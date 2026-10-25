// prompt.mjs — worker / reviewer / fixup prompt 组装 + 输出契约块解析。
// 设计见 docs 5.5（五层 prompt 结构、输出契约）与 5.8（审查 prompt 复用
// .agents/workflows/code-review.md 的固化模板）。

import fs from 'node:fs';
import path from 'node:path';

/** worker 结束前必须产出的契约块标记（fenced code block 的语言名）。 */
export const RESULT_MARKER = 'agents-result';

/**
 * 组装 worker prompt（五层结构，docs 5.5）。
 * @param {object} card loadCard 的返回值 { meta, body }
 * @param {object} ctx { repoRoot, worktreePath, playbooksDir }
 */
export function buildWorkerPrompt(card, ctx) {
  const { meta, body } = card;
  const parts = [];

  // [系统层] AGENTS.md 全文
  const agentsMd = path.join(ctx.repoRoot, 'AGENTS.md');
  parts.push(`# 系统层：仓库约定（AGENTS.md，必须全文遵守）\n\n${fs.readFileSync(agentsMd, 'utf8')}`);

  // [流程层] 任务卡 workflows 命中的 playbook 全文
  for (const name of meta.workflows) {
    const p = path.join(ctx.playbooksDir, `${name}.md`);
    if (!fs.existsSync(p)) throw new Error(`任务卡 workflows 引用的 playbook 不存在：${p}`);
    parts.push(`# 流程层：playbook「${name}」\n\n${fs.readFileSync(p, 'utf8')}`);
  }

  // [任务层] 目标 / 验收标准 / 红线 / 背景
  parts.push(
    `# 任务层：本次任务（${meta.id}，类型 ${meta.type}）\n\n` +
      `## 目标\n${body.goal}\n\n## 验收标准（orchestrator 会机器验证，务必逐条满足）\n${body.acceptance}\n\n` +
      (body.redlines ? `## 红线（违反任一条任务直接失败）\n${body.redlines}\n\n` : '') +
      (body.background ? `## 背景\n${body.background}\n\n` : '')
  );

  // [环境层] worktree 绝对路径
  parts.push(
    `# 环境层：工作目录\n\n` +
      `你的工作目录（worktree）是：${ctx.worktreePath}\n` +
      `所有编辑必须使用此目录下的绝对路径，禁止改动主仓库或任何其他 worktree 的文件。`
  );

  // [契约层] 输出契约
  const contractFence = '```';
  parts.push(
    `# 契约层：结束前必须输出结果块\n\n` +
      `任务收尾时（提交完成之后），在回复的**最末尾**输出一个 fenced block：\n\n` +
      `${contractFence}${RESULT_MARKER}\n` +
      `status: done | stuck\n` +
      `summary: 一句话说明做了什么\n` +
      `files_changed: ["相对 worktree 的路径", ...]\n` +
      `tests: pass | fail\n` +
      `notes_updated: true | false\n` +
      `${contractFence}\n\n` +
      `- status=stuck 表示你无法继续（缺信息/遇到红线/反复失败），此时必须在 NOTES.md 留全现场。\n` +
      `- 无论自报什么，orchestrator 都会亲自跑门禁验证；自报不可信，如实报告即可。`
  );

  return parts.join('\n\n---\n\n');
}

/**
 * 组装 reviewer prompt（全新上下文只读审查，复用 code-review.md 模板骨架）。
 * @param {object} card 任务卡
 * @param {string} diff `git diff <base>...HEAD` 全文
 * @param {string} redlines 项目红线文本（workflow.json reviewNotes；缺省 = 不列具体红线）
 */
export function buildReviewerPrompt(card, diff, redlines = '') {
  const { meta, body } = card;
  const plannerNote =
    meta.created_by === 'planner'
      ? `\n5. **本任务卡由 Planner 自动生成**：请额外评估「验收标准」本身的完备性——是否空洞（如只有"测试全绿"而无具体行为断言）、是否真正覆盖了意图、是否存在 Planner 幻觉（引用不存在的文件/端点）。验收标准不合格同样计阻塞项。\n`
      : '';
  const redlineNote = redlines ? `（${redlines}）` : '';
  return (
    `请审查这个 diff。任务目标是：${body.goal}\n\n` +
    `请检查：\n` +
    `1. 改动是否完整实现了目标（对照验收标准：\n${body.acceptance}\n）？\n` +
    `2. 有没有引入明显 bug、安全问题、或破坏项目红线${redlineNote}？\n` +
    `3. 测试是否覆盖了改动路径？\n` +
    `4. 有没有不必要的改动混入（顺手重构、无关格式化、超出预期范围：${meta.files_hint.join(', ')}）？\n${plannerNote}\n` +
    `只报告问题，不修改代码。每个问题给出严重级别（阻塞/建议/提示）。输出末尾用一行汇总：\n` +
    `REVIEW_SUMMARY: blockers=<n> suggestions=<n> notes=<n>\n\n` +
    `# 待审查 diff（git diff <base>...HEAD）\n\n\`\`\`diff\n${diff}\n\`\`\`\n`
  );
}

/** 从 reviewer 输出提取三级计数；解析不到时返回 null（由调用方决定保守处理）。 */
export function parseReviewVerdict(text) {
  const m = /REVIEW_SUMMARY:\s*blockers=(\d+)\s+suggestions=(\d+)\s+notes=(\d+)/.exec(text);
  if (!m) return null;
  return { blockers: parseInt(m[1], 10), suggestions: parseInt(m[2], 10), notes: parseInt(m[3], 10) };
}

/**
 * 组装 fixup prompt（调试子循环 / 审查返工共用：失败输出尾部注入，同 worktree 续做）。
 * @param {string} reasonTag 'test_failure' | 'build_failure' | 'review_blockers'
 */
export function buildFixupPrompt(card, ctx, reasonTag, failureOutput, iteration) {
  const tail = failureOutput.split('\n').slice(-200).join('\n');
  return (
    `${buildWorkerPrompt(card, ctx)}\n\n---\n\n` +
    `# Fixup 指令（第 ${iteration} 次返工）\n\n` +
    `你此前报告完成，但自动验证未通过（原因：${reasonTag}）。请在同一 worktree 内继续修复，\n` +
    `修复后重新提交，并再次按契约层要求输出结果块。以下是失败输出（截取尾部 200 行）：\n\n` +
    '```\n' +
    `${tail}\n` +
    '```\n'
  );
}

/**
 * 从 worker 输出解析契约块。返回 null 表示未找到（视为 stuck 信号之一，
 * 由调用方连同 NOTES.md 检查一起决策）。
 */
export function parseResultBlock(text) {
  const re = new RegExp('```' + RESULT_MARKER + '\\s*\\n([\\s\\S]*?)\\n```');
  const m = re.exec(text);
  if (!m) return null;
  const result = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, key, raw] = kv;
    if (key === 'files_changed') {
      // 契约示例是 JSON 数组；容错解析（失败则按逗号拆）
      try {
        result[key] = JSON.parse(raw);
      } catch {
        result[key] = raw
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      }
    } else if (raw === 'true' || raw === 'false') {
      result[key] = raw === 'true';
    } else {
      result[key] = raw.trim();
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Planner（intent 命令）：把一句话意图编译成任务卡（docs 10.8）
// ---------------------------------------------------------------------------

/** Planner 输出契约的 fenced block 标记。 */
export const CARD_MARKER = 'agents-card';

/**
 * 组装 planner prompt：只读会话（Read/Glob/Grep）探索仓库，把意图编译成任务卡。
 * 意图文本先经 sanitize 消毒（人给的一句话也可能引用了仓库外的不可信内容）。
 */
export function buildPlannerPrompt(intentText, repoRoot) {
  const agentsMd = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  const clean = sanitizeIntent(intentText);
  const fence = '```';
  return (
    `# 系统层：仓库约定（AGENTS.md，必须遵守其中的工程约定与红线）\n\n${agentsMd}\n\n` +
    `# 任务：把下面的意图编译成一张可执行的任务卡\n\n` +
    `用户意图：${clean}\n\n` +
    `你可以用 Read/Glob/Grep 探索本仓库（当前目录就是仓库根）来了解现状：定位相关代码、\n` +
    `看测试怎么组织、确认涉及的真实文件路径。禁止编造不存在的文件与端点。\n\n` +
    `# 产出契约\n\n` +
    `探索完成后，输出**一张完整任务卡**（markdown，含 YAML frontmatter），放在单个 fenced block 里：\n\n` +
    `${fence}${CARD_MARKER}\n` +
    `---\n` +
    `id: <小写短横线，体现意图>\n` +
    `type: <bugfix | feature | docs | deps | refactor>\n` +
    `priority: normal\n` +
    `created_at: <当前 ISO 时间>\n` +
    `created_by: planner\n` +
    `files_hint:\n` +
    `  - <你探索后确认的实际预期范围，glob>\n` +
    `workflows:\n` +
    `  - feature-branch\n` +
    `gate: L3\n` +
    `---\n` +
    `\n# 目标\n<意图的去歧义重述：改什么、为什么>\n\n# 验收标准\n<必须可机器检查>\n\n# 背景\n<探索到的现状与线索>\n` +
    `${fence}\n\n` +
    `硬性要求：\n` +
    `1. gate 固定写 L3（合并级别由系统按实际改动分级裁决，不由你决定）；\n` +
    `2. 验收标准必须可机器检查：除测试全绿（workflow.json testCmd）外，给出**具体行为断言**（哪个函数/端点/文案应当怎样），\n` +
    `   禁止空洞标准；\n` +
    `3. files_hint 写真实范围（你确认过的路径），越准越好；\n` +
    `4. created_by 固定写 planner；\n` +
    `5. 围栏外只允许一句话概述，不要输出其他内容。\n`
  );
}

/** 意图文本消毒：与 scan 的 sanitize 同策略（控制字符/空白折叠/结构字符/截断）。 */
export function sanitizeIntent(text, limit = 500) {
  return String(text ?? '')
    .replace(/\p{C}/gu, ' ')
    .replace(/[`<>|;${}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/** 从 planner 输出提取任务卡文本；找不到返回 null。 */
export function parseCardBlock(text) {
  const re = new RegExp('```' + CARD_MARKER + '\\s*\\n([\\s\\S]*?)\\n```');
  const m = re.exec(text ?? '');
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Spec Planner（spec 命令）：把一句话意图编译成 Spec Kit/Kiro 式三件套
// （requirements → design → tasks，docs 10.9）。产出契约 = 四个 fenced block；
// 三件套落盘 .agents/orchestrator/specs/<id>/，人工审阅后由 spec build 拆成任务卡。
// ---------------------------------------------------------------------------

/** spec planner 输出契约的 fenced block 标记（元信息 + 三件套）。 */
export const SPEC_META_MARKER = 'agents-spec';
export const REQUIREMENTS_MARKER = 'agents-requirements';
export const DESIGN_MARKER = 'agents-design';
export const TASKS_MARKER = 'agents-tasks';

/** 从 fenced block 里提取标记内容；找不到返回 null。 */
function parseMarkerBlock(text, marker) {
  const re = new RegExp('```' + marker + '\\s*\\n([\\s\\S]*?)\\n```');
  const m = re.exec(text ?? '');
  return m ? m[1] : null;
}

/**
 * 组装 spec planner prompt：只读会话（Read/Glob/Grep）探索仓库，产出三件套。
 * 与 buildPlannerPrompt 同构（AGENTS.md 注入 + 意图消毒 + 契约模板 + 硬性要求），
 * 差异在产物：单张任务卡 → requirements/design/tasks 三份文档（人审后再拆卡）。
 */
export function buildSpecPrompt(intentText, repoRoot) {
  const agentsMd = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  const clean = sanitizeIntent(intentText);
  const fence = '```';
  return (
    `# 系统层：仓库约定（AGENTS.md，必须遵守其中的工程约定与红线）\n\n${agentsMd}\n\n` +
    `# 任务：把下面的意图编译成规格三件套（requirements → design → tasks）\n\n` +
    `用户意图：${clean}\n\n` +
    `你可以用 Read/Glob/Grep 探索本仓库（当前目录就是仓库根）来了解现状：定位相关模块、\n` +
    `看测试怎么组织、确认涉及的真实文件路径。禁止编造不存在的文件与端点。\n\n` +
    `# 产出契约\n\n` +
    `探索完成后，按顺序输出四个 fenced block：\n\n` +
    `${fence}${SPEC_META_MARKER}\n` +
    `id: <小写短横线，体现意图>\n` +
    `title: <一句话标题>\n` +
    `${fence}\n\n` +
    `${fence}${REQUIREMENTS_MARKER}\n` +
    `# <标题>\n\n` +
    `## 背景\n<为什么做：现状痛点、触发场景>\n\n` +
    `## 用户故事\n- 作为 <角色>，我希望 <能力>，以便 <价值>。\n\n` +
    `## 验收标准（EARS 式，可机器检查）\n- 当 <触发>，系统应当 <可观察行为>。\n` +
    `${fence}\n\n` +
    `${fence}${DESIGN_MARKER}\n` +
    `# 技术设计：<标题>\n\n` +
    `## 现状\n<探索到的相关模块/文件（写真实路径）与现有行为>\n\n` +
    `## 方案\n<改动方案与关键决策>\n\n` +
    `## 取舍\n<备选方案与放弃理由>\n\n` +
    `## 风险\n<平台兼容/端口/兼容性等风险与规避>\n` +
    `${fence}\n\n` +
    `${fence}${TASKS_MARKER}\n` +
    `# 任务分解：<标题>\n\n` +
    `## 任务 1：<短标题>\n` +
    `- 目标: <这个任务做什么>\n` +
    `- 文件: <glob1>, <glob2>（你探索后确认的真实范围）\n` +
    `- 完成条件: <可机器检查的断言>\n` +
    `- 依赖: 无（或：任务 N）\n\n` +
    `（按需增加「## 任务 2:…」，每个任务一个段；任务应可独立合并，粒度=一次 worktree 闭环）\n` +
    `${fence}\n\n` +
    `硬性要求：\n` +
    `1. 验收标准与完成条件必须可机器检查（哪个函数/端点/命令/文案应当怎样），禁止空洞标准；\n` +
    `2. 「文件」行写真实路径 glob（你确认过的），越准越好——它直接成为任务卡的 files_hint；\n` +
    `3. 任务间依赖显式写「依赖: 任务 N」，无依赖写「依赖: 无」；\n` +
    `4. 设计不得违反 AGENTS.md 红线（端口 8687/8890、native 依赖、import.meta 等）；\n` +
    `5. 围栏外只允许一句话概述，不要输出其他内容。\n`
  );
}

/**
 * 从 spec planner 输出提取四块。返回 { id, title, requirements, design, tasks }；
 * 任一块缺失或 meta 解析失败返回 null（调用方喂回重试）。
 */
export function parseSpecBlocks(text) {
  const metaRaw = parseMarkerBlock(text, SPEC_META_MARKER);
  const requirements = parseMarkerBlock(text, REQUIREMENTS_MARKER);
  const design = parseMarkerBlock(text, DESIGN_MARKER);
  const tasks = parseMarkerBlock(text, TASKS_MARKER);
  if (!metaRaw || !requirements || !design || !tasks) return null;
  const id = /^id:\s*(.+)$/m.exec(metaRaw)?.[1]?.trim();
  const title = /^title:\s*(.+)$/m.exec(metaRaw)?.[1]?.trim();
  if (!id || !title) return null;
  return { id, title: title.trim(), requirements, design, tasks };
}

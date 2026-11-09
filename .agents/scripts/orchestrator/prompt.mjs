// prompt.mjs — worker / reviewer / fixup prompt 组装 + 输出契约块解析。
// 设计见 docs 5.5（五层 prompt 结构、输出契约）与 5.8（审查 prompt 复用
// .agents/workflows/code-review.md 的固化模板）。

import fs from 'node:fs';
import path from 'node:path';
import { toIsoLocal } from './events.mjs';

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

  // [任务层] 目标 / 验收标准 / 红线 / 航次计划（可选）/ 背景
  parts.push(
    `# 任务层：本次任务（${meta.id}，类型 ${meta.type}）\n\n` +
      `## 目标\n${body.goal}\n\n## 验收标准（orchestrator 会机器验证，务必逐条满足）\n${body.acceptance}\n\n` +
      (body.redlines ? `## 红线（违反任一条任务直接失败）\n${body.redlines}\n\n` : '') +
      (body.plan ? `## 航次计划（按检查点推进；偏离航线时在 NOTES.md 说明原因）\n${body.plan}\n\n` : '') +
      (body.background ? `## 背景\n${body.background}\n\n` : '')
  );

  // [环境层] worktree 绝对路径 + headless 权限形态约定（2026-10 实跑教训：
  // worker 惯用 `git -C <绝对路径>` 而 headless 白名单按命令前缀匹配，-C 形态
  // 不在白名单内被自动拒绝，白白烧预算——禁用 -C，shell 一律以当前目录执行）
  parts.push(
    `# 环境层：工作目录\n\n` +
      `你的工作目录（worktree）是：${ctx.worktreePath}\n` +
      `所有编辑必须使用此目录下的绝对路径，禁止改动主仓库或任何其他 worktree 的文件。\n` +
      `shell 命令一律以当前目录执行：git 直接写 \`git add / git commit / git diff / git status\`，**禁止 \`git -C <路径> <子命令>\` 形态**\n` +
      `（headless 权限白名单按命令前缀匹配，-C 形态会被自动拒绝）。未列入白名单的命令（如 node/powershell 直调）同样会被拒。\n` +
      `**一次工具调用只发一条 shell 命令**：不要用 ; / && / | 把多条命令拼在一起——复合命令会被权限系统按「multiple operations」整体拒绝。`
  );

  // [纪律层] 长时自治运行的结束纪律（Anthropic 长时程 harness 结论 + 实跑教训：
  // worker 被权限拒绝后换形态重试 15+ 次并派子代理同拒，烧穿预算零产出）。
  // 第 0 条复诵协议（closed-loop repeat-back）：接收方用自己的话复述指令，发送方
  // 核对一致后放行——把「理解错方向」拦在开工前，而不是烧完预算才发现。
  parts.push(
    `# 结束纪律（必须遵守）\n\n` +
      `0. 开工第一件事：把托运单**复诵**进 NOTES.md——目的地（目标）、交货标准（验收标准）、禁航区（红线）、航次计划各一行。船长（编排器）与验船师会核对复诵与执行是否一致；复诵即承诺。\n` +
      `1. 报告 done 之前，亲自跑一遍测试命令（见验收标准）确认全绿——orchestrator 会机器复核，自报与实测不符时以实测为准。\n` +
      `2. 收尾现场干净：本卡全部改动已在 worktree 内 git add + git commit，NOTES.md 已更新。\n` +
      `3. 只做本卡范围内的事（对照验收标准与预期改动范围）：不顺手重构、不修无关问题——越界改动会被门禁打回。\n` +
      `4. 权限拒绝熔断：同一条 shell 命令被权限系统拒绝满 2 次，立即停止重试（不要换写法绕过、不要派子代理），\n` +
      `   在 NOTES.md 列出被拒命令原文，然后按契约层输出 status: stuck 的结果块——拒绝通常是环境缺配置，重试只烧预算。`
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
 * 大 prompt 落文件（D17）后的收缩正文：全文文件引用 + 要点摘要（worktree 路径 / 目标 /
 * 验收标准 / 红线）+ 契约块模板。完整简报（AGENTS.md 系统层 / playbook 流程层 / 结束纪律 /
 * 交接班单 / follow-up 全文）在 promptPath，worker 开工前必须先读它——正文只保留「开工即需」
 * 的最小面，体量恒小于 zcode argv 上限（30k），escalation 换船退为最后兜底。
 * 简报文件是编排器落的只读输入（logs/<taskId>/prompt-full.md，.agents/orchestrator/logs 已
 * gitignore，不进 worktree、不污染 diff/审查面）；本摘要与全文冲突时以全文为准。
 * @param {object} p { promptPath, card, ctx?, originalChars }
 */
export function buildPromptFileRefBody({ promptPath, card, ctx, originalChars = 0 }) {
  const { meta, body } = card;
  const contractFence = '```';
  return (
    `# 任务层：本次任务（${meta.id}，类型 ${meta.type}）\n\n` +
    `你的完整任务简报已由编排器写入文件（${originalChars} 字符）：\n${promptPath}\n\n` +
    `**开工第一件事：先用 Read 工具读完该文件全文并逐条遵守**——它包含仓库约定（AGENTS.md）、\n` +
    `playbook 流程层、结束纪律与本契约的完整版；该文件是只读输入，不要修改它。与本摘要冲突时以全文为准。\n\n` +
    (ctx?.worktreePath
      ? `你的工作目录（worktree）是：${ctx.worktreePath}\n` +
        `所有编辑必须使用此目录下的绝对路径，禁止改动主仓库或任何其他 worktree 的文件。\n\n`
      : '') +
    `## 目标（摘要）\n${body.goal}\n\n## 验收标准（orchestrator 会机器验证，务必逐条满足）\n${body.acceptance}\n\n` +
    (body.redlines ? `## 红线（违反任一条任务直接失败）\n${body.redlines}\n\n` : '') +
    `# 契约层：结束前必须输出结果块\n\n` +
    `任务收尾时（提交完成之后），在回复的**最末尾**输出一个 fenced block（字段说明见简报文件）：\n\n` +
    `${contractFence}${RESULT_MARKER}\n` +
    `status: done | stuck\n` +
    `summary: 一句话说明做了什么\n` +
    `files_changed: ["相对 worktree 的路径", ...]\n` +
    `tests: pass | fail\n` +
    `notes_updated: true | false\n` +
    `${contractFence}\n`
  );
}

/**
 * 组装 reviewer prompt（全新上下文只读审查，复用 code-review.md 模板骨架）。
 * @param {object} card 任务卡
 * @param {string} diff `git diff <base>...HEAD` 全文
 * @param {string} redlines 项目红线文本（workflow.json reviewNotes；缺省 = 不列具体红线）
 * @param {string} discipline 审查纪律文本（如 REVIEW.md 摘要；缺省 = 不注入——
 *   与人工/PR 审查同一套失败形态与红线标准，异构引擎 + 同一纪律）
 */
export function buildReviewerPrompt(card, diff, redlines = '', discipline = '') {
  const { meta, body } = card;
  const plannerNote =
    meta.created_by === 'planner'
      ? `\n5. **本任务卡由 Planner 自动生成**：请额外评估「验收标准」本身的完备性——是否空洞（如只有"测试全绿"而无具体行为断言）、是否真正覆盖了意图、是否存在 Planner 幻觉（引用不存在的文件/端点）。验收标准不合格同样计阻塞项。\n`
      : '';
  const redlineNote = redlines ? `（${redlines}）` : '';
  const disciplineNote = discipline
    ? `\n# 审查纪律（与人工/PR 审查同一标准）\n\n${discipline}\n`
    : '';
  return (
    `请审查这个 diff。任务目标是：${body.goal}\n\n` +
    `请检查：\n` +
    `1. 改动是否完整实现了目标（对照验收标准：\n${body.acceptance}\n）？\n` +
    `2. 有没有引入明显 bug、安全问题、或破坏项目红线${redlineNote}？\n` +
    `3. 测试是否覆盖了改动路径？\n` +
    `4. 有没有不必要的改动混入（顺手重构、无关格式化、超出预期范围：${meta.files_hint.join(', ')}）？\n${plannerNote}\n` +
    disciplineNote +
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
 * 把 follow-up 条目追加到 prompt 尾部（订阅直通：任务进行中下达的补充指令在
 * 会话边界送达 worker）。一律追加在尾部——任务层及之前的字节序列保持稳定，
 * provider 前缀缓存不失效；条数/字符截断已在 readInbox 侧完成。
 * @param {string} promptText 既有 prompt 全文
 * @param {Array<{ts: string, text: string}>} entries readInbox 的返回值
 */
export function appendFollowUps(promptText, entries) {
  if (!entries?.length) return promptText;
  const body = entries.map((e) => `## ${e.ts || '（未注明时间）'}\n${e.text}`).join('\n\n');
  return (
    promptText +
    `\n\n---\n\n# 补充指令（follow-up：任务进行中由编排者/用户中途下达，仍然有效；与本卡早期说明冲突时以这里为准）\n\n${body}\n`
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
    `\n# 目标\n<意图的去歧义重述：改什么、为什么>\n\n# 验收标准\n<必须可机器检查>\n\n# 航次计划\n<3-6 个检查点，每个检查点一句话「做什么 + 怎么验证」；末尾一行「备选路线：若 X 不通则 Y」>\n\n# 背景\n<探索到的现状与线索>\n` +
    `${fence}\n\n` +
    `硬性要求：\n` +
    `1. gate 固定写 L3（合并级别由系统按实际改动分级裁决，不由你决定）；\n` +
    `2. 验收标准必须可机器检查：除测试全绿（workflow.json testCmd）外，给出**具体行为断言**（哪个函数/端点/文案应当怎样），\n` +
    `   禁止空洞标准；\n` +
    `3. files_hint 写真实范围（你确认过的路径），越准越好；写裸 glob（如 src/presets/**），不要用反引号或引号包住；\n` +
    `4. created_by 固定写 planner；\n` +
    `5. 卡必须含「# 航次计划」段：3-6 个检查点，每个检查点一句话写清「做什么 + 怎么验证」，末尾一行「备选路线：若 X 不通则 Y」；\n` +
    `6. 围栏外只允许一句话概述，不要输出其他内容。\n`
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
// Propose（autopilot 需求综合）：目标面 + 巡检信号 → 高质量任务卡提案
// ---------------------------------------------------------------------------

/**
 * 组装 propose prompt：只读会话探索仓库，把「目标面 + 巡检提案 + 队列现状」综合成
 * 至多 maxCards 张高质量任务卡。与 intent 的分工：intent 是人给意图的单卡编译；
 * propose 是无人值守下按目标面自主给出需求——产出只落 drafts 提案，进不进队列由
 * 人工批量 submit 或 autopilot 白名单决定。
 * @param {object} p { goals, signals, queueSummary, maxCards, repoRoot, fleetFeedback? }
 *   fleetFeedback：舰队反馈正文（stats.mjs buildFleetFeedback 产出的数据事实，可选）——
 *   插在队列现状之后、产出契约之前；未传 = 不出现该段，prompt 与历史逐字节一致（回归红线）。
 */
export function buildProposePrompt({ goals, signals, queueSummary, maxCards, repoRoot, fleetFeedback }) {
  const agentsMd = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  const fence = '```';
  const fleetSection = fleetFeedback
    ? `## 舰队反馈（近 7 天运行度量：以下全部是数据事实，供决策参考，无硬性指令）\n${fleetFeedback}\n\n`
    : '';
  return (
    `# 系统层：仓库约定（AGENTS.md，必须遵守其中的工程约定与红线）\n\n${agentsMd}\n\n` +
    `# 任务：项目需求综合（autopilot 提案）\n\n` +
    `你是这个仓库的需求规划者。下面给出项目目标面、当前巡检信号与队列现状；请先用 Read/Glob/Grep ` +
    `探索本仓库（当前目录就是仓库根）确认现状，再产出**至多 ${maxCards} 张**高质量、可独立执行的任务卡。\n\n` +
    `## 项目目标面（用户维护的核心目标；需求必须对齐它）\n${goals?.trim() || '（未提供 goals.md——只基于巡检信号与仓库现状提案，并在背景里说明价值依据）'}\n\n` +
    `## 当前巡检信号（scan 已落 drafts 的提案：可深化、合并或否决，重复的不必再出）\n${signals?.trim() || '（本轮无巡检信号）'}\n\n` +
    `## 队列现状（各状态卡数）\n${queueSummary || '（空）'}\n\n` +
    fleetSection +
    `# 产出契约\n\n` +
    `按优先级输出**零到多张**任务卡，每张放在独立 fenced block（最多 ${maxCards} 张；没有值得做的就一张都不出）：\n\n` +
    `${fence}${CARD_MARKER}\n` +
    `---\n` +
    `id: <小写短横线，体现意图>\n` +
    `type: <bugfix | feature | docs | deps | refactor>\n` +
    `priority: <high | normal | low>\n` +
    `created_at: <当前 ISO 时间>\n` +
    `created_by: planner\n` +
    `files_hint:\n` +
    `  - <你探索后确认的实际预期范围，glob>\n` +
    `workflows:\n` +
    `  - feature-branch\n` +
    `gate: L3\n` +
    `proposal: true\n` +
    `research: <feature 卡必填：引用既有调研 brief 的 id；仓库里没有能回答它的 brief 就写 todo——系统会先派调研、再出规格；非 feature 卡省略此行>\n` +
    `score:\n` +
    `  value: <1-3 价值档>\n` +
    `  effort: <1-3 成本档>\n` +
    `  confidence: <1-3 证据强度>\n` +
    `  risk: <1-3 风险档>\n` +
    `evidence:\n` +
    `  - <证据：巡检信号来源 / goals 条目 / 运行度量数据，一句话一条>\n` +
    `---\n` +
    `\n# 目标\n<做什么、为什么；引用目标面条目或巡检信号来源>\n\n# 验收标准\n<必须可机器检查：具体行为断言>\n\n# 航次计划\n<3-6 个检查点，每个检查点一句话「做什么 + 怎么验证」；末尾一行「备选路线：若 X 不通则 Y」>\n\n# 背景\n<探索到的现状与线索>\n` +
    `${fence}\n\n` +
    `硬性要求：\n` +
    `1. 验收标准必须可机器检查（哪个函数/端点/命令/文案应当怎样），禁止只有「测试全绿」这类空洞标准；\n` +
    `2. files_hint 写真实范围（你确认过的路径），写裸 glob，不要用反引号或引号包住；\n` +
    `3. created_by 固定 planner、gate 固定 L3、frontmatter 带 proposal: true；\n` +
    `4. feature 卡 frontmatter 必带 research 行（引用既有 brief id 或写 todo）——feature 不直接进队列，走 research → spec → 人工审设计 → spec build 管线；\n` +
    `5. score 四因子只取 1/2/3 档并在 evidence 里给出依据（量化给调度定序用，宁缺毋滥：证据不足就整体省略 score/evidence）；\n` +
    `6. 深化巡检信号里的既有卡时用**同 id**（提案落盘同 id 覆盖=升级），不要另起新 id 造成重复；\n` +
    `7. 价值说不清或验收写不具体 → 宁可不出这张卡；\n` +
    `8. 卡必须含「# 航次计划」段：3-6 个检查点，每个检查点一句话写清「做什么 + 怎么验证」，末尾一行「备选路线：若 X 不通则 Y」；\n` +
    `9. 围栏外只允许一句话概述，不要输出其他内容。\n`
  );
}

/** 从 propose 输出提取全部任务卡块（parseCardBlock 的多卡版）。 */
export function parseCardBlocks(text) {
  const re = new RegExp('```' + CARD_MARKER + '\\s*\\n([\\s\\S]*?)\\n```', 'g');
  const out = [];
  for (const m of String(text ?? '').matchAll(re)) out.push(m[1]);
  return out;
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
 * @param {string} redlines 项目红线文本（workflow.json reviewNotes；缺省 = 只提 AGENTS.md 不展开）
 * @param {string} brief 调研结论全文（research/<id>/brief.md，--from-brief 注入；可选）——
 *   插在产出契约之前；为空 = 不出现该段，prompt 与历史逐字节一致（回归红线）。
 */
export function buildSpecPrompt(intentText, repoRoot, redlines = '', brief = '') {
  const agentsMd = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  const clean = sanitizeIntent(intentText);
  const fence = '```';
  const briefSection = brief
    ? `## 调研结论（research brief 已产出，设计须以此为据；与其冲突时在「取舍」段说明理由）\n\n${String(brief).trim()}\n\n`
    : '';
  return (
    `# 系统层：仓库约定（AGENTS.md，必须遵守其中的工程约定与红线）\n\n${agentsMd}\n\n` +
    `# 任务：把下面的意图编译成规格三件套（requirements → design → tasks）\n\n` +
    `用户意图：${clean}\n\n` +
    `你可以用 Read/Glob/Grep 探索本仓库（当前目录就是仓库根）来了解现状：定位相关模块、\n` +
    `看测试怎么组织、确认涉及的真实文件路径。禁止编造不存在的文件与端点。\n\n` +
    briefSection +
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
    `2. 「文件」行写真实路径 glob（你确认过的），越准越好——它直接成为任务卡的 files_hint；写裸 glob（如 src/api/**），不要用反引号或引号包住；\n` +
    `3. 任务间依赖显式写「依赖: 任务 N」，无依赖写「依赖: 无」；\n` +
    `4. 设计不得违反 AGENTS.md 红线${redlines ? `（${redlines}）` : ''}；\n` +
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

// ---------------------------------------------------------------------------
// Researcher（research 命令）：Deep Research 式外部调研。会话工具面 = WebFetch/WebSearch
// + Read/Glob/Grep（无 Bash 无写，fail-closed）；产物 = research/<id>/brief.md（五段
// 契约 + 引用），供卡 research 字段引用、spec --from-brief 消费。逻辑件在 research.mjs。
// ---------------------------------------------------------------------------

import { BRIEF_MARKER, VERDICT_MARKER, ARBITRATION_MARKER } from './research.mjs';
import { SPECVERDICT_MARKER } from './spec-review.mjs';

export { BRIEF_MARKER, VERDICT_MARKER, ARBITRATION_MARKER, SPECVERDICT_MARKER };

/** 拆维规划会话输出契约的 fenced block 标记（sail researchAutoDim，P3 2026-11-10；
 *  backends/mock.mjs 以 prompt 含此标记判定拆维会话模式）。 */
export const DIMS_SPLIT_MARKER = 'agents-dims';

/**
 * 组装拆维规划 prompt（sail 上游管线 researchAutoDim，2026-11-10 P3）：readonly 轻会话
 * 把提案目标拆成 2–4 个互补的调研维度。与 planner 家族同构（AGENTS.md 注入 + 意图消毒 +
 * 契约模板 + 硬性要求），产物既不是卡也不是 brief，是纯维度清单——每行一个、无解释；
 * 解析在 research.mjs parseDimsPlan（容忍围栏包裹，不足 2 维调用方降级单 brief）。
 */
export function buildResearchDimsPrompt(goalText, repoRoot) {
  const agentsMd = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  const clean = sanitizeIntent(goalText);
  const fence = '```';
  return (
    `# 系统层：仓库约定（AGENTS.md，必须遵守其中的工程约定与红线）\n\n${agentsMd}\n\n` +
    `# 任务：为下面的提案目标拆分调研维度（research auto-dim 规划）\n\n` +
    `提案目标：${clean}\n\n` +
    `你可以用 Read/Glob/Grep 快速了解本仓库语境（当前目录就是仓库根），判断该目标值得从哪些互补角度调研。\n` +
    `你没有 Bash 也没有任何写文件工具——只规划，不改仓库。\n\n` +
    `# 产出契约\n\n` +
    `输出一个 fenced block，块内每行一个维度（2–4 个）：\n\n` +
    `${fence}${DIMS_SPLIT_MARKER}\n` +
    `<维度1>\n<维度2>\n<维度3（可选）>\n` +
    `${fence}\n\n` +
    `硬性要求：\n` +
    `1. 维度必须互补（合起来覆盖目标的关键未知面，如技术选型/成本/风险/生态），不要同义反复；\n` +
    `2. 每个维度一行、不超过 20 字、不带编号、不带项目符号、不写任何解释——多余文字会破坏解析；\n` +
    `3. 维度数量 2–4 个：少于 2 个无法多维调研，多于 4 个会被截断；\n` +
    `4. 围栏外不要输出任何内容。\n`
  );
}

/**
 * 组装 researcher prompt。与 planner 家族同构（AGENTS.md 注入 + 意图消毒 + 契约模板 +
 * 硬性要求）。goalsText：goals.md 罗盘全文（可选）——注入「罗盘对齐」段的判定依据。
 * minCitations 透传 research.mjs validateBriefBody（缺省 1）。
 * 2026-11 编造引用防线：显式注入今天的日期（headless 会话对「当前日期」不可靠，真实
 * 首跑曾把 2023 训练先验当 2026 现状且引用日期全编成 2023）+ gate 强校验引用日期
 * ≈今天（未来/陈旧拒收）+ 一手来源优先、关键结论双源交叉。
 */
export function buildResearchPrompt(questionText, repoRoot, { goalsText = '', minCitations = 1, today = toIsoLocal().slice(0, 10) } = {}) {
  const agentsMd = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  const clean = sanitizeIntent(questionText);
  const fence = '```';
  return (
    `# 系统层：仓库约定（AGENTS.md，必须遵守其中的工程约定与红线）\n\n${agentsMd}\n\n` +
    `# 任务：把下面的问题调研清楚，产出一份带引用的调研结论（research brief）\n\n` +
    `今天是 ${today}——你输出的一切「当前/最新」都以它为准；你的训练知识可能过时，现状问题必须以本次检索结果为准。\n\n` +
    `调研问题：${clean}\n\n` +
    `你可以用 WebSearch / WebFetch 检索与阅读外部资料；若工具列表里有 mcp__zsearch__web_search（智谱搜索包）也可直接使用。` +
    `用 Read/Glob/Grep 查看本仓库现状。\n` +
    `你没有 Bash 也没有任何写文件工具——只调研，不改仓库。\n\n` +
    (goalsText ? `## 项目罗盘（goals.md——「罗盘对齐」段对照它写）\n${String(goalsText).trim().slice(0, 2000)}\n\n` : '') +
    `# 产出契约\n\n` +
    `调研完成后，输出一个 fenced block（id 用小写短横线、体现问题主题）：\n\n` +
    `${fence}${BRIEF_MARKER}\n` +
    `id: <小写短横线>\n` +
    `title: <一句话标题>\n` +
    `# 结论\n<直接回答调研问题；每条关键结论标注来源编号 [1] [2]…>\n\n` +
    `# 选项对比\n<有可比项时列表对比（方案/库/竞品/做法 × 优劣）；无则写「单结论问题，无选项对比」>\n\n` +
    `# 引用\n<每行一条，必须以今天的访问日期开头：- ${today} <URL> — <来源名>：<一句话说明这条来源支撑什么>>\n\n` +
    `# 建议\n<落到本项目可执行的下一步建议（做/不做/先做什么）>\n\n` +
    `# 罗盘对齐\n<该结论与项目罗盘/现状的关系：对齐哪条、或说明为何值得偏离>\n` +
    `${fence}\n\n` +
    `硬性要求：\n` +
    `1. 「# 引用」段至少 ${minCitations} 条，且**每行必须以今天的访问日期 ${today} 开头**（格式：- ${today} <URL> — 来源名：依据）——无日期/旧日期/未来日期/裸 URL 行不计入，产出会被 gate 直接拒收重做（未来或陈旧日期视为编造）；\n` +
    `2. 来源可信核查：**优先一手来源**（官方文档/官方公告/榜单原始页，如 OpenRouter Rankings、LMArena、HuggingFace、GitHub 官方仓库）；关键结论至少 2 个独立来源交叉；检索结果与你的训练知识冲突时以检索为准；\n` +
    `3. 禁止编造：URL、日期、数据、型号名一律以本次检索所见为准；查不到就如实写「未证实」并减少结论，**不要为了凑引用数编造来源**；\n` +
    `4. 结论必须有来源支撑（[n] 标注）；\n` +
    `5. 围栏外只允许一句话概述，不要输出其他内容。\n`
  );
}

// ---------------------------------------------------------------------------
// L2 可信度复核（research verify）：readonly 会话拿 brief + 快照文本做内部一致性
// 审查——结论是否被引用支撑、有无训练先验冒充检索现状的迹象。产出 agents-verdict
// 契约块（level/blockers/理由），与 L1 快照回查互补（L1 管数字对得上，L2 管逻辑自洽）。
// ---------------------------------------------------------------------------

/**
 * 组装 L2 复核 prompt。sourcesBlocks：快照文本（已截断拼接）；readonly 会话无联网——
 * 只对给定材料判内部一致性，不给外部知识下结论（训练知识只用来标记「可疑冲突点」）。
 */
export function buildVerifierPrompt(briefBody, sourcesBlocks, repoRoot, { today = toIsoLocal().slice(0, 10) } = {}) {
  const agentsMd = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  const fence = '```';
  const CAP = 12_000;
  const sources = String(sourcesBlocks ?? '').slice(0, CAP * 4);
  return (
    `# 系统层：仓库约定（AGENTS.md，必须遵守其中的工程约定与红线）\n\n${agentsMd}\n\n` +
    `# 任务：复核一份调研 brief 的可信度（claim 级一致性审查）\n\n` +
    `今天是 ${today}。你没有联网工具——只依据下面给定的 brief 与来源快照判断，不给材料之外的事实下结论。\n` +
    `你的知识只用来标记「可疑冲突」（如 brief 所述与普遍认知明显矛盾处），标注为疑点而非定论。\n\n` +
    `## 待复核 brief\n\n${String(briefBody ?? '').slice(0, CAP)}\n\n` +
    `## 来源快照（brief 所引页面的抓取文本）\n\n${sources || '（快照缺失——相应 claim 请判 unverifiable）'}\n\n` +
    `# 产出契约\n\n` +
    `挑出 brief 中**至多 10 条承重结论**（数字/排名/事实性断言），逐条判定，输出单个 fenced block（内容为合法 JSON）：\n\n` +
    `${fence}${VERDICT_MARKER}\n` +
    `{\n` +
    `  "claims": [\n` +
    `    { "claim": "<逐字摘自 brief 原文的承重结论，≤80 字，禁止改写/概括>", "status": "supported", "note": "<一句话：快照哪里支撑/矛盾/缺口>" }\n` +
    `  ],\n` +
    `  "blockers": ["<低可信硬伤一句话；无则空数组>"]\n` +
    `}\n` +
    `${fence}\n\n` +
    `status 枚举（只允许这五个）：\n` +
    `- supported：快照里有直接依据\n` +
    `- partial：部分依据/依赖转述\n` +
    `- unsupported：快照里找不到依据\n` +
    `- contradicted：与快照内容矛盾（或两处引文互相矛盾）\n` +
    `- unverifiable：快照缺失或纯定性无法对账\n\n` +
    `硬性要求：\n` +
    `1. claim **逐字摘自 brief 原文**（系统逐字校验，改写/概括/编造一律作废）；\n` +
    `2. 只判「结论是否被给定快照支撑」与「内部是否自洽」，不引入外部事实下断言；\n` +
    `3. brief 自己标注「未证实/转述」不算硬伤（诚实标注是加分项），但该 claim 最多 partial；\n` +
    `4. **页面发布/更新时间 ≠ 事件发生时间**（2026-11-09 实测误报：公告页 published_time=2025-06 被当成「API 1 月上线」的反证，事后四来源证实 1 月正确）——判 contradicted 前确认快照文本本身断言了该事件日期；仅凭 published_time/last-updated 元数据与 claim 断言的日期不符，判 partial 并在 note 写明依据，不判 contradicted；\n` +
    `5. 围栏外只允许一句话概述。\n`
  );
}

/**
 * 组装仲裁轮 prompt（L2 contradicted 的外部取证）：复核船无联网，矛盾只能拿快照文本
 * 裁断；快照自身误导（页面元数据语义、骨架截断）时矛盾可能是误报。仲裁会话带联网工具
 * （同 researcher 工具面），对每条 contradicted claim 检索 ≥2 个独立带日期来源、优先
 * 官方源，产出 agents-arbitration JSON 契约块。maintains：upheld 才翻案，翻不了维持否决。
 */
export function buildArbitrationPrompt(contradictedClaims, sourcesBlocks, repoRoot, { today = toIsoLocal().slice(0, 10) } = {}) {
  const agentsMd = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  const fence = '```';
  const CAP = 12_000;
  const sources = String(sourcesBlocks ?? '').slice(0, CAP * 4);
  const claimsText = (contradictedClaims ?? [])
    .map((c, i) => `${i + 1}. 「${c.claim}」\n   L2 矛盾理由：${c.note || '（未注明）'}`)
    .join('\n');
  return (
    `# 系统层：仓库约定（AGENTS.md，必须遵守其中的工程约定与红线）\n\n${agentsMd}\n\n` +
    `# 任务：仲裁 L2 复核判为 contradicted 的调研 claim（外部取证翻案/维持）\n\n` +
    `今天是 ${today}。你有联网检索工具（WebSearch / mcp__zsearch__web_search / WebFetch）。` +
    `逐条对下列被否决 claim 做外部取证，裁定矛盾是否成立。\n\n` +
    `## 待仲裁 claim（L2 判 contradicted）\n\n${claimsText}\n\n` +
    `## 触发矛盾的来源快照（brief 所引页面的抓取文本）\n\n${sources || '（快照缺失）'}\n\n` +
    `# 裁定规则\n\n` +
    `1. 每条 claim 检索 **≥2 个独立来源**（优先官方公告/官方文档/changelog/权威媒体；来源必须带发布日期）；\n` +
    `2. **页面发布/更新时间（published_time / last-updated）≠ 事件发生时间**——页面被后续改版很常见，` +
    `仅凭元数据时间与 claim 断言日期不符不足以判矛盾（这正是本轮仲裁最常见误报）；\n` +
    `3. upheld：≥2 个带日期的独立来源一致支持 claim 断言 → 矛盾是误报，翻案；` +
    `overturned：≥2 个独立来源一致否定 claim → 矛盾成立；` +
    `其余（来源冲突/只有单一来源/查不到带日期来源）→ undetermined；\n` +
    `4. 与快照同源的内容（同一域名/转载）不算独立来源；\n` +
    `5. claim 必须逐字摘录上面列出的原句（系统逐字对账，改写作废）。\n\n` +
    `# 产出契约\n\n` +
    `输出单个 fenced block（内容为合法 JSON，对每条待仲裁 claim 各一条裁定）：\n\n` +
    `${fence}${ARBITRATION_MARKER}\n` +
    `{\n` +
    `  "rulings": [\n` +
    `    { "claim": "<逐字摘录待仲裁 claim 原句>", "ruling": "upheld", "sources": ["- 2026-01-24 https://… — 一句话说明"], "reasoning": "<一句话：为何维持/推翻>" }\n` +
    `  ]\n` +
    `}\n` +
    `${fence}\n\n` +
    `ruling 枚举（只允许这三个）：upheld（翻案，否决解除）/ overturned（矛盾成立）/ undetermined（证据不足，否决维持）。围栏外只允许一句话概述。\n`
  );
}

// ---------------------------------------------------------------------------
// Spec 审查船（spec review 命令）：readonly 会话按 .agents/conventions/spec-review.md
// 规约对三件套做五维评分 + findings（防编造定位对账）。advisory——产出只做筛查，
// spec build 拆卡永远人工拍板。逻辑件在 spec-review.mjs（L0/对账/裁决重算）。
// ---------------------------------------------------------------------------

/**
 * 组装 spec 审查 prompt。l0：runSpecL0Checks 结果——L0 findings 以 JSON 注入（审查船
 * 必须回应每个红线命中与 fail 项）；红线条目命中 ≠ 违规，裁决义务在审查船。
 */
export function buildSpecReviewPrompt(specId, spec, l0, repoRoot, { today = toIsoLocal().slice(0, 10) } = {}) {
  const fence = '```';
  const specDirHint = `.agents/orchestrator/specs/${specId}`;
  return (
    `# 任务：按规约审查一份 spec 三件套（advisory）\n\n` +
    `今天是 ${today}。你是 spec 审查船：只读，不修改任何文件，不跑 git 写操作或测试。\n` +
    `工作目录是仓库根 ${repoRoot}（你只有只读探索工具：Read/Glob/Grep）。\n\n` +
    `## 必读（按序，审查标准的事实源）\n\n` +
    `1. .agents/conventions/spec-review.md —— 审查规约全文（五维定义/红线 gate/防编造硬纪律/裁决矩阵）\n` +
    `2. ${specDirHint}/requirements.md\n` +
    `3. ${specDirHint}/design.md\n` +
    `4. ${specDirHint}/tasks.md\n\n` +
    `## 硬纪律（规约 §1.3/§3，违反 = 该 finding 判编造并整体降档）\n\n` +
    `- **现状对账**：design「现状」节引用的每个代码事实（符号/函数名/文件:行号）必须实际打开对应文件核实；行号可能漂移，以符号为准。行号漂移记 P1；符号不存在或行为不符记 P1 并说明。\n` +
    `- finding 的 file 必须真实存在（相对仓库根路径）；涉及 spec 原文的 claim 必须逐字定位；无 claim 时 section 必须可定位（§节名或行号）。≤12 条，按 P0>P1>P2 排序，每条带一句话 fix。\n` +
    `- 红线裁决：L0 命中（见下）不等于违规——你必须在 gates.notes 逐条裁决 violation / legitimate-mention；有 violation 才 gates.redlines=fail。\n` +
    `- 维度分不确定给 null（服务端会 null 传染不聚合），禁止拍脑袋填数。\n\n` +
    `## L0 确定性检查结果（零 token 已跑，你不重复跑，但必须回应其中的 fail/warn 与红线命中）\n\n` +
    `${fence}json\n${JSON.stringify({ checks: l0.checks, redlineHits: l0.redlineHits, tbdCount: l0.tbdCount, fuzzyCount: l0.fuzzyCount, baselineDrift: l0.baselineDrift }, null, 2)}\n${fence}\n\n` +
    `## 产出契约\n\n` +
    `输出单个 fenced block（内容为合法 JSON）：\n\n` +
    `${fence}${SPECVERDICT_MARKER}\n` +
    `{\n` +
    `  "spec": "${specId}",\n` +
    `  "gates": { "redlines": "pass", "notes": ["<逐条裁决 L0 红线命中；无命中则一句 pass 说明>"] },\n` +
    `  "dimensions": { "completeness": 0-100|null, "unambiguity": 0-100|null, "consistency": 0-100|null, "testability": 0-100|null, "feasibility": 0-100|null },\n` +
    `  "findings": [\n` +
    `    { "severity": "P0|P1|P2", "file": "${specDirHint}/design.md 或被引代码文件", "section": "§节名或第N行", "claim": "<涉及 spec 原文时逐字摘录，否则留空>", "why": "<依据：规约条目或代码事实>", "fix": "<一句话建议>" }\n` +
    `  ],\n` +
    `  "usage": { "build_ready": "approve_to_build|needs_revision|rework|blocked" },\n` +
    `  "advisory": true\n` +
    `}\n` +
    `${fence}\n\n` +
    `围栏外只允许一句话概述。不要输出其他内容。\n`
  );
}

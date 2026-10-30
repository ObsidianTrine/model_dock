// spec.mjs — 规格驱动（Spec Kit/Kiro 式）的落盘与拆卡（spec 命令族，docs 10.9）。
// 三件套（requirements/design/tasks）由 spec planner 只读会话产出、人工审阅修改；
// spec build 把 tasks.md 的任务段拆成 orchestrator 任务卡进 pending/（gate=L3，
// 合并仍人工）。design.md 全文注入每张卡的背景段——specs 目录不入 worktree，
// worker 看不到仓库主目录的 specs，设计上下文必须随卡携带。

import fs from 'node:fs';
import path from 'node:path';
import { toIsoLocal } from './events.mjs';
import { cardPath, findCard } from './queue.mjs';

export function specsDir(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'specs');
}

export function specDir(repoRoot, id) {
  return path.join(specsDir(repoRoot), id);
}

/** 三件套落盘（spec start 产出后调用）。 */
export function writeSpec(repoRoot, parsed) {
  const dir = specDir(repoRoot, parsed.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: parsed.id, title: parsed.title, created_at: toIsoLocal() }, null, 2));
  fs.writeFileSync(path.join(dir, 'requirements.md'), `${parsed.requirements.trim()}\n`);
  fs.writeFileSync(path.join(dir, 'design.md'), `${parsed.design.trim()}\n`);
  fs.writeFileSync(path.join(dir, 'tasks.md'), `${parsed.tasks.trim()}\n`);
  return dir;
}

export function readSpec(repoRoot, id) {
  const dir = specDir(repoRoot, id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  return {
    dir,
    meta,
    requirements: fs.readFileSync(path.join(dir, 'requirements.md'), 'utf8'),
    design: fs.readFileSync(path.join(dir, 'design.md'), 'utf8'),
    tasks: fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8'),
  };
}

export function listSpecs(repoRoot) {
  const dir = specsDir(repoRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'meta.json')))
    .map((e) => e.name)
    .sort();
}

/**
 * 解析 tasks.md 的任务段。契约格式（spec planner 产出）：
 *   ## 任务 1:<短标题>
 *   - 目标: ...
 *   - 文件: glob1, glob2
 *   - 完成条件: ...
 *   - 依赖: 无 | 任务 N
 * 容错：键缺失回落占位（文件缺 → ['**'] 独占并告警）；无任何任务段返回 []。
 */
export function parseTasksDoc(text) {
  const tasks = [];
  const lines = String(text ?? '').split('\n');
  let cur = null;
  const push = () => {
    if (cur) {
      if (!cur.files.length) cur.files = ['**'];
      if (!cur.deps) cur.deps = '无';
      tasks.push(cur);
    }
  };
  for (const line of lines) {
    const h = /^##\s+任务\s*(\d+)[:：]\s*(.+)$/.exec(line);
    if (h) {
      push();
      cur = { n: parseInt(h[1], 10), title: h[2].trim(), goal: '', files: [], done: '', deps: '' };
      continue;
    }
    if (!cur) continue;
    const m = /^-\s+(目标|文件|完成条件|依赖)[:：]\s*(.+)$/.exec(line);
    if (!m) continue;
    const val = m[2].trim();
    if (m[1] === '目标') cur.goal = val;
    else if (m[1] === '文件') cur.files = val.split(/[,，]/).map((s) => s.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim()).filter(Boolean);
    else if (m[1] === '完成条件') cur.done = val;
    else if (m[1] === '依赖') cur.deps = val;
  }
  push();
  return tasks;
}

/**
 * 渲染单张任务卡。created_at 按任务序递增 n 分钟——drain 同优先级按 created_at
 * 升序调度，「依赖: 任务 N」由此天然先跑被依赖方（不引入显式依赖图，保持简单）。
 */
export function renderTaskCard(spec, task, total) {
  const fm = [
    '---',
    `id: ${spec.meta.id}-t${task.n}`,
    'type: feature',
    'priority: normal',
    `created_at: ${bumpMinutes(spec.meta.created_at, task.n)}`,
    'created_by: planner',
    `spec: ${spec.meta.id}`, // 进度锚寻址键：卡片状态迁移时同步 specs/<id>/progress.json（queue.mjs moveCard）
    'files_hint:',
    ...task.files.map((f) => `  - ${f}`),
    'workflows:',
    '  - feature-branch',
    'gate: L3',
    '---',
  ];
  const body = [
    '',
    '# 目标',
    `${task.title}：${task.goal || '（见验收标准）'}（规格 ${spec.meta.id}「${spec.meta.title}」任务 ${task.n}/${total}）`,
    '',
    '# 验收标准',
    '- npm test 全绿（workflow.json testCmd）',
    task.done ? `- ${task.done}` : '- 按 requirements 验收标准逐条自查',
    '',
    '# 背景',
    `来源：spec build 拆解自 .agents/orchestrator/specs/${spec.meta.id}/tasks.md（人工已审阅）。`,
    task.deps && task.deps !== '无' ? `依赖：${task.deps}（先于本任务合并）。` : '依赖：无。',
    '',
    '## 技术设计（随 worktree 携带，开工前必读）',
    '',
    `design.md 与 requirements.md 全文已随 worktree 准备拷贝到 worktree 内 .agents/orchestrator/specs/${spec.meta.id}/。`,
    `**开工前先读 worktree 内的 .agents/orchestrator/specs/${spec.meta.id}/design.md**（实现以本设计为纲；与其冲突时以已审阅的 design 为准并在 NOTES.md 说明）；`,
    `需求验收标准对照同目录 requirements.md。specs 目录在 .gitignore 内，不要改动、不要 git add 它。`,
    '',
  ];
  return [...fm, ...body].join('\n');
}

function bumpMinutes(iso, minutes) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return toIsoLocal();
  return toIsoLocal(new Date(d.getTime() + minutes * 60_000));
}

/**
 * 全局进度锚（Anthropic 长时程 harness 的 JSON feature-list 模式对应物）：
 * spec 拆出的多张卡完成态散在 queue 七目录里，progress.json 给跨夜 drain /
 * 断点续跑一个机器可读的全局视图。build 幂等重跑时按各卡当前状态刷新；
 * 后续迁移由 queue.mjs moveCard 按卡的 spec 字段同步。
 */
export function progressPath(queueRootDir, specId) {
  return path.join(queueRootDir, '..', 'specs', specId, 'progress.json');
}

export function writeProgress(queueRootDir, spec, tasks) {
  const id = spec.meta.id;
  const progress = {
    id,
    title: spec.meta.title,
    updated_at: toIsoLocal(),
    tasks: tasks.map((t) => ({
      n: t.n,
      title: t.title,
      card_id: `${id}-t${t.n}`,
      files: t.files,
      status: findCard(queueRootDir, `${id}-t${t.n}`)?.state ?? 'pending',
    })),
  };
  fs.writeFileSync(progressPath(queueRootDir, id), `${JSON.stringify(progress, null, 2)}\n`);
  return progressPath(queueRootDir, id);
}

export function readProgress(queueRootDir, specId) {
  return JSON.parse(fs.readFileSync(progressPath(queueRootDir, specId), 'utf8'));
}

/**
 * 拆卡进 pending/（幂等：同 id 已存在于任何状态目录则跳过）。
 * 返回 { created: string[], skipped: string[], warnings: string[] }。
 */
export function buildSpecCards(repoRoot, queueRootDir, id) {
  const spec = readSpec(repoRoot, id);
  const tasks = parseTasksDoc(spec.tasks);
  const created = [];
  const skipped = [];
  const warnings = [];
  if (!tasks.length) return { created, skipped, warnings: ['tasks.md 未解析到任何「## 任务 N:」段——先补任务段再 build'] };
  for (const t of tasks) {
    const cardId = `${id}-t${t.n}`;
    if (findCard(queueRootDir, cardId)) {
      skipped.push(cardId);
      continue;
    }
    if (t.files.length === 1 && t.files[0] === '**') warnings.push(`${cardId}: 「文件」行缺失或未解析，files_hint 兜底为 **（独占分区）——建议手改卡收窄`);
    fs.writeFileSync(cardPath(queueRootDir, 'pending', cardId), renderTaskCard(spec, t, tasks.length));
    created.push(cardId);
  }
  writeProgress(queueRootDir, spec, tasks);
  return { created, skipped, warnings };
}

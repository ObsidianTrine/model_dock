// scan.mjs — nightly 巡检信号源（Phase 2，docs 10.4）。
// 扫描 TODO/FIXME、npm audit、测试失败、GitHub issues、已知问题账本（known-issues.md）、
// 主干 CI 失败六类信号，**消毒后**生成提案卡落 drafts/（proposal: true）——巡检只出提案、
// 绝不直接进队列：仓库内容进 worker prompt 的注入面，第一道闸就是这里的内容消毒 +
// 人工批量 submit（或 autopilot 白名单自动提交，见 autopilot.mjs 的授权矩阵）。

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runCmd } from './gates.mjs';
import { findCard } from './queue.mjs';
import { toIsoLocal } from './events.mjs';
import { shellSpawnOptions } from './spawn-shell.mjs';

/** sha256 前 8 位：卡 id 稳定性用（内容不变 → 同 id → 重复巡检自然去重）。 */
export function sha8(s) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

/**
 * prompt injection 消毒：扫描到的仓库内容（注释文本、audit 摘要、测试输出）
 * 进任务卡（→ worker prompt）前压平——控制字符与空白折叠、删除命令结构字符、
 * 截断长度。不追求可读性完美，追求"无法携带指令结构"。
 */
export function sanitize(text, limit = 200) {
  const cleaned = String(text ?? '')
    .replace(/\p{C}/gu, ' ') // 控制字符（含换行）
    .replace(/[`<>|;${}]/g, ' ') // 命令/模板结构字符（先于空白折叠，避免二次空格）
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
  return cleaned.length === limit ? cleaned + '…' : cleaned;
}

// ---------------------------------------------------------------------------
// 信号源
// ---------------------------------------------------------------------------

const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.tsx']);
const TODO_RE = /\/\/\s*(TODO|FIXME)\b[:\s]?(.+)/;

/** 递归收集目录下的代码文件（跳过 node_modules/dist/release/.git）。 */
function walkCode(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || ['node_modules', 'dist', 'release'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkCode(p, out);
    else if (CODE_EXTS.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

/** 信号源 1：src/ 下 TODO/FIXME 注释（每个 TODO 一张卡）。 */
export function scanTodo(repoRoot) {
  const srcDir = path.join(repoRoot, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const todos = [];
  for (const file of walkCode(srcDir)) {
    let lines;
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      continue;
    }
    lines.forEach((line, i) => {
      const m = TODO_RE.exec(line);
      if (m) todos.push({ file: path.relative(repoRoot, file).replace(/\\/g, '/'), line: i + 1, kind: m[1], text: sanitize(m[2], 200) });
    });
  }
  return todos.map((t) => ({
    id: `scan-todo-${sha8(t.file + t.text)}`,
    type: 'refactor',
    priority: 'low',
    files_hint: [t.file],
    goal: `处理 ${t.file}:${t.line} 的 ${t.kind} 注释`,
    acceptance: '- 该 TODO/FIXME 已解决或转成正式任务跟踪，代码里不再残留此条目',
    background: `巡检发现：${t.file}:${t.line} — ${t.kind}：${t.text}`,
  }));
}

/** 信号源 2：npm audit 漏洞（汇总为一张卡）。 */
export function scanAudit(repoRoot) {
  // Windows 的 npm 是 .cmd 包装，spawnSync 直调必 ENOENT——win32 走 shell（见 spawn-shell.mjs）；
  // 失败由下方 catch 归一为 skipped，但静默失效会掐断 nightly audit 信号源，这里必须能真跑起来
  const r = spawnSync('npm', ['audit', '--json'], shellSpawnOptions(process.platform, { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 }));
  let json;
  try {
    json = JSON.parse(r.stdout ?? '');
  } catch {
    return { skipped: true, reason: 'npm audit 不可用（无网络或无 lockfile），跳过该信号源' };
  }
  const vulns = json.vulnerabilities ?? {};
  const names = Object.keys(vulns).sort();
  if (!names.length) return [];
  const items = names.map((n) => `${n}(${vulns[n].severity})`).join(', ');
  return [
    {
      id: `scan-audit-${sha8(names.join(',') + ':' + (json.metadata?.vulnerabilities?.total ?? names.length))}`,
      type: 'deps',
      priority: 'high',
      files_hint: ['package.json', 'package-lock.json'],
      goal: `修复 npm audit 报告的 ${names.length} 个依赖漏洞`,
      acceptance: '- npm audit 不再报告这些漏洞（升级/替换/评估豁免并说明理由）',
      background: `巡检发现依赖漏洞：${sanitize(items, 400)}`,
    },
  ];
}

/** 信号源 3：测试失败（跑 testCmd，失败才生成；每天最多一张，同日重复去重）。 */
export function scanTests(repoRoot, testCmdStr) {
  const r = runCmd(testCmdStr, repoRoot);
  if (r.ok) return [];
  const day = toIsoLocal().slice(0, 10);
  return [
    {
      id: `scan-testfail-${day}`,
      type: 'bugfix',
      priority: 'high',
      files_hint: ['src/**', 'test/**'],
      goal: `修复当前测试套件失败（巡检于 ${day}）`,
      acceptance: '- 巡检命令重跑测试全绿',
      background: `巡检发现测试失败（exit ${r.exitCode}），输出尾部：${sanitize(r.output, 400)}`,
    },
  ];
}

/** 纯映射：gh issue list 的 JSON → 任务卡数组（issue 内容过 sanitize——外部用户可写内容）。 */
export function issuesToCards(issues) {
  return (Array.isArray(issues) ? issues : [])
    .filter((i) => i && Number.isInteger(i.number) && typeof i.title === 'string' && i.title.trim())
    .map((i) => ({
      id: `scan-issue-${i.number}-${sha8(i.title.trim())}`,
      type: 'bugfix',
      priority: 'normal',
      files_hint: ['**'], // issue 不带文件线索：全通配（scope_purity 不误报；L3 人工闸兜底）
      goal: `处理 GitHub issue #${i.number}：${sanitize(i.title.trim(), 200)}`,
      acceptance: `- issue #${i.number} 所述问题已修复或有明确结论（关联提交/评论注明 #${i.number}，issue 可关闭）`,
      background: `巡检发现 open issue：${sanitize(i.url ?? '', 200) || '（无 URL）'}；正文摘录：${sanitize(i.body ?? '', 400) || '（无正文）'}`,
    }));
}

/**
 * 信号源 4：GitHub open issues（gh CLI，best-effort）。仅 origin 指向 GitHub 的仓库启用；
 * gh 未安装/未登录/超时 → { skipped, reason } 警告，不阻塞其余信号源。
 * opts.run 可注入假执行器（测试）；ORCH_GH_CLI 环境变量可指认 gh 路径（对齐 ORCH_ZCODE_CLI 惯例）。
 */
export function scanIssues(repoRoot, opts = {}) {
  let remote = '';
  try {
    remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 }).stdout ?? '';
  } catch {
    /* 无 git/无远端 */
  }
  if (!/github\.com[:/]/i.test(remote.trim())) return { skipped: true, reason: 'origin 非 GitHub 远端，跳过 issues 信号源' };
  const gh = opts.gh ?? process.env.ORCH_GH_CLI ?? 'gh';
  const r = (opts.run ?? defaultGhRun)(gh, ['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,body,url'], repoRoot);
  if (r.status !== 0) {
    return { skipped: true, reason: `gh issue list 不可用（未安装 gh 或未 gh auth login？）：${sanitize(r.stderr || '', 120) || `exit ${r.status}`}` };
  }
  let issues;
  try {
    issues = JSON.parse(r.stdout ?? '[]');
  } catch {
    return { skipped: true, reason: 'gh 输出不可解析，跳过 issues 信号源' };
  }
  return issuesToCards(issues);
}

function defaultGhRun(gh, args, cwd) {
  return spawnSync(gh, args, { cwd, encoding: 'utf8', timeout: 30_000 });
}

/** 信号源 5：docs/known-issues.md 未修条目（已知问题账本 → 提案）。容错解析总览表
 *  `| ID | 级别 | 位置 | 一句话 | 状态 |` 行：状态列含 ☑/已修/已闭环 跳过、含「暂缓」
 *  跳过（人工已裁决维持，自主提案不得推翻）。文件缺失/损坏 = 无该信号源（多数仓库
 *  没有这本账，静默跳过不告警）。 */
export function scanKnownIssues(repoRoot) {
  const file = path.join(repoRoot, 'docs', 'known-issues.md');
  if (!fs.existsSync(file)) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const cards = [];
  for (const line of text.split('\n')) {
    const m = /^\|\s*([A-Za-z]+-\d+)\s*\|/.exec(line);
    if (!m) continue;
    if (/☑|已修|已闭环|已合并|暂缓/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    // cells：[ID, 级别, 位置, 一句话, 状态]（宽松取用——列数可能因条目而异）
    const where = cells[2] ?? '';
    const what = cells[3] ?? line;
    const fileHint = /[\w./\\-]+\.(?:ts|mts|cts|js|mjs|cjs|jsx|tsx)/.exec(where)?.[0]?.replace(/\\/g, '/');
    cards.push({
      id: `scan-ki-${m[1].toLowerCase()}`,
      type: 'refactor',
      priority: 'normal',
      files_hint: [fileHint ?? 'src/**'],
      goal: `处理已知问题 ${m[1]}：${sanitize(what, 160)}`,
      acceptance: `- ${m[1]} 项按账本维护约定闭环：修复后在 docs/known-issues.md 勾选该项并标注日期与 commit`,
      background: `巡检发现已知问题账本未修条目：${sanitize(where, 120)} — ${sanitize(what, 300)}`,
    });
  }
  return cards;
}

/**
 * 信号源 6：主干 test 失败（gh run list，best-effort，模式同 scanIssues）。
 * 只看最近一条失败 run——按 head sha 建 id（同提交同 id 天然去重；run 恢复绿后不再生成）。
 */
export function scanCI(repoRoot, opts = {}) {
  let remote = '';
  try {
    remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 }).stdout ?? '';
  } catch {
    /* 无 git/无远端 */
  }
  if (!/github\.com[:/]/i.test(remote.trim())) return { skipped: true, reason: 'origin 非 GitHub 远端，跳过 CI 信号源' };
  const branch = opts.baseBranch ?? 'main';
  const gh = opts.gh ?? process.env.ORCH_GH_CLI ?? 'gh';
  const r = (opts.run ?? defaultGhRun)(gh, ['run', 'list', '--workflow', 'test', '--branch', branch, '--status', 'failure', '--limit', '1', '--json', 'databaseId,headSha,displayTitle'], repoRoot);
  if (r.status !== 0) {
    return { skipped: true, reason: `gh run list 不可用（未安装 gh 或未 gh auth login？）：${sanitize(r.stderr || '', 120) || `exit ${r.status}`}` };
  }
  let runs;
  try {
    runs = JSON.parse(r.stdout ?? '[]');
  } catch {
    return { skipped: true, reason: 'gh 输出不可解析，跳过 CI 信号源' };
  }
  const run = (Array.isArray(runs) ? runs : [])[0];
  if (!run?.headSha) return [];
  const shortSha = String(run.headSha).slice(0, 8);
  return [
    {
      id: `scan-ci-${shortSha}`,
      type: 'bugfix',
      priority: 'high',
      files_hint: ['src/**', 'test/**'],
      goal: `修复主干（${branch}）test 失败 run #${run.databaseId}`,
      acceptance: `- 失败测试修复；对应提交 ${shortSha} 上的 test workflow 全绿`,
      background: `巡检发现主干 test 失败：run ${run.databaseId}（${sanitize(run.displayTitle ?? '', 160)}，head ${run.headSha}）`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 生成提案卡（写 drafts/，proposal: true；不直接进队列——id 已存在于队列任何状态
// 目录或 drafts/ 则跳过）
// ---------------------------------------------------------------------------

function renderCard(c) {
  return [
    '---',
    `id: ${c.id}`,
    `type: ${c.type}`,
    `priority: ${c.priority}`,
    `created_at: ${toIsoLocal()}`,
    'created_by: scanner',
    'files_hint:',
    ...c.files_hint.map((f) => `  - ${f}`),
    'workflows:',
    '  - feature-branch',
    'gate: L3',
    'proposal: true',
    '---',
    '',
    `# 目标`,
    c.goal,
    '',
    `# 验收标准`,
    c.acceptance,
    '',
    `# 背景`,
    c.background,
    '',
  ].join('\n');
}

/**
 * 执行巡检并落提案。返回 { created: string[], skipped: string[], warnings: string[] }。
 * opts: { todo, audit, tests, issues, ki, ci, dryRun, testCmd, gh, ghRun, baseBranch }
 * 产出一律落 drafts/（提案态）：submitDraft 进队列（人工 submit 或 autopilot 白名单）。
 */
export function runScan(repoRoot, opts = {}) {
  const root = path.join(repoRoot, '.agents', 'orchestrator', 'queue');
  const drafts = path.join(repoRoot, '.agents', 'orchestrator', 'drafts');
  fs.mkdirSync(path.join(root, 'pending'), { recursive: true });
  fs.mkdirSync(drafts, { recursive: true });
  const created = [];
  const skipped = [];
  const warnings = [];

  const candidates = [];
  if (opts.todo) candidates.push(...scanTodo(repoRoot));
  if (opts.audit) {
    const r = scanAudit(repoRoot);
    if (r.skipped) warnings.push(r.reason);
    else candidates.push(...r);
  }
  if (opts.tests) candidates.push(...scanTests(repoRoot, opts.testCmd));
  if (opts.issues) {
    const r = scanIssues(repoRoot, { gh: opts.gh, run: opts.ghRun }); // ghRun：测试注入假执行器
    if (r.skipped) warnings.push(r.reason);
    else candidates.push(...r);
  }
  if (opts.ki) candidates.push(...scanKnownIssues(repoRoot));
  if (opts.ci) {
    const r = scanCI(repoRoot, { baseBranch: opts.baseBranch, gh: opts.gh, run: opts.ghRun });
    if (r.skipped) warnings.push(r.reason);
    else candidates.push(...r);
  }

  for (const c of candidates) {
    if (findCard(root, c.id) || fs.existsSync(path.join(drafts, `${c.id}.md`))) {
      skipped.push(c.id);
      continue;
    }
    if (opts.dryRun) {
      created.push(`[dry-run] ${c.id}`);
      continue;
    }
    fs.writeFileSync(path.join(drafts, `${c.id}.md`), renderCard(c));
    created.push(c.id);
  }
  return { created, skipped, warnings };
}

#!/usr/bin/env node
// fleet-console.mjs — 舰队控制台：一条命令聚合多个项目的 Dockmaster 健康度。
// 背景：Dockmaster 随 .agents/ 工具链移植后，一台机器上会同时有多个「港口」（项目）
// 各自跑编排闭环；健康度散落在各仓的 .agents/orchestrator/ 下，人要逐仓查。本脚本
// 只读聚合——queue 各状态卡数、近 N 天 fleet 级事件（weather_hold / sail_*）、
// 夜航巡检时间、drift 降级标记，并逐港 spawn 各仓自带的 orchestrator.mjs stats
// 取窗口汇总（合并率 / 安全晴雨表）。
// 设计约束：
//   - 纯只读：不改任何港口状态（drift 只读 degraded.json 标记，不触发重评）。
//   - 容错：单个港口坏（工具链缺失 / stats 失败 / 输出损坏）标「不可得」继续，
//     绝不让一个坏港口炸掉整份舰队报告。
//   - 零第三方依赖（.agents/ 工具链红线），Node ≥18，三平台兼容
//     （路径一律 path.join，spawn node 一律 process.execPath）。
// 用法：
//   node fleet-console.mjs [--project <目录>]... [--days 7] [--json]
// 项目清单 = CLI --project（可多次）+ 配置文件 ~/.agents/fleet-console.json
// （{"projects": ["..."]}，相对路径相对 ~/.agents 解析）+ 当前仓库，合并去重。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 与 orchestrator/queue.mjs 的 STATES 对齐（7 个泊位状态目录）。 */
const QUEUE_STATES = ['pending', 'running', 'reviewing', 'awaiting-human', 'merged', 'failed', 'blocked'];

/** stats 子进程超时：stats 是一次日志扫描，正常秒级；30s 给慢盘/大日志留余量。 */
const STATS_TIMEOUT_MS = 30_000;

const DAY_MS = 86_400_000;

function die(msg, code = 1) {
  console.error(`[fleet-console] ${msg}`);
  process.exit(code);
}

function warn(msg) {
  console.error(`[fleet-console] ${msg}`);
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function usage() {
  return `⚓ 舰队控制台（fleet-console）——聚合多个项目的 Dockmaster 健康度（纯只读）

用法:
  node fleet-console.mjs [--project <目录>]... [--days 7] [--json]

参数:
  --project <目录>  纳入聚合的项目根目录；可重复传多个
  --days <N>        统计窗口（天），缺省 7；影响 stats 汇总窗口与 fleet 事件过滤
  --json            输出机器可读 JSON（人类可读表格关闭）
  -h, --help        本帮助

项目清单来源（合并去重）:
  1. CLI --project 参数（可多次）
  2. 配置文件 ~/.agents/fleet-console.json：{ "projects": ["/abs/path/a", ...] }
     （相对路径相对 ~/.agents 解析；文件缺失视为无自定义，格式错误告警后忽略）
  3. 当前仓库（始终包含，已在清单中则去重）

每个港口采集:
  - .agents/orchestrator/queue/ 七个状态目录的卡数
  - logs/fleet.jsonl 近 N 天事件（weather_hold / sail_* 等，按类型计数）
  - logs/nightly-state.json 上次夜航巡检时间
  - .agents/orchestrator/degraded.json 质量漂移降级标记
  - spawn 该仓自带的 .agents/scripts/orchestrator.mjs stats --json --days N 取汇总
    （合并率 / 安全晴雨表 near_miss；失败标「不可得」继续）

示例:
  node .agents/scripts/fleet-console.mjs                          # 当前仓库 + 配置文件里的港口
  node .agents/scripts/fleet-console.mjs --project ~/proj/a --project ~/proj/b
  node .agents/scripts/fleet-console.mjs --days 30 --json`;
}

function parseArgs(argv) {
  const opts = { projects: [], days: 7, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = (name) => {
      if (a === name) {
        i += 1;
        if (i >= argv.length) die(`${name} 缺少参数值。示例：${name} /path/to/project`);
        return argv[i];
      }
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      return null;
    };
    const proj = takeValue('--project');
    if (proj !== null) {
      if (!proj.trim()) die('--project 的值不能为空。示例：--project /path/to/project');
      opts.projects.push(proj.trim());
      continue;
    }
    const days = takeValue('--days');
    if (days !== null) {
      const n = Number(days);
      if (!Number.isInteger(n) || n < 1 || n > 365) {
        die(`--days 需要正整数（1-365），收到「${days}」。示例：--days 7`);
      }
      opts.days = n;
      continue;
    }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '-h' || a === '--help' || a === 'help') { opts.help = true; continue; }
    die(`未知参数「${a}」。用 --help 查看用法。`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 项目清单（CLI + 配置文件 + 当前仓库，合并去重）
// ---------------------------------------------------------------------------

/** 当前仓库：从 cwd 向上找 .git（与 feature-branch.mjs 的回退策略一致）；找不到用 cwd。 */
function currentRepoRoot() {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/**
 * 读配置文件 ~/.agents/fleet-console.json。
 * 缺失 → 空清单；缺失字段/形态错/JSON 损坏 → 告警后忽略（只读观测工具，
 * 失败 open 不阻断报告——与 presets.json「格式错误阻断启动」不同：那是写路径，这是看板）。
 */
function readConfigProjects(configFile) {
  if (!fs.existsSync(configFile)) return [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (e) {
    warn(`配置文件不是合法 JSON：${configFile}（${e.message}）——忽略该配置继续；请修复格式或删除文件。`);
    return [];
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.projects)) {
    warn(`配置文件形态不对：${configFile}——需要 { "projects": ["目录", ...] }；已忽略，请修正后重跑。`);
    return [];
  }
  return raw.projects.map(String).filter((s) => s.trim());
}

/** 清单合成 + 按 resolve 后的绝对路径去重（保持首次出现顺序）。 */
function resolveProjectList(cliProjects) {
  const configFile = path.join(os.homedir(), '.agents', 'fleet-console.json');
  const entries = [
    ...cliProjects,
    ...readConfigProjects(configFile).map((p) => (path.isAbsolute(p) ? p : path.join(path.dirname(configFile), p))),
    currentRepoRoot(),
  ];
  const seen = new Set();
  const list = [];
  for (const e of entries) {
    const abs = path.resolve(e);
    if (seen.has(abs)) continue;
    seen.add(abs);
    list.push(abs);
  }
  return { list, configFile };
}

// ---------------------------------------------------------------------------
// 单港采集（全部容错：坏文件按缺失处理，绝不抛出）
// ---------------------------------------------------------------------------

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** queue/<state>/ 下的卡数（与 queue.mjs listCards 同口径：只数 .md）。 */
function countCards(orchRoot, state) {
  const dir = path.join(orchRoot, 'queue', state);
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/** fleet.jsonl 近 N 天事件按类型计数（半行/损坏行跳过——与 readFleetEvents 同容错）。 */
function recentFleetEventCounts(orchRoot, sinceMs) {
  const f = path.join(orchRoot, 'logs', 'fleet.jsonl');
  if (!fs.existsSync(f)) return {};
  const counts = {};
  let lines = [];
  try {
    lines = fs.readFileSync(f, 'utf8').split('\n');
  } catch {
    return {};
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch { /* 崩溃残留半行，忽略 */ continue; }
    const ts = Date.parse(e?.ts ?? '');
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    const type = typeof e.type === 'string' ? e.type : 'unknown';
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

/** 上次夜航巡检时间（logs/nightly-state.json：{startedAt, finishedAt?, result?}）。 */
function readNightly(orchRoot) {
  const st = readJsonSafe(path.join(orchRoot, 'logs', 'nightly-state.json'));
  if (!st || typeof st !== 'object' || Array.isArray(st)) return null;
  return {
    startedAt: typeof st.startedAt === 'string' ? st.startedAt : null,
    finishedAt: typeof st.finishedAt === 'string' ? st.finishedAt : null,
    result: typeof st.result === 'string' ? st.result : null,
  };
}

/** 质量漂移降级标记（degraded.json 存在 = 降级期）。只读，不触发重评。 */
function readDrift(orchRoot) {
  const d = readJsonSafe(path.join(orchRoot, 'degraded.json'));
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  return {
    degraded_at: typeof d.degraded_at === 'string' ? d.degraded_at : null,
    reason: typeof d.reason === 'string' ? d.reason : null,
  };
}

/**
 * 度量：spawn 该仓自带的 orchestrator.mjs stats --json --days N（cwd=项目根）。
 * 工具链自包含——各港口用各自的编排器版本出账，不跨仓串味。
 * 失败（脚本缺失/超时/非零退出/输出损坏）→ { summary: null, error: 原因 }。
 */
function collectStats(root, days) {
  const script = path.join(root, '.agents', 'scripts', 'orchestrator.mjs');
  if (!fs.existsSync(script)) {
    return { summary: null, error: '未找到 .agents/scripts/orchestrator.mjs（该仓未部署编排工具链？）' };
  }
  let r;
  try {
    r = spawnSync(process.execPath, [script, 'stats', '--json', '--days', String(days)], {
      cwd: root,
      encoding: 'utf8',
      timeout: STATS_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { summary: null, error: `stats 执行异常：${e?.message ?? e}` };
  }
  if (r.error) {
    const reason = r.error.code === 'ETIMEDOUT' ? `stats 超时（>${STATS_TIMEOUT_MS / 1000}s）` : `stats 无法启动：${r.error.code ?? r.error.message}`;
    return { summary: null, error: reason };
  }
  if (r.status !== 0) {
    const tail = String(r.stderr ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(-2).join('；').slice(0, 200);
    return { summary: null, error: `stats 退出码 ${r.status}${tail ? `：${tail}` : ''}` };
  }
  const out = String(r.stdout ?? '').trim();
  const start = out.indexOf('{');
  try {
    const parsed = JSON.parse(start > 0 ? out.slice(start) : out);
    if (!parsed || typeof parsed !== 'object' || !parsed.summary || typeof parsed.summary !== 'object') {
      return { summary: null, error: 'stats 输出缺少 summary 对象（编排器版本过旧？）' };
    }
    return { summary: parsed.summary, error: null };
  } catch {
    return { summary: null, error: 'stats 输出不是合法 JSON（编排器版本过旧或输出被污染？）' };
  }
}

/** 单港口采集主入口。非港口（无 .agents/orchestrator/）只记 kind，其余字段不采。 */
function collectProject(root, days) {
  const orchRoot = path.join(root, '.agents', 'orchestrator');
  const project = {
    root,
    name: path.basename(root),
    kind: fs.existsSync(orchRoot) ? 'dockmaster' : 'non-port',
    exists: fs.existsSync(root),
    queue: Object.fromEntries(QUEUE_STATES.map((s) => [s, 0])),
    stats_summary: null,
    stats_error: null,
    fleet_events: {},
    nightly: null,
    drift_degraded: null,
  };
  if (project.kind !== 'dockmaster') return project;
  for (const s of QUEUE_STATES) project.queue[s] = countCards(orchRoot, s);
  const stats = collectStats(root, days);
  project.stats_summary = stats.summary;
  project.stats_error = stats.error;
  project.fleet_events = recentFleetEventCounts(orchRoot, Date.now() - days * DAY_MS);
  project.nightly = readNightly(orchRoot);
  project.drift_degraded = readDrift(orchRoot);
  return project;
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

/** near_miss 四类合计（缺字段按 0）。 */
function nearMissTotal(nm) {
  if (!nm || typeof nm !== 'object') return 0;
  return ['watchdog', 'retries', 'xte', 'incidents'].reduce((n, k) => n + (Number(nm[k]) || 0), 0);
}

function aggregate(projects, days) {
  const ports = projects.filter((p) => p.kind === 'dockmaster');
  const nonPorts = projects.filter((p) => p.kind !== 'dockmaster');
  const totals = {
    ports: ports.length,
    non_ports: nonPorts.length,
    queue: Object.fromEntries(QUEUE_STATES.map((s) => [s, ports.reduce((n, p) => n + p.queue[s], 0)])),
    // 窗口汇总只对「stats 可得」的港口求和：缺港口时是下界，如实注明
    merged_window: null,
    settled_window: null,
    merge_rate: null,
    near_miss: null,
    weather_hold: ports.reduce((n, p) => n + (p.fleet_events.weather_hold ?? 0), 0),
    degraded_ports: ports.filter((p) => p.drift_degraded).length,
    stats_ok_ports: ports.filter((p) => p.stats_summary).length,
  };
  const withStats = ports.filter((p) => p.stats_summary);
  if (withStats.length) {
    const merged = withStats.reduce((n, p) => n + (Number(p.stats_summary.merged) || 0), 0);
    const settled = withStats.reduce((n, p) => n + (Number(p.stats_summary.settled) || 0), 0);
    totals.merged_window = merged;
    totals.settled_window = settled;
    totals.merge_rate = settled > 0 ? Math.round((merged / settled) * 100) / 100 : null;
    totals.near_miss = { watchdog: 0, retries: 0, xte: 0, incidents: 0 };
    for (const p of withStats) {
      const nm = p.stats_summary.near_miss ?? {};
      for (const k of Object.keys(totals.near_miss)) totals.near_miss[k] += Number(nm[k]) || 0;
    }
  }
  return { generated_at: new Date().toISOString(), days, projects, totals };
}

// ---------------------------------------------------------------------------
// 人类可读输出（CJK 宽度对齐表格）
// ---------------------------------------------------------------------------

function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  return w;
}

function pad(s, w) {
  s = String(s);
  return s + ' '.repeat(Math.max(w - strWidth(s), 0));
}

function padLeft(s, w) {
  s = String(s);
  return ' '.repeat(Math.max(w - strWidth(s), 0)) + s;
}

/** ISO 时间 → 本地「MM-DD HH:mm」。 */
function shortTime(iso) {
  const ts = Date.parse(iso ?? '');
  if (!Number.isFinite(ts)) return null;
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function renderHuman(report) {
  const { projects, totals, days } = report;
  const ports = projects.filter((p) => p.kind === 'dockmaster');
  const nonPorts = projects.filter((p) => p.kind !== 'dockmaster');
  const lines = [];
  lines.push(`⚓ 舰队控制台（近 ${days} 天）——${totals.ports} 个港口${nonPorts.length ? `，${nonPorts.length} 个非港口` : ''}`);
  if (!ports.length) {
    lines.push('');
    lines.push('没有任何 Dockmaster 港口可聚合。排查建议：');
    lines.push('  - 确认项目根下存在 .agents/orchestrator/（跑过编排闭环的项目才有）');
    lines.push('  - 用 --project <目录> 显式指定项目，或检查 ~/.agents/fleet-console.json 配置');
  }
  const cols = [
    { label: '项目', width: Math.max(strWidth('项目') + 2, ...ports.map((p) => strWidth(p.name))) },
    { label: '待泊', width: 6, num: true },
    { label: '在坞', width: 6, num: true },
    { label: '搁浅', width: 6, num: true },
    { label: '待放行', width: 8, num: true },
    { label: `出港${days}d`, width: 7, num: true },
    { label: '合并率', width: 7, num: true },
    { label: '险情', width: 5, num: true },
    { label: '风暴', width: 5, num: true },
    { label: '漂移', width: 8 },
    { label: '巡检', width: 14 },
  ];
  // 列宽按数据自适应（列头与单元格取最大）
  const rows = ports.map((p) => {
    const s = p.stats_summary;
    const rate = s && s.merge_rate != null ? `${Math.round(s.merge_rate * 100)}%` : '-';
    const drift = p.drift_degraded ? `降级(${shortTime(p.drift_degraded.degraded_at) ?? '?'})` : '-';
    const nightly = p.nightly
      ? p.nightly.finishedAt
        ? (shortTime(p.nightly.finishedAt) ?? '-')
        : `⚠未收尾 ${shortTime(p.nightly.startedAt) ?? '-'}`
      : '-';
    return [
      p.name,
      p.queue.pending,
      p.queue.running,
      p.queue.blocked,
      p.queue['awaiting-human'],
      s && s.merged != null ? s.merged : '-',
      rate,
      s ? nearMissTotal(s.near_miss) : '-',
      p.fleet_events.weather_hold ?? 0,
      drift,
      nightly,
    ];
  });
  if (ports.length) {
    const t = totals;
    const rate = t.merge_rate != null ? `${Math.round(t.merge_rate * 100)}%` : '-';
    rows.push([
      '合计',
      t.queue.pending,
      t.queue.running,
      t.queue.blocked,
      t.queue['awaiting-human'],
      t.merged_window != null ? t.merged_window : '-',
      rate,
      t.near_miss ? nearMissTotal(t.near_miss) : '-',
      t.weather_hold,
      t.degraded_ports > 0 ? `降级${t.degraded_ports}港` : '-',
      '-',
    ]);
  }
  // 数据进入后再校准每列宽（含表头）
  for (let c = 0; c < cols.length; c++) {
    cols[c].width = Math.max(cols[c].width, ...rows.map((r) => strWidth(r[c])));
  }
  lines.push('');
  lines.push(cols.map((c, i) => (c.num && i > 0 ? padLeft(c.label, c.width) : pad(c.label, c.width))).join(' '));
  for (const r of rows) {
    lines.push(r.map((cell, i) => (cols[i].num && i > 0 ? padLeft(cell, cols[i].width) : pad(cell, cols[i].width))).join(' '));
  }
  const partial = ports.filter((p) => p.stats_error);
  if (partial.length) {
    lines.push('');
    lines.push('窗口汇总不可得的项目（其余指标仍有效）:');
    for (const p of partial) lines.push(`  - ${p.name}：${p.stats_error}`);
  }
  if (nonPorts.length) {
    lines.push('');
    lines.push('非港口（无 .agents/orchestrator/，已跳过）:');
    for (const p of nonPorts) lines.push(`  - ${p.root}${p.exists ? '' : '（目录不存在）'}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  const { list } = resolveProjectList(opts.projects);
  const projects = list.map((root) => collectProject(root, opts.days));
  const report = aggregate(projects, opts.days);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderHuman(report));
  }
}

main();

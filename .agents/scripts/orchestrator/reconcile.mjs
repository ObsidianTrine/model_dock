// reconcile.mjs — 狗粮对账（Phase 2 展望项落地，docs 10.7）。
// worker 的 token 用量有两本账：
//   自报账：任务 events.jsonl 的 budget_snapshot（stream-json result 回填；第三方上游
//           流式 usage 全 0 时运行中数值不可信，见 docs 5.10）；
//   实测账：网关请求日志（gateway-YYYY-MM-DD.jsonl）的 usage 字段——网关转发层从上游
//           响应旁路解析（src/gateway/usage.ts），网关只看得到经它转发的流量。
// 对账 = 把任务事件时间窗（worker_spawned 首条 → merged/failed 尾条）投影到网关日志，
// 汇总实测用量与自报用量对比。worker 走网关（吃狗粮）时两本账应该贴近；直连上游时实测账为 0。
//
// 状态对账（reconcileCardStates）：卡状态 vs git 现实。真实数据发现 running/ 里有卡
// 实际已 git 合并但卡没落 merged/（状态机被人工旁路，如手工 git merge 后忘了 moveCard）——
// 用 `git log --merges <baseBranch>` 解析「已合并分支」集合对照队列各状态目录：
//   已合并未落位（分支已合并、卡不在 merged/）→ 默认只读列出；--fix-states 落位并写事件；
//   账面合并但 git 无实证（卡在 merged/、无对应 merge 提交）→ 警告级（可能是 squash 或改史）。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { STATES, cardPath, listCards, moveCard } from './queue.mjs';
import { appendEvent, logDir, readEvents } from './events.mjs';
import { loadWorkflowConfig } from '../workflow-config.mjs';

/**
 * 网关日志目录解析序：
 *   1. MODELRDOCK_FAKE_HOME / MODELRDOCK_HOME 环境重定向（测试隔离/多实例，既有机制，优先）；
 *   2. workflow.json gatewayLogDir（载入时已展开 ~/）——显式配置才启用对账；
 *   3. 都没有 → null（对账关闭。吃狗粮是走网关的项目才有的能力，其他项目缺省不可用）。
 */
export function gatewayLogsDir(cfg) {
  const envBase = process.env.MODELRDOCK_FAKE_HOME || process.env.MODELRDOCK_HOME;
  if (envBase) return path.join(envBase, '.modeldock', 'logs');
  return (cfg ?? loadWorkflowConfig()).gatewayLogDir || null;
}

function usageTotal(u) {
  if (!u) return 0;
  // 对账口径与 docs 5.10 预算口径一致：缓存读计入输入
  return (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0) + (u.output_tokens ?? 0);
}

/** 解析本地 ISO 时间戳（网关日志与 events 同格式），失败返回 NaN。 */
function parseTs(ts) {
  return new Date(String(ts)).getTime();
}

/** 读某日期网关日志的全部请求条目（容错半行）。 */
export function readGatewayLog(dir, date) {
  const file = path.join(dir, `gateway-${date}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 崩溃半行 */
    }
  }
  return out;
}

/**
 * 单任务对账：事件时间窗内的网关转发请求汇总。
 * 多天任务自动跨日期文件；MODELRDOCK_FAKE_HOME/HOME 重定向生效（测试隔离）。
 */
export function reconcileTask(repoRoot, taskId, queueRootDir) {
  const logsRoot = path.join(repoRoot, '.agents', 'orchestrator', 'logs', taskId);
  const events = readEvents(logsRoot);
  const spawned = events.filter((e) => e.type === 'worker_spawned');
  if (!spawned.length) return { skipped: true, reason: '无 worker 运行记录' };
  const start = parseTs(spawned[0].ts);
  const endEvts = events.filter((e) => ['merged', 'failed', 'blocked'].includes(e.type));
  const end = endEvts.length ? parseTs(endEvts[endEvts.length - 1].ts) : Date.now();

  const snapshots = events.filter((e) => e.type === 'budget_snapshot');
  const selfReported = {
    tokensIn: Math.max(0, ...snapshots.map((e) => e.tokens_in ?? 0)),
    tokensOut: Math.max(0, ...snapshots.map((e) => e.tokens_out ?? 0)),
  };

  // 锚定 repoRoot 的配置（临时仓库/测试才有正确归属；env 重定向仍优先——测试隔离通道）
  const gwDir = gatewayLogsDir(loadWorkflowConfig(repoRoot));
  if (!gwDir) return { skipped: true, reason: '未启用网关对账（workflow.json gatewayLogDir 未配置）' };
  const observed = { requests: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0 };
  for (let day = new Date(start); day.getTime() <= end; day.setDate(day.getDate() + 1)) {
    const date = new Date(day.getTime() - day.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    for (const entry of readGatewayLog(gwDir, date)) {
      const ts = parseTs(entry.ts);
      if (!(ts >= start - 60_000 && ts <= end + 60_000)) continue; // 1 分钟容差
      if (entry.status === undefined || entry.status >= 400) continue; // 只算成功转发
      const u = entry.usage;
      if (!u) continue;
      observed.requests += 1;
      observed.tokensIn += (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0);
      observed.tokensOut += u.output_tokens ?? 0;
      observed.cacheRead += u.cache_read_tokens ?? 0;
      observed.cacheCreate += u.cache_creation_tokens ?? 0;
    }
  }

  const selfTotal = selfReported.tokensIn + selfReported.tokensOut;
  const gwTotal = observed.tokensIn + observed.tokensOut;
  // 偏差率：以较大的一边为分母（衡量两本账的相对分歧，避免零分母）
  const divergence = selfTotal + gwTotal > 0 ? Math.abs(selfTotal - gwTotal) / Math.max(selfTotal, gwTotal) : 0;
  return {
    skipped: false,
    taskId,
    window: { start: new Date(start).toISOString(), end: new Date(Math.min(end, Date.now())).toISOString() },
    selfReported,
    selfTotal,
    gateway: { ...observed, total: gwTotal },
    divergence,
    /** worker 是否走网关（实测账非空）。直连上游时对账无意义。 */
    viaGateway: gwTotal > 0,
  };
}

/**
 * 上游海况摘要（VDR 事故调查包用）：把任务事件时间窗投影到网关请求日志的**全量**请求。
 * 与 reconcileTask 同窗口（worker_spawned 首条 → 终态尾条，±60s 容差）、同日期文件切分，
 * 但不过滤失败请求——调查包关心的是上游风暴本身：429/5xx 分布、路由事件痕迹（reason
 * 标记 failover_to:/down_all/skip_all）、时延分位、实测用量、最近一次失败现场。
 * events 复用调用方已读的事件流（archiveIncident 手里有一份，避免重复读盘）。
 * skipped=true 时带可操作 reason；未启用网关日志（gatewayLogsDir null）与对账同口径。
 */
export function upstreamSeaState(repoRoot, events) {
  const spawned = events.filter((e) => e.type === 'worker_spawned');
  if (!spawned.length) return { skipped: true, reason: '无 worker 运行记录' };
  const start = parseTs(spawned[0].ts);
  const endEvts = events.filter((e) => ['merged', 'failed', 'blocked'].includes(e.type));
  const end = endEvts.length ? parseTs(endEvts[endEvts.length - 1].ts) : Date.now();

  const gwDir = gatewayLogsDir(loadWorkflowConfig(repoRoot));
  if (!gwDir) return { skipped: true, reason: '未启用网关日志（workflow.json gatewayLogDir 未配置）' };

  const entries = [];
  for (let day = new Date(start); day.getTime() <= end; day.setDate(day.getDate() + 1)) {
    const date = new Date(day.getTime() - day.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    for (const entry of readGatewayLog(gwDir, date)) {
      const ts = parseTs(entry.ts);
      if (ts >= start - 60_000 && ts <= end + 60_000) entries.push(entry);
    }
  }
  if (!entries.length) {
    return { skipped: true, reason: '任务时间窗内网关日志无请求记录（worker 可能直连上游，或日志已被清理）' };
  }

  const ok = entries.filter((e) => e.status !== undefined && e.status < 400);
  const failed = entries.filter((e) => e.status === undefined || e.status >= 400);
  const tally = (list, key) => {
    const m = {};
    for (const e of list) {
      const k = String(e[key] ?? 'n/a');
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  };
  const topN = (m, n) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n);
  const lat = ok.map((e) => e.ms).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const quantile = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] : undefined);
  // 用量口径与 reconcileTask 一致（缓存读+缓存建计入输入），但只计成功转发
  const tokens = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
  for (const e of ok) {
    const u = e.usage;
    if (!u) continue;
    tokens.in += (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0);
    tokens.out += u.output_tokens ?? 0;
    tokens.cacheRead += u.cache_read_tokens ?? 0;
    tokens.cacheCreate += u.cache_creation_tokens ?? 0;
  }
  // reason 非空即路由事件（日志过滤依赖「非空即事件」），failover_to:<id> 按前缀归并
  const routeEvents = {};
  for (const e of entries) {
    if (!e.reason) continue;
    const k = e.reason.startsWith('failover_to:') ? 'failover_to' : e.reason;
    routeEvents[k] = (routeEvents[k] ?? 0) + 1;
  }
  const lastFail = failed.length ? failed[failed.length - 1] : null;
  return {
    skipped: false,
    window: { start: new Date(start).toISOString(), end: new Date(Math.min(end, Date.now())).toISOString() },
    requests: entries.length,
    ok: ok.length,
    failed: failed.length,
    failStatus: tally(failed, 'status'),
    providers: tally(entries, 'provider'),
    models: tally(entries.filter((e) => e.model), 'model'),
    latency: { p50: quantile(0.5), p95: quantile(0.95) },
    tokens,
    routeEvents,
    lastFailure: lastFail
      ? {
          ts: lastFail.ts,
          status: lastFail.status,
          provider: lastFail.provider,
          model: lastFail.model,
          reason: lastFail.reason,
          err: lastFail.err ? String(lastFail.err).slice(0, 160) : undefined,
        }
      : null,
  };
}

/** 全部 merged 任务的对账汇总（按 divergence 降序，最可疑的在前）。 */
export function reconcileAll(repoRoot, queueRootDir) {
  const out = [];
  for (const id of listCards(queueRootDir, 'merged')) {
    const r = reconcileTask(repoRoot, id, queueRootDir);
    if (!r.skipped) out.push(r);
  }
  out.sort((a, b) => b.divergence - a.divergence);
  return out;
}

// ---------------------------------------------------------------------------
// 状态对账：卡状态 vs git 现实（状态机被人工旁路的检测，见文件头注）
// ---------------------------------------------------------------------------

/**
 * 从 git merge 提交标题解析已合并的 feature 分支任务 id 集合。
 * 形态：`Merge branch 'feature/<id>'`（finish 的默认消息）；容忍单双引号、
 * 分支分隔符差异（[\\/]）与 `into <branch>` 尾巴（合并进非默认分支时 git 会追加）。
 * 非任务 id 字符集（小写字母/数字/短横线）的分支名不收——队列 id 本就受此约束。
 */
export function parseMergedBranchIds(subjects) {
  const lines = Array.isArray(subjects) ? subjects : String(subjects ?? '').split('\n');
  const ids = new Set();
  const re = /^Merge branch ['"]feature[\\/]([a-z0-9][a-z0-9-]*)['"](?:\s|$)/;
  for (const line of lines) {
    const m = re.exec(line.trim());
    if (m) ids.add(m[1]);
  }
  return ids;
}

/**
 * 把「已合并未落位」的卡落位 merged/。白名单不允许的迁移（pending/blocked/failed →
 * merged）走直接 rename——对账修复是状态机被旁路后的事后纠正，与 abandon 直落 failed/
 * 同一兜底地位；git 已合并是比迁移白名单更高的事实。
 */
function forceSettleCard(root, id, from) {
  const src = cardPath(root, from, id);
  if (!fs.existsSync(src)) return false; // 并发变动：卡已不在原状态目录，跳过
  try {
    moveCard(root, id, from, 'merged');
  } catch {
    fs.renameSync(src, cardPath(root, 'merged', id));
  }
  return true;
}

/**
 * 状态对账：git 合并现实 vs 队列卡落位。
 *   - 分支已合并但卡不在 merged/ → mergedNotSettled [{id, state}]（含当前状态）；
 *   - 卡在 merged/ 但 git 无对应 merge 提交 → settledNotMerged [{id}]（警告级，可能是
 *     squash 或改史——squash 不产生 merge 提交，属已知盲区，只提示不强修）。
 * opts.fix = true 时把「已合并未落位」的卡落位 merged/ 并写 state_reconciled 事件；
 * opts.baseBranch 覆盖 workflow.json 的基准分支（测试注入用）。
 */
export function reconcileCardStates(repoRoot, queueRootDir, opts = {}) {
  const baseBranch = opts.baseBranch ?? loadWorkflowConfig(repoRoot).baseBranch ?? 'develop';
  let subjects;
  try {
    subjects = execFileSync('git', ['log', '--merges', '--pretty=%s', baseBranch], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`git log --merges 读取失败（基准分支 ${baseBranch}）：${String(e?.message ?? e).trim()}`);
  }
  const mergedIds = parseMergedBranchIds(subjects);
  const mergedNotSettled = [];
  for (const state of STATES) {
    if (state === 'merged') continue;
    for (const id of listCards(queueRootDir, state)) {
      if (mergedIds.has(id)) mergedNotSettled.push({ id, state });
    }
  }
  const settledNotMerged = listCards(queueRootDir, 'merged')
    .filter((id) => !mergedIds.has(id))
    .map((id) => ({ id }));
  const result = { baseBranch, mergedIds: [...mergedIds].sort(), mergedNotSettled, settledNotMerged, fixed: [] };
  if (opts.fix) {
    for (const c of mergedNotSettled) {
      appendEvent(logDir(repoRoot, c.id), 'state_reconciled', { from: c.state, to: 'merged', base_branch: baseBranch });
      if (forceSettleCard(queueRootDir, c.id, c.state)) result.fixed.push(c.id);
    }
  }
  return result;
}

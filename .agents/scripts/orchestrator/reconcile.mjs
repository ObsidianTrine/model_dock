// reconcile.mjs — 狗粮对账（Phase 2 展望项落地，docs 10.7）。
// worker 的 token 用量有两本账：
//   自报账：任务 events.jsonl 的 budget_snapshot（stream-json result 回填；第三方上游
//           流式 usage 全 0 时运行中数值不可信，见 docs 5.10）；
//   实测账：网关请求日志（gateway-YYYY-MM-DD.jsonl）的 usage 字段——网关转发层从上游
//           响应旁路解析（src/gateway/usage.ts），网关只看得到经它转发的流量。
// 对账 = 把任务事件时间窗（worker_spawned 首条 → merged/failed 尾条）投影到网关日志，
// 汇总实测用量与自报用量对比。worker 走网关（吃狗粮）时两本账应该贴近；直连上游时实测账为 0。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listCards } from './queue.mjs';
import { readEvents } from './events.mjs';

/** 网关日志目录（真实 HOME 下的 ~/.modeldock/logs；测试经 MODELRDOCK_* 重定向隔离）。 */
export function gatewayLogsDir() {
  return path.join(process.env.MODELRDOCK_FAKE_HOME || process.env.MODELRDOCK_HOME || os.homedir(), '.modeldock', 'logs');
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

  const gwDir = gatewayLogsDir();
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

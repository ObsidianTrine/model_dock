// weather.mjs — 风暴闸（weather hold）：窗口期内瞬时故障计数与滞留判定。
// 背景（2026-10-29 夜跑实证）：GLM 并发上限被占满时 worker 连环 429，drain 仍逐卡
// 派发、逐卡烧成 blocked——风暴中应该收帆停派，等窗口滑过再出航。设计取向：
//   - 无状态：每次派发前现算窗口计数，不落 hold 标记文件——窗口滑过自动恢复，
//     不存在「标记忘了清」的次生故障。
//   - fleet 级事件（logs/fleet.jsonl）：跨任务的调度层留痕与任务 events.jsonl
//     分文件（任务线保持单任务语义），格式与任务事件同构（ts/seq/type）。
// 上游海况（countUpstreamStorm）：网关先于 worker 看到上游限流（任何 harness 的流量
// 都经它转发）——窗口内 429/402 合计达阈值同样滞留，风暴中比 worker 重试信号更早收帆。
// 上游海况数据面（2026-11-04，A1）：优先消费 /_modeldock/metrics 的权威海况
// （sea_state.storm + per-provider 滑窗错误分桶，5min 节流缓存）；metrics 不可得 →
// /_modeldock/usage 聚合端点（A3，2026-11：by_status 的 429+402 计数，同步桥同款信任域
// 与缓存）；端点也不可得 → 自动落回现有网关日志 429/402 扫描——观测失败绝不阻断派发
//（fail-open）。
// 零第三方依赖（.agents/ 工具链红线）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { toIsoLocal } from './events.mjs';
import { readGatewayLog } from './reconcile.mjs';
import { resolveGatewayAdmin } from './tiers.mjs';

/**
 * 统计各任务 events 里窗口期内的 worker_retry 事件数合计。
 * @param {Array<{id?: string, events: Array<object>} | Array<object>>} allEvents
 *        每任务一项（{id, events} 或直接事件数组）；事件需含 type 与 ts。
 * @param {{windowMs: number, now?: number}} opts now 显式传入（纯函数，测试可注入时钟）。
 * @returns {number} 窗口内 worker_retry 合计
 */
export function countRecentTransient(allEvents, { windowMs, now = Date.now() } = {}) {
  let count = 0;
  for (const item of allEvents ?? []) {
    const events = Array.isArray(item) ? item : item?.events;
    if (!Array.isArray(events)) continue;
    for (const e of events) {
      if (e?.type !== 'worker_retry') continue;
      const ts = Date.parse(e.ts ?? '');
      if (!Number.isFinite(ts)) continue;
      const age = now - ts;
      if (age >= 0 && age <= windowMs) count += 1;
    }
  }
  return count;
}

/** 滞留判定：窗口内计数达阈值即 true（≥ 语义：恰好等于阈值也算风暴）。 */
export function shouldHold(count, threshold) {
  return Number.isFinite(count) && Number.isFinite(threshold) && count >= threshold;
}

// ---------------------------------------------------------------------------
// 上游海况数据面（2026-11-04，A1）：/_modeldock/metrics 消费
// 数据源：sea_state（网关聚合风暴信号：meltdown_majority / rate_429_60m，判定常量见
// src/gateway/state/sea.ts）+ providers[].errors 滑窗错误分桶（last_5m/last_60m）。
// 并发水位 advisory（2026-11 concurrency signal）：metrics.concurrency（per-provider
// 实时 in_flight/queued/limit）汇总为 queued_providers + max_in_flight_ratio——排队出现
// 早于 429，是比 sea_state 更早的风暴前兆；**只照亮不拦截**（storm 判定阈值与派发放行
// 均不动，硬语义变更需用户拍板）。
// 与 countUpstreamStorm 的日志扫描同一滞留语义：metrics 优先，缺席/失败自动落回日志
// 扫描（fail-open——观测失败绝不阻断派发）。两条取数路径共享一个模块级节流缓存：
//   fetchSeaSnapshot  异步（cfg 门控走 resolveGatewayAdmin，decideDispatchForRun 用）
//   seaSnapshotSync   同步桥（countUpstreamStorm 专用，见函数注）
// ---------------------------------------------------------------------------

/** metrics 快照节流缓存 TTL：ok 结果 5min（海况是分钟桶粒度，高频拉取无增益）；
 *  不可达负结果 60s（不至于每次派发都撞超时，又能在网关恢复后较快跟进）。 */
export const SEA_SNAPSHOT_TTL_MS = 5 * 60_000;
export const SEA_SNAPSHOT_NEG_TTL_MS = 60_000;

/** 补充信号：providers[].errors.last_5m 的 429 率阈值与最小样本（仅 dispatch 层消费，
 *  作为 sea_state.storm 的更早预警）。比网关自身风暴规则（60m、率 0.3、样本 20）更严：
 *  短窗样本少、噪声大，只取「5 分钟内过半请求被限流」这种明确信号。 */
export const SEA_429_RATE_5M_THRESHOLD = 0.5;
export const SEA_429_RATE_5M_MIN_TOTAL = 10;

/** 同步桥子进程内 fetch 的 AbortSignal 时限；spawnSync 外层多留 1.5s node 启动余量。 */
const SEA_SYNC_TIMEOUT_MS = 3000;

/** 模块级快照缓存：键 = 管理面 base（异步/同步两路共享）；条目数封顶防泄漏。 */
const _seaCache = new Map();
const _seaCacheMax = 8;

function seaCacheGet(key, now, okTtlMs, negTtlMs) {
  const hit = _seaCache.get(key);
  if (!hit) return null;
  const ttl = hit.snap?.mode === 'ok' ? okTtlMs : negTtlMs;
  if (now - hit.at > ttl) return null;
  return hit.snap;
}

function seaCachePut(key, snap, now) {
  if (_seaCache.size >= _seaCacheMax && !_seaCache.has(key)) {
    _seaCache.delete(_seaCache.keys().next().value); // 淘汰最早写入的键
  }
  _seaCache.set(key, { at: now, snap });
}

/** 测试清场：清空海况快照节流缓存（vitest 单 fork 共享注册表，用例收尾必须调用）。 */
export function resetSeaSnapshotCache() {
  _seaCache.clear();
}

const _num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * 并发水位 advisory（2026-11 concurrency signal，纯增量，不参与任何硬判定）：从
 * metrics.concurrency（per-provider 实时水位 { in_flight, queued, limit }，见
 * src/gateway/server.ts hMetrics）汇总出两个信号——
 *   queued_providers     正在排队的 provider 数（queued>0）：排队出现早于 429，是比
 *                        sea_state 更早的风暴前兆（供给闸只能判「允许几路」，看不到
 *                        「正在排多少」，本字段补这个盲区）
 *   max_in_flight_ratio  全队最大 in_flight/limit 占比（0<limit 才进分母；limit=0 不限
 *                        者不入——否则分母 0 无意义）；无可比条目 → null
 * metrics 缺 concurrency 段（旧版网关）或形态异常 → null，消费方按缺失处理；provider
 * 在段内缺席 = 空闲（网关口径：无流量且无在途不露出），不计入排队、不拉低占比。
 */
export function concurrencyAdvisoryFromMetrics(j) {
  const c = j?.concurrency;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  let queuedProviders = 0;
  let maxRatio = null;
  for (const v of Object.values(c)) {
    if (!v || typeof v !== 'object') continue;
    if (Number.isFinite(v.queued) && v.queued > 0) queuedProviders += 1;
    if (Number.isFinite(v.in_flight) && Number.isFinite(v.limit) && v.limit > 0) {
      const r = v.in_flight / v.limit;
      if (maxRatio === null || r > maxRatio) maxRatio = r;
    }
  }
  return { queued_providers: queuedProviders, max_in_flight_ratio: maxRatio };
}

/**
 * 从 /_modeldock/metrics 响应提取海况快照（纯函数，字段缺失容错——旧版网关无 sea_state
 * 或 errors 分桶时各字段按「无数据」处理，不抛错）。
 * @returns {{ mode:'ok', at:number, storm:boolean, reasons:string[], meltdown:string[],
 *   meltdownCount:number, rate429_5m:number, total5m:number, count429_5m:number,
 *   countQuota_5m:number, count429_60m:number, countQuota_60m:number,
 *   concurrency:{ queued_providers:number, max_in_flight_ratio:number|null }|null }}
 */
export function seaSnapshotFromMetricsJson(j, now = Date.now()) {
  const sea = j?.sea_state ?? {};
  const meltdown = (Array.isArray(j?.meltdown) ? j.meltdown : [])
    .map((m) => (m && m.provider ? String(m.provider) : null))
    .filter(Boolean);
  const providers = j?.providers && typeof j.providers === 'object' && !Array.isArray(j.providers) ? j.providers : {};
  let c429a = 0; let qa = 0; let ta = 0; let c429b = 0; let qb = 0;
  for (const p of Object.values(providers)) {
    const w5 = p?.errors?.last_5m;
    const w60 = p?.errors?.last_60m;
    if (w5) {
      c429a += _num(w5['429']);
      qa += _num(w5.quota);
      ta += _num(w5.total);
    }
    if (w60) {
      c429b += _num(w60['429']);
      qb += _num(w60.quota);
    }
  }
  return {
    mode: 'ok',
    at: now,
    storm: sea.storm === true,
    reasons: Array.isArray(sea.reasons) ? sea.reasons.map(String) : [],
    meltdownCount: Number.isFinite(sea.meltdown_count) ? sea.meltdown_count : meltdown.length,
    meltdown,
    rate429_5m: ta > 0 ? c429a / ta : 0,
    total5m: ta,
    count429_5m: c429a,
    countQuota_5m: qa,
    count429_60m: c429b,
    countQuota_60m: qb,
    // 并发水位 advisory（纯增量）：快照消费者（dispatch 权威风暴位）对该字段零依赖——
    // 缺席（旧网关）为 null，不影响任何既有判定语义。
    concurrency: concurrencyAdvisoryFromMetrics(j),
  };
}

/**
 * 异步拉取海况快照。cfg 门控走 resolveGatewayAdmin（gatewayAdmin !== true 一律
 * unavailable 不触达）；网络失败/超时/非 200/响应损坏 → unavailable（负缓存 60s），
 * 绝不抛出——调用方（seaWeather / dispatch 预检）落回既有行为。
 */
export async function fetchSeaSnapshot(cfg, { now = Date.now(), timeoutMs = 3000, okTtlMs = SEA_SNAPSHOT_TTL_MS, negTtlMs = SEA_SNAPSHOT_NEG_TTL_MS } = {}) {
  const adm = resolveGatewayAdmin(cfg);
  if (!adm) {
    return {
      mode: 'unavailable',
      reason: cfg?.gatewayAdmin === true
        ? '未发现网关（gateway.json 缺失或 ORCH_GATEWAY_* 未配置）'
        : 'workflow.json 未开启 gatewayAdmin',
    };
  }
  const key = adm.base;
  const cached = seaCacheGet(key, now, okTtlMs, negTtlMs);
  if (cached) return cached;
  let snap;
  try {
    const res = await fetch(`${adm.base}/_modeldock/metrics`, {
      headers: { 'x-modeldock-admin': adm.adminToken },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`网关返回 ${res.status}`);
    snap = seaSnapshotFromMetricsJson(await res.json(), now);
  } catch (e) {
    snap = { mode: 'unavailable', reason: `metrics 查询失败：${String(e?.message ?? e).slice(0, 120)}` };
  }
  seaCachePut(key, snap, now);
  return snap;
}

/**
 * 同步桥的发现源（gwDir 同目录的 gateway.json 为唯一信任域）——它就是网关日志所在的
 * 同一 ModelDock 安装（<.modeldock>/logs ↔ <.modeldock>/gateway.json），测试 fixture
 * 不放该文件即零网络。有意不读 ORCH_GATEWAY_* env：无 cfg 的同步路径里 env 发现锚不住
 * 信任域。缺失/损坏/字段不完整 → null。
 */
function gwEndpointFromGwDir(gwDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(path.dirname(gwDir), 'gateway.json'), 'utf8'));
    if (Number.isInteger(j?.port) && j.port > 0 && typeof j?.admin_token === 'string' && j.admin_token) {
      return { base: `http://127.0.0.1:${j.port}`, adminToken: j.admin_token };
    }
  } catch { /* 缺失/损坏 = 未发现 → 日志扫描 */ }
  return null;
}

/**
 * 同步桥（countUpstreamStorm 专用，因调度闸调用点为同步函数）：spawnSync node -e 取数
 * （Node ≥22 内置 fetch；admin token 经子进程 env 传递，不进 argv）。失败/超时/解析失败
 * → null（调用方落回日志扫描），并把负结果写共享缓存。
 */
function seaSnapshotSync(gwDir, { now = Date.now(), timeoutMs = SEA_SYNC_TIMEOUT_MS, okTtlMs = SEA_SNAPSHOT_TTL_MS, negTtlMs = SEA_SNAPSHOT_NEG_TTL_MS } = {}) {
  const ep = gwEndpointFromGwDir(gwDir);
  if (!ep) return null;
  const cached = seaCacheGet(ep.base, now, okTtlMs, negTtlMs);
  if (cached) return cached.mode === 'ok' ? cached : null;
  let snap = null;
  try {
    const script = `fetch(${JSON.stringify(`${ep.base}/_modeldock/metrics`)},{headers:{'x-modeldock-admin':process.env.ORCH_SEA_ADMIN_TOKEN||''},signal:AbortSignal.timeout(${timeoutMs})})`
      + `.then(r=>{if(!r.ok)throw new Error('status '+r.status);return r.json()})`
      + `.then(j=>process.stdout.write(JSON.stringify(j))).catch(()=>process.exit(1))`;
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: timeoutMs + 1500,
      windowsHide: true,
      env: { ...process.env, ORCH_SEA_ADMIN_TOKEN: ep.adminToken },
    });
    if (r.status === 0 && r.stdout) snap = seaSnapshotFromMetricsJson(JSON.parse(r.stdout), now);
  } catch { /* 任何失败 → null → 日志扫描 */ }
  seaCachePut(ep.base, snap ?? { mode: 'unavailable', reason: '海况同步桥不可得' }, now);
  return snap;
}

/**
 * /usage 风暴计数同步桥（A3，countUpstreamStorm 专用）：metrics 不可得时的中间层——
 * GET /_modeldock/usage?from=&to=&cost=0 取 by_status 的 429+402 合计。by_status 键口径
 * 已核对 src/gateway/state/logs.ts createUsageAccumulator：只收失败条目、键 = 状态码原文
 * （status 缺失计 'n/a'）——'429'/'402' 可精确区分，端点足以服务风暴闸。信任域与缓存
 * 策略同 seaSnapshotSync（gwDir 同目录 gateway.json；ok 5min / 负 60s；键加 |usage 命名
 * 空间与 metrics 快照隔离）。失败/超时/解析失败 → null（调用方落回日志文件扫描，fail-open）。
 */
function usageStormSync(gwDir, { now = Date.now(), windowMs = 0, timeoutMs = SEA_SYNC_TIMEOUT_MS, okTtlMs = SEA_SNAPSHOT_TTL_MS, negTtlMs = SEA_SNAPSHOT_NEG_TTL_MS } = {}) {
  const ep = gwEndpointFromGwDir(gwDir);
  if (!ep) return null;
  const key = `${ep.base}|usage`;
  const cached = seaCacheGet(key, now, okTtlMs, negTtlMs);
  if (cached) return cached.mode === 'ok' ? cached.storm : null;
  let count = null;
  try {
    const url = `${ep.base}/_modeldock/usage?from=${encodeURIComponent(new Date(now - Math.max(0, windowMs)).toISOString())}&to=${encodeURIComponent(new Date(now).toISOString())}&cost=0`;
    const script = `fetch(${JSON.stringify(url)},{headers:{'x-modeldock-admin':process.env.ORCH_SEA_ADMIN_TOKEN||''},signal:AbortSignal.timeout(${timeoutMs})})`
      + `.then(r=>{if(!r.ok)throw new Error('status '+r.status);return r.json()})`
      + `.then(j=>{const b=(j&&j.usage&&j.usage.by_status)||{};process.stdout.write(JSON.stringify((b['429']||0)+(b['402']||0)))}).catch(()=>process.exit(1))`;
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: timeoutMs + 1500,
      windowsHide: true,
      env: { ...process.env, ORCH_SEA_ADMIN_TOKEN: ep.adminToken },
    });
    if (r.status === 0 && r.stdout) {
      const n = Number(String(r.stdout).trim());
      if (Number.isFinite(n) && n >= 0) count = n;
    }
  } catch { /* 任何失败 → null → 日志扫描 */ }
  seaCachePut(key, count === null ? { mode: 'unavailable', reason: 'usage 风暴同步桥不可得' } : { mode: 'ok', storm: count }, now);
  return count;
}

/**
 * 上游海况计数：优先 metrics 数据面（60 分钟窗口 429+quota 真实请求数——与日志扫描的
 * status 429/402 计数同语义，阈值可共用；sea_state.storm 的 60m 429 规则最低 6 次 429，
 * 阈值 ≤5 即可保证「网关判风暴 → 计数闸必触发」）；metrics 不可得 → /_modeldock/usage
 * 聚合端点（A3：by_status['429']+['402']，按 windowMs 定 from/to）；端点也不可得（无
 * gateway.json / 网关挂了 / 超时）→ 落回网关日志窗口扫描（windowMs 生效，行为与历史
 * 版本一致，fail-open）。gwDir=null（未启用网关日志）恒 0。日文件按本地日期切分，
 * 读取范围按窗口跨午夜补足。
 */
export function countUpstreamStorm(gwDir, { windowMs, now = Date.now() } = {}) {
  if (!gwDir) return 0;
  const snap = seaSnapshotSync(gwDir, { now });
  if (snap?.mode === 'ok') return snap.count429_60m + snap.countQuota_60m;
  const usageCount = usageStormSync(gwDir, { now, windowMs });
  if (usageCount !== null) return usageCount;
  const dayMs = 86_400_000;
  const dayCount = Math.ceil(windowMs / dayMs) + 1; // 跨本地午夜余量
  let count = 0;
  for (let i = 0; i < dayCount; i++) {
    const date = toIsoLocal(new Date(now - i * dayMs)).slice(0, 10);
    for (const entry of readGatewayLog(gwDir, date)) {
      if (entry.status !== 429 && entry.status !== 402) continue;
      const ts = Date.parse(entry.ts ?? '');
      if (!Number.isFinite(ts)) continue;
      const age = now - ts;
      if (age >= 0 && age <= windowMs) count += 1;
    }
  }
  return count;
}

/** fleet 级事件日志路径（跨任务调度层留痕，独立于任务 events.jsonl）。 */
export function fleetLogPath(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'logs', 'fleet.jsonl');
}

/** 读 fleet 事件（容错同 readEvents：半行跳过不抛错）。 */
export function readFleetEvents(repoRoot) {
  const f = fleetLogPath(repoRoot);
  if (!fs.existsSync(f)) return [];
  const events = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch { /* 崩溃残留半行，忽略 */ }
  }
  return events;
}

/**
 * 追加一条 fleet 级事件（与 appendEvent 同格式、独立文件）。fleet 事件极低频
 * （风暴滞留级别），不做进程内 seq 缓存——每次从盘上对齐，跨进程双写也安全。
 */
export function appendFleetEvent(repoRoot, type, fields = {}) {
  const f = fleetLogPath(repoRoot);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let seq = 0;
  try {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        seq = JSON.parse(lines[i]).seq ?? 0;
        break;
      } catch { /* 尾行损坏：继续向前找 */ }
    }
  } catch { /* 文件不存在：首条 */ }
  const event = { ts: toIsoLocal(), seq: seq + 1, type, ...fields };
  fs.appendFileSync(f, JSON.stringify(event) + '\n');
  return event;
}

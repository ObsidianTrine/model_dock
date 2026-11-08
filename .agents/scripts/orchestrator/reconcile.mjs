// reconcile.mjs — 狗粮对账（Phase 2 展望项落地，docs 10.7）。
// worker 的 token 用量有两本账：
//   自报账：任务 events.jsonl 的 budget_snapshot（stream-json result 回填；第三方上游
//           流式 usage 全 0 时运行中数值不可信，见 docs 5.10）；
//   实测账：网关请求日志（gateway-YYYY-MM-DD.jsonl）的 usage 字段——网关转发层从上游
//           响应旁路解析（src/gateway/usage.ts），网关只看得到经它转发的流量。
// 对账 = 把任务事件时间窗（worker_spawned 首条 → merged/failed 尾条）投影到网关日志，
// 汇总实测用量与自报用量对比。worker 走网关（吃狗粮）时两本账应该贴近；直连上游时实测账为 0。
// 口径（2026-11 usage-cache-read-scope）：分歧率优先「可计费口径」（剔除缓存读，与 max_tokens
// 熔断同口径）；任一侧缺新字段（旧 events / 旧网关日志）整体回落旧口径（缓存读计入）并标注。
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
import { resolveGatewayAdmin } from './tiers.mjs';
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

// ---------------------------------------------------------------------------
// /_modeldock/usage 聚合取数助手（A3，2026-11）：编排侧对网关请求日志的取数从「直读
// jsonl」升级为「admin 可得时优先走聚合端点，文件直读降级为 fallback」——复用 tiers.mjs
// resolveGatewayAdmin 的同一信任域与开启哲学（cfg.gatewayAdmin !== true 一律不触达，
// 与既有 admin 调用同款 ≤3s 超时）。fail-open：端点不可得/非 200/解析失败 → ok:false，
// 调用方落回文件扫描（行为与历史一致）。summary 形状见 src/gateway/state/logs.ts 的
// UsageSummary：requests/ok/failed/by_status（键 = String(status)，仅失败条目，缺失计
// 'n/a'）/by_provider|by_model（请求数，非 token）/latency/tokens{input,output,cache_read,
// cache_creation}/billable_tokens（可计费口径求和：成功且有 usage 条目）/billable_partial
// （窗口混入旧版网关日志 → true，求和只是可得部分）/cost/unpriced_models——注意
// tokens.input 已含缓存读+缓存建（与实测账 tokensIn 同口径），by_provider/by_model 只是
// 请求数，token 分桶端点给不了。
// ---------------------------------------------------------------------------

const USAGE_TIMEOUT_MS = 3000;

/**
 * 查询网关请求日志聚合（GET /_modeldock/usage?from=&to=&harness=&provider=&cost=）。
 * @param {object} cfg loadWorkflowConfig 结果（gatewayAdmin 门控）
 * @param {object} [p] fromMs/toMs 毫秒时间窗（缺省不设限）、harness/provider 精确过滤、
 *        withCost=true 时带网关侧成本聚合（cost=1，价目与 pricing-lookup 同源）、timeoutMs
 * @returns {Promise<{ ok: true, summary: object } | { ok: false, reason: string }>}
 */
export async function fetchGatewayUsageSummary(cfg, { fromMs, toMs, harness = '', provider = '', withCost = false, timeoutMs = USAGE_TIMEOUT_MS } = {}) {
  const adm = resolveGatewayAdmin(cfg);
  if (!adm) {
    return {
      ok: false,
      reason: cfg?.gatewayAdmin === true
        ? '未发现网关（gateway.json 缺失或 ORCH_GATEWAY_* 未配置）'
        : 'workflow.json 未开启 gatewayAdmin',
    };
  }
  const q = new URLSearchParams();
  if (Number.isFinite(fromMs)) q.set('from', new Date(fromMs).toISOString());
  if (Number.isFinite(toMs)) q.set('to', new Date(toMs).toISOString());
  if (harness) q.set('harness', String(harness));
  if (provider) q.set('provider', String(provider));
  q.set('cost', withCost ? '1' : '0');
  try {
    const res = await fetch(`${adm.base}/_modeldock/usage?${q}`, {
      headers: { 'x-modeldock-admin': adm.adminToken },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `网关返回 ${res.status}` };
    const j = await res.json();
    if (!j?.ok || !j.usage || typeof j.usage !== 'object') return { ok: false, reason: 'usage 响应形状不符（旧版网关？）' };
    return { ok: true, summary: j.usage };
  } catch (e) {
    return { ok: false, reason: `usage 查询失败：${String(e?.message ?? e).slice(0, 120)}` };
  }
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
 * 单任务对账：事件时间窗内的网关转发请求汇总（异步，A3——实测账优先走 /_modeldock/usage）。
 * 多天任务自动跨日期文件；MODELRDOCK_FAKE_HOME/HOME 重定向生效（测试隔离）。
 */
export async function reconcileTask(repoRoot, taskId, queueRootDir) {
  const logsRoot = path.join(repoRoot, '.agents', 'orchestrator', 'logs', taskId);
  const events = readEvents(logsRoot);
  const spawned = events.filter((e) => e.type === 'worker_spawned');
  if (!spawned.length) return { skipped: true, reason: '无 worker 运行记录' };
  const start = parseTs(spawned[0].ts);
  const endEvts = events.filter((e) => ['merged', 'failed', 'blocked'].includes(e.type));
  const end = endEvts.length ? parseTs(endEvts[endEvts.length - 1].ts) : Date.now();

  const snapshots = events.filter((e) => e.type === 'budget_snapshot');
  const billableSnaps = snapshots.map((e) => e.tokens_billable).filter(Number.isFinite);
  const selfReported = {
    tokensIn: Math.max(0, ...snapshots.map((e) => e.tokens_in ?? 0)),
    tokensOut: Math.max(0, ...snapshots.map((e) => e.tokens_out ?? 0)),
    // 可计费口径（剔除缓存读）：全部快照都带 tokens_billable 才可用（部分新部分旧 =
    // 混口径，宁可保守回落 legacy），否则 null
    billable: snapshots.length > 0 && billableSnaps.length === snapshots.length ? Math.max(0, ...billableSnaps) : null,
  };

  // 锚定 repoRoot 的配置（临时仓库/测试才有正确归属；env 重定向仍优先——测试隔离通道）
  const cfg = loadWorkflowConfig(repoRoot);
  const gwDir = gatewayLogsDir(cfg);
  if (!gwDir) return { skipped: true, reason: '未启用网关对账（workflow.json gatewayLogDir 未配置）' };

  // A3 闭环（2026-11-08 billable 聚合）：实测账优先走 /_modeldock/usage 聚合端点。
  // 端点已补 billable_tokens（条目级可计费口径求和——公式分协议形态，网关落盘前已算好，
  // 聚合只求和不重算）与 billable_partial（窗口混入旧版网关日志 → true）。两种口径的
  // HTTP 准入：
  //   legacy（自报账无可计费字段）：summary 的 tokens/requests 聚合即全部所需（现状不变）；
  //   billable（自报账带可计费字段）：还需响应带 billable_tokens 且 partial!==true——
  //     partial / 缺字段（旧版网关）/ 端点不可得 / 查询失败 → 整批落回文件扫描（下方
  //     原路径，行为与历史逐字节一致；与 measureFuelBatch 的整批 fail-open 粒度一致）。
  // (provider,model) token 分桶端点仍给不了 → 两条 HTTP 路径的 pairs 均留空、燃油账由
  // 同一响应里的网关 cost 聚合预填（价目与 pricing-lookup 同源；attachCost 见空 pairs
  // 跳过、不覆盖预填值）——一次窗口查询同时服务对账与成本，不重复打两次。transient /
  // 海况调查包仍文件直读：明细端点给不了逐条目（见 upstreamSeaState 注）。
  const u = await fetchGatewayUsageSummary(cfg, { fromMs: start - 60_000, toMs: end + 60_000, withCost: true });
  if (u.ok && selfReported.billable === null) {
    const t = u.summary.tokens && typeof u.summary.tokens === 'object' ? u.summary.tokens : {};
    const tokensIn = t.input ?? 0; // 端点 tokens.input = input+cache_read+cache_creation（实测账 tokensIn 同口径）
    const tokensOut = t.output ?? 0;
    const gwTotal = tokensIn + tokensOut;
    return {
      skipped: false,
      taskId,
      window: { start: new Date(start).toISOString(), end: new Date(Math.min(end, Date.now())).toISOString() },
      selfReported,
      selfTotal: selfReported.tokensIn + selfReported.tokensOut,
      selfBillable: null,
      gateway: {
        // 端点 ok = status<400 条数（文件路径口径是「成功且带 usage」——成功请求几乎必有
        // usage，可接受偏差）；billable 恒 0（scope 固定 legacy：自报账无可计费字段）
        requests: u.summary.ok ?? 0,
        tokensIn,
        tokensOut,
        cacheRead: t.cache_read ?? 0,
        cacheCreate: t.cache_creation ?? 0,
        billable: 0,
        total: gwTotal,
      },
      gatewayBillable: null,
      scope: 'legacy',
      divergence:
        selfReported.tokensIn + selfReported.tokensOut + gwTotal > 0
          ? Math.abs(selfReported.tokensIn + selfReported.tokensOut - gwTotal) / Math.max(selfReported.tokensIn + selfReported.tokensOut, gwTotal)
          : 0,
      // 聚合端点给不了 (provider,model) token 分桶——燃油账由网关侧 cost 聚合预填
      // （价目与 pricing-lookup 同源），attachCost 见空 pairs 跳过、不覆盖预填值
      pairs: [],
      viaGateway: gwTotal > 0,
      source: 'gateway-usage',
      ...(u.summary.cost && typeof u.summary.cost === 'object'
        ? {
            cost: {
              usd: u.summary.cost.total ?? 0,
              unpriced: Array.isArray(u.summary.unpriced_models) ? u.summary.unpriced_models : [],
              requests: u.summary.ok ?? 0,
              source: 'gateway-usage',
            },
          }
        : {}),
    };
  }
  if (u.ok && selfReported.billable !== null && Number.isFinite(u.summary.billable_tokens) && u.summary.billable_partial !== true) {
    // billable HTTP 路径：分歧率按可计费口径对可计费口径（与文件路径 billableMode 同式）。
    // requests 用端点 ok 计数（同 legacy 路径的可接受偏差）；partial 已在上游条件排除——
    // 这里的求和与文件逐条累加同值（条目级 billable 落盘前已算好，聚合只是求和）。
    const t = u.summary.tokens && typeof u.summary.tokens === 'object' ? u.summary.tokens : {};
    const tokensIn = t.input ?? 0;
    const tokensOut = t.output ?? 0;
    const gwTotal = tokensIn + tokensOut;
    const gwBillable = u.summary.billable_tokens;
    const denom = Math.max(selfReported.billable, gwBillable);
    return {
      skipped: false,
      taskId,
      window: { start: new Date(start).toISOString(), end: new Date(Math.min(end, Date.now())).toISOString() },
      selfReported,
      selfTotal: selfReported.tokensIn + selfReported.tokensOut,
      selfBillable: selfReported.billable,
      gateway: {
        requests: u.summary.ok ?? 0,
        tokensIn,
        tokensOut,
        cacheRead: t.cache_read ?? 0,
        cacheCreate: t.cache_creation ?? 0,
        billable: gwBillable,
        total: gwTotal,
      },
      gatewayBillable: gwBillable,
      scope: 'billable',
      // 分母取两账较大者（文件路径同式）；两边都为 0 记 0（完美一致，避免 0/0 = NaN）
      divergence: denom > 0 ? Math.abs(selfReported.billable - gwBillable) / denom : 0,
      // 端点给不了 (provider,model) token 分桶——燃油账由同一响应里的网关 cost 聚合预填
      // （价目与 pricing-lookup 同源），attachCost 见空 pairs 跳过、不覆盖预填值
      pairs: [],
      viaGateway: gwTotal > 0,
      source: 'gateway-usage',
      ...(u.summary.cost && typeof u.summary.cost === 'object'
        ? {
            cost: {
              usd: u.summary.cost.total ?? 0,
              unpriced: Array.isArray(u.summary.unpriced_models) ? u.summary.unpriced_models : [],
              requests: u.summary.ok ?? 0,
              source: 'gateway-usage',
            },
          }
        : {}),
    };
  }
  // 其余（端点不可得 / partial / 缺 billable 字段）→ 整批落回文件扫描，行为与历史一致

  const observed = { requests: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0, billable: 0 };
  let billableEntries = 0; // 带 usage.billable_tokens 的条数（旧网关日志无此字段 → 回落旧口径）
  // (provider, model) token 分桶：成本投影（cost.mjs computeCost）的原料——同一循环顺手聚合，
  // 不再二次扫日志。键 = "provider/model"（无 provider 裸模型名）。
  const pairsMap = new Map();
  // 按日历日扫 [date(start) .. date(end)]：旧写法跨午夜窗口读不到 end 日文件（CORRECT-12 同款，见 cost.mjs readWindowEntries 注记）
  const endKey = new Date(end - new Date(end).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  for (let day = new Date(start); ; ) {
    const date = new Date(day.getTime() - day.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    if (date > endKey) break;
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
      if (Number.isFinite(u.billable_tokens)) {
        observed.billable += u.billable_tokens;
        billableEntries += 1;
      }
      const pk = entry.provider ? `${entry.provider}/${entry.model}` : String(entry.model ?? '');
      const p = pairsMap.get(pk) ?? { provider: entry.provider ?? null, model: entry.model ?? null, requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      p.requests += 1;
      p.input += u.input_tokens ?? 0;
      p.output += u.output_tokens ?? 0;
      p.cacheRead += u.cache_read_tokens ?? 0;
      p.cacheCreate += u.cache_creation_tokens ?? 0;
      pairsMap.set(pk, p);
    }
    day.setDate(day.getDate() + 1);
  }

  const selfTotal = selfReported.tokensIn + selfReported.tokensOut;
  const gwTotal = observed.tokensIn + observed.tokensOut;
  // 口径选择（2026-11 usage-cache-read-scope）：两本账都有可计费字段才走 billable 对
  // billable（与 max_tokens 熔断同口径——GLM 网关缓存读占大头，总口径分歧被摊薄失真）；
  // 任一侧缺新字段（旧 events / 旧网关日志）整体回落旧口径并标 scope='legacy'——绝不混
  // 口径相减，混了分歧率无意义。
  const billableMode = selfReported.billable !== null && observed.requests > 0 && billableEntries === observed.requests;
  const divergence = billableMode
    ? Math.abs(selfReported.billable - observed.billable) / Math.max(selfReported.billable, observed.billable)
    : selfTotal + gwTotal > 0
      ? Math.abs(selfTotal - gwTotal) / Math.max(selfTotal, gwTotal)
      : 0; // 偏差率分母取两账中较大者（衡量相对分歧，避免零分母）
  return {
    skipped: false,
    taskId,
    window: { start: new Date(start).toISOString(), end: new Date(Math.min(end, Date.now())).toISOString() },
    selfReported,
    selfTotal,
    /** 可计费口径自报值；scope='legacy'（缺新字段回落）时为 null */
    selfBillable: billableMode ? selfReported.billable : null,
    gateway: { ...observed, total: gwTotal },
    /** 可计费口径网关实测值；scope='legacy' 时为 null */
    gatewayBillable: billableMode ? observed.billable : null,
    /** 对账口径：'billable'（两本账都有可计费字段）| 'legacy'（旧事件/旧网关日志回落，缓存读计入） */
    scope: billableMode ? 'billable' : 'legacy',
    divergence,
    /** (provider, model) token 分桶（成本投影原料；无成本核算时仅占位不烧价目请求） */
    pairs: [...pairsMap.values()],
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
 * A3 注：保持网关日志文件直读——调查包要逐条明细（routeEvents 路由痕迹、lastFailure
 * 失败现场），/_modeldock/usage 聚合端点给不了；未来 /_modeldock/logs 明细端点落地后再切
 * （与 transient.classifyWorkerCrash 同一取舍）。
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
  // 按日历日扫 [date(start) .. date(end)]：旧写法跨午夜窗口读不到 end 日文件（CORRECT-12 同款，见 cost.mjs readWindowEntries 注记）
  const endKey = new Date(end - new Date(end).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  for (let day = new Date(start); ; ) {
    const date = new Date(day.getTime() - day.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    if (date > endKey) break;
    for (const entry of readGatewayLog(gwDir, date)) {
      const ts = parseTs(entry.ts);
      if (ts >= start - 60_000 && ts <= end + 60_000) entries.push(entry);
    }
    day.setDate(day.getDate() + 1);
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
  // 用量口径：总口径（缓存读+缓存建计入输入），只计成功转发；reconcileTask 的分歧率
  // 已优先可计费口径（billable），海况调查包保持总口径不变（与燃油账同源）
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

/** 全部 merged 任务的对账汇总（按 divergence 降序，最可疑的在前）。异步（A3 同 reconcileTask）。 */
export async function reconcileAll(repoRoot, queueRootDir) {
  const out = [];
  for (const id of listCards(queueRootDir, 'merged')) {
    const r = await reconcileTask(repoRoot, id, queueRootDir);
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

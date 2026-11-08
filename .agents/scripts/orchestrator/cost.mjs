// cost.mjs — 燃油成本账（编排侧）：把网关实测 token（usage 日志）按模型单价折成 USD。
//   价目来源：POST <gateway>/_modeldock/pricing-lookup（admin 面，workflow.json gatewayAdmin
//   显式开启才启用——可移植工具链不默认读 ModelDock 状态，与 tier-validate 同一开启哲学）；
//   网关不可达时回落 logs/pricing-cache.json 陈价（成本是观测面，宁旧勿缺）。
//   查不到价的模型按 $0 计并列 unpriced 清单（提醒补 ~/.modeldock/pricing.json），绝不猜价。
// 计费口径与 src/gateway/pricing.ts costOfUsage 逐字段一致（两边测试各持同一组期望值对拍）：
//   cost = (input×in价 + output×out价 + cache_read×cr价 + cache_creation×cw价) / 1e6，
//   cr/cw 价缺省回落输入价（宁可高估不低估）。实测账只认「走网关」的流量——worker 直连
//   上游时网关零流量，成本不可测（如实标注，与 reconcile 的狗粮对账同一警告口径）。

import fs from 'node:fs';
import path from 'node:path';
import { fetchGatewayUsageSummary, gatewayLogsDir, readGatewayLog } from './reconcile.mjs';
import { logDir, readEvents } from './events.mjs';
import { resolveGatewayAdmin } from './tiers.mjs';

/** 单价 × 单请求 token 分桶 → USD。price 单位 USD/百万 token；usage 为网关日志四桶原始计数。 */
export function costOfUsage(u, price) {
  const cacheRead = price.cache_read ?? price.input;
  const cacheWrite = price.cache_write ?? price.input;
  return (
    ((u.input_tokens ?? 0) * price.input +
      (u.output_tokens ?? 0) * price.output +
      (u.cache_read_tokens ?? 0) * cacheRead +
      (u.cache_creation_tokens ?? 0) * cacheWrite) /
    1e6
  );
}

/** 价目表键：带 provider 用 "provider/model"（跨服务商同名模型各记各价），否则裸模型名。 */
export function pairKey(provider, model) {
  return provider ? `${provider}/${model}` : String(model ?? '');
}

/**
 * 网关日志条目 → (provider, model) 对的 token 分桶聚合（成功且有 usage 的条目）。
 * 返回 [{ provider, model, requests, input, output, cacheRead, cacheCreate }]。
 */
export function collectPairs(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.status === undefined || e.status >= 400) continue;
    const u = e.usage;
    if (!u) continue;
    const k = pairKey(e.provider, e.model);
    const p = map.get(k) ?? { provider: e.provider ?? null, model: e.model ?? null, requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    p.requests += 1;
    p.input += u.input_tokens ?? 0;
    p.output += u.output_tokens ?? 0;
    p.cacheRead += u.cache_read_tokens ?? 0;
    p.cacheCreate += u.cache_creation_tokens ?? 0;
    map.set(k, p);
  }
  return [...map.values()];
}

/** 价目缓存（网关取到的最近一份价目；网关不可达时的回落数据源）。 */
export function pricingCachePath(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'logs', 'pricing-cache.json');
}

function readPricingCache(repoRoot) {
  try {
    const j = JSON.parse(fs.readFileSync(pricingCachePath(repoRoot), 'utf8'));
    if (j && typeof j === 'object' && j.prices && typeof j.prices === 'object') {
      return { fetchedAt: typeof j.fetchedAt === 'string' ? j.fetchedAt : null, prices: j.prices };
    }
  } catch {
    /* 缺失/损坏 = 无缓存 */
  }
  return null;
}

function writePricingCache(repoRoot, fetchedAt, prices) {
  try {
    fs.mkdirSync(path.dirname(pricingCachePath(repoRoot)), { recursive: true });
    fs.writeFileSync(pricingCachePath(repoRoot), JSON.stringify({ fetchedAt, prices }, null, 2));
  } catch {
    /* 缓存写失败不阻断（下次再取） */
  }
}

/**
 * 价目表获取：pairs（collectPairs 产物，取并集去重）→ Map<pairKey, price>。
 *   opts.table        注入现成表（调用方已取过 / 测试）——直接用，不发请求不读缓存；
 *   opts.timeoutMs    请求超时（缺省 4s）；
 * 解析序：ORCH_GATEWAY_BASE / ORCH_GATEWAY_ADMIN_TOKEN env > gateway.json 同机发现（仅
 * gatewayAdmin 开启后触达）；optIn=false 一律 unavailable 不发请求。
 * 返回 { mode: 'fetched'|'cache'|'injected'|'empty'|'unavailable', table: Map, fetchedAt?, reason? }。
 */
export async function getPricingTable(repoRoot, cfg, pairs, opts = {}) {
  if (opts.table) return { mode: 'injected', table: opts.table };
  const wanted = [];
  const seen = new Set();
  for (const p of pairs) {
    if (!p?.model) continue;
    const k = pairKey(p.provider, p.model);
    if (seen.has(k)) continue;
    seen.add(k);
    wanted.push(p.provider ? { provider: p.provider, model: p.model } : p.model);
  }
  if (!wanted.length) return { mode: 'empty', table: new Map() };
  if (cfg?.gatewayAdmin !== true) {
    return { mode: 'unavailable', reason: 'workflow.json 未开启 gatewayAdmin（价目走网关 admin 面），成本核算不可用', table: new Map() };
  }
  const adm = resolveGatewayAdmin(cfg);
  if (!adm) {
    const cached = readPricingCache(repoRoot);
    if (cached) return { mode: 'cache', table: new Map(Object.entries(cached.prices)), fetchedAt: cached.fetchedAt };
    return { mode: 'unavailable', reason: '未发现网关（gateway.json 缺失或 ORCH_GATEWAY_* 未配置），且无本地价目缓存', table: new Map() };
  }
  try {
    const res = await fetch(`${adm.base}/_modeldock/pricing-lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-modeldock-admin': adm.adminToken },
      body: JSON.stringify({ models: wanted }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
    });
    if (res.ok) {
      const j = await res.json();
      if (j?.ok && j.prices && typeof j.prices === 'object') {
        writePricingCache(repoRoot, new Date().toISOString(), j.prices);
        return { mode: 'fetched', table: new Map(Object.entries(j.prices)) };
      }
    }
  } catch {
    /* 落到缓存回落 */
  }
  const cached = readPricingCache(repoRoot);
  if (cached) return { mode: 'cache', table: new Map(Object.entries(cached.prices)), fetchedAt: cached.fetchedAt };
  return { mode: 'unavailable', reason: '网关价目查询失败且无本地价目缓存', table: new Map() };
}

/** 一组 (provider, model) 分桶 × 价目表 → { usd, requests, unpriced }。unpriced 为查不到价的键。 */
export function computeCost(pairs, table) {
  let usd = 0;
  let requests = 0;
  const unpriced = [];
  for (const p of pairs) {
    const price = table.get(pairKey(p.provider, p.model));
    if (!price) {
      unpriced.push(pairKey(p.provider, p.model));
      continue;
    }
    usd += costOfUsage(
      { input_tokens: p.input, output_tokens: p.output, cache_read_tokens: p.cacheRead, cache_creation_tokens: p.cacheCreate },
      price
    );
    requests += p.requests;
  }
  return { usd, requests, unpriced };
}

/** 单卡事件时间窗（worker_spawned 首条 → 终态尾条；未终态用当前时刻）。无运行记录返回 null。 */
export function cardWindowFromEvents(repoRoot, taskId) {
  let events;
  try {
    events = readEvents(logDir(repoRoot, taskId));
  } catch {
    return null;
  }
  const spawned = events.filter((e) => e.type === 'worker_spawned');
  if (!spawned.length) return null;
  const start = Date.parse(spawned[0].ts);
  const endEvts = events.filter((e) => ['merged', 'failed', 'blocked'].includes(e.type));
  const end = endEvts.length ? Date.parse(endEvts[endEvts.length - 1].ts) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

function readWindowEntries(gwDir, start, end) {
  const entries = [];
  // 按日历日扫 [date(start) .. date(end)]：旧写法以 start 的时刻整日推进、条件 `day <= end`，
  // 跨午夜窗口（end 时刻早于 start 时刻，如 23:56→00:08）永远推进不到 end 日——结束日文件
  // 整日漏读，用量漏记甚至整窗「零请求」（CORRECT-12，2026-11-04 夜航定位）。
  const endKey = new Date(end - new Date(end).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  for (let day = new Date(start); ; ) {
    const date = new Date(day.getTime() - day.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    if (date > endKey) break;
    for (const entry of readGatewayLog(gwDir, date)) {
      const ts = Date.parse(String(entry.ts));
      if (ts >= start - 60_000 && ts <= end + 60_000) entries.push(entry); // 1 分钟容差（reconcile 同款）
    }
    day.setDate(day.getDate() + 1);
  }
  return entries;
}

/**
 * 多窗口燃油实测（stats --cost / sail 总账+逐卡拆账共用）：A3 优先走 /_modeldock/usage
 * 聚合端点（admin 可得且未显式注入价目表时——cost=1，网关侧价目与 pricing-lookup 同源，
 * cost.total 直接可用；逐窗口并发查询，任一窗口端点失败即整批落回文件扫描保口径一致）；
 * 端点不可得 → 文件扫描 + 价目请求两条既有路径（一次日志扫描 + 一次价目请求服务全部窗口）。
 * windows: [{ key, start, end }]；results.get(key) = { measured, viaGateway,
 * requests, usd, unpriced, reason? }。价目不可得 → 所有窗口 measured:false 附同一 reason。
 */
export async function measureFuelBatch(repoRoot, cfg, windows = [], opts = {}) {
  if (!windows.length) return { source: 'empty', results: new Map() };
  const gwDir = gatewayLogsDir(cfg);
  if (!gwDir) {
    const reason = '未启用网关日志（workflow.json gatewayLogDir 未配置）';
    return { source: 'unavailable', results: new Map(windows.map((w) => [w.key, { measured: false, reason }])) };
  }
  // A3：/usage 聚合优先（显式 opts.table = 价目调用方说了算，测试/复用语义——跳过走原路径）
  if (!opts.table && resolveGatewayAdmin(cfg)) {
    const settled = await Promise.all(
      windows.map(async (w) => {
        const u = await fetchGatewayUsageSummary(cfg, { fromMs: w.start - 60_000, toMs: w.end + 60_000, withCost: true });
        if (!u.ok) return { w, failed: true };
        const ok = u.summary.ok ?? 0;
        if (!ok) return { w, zero: true };
        return {
          w,
          result: {
            measured: true,
            viaGateway: true,
            requests: ok,
            usd: u.summary.cost?.total ?? 0,
            unpriced: Array.isArray(u.summary.unpriced_models) ? u.summary.unpriced_models : [],
          },
        };
      })
    );
    if (settled.every((s) => s.result || s.zero)) {
      const results = new Map();
      for (const s of settled) {
        results.set(
          s.w.key,
          s.result ?? { measured: false, viaGateway: false, requests: 0, reason: '时间窗内网关零请求（worker 直连上游或无流量），成本不可测' }
        );
      }
      return { source: 'gateway-usage', results };
    }
    // 任一窗口端点失败（含窗口超 31 天封顶 400）→ 整批落回文件扫描，结果口径保持一致
  }
  const lo = Math.min(...windows.map((w) => w.start));
  const hi = Math.max(...windows.map((w) => w.end));
  const entries = readWindowEntries(gwDir, lo, hi);
  const results = new Map();
  const allPairs = [];
  const pairsByWindow = new Map();
  for (const w of windows) {
    const wEntries = entries.filter((e) => {
      const ts = Date.parse(String(e.ts));
      return ts >= w.start - 60_000 && ts <= w.end + 60_000;
    });
    if (!wEntries.length) {
      results.set(w.key, { measured: false, viaGateway: false, requests: 0, reason: '时间窗内网关零请求（worker 直连上游或无流量），成本不可测' });
      continue;
    }
    const pairs = collectPairs(wEntries);
    pairsByWindow.set(w.key, pairs);
    allPairs.push(...pairs);
  }
  const pt = await getPricingTable(repoRoot, cfg, allPairs, opts);
  if (pt.mode === 'unavailable') {
    for (const w of windows) {
      if (!results.has(w.key)) results.set(w.key, { measured: false, viaGateway: true, requests: (pairsByWindow.get(w.key) ?? []).reduce((n, p) => n + p.requests, 0), reason: pt.reason });
    }
    return { source: pt.mode, reason: pt.reason, results };
  }
  for (const w of windows) {
    if (results.has(w.key)) continue;
    const pairs = pairsByWindow.get(w.key) ?? [];
    const c = computeCost(pairs, pt.table);
    results.set(w.key, {
      measured: true,
      viaGateway: true,
      requests: c.requests,
      usd: c.usd,
      unpriced: c.unpriced,
    });
  }
  return { source: pt.mode, fetchedAt: pt.fetchedAt, results };
}

/**
 * 航行燃油实测：[start, end] 总账 + opts.cardIds 逐卡拆账（每卡用自身事件时间窗再投影）。
 * 返回 { measured, viaGateway, requests, usd, unpriced, byCard, source, fetchedAt?, reason? }。
 */
export async function measureFuel(repoRoot, cfg, opts = {}) {
  const start = opts.start;
  const end = opts.end ?? Date.now();
  if (!Number.isFinite(start)) return { measured: false, reason: '缺少起航时刻（start）' };
  const windows = [{ key: '_', start, end }];
  for (const id of opts.cardIds ?? []) {
    const w = cardWindowFromEvents(repoRoot, id);
    if (w) windows.push({ key: `card:${id}`, start: w.start, end: w.end });
  }
  const batch = await measureFuelBatch(repoRoot, cfg, windows, opts);
  const total = batch.results.get('_');
  if (!total || total.measured === false) {
    return { measured: false, viaGateway: total?.viaGateway ?? false, requests: total?.requests ?? 0, reason: total?.reason ?? batch.reason };
  }
  const byCard = [];
  for (const id of opts.cardIds ?? []) {
    const r = batch.results.get(`card:${id}`);
    if (r?.measured) byCard.push({ id, usd: r.usd });
  }
  return {
    measured: true,
    viaGateway: total.viaGateway,
    requests: total.requests,
    usd: total.usd,
    unpriced: total.unpriced,
    byCard,
    source: batch.source,
    fetchedAt: batch.fetchedAt,
  };
}

/** USD 展示（小金额保留 4 位，其余 2 位）。 */
export function fmtUsd(n) {
  return `$${n >= 0.01 || n === 0 ? n.toFixed(2) : n.toFixed(4)}`;
}

/**
 * 给 reconcile 结果（数组）附加成本账：并集 (provider, model) 对查一次价目表，逐任务
 * computeCost。价目不可得时 r.cost 保持缺席、r.costReason 说明原因（不打断对账主体）。
 * opts 透传 getPricingTable（opts.table 注入现成表供测试/复用）。
 */
export async function attachCost(repoRoot, cfg, results, opts = {}) {
  const tasks = (results ?? []).filter((r) => r && !r.skipped);
  if (!tasks.length) return;
  const allPairs = tasks.flatMap((r) => r.pairs ?? []);
  if (!allPairs.length) return;
  const pt = await getPricingTable(repoRoot, cfg, allPairs, opts);
  if (pt.mode === 'unavailable') {
    for (const r of tasks) r.costReason = pt.reason;
    return;
  }
  for (const r of tasks) {
    if (!r.pairs?.length) continue;
    const c = computeCost(r.pairs, pt.table);
    r.cost = { usd: c.usd, unpriced: c.unpriced, requests: c.requests, source: pt.mode, fetchedAt: pt.fetchedAt };
  }
}

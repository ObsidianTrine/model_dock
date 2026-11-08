// availability.mjs — 派发预检（A5，2026-11-04）：worker 模型在上游服务目录的可用性预检。
// 数据面：/_modeldock/model-availability（admin 只读；网关 24h 周期探测上游 /models、
// 失败负缓存——**缺席 = 从未探测 ≠ 不可用**）。provider 解析：/_modeldock/tier-validate
// （tiers.mjs）把 worker tier token 权威映射到 provider id；ship→provider 的映射推断属
// 推测性设计明确不做——无 tier token = 不预检（照常派发）。
// 滞留判定（hold 需全部成立，其余一律照常派发 fail-open）：
//   条目存在 ∧ fetched_at 新鲜(<25h) ∧ ok===true ∧ model_ids 非空 ∧ worker.model ∉ model_ids
// 观测失败绝不阻断派发（编排器既有哲学）；每步网络调用 ≤3s 超时。
// 零第三方依赖（.agents/ 工具链红线）。

import { resolveGatewayAdmin, validateTierViaGateway } from './tiers.mjs';

/** 目录快照节流缓存：ok 结果 5min（与海况数据面同款节流口径）；不可达负结果 60s。 */
export const AVAILABILITY_TTL_MS = 5 * 60_000;
export const AVAILABILITY_NEG_TTL_MS = 60_000;
/** 条目新鲜度上界：探测周期 24h + 1h 余量（消费方按 fetched_at 自判陈旧）。 */
export const AVAILABILITY_FRESH_MS = 25 * 3_600_000;

const _cache = new Map(); // base -> { at, snap }
const _cacheMax = 8;

function cacheGet(key, now, okTtlMs, negTtlMs) {
  const hit = _cache.get(key);
  if (!hit) return null;
  const ttl = hit.snap?.mode === 'ok' ? okTtlMs : negTtlMs;
  if (now - hit.at > ttl) return null;
  return hit.snap;
}

function cachePut(key, snap, now) {
  if (_cache.size >= _cacheMax && !_cache.has(key)) _cache.delete(_cache.keys().next().value);
  _cache.set(key, { at: now, snap });
}

/** 测试清场：清空目录快照缓存（vitest 单 fork 共享注册表，用例收尾必须调用）。 */
export function resetAvailabilityCache() {
  _cache.clear();
}

/**
 * 拉取 model-availability 快照。cfg 门控走 resolveGatewayAdmin（gatewayAdmin !== true
 * 一律 unavailable 不触达）。失败不抛——{ mode:'unavailable', reason }，调用方照常派发。
 * @returns {{ mode:'ok', at:number, availability:Record<string,{ok:boolean,fetched_at:string,model_ids?:string[],error?:string}> } | { mode:'unavailable', reason:string }}
 */
export async function fetchModelAvailability(cfg, { now = Date.now(), timeoutMs = 3000, okTtlMs = AVAILABILITY_TTL_MS, negTtlMs = AVAILABILITY_NEG_TTL_MS } = {}) {
  const adm = resolveGatewayAdmin(cfg);
  if (!adm) {
    return {
      mode: 'unavailable',
      reason: cfg?.gatewayAdmin === true
        ? '未发现网关（gateway.json 缺失或 ORCH_GATEWAY_* 未配置）'
        : 'workflow.json 未开启 gatewayAdmin',
    };
  }
  const cached = cacheGet(adm.base, now, okTtlMs, negTtlMs);
  if (cached) return cached;
  let snap;
  try {
    const res = await fetch(`${adm.base}/_modeldock/model-availability`, {
      headers: { 'x-modeldock-admin': adm.adminToken },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`网关返回 ${res.status}`);
    const j = await res.json();
    snap = {
      mode: 'ok',
      at: now,
      availability: j?.availability && typeof j.availability === 'object' && !Array.isArray(j.availability) ? j.availability : {},
    };
  } catch (e) {
    snap = { mode: 'unavailable', reason: `model-availability 查询失败：${String(e?.message ?? e).slice(0, 120)}` };
  }
  cachePut(adm.base, snap, now);
  return snap;
}

/**
 * tier token → provider id（tier-validate 权威解析）。unavailable（未开 gatewayAdmin /
 * 网关不可得 / 校验否定 / 无 provider 字段）→ null（调用方不预检，照常派发）。
 */
export async function resolveProviderViaTier({ token, tier, base, adminToken, optIn, timeoutMs = 3000 } = {}) {
  try {
    const v = await validateTierViaGateway({ token, tier, base, adminToken, optIn, timeoutMs });
    if (v.mode === 'gateway' && v.ok && v.provider) return { provider: v.provider, profile: v.profile ?? null };
  } catch { /* 校验失败 → null → 不预检 */ }
  return null;
}

/**
 * 滞留判定（纯函数）。hold 全条件：条目存在 ∧ fetched_at 新鲜(<freshMs，负 age 视为坏
 * 时间戳) ∧ ok===true ∧ model_ids 非空 ∧ model 不在列表。其余一律 fail-open 不滞留。
 * @returns {{ hold:boolean, reason:string, fetchedAt?:string }}
 */
export function availabilityVerdict(availability, provider, model, { now = Date.now(), freshMs = AVAILABILITY_FRESH_MS } = {}) {
  if (!provider || !model) return { hold: false, reason: 'no-provider-or-model' };
  const entry = availability?.[provider];
  if (!entry || typeof entry !== 'object') return { hold: false, reason: 'absent' }; // 从未探测 ≠ 不可用
  const ts = Date.parse(entry.fetched_at ?? '');
  if (!Number.isFinite(ts) || now - ts > freshMs || ts > now) return { hold: false, reason: 'stale', fetchedAt: entry.fetched_at };
  if (entry.ok !== true) return { hold: false, reason: 'probe-failed', fetchedAt: entry.fetched_at }; // 探测失败 ≠ 模型不可用
  const ids = Array.isArray(entry.model_ids) ? entry.model_ids : [];
  if (!ids.length) return { hold: false, reason: 'empty-model-ids', fetchedAt: entry.fetched_at };
  if (ids.includes(model)) return { hold: false, reason: 'listed', fetchedAt: entry.fetched_at };
  return { hold: true, reason: 'model_unavailable', fetchedAt: entry.fetched_at };
}

/**
 * 派发预检入口（decideDispatchForRun 调用）：tier-validate 解析 provider → 查该 provider
 * 的 availability 条目 → availabilityVerdict。任一步观测缺席 → { hold:false }（照常派发）。
 * tier.gatewayBase 指向别一网关（与 cfg 管理面不同源）时预检不生效——目录快照来自 cfg
 * 管理面，跨源比对会张冠李戴（保守 fail-open）。
 * @returns {{ hold:boolean, reason:string, provider?:string, model?:string, fetchedAt?:string }}
 */
export async function precheckModelAvailability({ cfg, tier, model, now = Date.now(), timeoutMs = 3000 } = {}) {
  try {
    if (!model) return { hold: false, reason: 'no-model' };
    if (!tier?.token) return { hold: false, reason: 'no-tier-token' }; // ship→provider 推断不做：无凭据即无权威 provider
    const adm = resolveGatewayAdmin(cfg);
    if (!adm) return { hold: false, reason: 'admin-unavailable' };
    if (tier.gatewayBase && adm.base !== String(tier.gatewayBase).replace(/\/+$/, '')) {
      return { hold: false, reason: 'gateway-base-mismatch' };
    }
    const resolved = await resolveProviderViaTier({ token: tier.token, tier: tier.name, base: adm.base, adminToken: adm.adminToken, optIn: true, timeoutMs });
    if (!resolved?.provider) return { hold: false, reason: 'provider-unresolved' };
    const snap = await fetchModelAvailability(cfg, { now, timeoutMs });
    // provider 随 fail-open 路径一并返回：协议兼容预检复用同一 tier-validate 解析（零重复请求）
    if (snap.mode !== 'ok') return { hold: false, reason: 'availability-unavailable', provider: resolved.provider };
    const v = availabilityVerdict(snap.availability, resolved.provider, model, { now });
    return { ...v, provider: resolved.provider, model };
  } catch {
    return { hold: false, reason: 'precheck-error' }; // fail-open：预检自身故障绝不阻断派发
  }
}

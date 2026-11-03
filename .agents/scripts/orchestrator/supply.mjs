// supply.mjs — 网关供给观测（A3 worker 并发供给闸 + A4 预算实测账，2026-11 B11/D17 同批）：
//   ① provider 容量判定：tier token → /_modeldock/tier-validate 解析到 provider →
//      /_modeldock/config 的 max_concurrency + /_modeldock/metrics 的 keypool 健康 → capacity。
//      动机：GLM 上游并发≈2 就 429，编排器被迫 workers=1；网关侧已有解药
//      （max_concurrency 信号量 + 多 key 池），编排器据此「有闸门的扩容」。
//   ② harness 实测油量轮询：/_modeldock/harness-usage 的 day_billable_tokens（可计费口径，
//      剔除缓存读）做 worker 运行中的低油量/熔断判定——zcode 无逐 turn 自报（会话结束才
//      一次性回填），自报账对它近乎失效；实测账让它获得真实逐时段 token 预算。
// fail-open 口径（AGENTS 硬性约束「网络观测一律 fail-open，绝不阻断派发/熔断误杀」）：
//   - 观测面未开启（workflow.json gatewayAdmin 缺省 false）→ 完全不触达、不设闸
//     （可移植工具链不默认读 ModelDock 状态，与 tiers.mjs 同一开启哲学）；
//   - 观测面已开启但任一环节不可达/字段缺失 → capacity=1（回落单 worker 现状：只是不扩容，
//     派发照常串行，绝不因观测失败中断 drain）；
//   - 实测油量取不到 → null → 自报账照旧兜底（budget.mjs），绝不误杀。
// 所有请求超时 ≤3s。零第三方依赖（.agents/ 工具链红线）。

import { discoverGatewayState, resolveGatewayAdmin, validateTierViaGateway } from './tiers.mjs';

/** 供给闸探测单请求超时（tier-validate / config / metrics 各自 ≤3s）。 */
export const SUPPLY_PROBE_TIMEOUT_MS = 3000;

/** 实测油量轮询间隔与单请求超时（60s 节流，与 sail 燃油上限检查同模式）。 */
export const MEASURED_FUEL_POLL_MS = 60_000;
export const MEASURED_FUEL_TIMEOUT_MS = 3000;

/**
 * 容量判定纯函数（测试直连）：由单 provider 的 max_concurrency 与 key 池健康判定可容纳的
 * worker 并发。解锁条件（船东 2026-11 定案）：max_concurrency>=2 且（healthy>=2 或 total>=2）
 * → capacity = min(max_concurrency, healthy 或 total)；否则 capacity=1（未解锁 = 不扩容）。
 * key 池全冷却（healthy=0 但 total>=2）按 total 计——容量是「配置上界」观测，冷却由网关
 * 信号量与重试兜底，不在这里二次猜测。
 * @returns {{ capacity: number, reason: string }}
 */
export function providerCapacityDecision({ maxConcurrency, keypoolTotal, keypoolHealthy } = {}) {
  const mc = Number.isFinite(maxConcurrency) ? maxConcurrency : 0;
  if (mc < 2) {
    return { capacity: 1, reason: `provider 未解锁并发（max_concurrency=${Number.isFinite(maxConcurrency) ? maxConcurrency : '未配置'}，需 >=2）` };
  }
  const total = Number.isFinite(keypoolTotal) ? keypoolTotal : 0;
  const healthy = Number.isFinite(keypoolHealthy) ? keypoolHealthy : 0;
  if (healthy >= 2) return { capacity: Math.min(mc, healthy), reason: `max_concurrency=${mc}，key 池 healthy=${healthy}` };
  if (total >= 2) return { capacity: Math.min(mc, total), reason: `max_concurrency=${mc}，key 池 total=${total}（healthy=${healthy}，部分 key 冷却中）` };
  return { capacity: 1, reason: `key 池不足 2 把 key（total=${total}，healthy=${healthy}）` };
}

/**
 * drain 供给闸探测：把 worker tier token 经网关解析到 provider，再查 config + metrics 判容量。
 * 返回 { capacity, observed, provider?, reason }：
 *   capacity = Infinity  观测面未开启（gatewayAdmin ≠ true）——不设闸，行为与历史一致
 *   capacity = 1         观测面已开启但未解锁 / 不可达 / 字段缺失（fail-safe：不盲目扩容）
 *   observed             是否拿到了权威容量判定（true 时 reason 说明依据）
 * @param {{ token?: string|null, tier?: string|null, base?: string, adminToken?: string, optIn?: boolean, timeoutMs?: number }} p
 */
export async function probeProviderCapacity(p = {}) {
  const { token, tier, base, adminToken, optIn, timeoutMs = SUPPLY_PROBE_TIMEOUT_MS } = p;
  if (optIn !== true) {
    return { capacity: Infinity, observed: false, reason: 'gatewayAdmin 未开启——不设供给闸（行为与历史一致）' };
  }
  if (!token) {
    return { capacity: 1, observed: false, reason: '观测面已开启但无 tier token——无从判定 provider 容量，回落单 worker' };
  }
  // admin 地址解析序与 validateTierViaGateway 同：显式参数 > ORCH_GATEWAY_* env > gateway.json
  // 同机发现——drainSupplyProbe 只传 optIn，base/admin 由这里自解（测试经 env 注入）。
  let gwBase = base ?? process.env.ORCH_GATEWAY_BASE ?? '';
  let gwAdmin = adminToken ?? process.env.ORCH_GATEWAY_ADMIN_TOKEN ?? '';
  if ((!gwBase || !gwAdmin) && !base && !process.env.ORCH_GATEWAY_BASE) {
    const d = discoverGatewayState();
    if (d) {
      gwBase = gwBase || `http://127.0.0.1:${d.port}`;
      gwAdmin = gwAdmin || d.adminToken;
    }
  }
  const tv = await validateTierViaGateway({ token, tier: tier ?? undefined, base: gwBase || undefined, adminToken: gwAdmin || undefined, optIn: true, timeoutMs });
  if (tv.mode !== 'gateway' || !tv.ok) {
    return { capacity: 1, observed: false, reason: `tier 网关解析不可得（${tv.reason ?? 'unavailable'}）——回落单 worker（fail-open：仅不扩容，不阻断派发）` };
  }
  const provider = tv.provider ?? null;
  if (!provider) {
    return { capacity: 1, observed: false, reason: 'tier token 未解析到 provider——回落单 worker' };
  }
  const [cfgView, metricsView] = await Promise.all([fetchAdminJson(`${gwBase}/_modeldock/config`, gwAdmin, timeoutMs), fetchAdminJson(`${gwBase}/_modeldock/metrics`, gwAdmin, timeoutMs)]);
  if (!cfgView || !metricsView) {
    return { capacity: 1, observed: false, provider, reason: `config/metrics 查询失败（provider=${provider}）——回落单 worker（fail-open）` };
  }
  // config 视图的 providers 是数组（overview-view 投影），metrics 的 keypool 是记录
  const providersArr = Array.isArray(cfgView.providers) ? cfgView.providers : [];
  const providerCfg = providersArr.find((x) => x && x.id === provider) ?? null;
  const kp = metricsView.keypool && typeof metricsView.keypool === 'object' ? metricsView.keypool[provider] : null;
  const d = providerCapacityDecision({
    maxConcurrency: providerCfg && Number.isFinite(providerCfg.max_concurrency) ? providerCfg.max_concurrency : NaN,
    keypoolTotal: kp && Number.isFinite(kp.total) ? kp.total : NaN,
    keypoolHealthy: kp && Number.isFinite(kp.healthy) ? kp.healthy : NaN,
  });
  return { capacity: d.capacity, observed: true, provider, reason: d.reason };
}

/** admin GET 尽力而为：非 2xx / 超时 / 网络 / 解析失败一律 null（调用方回落，绝不抛出）。 */
async function fetchAdminJson(url, adminToken, timeoutMs) {
  if (!url || !/^https?:\/\//.test(url) || !adminToken) return null;
  try {
    const res = await fetch(url, { headers: { 'x-modeldock-admin': adminToken }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * harness-usage 响应 → 该 harness 的 day_billable_tokens。字段缺失/非法（旧网关、旧内存态
 * 未累计过）→ null——调用方保持自报账兜底，绝不把「读不到」当「零消耗」。
 */
export function harnessBillableFromUsage(payload, harnessId) {
  const u = payload && typeof payload === 'object' ? payload.usage : null;
  const v = u && typeof u === 'object' ? u[harnessId]?.day_billable_tokens : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** 单次拉取实测油量：失败/字段缺失 → null（fail-open，静默）。 */
export async function fetchHarnessBillable({ base, adminToken, harness, timeoutMs = MEASURED_FUEL_TIMEOUT_MS }) {
  if (!base || !adminToken || !harness) return null;
  const payload = await fetchAdminJson(`${base.replace(/\/+$/, '')}/_modeldock/harness-usage`, adminToken, timeoutMs);
  return payload ? harnessBillableFromUsage(payload, harness) : null;
}

/**
 * 实测油量轮询器（A4）：每 60s 拉 harness-usage 的 day_billable_tokens 喂 budget.accountMeasured
 * （可计费口径、网关实测）；取不到时静默（自报账兜底）。返回 { active, stop() }——
 * harness 未知 / gatewayAdmin 未开 / 无 admin 地址时不启动（active=false，零副作用）。
 * intervalMs 仅测试注入（生产恒 60s）。定时器 unref：进程自然退出不被它拖住；调用方收尾必须 stop()。
 */
export function startMeasuredFuelPoller({ budget, cfg, harness, intervalMs = MEASURED_FUEL_POLL_MS, log = () => {} } = {}) {
  const adm = harness && cfg?.gatewayAdmin === true ? resolveGatewayAdmin(cfg) : null;
  if (!adm) return { active: false, stop() {} };
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return; // 上一轮超时未归：跳过本轮，不堆叠请求
    inFlight = true;
    void (async () => {
      try {
        const v = await fetchHarnessBillable({ base: adm.base, adminToken: adm.adminToken, harness });
        if (v != null) budget.accountMeasured(v); // null（旧网关字段缺失/不可达）→ 自报账兜底
      } finally {
        inFlight = false;
      }
    })();
  }, intervalMs);
  timer.unref?.();
  log(`⛽ 实测油量轮询已启动：harness=${harness} ← ${adm.base}/_modeldock/harness-usage（60s 节流，网关实测口径；取不到时自报账兜底）`);
  return { active: true, stop: () => clearInterval(timer) };
}

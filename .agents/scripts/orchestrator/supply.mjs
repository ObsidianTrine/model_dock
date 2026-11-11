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
 * provider 实时水位读数与饱和 advisory（纯函数，测试直连；2026-11 concurrency signal）：
 * entry = metrics.concurrency[providerId]（{ in_flight, queued, limit }，见
 * src/gateway/server.ts hMetrics）。返回 { waterline, saturation_advisory }：
 *   waterline            实时读数原样（三字段齐全才给）；provider 在 concurrency 段缺席
 *                        = 空闲（网关口径：无流量且无在途不露出，缺席勿当故障）→ null
 *   saturation_advisory  饱和（in_flight>=limit 且 limit>0）或排队（queued>0）时给
 *                        { level:'saturated'|'queued', in_flight, queued, limit, message }
 *                        （同时饱和与排队取更强的 saturated）；水位正常 → null。
 *                        **只照亮不拦截**：不改变 capacity 判定与派发放行（硬语义变更
 *                        如「排队即延迟派发」需用户拍板）；旧网关缺 concurrency 段 →
 *                        两者恒 null（fail-open，行为与历史一致）。
 */
export function providerWaterline(entry) {
  if (!entry || typeof entry !== 'object') return { waterline: null, saturation_advisory: null };
  const in_flight = entry.in_flight;
  const queued = entry.queued;
  const limit = entry.limit;
  if (!Number.isFinite(in_flight) || !Number.isFinite(queued) || !Number.isFinite(limit)) {
    return { waterline: null, saturation_advisory: null };
  }
  const waterline = { in_flight, queued, limit };
  const saturated = limit > 0 && in_flight >= limit;
  const hasQueue = queued > 0;
  if (!saturated && !hasQueue) return { waterline, saturation_advisory: null };
  const occupancy = limit > 0 ? `in_flight ${in_flight}/${limit}` : `in_flight ${in_flight}（不限上限）`;
  const message = saturated
    ? `${occupancy} 已饱和${hasQueue ? `，另有 ${queued} 个请求排队` : ''}`
    : `请求排队中（queued ${queued}，${occupancy}）`;
  return {
    waterline,
    saturation_advisory: { level: saturated ? 'saturated' : 'queued', in_flight, queued, limit, message },
  };
}

/**
 * drain 供给闸探测：把 worker tier token 经网关解析到 provider，再查 config + metrics 判容量。
 * 返回 { capacity, observed, provider?, reason }；观测打通时另附实时水位（纯增量 advisory，
 * 见 providerWaterline）：
 *   waterline            { in_flight, queued, limit } | null（concurrency 段可得且该 provider 在列时）
 *   saturation_advisory  { level, in_flight, queued, limit, message }（仅饱和/排队时存在）
 *   capacity / observed / reason 语义不变——advisory 不参与任何判定。
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
  // 实时水位读数（纯增量 advisory，2026-11 concurrency signal）：probe 本就拉了 metrics——
  // 直接读目标 provider 的 in_flight/queued 附在结果里，饱和/排队时再附 saturation_advisory
  // 提示。capacity 判定与派发放行零变化；旧网关无 concurrency 段或 provider 缺席（= 空闲）
  // → waterline/saturation_advisory 为 null，调用方按缺失处理。
  const wl = providerWaterline(metricsView.concurrency && typeof metricsView.concurrency === 'object' ? metricsView.concurrency[provider] : null);
  return {
    capacity: d.capacity,
    observed: true,
    provider,
    reason: d.reason,
    waterline: wl.waterline,
    ...(wl.saturation_advisory ? { saturation_advisory: wl.saturation_advisory } : {}),
  };
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

/** 临期告警阈值（orch-ephemeral-expiry-watch）：剩余 < min(20% TTL, 30min) 触发——
 *  短 TTL 凭据按寿命比例提前量，长 TTL 被 30min 封顶（预警窗口再大也只是刷屏）。 */
export const EXPIRY_WARN_TTL_SHARE = 0.2;
export const EXPIRY_WARN_MAX_MS = 30 * 60 * 1000;

/**
 * harness-usage 响应 → 该 harness 的临期判定原料（expiresAtMs）。仅 ephemeral 条目带
 * expires_at（网关 hHarnessUsage 对 rt.ephemeral 的投影）；非临时凭据（tier token 解析的
 * 常驻 harness）无该字段 → null，天然不参与临期预警。已吊销/已过期被网关摘除的条目
 * 直接缺席 usage → 同样 null（吊销即静默）。expires_at 非法时间戳 → null（fail-open）。
 */
export function harnessExpiryFromUsage(payload, harnessId) {
  const u = payload && typeof payload === 'object' ? payload.usage : null;
  const e = u && typeof u === 'object' ? u[harnessId] : null;
  if (!e || typeof e !== 'object' || e.ephemeral !== true || typeof e.expires_at !== 'string') return null;
  const ms = Date.parse(e.expires_at);
  return Number.isFinite(ms) ? { expiresAtMs: ms } : null;
}

/**
 * 临期预警观察器（纯判定 + 去抖，测试直连）：observe() 每次轮询喂一次 usage payload，
 * 跨阈值时返回 { harness_id, expires_at, remaining_ms, threshold_ms, ttl_ms }，否则 null。
 * 内部两份状态：
 *   anchor  expiresAtMs → 首次观测时刻。TTL 无法从单个绝对时间戳反推（网关响应只有
 *           expires_at、无签发时刻；网关 src/** 本卡禁碰不可加字段），用首次观测时刻锚定
 *           ——轮询器在 provision 后 ≤一个周期内首采，误差 ≤60s，只对 TTL<2.5h 的短凭据
 *           的 20% 分支有秒级影响，可接受。
 *   warned  已告警的 expiresAtMs 集合。去抖口径 = 每个阈值实例只告警一次：同一次签发的
 *           凭据 expires_at 恒定 → 只告一次；re-provision 产生新 expires_at = 新阈值实例
 *           → 允许再告（跨 run 重试属新凭据，不是重复刷屏）。
 * @param {{ ttlShare?: number, capMs?: number }} opts 阈值参数（测试注入；生产用缺省）
 */
export function createExpiryWatcher({ ttlShare = EXPIRY_WARN_TTL_SHARE, capMs = EXPIRY_WARN_MAX_MS } = {}) {
  const anchor = new Map();
  const warned = new Set();
  return {
    observe(payload, harnessId, nowMs = Date.now()) {
      const ex = harnessExpiryFromUsage(payload, harnessId);
      if (!ex) return null;
      const { expiresAtMs } = ex;
      if (!anchor.has(expiresAtMs)) anchor.set(expiresAtMs, nowMs);
      const ttlMs = Math.max(expiresAtMs - anchor.get(expiresAtMs), 0);
      const thresholdMs = Math.min(ttlMs * ttlShare, capMs);
      const remainingMs = expiresAtMs - nowMs;
      if (remainingMs >= thresholdMs || warned.has(expiresAtMs)) return null;
      warned.add(expiresAtMs);
      return {
        harness_id: harnessId,
        expires_at: new Date(expiresAtMs).toISOString(),
        remaining_ms: remainingMs,
        threshold_ms: Math.round(thresholdMs),
        ttl_ms: Math.round(ttlMs),
      };
    },
  };
}

/** 临期续命单请求超时（orch-ephemeral-renew-consume，AGENTS 硬性约束 ≤3s，与 provision/revoke 同款）。 */
export const RENEW_TIMEOUT_MS = 3000;

/**
 * 续期一次性 harness（orch-ephemeral-renew-consume）：POST /_modeldock/harness/renew（船 9
 * 交付的网关端点，src/gateway/server.ts hRenewHarness）。请求体 { harnessId, ttl_minutes }——
 * body 键是 harnessId（与 provision/revoke 的 id 不同名，网关侧决策）；ttl_minutes 为正数分钟，
 * 网关只延不缩（新到期 = max(旧到期, now+ttl)，收敛 ≤1440min 硬顶；缩短请求 = 无效 no-op）。
 * 响应 200 { ok, id, expires_at, ttl_minutes }；400 非法传参 / 404 非在册临时条目（未知 id、
 * 持久 harness、已吊销或已清扫）/ 410 已过期（过期凭据不得复活）。
 * fail-open（provision.mjs 同口径）：admin 未配置 / 网关不可达 / 超时 / 非 2xx / 响应异常
 * 一律 { ok:false, reason } 返回，绝不抛出——调用方只落事件，续期失败不重试（重试风暴红线）。
 * @param {{ base: string, adminToken: string }} ga admin 地址与令牌（resolveGatewayAdmin 产物）
 * @param {string} harnessId provision 响应返回的临时 harness id
 * @param {number} ttlMinutes 续期分钟数（与 provision ttlHours×60 同源；非法值直接 fail-open）
 * @returns { Promise<{ ok: true, id: string, expiresAt: string|null, ttlMinutes: number|null }
 *                  | { ok: false, reason: string }> }
 */
export async function renewTaskHarness(ga, harnessId, ttlMinutes, { timeoutMs = RENEW_TIMEOUT_MS } = {}) {
  if (!ga || !/^https?:\/\//.test(String(ga.base ?? '')) || !ga.adminToken) {
    return { ok: false, reason: 'admin 未配置（gatewayAdmin 未开启或未发现网关）' };
  }
  if (!harnessId) return { ok: false, reason: '缺少 harnessId（未签发一次性凭据，无可续期）' };
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) return { ok: false, reason: 'ttl_minutes 未定（卡无生效 max_wall_minutes）——不续' };
  try {
    const res = await fetch(`${String(ga.base).replace(/\/+$/, '')}/_modeldock/harness/renew`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-modeldock-admin': ga.adminToken },
      body: JSON.stringify({ harnessId, ttl_minutes: ttlMinutes }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { ok: false, reason: 'admin token 被网关拒绝（gateway.json 与运行实例不同源？）' };
    if (!res.ok) return { ok: false, reason: `网关返回 ${res.status}` };
    const j = await res.json().catch(() => null);
    if (!j?.ok) return { ok: false, reason: `网关响应异常：${j?.reason ?? '缺少 ok'}` };
    return {
      ok: true,
      id: typeof j.id === 'string' && j.id ? j.id : harnessId,
      expiresAt: typeof j.expires_at === 'string' ? j.expires_at : null,
      ttlMinutes: Number.isFinite(j.ttl_minutes) ? j.ttl_minutes : null,
    };
  } catch (e) {
    return { ok: false, reason: `网关不可达：${e?.message ?? e}` };
  }
}

/**
 * 临期续命消费钩子（orch-ephemeral-renew-consume）：createExpiryWatcher 跨阈值时由
 * orchestrator 的 onExpiryWarning 接线调用——先落 harness_expiry_warning（船 5 事件口径不变），
 * 随即向网关 renew 端点续命（≤3s 超时、fail-open）：成功落 harness_renewed（含新 expires_at），
 * 失败落 harness_renew_failed（不抛、不重试——与 revoke 同红线，漏网由 TTL 自然过期兜底）。
 *
 * 保守闸（deps 注入，orchestrator 闭包取实时值）：liveHarnessId() 只认本 run 已签发且未吊销的
 * 一次性凭据（gatewayAdmin/provision 前置已由上游保证——taskHarness 存在即 admin 可得）；任务
 * 落位终态（terminalState()，blocked/merged/failed）后不再续——awaiting-human 人工闸门期间凭据
 * 仍活，照常预警与续期。id 不匹配（tier 解析的非任务凭据等）一律静默。
 *
 * 去抖重置口径：续期成功改写网关侧 expires_at → 下一轮 harness-usage 即新值 →
 * createExpiryWatcher 以 expiresAtMs 为去抖键，天然按新实例重新锚定/去抖（新 expires_at 是
 * 新阈值实例，可再告警/再续），无需手动清状态；旧实例已 warned，即使续期后短暂读到旧值也
 * 不会重复告警/续期。续期失败后本实例亦不再重试（已 warned）。
 *
 * 依赖注入（appendEvent/log）保持本模块零编排域依赖；返回的回调返回续命 Promise
 * （生产 fire-and-forget 不 await，测试可 await 精确断言事件时序）。
 * @param {{ ga: object|null, ttlMinutes?: number, liveHarnessId: () => string|null,
 *          terminalState: () => boolean, appendEvent: (type: string, fields: object) => void,
 *          log?: (msg: string) => void, timeoutMs?: number }} deps
 */
export function createExpiryRenewal({ ga, ttlMinutes, liveHarnessId, terminalState, appendEvent, log = () => {}, timeoutMs = RENEW_TIMEOUT_MS } = {}) {
  return (w) => {
    // 整体 try/catch（P2 修正 2026-11-11）：appendEvent/log 的同步段（Windows EBUSY 等写
    // 失败）在回调里直接抛——回调经 poller fire-and-forget 消费，同步抛与异步 rejection
    // 同样变成 unhandledRejection 带崩整个 run 进程（fail-open 红线）。保守闸的 fs 读
    // （liveHarnessId/terminalState 闭包查卡状态）也在兜底面内。
    try {
      const harnessId = typeof liveHarnessId === 'function' ? liveHarnessId() : null;
      if (!harnessId || !w || w.harness_id !== harnessId) return Promise.resolve();
      if (typeof terminalState === 'function' && terminalState() === true) return Promise.resolve();
      appendEvent('harness_expiry_warning', { harness_id: w.harness_id, expires_at: w.expires_at, remaining_ms: w.remaining_ms, threshold_ms: w.threshold_ms });
      const mins = Math.max(1, Math.ceil((w.remaining_ms ?? 0) / 60000));
      log(`⏳ 一次性凭据临期：harness=${w.harness_id} 剩余约 ${mins} 分钟（阈值 ${Math.round((w.threshold_ms ?? 0) / 60000)} 分钟）——触发网关续期（失败只留痕，尽快收尾落位）`);
      return (async () => {
        try {
          const rr = await renewTaskHarness(ga, harnessId, ttlMinutes, { timeoutMs });
          if (rr.ok) {
            appendEvent('harness_renewed', { harness_id: rr.id ?? harnessId, expires_at: rr.expiresAt, ttl_minutes: rr.ttlMinutes });
            log(`♻ 一次性凭据已续期：harness=${harnessId} 新到期 ${rr.expiresAt ?? '未知'}（网关只延不缩；下一轮 usage 即新阈值实例，可再告警/再续）`);
          } else {
            appendEvent('harness_renew_failed', { harness_id: harnessId, reason: rr.reason });
            log(`⚠ 一次性凭据续期失败（${rr.reason}）——fail-open 不重试，凭据按原到期继续，临期前尽量收尾落位避免中途 401`);
          }
        } catch (e) {
          // 双保险：renewTaskHarness 本身 fail-open 不抛，这里兜 appendEvent/log 等意外——回调经
          // poller fire-and-forget 消费，未处理的 rejection 会带崩整个 run 进程（fail-open 红线）
          log(`⚠ 一次性凭据续命意外失败（${e?.message ?? e}）——fail-open 继续跑`);
        }
      })();
    } catch (e) {
      log(`⚠ 一次性凭据临期处置意外失败（${e?.message ?? e}）——fail-open 继续跑（预警/续期本轮跳过，凭据按原到期继续）`);
      return Promise.resolve();
    }
  };
}

/** 单次拉取 harness-usage 原始 payload：失败/字段缺失 → null（fail-open，静默）。 */
async function fetchHarnessUsagePayload({ base, adminToken, timeoutMs }) {
  if (!base || !adminToken) return null;
  return fetchAdminJson(`${String(base).replace(/\/+$/, '')}/_modeldock/harness-usage`, adminToken, timeoutMs);
}

/** 单次拉取实测油量：失败/字段缺失 → null（fail-open，静默）。 */
export async function fetchHarnessBillable({ base, adminToken, harness, timeoutMs = MEASURED_FUEL_TIMEOUT_MS }) {
  if (!harness) return null;
  const payload = await fetchHarnessUsagePayload({ base, adminToken, timeoutMs });
  return payload ? harnessBillableFromUsage(payload, harness) : null;
}

/**
 * 实测油量轮询器（A4）：每 60s 拉 harness-usage 的 day_billable_tokens 喂 budget.accountMeasured
 * （可计费口径、网关实测）；取不到时静默（自报账兜底）。同一份 payload 兼顾一次性凭据临期
 * 预警（orch-ephemeral-expiry-watch）：ephemeral 条目带 expires_at，剩余 < min(20% TTL, 30min)
 * 时经 onExpiryWarning 回调上抛（事件落盘 + log 由调用方负责；去抖在 createExpiryWatcher——
 * 每凭据每阈值一次）。返回 { active, stop() }——
 * harness 未知 / gatewayAdmin 未开 / 无 admin 地址时不启动（active=false，零副作用）。
 * intervalMs / nowFn 仅测试注入（生产恒 60s / Date.now）。定时器 unref：进程自然退出不被它
 * 拖住；调用方收尾必须 stop()。
 */
export function startMeasuredFuelPoller({ budget, cfg, harness, intervalMs = MEASURED_FUEL_POLL_MS, log = () => {}, onExpiryWarning = null, nowFn = Date.now } = {}) {
  const adm = harness && cfg?.gatewayAdmin === true ? resolveGatewayAdmin(cfg) : null;
  if (!adm) return { active: false, stop() {} };
  const expiryWatcher = typeof onExpiryWarning === 'function' ? createExpiryWatcher() : null;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return; // 上一轮超时未归：跳过本轮，不堆叠请求
    inFlight = true;
    void (async () => {
      try {
        const payload = await fetchHarnessUsagePayload({ base: adm.base, adminToken: adm.adminToken, timeoutMs: MEASURED_FUEL_TIMEOUT_MS });
        if (!payload) return; // 不可达/旧网关字段缺失 → 静默（自报账兜底）
        const v = harnessBillableFromUsage(payload, harness);
        if (v != null) budget.accountMeasured(v); // null → 自报账兜底
        if (expiryWatcher) {
          const warn = expiryWatcher.observe(payload, harness, nowFn());
          if (warn) onExpiryWarning(warn);
        }
      } finally {
        inFlight = false;
      }
    })().catch((e) => {
      // 双保险收口（P2 修正 2026-11-11）：onExpiryWarning 同步段与观测主体的任何异常都不
      // 出 poller——fire-and-forget 的 IIFE 只配 finally 时异常仍成 unhandledRejection 带
      // 崩整个 run 进程。fail-open 名副其实：下一轮照常轮询。
      try { log(`⚠ 实测油量轮询单轮失败（${e?.message ?? e}）——fail-open 继续跑`); } catch { /* log 再抛也吞 */ }
    });
  }, intervalMs);
  timer.unref?.();
  log(`⛽ 实测油量轮询已启动：harness=${harness} ← ${adm.base}/_modeldock/harness-usage（60s 节流，网关实测口径；取不到时自报账兜底${expiryWatcher ? '；一次性凭据临期预警已接线' : ''}）`);
  return { active: true, stop: () => clearInterval(timer) };
}

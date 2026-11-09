// fleet.mjs — 开航前海况观测（纯观测，零决策变更；2026-11-03 船东定案阶段 1）：
// 派发前拉网关 admin 面（/_modeldock/config + /_modeldock/metrics），把「有哪些服务、
// 什么状态、哪些客户端指向网关、谁在熔断」写进任务事件时间线（fleet_observed）并打印
// 告警行。**只观测不决策**——选船仍走既有静态规则（workflow.json > CLI 显式 > 沿用），
// 引擎切换人工闸门不变；观测缺席（gatewayAdmin 未开/网关不可达）绝不阻断派发。
// A4（2026-11）：admin 查询前先打免鉴权 /v1/health 探活（≤2s）——此前 admin 凭据错误与
// 网关挂了都表现成「查询失败」，人工无法区分该修凭据还是该救网关；现在探活失败 =
// 「网关不可达」，探活成功但 admin 失败 = 「网关在线但 admin 凭据/接口异常」。只改告警
// 文案与分类，不拦截（observe 只照亮不拦截的设计不变）。
// 船 ↔ harness 映射：编排后端是 headless CLI，接入态看的是同一个 CLI 的交互形态适配器
// （zcode-headless ↔ zcode、claude-headless ↔ claude-code）——客户端指向「其他端点」
// = 船将绕开 ModelDock 燃油（reconcile 会显示网关零流量），这是本模块要照亮的头号盲区。

import { resolveGatewayAdmin } from './tiers.mjs';

const FLEET_TIMEOUT_MS = 3000;
/** /v1/health 免鉴权探活超时（A4）：定责「网关不可达」vs「在线但 admin 异常」。 */
const HEALTH_PROBE_TIMEOUT_MS = 2000;

async function getJson(base, adminToken, path, timeoutMs) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'x-modeldock-admin': adminToken },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`网关返回 ${res.status}`);
  return res.json();
}

/** 船（编排后端）→ 网关 harness 适配器 id（接入态观测对象）；mock 等无对应 harness。 */
export const SHIP_HARNESS = { 'zcode-headless': 'zcode', 'claude-headless': 'claude-code' };

/**
 * 拉取并压缩海况快照。返回
 *   { mode:'ok', observedAt, providers:[{id, models, down, lastMs}], harnesses:[{id, attached, pointing}], meltdown:[{provider, class}] }
 *   | { mode:'unavailable', reason }
 * 观测失败永不抛出——海况是观测面，断了就如实 unavailable。
 */
export async function fetchFleetState(cfg, opts = {}) {
  const adm = resolveGatewayAdmin(cfg);
  if (!adm) {
    return {
      mode: 'unavailable',
      reason: cfg?.gatewayAdmin === true
        ? '未发现网关（gateway.json 缺失或 ORCH_GATEWAY_* 未配置）'
        : 'workflow.json 未开启 gatewayAdmin',
    };
  }
  const timeoutMs = opts.timeoutMs ?? FLEET_TIMEOUT_MS;
  // A4 前置探活：免鉴权 GET /v1/health（≤2s）先于 admin 查询定责。网络层探活失败
  // （拒连/超时）→ 直接 unavailable「网关不可达」（admin 查询不必再撞超时）；探活成功
  // → 继续 admin 查询，此时查询失败 = 「网关在线但 admin 凭据/接口异常」。/v1/health 返回
  // 非 200 不算不可达（有东西在应答——可能非网关服务或旧版鉴权），留作 admin 失败时的
  // 归因线索。只影响文案与分类，不拦截（observe 只照亮不拦截的设计不变）。
  let healthNote = '';
  try {
    const h = await fetch(`${adm.base}/v1/health`, { signal: AbortSignal.timeout(opts.healthTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS) });
    if (!h.ok) healthNote = `（/v1/health 返回 ${h.status}）`;
  } catch (e) {
    return { mode: 'unavailable', reason: `网关不可达（/v1/health 探活失败：${String(e?.message ?? e).slice(0, 120)}）` };
  }
  try {
    const [cfgView, metrics] = await Promise.all([
      getJson(adm.base, adm.adminToken, '/_modeldock/config', timeoutMs),
      getJson(adm.base, adm.adminToken, '/_modeldock/metrics', timeoutMs),
    ]);
    const melted = new Map(
      (Array.isArray(metrics?.meltdown) ? metrics.meltdown : [])
        .filter((m) => m && m.provider)
        .map((m) => [m.provider, { provider: m.provider, class: m.class ?? null }])
    );
    const providers = Object.entries(cfgView?.providers ?? {}).map(([id, p]) => ({
      id,
      models: Array.isArray(p?.models) ? p.models.length : 0,
      down: melted.has(id),
      lastMs: metrics?.providers?.[id]?.last_ms ?? null,
    }));
    const harnesses = (Array.isArray(cfgView?.harness) ? cfgView.harness : []).map((h) => ({
      id: h?.id,
      attached: h?.attached === true,
      pointing: h?.pointing ?? 'unknown',
    }));
    return {
      mode: 'ok',
      observedAt: new Date().toISOString(),
      providers,
      harnesses,
      meltdown: [...melted.values()],
    };
  } catch (e) {
    // 探活已过（网络层在线）走到这里 = admin 面（凭据/接口）异常——文案直接点名，替代
    // 含混的「查询失败」（A4：人工该去核对 admin token 而不是去救网关）；health 探活的
    // 非 200 异常（如有）作为归因线索附上
    return { mode: 'unavailable', reason: `网关在线但 admin 凭据/接口异常${healthNote}——网关查询失败：${e?.message ?? e}` };
  }
}

/**
 * 海况判读（纯函数）：派发这条船的视角找隐患。只产告警不阻断——
 *   dogfood_bypass  本船对应客户端指向其他端点（绕开狗粮，燃油实测/对账失效）
 *   not_attached    本船对应客户端未经 ModelDock 接管（引擎/路由自行其是）
 *   meltdown_active 有服务在熔断（自动路由会避开；钉死路由/tier 的船会撞 429）
 */
export function assessFleet(state, { backend } = {}) {
  if (state?.mode !== 'ok') return [];
  const warnings = [];
  const hid = SHIP_HARNESS[backend];
  if (hid) {
    const row = (state.harnesses ?? []).find((h) => h.id === hid);
    if (row) {
      if (row.attached && row.pointing === 'other') {
        warnings.push({
          code: 'dogfood_bypass',
          message: `${hid} 客户端当前指向 ModelDock 之外的端点——${backend} 船将直连上游，燃油实测与 reconcile 对账失效`,
        });
      } else if (!row.attached) {
        warnings.push({
          code: 'not_attached',
          message: `${hid} 客户端未经 ModelDock 接管（attached=false）——${backend} 船按其自身配置航行，不经网关路由与计量`,
        });
      }
    }
  }
  const melted = (state.providers ?? []).filter((p) => p.down).map((p) => p.id);
  if (melted.length) {
    warnings.push({
      code: 'meltdown_active',
      message: `服务熔断中：${melted.join(', ')}——自动路由会避开；钉死路由 / tier 指向其上的船会撞 429`,
    });
  }
  return warnings;
}

/** 海况一行摘要（日志用）：服务数/熔断数 + 各客户端指向。 */
export function renderFleetLine(state) {
  const providers = state.providers ?? [];
  const melted = providers.filter((p) => p.down).length;
  const pointing = (state.harnesses ?? [])
    .filter((h) => h.id)
    .map((h) => `${h.id}=${h.pointing}${h.attached ? '' : '(未接入)'}`)
    .join(' / ');
  return `⚓ 海况（${state.observedAt}）：服务 ${providers.length} 个（熔断 ${melted}）${pointing ? ` · 客户端 ${pointing}` : ''}`;
}

/**
 * 派发前观测入口（cmdRun 调用）：返回 { lines, event, state }。
 *   gatewayAdmin 未开 → 完全静默（{ lines: [], event: null, state: null }，行为与历史版本一致）；
 *   开了但不可得 → 一行可操作提示，不落事件不阻断；
 *   观测成功 → 摘要行 + 告警行，event = fleet_observed 载荷（紧凑，供事件时间线留痕），
 *   state = 原始快照（动态选船逐船判读用——event 压缩掉了 attached 位，判 not_attached 需要它）。
 */
export async function observeFleetForRun(cfg, { backend } = {}) {
  const state = await fetchFleetState(cfg);
  if (state.mode !== 'ok') {
    if (cfg?.gatewayAdmin === true) {
      return { lines: [`⚓ 海况观测不可得：${state.reason}——继续按既有规则派发`], event: null, state: null };
    }
    return { lines: [], event: null, state: null };
  }
  const warnings = assessFleet(state, { backend });
  const lines = [renderFleetLine(state), ...warnings.map((w) => `⚠ ${w.message}`)];
  return {
    lines,
    state,
    event: {
      mode: 'ok',
      providers: Object.fromEntries((state.providers ?? []).map((p) => [p.id, { down: p.down, lastMs: p.lastMs }])),
      meltdown: (state.meltdown ?? []).map((m) => m.provider),
      harnesses: Object.fromEntries((state.harnesses ?? []).map((h) => [h.id, h.pointing])),
      warnings: warnings.map((w) => w.code),
      ...(warnings.some((w) => w.code === 'dogfood_bypass') ? { dogfood_bypass: true } : {}),
    },
  };
}

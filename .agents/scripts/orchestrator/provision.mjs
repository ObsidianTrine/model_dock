// provision.mjs — 每任务一次性凭据（ephemeral harness）编排侧接入（2026-11-08）。
// 网关已交付 POST /_modeldock/harness/provision | /_modeldock/harness/revoke（admin 门内，
// src/gateway/server.ts C14）：签发 runtime-only 临时 harness——TTL ≤24h、可选日限额、
// 不落盘、token 明文只在签发响应出现一次、revoke 幂等（条目不在册也返回 ok）。
// 本模块提供：provisionTaskHarness / revokeTaskHarness（admin 请求封装）+ 两个纯函数
// （findUnrevokedHarnessId 接管路径找陈账、applyEphemeralToken 凭据并入 env patch）。
//
// fail-open 红线（AGENTS：网络观测一律 fail-open，绝不阻断派发）：所有失败形态
// （admin 未配置 / 网关不可达 / 超时 / 非 2xx / 响应缺字段）一律返回 { ok:false, reason }
// 由调用方回落既有 tier token 路径（行为与未接入完全一致）并记一条编排事件，绝不抛出。
// 单请求超时 ≤3s，与编排侧既有 admin 调用口径一致（tiers.mjs / supply.mjs 同款）。
// 零第三方依赖（.agents/ 工具链红线）。

/** provision / revoke 单请求超时（AGENTS 硬性约束 ≤3s）。 */
export const PROVISION_TIMEOUT_MS = 3000;

/** 网关 TTL 硬顶（分钟）：临时凭据不得事实永久化，超界请求会被网关 400——客户端先收敛。 */
const TTL_MAX_MINUTES = 24 * 60;

/**
 * 签发一次性 harness。ga = resolveGatewayAdmin(cfg) 的结果（{ base, adminToken }），
 * 请求体不传 id 时网关自动生成 eph-<随机>。
 * @param {{ base: string, adminToken: string }} ga admin 地址与令牌（resolveGatewayAdmin 产物）
 * @param {{ taskId?: string, ttlHours?: number, maxDailyTokens?: number, timeoutMs?: number }} opts
 *   taskId    确定性 id 的原料（`orch-<taskId>`，非法字符归一为 `-`）——网关审计与 Web 控制台
 *             可直接看出凭据归属；已被占用（上次 revoke 失败的残留）时自动降级为不传 id
 *             重试一次（网关随机生成，绝不因 id 冲突 fail-open）。
 *   ttlHours  TTL 小时数；非法/缺省不传（网关缺省 480 分钟），>24 收敛到 24（网关硬顶）。
 *   maxDailyTokens  per-harness 日限额（超限 429 与网关 daily_tokens 同口径）；缺省不限。
 * @returns { Promise<{ ok: true, harnessId: string, token: string, expiresAt: string|null, env: object|null }
 *                  | { ok: false, reason: string }> }
 */
export async function provisionTaskHarness(ga, opts = {}) {
  const { taskId, ttlHours, maxDailyTokens, timeoutMs = PROVISION_TIMEOUT_MS } = opts ?? {};
  if (!ga || !/^https?:\/\//.test(String(ga.base ?? '')) || !ga.adminToken) {
    return { ok: false, reason: 'admin 未配置（gatewayAdmin 未开启或未发现网关）' };
  }
  const body = {};
  if (Number.isFinite(ttlHours) && ttlHours > 0) body.ttl_minutes = Math.min(ttlHours, 24) * 60;
  if (Number.isFinite(maxDailyTokens) && maxDailyTokens > 0) body.max_daily_tokens = Math.floor(maxDailyTokens);
  // 确定性 id（orch-<taskId>）：审计面可读 + 同任务续跑时接管吊销先释放 id。
  // 网关对已占用 id 返回 400——降级为不带 id 重试一次（随机 eph-*，永不因冲突失败）。
  const taskIdSafe = typeof taskId === 'string' ? taskId.trim().replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[-.]+/, '').slice(0, 59) : '';
  if (taskIdSafe) body.id = `orch-${taskIdSafe}`;
  const attempt = async (payload) => {
    const res = await fetch(`${String(ga.base).replace(/\/+$/, '')}/_modeldock/harness/provision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-modeldock-admin': ga.adminToken },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res;
  };
  try {
    let res = await attempt(body);
    if (res.status === 400 && body.id) {
      res = await attempt({ ...body, id: undefined });
    }
    if (res.status === 401) return { ok: false, reason: 'admin token 被网关拒绝（gateway.json 与运行实例不同源？）' };
    if (!res.ok) return { ok: false, reason: `网关返回 ${res.status}` };
    const j = await res.json().catch(() => null);
    if (!j?.ok) return { ok: false, reason: `网关响应异常：${j?.reason ?? '缺少 ok'}` };
    if (typeof j.id !== 'string' || !j.id || typeof j.token !== 'string' || !j.token) {
      return { ok: false, reason: '网关响应缺少 id/token（旧版网关无 provision 端点的响应契约？）' };
    }
    return {
      ok: true,
      harnessId: j.id,
      token: j.token,
      expiresAt: typeof j.expires_at === 'string' ? j.expires_at : null,
      env: j.env && typeof j.env === 'object' ? j.env : null,
    };
  } catch (e) {
    return { ok: false, reason: `网关不可达：${e?.message ?? e}` };
  }
}

/**
 * 吊销一次性 harness（幂等）：网关 200 {ok, revoked} 与 404（已过期/已吊销/从未存在）
 * 一律 ok:true——「条目已不在册」就是吊销想要达成的终态。仅网络层失败 / 鉴权失败 /
 * 其他非 2xx 返回 ok:false（调用方 best-effort：只告警不阻断、不重试——重试风暴红线，
 * 漏网凭据由 TTL（≤24h）自然过期兜底）。
 * @returns { Promise<{ ok: true, revoked: boolean } | { ok: false, reason: string }> }
 *   revoked = 网关确答「在册条目被摘除」；false = 本来就不在册（幂等放行）。
 */
export async function revokeTaskHarness(ga, harnessId, { timeoutMs = PROVISION_TIMEOUT_MS } = {}) {
  if (!ga || !/^https?:\/\//.test(String(ga.base ?? '')) || !ga.adminToken) {
    return { ok: false, reason: 'admin 未配置（gatewayAdmin 未开启或未发现网关）' };
  }
  if (!harnessId) return { ok: true, revoked: false }; // 无凭据可吊销 = 幂等成功
  try {
    const res = await fetch(`${String(ga.base).replace(/\/+$/, '')}/_modeldock/harness/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-modeldock-admin': ga.adminToken },
      body: JSON.stringify({ id: harnessId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { ok: true, revoked: false }; // 已失效/从未存在：幂等成功
    if (res.status === 401) return { ok: false, reason: 'admin token 被网关拒绝（gateway.json 与运行实例不同源？）' };
    if (!res.ok) return { ok: false, reason: `网关返回 ${res.status}` };
    const j = await res.json().catch(() => null);
    return { ok: true, revoked: j?.revoked === true };
  } catch (e) {
    return { ok: false, reason: `网关不可达：${e?.message ?? e}` };
  }
}

/**
 * 事件流 → 上一次签发且尚未成功吊销的 harness id（接管/孤儿清理路径用）。
 * 找最新一条 harness_provisioned；其后的 harness_revoked 有任一成功记录（ok !== false，
 * 失败的吊销不算——凭据还活着）即视为已吊销返回 null。无签发记录返回 null。
 */
export function findUnrevokedHarnessId(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e?.type !== 'harness_provisioned' || typeof e.harness_id !== 'string' || !e.harness_id) continue;
    const revoked = list
      .slice(i + 1)
      .some((r) => r?.type === 'harness_revoked' && r.harness_id === e.harness_id && r.ok !== false);
    return revoked ? null : e.harness_id;
  }
  return null;
}

/**
 * 一次性凭据并入 worker/reviewer 的 env patch（复用 tierEnvPatch 同形通道）：
 * 只替换 ANTHROPIC_AUTH_TOKEN，不注 base_url——接入目标仍由 ModelDock attach 写好的
 * 客户端配置文件决定，编排器不越权。provision 失败/无 token 时原样返回（fail-open）。
 */
export function applyEphemeralToken(envPatch, provision) {
  if (!provision?.ok || typeof provision.token !== 'string' || !provision.token) return envPatch ?? {};
  return { ...(envPatch ?? {}), ANTHROPIC_AUTH_TOKEN: provision.token };
}

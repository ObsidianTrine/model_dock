// tiers.mjs — 任务等级（tier）→ 凭据/模型解析（纯函数 + 目录校验，测试直连本模块）。
// 设计（2026-10 落地方案）：网关不感知任务难度，选型决策在工作流侧——
//   workflow.json  tiers.<name> = { tokenEnv, workerModel?, reviewModel?, provider?, gatewayBase? }
//   任务卡 frontmatter  tier: <name>（显式点名）
// token 经环境变量注入（机密不入库）；env 未设 → tier 整体不生效回落全局默认
// （显式点名的卡告警，自动升级的卡静默跳过——后者高频，告警会淹日志）。
// 模型名生效优先级：CLI 单次覆盖 > tier.workerModel/reviewModel > workflow.json 全局默认。
// 网关权威校验（2026-11-02 船东授权 admin 面）：workflow.json gatewayAdmin: true 显式开启
// 后，validateTierViaGateway 查 token 真实指向的 profile 与全库 tier 标签——「tier 已打标
// 但 token 指向别档」在派发前拦下；未开启/网关不可得一律回落 advisory，行为不变。
// 零第三方依赖（.agents/ 工具链红线）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hintsOverlap } from '../policy.mjs';

/** files_hint（glob 列表）是否触及核心/发布路径：复用 policy.mjs 的段首相交判定
 *  （src/gateway/** 与 src/gateway/server.ts 首段同为 src → 命中）。 */

// 车钟档位（2026-11-01 船东定名）：tier 四级制 ahead-1..4，文档与日志显示「前进1-4」
// （船钟口径：前进1=慢车最省，前进4=旗舰全速）。旧两级制 heavy/light 是别名，
// 永远兼容（历史卡不返工）：heavy→ahead-4、light→ahead-2。
export const TIER_ALIASES = { heavy: 'ahead-4', light: 'ahead-2' };
export const TIER_DISPLAY = { 'ahead-1': '前进1', 'ahead-2': '前进2', 'ahead-3': '前进3', 'ahead-4': '前进4' };
export const TIER_AUTO_UPGRADE = 'ahead-4'; // 自动升档目标：files_hint 命中核心/发布路径 → 前进4

/** tier 名归一：旧别名 → 车钟档位键；未知名字原样返回（validateCard 的键名规则不变）。 */
export function normalizeTierName(name) {
  const n = String(name ?? '').trim();
  return TIER_ALIASES[n] ?? n;
}

/** tier 显示名（日志/文档用）：ahead-N → 前进N；别名与未知名字一并映射显示。 */
export function tierDisplayName(name) {
  const n = normalizeTierName(name);
  return TIER_DISPLAY[n] ?? n;
}

/**
 * 解析任务的有效 tier。返回：
 *   null                          未配置 tiers / 无卡显式 tier 且不满足自动升级（常见静默路径）
 *   { inactive: 'unconfigured' }  卡显式点名但 workflow.json 无该键（调用方告警）
 *   { inactive: 'token', tokenEnv } tier 已配置但 tokenEnv 环境变量未设（调用方按 auto 决定告警还是静默）
 *   { name, token, tokenEnv, workerModel?, reviewModel?, provider?, gatewayBase?, gatewayAdmin, auto } 生效
 */
export function resolveTier(meta, cfg, env = process.env) {
  const tiers = cfg.tiers ?? {};
  const explicit = typeof meta?.tier === 'string' && meta.tier.trim() ? normalizeTierName(meta.tier) : '';
  let name = explicit;
  let auto = false;
  if (!name) {
    // 规则兜底：只做「升级」方向（files_hint 命中核心/发布路径 → ahead-4/前进4），
    // 不隐式降档——未声明的卡保持全局默认路由，行为不变。
    if (!tiers[TIER_AUTO_UPGRADE] || !hintsOverlap(meta?.files_hint, [...(cfg.corePaths ?? []), ...(cfg.releasePaths ?? [])])) return null;
    name = TIER_AUTO_UPGRADE;
    auto = true;
  }
  const t = tiers[name];
  if (!t) return { inactive: 'unconfigured', name };
  const tokenEnv = typeof t.tokenEnv === 'string' && t.tokenEnv.trim() ? t.tokenEnv.trim() : '';
  const token = tokenEnv ? String(env[tokenEnv] ?? '').trim() : '';
  if (!token) return { inactive: 'token', name, tokenEnv, auto };
  return {
    name,
    token,
    tokenEnv,
    workerModel: t.workerModel ?? null,
    reviewModel: t.reviewModel ?? null,
    provider: t.provider ?? null,
    gatewayBase: t.gatewayBase ?? null,
    gatewayAdmin: cfg?.gatewayAdmin === true,
    auto,
  };
}

/** tier 凭据 → 注入 worker/reviewer 子进程的环境变量补丁。 */
export function tierEnvPatch(tier) {
  return tier?.token ? { ANTHROPIC_AUTH_TOKEN: tier.token } : {};
}

/**
 * 目录校验：GET <gatewayBase>/v1/models?provider=<provider>（Bearer = tier token），
 * 核对模型名在服务目录内——防拼写/下线在派发后才发现。仅 advisory：
 * 网关不可达/超时/404 一律 ok:false 由调用方告警后继续，不用目录故障阻断派发。
 * @returns { ok, reason?, missing? } missing = 请求了但目录里没有的模型名
 */
export async function validateTierModel({ gatewayBase, token, provider, models, timeoutMs = 4000 }) {
  const wanted = (models ?? []).filter(Boolean);
  if (!wanted.length) return { ok: true, missing: [] };
  if (!gatewayBase || !/^https?:\/\//.test(gatewayBase)) return { ok: false, reason: 'tier 未配置 gatewayBase，跳过目录校验' };
  try {
    const res = await fetch(`${gatewayBase.replace(/\/+$/, '')}/v1/models?provider=${encodeURIComponent(provider)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `网关返回 ${res.status}（provider=${provider}）` };
    const j = await res.json();
    const ids = new Set((Array.isArray(j?.data) ? j.data : []).map((m) => m?.id).filter(Boolean));
    const missing = wanted.filter((m) => !ids.has(m));
    return missing.length ? { ok: false, missing, reason: `模型不在服务 ${provider} 目录` } : { ok: true, missing: [] };
  } catch (e) {
    return { ok: false, reason: `目录查询失败：${e?.message ?? e}` };
  }
}

// ---------------------------------------------------------------------------
// 网关权威 tier 校验（admin 面；workflow.json gatewayAdmin: true 显式开启）
// ---------------------------------------------------------------------------

/** 与 tier 名等价的标签集合：网关 profile.tier 标签与 tier 名对表用（别名归一同键——
 *  ahead-4 ≡ heavy，双向等价）。显示名（前进N）不是合法标签名，不收。 */
export function tierTagNames(name) {
  const canonical = normalizeTierName(name);
  const names = new Set([name, canonical]);
  for (const [alias, c] of Object.entries(TIER_ALIASES)) {
    if (c === canonical) names.add(alias);
  }
  return [...names];
}

/** gateway.json 发现（admin token + 端口的同机事实源）：env 重定向优先（测试隔离/多实例），
 *  否则用户 home。文件缺失/损坏/字段不完整返回 null。与 reconcile 读网关日志同一信任域
 *  （同机同用户本地文件），且仅 gatewayAdmin 显式开启后才被调用。 */
export function discoverGatewayState() {
  const envBase = process.env.MODELRDOCK_FAKE_HOME || process.env.MODELRDOCK_HOME;
  const file = envBase ? path.join(envBase, '.modeldock', 'gateway.json') : path.join(os.homedir(), '.modeldock', 'gateway.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isInteger(j?.port) && j.port > 0 && typeof j?.admin_token === 'string' && j.admin_token) {
      return { port: j.port, adminToken: j.admin_token };
    }
  } catch { /* 缺失/损坏 = 未发现 */ }
  return null;
}

/**
 * 网关权威校验：POST <base>/_modeldock/tier-validate（x-modeldock-admin），问网关
 * 「这个 token 现在真实解析到哪个 profile、带什么 tier 标签、全库哪些 profile 已打标」。
 * base 解析序：显式参数 > ORCH_GATEWAY_BASE env > gateway.json 发现（同机事实源）；
 * admin token：显式参数 > ORCH_GATEWAY_ADMIN_TOKEN env > gateway.json。
 * optIn=false（workflow.json 未开 gatewayAdmin）→ 一律 unavailable，不发任何请求——
 * 可移植工具链不得默认读用户 home 下的 ModelDock 状态（与 gatewayLogDir 同一开启哲学）。
 * 网关不可达/超时/401/旧版网关 404 → unavailable（调用方回落 advisory，不阻断派发）。
 * @returns { mode:'gateway', ok:true, harness, profile, provider, tierTag, models, tierProfiles }
 *        | { mode:'gateway', ok:false, reason }   网关给出权威否定（token 未注册等）
 *        | { mode:'unavailable', reason }         观测缺席，非权威结论
 */
export async function validateTierViaGateway({ token, tier, base, adminToken, optIn, timeoutMs = 4000 } = {}) {
  if (!optIn) return { mode: 'unavailable', reason: 'workflow.json 未开启 gatewayAdmin，跳过网关权威校验' };
  if (!token) return { mode: 'unavailable', reason: '无 tier token' };
  let gwBase = base ?? process.env.ORCH_GATEWAY_BASE ?? '';
  let gwAdmin = adminToken ?? process.env.ORCH_GATEWAY_ADMIN_TOKEN ?? '';
  if ((!gwBase || !gwAdmin) && !base && !process.env.ORCH_GATEWAY_BASE) {
    const d = discoverGatewayState();
    if (d) {
      gwBase = gwBase || `http://127.0.0.1:${d.port}`;
      gwAdmin = gwAdmin || d.adminToken;
    }
  }
  if (!gwBase || !/^https?:\/\//.test(gwBase) || !gwAdmin) {
    return { mode: 'unavailable', reason: '未发现网关（gateway.json 缺失或 ORCH_GATEWAY_* 未配置）' };
  }
  try {
    const res = await fetch(`${gwBase.replace(/\/+$/, '')}/_modeldock/tier-validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-modeldock-admin': gwAdmin },
      body: JSON.stringify({ token, ...(tier ? { tier } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { mode: 'unavailable', reason: 'admin token 被网关拒绝（gateway.json 与运行实例不同源？）' };
    if (!res.ok) return { mode: 'unavailable', reason: `网关返回 ${res.status}（旧版网关无此端点时回落 advisory）` };
    const j = await res.json();
    if (!j?.ok) return { mode: 'gateway', ok: false, reason: j?.reason ?? 'unknown_token' };
    return {
      mode: 'gateway',
      ok: true,
      harness: j.harness ?? null,
      profile: j.profile ?? null,
      provider: j.provider ?? null,
      tierTag: j.tier ?? null,
      models: Array.isArray(j.models) ? j.models : [],
      tierProfiles: j.tier_profiles && typeof j.tier_profiles === 'object' ? j.tier_profiles : {},
    };
  } catch (e) {
    return { mode: 'unavailable', reason: `网关查询失败：${e?.message ?? e}` };
  }
}

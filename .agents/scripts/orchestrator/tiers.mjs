// tiers.mjs — 任务等级（tier）→ 凭据/模型解析（纯函数 + 目录校验，测试直连本模块）。
// 设计（2026-10 落地方案）：网关不感知任务难度，选型决策在工作流侧——
//   workflow.json  tiers.<name> = { tokenEnv, workerModel?, reviewModel?, provider?, gatewayBase? }
//   任务卡 frontmatter  tier: <name>（显式点名）
// token 经环境变量注入（机密不入库）；env 未设 → tier 整体不生效回落全局默认
// （显式点名的卡告警，自动升级的卡静默跳过——后者高频，告警会淹日志）。
// 模型名生效优先级：CLI 单次覆盖 > tier.workerModel/reviewModel > workflow.json 全局默认。
// 零第三方依赖（.agents/ 工具链红线）。

import { hintsOverlap } from '../policy.mjs';

/** files_hint（glob 列表）是否触及核心/发布路径：复用 policy.mjs 的段首相交判定
 *  （src/gateway/** 与 src/gateway/server.ts 首段同为 src → 命中）。 */

/**
 * 解析任务的有效 tier。返回：
 *   null                          未配置 tiers / 无卡显式 tier 且不满足自动升级（常见静默路径）
 *   { inactive: 'unconfigured' }  卡显式点名但 workflow.json 无该键（调用方告警）
 *   { inactive: 'token', tokenEnv } tier 已配置但 tokenEnv 环境变量未设（调用方按 auto 决定告警还是静默）
 *   { name, token, tokenEnv, workerModel?, reviewModel?, provider?, gatewayBase?, auto } 生效
 */
export function resolveTier(meta, cfg, env = process.env) {
  const tiers = cfg.tiers ?? {};
  const explicit = typeof meta?.tier === 'string' && meta.tier.trim() ? meta.tier.trim() : '';
  let name = explicit;
  let auto = false;
  if (!name) {
    // 规则兜底：只做「升级」方向（files_hint 命中核心/发布路径 → heavy），
    // 不隐式派 light——未声明的卡保持全局默认路由，行为不变。
    if (!tiers.heavy || !hintsOverlap(meta?.files_hint, [...(cfg.corePaths ?? []), ...(cfg.releasePaths ?? [])])) return null;
    name = 'heavy';
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

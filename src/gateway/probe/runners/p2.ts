// p2.ts — P2 钥匙池审计（provider-probe-suite 任务 4）。
// 逐把展开：resolveProviderKeys 全量解析池 key → 每把一个探针目标（keyIndex + sha256 前 8 位
// 指纹），经引擎对每把各跑一次 P1——P2 的单元判定与 P1 同口径（能精确回显 = 该把 key 的鉴权、
// 路由、推理链路全通），五态归档单一事实源。副作用边界：探针路径经 ForwardOptions.forceKeyIndex
// 直发指定把位，冷却过滤 / 401/403 换 key 重试 / markKeyCooldown 全部绕行——池态（rt.keyPool）
// 不受探针影响，结论只落 rt.probeVerdicts。红线：目标与结论只带指纹（keyFingerprint），明文 key
// 仅在 runP2Audit 内部作为 secrets 传给引擎做错误体脱敏（引擎不持久化、不打印）。

import { providerKeyRefs, resolveProviderKeys } from '../../../config/secrets.js'
import { t } from '../../../util/i18n.js'
import { runProbeSuite } from '../engine.js'
import type { ProbeRunResult, ProbeRunner, ProbeTarget, ProbeTransport, ProbeUnitContext, ProbeUnitOutcome } from '../engine.js'
import { effectiveVerdictState, getProbeVerdict, keyFingerprint } from '../verdict.js'
import { runP1 } from './p1.js'
import type { GatewayRuntime, ProbeVerdictState } from '../../state/types.js'

/** 解析 provider 的整个 key 池（provider 缺失给可操作报错；单个引用不可读按 resolveProviderKeys
 *  既有语义跳过——读不到 ≠ 无效，不做审计结论）。 */
async function resolvePool(rt: GatewayRuntime, providerId: string): Promise<Array<{ index: number; ref: string; key: string }>> {
  const provider = rt.config.providers[providerId]
  if (!provider) {
    throw new Error(t('服务「{id}」不存在，无法审计钥匙池', 'Service "{id}" does not exist; nothing to audit', { id: providerId }))
  }
  const refs = providerKeyRefs(provider)
  const pool = await resolveProviderKeys(refs)
  if (pool.length === 0) {
    throw new Error(
      t('服务「{id}」没有可解析的 key（{n} 个引用全部不可读或未配置）：先 modeldock provider set-key {id} 再审计', 'Service "{id}" has no resolvable keys ({n} references unreadable or unset): run modeldock provider set-key {id} first', { id: providerId, n: String(refs.length) })
    )
  }
  return pool
}

function targetsOfPool(providerId: string, model: string, pool: Array<{ index: number; key: string }>): ProbeTarget[] {
  return pool.map((e) => ({ providerId, model, keyIndex: e.index, keyFp: keyFingerprint(e.key) }))
}

/** 逐把展开 P2 目标：每把可解析的 key 一个引擎单元（keyIndex = 配置 refs 原始位置，keyFp = 指纹）。
 *  供 runProbeSuite 调用方（任务 6 CLI/控制台、测试）构造逐 key 单元——预估、账本、并发闸、
 *  冷却重试都按单元粒度成立（registry P2 requests='per-key' 的展开口径）。 */
export async function planP2Targets(rt: GatewayRuntime, providerId: string, model: string): Promise<ProbeTarget[]> {
  const pool = await resolvePool(rt, providerId)
  return targetsOfPool(providerId, model, pool)
}

/** P2 单元判定：每把 key 即一个 P1 样本。逐把展开不在 runner 内做（planP2Targets×引擎负责），
 *  runner 只回答「这一把 key 通不通」——与 P1 共享同一判定实现，防止两套归档口径漂移。 */
export const runP2: ProbeRunner = (ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> => runP1(ctx)

/** 逐 key 结论行（index + verdict + 状态码）：P2 对外交付的形态。 */
export interface P2KeyAudit {
  index: number
  keyFp: string
  verdict: ProbeVerdictState
  status?: number
  ms?: number
  err?: string
}

export interface P2AuditResult {
  keys: P2KeyAudit[]
  run: ProbeRunResult
}

/** P2 钥匙池审计一站式入口：逐把解析池 key → 每把各跑一次 P1 → 输出逐 key 结论。
 *  被跳过的把位（provider 探针冷却/取消等）按 unverified 列出，不留静默空洞。 */
export async function runP2Audit(
  rt: GatewayRuntime,
  o: { providerId: string; model: string; transport: ProbeTransport; confirmed?: boolean; signal?: AbortSignal }
): Promise<P2AuditResult> {
  const pool = await resolvePool(rt, o.providerId)
  const targets = targetsOfPool(o.providerId, o.model, pool)
  const run = await runProbeSuite(rt, {
    probeIds: ['p2'],
    targets,
    transport: o.transport,
    runner: runP2,
    ...(o.confirmed != null ? { confirmed: o.confirmed } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    // 明文 key 仅作错误体脱敏弹药（401 体可能回显 key）：引擎消费后即弃，不入账本/verdict
    secrets: pool.map((e) => e.key),
  })
  const keys = targets.map((tg, i) => {
    const fp = tg.keyFp ?? ''
    const v = run.verdicts.find((x) => x.keyFp === fp && x.model === o.model) ?? getProbeVerdict(rt, o.providerId, fp, o.model)
    return {
      index: tg.keyIndex ?? i,
      keyFp: fp,
      verdict: v ? effectiveVerdictState(v) : 'unverified' as ProbeVerdictState,
      ...(v?.evidence.status != null ? { status: v.evidence.status } : {}),
      ...(v?.evidence.ms != null ? { ms: v.evidence.ms } : {}),
      ...(v?.evidence.err ? { err: v.evidence.err } : {}),
    }
  })
  return { keys, run }
}

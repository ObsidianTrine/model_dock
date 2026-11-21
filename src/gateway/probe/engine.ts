// engine.ts — 探针执行引擎（provider-probe-suite 任务 1）。
// 职责边界：单元调度（全局并发闸 ≤4 + 同 provider 串行互斥）、四道闸里的两道硬闸（月度预算 /
// 成本确认，预估展示由调用方组装）、429 退避与 provider 探针冷却（负缓存 10 分钟）、AbortSignal
// 取消、逐样本喂 verdict 状态机（jittery 的 3 取中位共识在 verdict 层积累）、账本记账。
// 副作用红线：本模块不 import logRequest / recordOutcome / recordModelFallback——探针调用在
// 请求日志、usageToday、key 冷却标记、熔断计数器里必须零记录（验收断言即差值为 0）。
// 上游调用封装为可注入 transport（生产适配器 relayProbeTransport 为导出桩，任务 3 接线
// forwardToUpstream；测试注入 mock）——这是「探针走 forwardToUpstream 且不调 logRequest」
// 可测的实现方式：副作用面在 server.ts 转发 handler 层，transport 天然不经过它。

import { parseRetryAfterMs } from '../relay.js'
import { t } from '../../util/i18n.js'
import { getProbeDef, probeEstimateTokens } from './registry.js'
import { applyVerdictEvidence, sanitizeErrorSummary, verdictKey } from './verdict.js'
import { probeBudgetTokens, probeMonthKey, probeMonthSpend, readProbeLedger, recordProbeLedgerEntry } from './ledger.js'
import type { GatewayRuntime, ProbeEngineRuntime, ProbeVerdict, ProbeVerdictState } from '../state/types.js'

/** 全局并发闸缺省（[probe].concurrency 的运行时缺省；配置段任务 5 落地） */
export const PROBE_CONCURRENCY_DEFAULT = 2
/** 全局并发闸上限（design：2–4，硬顶 4） */
export const PROBE_CONCURRENCY_MAX = 4
/** provider 探针冷却（429 负缓存）：收到 429 后该 provider 的后续探针跳过 10 分钟 */
export const PROBE_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000
/** Retry-After 退避等待上限：探针非交互可稍长等（relay 转发是 5s），60s 封顶 */
export const PROBE_RETRY_AFTER_MAX_WAIT_MS = 60_000

export interface ProbeTarget {
  providerId: string
  model: string
  /** 池内 key 索引（P2 逐把审计用；轮转主选探针可缺省） */
  keyIndex?: number
  /** 本次调用所用 key 的指纹（sha256 前 8 位 hex，调用方解析 key 后计算）。红线：引擎只收
   *  指纹不收明文；主动探针缺指纹一律拒发（no-key），被动 P15 以 '-' 占位（provider+model 级）。 */
  keyFp?: string
}

export interface ProbeUpstreamRequest {
  providerId: string
  model: string
  keyIndex?: number
  /** 协议路径（生产适配器按 provider.protocol 拼，缺省 P1 形态） */
  path?: string
  body?: unknown
  signal?: AbortSignal
}

export interface ProbeUpstreamResponse {
  status: number
  headers?: Record<string, string | string[] | undefined>
  bodyText?: string
  usage?: Record<string, number>
  ms: number
}

/** 上游调用封装（可注入）：生产实现走 forwardToUpstream（key 注入/代理/三协议免费获得）。 */
export type ProbeTransport = (req: ProbeUpstreamRequest) => Promise<ProbeUpstreamResponse>

export interface ProbeUnitContext {
  rt: GatewayRuntime
  def: import('./registry.js').ProbeDef
  target: ProbeTarget
  transport: ProbeTransport
  signal: AbortSignal | undefined
}

/** 单个探针样本的判定产出。calls 是本样本每次上游调用的记账明细（账本按次落条目）；429 由
 *  runner 标 rateLimited 并透传 Retry-After 原始头值（解析与钳 60s 归引擎，单一口径）。 */
export interface ProbeUnitOutcome {
  state?: ProbeVerdictState
  status?: number
  ms?: number
  /** 原始错误文本（引擎统一过 sanitizeErrorSummary 后入证据） */
  err?: string
  calls?: Array<{ tokens?: number; ms?: number; status?: number }>
  rateLimited?: boolean
  retryAfter?: string | string[]
}

export type ProbeRunner = (ctx: ProbeUnitContext) => Promise<ProbeUnitOutcome>

export interface ProbeRunOptions {
  probeIds: string[]
  targets: ProbeTarget[]
  transport: ProbeTransport
  /** 单样本判定实现（任务 3+ 起由 runners/ 提供；缺省 = 全部 not-implemented 零上游请求） */
  runner?: ProbeRunner
  /** 全局并发闸（1–4，缺省 2；上限硬顶 4） */
  concurrency?: number
  /** 成本确认闸：true 才允许发主动探针（P1–P14）的上游请求；缺省 false = 0 请求返回预估 */
  confirmed?: boolean
  /** 批量任务取消 */
  signal?: AbortSignal
  /** key 明文清单（仅用于错误体脱敏替换，绝不入账本/日志/verdict——引擎不持久化、不打印） */
  secrets?: readonly string[]
}

export type ProbeSkipReason =
  | 'unknown'
  | 'not-implemented'
  | 'no-key'
  | 'budget-exhausted'
  | 'unconfirmed'
  | 'cooldown'
  | 'busy'
  | 'cancelled'

export interface ProbeRunSkip {
  probeId: string
  providerId: string
  model: string
  reason: ProbeSkipReason
  /** 冷却期跳过的目标标 stale（「冷却期内触发直接跳过并把目标标为 stale」） */
  stale?: boolean
}

export interface ProbeRunResult {
  /** false = 被闸拦停（budget-exhausted / unconfirmed）或取消，未完成计划 */
  ok: boolean
  reason?: 'ok' | 'budget-exhausted' | 'unconfirmed' | 'cancelled'
  /** 计划单元数（probeIds × targets 全组合） */
  planned: number
  /** 实际派发执行的单元数 */
  dispatched: number
  /** 实际发出的上游请求数（含 429 退避重试） */
  upstreamRequests: number
  /** 实际记账 tokens */
  tokens: number
  /** 预估 tokens（Σ 单元 请求数×档位上限） */
  estimate: number
  skipped: ProbeRunSkip[]
  /** 本轮触碰过的 verdict（应用后状态） */
  verdicts: ProbeVerdict[]
}

interface ProbeUnit {
  def: import('./registry.js').ProbeDef
  target: ProbeTarget
}

function engineRuntime(rt: GatewayRuntime): ProbeEngineRuntime {
  if (!rt.probeRuntime) rt.probeRuntime = { cooldown: new Map(), inflight: new Set() }
  return rt.probeRuntime
}

/** provider 探针冷却截止（无冷却返回 undefined） */
export function probeCooldownUntil(rt: GatewayRuntime, providerId: string): number | undefined {
  const until = engineRuntime(rt).cooldown.get(providerId)
  if (until == null) return undefined
  if (until <= Date.now()) {
    engineRuntime(rt).cooldown.delete(providerId) // 过期条目顺手清（同 keyInCooldown 惰性清先例）
    return undefined
  }
  return until
}

export function providerProbeInCooldown(rt: GatewayRuntime, providerId: string, now = Date.now()): boolean {
  const until = probeCooldownUntil(rt, providerId)
  return until != null && until > now
}

/** Retry-After 原始头值 → 退避 ms（解析归 relay 的 parseRetryAfterMs 单一口径，钳 60s 上限；
 *  无头/解析不出 = 0 = 不等待直接走冷却） */
export function probeBackoffWaitMs(retryAfter: string | string[] | undefined, now = Date.now()): number {
  const ms = parseRetryAfterMs(retryAfter, now)
  if (ms == null) return 0
  return Math.min(ms, PROBE_RETRY_AFTER_MAX_WAIT_MS)
}

function markProviderCooldown(rt: GatewayRuntime, providerId: string): void {
  engineRuntime(rt).cooldown.set(providerId, Date.now() + PROBE_RATE_LIMIT_COOLDOWN_MS)
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve()
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** 计数信号量：槽位在 pump 内授予（active++ 先于唤醒），杜绝「唤醒与抢占竞态」超限 */
function makeSemaphore(limit: number): { acquire: () => Promise<() => void> } {
  let active = 0
  const queue: Array<() => void> = []
  const pump = (): void => {
    while (active < limit && queue.length > 0) {
      active++
      queue.shift()!()
    }
  }
  return {
    acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        queue.push(() => {
          let done = false
          resolve(() => {
            if (done) return
            done = true
            active--
            pump()
          })
        })
        pump()
      })
    },
  }
}

/** 生产 transport 适配器（任务 3 接线 forwardToUpstream 的导出桩）：显式抛错而非假成功——
 *  静默返回伪响应会伪造健康结论，宁炸勿骗。报错带上请求目标，便于误用点定位。 */
export async function relayProbeTransport(req: ProbeUpstreamRequest): Promise<ProbeUpstreamResponse> {
  throw new Error(
    t(
      '探针生产 transport 尚未实现（目标 {provider} / {path}）：请经 runProbeSuite 的 transport 参数注入实现',
      'Probe production transport is not implemented yet (target {provider} / {path}); inject an implementation via the transport parameter of runProbeSuite',
      { provider: req.providerId, path: req.path ?? '-' }
    )
  )
}

/** 探针套件运行入口：跑 probeIds × targets 全组合。 */
export async function runProbeSuite(rt: GatewayRuntime, opts: ProbeRunOptions): Promise<ProbeRunResult> {
  const skipped: ProbeRunSkip[] = []
  const units: ProbeUnit[] = []
  let planned = 0
  for (const probeId of opts.probeIds) {
    const def = getProbeDef(probeId)
    for (const target of opts.targets) {
      planned++
      const skip = (reason: ProbeSkipReason, stale?: boolean): void => {
        skipped.push({ probeId, providerId: target.providerId, model: target.model, reason, ...(stale ? { stale: true } : {}) })
      }
      if (!def) {
        skip('unknown')
        continue
      }
      if (def.status === 'reserved') {
        skip('not-implemented') // ctx 预留槽位：目录占位，引擎拒绝派发
        continue
      }
      if (def.kind !== 'passive' && !target.keyFp) {
        skip('no-key') // 主动探针必须带 key 指纹（三元组归属 + 账本记账都靠它）
        continue
      }
      units.push({ def, target })
    }
  }

  let estimate = 0
  for (const u of units) estimate += probeEstimateTokens(u.def)
  const hasActive = units.some((u) => u.def.cost !== 'none')

  // 预算闸（先于确认闸——预算是硬停，连预估展示都不必发请求）
  const monthKey = probeMonthKey()
  const budget = probeBudgetTokens(rt)
  let spent = probeMonthSpend(await readProbeLedger(), monthKey)
  const budgetStop = (markAll: boolean): ProbeRunResult => {
    if (markAll) {
      for (const u of units) skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'budget-exhausted' })
    }
    return { ok: false, reason: 'budget-exhausted', planned, dispatched: 0, upstreamRequests: 0, tokens: 0, estimate, skipped, verdicts: [] }
  }
  if (hasActive && spent >= budget) return budgetStop(true)

  // 确认闸：未确认时不发任何主动探针的上游请求（预估随结果返回供调用方回显）
  if (hasActive && opts.confirmed !== true) {
    for (const u of units) skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'unconfirmed' })
    return { ok: false, reason: 'unconfirmed', planned, dispatched: 0, upstreamRequests: 0, tokens: 0, estimate, skipped, verdicts: [] }
  }

  // 冷却过滤（计划期）：429 负缓存中的 provider 直接跳过并标 stale
  const dispatchable: ProbeUnit[] = []
  for (const u of units) {
    if (providerProbeInCooldown(rt, u.target.providerId)) {
      skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'cooldown', stale: true })
      continue
    }
    dispatchable.push(u)
  }

  let dispatched = 0
  let upstreamRequests = 0
  let tokensTotal = 0
  let anyCancelled = false
  let budgetStopped = false
  const touched = new Set<string>()

  if (!opts.runner) {
    // 无 runner（任务 3+ 才有判定实现）：全部记 not-implemented，零上游请求
    for (const u of dispatchable) skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'not-implemented' })
    return { ok: true, reason: 'ok', planned, dispatched: 0, upstreamRequests: 0, tokens: 0, estimate, skipped, verdicts: [] }
  }

  const recordSample = (u: ProbeUnit, o: ProbeUnitOutcome): void => {
    // 账本：每次上游调用一条八字段条目（0 token 调用如 429 也入账留痕——调用发生本身是花费事实）
    for (const c of o.calls ?? []) {
      upstreamRequests++
      tokensTotal += c.tokens ?? 0
      spent += c.tokens ?? 0
      recordProbeLedgerEntry({
        tag: 'probe',
        probe_id: u.def.id,
        provider: u.target.providerId,
        key_fp: u.target.keyFp ?? '-',
        model: u.target.model,
        tokens: c.tokens ?? 0,
        estimated_tokens: u.def.unitTokens,
        ms: c.ms ?? 0,
        ts: new Date().toISOString(),
      })
    }
    const keyFp = u.target.keyFp ?? '-'
    applyVerdictEvidence(rt, {
      provider: u.target.providerId,
      keyFp,
      model: u.target.model,
      source: `probe:${u.def.id}`,
      kind: u.def.kind,
      state: o.state,
      evidence: {
        at: Date.now(),
        ...(o.status != null ? { status: o.status } : {}),
        ...(o.err ? { err: sanitizeErrorSummary(o.err, opts.secrets) } : {}),
        ...(o.ms != null ? { ms: o.ms } : {}),
      },
    })
    touched.add(verdictKey(u.target.providerId, keyFp, u.target.model))
  }

  const runUnit = async (u: ProbeUnit): Promise<void> => {
    const pid = u.target.providerId
    const runtime = engineRuntime(rt)
    if (runtime.inflight.has(pid)) {
      skipped.push({ probeId: u.def.id, providerId: pid, model: u.target.model, reason: 'busy' })
      return
    }
    runtime.inflight.add(pid)
    try {
      const ctx: ProbeUnitContext = { rt, def: u.def, target: u.target, transport: opts.transport, signal: opts.signal }
      const sampleCount = u.def.kind === 'jittery' ? 3 : 1 // 3 取中位共识的采样轮数（共识判定在 verdict 层）
      const runner = opts.runner!
      for (let i = 0; i < sampleCount; i++) {
        if (opts.signal?.aborted) {
          anyCancelled = true
          break
        }
        let o: ProbeUnitOutcome
        try {
          o = await runner(ctx)
        } catch (e) {
          // runner/transport 异常兜底：网络层失败按 unreachable 记证据（分类细则归任务 3 的 P1 runner）
          o = { state: 'unreachable', err: e instanceof Error ? e.message : String(e) }
        }
        if (o.rateLimited) {
          markProviderCooldown(rt, pid)
          recordSample(u, o) // 429 调用本身入账留痕（0 token）+ 记证据（限流是真实发生的事件）
          const wait = probeBackoffWaitMs(o.retryAfter)
          if (wait > 0) await abortableSleep(wait, opts.signal)
          if (opts.signal?.aborted) {
            anyCancelled = true
            break
          }
          let retry: ProbeUnitOutcome
          try {
            retry = await runner(ctx)
          } catch (e) {
            retry = { state: 'unreachable', err: e instanceof Error ? e.message : String(e) }
          }
          if (retry.rateLimited) {
            markProviderCooldown(rt, pid) // 退避重试仍 429：冷却顺延
            recordSample(u, retry)
            break // 仍限流：本单元放弃后续采样（冷却已兜住该 provider 的后续探针）
          }
          o = retry
        }
        recordSample(u, o)
      }
    } finally {
      runtime.inflight.delete(pid)
    }
  }

  // 调度：同 provider 串行链 + 全局信号量（槽位只在单元真正执行时持有）
  const groups = new Map<string, ProbeUnit[]>()
  for (const u of dispatchable) {
    const g = groups.get(u.target.providerId) ?? []
    g.push(u)
    groups.set(u.target.providerId, g)
  }
  const limit = Math.max(1, Math.min(opts.concurrency ?? PROBE_CONCURRENCY_DEFAULT, PROBE_CONCURRENCY_MAX))
  const sem = makeSemaphore(limit)
  const chains: Promise<void>[] = []
  for (const providerUnits of groups.values()) {
    chains.push(
      (async () => {
        for (const u of providerUnits) {
          if (opts.signal?.aborted) {
            skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'cancelled' })
            anyCancelled = true
            continue
          }
          if (providerProbeInCooldown(rt, u.target.providerId)) {
            // 本轮前序单元可能刚因 429 置了冷却：派发前复核，命中即跳过标 stale
            skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'cooldown', stale: true })
            continue
          }
          if (u.def.cost !== 'none' && spent >= budget) {
            skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'budget-exhausted' })
            budgetStopped = true
            continue
          }
          const release = await sem.acquire()
          if (opts.signal?.aborted) {
            release()
            skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'cancelled' })
            anyCancelled = true
            continue
          }
          try {
            dispatched++
            await runUnit(u)
          } finally {
            release()
          }
        }
      })()
    )
  }
  await Promise.all(chains)

  const verdicts = [...touched]
    .map((k) => rt.probeVerdicts?.get(k))
    .filter((v): v is ProbeVerdict => !!v)
  const reason: ProbeRunResult['reason'] = anyCancelled ? 'cancelled' : budgetStopped ? 'budget-exhausted' : 'ok'
  return { ok: reason === 'ok', reason, planned, dispatched, upstreamRequests, tokens: tokensTotal, estimate, skipped, verdicts }
}

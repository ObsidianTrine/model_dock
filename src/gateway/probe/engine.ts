// engine.ts — 探针执行引擎（provider-probe-suite 任务 1）。
// 职责边界：单元调度（全局并发闸 ≤4 + 同 provider 串行互斥）、四道闸里的两道硬闸（月度预算 /
// 成本确认，预估展示由调用方组装）、429 退避与 provider 探针冷却（负缓存 10 分钟）、AbortSignal
// 取消、逐样本喂 verdict 状态机（jittery 的 3 取中位共识在 verdict 层积累）、账本记账。
// 副作用红线：本模块不 import logRequest / recordOutcome / recordModelFallback——探针调用在
// 请求日志、usageToday、key 冷却标记、熔断计数器里必须零记录（验收断言即差值为 0）。
// 上游调用封装为可注入 transport（生产适配器 relayProbeTransport 为导出桩，任务 3 接线
// forwardToUpstream；测试注入 mock）——这是「探针走 forwardToUpstream 且不调 logRequest」
// 可测的实现方式：副作用面在 server.ts 转发 handler 层，transport 天然不经过它。

import { StringDecoder } from 'node:string_decoder'
import { parseRetryAfterMs, forwardToUpstream, readBodyBounded, readUpstreamErrorText, UPSTREAM_ERROR_BODY_MAX_BYTES } from '../relay.js'
import type { UpstreamBody } from '../relay.js'
import { t } from '../../util/i18n.js'
import { providerKeyRefs, resolveProviderKeys } from '../../config/secrets.js'
import { profileRefForProvider } from '../admin-shared.js'
import { getProbeDef, probeEstimateTokens } from './registry.js'
import { probeWire } from './wire.js'
import { applyVerdictEvidence, keyFingerprint, sanitizeErrorSummary, verdictKey } from './verdict.js'
import { probeBudgetTokens, probeMonthKey, probeMonthSpend, readProbeLedger, recordProbeLedgerEntry } from './ledger.js'
import { DEFAULT_PROBE_CONCURRENCY, PROBE_CONCURRENCY_MAX, PROBE_CONCURRENCY_MIN } from '../../config/types.js'
import type { ProbeConfig } from '../../config/types.js'
import type { GatewayRuntime, ProbeEngineRuntime, ProbeVerdict, ProbeVerdictState, ResolvedTarget } from '../state/types.js'

/** 全局并发闸缺省/上限（数值唯一事实来源在 config/types.ts DEFAULT_PROBE_CONCURRENCY / PROBE_CONCURRENCY_MAX，此处保留既有导入路径） */
export const PROBE_CONCURRENCY_DEFAULT = DEFAULT_PROBE_CONCURRENCY
export { PROBE_CONCURRENCY_MAX }
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
  /** 协议路径（runner 经 probeWire 按 provider.protocol 拼；缺席时生产适配器按 P1 形态兜底） */
  path?: string
  body?: Buffer
  signal?: AbortSignal
}

export interface ProbeUpstreamResponse {
  status: number
  headers?: Record<string, string | string[] | undefined>
  bodyText?: string
  usage?: Record<string, number>
  /** mfGate 改写后的最终模型（forwardToUpstream UpstreamResult.modelAfter 透传）：P12 身份
   *  核对的比对基准——响应体 model 字段可能仍是被请求的原文，改写事实只在 modelAfter。 */
  modelAfter?: string
  ms: number
  /** 流式分片到达时刻（每个 SSE data 分片相对请求起点的 elapsed ms，升序）：P3 的 TTFB（首片）
   *  与分片计数的唯一计时事实源——只有传输层能观测逐片到达；非流式/未观测缺席，runner 退回
   *  按 bodyText 的 SSE data 行计数（有计数无计时）。 */
  chunks?: number[]
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
  /** 证据来源短码覆盖：被动探针（P15）标 `passive:<id>`（design 判定规则），缺省 = `probe:<id>` */
  source?: string
  /** advisory 观测（P12 身份核对等）：只挂 verdict 旁注、永不参与翻状态 */
  advisory?: Record<string, unknown>
  /** 本样本无新证据（P15 窗口内零活动等）：跳过证据落账——空刷新会把 freshness 顶新，
   *  架空「7 天无证据转 stale」 */
  noEvidence?: boolean
}

export type ProbeRunner = (ctx: ProbeUnitContext) => Promise<ProbeUnitOutcome>

export interface ProbeRunOptions {
  probeIds: string[]
  targets: ProbeTarget[]
  transport: ProbeTransport
  /** 单样本判定实现（任务 3+ 起由 runners/ 提供；缺省 = 全部 not-implemented 零上游请求） */
  runner?: ProbeRunner
  /** 按探针 id 查判定实现（任务 6 CLI/端点共用形态）：混合清单里未实现 id 记 not-implemented
   *  跳过、其余照常派发——与 runner 二选一，同给时 runnerFor 优先。 */
  runnerFor?: (probeId: string) => ProbeRunner | undefined
  /** 全局并发闸运行级覆盖（不传读 [probe].concurrency，仍缺省 2；上限硬顶 4） */
  concurrency?: number
  /** 成本确认闸：true 才允许发主动探针（P1–P14）的上游请求；缺省 false = 主动 0 请求、被动单元照常派发（与预算闸同族豁免，零上游请求） */
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
  | 'disabled'

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

/** [probe] 段解析视图：全字段带缺省，engine/调度器/CLI（任务 6/13）统一从这读——
 *  不配整段即全缺省（config-gaps「缺省配置下全字段有值」验收的单一锚点）。 */
export function probeConfigView(rt: GatewayRuntime): Required<ProbeConfig> {
  const p = rt.config.probe
  const c = p?.concurrency
  return {
    enabled: p?.enabled !== false,
    concurrency: c != null && Number.isInteger(c) && c >= PROBE_CONCURRENCY_MIN && c <= PROBE_CONCURRENCY_MAX ? c : PROBE_CONCURRENCY_DEFAULT,
    budget_tokens: probeBudgetTokens(rt),
    schedule_hours: p?.schedule_hours ?? [],
    cost_ack: p?.cost_ack === true,
    disabled_ids: p?.disabled_ids ?? [],
    deep_flags: p?.deep_flags ?? [],
  }
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

/** SSE 有界增量读（t15：生产 P3 真 TTFB）：逐网络块解码按行切分，每条非空载 data 行边界记录
 *  一次到达时刻（相对 startMs 的 elapsed ms）。分片行口径与 p3.ts countSseChunks 一致（剔除
 *  [DONE] 与空载行）——transport 观测的分片数与 bodyText 兜底计数才互为对照。StringDecoder
 *  持跨块不完整多字节序列（同 usage tap 先例：直接 toString 会把被块边界截断的中文字符变
 *  替换符，usage 行解析随之失败）。startMs 由调用方回推（Date.now() - up.ms = 请求起点），
 *  401 换 key 重试后锚到的也是真正产出本响应的那次发送。1MB 上限沿用 readBodyBounded 口径
 *  封顶总量（行缓冲是已收字节的后缀，天然被同一上限约束，无需另设行帽）；流中途断掉（含
 *  abort 摧毁连接）保留已读部分不上抛，同 readBodyBounded 语义。 */
async function readSseBounded(
  body: UpstreamBody,
  startMs: number,
  signal: AbortSignal | undefined
): Promise<{ text: string; chunks: number[] }> {
  const chunks: number[] = []
  const decoder = new StringDecoder('utf8')
  let text = ''
  let scanned = 0 // 已按行扫过的字符游标：每块只扫新增段，不整串重扫
  const feedLine = (line: string): void => {
    const s = line.trim()
    if (!s.startsWith('data:')) return
    const payload = s.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    chunks.push(Math.max(0, Date.now() - startMs))
  }
  const drain = (): void => {
    for (let idx = text.indexOf('\n', scanned); idx >= 0; idx = text.indexOf('\n', scanned)) {
      feedLine(text.slice(scanned, idx))
      scanned = idx + 1
    }
  }
  try {
    let total = 0
    for await (const c of body as unknown as AsyncIterable<unknown>) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c as string)
      total += b.length
      text += decoder.write(b)
      drain()
      if (signal?.aborted || total >= UPSTREAM_ERROR_BODY_MAX_BYTES) break
    }
  } catch {
    /* 流中途断掉：保留已读部分 */
  }
  text += decoder.end()
  drain()
  feedLine(text.slice(scanned)) // 末尾无换行的残行也计（与 countSseChunks 的 split('\n') 口径一致）
  return { text, chunks }
}

/** 生产 transport 适配器（任务 3 接线）：走 forwardToUpstream——key 注入 / 代理 / 三协议 / 池解析
 *  免费获得，且天然不调 logRequest（落账面在 server.ts 转发 handler 层，探针不经过它）。
 *  错误语义：本地跳过（key 池空/全冷却/端点缺失）与网络失败按 UpstreamError/普通异常抛出，
 *  runner 归档 unreachable——静默转伪响应会伪造健康结论，宁炸勿骗。runner 自带 path/body 时
 *  原样使用（P1/P12 经 probeWire 拼装），缺席按 provider 协议拼 P1 形态兜底。 */
export function makeRelayProbeTransport(
  rt: GatewayRuntime,
  o: { idleTimeoutMs?: number; retries?: number } = {}
): ProbeTransport {
  const idle = o.idleTimeoutMs ?? 10 * 60_000
  const retries = o.retries ?? 1
  return async (req: ProbeUpstreamRequest): Promise<ProbeUpstreamResponse> => {
    const provider = rt.config.providers[req.providerId]
    if (!provider) {
      throw new Error(t('服务「{id}」不存在，无法探测', 'Service "{id}" does not exist; nothing to probe', { id: req.providerId }))
    }
    // 假 profile 直探（同 server.ts hTest 按 provider 探测的构造）：探针不依赖任何已配路由
    const model = req.model || Object.keys(provider.models ?? {})[0] || ''
    const fakeProfile = { name: `probe-${req.providerId}`, provider: req.providerId, default_model: model }
    const target: ResolvedTarget = { harness: 'admin-test', profileName: fakeProfile.name, profile: fakeProfile, provider }
    const path = req.path ?? probeWire(provider.protocol, model).path
    const body = req.body ?? probeWire(provider.protocol, model).body
    const up = await forwardToUpstream(rt, target, {
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
      body,
      idleTimeoutMs: idle,
      retries,
      // 探针路径恒禁 mfGate（design 方案 3）：熔断中模型按原模型直发、零熔断计数——探测对象
      // 就是被点名的模型本身
      skipModelFallbackGate: true,
      // 探针路径恒豁免 key 冷却打标（t4b，与任务 4 的 forced 豁免合流）：P1/P12 非 forced
      // 直发遇上游 401/403 时不得 markKeyCooldown——探死 key 是观测，池态零扰动（冷却中的
      // key 会被 healthy 过滤，打了标 P2 复审就看不到刚探死的把位）
      skipKeyCooldownMark: true,
      // P2 逐把审计（design 方案 3）：req.keyIndex 缺省 undefined = 轮转主选路径（P1/P12 单 key 探针）
      ...(req.keyIndex != null ? { forceKeyIndex: req.keyIndex } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    })
    // 有界读（同 server.ts probe()）：错误体经 readUpstreamErrorText 按 content-encoding 解压，
    // 成功体直接读——探针只取回复文本/usage，1MB 上限防异常上游的超大 body 进堆。
    // SSE 成功体（P3 流式探针，t15）改走增量读逐 data 行记录到达时刻（chunks）：TTFB 只有
    // 传输层能测，整包读会把它退化成调用总耗时。非流式与 ≥400 路径逐字节保持原样
    const rawCt = up.headers['content-type'] ?? up.headers['Content-Type']
    const isSse = /text\/event-stream/i.test((Array.isArray(rawCt) ? rawCt[0] : rawCt) ?? '')
    let chunks: number[] | undefined
    let text: string
    if (up.status >= 400) {
      text = await readUpstreamErrorText(up.headers, up.body)
    } else if (isSse) {
      const r = await readSseBounded(up.body, Date.now() - up.ms, req.signal)
      text = r.text
      chunks = r.chunks
    } else {
      text = (await readBodyBounded(up.body, UPSTREAM_ERROR_BODY_MAX_BYTES)).toString('utf8')
    }
    let usage: Record<string, number> | undefined
    try {
      const u = (JSON.parse(text) as { usage?: unknown })?.usage
      if (u && typeof u === 'object') {
        usage = {}
        for (const [k, v] of Object.entries(u as Record<string, unknown>)) {
          if (typeof v === 'number') usage[k] = v
        }
      }
    } catch {
      /* SSE 或非 JSON：usage 缺席仅观测降级 */
    }
    return {
      status: up.status,
      headers: up.headers,
      bodyText: text,
      usage,
      modelAfter: up.modelAfter,
      ms: up.ms,
      ...(chunks != null ? { chunks } : {}),
    }
  }
}

/** 探针套件运行入口：跑 probeIds × targets 全组合。 */
export async function runProbeSuite(rt: GatewayRuntime, opts: ProbeRunOptions): Promise<ProbeRunResult> {
  const skipped: ProbeRunSkip[] = []
  let units: ProbeUnit[] = []
  let planned = 0
  const pcfg = probeConfigView(rt)
  for (const probeId of opts.probeIds) {
    const def = getProbeDef(probeId)
    for (const target of opts.targets) {
      planned++
      const skip = (reason: ProbeSkipReason, stale?: boolean): void => {
        skipped.push({ probeId, providerId: target.providerId, model: target.model, reason, ...(stale ? { stale: true } : {}) })
      }
      if (!pcfg.enabled) {
        skip('disabled') // 总开关（[probe].enabled=false）：整轮拒发（含 P15 被动聚合），零上游请求
        continue
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

  let dispatched = 0
  let upstreamRequests = 0
  let tokensTotal = 0
  let anyCancelled = false
  let budgetStopped = false
  let confirmStopped = false
  const touched = new Set<string>()

  // 预算闸（先于确认闸——预算是硬停，连预估展示都不必发请求）。只拦主动探针：
  // schedule.ts 触发口径明文「预算闸拦的是主动探针」（被动观测断了会架空 7 天转 stale）、
  // 冷却过滤豁免被动（同理由）、逐单元闸只对 cost !== 'none' 查账——三处既有口径一致，
  // 唯计划级初闸曾一刀切把混合清单的被动单元也标 budget-exhausted 漏刷被动证据。
  // 预算耗尽时主动单元拦下、被动单元照常走派发管线；过滤后无剩余可跑单元才整轮早退
  const monthKey = probeMonthKey()
  const budget = probeBudgetTokens(rt)
  let spent = probeMonthSpend(await readProbeLedger(), monthKey)
  if (hasActive && spent >= budget) {
    const blocked = units.filter((u) => u.def.cost !== 'none')
    units = units.filter((u) => u.def.cost === 'none')
    for (const u of blocked) skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'budget-exhausted' })
    if (units.length === 0) {
      return { ok: false, reason: 'budget-exhausted', planned, dispatched: 0, upstreamRequests: 0, tokens: 0, estimate, skipped, verdicts: [] }
    }
    budgetStopped = true // 与逐单元闸同口径：任一主动单元因预算被拦 → 整轮 reason 带 budget-exhausted
  }

  // 确认闸：未确认时不发任何主动探针的上游请求（预估随结果返回供调用方回显）。只拦主动单元：
  // 被动单元零上游请求（p15 runner calls 恒空、transport 不触），不属「防误烧钱」确认面——
  // 与预算闸 d47d8f2 同族口径：主动拦下标 unconfirmed、被动照常走派发管线刷证据；过滤后
  // 无剩余可跑单元才整轮早退。对过滤后的 units 重判有无主动（预算闸先行拦走主动时不再误标）
  if (opts.confirmed !== true && units.some((u) => u.def.cost !== 'none')) {
    const blocked = units.filter((u) => u.def.cost !== 'none')
    units = units.filter((u) => u.def.cost === 'none')
    for (const u of blocked) skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'unconfirmed' })
    confirmStopped = true // 与预算闸 budgetStopped 同型：任一主动单元被确认闸拦 → 整轮 reason 带 unconfirmed
    if (units.length === 0) {
      return { ok: false, reason: 'unconfirmed', planned, dispatched: 0, upstreamRequests: 0, tokens: 0, estimate, skipped, verdicts: [] }
    }
  }

  // 冷却过滤（计划期）：429 负缓存中的 provider 直接跳过并标 stale。被动探针（P15）豁免——
  // 零上游请求，不存在限流风险，被主动探针的冷却连带停掉会漏被动证据
  const dispatchable: ProbeUnit[] = []
  for (const u of units) {
    if (u.def.kind !== 'passive' && providerProbeInCooldown(rt, u.target.providerId)) {
      skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'cooldown', stale: true })
      continue
    }
    dispatchable.push(u)
  }

  if (!opts.runner && !opts.runnerFor) {
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
    if (o.noEvidence) return // 无新证据样本（被动窗口零活动）：不落证据不碰 freshness
    const keyFp = u.target.keyFp ?? '-'
    applyVerdictEvidence(rt, {
      provider: u.target.providerId,
      keyFp,
      model: u.target.model,
      source: o.source ?? `probe:${u.def.id}`,
      kind: u.def.kind,
      state: o.state,
      evidence: {
        at: Date.now(),
        ...(o.status != null ? { status: o.status } : {}),
        ...(o.err ? { err: sanitizeErrorSummary(o.err, opts.secrets) } : {}),
        ...(o.ms != null ? { ms: o.ms } : {}),
      },
      ...(o.advisory ? { advisory: o.advisory } : {}),
    })
    touched.add(verdictKey(u.target.providerId, keyFp, u.target.model))
  }

  const runUnit = async (u: ProbeUnit, runner: ProbeRunner): Promise<void> => {
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
  const limit = Math.max(1, Math.min(opts.concurrency ?? pcfg.concurrency, PROBE_CONCURRENCY_MAX))
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
          if (u.def.kind !== 'passive' && providerProbeInCooldown(rt, u.target.providerId)) {
            // 本轮前序单元可能刚因 429 置了冷却：派发前复核，命中即跳过标 stale（被动探针豁免同计划期）
            skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'cooldown', stale: true })
            continue
          }
          if (u.def.cost !== 'none' && spent >= budget) {
            skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'budget-exhausted' })
            budgetStopped = true
            continue
          }
          // runner 计划期解析（runnerFor 优先）：未实现 id 记 not-implemented 跳过、零上游请求——
          // 在 inflight/dispatched 之前拦下，计数不掺水（与上方无 runner 的整轮兜底同口径）
          const unitRunner = opts.runnerFor ? opts.runnerFor(u.def.id) : opts.runner
          if (!unitRunner) {
            skipped.push({ probeId: u.def.id, providerId: u.target.providerId, model: u.target.model, reason: 'not-implemented' })
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
            await runUnit(u, unitRunner)
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
  const reason: ProbeRunResult['reason'] = anyCancelled ? 'cancelled' : confirmStopped ? 'unconfirmed' : budgetStopped ? 'budget-exhausted' : 'ok'
  return { ok: reason === 'ok', reason, planned, dispatched, upstreamRequests, tokens: tokensTotal, estimate, skipped, verdicts }
}

// ===== 探测计划（任务 6：CLI provider test 与 POST /_modeldock/probe/run 共用）=====

/** 一次探测的计划：目标展开 + 逐探针预估。目标是 (provider, key 指纹, model) 三元组——
 *  verdict 归属与账本记账都靠它，key 明文只出现在 secrets（错误体脱敏用），绝不入计划回显面。 */
export interface ProbePlan {
  providerId: string
  /** 目标模型（resolveProbeModel 解析：probe_model 指定 > 服务默认模型 > 目录首项；空目录 = 空串，
   *  transport 侧按 provider 协议兜底拼装） */
  model: string
  /** 池内可解析 key 的指纹清单（sha256 前 8 位；绝不含明文） */
  keys: Array<{ index: number; fp: string }>
  probeIds: string[]
  /** 每探针的目标展开（per-key 探针逐把 key 一目标，其余取主 key 一目标） */
  units: Array<{ probeId: string; target: ProbeTarget }>
  /** 计划单元数（probeIds × targets 全组合） */
  planned: number
  /** 预估 tokens 合计（Σ 单元 档位上限×请求基数；请求级实际用量以账本为准） */
  estimate: number
  /** 逐探针预估 tokens（CLI --json 的 per_probe_cost 字段与端点预估回显共用此键） */
  perProbeCost: Record<string, number>
  /** key 明文清单（仅传 runProbeSuite secrets 做错误体脱敏；不落盘、不打印） */
  secrets: string[]
}

/** 探针代表模型解析（probe-model-select）：provider.probe_model 显式指定（须在该服务模型表
 *  内，非法回落，config.toml 手编错值不炸）> 服务默认模型（引用该服务的 profile 的
 *  default_model，与服务卡「默认 X」同口径——探针回答「这个服务活着吗」，打真实流量用的模型
 *  最有代表性）> 模型表第一个（无 profile/未设 default_model 的兜底）。手动诊断（buildProbePlan）、
 *  周期调度与被动聚合（schedule targets）、overview 投影统一从这里取，防口径漂移。 */
export function resolveProbeModel(cfg: GatewayRuntime['config'], providerId: string): string {
  const p = cfg.providers[providerId]
  if (!p) return ''
  const ids = Object.keys(p.models ?? {})
  if (!ids.length) return ''
  const probeModel = String(p.probe_model ?? '').trim()
  if (probeModel && ids.includes(probeModel)) return probeModel
  const ref = profileRefForProvider(cfg, providerId)
  const dm = ref ? cfg.profiles[ref]?.default_model : undefined
  if (dm && ids.includes(dm)) return dm
  return ids[0]
}

/** 展开 provider 的探测计划：模型取 resolveProbeModel（probe_model 指定 > 服务默认模型 >
 *  目录首项）；per-key 探针（P2）按池内每把可解析 key 各一目标（keyIndex 保留原始池位），
 *  其余探针取主 key 一目标。无 runner 校验在这里不做——派发期由 runnerFor 按目录记
 *  not-implemented，预估展示因此可以覆盖未实现探针（先见成本、后见跳过）。 */
export async function buildProbePlan(
  rt: GatewayRuntime,
  providerId: string,
  probeIds: readonly string[]
): Promise<ProbePlan> {
  const provider = rt.config.providers[providerId]
  if (!provider) {
    throw new Error(t('服务「{id}」不存在，无法探测', 'Service "{id}" does not exist; nothing to probe', { id: providerId }))
  }
  const model = resolveProbeModel(rt.config, providerId)
  const keys = await resolveProviderKeys(providerKeyRefs(provider))
  const fps = keys.map((k) => ({ index: k.index, fp: keyFingerprint(k.key) }))
  const units: ProbePlan['units'] = []
  const perProbeCost: Record<string, number> = {}
  for (const probeId of probeIds) {
    const def = getProbeDef(probeId)
    if (!def) continue // 未知 id 由调用方在参数校验层给出可操作报错，这里静默不展开
    const targets: ProbeTarget[] =
      def.requests === 'per-key'
        ? keys.map((k) => ({ providerId, model, keyIndex: k.index, keyFp: keyFingerprint(k.key) }))
        : keys.length > 0
          ? [{ providerId, model, keyIndex: keys[0].index, keyFp: keyFingerprint(keys[0].key) }]
          : []
    for (const target of targets) units.push({ probeId, target })
    perProbeCost[probeId] = targets.length * probeEstimateTokens(def)
  }
  let estimate = 0
  for (const v of Object.values(perProbeCost)) estimate += v
  return {
    providerId,
    model,
    keys: fps,
    probeIds: [...probeIds],
    units,
    planned: units.length,
    estimate,
    perProbeCost,
    secrets: keys.map((k) => k.key),
  }
}

// verdict.ts — 探针三元组 verdict 状态机 + 按天 JSONL 落盘与回放（provider-probe-suite 任务 1）。
// 结论记在 (provider, key 指纹, model) 三元组上：热态常驻 rt.probeVerdicts（Map，对齐
// rt.modelProbe/rt.keyPool 先例），同时 append-only 落 probe-<date>.jsonl——重启后回放重建热态
// （JSONL 是唯一事实源，热态只是缓存）。canary/passive 单次证据即定状态；jittery（P10/P12/P13/P14）
// 冲突样本进 pending 缓冲，3 取中位（多数派 ≥2）共识后才翻状态，冲突期间维持原状态并把冲突
// 证据标 unverified——单次抖动不武断翻脸，是「结论分档不武断」需求的直接落地。
// 写盘只走 state/logs.appendLog（util/fsx 常驻流池），禁自写 fs 写路径。

import fs from 'node:fs'
import path from 'node:path'
import { logsDir } from '../../util/paths.js'
import { localDateStr, localIsoTs } from '../../util/time.js'
import { sha256 } from '../../util/fsx.js'
import { appendLog } from '../state/logs.js'
import { closeAppendStream } from '../../util/fsx.js'
import type { GatewayRuntime, ProbeCapabilityRecord, ProbeEvidence, ProbePendingSample, ProbeVerdict, ProbeVerdictState } from '../state/types.js'

/** 三元组键分隔符：NUL 与 modelHealth 同款（provider/model 不含 NUL，指纹是 hex） */
const KEY_SEP = '\u0000'

/** 7 天无任何新证据（主动探针或被动信号）转 stale */
export const PROBE_VERDICT_STALE_MS = 7 * 86_400_000

/** 错误体摘要上限（字符）：design 溯源五件套硬约束 */
export const PROBE_ERR_SUMMARY_MAX = 400

/** jittery 共识样本数：3 取中位（多数派 ≥2 翻状态） */
export const PROBE_JITTERY_CONSENSUS_SAMPLES = 3

const VERDICT_STATES: readonly ProbeVerdictState[] = ['healthy', 'degraded', 'quota', 'auth-dead', 'unreachable', 'unverified', 'stale']

/** key 指纹：sha256 前 8 位十六进制。红线：指纹之外绝不输出 key 明文（对齐 keyPoolHealthView）。 */
export function keyFingerprint(key: string): string {
  return sha256(key).slice(0, 8)
}

export function verdictKey(provider: string, keyFp: string, model: string): string {
  return `${provider}${KEY_SEP}${keyFp}${KEY_SEP}${model}`
}

/** 由三元组键反解 provider（reload 清理按 provider 删条目用） */
export function verdictKeyProvider(key: string): string {
  return key.slice(0, key.indexOf(KEY_SEP))
}

function verdictStore(rt: GatewayRuntime): Map<string, ProbeVerdict> {
  if (!rt.probeVerdicts) rt.probeVerdicts = new Map() // 兜底手搭 rt（同 modelprobe 先例）
  return rt.probeVerdicts
}

export function getProbeVerdict(rt: GatewayRuntime, provider: string, keyFp: string, model: string): ProbeVerdict | undefined {
  return verdictStore(rt).get(verdictKey(provider, keyFp, model))
}

/** 读面状态：证据超 7 天未刷新即视为 stale（不依赖清扫任务执行；清扫只是把翻转固化进 JSONL） */
export function effectiveVerdictState(v: ProbeVerdict, now = Date.now()): ProbeVerdictState {
  if (v.state === 'stale') return 'stale'
  if (now - v.evidence.at > PROBE_VERDICT_STALE_MS) return 'stale'
  return v.state
}

/** verdict 视图（任务 6：CLI provider test --json 与 GET /_modeldock/probe/verdicts 共用 JSON 形态）。
 *  state 取读面状态（freshness 兜底）；key 只出指纹；pending 不出（进程内瞬态采样缓冲，无跨进程意义）。 */
export function probeVerdictView(v: ProbeVerdict): {
  provider: string
  key_fp: string
  model: string
  state: ProbeVerdictState
  evidence: ProbeEvidence
  advisory?: Record<string, unknown>
} {
  const base = { provider: v.provider, key_fp: v.keyFp, model: v.model, state: effectiveVerdictState(v), evidence: v.evidence }
  return v.advisory ? { ...base, advisory: v.advisory } : base
}

/** 能力实证探针 → capabilities 标记（design 方案 6：探针结论只写 upstream 采集层）。
 *  标记口径与预设库 capabilities 对齐（vision/tools/reasoning 既有值），json/stream 为 P6/P3 新词。 */
const CAPABILITY_PROBES: Record<string, string> = { p3: 'stream', p4: 'vision', p5: 'tools', p6: 'json', p7: 'reasoning' }

/** 能力探针样本落记录：healthy/degraded 结论按标记累积进 verdict.capabilities（多探针独立并存，
 *  同标记新证据覆盖旧证据）；其余状态（unreachable/quota/auth-dead/unverified）不发明能力结论 */
function mergeCapabilityRecord(target: ProbeVerdict, source: string, state: ProbeVerdictState | undefined, at: number): void {
  if (!source.startsWith('probe:')) return
  const token = CAPABILITY_PROBES[source.slice('probe:'.length)]
  if (!token || (state !== 'healthy' && state !== 'degraded')) return
  target.capabilities = { ...(target.capabilities ?? {}), [token]: { ok: state === 'healthy', at } }
}

/** 能力记录合并（回放/多来源聚合）：逐标记取证据更新者——不同探针的结论并存，同探针新测量胜出 */
function mergeCapabilityRecords(
  a: ProbeVerdict['capabilities'] | undefined,
  b: ProbeVerdict['capabilities'] | undefined
): ProbeVerdict['capabilities'] | undefined {
  if (!a) return b
  if (!b) return a
  const out: Record<string, ProbeCapabilityRecord> = { ...a }
  for (const [token, rec] of Object.entries(b)) {
    if (!out[token] || rec.at > out[token].at) out[token] = rec
  }
  return out
}

/** 探针实测能力视图：capabilities 三态链的探针层素材 + 徽标「实测」态的时间戳 */
export interface ProbeCapabilityView {
  capabilities: string[]
  /** 最新一次能力实证证据时间（epoch ms） */
  at: number
}

/** 从 rt.probeVerdicts 派生 (provider, model) 的探针实测能力（任务 10：resolveModelMeta 探针层素材）。
 *  结论读 verdict.capabilities 按 (provider, model) 聚合（多把 key 各有三元组 verdict，逐标记取最新）；
 *  记录超 7 天保鲜期视为弃权（实测结论同样过期，回落目录态）。
 *  表态门只认 vision：链上 capabilities 的 [] 语义与全部消费方都只看 vision——vision 未实测时返回
 *  undefined，探针层不得替 vision 发明表态（否则 P6 单独通过就会把内置表的 vision 短路掉）；
 *  门开时其余实测拥有的标记并进列表，实测无（ok=false）只减不加。 */
export function probeCapabilityView(rt: GatewayRuntime, provider: string, model: string, now = Date.now()): ProbeCapabilityView | undefined {
  const store = rt.probeVerdicts
  if (!store || store.size === 0) return undefined
  const latest = new Map<string, ProbeCapabilityRecord>()
  for (const v of store.values()) {
    if (v.provider !== provider || v.model !== model || !v.capabilities) continue
    for (const [token, rec] of Object.entries(v.capabilities)) {
      if (now - rec.at > PROBE_VERDICT_STALE_MS) continue
      const prev = latest.get(token)
      if (!prev || rec.at > prev.at) latest.set(token, rec)
    }
  }
  const vision = latest.get('vision')
  if (!vision) return undefined
  const caps = new Set<string>()
  if (vision.ok) caps.add('vision')
  let at = vision.at
  for (const [token, rec] of latest) {
    if (token === 'vision') continue
    if (rec.ok) caps.add(token)
    if (rec.at > at) at = rec.at
  }
  return { capabilities: [...caps].sort(), at }
}

/** 脱敏错误体摘要：取首行 → 剥离 key 明文（先替换后截断，防截断边界把 key 切半漏脱敏）→
 *  ≤400 字符。secrets 传本次调用涉及的 key 明文（可多把）；短于 8 字符的串不替换（过短会误伤正文）。 */
export function sanitizeErrorSummary(text: string, secrets?: readonly (string | undefined)[]): string {
  let s = String(text ?? '')
  const nl = s.indexOf('\n')
  if (nl >= 0) s = s.slice(0, nl)
  for (const sec of secrets ?? []) {
    if (sec && sec.length >= 8) s = s.split(sec).join('[redacted]')
  }
  if (s.length > PROBE_ERR_SUMMARY_MAX) s = s.slice(0, PROBE_ERR_SUMMARY_MAX)
  return s
}

export interface ProbeVerdictInput {
  provider: string
  keyFp: string
  model: string
  /** 证据来源短码：`probe:<id>`（主动探针）/ `passive:<id>`（被动信号） */
  source: string
  kind: 'canary' | 'jittery' | 'passive'
  /** 本样本主张的状态；undefined = advisory/不确定（只记证据，不参与翻状态） */
  state?: ProbeVerdictState
  /** 证据本体（at/status/ms/err；source 由本函数按 input.source 统一盖戳） */
  evidence: Omit<ProbeEvidence, 'source'>
  /** advisory 观测旁注（P12 身份核对等）：挂在 verdict 上供人复核，永不参与翻状态 */
  advisory?: Record<string, unknown>
}

/** 证据落状态机：单一样本入口（引擎逐样本调用；jittery 的 3 取中位共识在本函数内积累）。 */
export function applyVerdictEvidence(rt: GatewayRuntime, input: ProbeVerdictInput): ProbeVerdict {
  const store = verdictStore(rt)
  const key = verdictKey(input.provider, input.keyFp, input.model)
  const prev = store.get(key)
  const ev: ProbeEvidence = { ...input.evidence, source: input.source }
  if (!prev) {
    const v: ProbeVerdict = { provider: input.provider, keyFp: input.keyFp, model: input.model, state: 'unverified', evidence: ev }
    if (input.kind === 'jittery') {
      // 首样本不立状态：jittery 未达共识前一律 unverified（防止一次抖动直接定健康/判死）
      v.evidence = { ...ev, unverified: true }
      v.pending = [{ state: input.state ?? 'unverified', evidence: v.evidence }]
    } else if (input.state) {
      v.state = input.state
    }
    if (input.advisory) v.advisory = input.advisory
    mergeCapabilityRecord(v, input.source, input.state, ev.at)
    store.set(key, v)
    appendVerdictJsonl(v)
    return v
  }
  if (input.kind === 'jittery' && input.state && input.state !== prev.state) {
    // 冲突样本：维持原状态、证据标 unverified、入缓冲等共识（缓冲存未打标的干净证据——
    // 共识翻转后取胜出样本的原证据，不带 unverified 残留）
    prev.evidence = { ...ev, unverified: true }
    const pending: ProbePendingSample[] = [...(prev.pending ?? []), { state: input.state, evidence: ev }]
    if (pending.length >= PROBE_JITTERY_CONSENSUS_SAMPLES) {
      const counts = new Map<ProbeVerdictState, number>()
      for (const p of pending) counts.set(p.state, (counts.get(p.state) ?? 0) + 1)
      let majority: ProbeVerdictState | undefined
      for (const [st, n] of counts) if (n * 2 > pending.length) majority = st
      if (majority) {
        const win = pending.find((p) => p.state === majority)!
        prev.state = majority
        prev.evidence = win.evidence
      }
      // 三样本各不相同（无多数派）：不翻状态；冲突缓冲清零重启计数，unverified 证据保留供人复核
      prev.pending = undefined
    } else {
      prev.pending = pending
    }
    if (input.advisory) prev.advisory = input.advisory
    appendVerdictJsonl(prev)
    return prev
  }
  // 一致样本 / advisory 样本：刷新证据时间戳（freshness），jittery 一致即冲突解除、缓冲清零
  prev.evidence = ev
  if (input.advisory) prev.advisory = input.advisory
  mergeCapabilityRecord(prev, input.source, input.state, ev.at)
  if (input.kind === 'jittery') prev.pending = undefined
  // canary/passive 单次判定：新样本状态即权威（probe 结论就是结论，后续样本直接覆盖旧状态）；
  // jittery 走上面的共识分支，此处只在解除 stale 时立状态（可判定立新状态，advisory 回 unverified）
  if (input.kind === 'jittery') {
    if (prev.state === 'stale') prev.state = input.state ?? 'unverified'
  } else if (input.state) {
    prev.state = input.state
  }
  appendVerdictJsonl(prev)
  return prev
}

/** 7 天无新证据的三元组翻 stale（每日维护/回放后调用；翻转落 JSONL 进趋势时间线）。
 *  证据 at 不动——stale 本就由证据年龄判定，改 at 会自解 stale。返回翻转数。 */
export function sweepStaleVerdicts(rt: GatewayRuntime, now = Date.now()): number {
  const store = verdictStore(rt)
  let n = 0
  for (const v of store.values()) {
    if (v.state === 'stale') continue
    if (now - v.evidence.at > PROBE_VERDICT_STALE_MS) {
      v.state = 'stale'
      appendVerdictJsonl(v)
      n++
    }
  }
  return n
}

/** 换 key 销账（2026-11-26 用户实证：key 出 401 → 换 key 重测健康，旧 key 名下的 auth-dead
 *  仍压徽标）：provider 存活但其 verdict 记在「已不在当前 key 集合」的真实指纹上 → 结论失去
 *  主体，热态随之删除。'-' 占位（被动 P15 provider 级）不在此列——它不属于任何 key，展示层由
 *  「真实指纹更新证据让位」规则处理（ui probe badgePool）。JSONL 落盘历史不删，趋势时间线仍可回溯。
 *  liveFps 为空集时直接跳过（区别不了「真没 key」与「keychain 暂时不可读」，宁保留勿误删）。
 *  调用时机 = buildProbePlan（该处已解析当前 key 池，零额外 secrets 读）。返回删除数。 */
export function pruneOrphanKeyVerdicts(rt: GatewayRuntime, providerId: string, liveFps: ReadonlySet<string>): number {
  const store = rt.probeVerdicts
  if (!store || store.size === 0 || liveFps.size === 0) return 0
  const prefix = providerId + KEY_SEP
  let n = 0
  for (const key of [...store.keys()]) {
    if (!key.startsWith(prefix)) continue
    const fp = key.slice(prefix.length).split(KEY_SEP)[0] ?? ''
    if (fp && fp !== '-' && !liveFps.has(fp)) {
      store.delete(key)
      n++
    }
  }
  return n
}

const VERDICT_FILE_PREFIX = 'probe-'
const VERDICT_FILE_RE = /^probe-(\d{4}-\d{2}-\d{2})\.jsonl$/

/** verdict 落盘条目（probe-<date>.jsonl 一行一证据；日期取证据本地时间） */
function appendVerdictJsonl(v: ProbeVerdict): void {
  const at = v.evidence.at
  const entry = {
    kind: 'probe-verdict',
    ts: localIsoTs(new Date(at)),
    provider: v.provider,
    key_fp: v.keyFp,
    model: v.model,
    state: v.state,
    source: v.evidence.source,
    at: new Date(at).toISOString(),
    ...(v.evidence.status != null ? { status: v.evidence.status } : {}),
    ...(v.evidence.err ? { err: v.evidence.err } : {}),
    ...(v.evidence.ms != null ? { ms: v.evidence.ms } : {}),
    ...(v.evidence.unverified ? { unverified: true } : {}),
    ...(v.advisory ? { advisory: v.advisory } : {}),
    ...(v.capabilities ? { capabilities: v.capabilities } : {}),
  }
  appendLog(`${VERDICT_FILE_PREFIX}${localDateStr(new Date(at))}.jsonl`, JSON.stringify(entry) + '\n')
}

/** 能力记录坏值过滤（回放容错）：只收 {ok:boolean, at:有限数} 的标记条目 */
function capabilityRecordsFromJsonl(e: unknown): ProbeVerdict['capabilities'] | undefined {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return undefined
  const out: Record<string, ProbeCapabilityRecord> = {}
  for (const [token, rec] of Object.entries(e as Record<string, unknown>)) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
    const r = rec as { ok?: unknown; at?: unknown }
    if (typeof r.ok !== 'boolean' || typeof r.at !== 'number' || !Number.isFinite(r.at)) continue
    out[token] = { ok: r.ok, at: r.at }
  }
  return Object.keys(out).length ? out : undefined
}

function verdictFromJsonl(e: Record<string, unknown>): ProbeVerdict | undefined {
  const provider = e.provider
  const keyFp = e.key_fp
  const model = e.model
  const state = VERDICT_STATES.includes(e.state as ProbeVerdictState) ? (e.state as ProbeVerdictState) : undefined
  const at = Date.parse(String(e.at ?? ''))
  if (typeof provider !== 'string' || typeof keyFp !== 'string' || typeof model !== 'string' || !state || !Number.isFinite(at)) return undefined
  const evidence: ProbeEvidence = { source: typeof e.source === 'string' ? e.source : 'replay', at }
  if (typeof e.status === 'number') evidence.status = e.status
  if (typeof e.err === 'string') evidence.err = e.err
  if (typeof e.ms === 'number') evidence.ms = e.ms
  if (e.unverified === true) evidence.unverified = true
  const advisory = e.advisory && typeof e.advisory === 'object' && !Array.isArray(e.advisory) ? (e.advisory as Record<string, unknown>) : undefined
  const capabilities = capabilityRecordsFromJsonl(e.capabilities)
  return { provider, keyFp, model, state, evidence, ...(advisory ? { advisory } : {}), ...(capabilities ? { capabilities } : {}) }
}

/** 启动回放：按天序读 probe-*.jsonl 重建热态（后写覆盖先写 = 最新证据胜；坏行跳过不致命）。
 *  pending 缓冲不持久化（进程内瞬态采样状态，重启即弃——共识从新进程重新积累）。 */
export async function replayProbeVerdicts(rt: GatewayRuntime): Promise<number> {
  const dir = logsDir()
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  const files = names.filter((n) => VERDICT_FILE_RE.test(n)).sort()
  const store = verdictStore(rt)
  let count = 0
  for (const name of files) {
    const full = path.join(dir, name)
    // 常驻流池可能还持有本文件的缓冲（重启回放前的最后一批 verdict）：先关流刷盘再读
    await closeAppendStream(full)
    let text: string
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      let e: Record<string, unknown>
      try {
        e = JSON.parse(t)
      } catch {
        continue
      }
      if (e?.kind !== 'probe-verdict') continue
      const v = verdictFromJsonl(e)
      if (!v) continue
      const key = verdictKey(v.provider, v.keyFp, v.model)
      // 回放按时间序后写覆盖先写；能力记录例外——按标记合并累积（多探针结论并存，
      // 不被后写的非能力样本冲掉，与热态 mergeCapabilityRecord 的累积语义一致）
      const prevReplay = store.get(key)
      const capabilities = mergeCapabilityRecords(prevReplay?.capabilities, v.capabilities)
      store.set(key, capabilities ? { ...v, capabilities } : v)
      count++
    }
  }
  return count
}

/** 趋势时间线条目（provider-probe-suite 任务 14）：verdict 状态变化证据。from=null = 窗口内该
 *  三元组首现——窗口外历史因读取层过滤不可见，不等于「无历史」。 */
export interface ProbeVerdictTimelineItem {
  /** 证据时间（ISO，与 JSONL 落盘的 at 同形态） */
  at: string
  provider: string
  /** sha256(key) 前 8 位指纹（对齐 probeVerdictView 红线：绝不含 key 明文） */
  key_fp: string
  model: string
  from: ProbeVerdictState | null
  to: ProbeVerdictState
  source: string
}

/** 近 windowMs 的 verdict 变化时间线（GET /_modeldock/probe/trend 数据源）：只读 probe-<date>.jsonl，
 *  窗口过滤在读取层逐行 at 过滤（窗口外数据不出本函数、更不出网关）；输出按证据时间 at 升序，
 *  同三元组相邻条目状态相同的（evidence 刷新）不出——变化时间线只记翻转。不读请求日志与账本。
 *  窗口受保留期约束：probe-<date>.jsonl 随 log_retention_days 清理，超出保留期的历史自然为空。 */
export async function probeVerdictTimeline(windowMs: number, now = Date.now()): Promise<ProbeVerdictTimelineItem[]> {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return []
  const startAt = now - windowMs
  const dir = logsDir()
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const files = names.filter((n) => VERDICT_FILE_RE.test(n)).sort()
  const rows: Array<ProbeVerdictTimelineItem & { atMs: number }> = []
  for (const name of files) {
    const full = path.join(dir, name)
    // 常驻流池可能还持有缓冲（appendVerdictJsonl 刚写入未刷盘）：先关流再读，防漏最新几行
    await closeAppendStream(full)
    let text: string
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      let e: Record<string, unknown>
      try {
        e = JSON.parse(t)
      } catch {
        continue
      }
      if (e?.kind !== 'probe-verdict') continue
      const atMs = Date.parse(String(e.at ?? ''))
      if (!Number.isFinite(atMs) || atMs < startAt) continue
      const state = VERDICT_STATES.includes(e.state as ProbeVerdictState) ? (e.state as ProbeVerdictState) : undefined
      if (!state || typeof e.provider !== 'string' || typeof e.key_fp !== 'string' || typeof e.model !== 'string') continue
      rows.push({
        atMs,
        at: new Date(atMs).toISOString(),
        provider: e.provider,
        key_fp: e.key_fp,
        model: e.model,
        from: null,
        to: state,
        source: typeof e.source === 'string' ? e.source : 'replay',
      })
    }
  }
  rows.sort((a, b) => a.atMs - b.atMs)
  const lastState = new Map<string, ProbeVerdictState>()
  const out: ProbeVerdictTimelineItem[] = []
  for (const r of rows) {
    const key = verdictKey(r.provider, r.key_fp, r.model)
    const prev = lastState.get(key) ?? null
    if (prev !== r.to) out.push({ at: r.at, provider: r.provider, key_fp: r.key_fp, model: r.model, from: prev, to: r.to, source: r.source })
    lastState.set(key, r.to)
  }
  return out
}

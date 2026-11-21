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
import type { GatewayRuntime, ProbeEvidence, ProbePendingSample, ProbeVerdict, ProbeVerdictState } from '../state/types.js'

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
    appendVerdictJsonl(prev)
    return prev
  }
  // 一致样本 / advisory 样本：刷新证据时间戳（freshness），jittery 一致即冲突解除、缓冲清零
  prev.evidence = ev
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
  }
  appendLog(`${VERDICT_FILE_PREFIX}${localDateStr(new Date(at))}.jsonl`, JSON.stringify(entry) + '\n')
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
  return { provider, keyFp, model, state, evidence }
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
      store.set(verdictKey(v.provider, v.keyFp, v.model), v)
      count++
    }
  }
  return count
}

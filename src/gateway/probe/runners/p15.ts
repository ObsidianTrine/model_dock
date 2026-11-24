// p15.ts — P15 被动聚合（provider-probe-suite 任务 3）。
// 滚动 24h 聚合请求日志（gateway-<date>.jsonl 的 LogEntry.cause 与状态码）→ 逐 provider 错误
// 分布；全程零上游请求（calls 恒空、transport 不触，成本档 none）。被动证据经
// applyVerdictEvidence 同一入口（source=passive:p15，kind=passive）刷新 freshness：窗口内
// provider 侧失败按严重度归档（auth-dead > quota > unreachable > degraded，quota 判定复用
// relay 的 isQuotaError 单一口径）；窗口有成功流量 → healthy；窗口零活动 → noEvidence 跳过
// （空刷新会把 freshness 顶新，架空「7 天无证据转 stale」）。

import { isQuotaError } from '../../relay.js'
import { readRequestLogWindow } from '../../state/logs.js'
import { nearestRankPercentile } from './shared.js'
import type { LogEntry, ProbeVerdictState } from '../../state/types.js'
import type { ProbeUnitContext, ProbeUnitOutcome } from '../engine.js'

/** 滚动窗口长度（design：P15 滚动 24h） */
export const P15_WINDOW_MS = 24 * 60 * 60_000
/** 被动证据来源短码（design：被动信号 source 标 passive） */
export const P15_SOURCE = 'passive:p15'

/** provider 侧失败分类（严重度从高到低）：auth → quota → unreachable → degraded */
export type P15ErrorClass = 'auth' | 'quota' | 'unreachable' | 'degraded'

/** 网关本地原因短码：非 provider 侧失败（本地跳过/客户端中止/排队超额等）——只进错误分布
 *  计数供排查，不参与 verdict 归档（把本地配置问题算到服务头上会污染被动判定）。 */
const LOCAL_CAUSES = new Set([
  'proto_endpoint_missing',
  'key_pool_empty',
  'key_cooldown',
  'key_pool_rejected',
  'queue_full',
  'model_mismatch',
  'local_limit',
  'client_abort',
  'stream_interrupt',
])

/** 单条日志的 provider 侧错误类（null = 成功或非 provider 侧失败）。归档口径与 P1 对齐：
 *  401/403（含 unauthorized 归因）→ auth；402 或 429+额度特征 → quota（isQuotaError 单一口径，
 *  旧日志缺 cause 时从 status+err 兜底判）；connect_failed/headers_timeout → unreachable；
 *  其余非本地原因的 4xx/5xx → degraded。 */
export function classifyLogEntry(e: LogEntry): P15ErrorClass | null {
  const status = e.status ?? 0
  if (status === 401 || status === 403 || e.cause === 'unauthorized') return 'auth'
  if (e.cause === 'quota' || isQuotaError(status, e.err ?? '')) return 'quota'
  if (e.cause === 'connect_failed' || e.cause === 'headers_timeout') return 'unreachable'
  if (status >= 400 && !(e.cause && LOCAL_CAUSES.has(e.cause))) return 'degraded'
  return null
}

/** 逐 provider 错误分布（窗口 [fromMs, toMs] 内的请求日志条目）。纯函数：单测直接注入条目断言。 */
export interface P15ProviderSignal {
  provider: string
  /** 窗口内请求总数 */
  requests: number
  /** 2xx 成功数 */
  ok: number
  /** provider 侧失败数（by_class 合计；本地原因失败不计入） */
  failed: number
  /** 按 LogEntry.cause 计数（含本地原因，供排查；无 cause 不计） */
  by_cause: Record<string, number>
  /** 按状态码计数（字符串键；无状态计 'n/a'） */
  by_status: Record<string, number>
  /** provider 侧失败按类计数 */
  by_class: Record<P15ErrorClass, number>
  /** 归档类下最新一条失败条目（verdict 证据的 status/err 取材；无 provider 侧失败缺席） */
  last_error?: { status?: number; err?: string; cause?: string; ts?: string }
  /** 窗口内带耗时的请求样本（成功与失败同计，metrics 采样环同口径）：延迟分位的取材 */
  ms_samples: number[]
}

export interface P15Aggregate {
  fromMs: number
  toMs: number
  /** 窗口内条目总数（= providers[].requests 合计；与注入日志条目数一致） */
  total: number
  providers: P15ProviderSignal[]
}

const CLASS_ORDER: readonly P15ErrorClass[] = ['auth', 'quota', 'unreachable', 'degraded']

export function aggregateProviderSignals(entries: readonly LogEntry[], fromMs: number, toMs: number): P15Aggregate {
  const byProvider = new Map<string, P15ProviderSignal & { lastByClass: Map<P15ErrorClass, LogEntry> }>()
  for (const e of entries) {
    const sig =
      byProvider.get(e.provider) ??
      ({
        provider: e.provider,
        requests: 0,
        ok: 0,
        failed: 0,
        by_cause: {},
        by_status: {},
        by_class: { auth: 0, quota: 0, unreachable: 0, degraded: 0 },
        ms_samples: [],
        lastByClass: new Map(),
      } as P15ProviderSignal & { lastByClass: Map<P15ErrorClass, LogEntry> })
    byProvider.set(e.provider, sig)
    sig.requests++
    if (e.ms != null && Number.isFinite(e.ms)) sig.ms_samples.push(e.ms)
    const statusKey = e.status == null ? 'n/a' : String(e.status)
    sig.by_status[statusKey] = (sig.by_status[statusKey] ?? 0) + 1
    if (e.cause) sig.by_cause[e.cause] = (sig.by_cause[e.cause] ?? 0) + 1
    const cls = classifyLogEntry(e)
    if (cls) {
      sig.failed++
      sig.by_class[cls]++
      // 同类取 ts 最新一条（ISO 字符串同序字典序，直接比字符串即可；时间过滤已在上游完成）
      const prev = sig.lastByClass.get(cls)
      if (!prev || String(e.ts) >= String(prev.ts)) sig.lastByClass.set(cls, e)
    } else if (e.status != null && e.status >= 200 && e.status < 300) {
      sig.ok++
    }
  }
  const providers: P15ProviderSignal[] = []
  for (const sig of byProvider.values()) {
    const rest: P15ProviderSignal = {
      provider: sig.provider,
      requests: sig.requests,
      ok: sig.ok,
      failed: sig.failed,
      by_cause: sig.by_cause,
      by_status: sig.by_status,
      by_class: sig.by_class,
      ms_samples: sig.ms_samples,
    }
    // 归档类取严重度最高且有发生的类；last_error 取该类最新条目（证据与归档类一致，防
    // 「quota 判定却挂着 502 的证据」错位）
    const top = CLASS_ORDER.find((c) => sig.by_class[c] > 0)
    if (top) {
      const le = sig.lastByClass.get(top)!
      rest.last_error = { ...(le.status != null ? { status: le.status } : {}), ...(le.err ? { err: le.err } : {}), ...(le.cause ? { cause: le.cause } : {}), ...(le.ts ? { ts: le.ts } : {}) }
    }
    providers.push(rest)
  }
  providers.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
  return { fromMs, toMs, total: entries.length, providers }
}

/** 分布 → verdict 状态：按严重度取最高发生类；无 provider 侧失败但有成功流量 → healthy；
 *  窗口零活动或只有本地失败/无成功 → undefined（无充分证据不下结论）。 */
export function p15SignalState(sig: P15ProviderSignal | undefined): ProbeVerdictState | undefined {
  if (!sig || sig.requests === 0) return undefined
  const top = CLASS_ORDER.find((c) => sig.by_class[c] > 0)
  if (top) {
    return top === 'auth' ? 'auth-dead' : top === 'quota' ? 'quota' : top === 'unreachable' ? 'unreachable' : 'degraded'
  }
  return sig.ok > 0 ? 'healthy' : undefined
}

/** P15 runner（engine 兼容）：聚合目标 provider 的滚动 24h 分布并落被动证据。零上游请求——
 *  calls 恒空，transport 参数不触。窗口内有带耗时的请求样本时，延迟 p50/p95（与错误分布同窗）
 *  挂 verdict advisory.latency——服务卡的「诊断」弹层据此展示真实流量延迟分布（passive:p15）。 */
export async function runP15(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const toMs = Date.now()
  const fromMs = toMs - P15_WINDOW_MS
  const agg = aggregateProviderSignals(readRequestLogWindow(fromMs, toMs), fromMs, toMs)
  const sig = agg.providers.find((p) => p.provider === ctx.target.providerId)
  if (!sig) return { calls: [], noEvidence: true, source: P15_SOURCE }
  const state = p15SignalState(sig)
  if (!state) return { calls: [], noEvidence: true, source: P15_SOURCE }
  const le = sig.last_error
  const lat = latencyAdvisory(sig)
  return {
    state,
    ...(le?.status != null ? { status: le.status } : {}),
    ...(le?.err ? { err: le.err } : {}),
    ...(lat ? { advisory: lat } : {}),
    calls: [],
    source: P15_SOURCE,
  }
}

/** 窗口样本的延迟分位旁注（p50/p95 最近秩法，同 P14 口径）：无样本返回 undefined（不挂空档）。 */
export function latencyAdvisory(sig: P15ProviderSignal): Record<string, unknown> | undefined {
  if (!sig.ms_samples.length) return undefined
  return {
    latency: {
      p50: nearestRankPercentile(sig.ms_samples, 50) ?? null,
      p95: nearestRankPercentile(sig.ms_samples, 95) ?? null,
      n: sig.ms_samples.length,
    },
  }
}

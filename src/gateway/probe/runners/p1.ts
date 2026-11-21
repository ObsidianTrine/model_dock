// p1.ts — P1 鉴权回声（provider-probe-suite 任务 3）。
// MODELDOCK-OK 精确回文（trim 后全等）：能精确回显 = 鉴权、路由、推理链路全通。五态归档口径
// （design 判定规则 5）：401/403 → auth-dead；402 或 429+额度特征 → quota（复用 relay 的
// isQuotaError 单一口径，勿复制正则）；网络失败 → unreachable；其余 4xx/5xx 与回显不匹配
// → degraded（宁严勿松：中转改写回显也算不通过）；匹配 → healthy。普通 429（无额度特征）
// 标 rateLimited 交引擎退避重试 + provider 探针冷却。

import { isQuotaError } from '../../relay.js'
import { t } from '../../../util/i18n.js'
import { probeWire, extractReplyText, upstreamErrorLine } from '../wire.js'
import type { ProbeUnitContext, ProbeUnitOutcome, ProbeUpstreamRequest, ProbeUpstreamResponse } from '../engine.js'

export const P1_CANARY = 'MODELDOCK-OK'
export const P1_PROMPT = `Reply with exactly ${P1_CANARY} and nothing else.`

/** usage 数字字段合计 → 账本 tokens（与请求日志 dayTokens 口径一致：缓存读/建计入 input） */
export function sumUsageTokens(usage: Record<string, number> | undefined): number {
  let sum = 0
  for (const v of Object.values(usage ?? {})) if (typeof v === 'number' && v > 0) sum += v
  return sum
}

/** 发一次 P1 回文请求（runner 经 engine transport 发请求，不自行 fetch）。runner 共享给 P2
 *  逐 key 审计（任务 4）：每把 key 各跑一次本函数。 */
export async function runP1(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const t0 = Date.now()
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const wire = probeWire(provider?.protocol ?? 'openai', ctx.target.model, { prompt: P1_PROMPT })
  const req: ProbeUpstreamRequest = {
    providerId: ctx.target.providerId,
    model: ctx.target.model,
    path: wire.path,
    body: wire.body,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  }
  let resp: ProbeUpstreamResponse
  try {
    resp = await ctx.transport(req)
  } catch (e) {
    // 网络层失败（连接拒绝/超时/DNS）：无响应状态可归档，unreachable + 错误消息入证据
    return { state: 'unreachable', err: e instanceof Error ? e.message : String(e), ms: Date.now() - t0, calls: [] }
  }
  const ms = resp.ms ?? Date.now() - t0
  const status = resp.status
  const bodyText = resp.bodyText
  const call = { tokens: sumUsageTokens(resp.usage), ms, status }
  const errLine = upstreamErrorLine(bodyText)
  const errField = errLine ? { err: errLine } : {}
  if (status === 401 || status === 403) return { state: 'auth-dead', status, ms, ...errField, calls: [call] }
  if (isQuotaError(status, bodyText ?? '')) return { state: 'quota', status, ms, ...errField, calls: [call] }
  if (status === 429) {
    // 普通限流：degraded + 引擎退避重试与 provider 冷却（额度特征已在上一分支截流为 quota）
    return {
      state: 'degraded',
      status,
      ms,
      ...errField,
      calls: [call],
      rateLimited: true,
      ...(resp.headers?.['retry-after'] != null ? { retryAfter: resp.headers['retry-after'] } : {}),
    }
  }
  if (status >= 400) return { state: 'degraded', status, ms, ...errField, calls: [call] }
  const reply = extractReplyText(bodyText)
  if (reply?.trim() === P1_CANARY) return { state: 'healthy', status, ms, calls: [call] }
  return {
    state: 'degraded',
    status,
    ms,
    err: t('探针 P1 回显不匹配：期望「{expected}」，实际「{actual}」（服务可达但回显被改写，人工复核）', 'Probe p1 echo mismatch: expected "{expected}", got "{actual}" (service reachable but echo altered; review manually)', {
      expected: P1_CANARY,
      actual: (reply ?? '').trim().slice(0, 120) || '-',
    }),
    calls: [call],
  }
}

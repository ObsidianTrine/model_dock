// p12.ts — P12 身份核对（provider-probe-suite 任务 3）。
// 响应 model 字段（生产 transport 透传 modelAfter——mfGate 改写后的最终模型，响应体 model
// 字段可能仍是被请求的原文）与请求模型比对，辅以自述问句观测模型自报身份。恒 advisory：
// outcome 不主张任何状态（state 缺席），比对结果只挂 verdict.advisory 旁注——身份核对是
// 「这家服务商到底在伺服哪个模型」的观测，不是健康判定（design 判定规则 5 + jittery 名单）。

import { t } from '../../../util/i18n.js'
import { probeWire, extractReplyText, extractResponseModel, upstreamErrorLine } from '../wire.js'
import { sumUsageTokens } from './p1.js'
import type { ProbeUnitContext, ProbeUnitOutcome, ProbeUpstreamRequest, ProbeUpstreamResponse } from '../engine.js'

export const P12_PROMPT = 'State the exact model identifier serving this request. Reply with the model name only.'

/** 恒 advisory 的身份观测（挂 verdict.advisory；match=null = 拿不到响应 model，无法比对） */
export interface P12Advisory extends Record<string, unknown> {
  requested: string
  actual: string | null
  match: boolean | null
  /** 模型自述回复（原文截断；自报身份与路由名常不一致，只观测不判定） */
  reply?: string
}

export async function runP12(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const t0 = Date.now()
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const wire = probeWire(provider?.protocol ?? 'openai', ctx.target.model, { prompt: P12_PROMPT })
  const req: ProbeUpstreamRequest = {
    providerId: ctx.target.providerId,
    model: ctx.target.model,
    path: wire.path,
    body: wire.body,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  }
  const advisoryOf = (resp: ProbeUpstreamResponse | undefined): P12Advisory => {
    const actual = resp ? (resp.modelAfter ?? extractResponseModel(resp.bodyText)) ?? null : null
    const reply = resp ? extractReplyText(resp.bodyText) : undefined
    return {
      requested: ctx.target.model,
      actual,
      match: actual == null ? null : actual === ctx.target.model,
      ...(reply ? { reply: reply.slice(0, 200) } : {}),
    }
  }
  let resp: ProbeUpstreamResponse
  try {
    resp = await ctx.transport(req)
  } catch (e) {
    return {
      err: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
      calls: [],
      advisory: advisoryOf(undefined),
    }
  }
  const ms = resp.ms ?? Date.now() - t0
  const status = resp.status
  const call = { tokens: sumUsageTokens(resp.usage), ms, status }
  const advisory = advisoryOf(resp)
  if (status === 429 && resp.headers?.['retry-after'] != null) {
    // 限流交引擎退避重试；身份观测先记 null-match 旁注（重试成功后由重试样本覆盖）
    return { status, ms, calls: [call], rateLimited: true, retryAfter: resp.headers['retry-after'], advisory }
  }
  if (status >= 400) {
    const errLine = upstreamErrorLine(resp.bodyText)
    return { status, ms, ...(errLine ? { err: errLine } : {}), calls: [call], advisory }
  }
  if (advisory.match === false) {
    advisory.note = t('探针 P12 身份不符：请求 {requested}，响应实际 {actual}（advisory 不改判状态）', 'Probe p12 identity mismatch: requested {requested}, served {actual} (advisory only; verdict unchanged)', { requested: ctx.target.model, actual: advisory.actual ?? '-' })
  }
  return { status, ms, calls: [call], advisory }
}

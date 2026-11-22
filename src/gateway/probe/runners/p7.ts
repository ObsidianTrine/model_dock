// p7.ts — P7 推理识别（provider-probe-suite 任务 7）。
// reasoning_content/thinking 块存在性（design 判定规则 5）：OpenAI 系 choices[].message
// .reasoning_content（GLM/DeepSeek R1 系）与 Anthropic content[] 中 type='thinking' 块两种
// 形态，检出任一即判支持。探针只认通道不认答案——提问带推理邀请（step-by-step）但答案内容
// 与数值都不参与判定：普通模型把过程写进正文不算推理通道，那是正文输出；空 reasoning_content
// 同样不算（空串说明通道未实际产出）。

import { t } from '../../../util/i18n.js'
import { probeWire, upstreamErrorLine } from '../wire.js'
import { PROBE_CANARY_MAX_TOKENS, classifyUpstreamFailure, sendProbe, sumUsageTokens } from './shared.js'
import type { ProbeUnitContext, ProbeUnitOutcome } from '../engine.js'

export const P7_PROMPT = 'What is 17 * 23? Think it through step by step, then state the final number.'

/** 从成功响应体检出推理通道（两种形态任一即可）：openai 系 message.reasoning_content 非空
 *  字符串，或 content 数组存在 type='thinking' 块。非 JSON / 无形态返回 false（从严）。 */
export function hasReasoningChannel(bodyText: string | undefined): boolean {
  if (!bodyText) return false
  let j: unknown
  try {
    j = JSON.parse(bodyText)
  } catch {
    return false
  }
  const o = j as Record<string, unknown>
  const msg = (o?.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined
  if (typeof msg?.reasoning_content === 'string' && msg.reasoning_content.trim()) return true
  if (Array.isArray(o?.content)) {
    for (const b of o.content as Array<Record<string, unknown>>) {
      if (b?.type === 'thinking') return true
    }
  }
  return false
}

export async function runP7(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const wire = probeWire(provider?.protocol ?? 'openai', ctx.target.model, {
    prompt: P7_PROMPT,
    maxTokens: PROBE_CANARY_MAX_TOKENS,
  })
  const sent = await sendProbe(ctx, wire.path, wire.body)
  if (!sent.ok) return { state: 'unreachable', err: sent.netErr, ms: sent.ms, calls: [] }
  const resp = sent.resp
  const ms = sent.ms
  const call = { tokens: sumUsageTokens(resp.usage), ms, status: resp.status }
  const errLine = upstreamErrorLine(resp.bodyText)
  const errField = errLine ? { err: errLine } : {}
  const failed = classifyUpstreamFailure(resp.status, resp.bodyText, resp.headers?.['retry-after'])
  if (failed) return { ...failed, status: resp.status, ms, ...errField, calls: [call] }
  if (hasReasoningChannel(resp.bodyText)) return { state: 'healthy', status: resp.status, ms, calls: [call] }
  return {
    state: 'degraded',
    status: resp.status,
    ms,
    err: t(
      '探针 P7 未检出推理通道：响应无 reasoning_content 字段也无 thinking 块（该模型可能不支持推理输出），人工复核',
      'Probe p7 no reasoning channel detected: response has neither reasoning_content field nor thinking blocks (model may not support reasoning output); review manually'
    ),
    calls: [call],
  }
}

// p6.ts — P6 结构化输出（provider-probe-suite 任务 7）。
// response_format=json_object + parse + 约定字段校验（design 判定规则 5）：canary 指令约定回复
// {"ok":true}，runner 解析回复 JSON 并校验约定字段 ok 存在（presence 语义——模型能按约定形态
// 吐 JSON 即证实结构化能力，字段取值不参与判定）。response_format 是 openai 协议原生槽位；
// anthropic/responses 无 json_object 参数（responses 的 text.format 不在本探针范围），约定
// 校验纯靠指令，跨协议同一判定口径。非法 JSON / 缺字段从严判 degraded（宁严勿松）。

import { t } from '../../../util/i18n.js'
import type { Protocol } from '../../../config/types.js'
import { extractReplyText, probeWirePath, upstreamErrorLine } from '../wire.js'
import { PROBE_CANARY_MAX_TOKENS, classifyUpstreamFailure, parseCanaryJson, sendProbe, sumUsageTokens } from './shared.js'
import type { ProbeUnitContext, ProbeUnitOutcome } from '../engine.js'

export const P6_PROMPT = 'Reply with exactly {"ok":true} and nothing else.'

/** P6 请求体拼装：任务 3 的 probeWire 线格式不含 response_format 槽位（并行 worktree、字节
 *  一致复制防漂移），openai 形态在此补装该槽；路径仍走 probeWirePath 单一事实源。键序对齐
 *  probeWire（responses 一等协议，max_output_tokens）。 */
function p6Wire(proto: Protocol, model: string): { path: string; body: Buffer } {
  const path = probeWirePath(proto)
  const base =
    proto === 'responses'
      ? { model, max_output_tokens: PROBE_CANARY_MAX_TOKENS, stream: false, input: P6_PROMPT }
      : { model, max_tokens: PROBE_CANARY_MAX_TOKENS, stream: false, messages: [{ role: 'user', content: P6_PROMPT }] }
  const body = proto === 'openai' ? { ...base, response_format: { type: 'json_object' } } : base
  return { path, body: Buffer.from(JSON.stringify(body)) }
}

export async function runP6(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const proto = provider?.protocol ?? 'openai'
  const wire = p6Wire(proto, ctx.target.model)
  const sent = await sendProbe(ctx, wire.path, wire.body)
  if (!sent.ok) return { state: 'unreachable', err: sent.netErr, ms: sent.ms, calls: [] }
  const resp = sent.resp
  const ms = sent.ms
  const call = { tokens: sumUsageTokens(resp.usage), ms, status: resp.status }
  const errLine = upstreamErrorLine(resp.bodyText)
  const errField = errLine ? { err: errLine } : {}
  const failed = classifyUpstreamFailure(resp.status, resp.bodyText, resp.headers?.['retry-after'])
  if (failed) return { ...failed, status: resp.status, ms, ...errField, calls: [call] }
  const parsed = parseCanaryJson(extractReplyText(resp.bodyText))
  if (parsed && 'ok' in parsed) return { state: 'healthy', status: resp.status, ms, calls: [call] }
  return {
    state: 'degraded',
    status: resp.status,
    ms,
    err: t(
      '探针 P6 结构化输出不合规：期望 JSON 含约定字段 ok（response_format={fmt}），实际「{actual}」，人工复核该服务的 JSON 模式',
      'Probe p6 structured output invalid: expected JSON with agreed field "ok" (response_format={fmt}), got "{actual}"; review this service JSON mode manually',
      { fmt: proto === 'openai' ? 'json_object' : 'none', actual: (extractReplyText(resp.bodyText) ?? '').trim().slice(0, 120) || '-' }
    ),
    calls: [call],
  }
}

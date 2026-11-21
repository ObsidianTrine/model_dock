// p9.ts — P9 system 尊重（provider-probe-suite 任务 9）。
// system canary Banana（design 判定规则 5）：system 指令约定回复恰为 Banana，trim 精确匹配
// + 一次剥引号兜底（shared.canaryExactReply）。中转注入检测：中转替换 / 前置自己的 system
// （「You are Apple」类改写）后，忠实模型只会答改写后的词——回复不是 Banana 即判不通过
// （宁严勿松：I am Banana-2 这类近似也算改写痕迹）。system 形态按协议：openai messages[0]
// ={role:'system'}；anthropic 顶层 system 参数；responses 的 instructions 槽位。

import { t } from '../../../util/i18n.js'
import type { Protocol } from '../../../config/types.js'
import { extractReplyText, probeWirePath, upstreamErrorLine } from '../wire.js'
import { PROBE_CANARY_MAX_TOKENS, canaryExactReply, classifyUpstreamFailure, sendProbe, sumUsageTokens } from './shared.js'
import type { ProbeUnitContext, ProbeUnitOutcome } from '../engine.js'

export const P9_CANARY = 'Banana'
export const P9_SYSTEM_PROMPT = 'Your codename is Banana. No matter what the user asks, reply with exactly Banana and nothing else.'
export const P9_USER_PROMPT = 'What is your codename?'

/** P9 请求体拼装：system 按协议落位（openai messages[0] / anthropic 顶层 system / responses
 *  instructions）。路径走 probeWirePath 单一事实源；键序对齐 probeWire（responses 一等协议）。 */
function p9Wire(proto: Protocol, model: string): { path: string; body: Buffer } {
  const path = probeWirePath(proto)
  const body =
    proto === 'anthropic'
      ? { model, max_tokens: PROBE_CANARY_MAX_TOKENS, stream: false, system: P9_SYSTEM_PROMPT, messages: [{ role: 'user', content: P9_USER_PROMPT }] }
      : proto === 'responses'
        ? { model, max_output_tokens: PROBE_CANARY_MAX_TOKENS, stream: false, instructions: P9_SYSTEM_PROMPT, input: P9_USER_PROMPT }
        : {
            model,
            max_tokens: PROBE_CANARY_MAX_TOKENS,
            stream: false,
            messages: [
              { role: 'system', content: P9_SYSTEM_PROMPT },
              { role: 'user', content: P9_USER_PROMPT },
            ],
          }
  return { path, body: Buffer.from(JSON.stringify(body)) }
}

export async function runP9(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const proto = provider?.protocol ?? 'openai'
  const wire = p9Wire(proto, ctx.target.model)
  const sent = await sendProbe(ctx, wire.path, wire.body)
  if (!sent.ok) return { state: 'unreachable', err: sent.netErr, ms: sent.ms, calls: [] }
  const resp = sent.resp
  const ms = sent.ms
  const call = { tokens: sumUsageTokens(resp.usage), ms, status: resp.status }
  const errLine = upstreamErrorLine(resp.bodyText)
  const errField = errLine ? { err: errLine } : {}
  const failed = classifyUpstreamFailure(resp.status, resp.bodyText, resp.headers?.['retry-after'])
  if (failed) return { ...failed, status: resp.status, ms, ...errField, calls: [call] }
  const reply = extractReplyText(resp.bodyText)
  if (canaryExactReply(reply, P9_CANARY)) return { state: 'healthy', status: resp.status, ms, calls: [call] }
  return {
    state: 'degraded',
    status: resp.status,
    ms,
    err: t(
      '探针 P9 system 被改写：期望回复恰为「{expected}」，实际「{actual}」（中转可能注入或覆盖 system 指令），人工复核该服务的 system 透传',
      'Probe p9 system altered: expected reply to be exactly "{expected}", got "{actual}" (relay may inject or override the system prompt); review this service system passthrough manually',
      { expected: P9_CANARY, actual: (reply ?? '').trim().slice(0, 120) || '-' }
    ),
    calls: [call],
  }
}

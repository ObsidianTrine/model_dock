// p4.ts — P4 视觉实证（provider-probe-suite 任务 8）。
// 内置纯红 2×2 PNG（assets.ts 代码生成）+ 问色 canary（design 判定规则 5）：回复含独立词
// red（大小写不敏感）判通过——图没送到时模型只能答「看不到图」或瞎猜颜色，防收图不看图的
// 中转。词边界匹配而非子串：colored/hundred 之类含子串 red 的回复并非答色，子串口径会把
// 无视觉服务的闲聊误判 healthy（假阳性比假阴性危害大）；假阴性（模型答 reddish 等）从严
// 判不通过、留人工复核，与 design「宁严勿松」一致。图像 body 在 runner 层组（wire.ts
// probeWire 只管文本形态），按协议三分支；非法回复从严判 degraded。

import { t } from '../../../util/i18n.js'
import type { Protocol } from '../../../config/types.js'
import { P4_RED_PNG_BASE64 } from '../assets.js'
import { extractReplyText, probeWirePath, upstreamErrorLine } from '../wire.js'
import { PROBE_CANARY_MAX_TOKENS, classifyUpstreamFailure, sendProbe, sumUsageTokens } from './shared.js'
import type { ProbeUnitContext, ProbeUnitOutcome } from '../engine.js'

export const P4_PROMPT = 'What color is this image? Answer with one English word.'

/** 判定：回复（trim 后）含独立词 red 即通过（大小写不敏感） */
export function replySaysRed(reply: string | undefined): boolean {
  return /\bred\b/i.test((reply ?? '').trim())
}

/** P4 请求体拼装：图像 content 块按协议分支——openai image_url（data URL 包对象）、anthropic
 *  内联 base64 source、responses input_image（data URL 直填字符串）。路径仍走 probeWirePath
 *  单一事实源；键序对齐 probeWire（responses 一等协议，max_output_tokens）。 */
function p4Wire(proto: Protocol, model: string): { path: string; body: Buffer } {
  const path = probeWirePath(proto)
  const textPart = { type: 'text', text: P4_PROMPT }
  const content =
    proto === 'anthropic'
      ? [
          textPart,
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: P4_RED_PNG_BASE64 } },
        ]
      : proto === 'responses'
        ? [
            { type: 'input_text', text: P4_PROMPT },
            { type: 'input_image', image_url: `data:image/png;base64,${P4_RED_PNG_BASE64}` },
          ]
        : [
            textPart,
            { type: 'image_url', image_url: { url: `data:image/png;base64,${P4_RED_PNG_BASE64}` } },
          ]
  const body =
    proto === 'responses'
      ? { model, max_output_tokens: PROBE_CANARY_MAX_TOKENS, stream: false, input: [{ role: 'user', content }] }
      : { model, max_tokens: PROBE_CANARY_MAX_TOKENS, stream: false, messages: [{ role: 'user', content }] }
  return { path, body: Buffer.from(JSON.stringify(body)) }
}

export async function runP4(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const proto = provider?.protocol ?? 'openai'
  const wire = p4Wire(proto, ctx.target.model)
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
  if (replySaysRed(reply)) return { state: 'healthy', status: resp.status, ms, calls: [call] }
  return {
    state: 'degraded',
    status: resp.status,
    ms,
    err: t(
      '探针 P4 视觉回复不合规：发送纯红 2×2 PNG 问色，期望回答含「red」，实际「{actual}」（中转可能未传图或模型无视觉能力，人工复核）',
      'Probe p4 vision reply invalid: sent a solid-red 2x2 PNG asking its color, expected answer containing "red", got "{actual}" (relay may drop images or the model lacks vision; review manually)',
      { actual: (reply ?? '').trim().slice(0, 120) || '-' }
    ),
    calls: [call],
  }
}

// p8.ts — P8 上下文保持（provider-probe-suite 任务 9）。
// 两轮小明埋取（design 判定规则 5）：轮 1 埋名（user「我叫小明」），轮 2 带全量历史问名——
// 回答含「小明」判通过，不含判不通过（中转丢历史 / 只转发末条消息即在此现形）。轮 2 的
// assistant 轮固定填「好的」而非轮 1 实际回复：轮 1 回复质量不掺进轮 2 判定（确定性 canary，
// 无 LLM judge），历史保持的判据只落在「模型能否看到历史里的 user 消息」。两请求经同一
// engine transport（transport 无状态），历史由请求体自带——多轮形态按协议拼装（responses
// 的 input 即消息数组，与 messages 同构）。

import { t } from '../../../util/i18n.js'
import type { Protocol } from '../../../config/types.js'
import { extractReplyText, probeWirePath, upstreamErrorLine } from '../wire.js'
import { PROBE_CANARY_MAX_TOKENS, classifyUpstreamFailure, sendProbe, sumUsageTokens } from './shared.js'
import type { ProbeUnitContext, ProbeUnitOutcome } from '../engine.js'

export const P8_PLANT_PROMPT = '我叫小明'
export const P8_RECALL_PROMPT = '我叫什么名字？'
/** 轮 2 历史里的 assistant 占位（固定文本，见文件头 why） */
export const P8_ASSIST_FILLER = '好的'

interface P8Message {
  role: 'user' | 'assistant'
  content: string
}

/** 轮 2 全量历史：埋名 user → assistant 占位 → 问名 user */
export function p8HistoryMessages(): P8Message[] {
  return [
    { role: 'user', content: P8_PLANT_PROMPT },
    { role: 'assistant', content: P8_ASSIST_FILLER },
    { role: 'user', content: P8_RECALL_PROMPT },
  ]
}

/** P8 请求体拼装：openai/anthropic 用 messages 数组，responses 用 input 数组（同构消息形态）。
 *  路径走 probeWirePath 单一事实源；键序对齐 probeWire（responses 一等协议）。 */
function p8Wire(proto: Protocol, model: string, round: 1 | 2): { path: string; body: Buffer } {
  const path = probeWirePath(proto)
  const messages: P8Message[] = round === 1 ? [{ role: 'user', content: P8_PLANT_PROMPT }] : p8HistoryMessages()
  const body =
    proto === 'responses'
      ? { model, max_output_tokens: PROBE_CANARY_MAX_TOKENS, stream: false, input: messages }
      : { model, max_tokens: PROBE_CANARY_MAX_TOKENS, stream: false, messages }
  return { path, body: Buffer.from(JSON.stringify(body)) }
}

export async function runP8(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const proto = provider?.protocol ?? 'openai'
  // 轮 1：埋名。失败即归档（轮 2 依赖同一链路，没必要再发）
  const w1 = p8Wire(proto, ctx.target.model, 1)
  const s1 = await sendProbe(ctx, w1.path, w1.body)
  if (!s1.ok) return { state: 'unreachable', err: s1.netErr, ms: s1.ms, calls: [] }
  const r1 = s1.resp
  const c1 = { tokens: sumUsageTokens(r1.usage), ms: s1.ms, status: r1.status }
  const errLine1 = upstreamErrorLine(r1.bodyText)
  const errField1 = errLine1 ? { err: errLine1 } : {}
  const failed1 = classifyUpstreamFailure(r1.status, r1.bodyText, r1.headers?.['retry-after'])
  if (failed1) return { ...failed1, status: r1.status, ms: s1.ms, ...errField1, calls: [c1] }
  // 轮 2：带全量历史取名（响应以轮 2 为准，耗时累计两轮）
  const w2 = p8Wire(proto, ctx.target.model, 2)
  const s2 = await sendProbe(ctx, w2.path, w2.body)
  if (!s2.ok) return { state: 'unreachable', err: s2.netErr, ms: s1.ms + s2.ms, calls: [c1] }
  const r2 = s2.resp
  const ms = s1.ms + s2.ms
  const c2 = { tokens: sumUsageTokens(r2.usage), ms: s2.ms, status: r2.status }
  const errLine2 = upstreamErrorLine(r2.bodyText)
  const errField2 = errLine2 ? { err: errLine2 } : {}
  const failed2 = classifyUpstreamFailure(r2.status, r2.bodyText, r2.headers?.['retry-after'])
  if (failed2) return { ...failed2, status: r2.status, ms, ...errField2, calls: [c1, c2] }
  const reply = extractReplyText(r2.bodyText)
  if ((reply ?? '').includes('小明')) return { state: 'healthy', status: r2.status, ms, calls: [c1, c2] }
  return {
    state: 'degraded',
    status: r2.status,
    ms,
    err: t(
      '探针 P8 上下文保持失败：轮 2 未答出埋入名字「小明」（中转可能丢弃历史消息），实际「{actual}」，人工复核该服务的多轮链路',
      'Probe p8 context retention failed: round 2 did not answer with the planted name "小明" (relay may drop history), got "{actual}"; review this service multi-turn path manually',
      { actual: (reply ?? '').trim().slice(0, 120) || '-' }
    ),
    calls: [c1, c2],
  }
}

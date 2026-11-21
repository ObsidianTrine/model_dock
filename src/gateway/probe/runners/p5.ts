// p5.ts — P5 工具实证（provider-probe-suite 任务 8）。
// 假工具 get_weather(city) + tool_choice 强制（design 判定规则 5）：openai/responses 用
// tool_choice:'required'、anthropic 用 {type:'tool',name}（协议原生最强形态），校验回复里
// 被调工具名精确匹配 get_weather 且 args JSON 合法（对象形态）——只强制不校验名与参数会被
// 「只回文本不调工具」或调错工具的假实现骗过。args 合法性复用 shared parseCanaryJson
// （P6 约定字段同口径：对象非数组非 null），anthropic input 本就是对象、同口径校验形态。
// 未调用工具 / 名不匹配 / 缺 args / args 非法一律从严判 degraded。

import { t } from '../../../util/i18n.js'
import type { Protocol } from '../../../config/types.js'
import { extractReplyText, extractToolUses, probeWirePath, upstreamErrorLine } from '../wire.js'
import type { ProbeToolUse } from '../wire.js'
import { PROBE_CANARY_MAX_TOKENS, classifyUpstreamFailure, parseCanaryJson, sendProbe, sumUsageTokens } from './shared.js'
import type { ProbeUnitContext, ProbeUnitOutcome } from '../engine.js'

export const P5_TOOL_NAME = 'get_weather'
export const P5_PROMPT = "What's the weather in Paris? Use the tool."
const P5_TOOL_DESCRIPTION = 'Get current weather for a city.'
const P5_TOOL_PARAMETERS = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }

/** 工具调用条目的 args 合法性：anthropic input 已是对象（须对象形态）；openai/responses
 *  arguments 为 JSON 字符串（parseCanaryJson 同口径）；两者都缺席 = 缺 args 判不通过 */
function toolArgsValid(u: ProbeToolUse): boolean {
  if (u.input !== undefined) return typeof u.input === 'object' && u.input !== null && !Array.isArray(u.input)
  if (u.argsText !== undefined) return parseCanaryJson(u.argsText) !== undefined
  return false
}

/** P5 请求体拼装：openai/responses 挂 tools + tool_choice:'required'，anthropic 挂
 *  input_schema 工具 + tool_choice:{type:'tool',name}（协议原生强制指定函数形态）；路径仍走
 *  probeWirePath 单一事实源，键序对齐 probeWire（responses 一等协议，max_output_tokens）。 */
function p5Wire(proto: Protocol, model: string): { path: string; body: Buffer } {
  const path = probeWirePath(proto)
  const base =
    proto === 'responses'
      ? { model, max_output_tokens: PROBE_CANARY_MAX_TOKENS, stream: false, input: P5_PROMPT }
      : { model, max_tokens: PROBE_CANARY_MAX_TOKENS, stream: false, messages: [{ role: 'user', content: P5_PROMPT }] }
  const tools =
    proto === 'anthropic'
      ? [{ name: P5_TOOL_NAME, description: P5_TOOL_DESCRIPTION, input_schema: P5_TOOL_PARAMETERS }]
      : proto === 'responses'
        ? [{ type: 'function', name: P5_TOOL_NAME, description: P5_TOOL_DESCRIPTION, parameters: P5_TOOL_PARAMETERS }]
        : [{ type: 'function', function: { name: P5_TOOL_NAME, description: P5_TOOL_DESCRIPTION, parameters: P5_TOOL_PARAMETERS } }]
  const toolChoice = proto === 'anthropic' ? { type: 'tool', name: P5_TOOL_NAME } : 'required'
  const body = { ...base, tools, tool_choice: toolChoice }
  return { path, body: Buffer.from(JSON.stringify(body)) }
}

export async function runP5(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const proto = provider?.protocol ?? 'openai'
  const wire = p5Wire(proto, ctx.target.model)
  const sent = await sendProbe(ctx, wire.path, wire.body)
  if (!sent.ok) return { state: 'unreachable', err: sent.netErr, ms: sent.ms, calls: [] }
  const resp = sent.resp
  const ms = sent.ms
  const call = { tokens: sumUsageTokens(resp.usage), ms, status: resp.status }
  const errLine = upstreamErrorLine(resp.bodyText)
  const errField = errLine ? { err: errLine } : {}
  const failed = classifyUpstreamFailure(resp.status, resp.bodyText, resp.headers?.['retry-after'])
  if (failed) return { ...failed, status: resp.status, ms, ...errField, calls: [call] }
  const uses = extractToolUses(resp.bodyText)
  if (uses.some((u) => u.name === P5_TOOL_NAME && toolArgsValid(u))) {
    return { state: 'healthy', status: resp.status, ms, calls: [call] }
  }
  const actual = uses.length
    ? uses.map((u) => u.name).join(',')
    : ((extractReplyText(resp.bodyText) ?? '').trim().slice(0, 120) || '-')
  return {
    state: 'degraded',
    status: resp.status,
    ms,
    err: t(
      '探针 P5 工具调用不合规：期望工具 {tool} 被强制调用且参数为合法 JSON 对象，实际「{actual}」（人工复核该服务的工具调用链路）',
      'Probe p5 tool call invalid: expected tool {tool} invoked with valid JSON object args under tool_choice enforcement, got "{actual}"; review this service tool-calling path manually',
      { tool: P5_TOOL_NAME, actual }
    ),
    calls: [call],
  }
}

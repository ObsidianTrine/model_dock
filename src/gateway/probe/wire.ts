// wire.ts — 三协议探针线格式（provider-probe-suite 任务 3）。
// 请求拼装与 server.ts probe() 同一口径（anthropic /v1/messages、responses /v1/responses 用
// max_output_tokens、openai /v1/chat/completions 用 max_tokens），server.ts probe() 也经本模块
// 拼装——单一事实源防「探针拼错协议、admin-test 拼对了」的口径漂移。回复抽取按三种响应形态
// 容错解析（中转改写响应壳是常态，探测只认文本不挑壳）。

import type { Protocol } from '../../config/types.js'

export const PROBE_DEFAULT_PROMPT = 'ping'
/** 档位 S 的单请求 token 上限（registry PROBE_TIER_TOKENS.S）；probe() 历史口径同值 */
export const PROBE_DEFAULT_MAX_TOKENS = 16

/** 三协议探针路径（与 server.ts probe() 同款三态：未知协议落 openai 兜底） */
export function probeWirePath(proto: Protocol): string {
  return proto === 'anthropic' ? '/v1/messages' : proto === 'responses' ? '/v1/responses' : '/v1/chat/completions'
}

export interface ProbeWire {
  path: string
  body: Buffer
}

/** 最小会话请求拼装：键序与 server.ts probe() 历史输出逐字节一致（responses 一等协议）。
 *  思考注入（probe-no-think）：anthropic 线格式缺省带 `thinking:{type:'disabled'}`——思考型
 *  模型（GLM/火山 coding plan 等）缺省开思考，推理块烧掉 S/M 档位 max_tokens 预算后正文为空，
 *  P1 回显解析不出（实测 glm-5-3-flash 40 tokens 只剩 thinking 块）；探针是活性/能力检查，
 *  不需要推理，关掉还省 tokens。只注入 anthropic 线：GLM/火山 anthropic 兼容层与原生
 *  Anthropic（ThinkingConfigDisabled）都接受 {type:'disabled'}；openai/responses 线不注入
 *  （原生 OpenAI 等严格上游拒绝未知顶层参数），那两条线上的思考模型需服务端侧配置关闭。
 *  P7 推理识别传 thinking:'keep'——它探的就是推理通道本身。 */
export function probeWire(
  proto: Protocol,
  model: string,
  opts: { prompt?: string; maxTokens?: number; stream?: boolean; thinking?: 'disabled' | 'keep' } = {}
): ProbeWire {
  const prompt = opts.prompt ?? PROBE_DEFAULT_PROMPT
  const maxTokens = opts.maxTokens ?? PROBE_DEFAULT_MAX_TOKENS
  const stream = opts.stream === true
  const noThink = (opts.thinking ?? 'disabled') === 'disabled' && proto === 'anthropic'
  const body = Buffer.from(
    JSON.stringify(
      proto === 'responses'
        ? { model, max_output_tokens: maxTokens, stream, input: prompt }
        : {
            model,
            max_tokens: maxTokens,
            stream,
            ...(noThink ? { thinking: { type: 'disabled' } } : {}),
            messages: [{ role: 'user', content: prompt }],
          }
    )
  )
  return { path: probeWirePath(proto), body }
}

function joinTextParts(parts: unknown[]): string | undefined {
  const chunks: string[] = []
  for (const p of parts) {
    const s = (p as { text?: unknown } | undefined)?.text
    if (typeof s === 'string') chunks.push(s)
  }
  return chunks.length ? chunks.join('') : undefined
}

/** 从成功响应体抽助手文本回复：anthropic content[].text、openai choices[].message.content、
 *  responses output[].content[].text（含部分中转拍的 output_text 快捷键与拍平的 content 字符串）。
 *  非 JSON / 无文本形态返回 undefined（调用方按「未取得回复」从严判定）。 */
export function extractReplyText(bodyText: string | undefined): string | undefined {
  if (!bodyText) return undefined
  let j: unknown
  try {
    j = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  const o = j as Record<string, unknown>
  if (typeof o?.content === 'string') return o.content
  if (Array.isArray(o?.content)) return joinTextParts(o.content)
  const msg = (o?.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined
  if (typeof msg?.content === 'string') return msg.content
  if (Array.isArray(msg?.content)) return joinTextParts(msg.content)
  if (typeof o?.output_text === 'string') return o.output_text
  if (Array.isArray(o?.output)) {
    for (const part of o.output as Array<Record<string, unknown>>) {
      if (Array.isArray(part?.content)) {
        const s = joinTextParts(part.content)
        if (s) return s
      }
    }
  }
  return undefined
}

/** 工具调用条目的协议无关投影：name 全协议必有；argsText = openai/responses 的 arguments
 *  JSON 字符串，input = anthropic 已解析的对象——两者互斥缺席，args 合法性判定在 runner。 */
export interface ProbeToolUse {
  name: string
  argsText?: string
  input?: unknown
}

/** 从成功响应体抽工具调用：openai choices[].message.tool_calls[].function、anthropic
 *  content[].tool_use、responses output[].function_call（含省略 type 字段的宽容形态——中转
 *  改写响应壳是常态，探测只认结构不挑壳）。全部命中合并返回，空数组 = 无工具调用。 */
export function extractToolUses(bodyText: string | undefined): ProbeToolUse[] {
  if (!bodyText) return []
  let j: unknown
  try {
    j = JSON.parse(bodyText)
  } catch {
    return []
  }
  const o = j as Record<string, unknown>
  const out: ProbeToolUse[] = []
  const arr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [])
  for (const tc of arr((arr(o?.choices)[0]?.message as Record<string, unknown> | undefined)?.tool_calls)) {
    const fn = tc?.function as Record<string, unknown> | undefined
    if (fn && typeof fn.name === 'string') {
      out.push({ name: fn.name, ...(typeof fn.arguments === 'string' ? { argsText: fn.arguments } : {}) })
    }
  }
  for (const part of arr(o?.content)) {
    if (part?.type === 'tool_use' && typeof part.name === 'string') out.push({ name: part.name, input: part.input })
  }
  for (const part of arr(o?.output)) {
    if (part?.type === 'function_call' && typeof part.name === 'string') {
      out.push({ name: part.name, ...(typeof part.arguments === 'string' ? { argsText: part.arguments } : {}) })
    }
  }
  return out
}

/** 响应体 model 字段（三协议都会回显；生产 transport 优先透传 modelAfter——mfGate 改写后的
 *  最终模型，本抽取只作 mock/无 modelAfter 时的兜底）。 */
export function extractResponseModel(bodyText: string | undefined): string | undefined {
  if (!bodyText) return undefined
  try {
    const m = (JSON.parse(bodyText) as { model?: unknown })?.model
    return typeof m === 'string' ? m : undefined
  } catch {
    return undefined
  }
}

/** 错误体转可读一行：优先上游 message（与 server.ts probe() 同款抽取），非 JSON 截前 400 字符 */
export function upstreamErrorLine(bodyText: string | undefined): string | undefined {
  if (!bodyText) return undefined
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: unknown }; message?: unknown }
    const m = [j?.error?.message, j?.message].find((v) => typeof v === 'string' && v)
    if (m) return m as string
  } catch {
    /* 非 JSON */
  }
  const s = bodyText.trim()
  return s ? s.slice(0, 400) : undefined
}

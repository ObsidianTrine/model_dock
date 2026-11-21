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

/** 最小会话请求拼装：键序与 server.ts probe() 历史输出逐字节一致（responses 一等协议）。 */
export function probeWire(
  proto: Protocol,
  model: string,
  opts: { prompt?: string; maxTokens?: number; stream?: boolean } = {}
): ProbeWire {
  const prompt = opts.prompt ?? PROBE_DEFAULT_PROMPT
  const maxTokens = opts.maxTokens ?? PROBE_DEFAULT_MAX_TOKENS
  const stream = opts.stream === true
  const body = Buffer.from(
    JSON.stringify(
      proto === 'responses'
        ? { model, max_output_tokens: maxTokens, stream, input: prompt }
        : { model, max_tokens: maxTokens, stream, messages: [{ role: 'user', content: prompt }] }
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

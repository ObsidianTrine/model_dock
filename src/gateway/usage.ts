import { StringDecoder } from 'node:string_decoder'
import { Transform, type TransformCallback } from 'node:stream'

/** 网关侧观测到的单请求 token 用量（对账口径与 orchestrator budget 一致：缓存读计入输入）。 */
export interface UsageStats {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
}

const EMPTY_USAGE: UsageStats = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }

/**
 * 从上游响应中提取 token usage 的"旁听"流：字节原样透传（转发行为零改变），
 * 解析尽力而为——SSE 逐行、application/json 小体积缓冲（≤1MB），失败静默。
 *
 * 支持三种协议形态（与网关转发的三类客户端对应）：
 *  - anthropic SSE：message_start（usage.input/cache_*）+ message_delta（usage.output_tokens 累计）
 *  - openai SSE：任一 chunk 携带 usage（通常最后一个，prompt_tokens/completion_tokens）
 *  - responses SSE：response.completed 事件里的 response.usage（input_tokens/output_tokens）
 *  - 非流式 JSON：顶层 usage（anthropic 口径或 openai 口径字段名都认）
 */
export function createUsageTap(contentType: string | undefined): Transform & { getUsage: () => UsageStats } {
  const isJson = /application\/json/i.test(contentType ?? '')
  const isSse = /text\/event-stream/i.test(contentType ?? '')

  let usage: UsageStats = { ...EMPTY_USAGE }
  let sseBuf = ''
  let jsonBuf = ''
  let jsonOverflow = false
  let sseOverflow = false
  const JSON_LIMIT = 1024 * 1024
  // SSE 行缓冲与 JSON 路径同款封顶：故障中转/异常代理发出不含换行的超长「行」时，
  // 每个在途请求的缓冲曾无界增长直到流结束（2026-11-02 复查 P2-2）
  const SSE_LIMIT = 1024 * 1024
  // 按 UTF-8 解码并持有跨 chunk 的不完整多字节序列：直接 chunk.toString('utf8') 会把被 chunk
  // 边界截断的多字节字符变成替换符，含中文 content 的 usage 行会因此解析失败、用量漏记
  const decoder = new StringDecoder('utf8')

  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

  /** 归一化吸收：anthropic 口径与 openai 口径字段名都认（后者用于非流式 JSON） */
  const absorb = (u: Record<string, unknown> | undefined) => {
    if (!u || typeof u !== 'object') return
    const input = num(u.input_tokens) + num(u.prompt_tokens)
    const output = num(u.output_tokens) + num(u.completion_tokens)
    const cacheRead = num(u.cache_read_input_tokens) + num((u.prompt_tokens_details as any)?.cached_tokens)
    const cacheCreate = num(u.cache_creation_input_tokens) + num((u.prompt_tokens_details as any)?.cache_creation_tokens)
    if (input) usage.input_tokens = Math.max(usage.input_tokens, input)
    if (output) usage.output_tokens = Math.max(usage.output_tokens, output)
    if (cacheRead) usage.cache_read_tokens = Math.max(usage.cache_read_tokens, cacheRead)
    if (cacheCreate) usage.cache_creation_tokens = Math.max(usage.cache_creation_tokens, cacheCreate)
  }

  const feedSseLine = (line: string) => {
    const m = /^data:\s*(.+)$/.exec(line.trim())
    if (!m || m[1] === '[DONE]') return
    // 预过滤：三类协议携带用量的 data 行都含 "usage" 字面量（message_start/message_delta 的
    // usage、response.completed 的 response.usage、openai 末 chunk 的 usage），不含则解析出的
    // absorb 也必是空操作——直接跳过 JSON.parse。流式响应 95%+ 的行是不带用量的 content delta，
    // 这是 tap 在热路径上的主要 CPU 开销。
    if (!m[1].includes('usage')) return
    let evt: any
    try {
      evt = JSON.parse(m[1])
    } catch {
      return
    }
    if (!evt || typeof evt !== 'object') return
    // anthropic：message_start 的 usage（输入+缓存），message_delta 的 usage（输出累计）
    if (evt.type === 'message_start') absorb(evt.message?.usage)
    else if (evt.type === 'message_delta') absorb(evt.usage)
    else if (evt.type === 'response.completed') absorb(evt.response?.usage)
    // openai：chunk 自带 usage（末尾 chunk）
    else absorb(evt.usage)
  }

  const tap = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      try {
        if (isSse) {
          if (!sseOverflow) {
            sseBuf += decoder.write(chunk)
            if (sseBuf.length > SSE_LIMIT) {
              // 封顶后丢弃缓冲只透传：该请求的 usage 统计缺失、转发不受影响
              sseBuf = ''
              sseOverflow = true
            } else {
              let idx: number
              while ((idx = sseBuf.indexOf('\n')) >= 0) {
                const line = sseBuf.slice(0, idx)
                sseBuf = sseBuf.slice(idx + 1)
                feedSseLine(line)
              }
            }
          }
        } else if (isJson) {
          if (!jsonOverflow) {
            jsonBuf += decoder.write(chunk)
            if (jsonBuf.length > JSON_LIMIT) jsonOverflow = true
          }
        }
      } catch {
        /* 解析失败不影响转发 */
      }
      cb(null, chunk)
    },
    flush(cb: TransformCallback) {
      try {
        if (isSse) {
          sseBuf += decoder.end()
          if (sseBuf.trim()) feedSseLine(sseBuf)
        } else if (isJson && !jsonOverflow && jsonBuf) {
          try {
            const parsed = JSON.parse(jsonBuf)
            absorb(parsed?.usage ?? (typeof parsed === 'object' ? parsed : undefined))
          } catch {
            /* 非 JSON 体忽略 */
          }
        }
      } catch {
        /* 同上 */
      }
      cb()
    },
  }) as Transform & { getUsage: () => UsageStats }

  tap.getUsage = () => usage
  return tap
}

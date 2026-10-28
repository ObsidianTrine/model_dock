import type { Transform } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createUsageTap, type UsageStats } from '../src/gateway/usage.js'

// usage tap 的 responses 协议形态（response.completed 事件）与非 SSE/超大 JSON 分支。
// anthropic / openai SSE 与常规非流式 JSON 已在 hotpath.test 覆盖，这里补齐注释里承诺的第三类。

function feedTap(chunks: Buffer[], contentType: string): Promise<{ usage: UsageStats; passed: Buffer }> {
  const tap = createUsageTap(contentType) as Transform & { getUsage: () => UsageStats }
  const passed: Buffer[] = []
  tap.on('data', (c: Buffer) => passed.push(c))
  return new Promise((resolve) => {
    tap.on('finish', () => resolve({ usage: tap.getUsage(), passed: Buffer.concat(passed) }))
    for (const c of chunks) tap.write(c)
    tap.end()
  })
}

describe('createUsageTap：responses SSE', () => {
  it('response.completed 事件提取 response.usage（input/output）', async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      'data: {"type":"response.output_text.delta","delta":"你好"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":120,"output_tokens":30}}}',
    ].join('\n\n') + '\n\n'
    const { usage, passed } = await feedTap([Buffer.from(sse, 'utf8')], 'text/event-stream')
    expect(usage).toEqual({ input_tokens: 120, output_tokens: 30, cache_read_tokens: 0, cache_creation_tokens: 0 })
    expect(passed.toString('utf8')).toBe(sse) // 旁听流：字节原样透传
  })

  it('末行无换行收尾：flush 兜底解析不丢 usage', async () => {
    const tail = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":2}}}'
    const { usage } = await feedTap([Buffer.from(tail, 'utf8')], 'text/event-stream')
    expect(usage).toEqual({ input_tokens: 8, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 })
  })

  it('responses 与 openai 形态混流：各自提取、字段取最大', async () => {
    const sse = [
      'data: {"usage":{"prompt_tokens":50,"completion_tokens":9}}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":60,"output_tokens":4}}}',
    ].join('\n\n') + '\n\n'
    const { usage } = await feedTap([Buffer.from(sse, 'utf8')], 'text/event-stream')
    expect(usage).toEqual({ input_tokens: 60, output_tokens: 9, cache_read_tokens: 0, cache_creation_tokens: 0 })
  })
})

describe('createUsageTap：非 SSE / 超大 JSON', () => {
  it('非 SSE 非 JSON 的 content-type：不解析、纯透传、usage 全零', async () => {
    const body = 'data: {"usage":{"prompt_tokens":5,"completion_tokens":6}}\n\n'
    const { usage, passed } = await feedTap([Buffer.from(body, 'utf8')], 'text/plain')
    expect(usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 })
    expect(passed.toString('utf8')).toBe(body)
  })

  it('JSON 体超过 1MB：放弃解析（usage 全零）但字节仍全量透传', async () => {
    const json = JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 6 }, pad: 'x'.repeat(1500 * 1024) })
    const { usage, passed } = await feedTap([Buffer.from(json, 'utf8')], 'application/json')
    expect(usage.input_tokens).toBe(0)
    expect(usage.output_tokens).toBe(0)
    expect(passed.length).toBe(Buffer.byteLength(json))
  })
})

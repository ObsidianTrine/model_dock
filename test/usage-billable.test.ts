import type { Transform } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createUsageTap, type UsageStats } from '../src/gateway/usage.js'

// 可计费口径（billable，剔除缓存读）：token 熔断与 orchestrator reconcile 分歧率用。
// GLM 网关缓存读占大头，总口径下 max_tokens 预算虚胖——billable 必须显著小于总输入。

function feedTap(chunks: Buffer[], contentType: string): Promise<UsageStats> {
  const tap = createUsageTap(contentType) as Transform & { getUsage: () => UsageStats }
  tap.resume()
  return new Promise((resolve) => {
    tap.on('finish', () => resolve(tap.getUsage()))
    for (const c of chunks) tap.write(c)
    tap.end()
  })
}

describe('createUsageTap：billable 可计费口径（剔除缓存读）', () => {
  it('anthropic SSE 缓存读占比高：billable 显著小于总输入（缓存写照计）', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":90000,"cache_creation_input_tokens":500}}}',
      'data: {"type":"message_delta","usage":{"output_tokens":2000}}',
    ].join('\n\n') + '\n\n'
    const usage = await feedTap([Buffer.from(sse, 'utf8')], 'text/event-stream')
    // 总输入 = 1000 + 90000 + 500 = 91500；billable = (1000 + 500) + 2000 = 3500
    expect(usage.input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens).toBe(91500)
    expect(usage.billable_tokens).toBe(3500)
    expect(usage.billable_tokens).toBeLessThan(usage.input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens)
  })

  it('openai chat 口径：prompt_tokens 已含 cached_tokens（子集），billable = prompt − cached + completion', async () => {
    const json = JSON.stringify({ usage: { prompt_tokens: 100000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 95000 } } })
    const usage = await feedTap([Buffer.from(json, 'utf8')], 'application/json')
    expect(usage.input_tokens).toBe(100000)
    expect(usage.cache_read_tokens).toBe(95000)
    expect(usage.billable_tokens).toBe(5500)
  })

  it('非流式 anthropic JSON：顶层 usage 同样形态感知（input 不再扣缓存读）', async () => {
    const json = JSON.stringify({ usage: { input_tokens: 1000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0, output_tokens: 100 } })
    const usage = await feedTap([Buffer.from(json, 'utf8')], 'application/json')
    // anthropic 形态：billable = input + cache_creation + output；缓存读只剔除一次
    expect(usage.billable_tokens).toBe(1100)
  })

  it('无 usage / 解析失败：billable 与旧字段一起为 0', async () => {
    const usage = await feedTap([Buffer.from('plain body', 'utf8')], 'text/plain')
    expect(usage.billable_tokens).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { DEFAULT_QUEUE_WAIT_MS, ProviderQueueTimeoutError, acquireProviderSlot, providerConcurrencyLimit, providerConcurrencyStats, queueWaitMs } from '../src/gateway/concurrency.js'
import { buildRuntime } from '../src/gateway/state.js'
import type { Config } from '../src/config/types.js'

/** per-provider 并发闸信号量单测（纯内存，不走网络）。
 *  集成行为（failover 链内的取槽/跳过/释放时机）见 relay-concurrency.test.ts。 */

function rt() {
  const cfg = { providers: {}, profiles: {}, harness: {} } as unknown as Config
  return buildRuntime(cfg, 'tok')
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('concurrency · providerConcurrencyLimit（max_concurrency 归一）', () => {
  it('正整数原样生效（向下取整），0 / 缺省 / 非法值一律 = 不限', () => {
    expect(providerConcurrencyLimit({ max_concurrency: 3 } as any)).toBe(3)
    expect(providerConcurrencyLimit({ max_concurrency: 2.9 } as any)).toBe(2)
    expect(providerConcurrencyLimit({ max_concurrency: 0 } as any)).toBe(0)
    expect(providerConcurrencyLimit({} as any)).toBe(0)
    expect(providerConcurrencyLimit(undefined)).toBe(0)
    expect(providerConcurrencyLimit({ max_concurrency: -1 } as any)).toBe(0)
    expect(providerConcurrencyLimit({ max_concurrency: Number.NaN } as any)).toBe(0)
    expect(providerConcurrencyLimit({ max_concurrency: Number.POSITIVE_INFINITY } as any)).toBe(0)
  })
})

describe('concurrency · queueWaitMs（排队等待上限归一）', () => {
  it('缺省 2000；非法值回落缺省；显式值原样', () => {
    expect(queueWaitMs(undefined)).toBe(DEFAULT_QUEUE_WAIT_MS)
    expect(queueWaitMs({} as any)).toBe(DEFAULT_QUEUE_WAIT_MS)
    expect(queueWaitMs({ queue_wait_ms: -5 } as any)).toBe(DEFAULT_QUEUE_WAIT_MS)
    expect(queueWaitMs({ queue_wait_ms: Number.NaN } as any)).toBe(DEFAULT_QUEUE_WAIT_MS)
    expect(queueWaitMs({ queue_wait_ms: 150 } as any)).toBe(150)
    expect(queueWaitMs({ queue_wait_ms: 0 } as any)).toBe(0) // 0 = 不排队，满了立即按超时处理
  })
})

describe('concurrency · 信号量（计数 + FIFO 等待队列）', () => {
  it('限额内直接取槽；满载排队超时抛 ProviderQueueTimeoutError', async () => {
    const r = rt()
    const s1 = await acquireProviderSlot(r, 'a', 1, 50, undefined)
    expect(providerConcurrencyStats(r, 'a')).toEqual({ inFlight: 1, queued: 0 })
    const p2 = acquireProviderSlot(r, 'a', 1, 50, undefined)
    await tick()
    expect(providerConcurrencyStats(r, 'a')).toEqual({ inFlight: 1, queued: 1 })
    await expect(p2).rejects.toBeInstanceOf(ProviderQueueTimeoutError)
    await expect(p2).rejects.toMatchObject({ providerId: 'a', limit: 1, waitMs: 50 })
    // 超时者已出队：释放后计数回 1，不留幽灵占用
    s1.release()
    expect(providerConcurrencyStats(r, 'a')).toEqual({ inFlight: 0, queued: 0 })
  })

  it('release 按 FIFO 唤醒队首等待者（先到先得，不按取号顺序外的顺序）', async () => {
    const r = rt()
    const s1 = await acquireProviderSlot(r, 'a', 1, 5_000, undefined)
    const order: string[] = []
    const p1 = acquireProviderSlot(r, 'a', 1, 5_000, undefined).then((s) => { order.push('w1'); return s })
    const p2 = acquireProviderSlot(r, 'a', 1, 5_000, undefined).then((s) => { order.push('w2'); return s })
    await tick()
    expect(providerConcurrencyStats(r, 'a')).toEqual({ inFlight: 1, queued: 2 })
    s1.release()
    const w1 = await p1
    expect(order).toEqual(['w1'])
    expect(providerConcurrencyStats(r, 'a')).toEqual({ inFlight: 1, queued: 1 })
    w1.release()
    const w2 = await p2
    expect(order).toEqual(['w1', 'w2'])
    w2.release()
    expect(providerConcurrencyStats(r, 'a')).toEqual({ inFlight: 0, queued: 0 })
  })

  it('release 是幂等的：重复释放不会把计数打穿成负数、不会误唤醒多个等待者', async () => {
    const r = rt()
    const s1 = await acquireProviderSlot(r, 'a', 1, 5_000, undefined)
    const p1 = acquireProviderSlot(r, 'a', 1, 5_000, undefined)
    await tick()
    s1.release()
    s1.release() // 双重释放
    const w1 = await p1
    expect(providerConcurrencyStats(r, 'a')).toEqual({ inFlight: 1, queued: 0 })
    w1.release()
    w1.release()
    expect(providerConcurrencyStats(r, 'a')).toEqual({ inFlight: 0, queued: 0 })
  })

  it('上限热调大：排队者无需等 release 即可被放行（下一次事件 pump）', async () => {
    const r = rt()
    const s1 = await acquireProviderSlot(r, 'a', 1, 5_000, undefined)
    const p1 = acquireProviderSlot(r, 'a', 1, 5_000, undefined)
    await tick()
    expect(providerConcurrencyStats(r, 'a').queued).toBe(1)
    // 配置热加载把 max_concurrency 1 → 2：排队者的下一次 acquire 事件触发 pump，
    // 队首旧等待者先放行（FIFO），新请求仍需排队
    const p2 = acquireProviderSlot(r, 'a', 2, 5_000, undefined)
    const w1 = await p1
    expect(providerConcurrencyStats(r, 'a')).toEqual({ inFlight: 2, queued: 1 })
    s1.release() // 腾出的槽按 FIFO 移交给 p2
    const s2 = await p2
    expect(providerConcurrencyStats(r, 'a')).toEqual({ inFlight: 2, queued: 0 })
    w1.release()
    s2.release()
    expect(providerConcurrencyStats(r, 'a')).toEqual({ inFlight: 0, queued: 0 })
  })

  it('排队等待期间客户端断开（signal 已中止）→ 立即拒绝，不占队位', async () => {
    const r = rt()
    const s1 = await acquireProviderSlot(r, 'a', 1, 5_000, undefined)
    const ac = new AbortController()
    ac.abort()
    await expect(acquireProviderSlot(r, 'a', 1, 5_000, ac.signal)).rejects.toThrow('aborted')
    s1.release()
    expect(providerConcurrencyStats(r, 'a')).toEqual({ inFlight: 0, queued: 0 })
  })

  it('不同 provider 各自独立计数，互不挤占', async () => {
    const r = rt()
    const a1 = await acquireProviderSlot(r, 'a', 1, 50, undefined)
    const b1 = await acquireProviderSlot(r, 'b', 1, 50, undefined)
    expect(providerConcurrencyStats(r, 'a')).toEqual({ inFlight: 1, queued: 0 })
    expect(providerConcurrencyStats(r, 'b')).toEqual({ inFlight: 1, queued: 0 })
    a1.release()
    b1.release()
  })
})

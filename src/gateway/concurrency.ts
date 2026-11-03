import type { GatewayConfig, ProviderConfig } from '../config/types.js'
import type { GatewayRuntime } from './state.js'

/** per-provider 并发闸（P0②）：网关内存信号量，限制同一 provider 的在途转发请求数。
 *  动机：多 agent worker 并发打上游时 429 压力原样透传（GLM 实测并发≈2 就 429）；
 *  设 max_concurrency 后超额请求在网关内排队（≤ gateway.queue_wait_ms），削峰而非压垮上游。
 *  仅进程内存态（重启清零、不落盘），与 tokenlimits 的定位一致；每网关实例独立计数。 */

/** queue_wait_ms 缺省值：交互请求排队超过 ~2s 通常不如尽快失败/切换候选 */
export const DEFAULT_QUEUE_WAIT_MS = 2000

/** 读取 provider 的并发上限：0 / 缺省 / 非法值（负数、NaN、Infinity）一律 = 不限 */
export function providerConcurrencyLimit(p: ProviderConfig | undefined): number {
  const n = p?.max_concurrency
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 读取排队等待上限 ms：缺省 DEFAULT_QUEUE_WAIT_MS；非法值（负数、NaN）回落缺省 */
export function queueWaitMs(g: GatewayConfig | undefined): number {
  const n = g?.queue_wait_ms
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_QUEUE_WAIT_MS
}

/** 已获取的并发槽位：响应结束（流式读完 / 错误回包发出）后必须 release，否则该 provider 永久少一个槽。
 *  release 幂等：重复调用是无操作（防御上层 finally 与显式释放双路径）。 */
export interface ProviderSlot {
  release(): void
}

/** 排队超时（queue_wait_ms 内未等到空闲槽位）。由 relay 层翻译为 429 + 可操作 hint 的 UpstreamError */
export class ProviderQueueTimeoutError extends Error {
  constructor(readonly providerId: string, readonly limit: number, readonly waitMs: number) {
    super(`provider "${providerId}" concurrency limit ${limit} busy; queued for ${waitMs}ms without a free slot`)
    this.name = 'ProviderQueueTimeoutError'
  }
}

/** 单 provider 的计数器 + 等待队列。limit 不固化在信号量上：每次 acquire 传当前配置值并记为
 *  lastLimit（release/pump 用它唤醒排队者）——热加载调大/调小 max_concurrency 即时生效
 *  （调小不驱逐在途请求，只等自然回落后生效；调大在下一次 acquire/release 事件时放行排队者）。 */
class ProviderSemaphore {
  private inFlight = 0
  private lastLimit = 0
  private waiters: Array<{ resolve: (s: ProviderSlot) => void; reject: (e: unknown) => void; timer?: NodeJS.Timeout }> = []

  async acquire(limit: number, waitMs: number, signal: AbortSignal | undefined, makeTimeout: () => Error): Promise<ProviderSlot> {
    if (signal?.aborted) throw new Error('aborted')
    this.lastLimit = limit
    if (this.inFlight < limit && this.waiters.length === 0) {
      this.inFlight++
      return makeSlot(() => this.release())
    }
    // 排队：FIFO。入队后立即 pump 一次——limit 刚被热调大时队列不该干等到有人 release
    return new Promise<ProviderSlot>((resolve, reject) => {
      const w: { resolve: (s: ProviderSlot) => void; reject: (e: unknown) => void; timer?: NodeJS.Timeout } = { resolve, reject }
      const settle = (err: unknown) => {
        if (w.timer) clearTimeout(w.timer)
        const i = this.waiters.indexOf(w)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(err)
      }
      w.timer = setTimeout(() => settle(makeTimeout()), waitMs)
      if (w.timer.unref) w.timer.unref()
      this.waiters.push(w)
      this.pump()
    })
  }

  /** 容量就位则按 FIFO 唤醒等待者（槽位所有权直接移交，授予即 inFlight++） */
  private pump(): void {
    while (this.waiters.length > 0 && this.inFlight < this.lastLimit) {
      const w = this.waiters.shift()!
      if (w.timer) clearTimeout(w.timer)
      this.inFlight++
      w.resolve(makeSlot(() => this.release()))
    }
  }

  release(): void {
    // 防御：上限被热调小后仍可能有多个 release 并发到达，不把计数打穿成负数
    if (this.inFlight > 0) this.inFlight--
    this.pump() // 释放的槽位按 FIFO 移交给队首等待者
  }

  stats(): { inFlight: number; queued: number } {
    return { inFlight: this.inFlight, queued: this.waiters.length }
  }
}

function makeSlot(release: () => void): ProviderSlot {
  let done = false
  return {
    release() {
      if (done) return
      done = true
      release()
    },
  }
}

/** rt 级信号量表：WeakMap 挂在 GatewayRuntime 上——reloadRuntime 复用同一 rt 对象（只换
 *  rt.config），表内计数跨热加载保留；实例重建（测试/重启）随旧 rt 一起可回收 */
const semaphores = new WeakMap<GatewayRuntime, Map<string, ProviderSemaphore>>()

function semaphoreFor(rt: GatewayRuntime, providerId: string): ProviderSemaphore {
  let m = semaphores.get(rt)
  if (!m) {
    m = new Map()
    semaphores.set(rt, m)
  }
  let s = m.get(providerId)
  if (!s) {
    s = new ProviderSemaphore()
    m.set(providerId, s)
  }
  return s
}

/** 对 provider 获取一个并发槽：满载时排队等待至多 waitMs，超时抛 ProviderQueueTimeoutError。
 *  signal 触发（客户端断开）时以普通 Error('aborted') 拒绝——调用方按 aborted 分支处理。
 *  limit ≤ 0（不限）时调用方应直接跳过本函数，不产生信号量条目。 */
export async function acquireProviderSlot(
  rt: GatewayRuntime,
  providerId: string,
  limit: number,
  waitMs: number,
  signal: AbortSignal | undefined
): Promise<ProviderSlot> {
  return semaphoreFor(rt, providerId).acquire(limit, waitMs, signal, () => new ProviderQueueTimeoutError(providerId, limit, waitMs))
}

/** 供测试/诊断观测：该 provider 当前在途请求数与排队人数（无信号量条目时全 0） */
export function providerConcurrencyStats(rt: GatewayRuntime, providerId: string): { inFlight: number; queued: number } {
  const s = semaphores.get(rt)?.get(providerId)
  if (!s) return { inFlight: 0, queued: 0 }
  return s.stats()
}

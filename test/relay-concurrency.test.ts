import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { UpstreamError, forwardWithFailover, parseRatelimitHeaders, parseRetryAfterMs, type ForwardOptions } from '../src/gateway/relay.js'
import { providerConcurrencyStats } from '../src/gateway/concurrency.js'
import { buildRuntime, type GatewayRuntime, type ResolvedTarget } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { setSecret } from '../src/config/secrets.js'
import { fakeHome } from './helpers.js'
import type { Config, ProviderConfig } from '../src/config/types.js'

/** 并发闸 + 429 退避在转发链路里的集成行为（真实 rt + 真实 forwardToUpstream，mock 上游全 listen(0)）。
 *  信号量本体的纯单测见 concurrency.test.ts。 */

const body = Buffer.from(JSON.stringify({ model: 'm', messages: [] }))
const ROUTED = '/v1/messages'

function providerCfg(id: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { name: id, base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: `file:${id}`, priority: 0, ...over }
}

function buildRt(providers: Record<string, ProviderConfig>, gateway?: Config['gateway']): GatewayRuntime {
  const cfg = { providers, profiles: {}, harness: {}, gateway: { auto_fallback: false, ...gateway } } as unknown as Config
  return buildRuntime(cfg, 'tok')
}

function baseOn(cfg: Config, id: string): ResolvedTarget {
  return { harness: 'test', profileName: 'p', profile: { name: 'p', provider: id }, provider: cfg.providers[id] }
}

/** 完整 ForwardOptions（本文件在 tsconfig.test.json 受检名单内）：统一补齐必填字段 */
function fwd(over: { fallbackIds?: string[] } = {}): ForwardOptions & { fallbackIds?: string[] } {
  return { method: 'POST', path: ROUTED, headers: {}, body, idleTimeoutMs: 60_000, retries: 1, ...over }
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.()
  return new Promise((r) => server.close(() => r()))
}

/** 会计数并保持 N ms 的 200 上游：并发闸串行化验证用 */
function slowMock(ms: number): { server: http.Server; url: Promise<string>; maxActive: () => number } {
  let active = 0
  let max = 0
  const server = http.createServer((_req, res) => {
    active++
    max = Math.max(max, active)
    setTimeout(() => {
      active--
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }, ms)
  })
  const url = listen(server)
  return { server, url, maxActive: () => max }
}

/** 按 canned 序列应答的上游：并发 429 退避验证用。entry 的 retryAfter 为 undefined 时不带头 */
function cannedMock(responses: Array<{ status: number; retryAfter?: string; body?: string }>): {
  server: http.Server
  url: Promise<string>
  hits: () => number
} {
  let i = 0
  const server = http.createServer((_req, res) => {
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (r.retryAfter !== undefined) headers['retry-after'] = r.retryAfter
    res.writeHead(r.status, headers)
    res.end(r.body ?? JSON.stringify({ error: { message: 'rate limited' } }))
  })
  const url = listen(server)
  return { server, url, hits: () => i }
}

describe('relay · parseRetryAfterMs（RFC 7231 两种格式）', () => {
  const now = Date.parse('2026-11-03T08:00:00Z')
  it('delta-seconds（纯整数秒）', () => {
    expect(parseRetryAfterMs('120', now)).toBe(120_000)
    expect(parseRetryAfterMs('0', now)).toBe(0)
    expect(parseRetryAfterMs(['30'], now)).toBe(30_000) // undici 重复头数组形态防御
  })
  it('HTTP-date（未来 → 差值；已过期 → 钳 0）', () => {
    expect(parseRetryAfterMs('Tue, 03 Nov 2026 08:00:02 GMT', now)).toBe(2_000)
    expect(parseRetryAfterMs('Tue, 03 Nov 2026 07:59:00 GMT', now)).toBe(0)
  })
  it('无头 / 空串 / 畸形值 → null（不重试，维持既有 failover 语义）', () => {
    expect(parseRetryAfterMs(undefined, now)).toBeNull()
    expect(parseRetryAfterMs('', now)).toBeNull()
    expect(parseRetryAfterMs('soon', now)).toBeNull()
    // '1.5' 非 RFC 合法值：V8 宽松日期解析把它当过去日期 → 钳 0（等同立即重试一次，宽松回落无害）
    expect(parseRetryAfterMs('1.5', now)).toBe(0)
  })
})

describe('relay · parseRatelimitHeaders（上游限流信号 → LogEntry.ratelimit）', () => {
  const now = Date.parse('2026-11-03T08:00:00Z')
  it('三头齐备：全部归一落账（reset 按 epoch ms / epoch s / delta s 量级判单位）', () => {
    expect(
      parseRatelimitHeaders({ 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': '1762156800000', 'retry-after': '30' }, now),
    ).toEqual({ remaining: 42, reset: 1762156800000, retry_after_ms: 30_000 })
    expect(
      parseRatelimitHeaders({ 'x-ratelimit-remaining': '7', 'x-ratelimit-reset': '1762156800', 'retry-after': '0' }, now),
    ).toEqual({ remaining: 7, reset: 1762156800000, retry_after_ms: 0 }) // epoch s ×1000
    expect(
      parseRatelimitHeaders({ 'x-ratelimit-reset': '90' }, now),
    ).toEqual({ reset: now + 90_000 }) // 小整数：delta 秒折算绝对时刻
    expect(
      parseRatelimitHeaders({ 'x-ratelimit-reset': '2026-11-03T08:00:05Z' }, now),
    ).toEqual({ reset: now + 5_000 }) // RFC3339 时间戳
  })
  it('reset 边界宁缺毋滥：小数/科学计数不进 Date.parse 引擎回退（防日期重排）；超界大整数缺省', () => {
    // V8 引擎回退把 "1.5" 重排成 2001-01-05——数值串但非整数格式直接缺省
    expect(parseRatelimitHeaders({ 'x-ratelimit-reset': '1.5' }, now)).toBeUndefined()
    expect(parseRatelimitHeaders({ 'x-ratelimit-reset': '1e12' }, now)).toBeUndefined()
    // 超出 ECMA time-clip（±8.64e15）：消费方 toISOString 会 RangeError，缺省
    expect(parseRatelimitHeaders({ 'x-ratelimit-reset': '99999999999999999999' }, now)).toBeUndefined()
    expect(parseRatelimitHeaders({ 'x-ratelimit-reset': '-99999999999999' }, now)).toBeUndefined()
    // 正常量级不受影响
    expect(parseRatelimitHeaders({ 'x-ratelimit-reset': '1799999999' }, now)).toEqual({ reset: 1_799_999_999_000 })
  })
  it('OpenAI/Anthropic 键名族覆盖（主力上游限流信号补齐）', () => {
    // OpenAI 系 Go duration（delta）
    expect(parseRatelimitHeaders({ 'x-ratelimit-reset-requests': '6m0s' }, now)).toEqual({ reset: now + 360_000 })
    expect(parseRatelimitHeaders({ 'x-ratelimit-reset-tokens': '500ms' }, now)).toEqual({ reset: now + 500 })
    expect(parseRatelimitHeaders({ 'x-ratelimit-reset-requests': '1h2m30s' }, now)).toEqual({ reset: now + 3_750_000 })
    // Anthropic 系 RFC3339 + remaining 别名
    expect(parseRatelimitHeaders({ 'anthropic-ratelimit-unified-reset': '2026-11-03T08:00:05Z' }, now)).toEqual({ reset: now + 5_000 })
    expect(
      parseRatelimitHeaders({ 'anthropic-ratelimit-requests-remaining': '9', 'anthropic-ratelimit-unified-reset': '2026-11-03T08:00:05Z' }, now),
    ).toEqual({ remaining: 9, reset: now + 5_000 })
    // 与主键共存：先到先得不覆盖
    expect(parseRatelimitHeaders({ 'x-ratelimit-reset': '90', 'x-ratelimit-reset-requests': '6m0s' }, now)).toEqual({ reset: now + 90_000 })
    // Go duration 判不出 → 子项缺省（不猜）
    expect(parseRatelimitHeaders({ 'x-ratelimit-reset-requests': 'soon' }, now)).toBeUndefined()
  })
  it('键名大小写不敏感、重复头取首值、数组形态防御', () => {
    expect(parseRatelimitHeaders({ 'X-RateLimit-Remaining': ['12', '0'], 'Retry-After': '2' }, now)).toEqual({
      remaining: 12,
      retry_after_ms: 2_000,
    })
  })
  it('无头 → undefined（日志零新增字段）；子项畸形只缺该子项', () => {
    expect(parseRatelimitHeaders({}, now)).toBeUndefined()
    expect(parseRatelimitHeaders({ 'content-type': 'application/json' }, now)).toBeUndefined()
    // 头存在但判不出：该子项缺省，不猜
    expect(parseRatelimitHeaders({ 'x-ratelimit-remaining': 'abc', 'x-ratelimit-reset': '6m0s' }, now)).toBeUndefined()
    // 混合：remaining 畸形但 retry-after 合法 → 只落可解析项
    expect(parseRatelimitHeaders({ 'x-ratelimit-remaining': '', 'retry-after': 'Wed, 03 Nov 2026 08:00:03 GMT' }, now)).toEqual({
      retry_after_ms: 3_000,
    })
  })
})

describe('relay · forwardWithFailover 并发闸（max_concurrency / queue_wait_ms）', () => {
  it('未配 max_concurrency：不取槽（release 缺席），行为与从前一致', async () => {
    const h = fakeHome()
    const mock = slowMock(0)
    try {
      const cfg = { providers: { a: providerCfg('a', { base_url: await mock.url }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      await setSecret('a', 'sk-a', 'file')
      const result = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd())
      expect(result.status).toBe(200)
      expect(result.release).toBeUndefined()
      expect(result.reason).toBeUndefined()
      expect(providerConcurrencyStats(rt, 'a')).toEqual({ inFlight: 0, queued: 0 })
    } finally {
      await close(mock.server)
      h.restore()
    }
  })

  it('max_concurrency=1：第二个请求排队等待，槽位释放后放行（模拟 server 响应结束后 release）', async () => {
    const h = fakeHome()
    const mock = slowMock(80)
    try {
      const cfg = { providers: { a: providerCfg('a', { base_url: await mock.url, max_concurrency: 1 }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      await setSecret('a', 'sk-a', 'file')
      const target = baseOn(cfg, 'a')
      const opts = fwd()
      // R1 取槽（上游 80ms 后响应）；R2 在 R1 响应未消费完（未 release）时到达 → 排队
      const p1 = forwardWithFailover(rt, target, opts)
      const r1 = await p1
      expect(r1.status).toBe(200)
      const p2 = forwardWithFailover(rt, target, opts)
      await new Promise((r) => setTimeout(r, 30))
      expect(providerConcurrencyStats(rt, 'a')).toEqual({ inFlight: 1, queued: 1 })
      // R1 响应消费完（server.ts 流式读完）→ 释放槽位 → R2 放行
      r1.release!()
      const r2 = await p2
      expect(r2.status).toBe(200)
      expect(mock.maxActive()).toBe(1) // 槽位未释放期间 R2 的上游请求不会发出
      r2.release!()
      expect(providerConcurrencyStats(rt, 'a')).toEqual({ inFlight: 0, queued: 0 })
    } finally {
      await close(mock.server)
      h.restore()
    }
  })

  it('排队超时候选被跳过换下一家：reason 留痕 queue_full + failover_to，旧候选槽不泄漏', async () => {
    const h = fakeHome()
    const a = slowMock(0)
    const b = slowMock(0)
    try {
      const cfg = {
        providers: {
          a: providerCfg('a', { base_url: await a.url, max_concurrency: 1 }),
          b: providerCfg('b', { base_url: await b.url }),
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers, { queue_wait_ms: 120 })
      await setSecret('a', 'sk-a', 'file')
      await setSecret('b', 'sk-b', 'file')
      // R1 拿走 a 的唯一槽位并持有（模拟在途流式响应）
      const r1 = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd())
      expect(providerConcurrencyStats(rt, 'a').inFlight).toBe(1)
      // R2 在 a 上排队超时 → 跳候选到 b 成功
      const r2 = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd({ fallbackIds: ['b'] }))
      expect(r2.usedProviderId).toBe('b')
      expect(r2.status).toBe(200)
      expect(r2.reason).toBe('failover_to:b,queue_full:a,replayed_from:a')
      // R1 释放后 a 恢复可用
      r1.release!()
      const r3 = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd())
      expect(r3.usedProviderId).toBe('a')
      r3.release?.()
      expect(providerConcurrencyStats(rt, 'a')).toEqual({ inFlight: 0, queued: 0 })
    } finally {
      await close(a.server)
      await close(b.server)
      h.restore()
    }
  })

  it('链尾候选排队超时：回 429 + 可操作 hint（点名服务与调大 max_concurrency 的指引）', async () => {
    const h = fakeHome()
    const a = slowMock(0)
    try {
      const cfg = { providers: { a: providerCfg('a', { base_url: await a.url, max_concurrency: 1 }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers, { queue_wait_ms: 80 })
      await setSecret('a', 'sk-a', 'file')
      const r1 = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd())
      const err = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd()).then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(UpstreamError)
      const e = err as UpstreamError
      expect(e.status).toBe(429)
      expect(e.routeReason).toBe('queue_full')
      expect(e.message).toContain('a') // 点名满了的服务
      expect(e.hint).toContain('max_concurrency') // 可操作：调大上限或降低客户端并发
      r1.release!()
      const r3 = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd())
      expect(r3.status).toBe(200)
      r3.release?.()
    } finally {
      await close(a.server)
      h.restore()
    }
  })
})

describe('relay · forwardWithFailover 429 Retry-After 退避（≤5s 原地重试一次）', () => {
  it('Retry-After: 0 → 立即同候选重试一次并成功，reason 留痕 retried_429:', async () => {
    const h = fakeHome()
    const a = cannedMock([
      { status: 429, retryAfter: '0' },
      { status: 200 },
    ])
    try {
      const cfg = { providers: { a: providerCfg('a', { base_url: await a.url }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      await setSecret('a', 'sk-a', 'file')
      const result = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd())
      expect(result.status).toBe(200)
      expect(a.hits()).toBe(2) // 同候选重试了一次
      expect(result.reason).toBe('retried_429:a')
    } finally {
      await close(a.server)
      h.restore()
    }
  })

  it('HTTP-date 形式（约 100ms 后）→ 等待后重试成功', async () => {
    const h = fakeHome()
    const date = new Date(Date.now() + 100).toUTCString()
    const a = cannedMock([
      { status: 429, retryAfter: date },
      { status: 200 },
    ])
    try {
      const cfg = { providers: { a: providerCfg('a', { base_url: await a.url }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      await setSecret('a', 'sk-a', 'file')
      const result = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd())
      expect(result.status).toBe(200)
      expect(a.hits()).toBe(2)
      expect(result.reason).toBe('retried_429:a')
    } finally {
      await close(a.server)
      h.restore()
    }
  })

  it('重试后仍 429 → 按既有语义原样返回（单候选无白名单不切换）', async () => {
    const h = fakeHome()
    const a = cannedMock([
      { status: 429, retryAfter: '0' },
      { status: 429 },
    ])
    try {
      const cfg = { providers: { a: providerCfg('a', { base_url: await a.url }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      await setSecret('a', 'sk-a', 'file')
      const result = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd())
      expect(result.status).toBe(429)
      expect(a.hits()).toBe(2) // 只重试一次，不无限退避
      expect(result.reason).toBe('retried_429:a')
    } finally {
      await close(a.server)
      h.restore()
    }
  })

  it('Retry-After 超过 5s 上限 → 不原地等待，维持既有 failover 语义（白名单命中则切换）', async () => {
    const h = fakeHome()
    const a = cannedMock([{ status: 429, retryAfter: '30' }])
    const b = cannedMock([{ status: 200 }])
    try {
      const cfg = {
        providers: {
          a: providerCfg('a', { base_url: await a.url }),
          b: providerCfg('b', { base_url: await b.url }),
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers, { failover_status_codes: [429] })
      await setSecret('a', 'sk-a', 'file')
      await setSecret('b', 'sk-b', 'file')
      const result = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd({ fallbackIds: ['b'] }))
      expect(result.usedProviderId).toBe('b')
      expect(a.hits()).toBe(1) // 长等待不重试，直接换候选
      expect(result.reason).toBe('failover_to:b,replayed_from:a')
    } finally {
      await close(a.server)
      await close(b.server)
      h.restore()
    }
  })

  it('额度耗尽的 429 即使带 Retry-After 也不重试（秒级等不回余额），恒可切换语义不变', async () => {
    const h = fakeHome()
    const a = cannedMock([{ status: 429, retryAfter: '0', body: '{"error":{"message":"该模型当前余额已耗尽，请充值后重试"}}' }])
    const b = cannedMock([{ status: 200 }])
    try {
      const cfg = {
        providers: {
          a: providerCfg('a', { base_url: await a.url }),
          b: providerCfg('b', { base_url: await b.url }),
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers)
      await setSecret('a', 'sk-a', 'file')
      await setSecret('b', 'sk-b', 'file')
      const result = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd({ fallbackIds: ['b'] }))
      expect(result.usedProviderId).toBe('b')
      expect(a.hits()).toBe(1) // quota 类不进退避重试
      expect(result.reason).toBe('failover_to:b,replayed_from:a')
    } finally {
      await close(a.server)
      await close(b.server)
      h.restore()
    }
  })
})

describe('gateway e2e · 流式响应占满并发槽直到响应结束（server.ts 释放时机）', () => {
  const TOKEN = 'mdk_conc_test_token'
  it('流未结束期间第二请求排队超时回 429；流结束后新请求正常取槽', async () => {
    const h = fakeHome()
    // 上游 SSE：首个请求发一段后挂起（由测试显式放行结束），后续请求立即回完整流。
    // 用对象持有句柄而非 let 闭包变量：TS 对回调内赋值的 let 会收窄成 null，finish?.() 报 never 不可调用
    const held: { end?: () => void } = {}
    let first = true
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"type":"message_start"}\n\n')
      if (first) {
        first = false
        held.end = () => res.end('data: [DONE]\n\n')
      } else {
        res.end('data: [DONE]\n\n')
      }
    })
    const upUrl = await listen(upstream)
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      security: { store: 'file' },
      providers: {
        a: { name: 'a', base_url: upUrl, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:a', max_concurrency: 1 },
      },
      profiles: { demo: { provider: 'a', default_model: 'm1' } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    const rt = buildRuntime(cfg, 'admin-tok')
    rt.config.gateway = { queue_wait_ms: 150 }
    await setSecret('a', 'sk-a', 'file') // e2e 走真实 getSecret：缺 key 的候选会被 candidateSkip 跳过
    const server = createGatewayServer(rt, { port: 0, autoHolidayRefresh: false, autoCatalogRefresh: false })
    try {
      const gwPort = await listen(server).then((u) => Number(new URL(u).port))
      const post = () => fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm1', messages: [] }),
      })
      const H = { authorization: `Bearer ${TOKEN}` }
      // R1：流式响应开始（网关持有 a 的唯一槽位直到流结束）
      const r1p = post()
      for (let waited = 0; waited < 5_000 && providerConcurrencyStats(rt, 'a').inFlight === 0; waited += 20) {
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(providerConcurrencyStats(rt, 'a')).toEqual({ inFlight: 1, queued: 0 })
      const r1 = await r1p
      expect(r1.status).toBe(200)
      // R2：a 满载 → 排队超时 → 无备用候选 → 429 + hint
      const r2 = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm1', messages: [] }) })
      expect(r2.status).toBe(429)
      const j2 = (await r2.json()) as { error?: { message?: string }; modeldock?: { hint?: string } }
      expect(j2.modeldock?.hint ?? '').toContain('max_concurrency')
      // 流结束后 R1 的槽位释放（网关 finally 先于/晚于客户端收尾皆有可能，轮询等归零），R3 正常取槽成功
      held.end?.()
      expect(await r1.text()).toContain('message_start')
      for (let waited = 0; waited < 5_000 && providerConcurrencyStats(rt, 'a').inFlight > 0; waited += 20) {
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(providerConcurrencyStats(rt, 'a')).toEqual({ inFlight: 0, queued: 0 })
      const r3 = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm1', messages: [] }) })
      expect(r3.status).toBe(200)
      await r3.text()
    } finally {
      server.closeAllConnections?.()
      server.close()
      await close(upstream)
      h.restore()
    }
  }, 45_000) // 显式放宽：真实网络 + 排队等待，且本机可能并行跑其他测试负载（20s 缺省偏紧）
})
/* MARKER-1793722522 */

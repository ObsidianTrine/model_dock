// 燃油成本账（.agents 编排侧）单测：cost 公式（与 src/gateway/pricing.ts 测试同数字对拍）、
// (provider, model) 分桶聚合、价目表获取（admin 面 + 缓存回落）、reconcile 成本附加、
// measureFuel 窗口实测、sail 报告燃油段、stats --cost CLI 端到端。

import { afterAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import { fakeHome } from '../helpers.js'
import { mkRepo, runOrchInproc } from './helpers.js'
import {
  attachCost,
  collectPairs,
  computeCost,
  costOfUsage,
  fmtUsd,
  getPricingTable,
  measureFuel,
  measureFuelBatch,
} from '../../.agents/scripts/orchestrator/cost.mjs'
import { reconcileTask } from '../../.agents/scripts/orchestrator/reconcile.mjs'
import { buildSailReport, buildSailSummary } from '../../.agents/scripts/orchestrator/sail.mjs'

// 本地日期（与 cost.mjs readWindowEntries 同款换算——日文件按本地日切分）
function localDate(ts = Date.now()): string {
  return new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

function writeGatewayLog(fake: string, entries: Array<Record<string, unknown>>): void {
  const dir = path.join(fake, '.modeldock', 'logs')
  fs.mkdirSync(dir, { recursive: true })
  const byDay = new Map<string, string[]>()
  for (const e of entries) {
    const day = localDate(Date.parse(String(e.ts)))
    byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(e)])
  }
  for (const [day, lines] of byDay) fs.writeFileSync(path.join(dir, `gateway-${day}.jsonl`), lines.join('\n') + '\n')
}

function writeEvents(repo: string, id: string, events: Array<Record<string, unknown>>): void {
  const dir = path.join(repo, '.agents', 'orchestrator', 'logs', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

// 价目 mock 网关（POST /_modeldock/pricing-lookup）
async function mockGateway(prices: Record<string, unknown>): Promise<{ url: string; token: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, currency: 'usd', unit: 'per_million_tokens', prices, missing: [] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, token: 'mock-admin', close: () => server.close() }
}

describe('costOfUsage（与 src/gateway/pricing.ts 测试同数字对拍）', () => {
  it('四桶 × 各自单价；cache_* 缺省回落输入价', () => {
    const price = { input: 0.6, output: 2.2, cache_read: 0.11, cache_write: 0 }
    expect(costOfUsage({ input_tokens: 1_000_000, output_tokens: 500_000, cache_read_tokens: 2_000_000, cache_creation_tokens: 100_000 }, price)).toBeCloseTo(1.92, 10)
    expect(costOfUsage({ input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 1_000_000, cache_creation_tokens: 1_000_000 }, { input: 1, output: 2 })).toBeCloseTo(3.0, 10)
  })

  it('fmtUsd：小金额 4 位、常规 2 位', () => {
    expect(fmtUsd(0.001234)).toBe('$0.0012')
    expect(fmtUsd(1.5)).toBe('$1.50')
    expect(fmtUsd(0)).toBe('$0.00')
  })
})

describe('collectPairs / computeCost', () => {
  it('失败请求与无 usage 条目不计；分桶按 provider/model；成本查表逐对计价', () => {
    const entries = [
      { ts: 't', provider: 'up', model: 'm1', status: 200, usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_creation_tokens: 0 } },
      { ts: 't', provider: 'up', model: 'm1', status: 200, usage: { input_tokens: 500_000, output_tokens: 50_000, cache_read_tokens: 0, cache_creation_tokens: 0 } },
      { ts: 't', provider: 'up', model: 'm1', status: 429, usage: { input_tokens: 9_999_999, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } },
      { ts: 't', provider: 'up', model: 'm1', status: 200 },
    ]
    const pairs = collectPairs(entries)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ provider: 'up', model: 'm1', requests: 2, input: 1_500_000, output: 150_000 })
    const table = new Map([['up/m1', { input: 1, output: 2 }]])
    const c = computeCost(pairs, table)
    expect(c.usd).toBeCloseTo(1.5 + 0.3, 10)
    expect(c.requests).toBe(2)
    expect(c.unpriced).toEqual([])
  })

  it('查不到价的进 unpriced（不猜价按 $0 计）', () => {
    const c = computeCost([{ provider: null, model: 'mystery', requests: 1, input: 1, output: 1, cacheRead: 0, cacheCreate: 0 }], new Map())
    expect(c.usd).toBe(0)
    expect(c.unpriced).toEqual(['mystery'])
  })
})

describe('getPricingTable（admin 面 + 缓存回落）', () => {
  const envBackup: Record<string, string | undefined> = {}
  afterAll(() => {
    delete process.env.ORCH_GATEWAY_BASE
    delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
    void envBackup
  })

  it('gatewayAdmin 未开启 → unavailable 不发请求', async () => {
    const repo = mkRepo()
    try {
      const pt = await getPricingTable(repo.root, {}, [{ provider: 'up', model: 'm1' }])
      expect(pt.mode).toBe('unavailable')
      expect(pt.reason).toContain('gatewayAdmin')
    } finally {
      repo.cleanup()
    }
  })

  it('mock 网关 fetched 并写缓存；网关不可达回落 cache', async () => {
    const repo = mkRepo({ extra: { gatewayAdmin: true } })
    const gw = await mockGateway({ 'up/m1': { input: 1, output: 2 }, m2: { input: 0.5, output: 1 } })
    process.env.ORCH_GATEWAY_BASE = gw.url
    process.env.ORCH_GATEWAY_ADMIN_TOKEN = gw.token
    try {
      const pt1 = await getPricingTable(repo.root, { gatewayAdmin: true }, [
        { provider: 'up', model: 'm1', requests: 1 },
        { model: 'm2', requests: 1 },
        { provider: 'up', model: 'm1', requests: 1 }, // 去重
      ])
      expect(pt1.mode).toBe('fetched')
      expect(pt1.table.get('up/m1')).toEqual({ input: 1, output: 2 })
      expect(pt1.table.get('m2')).toEqual({ input: 0.5, output: 1 })
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'pricing-cache.json'))).toBe(true)

      // 网关下线：回落陈价目
      gw.close()
      const pt2 = await getPricingTable(repo.root, { gatewayAdmin: true }, [{ provider: 'up', model: 'm1' }])
      expect(pt2.mode).toBe('cache')
      expect(pt2.table.get('up/m1')).toEqual({ input: 1, output: 2 })
    } finally {
      delete process.env.ORCH_GATEWAY_BASE
      delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
      repo.cleanup()
    }
  })

  it('无网关无缓存 → unavailable（带可操作 reason）', async () => {
    // 隔离：不设 ORCH_GATEWAY_* 时 resolveGatewayAdmin 会做 gateway.json 同机发现——
    // 必须 fakeHome 重定向，否则开发机上有在跑的生产网关（8687）时「无网关」前提被击穿，
    // 用例实际打到生产实例且返回 fetched（2026-11-07 v1.7.1 全量门禁实测踩中）。
    const h = fakeHome()
    const repo = mkRepo({ extra: { gatewayAdmin: true } })
    try {
      const pt = await getPricingTable(repo.root, { gatewayAdmin: true }, [{ provider: 'up', model: 'm1' }])
      expect(pt.mode).toBe('unavailable')
      expect(pt.reason).toBeTruthy()
    } finally {
      repo.cleanup()
      h.restore()
    }
  })
})

describe('reconcileTask pairs + attachCost（成本附加）', () => {
  it('对账产出 (provider, model) 分桶；注入价目表后 r.cost 就位', async () => {
    const repo = mkRepo({ extra: { gatewayLogDir: '~/.modeldock/logs', gatewayAdmin: true } })
    const h = fakeHome()
    try {
      const now = Date.now()
      const iso = (t: number) => new Date(t).toISOString()
      writeEvents(repo.root, 'task-a', [
        { type: 'task_accepted', ts: iso(now - 600_000) },
        { type: 'worker_spawned', ts: iso(now - 500_000) },
        { type: 'budget_snapshot', ts: iso(now - 100_000), tokens_in: 800_000, tokens_out: 40_000 },
        { type: 'merged', ts: iso(now - 60_000) },
      ])
      writeGatewayLog(h.home, [
        { ts: iso(now - 400_000), harness: 'zcode', profile: 'p', provider: 'up', model: 'm1', path: '/v1/messages', status: 200, ms: 30, usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_creation_tokens: 0 } },
        { ts: iso(now - 300_000), harness: 'zcode', profile: 'p', provider: 'up', model: 'm1', path: '/v1/messages', status: 200, ms: 30, usage: { input_tokens: 500_000, output_tokens: 50_000, cache_read_tokens: 0, cache_creation_tokens: 0 } },
      ])
      const r = await reconcileTask(repo.root, 'task-a', path.join(repo.root, '.agents', 'orchestrator', 'queue'))
      expect(r.skipped).toBe(false)
      expect(r.pairs).toHaveLength(1)
      expect(r.pairs[0]).toMatchObject({ provider: 'up', model: 'm1', requests: 2, input: 1_500_000, output: 150_000 })
      await attachCost(repo.root, { gatewayAdmin: true }, [r], { table: new Map([['up/m1', { input: 1, output: 2 }]]) })
      expect(r.cost).toBeTruthy()
      expect(r.cost.usd).toBeCloseTo(1.5 + 0.3, 10)
      expect(r.cost.source).toBe('injected')
    } finally {
      h.restore()
      repo.cleanup()
    }
  })
})

describe('measureFuel（窗口实测 + 逐卡拆账）', () => {
  it('总账 + byCard；零请求窗口如实不可测', async () => {
    const repo = mkRepo({ extra: { gatewayLogDir: '~/.modeldock/logs', gatewayAdmin: true } })
    const h = fakeHome()
    try {
      const now = Date.now()
      const iso = (t: number) => new Date(t).toISOString()
      writeEvents(repo.root, 'card-1', [
        { type: 'task_accepted', ts: iso(now - 600_000) },
        { type: 'worker_spawned', ts: iso(now - 500_000) },
        { type: 'merged', ts: iso(now - 400_000) },
      ])
      writeGatewayLog(h.home, [
        { ts: iso(now - 450_000), provider: 'up', model: 'm1', status: 200, usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_creation_tokens: 0 } },
        { ts: iso(now - 100_000), provider: 'up', model: 'm1', status: 200, usage: { input_tokens: 200_000, output_tokens: 20_000, cache_read_tokens: 0, cache_creation_tokens: 0 } },
      ])
      const fuel = await measureFuel(repo.root, { gatewayAdmin: true, gatewayLogDir: '~/.modeldock/logs' }, {
        start: now - 600_000,
        end: now,
        cardIds: ['card-1'],
        table: new Map([['up/m1', { input: 1, output: 2 }]]),
      })
      // 自定义失败消息（CORRECT-12：偶发红复现时 reason 直接可见，免插桩）——正常通过时零开销
      expect(fuel.measured, `fuel=${JSON.stringify(fuel)}`).toBe(true)
      expect(fuel.usd, `fuel=${JSON.stringify(fuel)}`).toBeCloseTo(1.2 + 0.24, 10) // 总窗：1.2M in + 0.12M out
      expect(fuel.byCard, `fuel=${JSON.stringify(fuel)}`).toHaveLength(1)
      expect(fuel.byCard[0].usd, `byCard0=${JSON.stringify(fuel.byCard?.[0])}`).toBeCloseTo(1.2, 10) // 卡窗只盖第一笔
    } finally {
      h.restore()
      repo.cleanup()
    }
  })

  it('窗口内网关零请求 → measured:false + viaGateway:false（直连上游不可测）', async () => {
    const repo = mkRepo({ extra: { gatewayLogDir: '~/.modeldock/logs', gatewayAdmin: true } })
    const h = fakeHome()
    try {
      const fuel = await measureFuel(repo.root, { gatewayAdmin: true, gatewayLogDir: '~/.modeldock/logs' }, {
        start: Date.now() - 60_000,
        table: new Map(),
      })
      expect(fuel.measured).toBe(false)
      expect(fuel.viaGateway).toBe(false)
      expect(fuel.reason).toContain('零请求')
    } finally {
      h.restore()
      repo.cleanup()
    }
  })

  it('跨午夜窗口：end 日文件不漏读——双笔都在 end 日，旧读法整窗「零请求」误判（CORRECT-12）', async () => {
    const repo = mkRepo({ extra: { gatewayLogDir: '~/.modeldock/logs', gatewayAdmin: true } })
    const h = fakeHome()
    try {
      // 本地午夜锚定（任意时区等价）：窗口 [前一日 23:56, 当日 00:08]，条目全部落在午夜后
      // ——旧读法按 start 的时刻整日推进，永远读不到 end 日文件 → 整窗「零请求」。
      // 夜航基线跑分 2026-11-04 00:08 左右实测命中（known-issues CORRECT-12）。
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      const iso = (t: number) => new Date(t).toISOString()
      writeGatewayLog(h.home, [
        { ts: iso(midnight.getTime() + 60_000), provider: 'up', model: 'm1', status: 200, usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_creation_tokens: 0 } },
        { ts: iso(midnight.getTime() + 360_000), provider: 'up', model: 'm1', status: 200, usage: { input_tokens: 200_000, output_tokens: 20_000, cache_read_tokens: 0, cache_creation_tokens: 0 } },
      ])
      const fuel = await measureFuel(repo.root, { gatewayAdmin: true, gatewayLogDir: '~/.modeldock/logs' }, {
        start: midnight.getTime() - 4 * 60_000,
        end: midnight.getTime() + 8 * 60_000,
        table: new Map([['up/m1', { input: 1, output: 2 }]]),
      })
      expect(fuel.measured, `fuel=${JSON.stringify(fuel)}`).toBe(true)
      expect(fuel.usd).toBeCloseTo(1.2 + 0.24, 10)
    } finally {
      h.restore()
      repo.cleanup()
    }
  })

  it('跨午夜窗口：start 日与 end 日条目都计入——旧读法漏 end 日文件 → 燃油少算（CORRECT-12）', async () => {
    const repo = mkRepo({ extra: { gatewayLogDir: '~/.modeldock/logs', gatewayAdmin: true } })
    const h = fakeHome()
    try {
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      const iso = (t: number) => new Date(t).toISOString()
      writeGatewayLog(h.home, [
        { ts: iso(midnight.getTime() - 3 * 60_000), provider: 'up', model: 'm1', status: 200, usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_creation_tokens: 0 } },
        { ts: iso(midnight.getTime() + 120_000), provider: 'up', model: 'm1', status: 200, usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_creation_tokens: 0 } },
      ])
      const fuel = await measureFuel(repo.root, { gatewayAdmin: true, gatewayLogDir: '~/.modeldock/logs' }, {
        start: midnight.getTime() - 4 * 60_000,
        end: midnight.getTime() + 8 * 60_000,
        table: new Map([['up/m1', { input: 1, output: 2 }]]),
      })
      expect(fuel.measured, `fuel=${JSON.stringify(fuel)}`).toBe(true)
      expect(fuel.usd, `fuel=${JSON.stringify(fuel)}`).toBeCloseTo(2.4, 10) // 两日各 1.2，旧读法只算 1.2
    } finally {
      h.restore()
      repo.cleanup()
    }
  })
})

describe('measureFuelBatch /usage 聚合优先（A3）', () => {
  /** usage 聚合 mock（可按 status 造失败；可选附带 pricing-lookup 服务回落链验证）。 */
  function mockUsageAndPricing({ usageStatus = 200, usagePayload, prices }: { usageStatus?: number; usagePayload?: unknown; prices?: Record<string, unknown> }) {
    let usageHits = 0
    let pricingHits = 0
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const path = req.url?.split('?')[0] ?? ''
        if (path === '/_modeldock/usage') {
          usageHits += 1
          if (req.headers['x-modeldock-admin'] !== 'mock-admin') {
            res.writeHead(401)
            res.end('{}')
            return
          }
          res.writeHead(usageStatus, { 'content-type': 'application/json' })
          res.end(JSON.stringify(usagePayload ?? {}))
          return
        }
        if (path === '/_modeldock/pricing-lookup') {
          pricingHits += 1
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, currency: 'usd', unit: 'per_million_tokens', prices: prices ?? {}, missing: [] }))
          return
        }
        res.writeHead(404)
        res.end('{}')
      })
    })
    return new Promise<{ url: string; usageHits: () => number; pricingHits: () => number; close: () => Promise<void> }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port
        resolve({
          url: `http://127.0.0.1:${port}`,
          usageHits: () => usageHits,
          pricingHits: () => pricingHits,
          close: () => new Promise<void>((done) => server.close(() => done())),
        })
      })
    })
  }

  function setEnv(url?: string) {
    if (url) process.env.ORCH_GATEWAY_BASE = url
    else delete process.env.ORCH_GATEWAY_BASE
    process.env.ORCH_GATEWAY_ADMIN_TOKEN = 'mock-admin'
  }

  const USAGE_OK = {
    ok: true,
    usage: {
      requests: 3,
      ok: 2,
      failed: 1,
      by_status: { '429': 1 },
      by_provider: { up: 3 },
      by_model: { m1: 3 },
      latency: { p50: 10, p95: 20, p99: 30 },
      tokens: { input: 1_000_000, output: 100_000, cache_read: 0, cache_creation: 0 },
      cost: { total: 1.5, by_provider: { up: 1.5 }, by_model: { m1: 1.5 } },
      unpriced_models: null,
    },
  }

  it('admin 可得 → usd/requests 来自网关侧聚合（source=gateway-usage，本侧零价目请求）', async () => {
    const repo = mkRepo({ extra: { gatewayLogDir: '~/.modeldock/logs', gatewayAdmin: true } })
    const h = fakeHome()
    const m = await mockUsageAndPricing({ usagePayload: USAGE_OK, prices: { 'up/m1': { input: 1, output: 2 } } })
    setEnv(m.url)
    try {
      const now = Date.now()
      const batch = await measureFuelBatch(repo.root, { gatewayAdmin: true, gatewayLogDir: '~/.modeldock/logs' }, [
        { key: 'w1', start: now - 600_000, end: now },
      ])
      expect(batch.source).toBe('gateway-usage')
      const r = batch.results.get('w1')
      expect(r).toMatchObject({ measured: true, viaGateway: true, requests: 2, usd: 1.5, unpriced: [] })
      expect(m.pricingHits()).toBe(0) // 价目不需本侧再查——cost 随聚合端点一并返回
    } finally {
      setEnv(undefined)
      await m.close()
      repo.cleanup()
      h.restore()
    }
  })

  it('响应带 billable_partial=true / 缺 billable 字段也照走聚合（成本不消费 billable，刻意不加闸）', async () => {
    const repo = mkRepo({ extra: { gatewayLogDir: '~/.modeldock/logs', gatewayAdmin: true } })
    const h = fakeHome()
    const m = await mockUsageAndPricing({
      usagePayload: { ok: true, usage: { ...USAGE_OK.usage, billable_tokens: 7, billable_partial: true } },
    })
    setEnv(m.url)
    try {
      const now = Date.now()
      const batch = await measureFuelBatch(repo.root, { gatewayAdmin: true, gatewayLogDir: '~/.modeldock/logs' }, [
        { key: 'wp', start: now - 600_000, end: now },
      ])
      // partial 只说明可计费求和不完整，不影响 cost 口径；老网关（响应缺 billable）同款放行
      expect(batch.source).toBe('gateway-usage')
      expect(batch.results.get('wp')).toMatchObject({ measured: true, viaGateway: true, usd: 1.5 })
    } finally {
      setEnv(undefined)
      await m.close()
      repo.cleanup()
      h.restore()
    }
  })

  it('窗口内零请求（ok=0）→ measured:false + 零请求 reason（与文件路径同文案）', async () => {
    const repo = mkRepo({ extra: { gatewayLogDir: '~/.modeldock/logs', gatewayAdmin: true } })
    const h = fakeHome()
    const m = await mockUsageAndPricing({ usagePayload: { ok: true, usage: { ...USAGE_OK, ok: 0, requests: 0 } } })
    setEnv(m.url)
    try {
      const now = Date.now()
      const batch = await measureFuelBatch(repo.root, { gatewayAdmin: true, gatewayLogDir: '~/.modeldock/logs' }, [
        { key: 'w0', start: now - 60_000, end: now },
      ])
      const r = batch.results.get('w0')
      expect(r?.measured).toBe(false)
      expect(r?.viaGateway).toBe(false)
      expect(String((r as { reason?: string })?.reason)).toContain('零请求')
    } finally {
      setEnv(undefined)
      await m.close()
      repo.cleanup()
      h.restore()
    }
  })

  it('端点失败（usage 500）→ 整批落回文件扫描：pricing-lookup 补价，成本来自本地计算', async () => {
    const repo = mkRepo({ extra: { gatewayLogDir: '~/.modeldock/logs', gatewayAdmin: true } })
    const h = fakeHome()
    const m = await mockUsageAndPricing({ usageStatus: 500, prices: { 'up/m1': { input: 1, output: 2 } } })
    setEnv(m.url)
    try {
      const now = Date.now()
      const iso = (t: number) => new Date(t).toISOString()
      writeGatewayLog(h.home, [
        { ts: iso(now - 300_000), provider: 'up', model: 'm1', status: 200, usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_creation_tokens: 0 } },
      ])
      const batch = await measureFuelBatch(repo.root, { gatewayAdmin: true, gatewayLogDir: '~/.modeldock/logs' }, [
        { key: 'wf', start: now - 600_000, end: now },
      ])
      expect(batch.source).not.toBe('gateway-usage') // 文件扫描路径
      expect(m.usageHits()).toBeGreaterThan(0) // 端点确实被试过
      const r = batch.results.get('wf')
      expect(r).toMatchObject({ measured: true, viaGateway: true, requests: 1 })
      expect(r?.usd).toBeCloseTo(1.2, 6)
      expect(m.pricingHits()).toBe(1)
    } finally {
      setEnv(undefined)
      await m.close()
      repo.cleanup()
      h.restore()
    }
  })

  it('显式注入价目表（opts.table）→ 跳过端点（零请求），走文件扫描 + 注入价', async () => {
    const repo = mkRepo({ extra: { gatewayLogDir: '~/.modeldock/logs', gatewayAdmin: true } })
    const h = fakeHome()
    const m = await mockUsageAndPricing({ usagePayload: USAGE_OK })
    setEnv(m.url)
    try {
      const now = Date.now()
      const iso = (t: number) => new Date(t).toISOString()
      writeGatewayLog(h.home, [
        { ts: iso(now - 300_000), provider: 'up', model: 'm1', status: 200, usage: { input_tokens: 500_000, output_tokens: 50_000, cache_read_tokens: 0, cache_creation_tokens: 0 } },
      ])
      const batch = await measureFuelBatch(
        repo.root,
        { gatewayAdmin: true, gatewayLogDir: '~/.modeldock/logs' },
        [{ key: 'wt', start: now - 600_000, end: now }],
        { table: new Map([['up/m1', { input: 1, output: 2 }]]) },
      )
      expect(m.usageHits()).toBe(0) // 注入语义：价目调用方说了算
      expect(batch.source).toBe('injected')
      expect(batch.results.get('wt')).toMatchObject({ measured: true, usd: 0.6 })
    } finally {
      setEnv(undefined)
      await m.close()
      repo.cleanup()
      h.restore()
    }
  })
})

describe('sail 报告燃油段（确定性组装）', () => {
  const voyage = (fuel: Record<string, unknown> | null, root?: string) => ({
    projectName: '测试港',
    root: root ?? null,
    startedAtISO: '2026-11-02T10:00:00Z',
    finishedAtISO: '2026-11-02T11:00:00Z',
    minutes: 60,
    actualMinutes: 60,
    stopReason: '到达时长上限',
    cycles: [],
    baseline: {},
    endState: {},
    diff: { changed: [], added: [] },
    dispatchedTotal: 1,
    goalsText: '',
    ...(fuel ? { fuel } : {}),
  })

  it('measured：列出总账与逐卡拆账 + 未配价提醒', () => {
    const repo = mkRepo()
    try {
      const report = buildSailReport(voyage({ measured: true, usd: 1.2345, requests: 12, source: 'fetched', unpriced: ['mystery'], byCard: [{ id: 'card-1', usd: 1.2 }] }, repo.root))
    expect(report).toContain('## 燃油账')
    expect(report).toContain('$1.23')
    expect(report).toContain('card-1')
    expect(report).toContain('mystery')
      const summary = buildSailSummary(voyage({ measured: true, usd: 1.2345, requests: 12, source: 'fetched', unpriced: [], byCard: [] }, repo.root))
      expect(summary).toContain('燃油 $1.23')
    } finally {
      repo.cleanup()
    }
  })

  it('不可测：如实给原因；无 fuel 字段不出现燃油段（向后兼容旧 voyage）', () => {
    const repo = mkRepo()
    try {
      expect(buildSailReport(voyage({ measured: false, reason: '未启用网关日志' }, repo.root))).toContain('不可测：未启用网关日志')
      expect(buildSailReport(voyage(null, repo.root))).not.toContain('燃油账')
    } finally {
      repo.cleanup()
    }
  })
})

describe('stats --cost CLI 端到端（价目缓存回落路径）', () => {
  it('实测 token × 陈价目 → 行与汇总的 cost_usd（网关不在场，零网络依赖）', async () => {
    const repo = mkRepo({ extra: { gatewayLogDir: '~/.modeldock/logs', gatewayAdmin: true } })
    const h = fakeHome()
    // 预置价目缓存（getPricingTable 的 cache 回落：无 env 网关、gateway.json 缺失 → 读缓存）
    const cacheDir = path.join(repo.root, '.agents', 'orchestrator', 'logs')
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, 'pricing-cache.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), prices: { 'up/m1': { input: 1, output: 2 } } }))
    try {
      const now = Date.now()
      const iso = (t: number) => new Date(t).toISOString()
      writeEvents(repo.root, 'costly', [
        { type: 'task_accepted', ts: iso(now - 300_000) },
        { type: 'worker_spawned', ts: iso(now - 240_000) },
        { type: 'budget_snapshot', ts: iso(now - 100_000), tokens_in: 900_000, tokens_out: 90_000 },
        { type: 'merged', ts: iso(now - 60_000) },
      ])
      writeGatewayLog(h.home, [
        { ts: iso(now - 200_000), harness: 'zcode', profile: 'p', provider: 'up', model: 'm1', path: '/v1/messages', status: 200, ms: 25, usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_creation_tokens: 0 } },
      ])
      const r = await runOrchInproc(repo.root, 'stats --cost --json', { MODELRDOCK_FAKE_HOME: h.home })
      const j = JSON.parse(r.stdout)
      expect(j.rows).toHaveLength(1)
      expect(j.rows[0].cost_usd).toBeCloseTo(1.2, 6)
      expect(j.summary.total_cost_usd).toBeCloseTo(1.2, 6)
      expect(j.summary.cost_reason).toBeUndefined()
    } finally {
      h.restore()
      repo.cleanup()
    }
  })
})

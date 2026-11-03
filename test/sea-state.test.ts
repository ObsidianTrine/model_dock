import http from 'node:http'
import { once } from 'node:events'
import { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { fakeHome, waitFor } from './helpers.js'
import {
  buildRuntime,
  checkTokenLimits,
  logRequest,
  recordOutcome,
  recordSeaOutcome,
  recordTokenUsage,
  seaStateSnapshot,
  seaWindowView,
} from '../src/gateway/state.js'
import { probeProviderModels } from '../src/gateway/modelprobe.js'
import { setSecret } from '../src/config/secrets.js'
import { localIsoTs } from '../src/util/time.js'
import { createGatewayServer } from '../src/gateway/server.js'

// 海况观测（sea-state-observability）：per-provider 滑窗错误分桶 + sea_state 聚合 +
// harness-usage / model-availability 两个 admin 只读端点。mock 上游一律 listen(0) 随机端口，
// 探测节奏用注入间隔（绝不真等 24h / 90s），绝不监听 8687/8890。

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function request(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function startMock(handler: http.RequestListener): Promise<{ base: string; port: number; close: () => void }> {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    close: () => {
      server.closeAllConnections?.()
      server.close()
    },
  }
}

/** 分钟对齐的基准时间戳（1.8e12 恰好是第 30,000,000 个分钟边界）：滑窗断言不受秒级余数干扰 */
const BASE = 1_800_000_000_000
const MINUTE = 60_000

describe('sea 分桶（state/sea.ts，注入时间）', () => {
  it('按错误类分桶计数 + 错误率（total 含成功，中性 4xx 只摊分母）', () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as never, 't')
      recordSeaOutcome(rt, 'up', { ok: true }, BASE)
      recordSeaOutcome(rt, 'up', { ok: false, cls: '429' }, BASE + 1000)
      recordSeaOutcome(rt, 'up', { ok: false, cls: '5xx' }, BASE + 2000)
      recordSeaOutcome(rt, 'up', { ok: false, cls: 'connect' }, BASE + 3000)
      recordSeaOutcome(rt, 'up', { ok: false, cls: 'quota' }, BASE + 4000)
      recordSeaOutcome(rt, 'up', { ok: false }, BASE + 5000) // 中性 4xx：进 total 不进任何类
      const sp = rt.seaErrors!.get('up')!
      const w = seaWindowView(sp, 3_600_000, BASE + 6000)
      expect(w.total).toBe(6)
      expect(w['429']).toBe(1)
      expect(w['5xx']).toBe(1)
      expect(w.connect).toBe(1)
      expect(w.quota).toBe(1)
      expect(w.error_rate).toBeCloseTo(4 / 6, 4)
      expect(sp.lastErrorCls).toBe('quota') // 中性 4xx 不顶掉 lastError 归属
      expect(sp.lastErrorAt).toBe(BASE + 4000)
    } finally {
      h.restore()
    }
  })

  it('5min/60min 窗口各自聚合；滑出窗口的数据不再计入（注入 now，不真等）', () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as never, 't')
      recordSeaOutcome(rt, 'up', { ok: false, cls: '5xx' }, BASE)
      recordSeaOutcome(rt, 'up', { ok: false, cls: '5xx' }, BASE + 4 * MINUTE)
      const sp = rt.seaErrors!.get('up')!
      // 5min 视图（BASE+6min）：首桶 [BASE, BASE+60s) 已整桶滑出，只剩 +4min 那桶
      // （分钟桶粒度：与窗口有交集的桶整桶计入，窗口边缘按分钟量化）
      expect(seaWindowView(sp, 5 * MINUTE, BASE + 6 * MINUTE).total).toBe(1)
      // 60min 视图：两桶都在窗口内
      const w60 = seaWindowView(sp, 60 * MINUTE, BASE + 6 * MINUTE)
      expect(w60.total).toBe(2)
      expect(w60['5xx']).toBe(2)
      // 65min 后：连 +4min 那桶（61min 龄）也滑出 60min 窗口
      const later = seaWindowView(sp, 60 * MINUTE, BASE + 65 * MINUTE)
      expect(later.total).toBe(0)
      expect(later.error_rate).toBe(0)
    } finally {
      h.restore()
    }
  })

  it('60 槽环形复用：60min 后同槽原地清零重写，无界增长不存在', () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as never, 't')
      recordSeaOutcome(rt, 'up', { ok: false, cls: '429' }, BASE)
      const sp = rt.seaErrors!.get('up')!
      expect(sp.slots.filter(Boolean)).toHaveLength(1)
      recordSeaOutcome(rt, 'up', { ok: true }, BASE + 60 * MINUTE) // minute+60 → 同一槽位
      expect(sp.slots.filter(Boolean)).toHaveLength(1) // 旧桶被覆盖，槽数不增
      const w = seaWindowView(sp, 60 * MINUTE, BASE + 60 * MINUTE)
      expect(w.total).toBe(1) // 只剩新记录
      expect(w['429']).toBe(0)
    } finally {
      h.restore()
    }
  })

  it('recordOutcome 顺带记账（同源事件流）：熔断判定照旧，海况分桶同步产生', () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as never, 't')
      recordOutcome(rt, 'up', { ok: true, ms: 42 })
      recordOutcome(rt, 'up', { ok: false, cls: '429' })
      recordOutcome(rt, 'up', { ok: false }) // 中性 4xx
      const sp = rt.seaErrors!.get('up')!
      const w = seaWindowView(sp, 3_600_000)
      expect(w.total).toBe(3)
      expect(w['429']).toBe(1)
      expect(rt.health.get('up')!.okStreak).toBe(0) // 熔断侧逻辑不受影响（429 计失败）
    } finally {
      h.restore()
    }
  })
})

describe('sea_state 风暴判定（常量集中 sea.ts 顶部）', () => {
  const up = { base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' }

  it('无任何数据：storm=false、reasons 空、meltdown_count=0、updated_at 可解析', () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime({ providers: { up }, profiles: {}, harness: {} } as never, 't')
      const st = seaStateSnapshot(rt)
      expect(st).toMatchObject({ storm: false, reasons: [], meltdown_count: 0 })
      expect(Number.isNaN(Date.parse(st.updated_at))).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('过半熔断：单服务部署熔断 1/1 即风暴；两服务熔断 1/2 不到半不风暴', () => {
    const h = fakeHome()
    try {
      const single = buildRuntime({ providers: { only: up }, profiles: {}, harness: {} } as never, 't')
      for (let i = 0; i < 3; i++) recordOutcome(single, 'only', { ok: false, cls: 'quota' })
      const s1 = seaStateSnapshot(single)
      expect(s1.meltdown_count).toBe(1)
      expect(s1.storm).toBe(true)
      expect(s1.reasons).toContain('meltdown_majority')

      const pair = buildRuntime({ providers: { a: up, b: up }, profiles: {}, harness: {} } as never, 't')
      for (let i = 0; i < 3; i++) recordOutcome(pair, 'a', { ok: false, cls: 'quota' })
      const s2 = seaStateSnapshot(pair)
      expect(s2.meltdown_count).toBe(1)
      expect(s2.storm).toBe(false) // 1 > 2×0.5 不成立
      expect(s2.reasons).toEqual([])
    } finally {
      h.restore()
    }
  })

  it('60min 合计 429 率 ≥0.3 且样本 ≥20 才风暴；低样本是噪声不判', () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime({ providers: { up }, profiles: {}, harness: {} } as never, 't')
      for (let i = 0; i < 20; i++) recordSeaOutcome(rt, 'up', { ok: true })
      for (let i = 0; i < 10; i++) recordSeaOutcome(rt, 'up', { ok: false, cls: '429' })
      const st = seaStateSnapshot(rt)
      expect(st.storm).toBe(true)
      expect(st.reasons).toContain('rate_429_60m')

      const small = buildRuntime({ providers: { up }, profiles: {}, harness: {} } as never, 't')
      for (let i = 0; i < 10; i++) recordSeaOutcome(small, 'up', { ok: true })
      for (let i = 0; i < 5; i++) recordSeaOutcome(small, 'up', { ok: false, cls: '429' }) // 33% 但 total=15 < 20
      const st2 = seaStateSnapshot(small)
      expect(st2.storm).toBe(false)
      expect(st2.reasons).toEqual([])
    } finally {
      h.restore()
    }
  })

  it('已下线（enabled:false）服务不计入风暴：不进熔断分母、分桶也不进 429 合计', () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime({ providers: { up, ghost: { ...up, enabled: false } }, profiles: {}, harness: {} } as never, 't')
      for (let i = 0; i < 30; i++) recordSeaOutcome(rt, 'ghost', { ok: false, cls: '429' })
      const st = seaStateSnapshot(rt)
      expect(st.storm).toBe(false)
      expect(st.reasons).toEqual([])
    } finally {
      h.restore()
    }
  })
})

describe('GET /_modeldock/harness-usage（admin 只读，E2E）', () => {
  it('401 门禁；per-harness rpm/当日 token 读取；未配 limits 的 harness 无条目', async () => {
    const h = fakeHome()
    try {
      const cfg = {
        providers: { up: { base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' } },
        profiles: { default: { provider: 'up', default_model: 'm1' } },
        harness: {
          zcode: { mode: 'gateway', route: 'default', token: 'tok-z', limits: { rpm: 100, daily_tokens: 999999 } },
          bare: { mode: 'gateway', route: 'default', token: 'tok-b' }, // 无 limits → checkTokenLimits 不建条目
        },
      } as never
      const rt = buildRuntime(cfg, 'admin-token-sea')
      for (let i = 0; i < 3; i++) checkTokenLimits(rt, 'zcode')
      recordTokenUsage(rt, 'zcode', { input_tokens: 100, output_tokens: 25, cache_read_tokens: 5, cache_creation_tokens: 0 })
      const server = createGatewayServer(rt, { port: 0, autoHolidayRefresh: false, autoCatalogRefresh: false, autoModelProbe: false })
      const port = await listenEphemeral(server)
      try {
        const noAuth = await request(port, '/_modeldock/harness-usage')
        expect(noAuth.status).toBe(401)
        const res = await request(port, '/_modeldock/harness-usage', { 'x-modeldock-admin': 'admin-token-sea' })
        expect(res.status).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(true)
        const z = body.usage.zcode
        expect(z.rpm).toBe(3)
        expect(z.day_tokens).toBe(130) // 100 + 25 + 5（缓存读计入）
        expect(z.day).toBe(localIsoTs().slice(0, 10))
        expect(Number.isNaN(Date.parse(z.rpm_started_at))).toBe(false)
        expect(body.usage.bare).toBeUndefined()
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    } finally {
      h.restore()
    }
  })
})

describe('metrics 海况扩展（E2E，只增不改）', () => {
  const ADMIN = { 'x-modeldock-admin': 'admin-token-sea' }

  it('sea_state 聚合 + providers[].errors 滑窗分桶；与既有耗时字段并存', async () => {
    const h = fakeHome()
    try {
      const cfg = {
        providers: { up: { base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' } },
        profiles: { default: { provider: 'up', default_model: 'm1' } },
        harness: {},
      } as never
      const rt = buildRuntime(cfg, 'admin-token-sea')
      // 纯 recordOutcome（无 logRequest）：providers.up 只有 errors 侧（键并集语义）
      for (let i = 0; i < 3; i++) recordOutcome(rt, 'up', { ok: false, cls: 'quota' })
      const server = createGatewayServer(rt, { port: 0, autoHolidayRefresh: false, autoCatalogRefresh: false, autoModelProbe: false })
      const port = await listenEphemeral(server)
      try {
        const m = JSON.parse((await request(port, '/_modeldock/metrics', ADMIN)).body)
        expect(m.providers.up.count).toBeUndefined()
        expect(m.providers.up.errors.last_60m).toMatchObject({ total: 3, quota: 3, error_rate: 1 })
        expect(m.providers.up.errors.last_5m).toMatchObject({ total: 3, quota: 3 })
        expect(m.sea_state).toMatchObject({ storm: true, reasons: ['meltdown_majority'], meltdown_count: 1 })
        expect(Number.isNaN(Date.parse(m.sea_state.updated_at))).toBe(false)
        // 既有熔断数组语义不变（只增不改）
        expect(m.meltdown).toHaveLength(1)
        expect(m.meltdown[0]).toMatchObject({ provider: 'up', class: 'quota' })
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    } finally {
      h.restore()
    }
  })

  it('耗时采样与海况分桶同provider并存：count/last_ms/p50 与 errors 互不挤占', async () => {
    const h = fakeHome()
    try {
      const cfg = {
        providers: { up: { base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' } },
        profiles: { default: { provider: 'up', default_model: 'm1' } },
        harness: {},
      } as never
      const rt = buildRuntime(cfg, 'admin-token-sea')
      logRequest(rt, { ts: localIsoTs(), harness: 'c', profile: 'p', provider: 'up', path: '/v1/messages', status: 200, ms: 20 })
      recordOutcome(rt, 'up', { ok: true, ms: 20 })
      const server = createGatewayServer(rt, { port: 0, autoHolidayRefresh: false, autoCatalogRefresh: false, autoModelProbe: false })
      const port = await listenEphemeral(server)
      try {
        const m = JSON.parse((await request(port, '/_modeldock/metrics', ADMIN)).body)
        expect(m.providers.up.count).toBe(1)
        expect(m.providers.up.last_ms).toBe(20)
        expect(m.providers.up.errors.last_60m.total).toBe(1) // 只有 recordOutcome 那条进分桶
        expect(m.providers.up.errors.last_60m.error_rate).toBe(0)
        expect(m.sea_state.storm).toBe(false)
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    } finally {
      h.restore()
    }
  })
})

describe('GET /_modeldock/model-availability 与周期探测（E2E，mock 上游 + 注入间隔）', () => {
  const ADMIN = { 'x-modeldock-admin': 'admin-token-sea' }

  it('注入短首查（50ms）：成功/失败/无key/已下线四态齐备；401 门禁；失败负缓存带原因', async () => {
    const h = fakeHome()
    const okMock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-a' }, { id: 'mock-b' }] }))
    })
    const failMock = await startMock((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
    try {
      const okRef = await setSecret('sea-probe-ok', 'sk-ok', 'file')
      const badRef = await setSecret('sea-probe-bad', 'sk-bad', 'file')
      const cfg = {
        providers: {
          up: { base_url: `${okMock.base}/v1`, protocol: 'openai', auth_style: 'bearer', key_ref: okRef },
          bad: { base_url: `${failMock.base}/v1`, protocol: 'openai', auth_style: 'bearer', key_ref: badRef },
          nokey: { base_url: `${okMock.base}/v1`, protocol: 'openai', auth_style: 'bearer', key_ref: 'file:sea-probe-missing' },
          off: { base_url: `${okMock.base}/v1`, protocol: 'openai', auth_style: 'bearer', key_ref: okRef, enabled: false },
        },
        profiles: {},
        harness: {},
      } as never
      const rt = buildRuntime(cfg, 'admin-token-sea')
      const server = createGatewayServer(rt, {
        port: 0,
        autoHolidayRefresh: false,
        autoCatalogRefresh: false,
        // autoModelProbe 缺省开启：注入 50ms 首查 + 长间隔（本轮探测后不再触发）
        modelProbeIntervals: { initialDelayMs: 50, intervalMs: 600_000 },
      })
      const port = await listenEphemeral(server)
      try {
        expect((await request(port, '/_modeldock/model-availability')).status).toBe(401)
        // 首查 50ms 后触发：轮询等 up 与 bad 两个结果落内存
        await waitFor(async () => {
          const b = JSON.parse((await request(port, '/_modeldock/model-availability', ADMIN)).body)
          return !!b.availability.up && !!b.availability.bad
        })
        const body = JSON.parse((await request(port, '/_modeldock/model-availability', ADMIN)).body)
        expect(body.ok).toBe(true)
        expect(body.availability.up).toMatchObject({ ok: true, model_ids: ['mock-a', 'mock-b'] })
        expect(Number.isNaN(Date.parse(body.availability.up.fetched_at))).toBe(false)
        expect(body.availability.bad.ok).toBe(false)
        expect(body.availability.bad.error).toContain('HTTP 404')
        expect(Number.isNaN(Date.parse(body.availability.bad.fetched_at))).toBe(false)
        // 缺席语义：从未探测（无 key / 已下线）≠ 不可用，不出现在结果里
        expect(body.availability.nokey).toBeUndefined()
        expect(body.availability.off).toBeUndefined()
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    } finally {
      okMock.close()
      failMock.close()
      h.restore()
    }
  })

  it('probeProviderModels 并发去重（inflight）：探测中重复触发只打一次上游，完成后可再探', async () => {
    const h = fakeHome()
    let hits = 0
    const slow = await startMock((_req, res) => {
      hits += 1
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'm1' }] }))
      }, 150)
    })
    try {
      const ref = await setSecret('sea-inflight-key', 'sk-x', 'file')
      const rt = buildRuntime(
        { providers: { up: { base_url: `${slow.base}/v1`, protocol: 'openai', auth_style: 'bearer', key_ref: ref } }, profiles: {}, harness: {} } as never,
        't'
      )
      await Promise.all([probeProviderModels(rt, 'up'), probeProviderModels(rt, 'up'), probeProviderModels(rt, 'up')])
      expect(hits).toBe(1) // 在飞去重：三个并发只打一次
      expect(rt.modelProbe!.results.get('up')).toMatchObject({ ok: true, model_ids: ['m1'] })
      await probeProviderModels(rt, 'up')
      expect(hits).toBe(2) // 完成后再探不被 inflight 卡死
    } finally {
      slow.close()
      h.restore()
    }
  })
})

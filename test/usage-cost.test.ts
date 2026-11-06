// 成本核算（src 侧）单测：单价解析（pricing.json 覆盖 + 目录兜底）、cost 公式、
// usage 聚合 cost 维度、今日用量仪表、pricing-lookup 端点（E2E）。
// 口径与 .agents/scripts/orchestrator/cost.mjs 逐字段一致——两边测试持同一组期望值对拍
// （orchestrator/cost.test.ts 的 mirror 用例数字必须与本文件一致）。

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import {
  buildRuntime,
  createUsageAccumulator,
  logRequest,
  resetUsageTodayForTest,
  setUsagePriceResolver,
  summarizeUsage,
  usageTodayView,
  type LogEntry,
} from '../src/gateway/state.js'
import { normalizeApiCatalog } from '../src/providers/catalog.js'
import { clearCatalogMemo } from '../src/providers/catalog.js'
import {
  clearPricingMemo,
  costOfUsage,
  gatewayPriceResolver,
  loadPricingOverrides,
  lookupPrice,
  saneModelCost,
} from '../src/gateway/pricing.js'
import { localIsoTs } from '../src/util/time.js'
import { createGatewayServer } from '../src/gateway/server.js'

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function request(port: number, reqPath: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, headers, method: body ? 'POST' : 'GET' }, (res) => {
      let out = ''
      res.on('data', (c) => (out += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

afterEach(() => {
  resetUsageTodayForTest()
  clearPricingMemo()
  clearCatalogMemo()
})

describe('saneModelCost / costOfUsage（计费口径）', () => {
  it('合法价保留、非法价丢弃；成本 = 四桶 token × 各自单价 / 1e6', () => {
    expect(saneModelCost({ input: 0.6, output: 2.2, cache_read: 0.11, cache_write: 0 })).toEqual({ input: 0.6, output: 2.2, cache_read: 0.11, cache_write: 0 })
    expect(saneModelCost({ input: 'x', output: 2 })).toBeUndefined()
    expect(saneModelCost({ input: -1, output: 2 })).toBeUndefined()
    expect(saneModelCost(null)).toBeUndefined()

    const price = { input: 0.6, output: 2.2, cache_read: 0.11, cache_write: 0 }
    // 1M 输入 + 0.5M 输出 + 2M 缓存读 + 0.1M 缓存建 = 0.6 + 1.1 + 0.22 + 0 = 1.92 USD
    expect(costOfUsage({ input_tokens: 1_000_000, output_tokens: 500_000, cache_read_tokens: 2_000_000, cache_creation_tokens: 100_000 }, price)).toBeCloseTo(1.92, 10)
  })

  it('cache_* 单价缺省回落输入价（宁可高估不低估）', () => {
    const price = { input: 1, output: 2 }
    // 1M 输入 + 1M 缓存读 + 1M 缓存建 = 1 + 1 + 1 = 3 USD（回落价=输入价 1）
    expect(costOfUsage({ input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 1_000_000, cache_creation_tokens: 1_000_000 }, price)).toBeCloseTo(3.0, 10)
    expect(costOfUsage({}, price)).toBe(0)
  })
})

describe('loadPricingOverrides / lookupPrice（覆盖 > 目录）', () => {
  it('缺失 = 无覆盖（常态）；provider/model 作用域 > 裸模型名 > 目录', () => {
    const h = fakeHome()
    try {
      expect(loadPricingOverrides()).toEqual({ data: {}, skipped: 0 })
      // 目录兜底：glm-4.6 在捆绑快照里（多个厂商同名条目，flat 表首见优先——不硬编码具体价，
      // 只断言命中且非零；快照数据漂移不破测试）
      const base = lookupPrice(undefined, 'glm-4.6')
      expect(base).not.toBeNull()
      expect(base!.input).toBeGreaterThan(0)
      expect(lookupPrice('zhipuai', 'glm-4.6')).toEqual(base) // 目录查价不区分 provider（作用域仅覆盖文件支持）

      fs.mkdirSync(path.join(process.env.MODELRDOCK_FAKE_HOME!, '.modeldock'), { recursive: true })
      fs.writeFileSync(
        path.join(process.env.MODELRDOCK_FAKE_HOME!, '.modeldock', 'pricing.json'),
        JSON.stringify({ 'glm-4.6': { input: 0.1, output: 0.2 }, 'ark/glm-4.6': { input: 0.05, output: 0.06 } })
      )
      clearPricingMemo()
      expect(lookupPrice('ark', 'glm-4.6')).toEqual({ input: 0.05, output: 0.06 }) // 作用域覆盖
      expect(lookupPrice('other', 'glm-4.6')).toEqual({ input: 0.1, output: 0.2 }) // 裸名覆盖跨服务商
      expect(lookupPrice(undefined, 'glm-4.6')).toEqual({ input: 0.1, output: 0.2 })
    } finally {
      h.restore()
    }
  })

  it('非法条目跳过计数不整文件拒绝；顶层非法整文件忽略 + error', () => {
    const h = fakeHome()
    try {
      const dir = path.join(process.env.MODELRDOCK_FAKE_HOME!, '.modeldock')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'pricing.json'), JSON.stringify({ good: { input: 1, output: 2 }, bad: { input: 'x' } }))
      clearPricingMemo()
      const r1 = loadPricingOverrides()
      expect(r1.data.good).toEqual({ input: 1, output: 2 })
      expect(r1.skipped).toBe(1)
      expect(r1.error).toBeTruthy()

      fs.writeFileSync(path.join(dir, 'pricing.json'), '[1,2]')
      clearPricingMemo()
      const r2 = loadPricingOverrides()
      expect(r2.data).toEqual({})
      expect(r2.error).toBeTruthy()
    } finally {
      h.restore()
    }
  })
})

describe('normalizeApiCatalog 保留 cost 字段', () => {
  it('合法 cost 透传；缺 cost / 畸形 cost 不炸条目', () => {
    const out = normalizeApiCatalog(
      {
        p: {
          models: {
            m1: { limit: { context: 128000 }, cost: { input: 0.5, output: 2, cache_read: 0.1, cache_write: 0 } },
            m2: { limit: { context: 128000 } },
            m3: { limit: { context: 128000 }, cost: { input: 'x', output: 1 } },
          },
        },
      },
      '2026-11-02T00:00:00Z'
    )
    expect(out.providers.p.models.m1.cost).toEqual({ input: 0.5, output: 2, cache_read: 0.1, cache_write: 0 })
    expect(out.providers.p.models.m2.cost).toBeUndefined()
    expect(out.providers.p.models.m3.cost).toBeUndefined()
  })
})

describe('usage 聚合 cost 维度（createUsageAccumulator）', () => {
  const entry = (over: Partial<LogEntry>): LogEntry =>
    ({
      ts: '2026-11-02T10:00:00.000+08:00',
      harness: 'c',
      profile: 'p',
      provider: 'zhipuai',
      model: 'glm-4.6',
      path: '/v1/messages',
      status: 200,
      usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_creation_tokens: 0 },
      ...over,
    }) as LogEntry

  it('注入 resolver：成本按 (provider, model) 累计；查不到价的进 unpriced', () => {
    const priceOf = (provider: string | undefined, model: string | undefined) =>
      model === 'glm-4.6' ? { input: 0.6, output: 2.2 } : null
    const s = summarizeUsage([entry({}), entry({ model: 'mystery-model' }), entry({ status: 500 })], priceOf)
    // 1M×0.6 + 0.1M×2.2 = 0.82；失败请求与无 usage 请求不计
    expect(s.cost!.total).toBeCloseTo(0.82, 10)
    expect(s.cost!.by_model['glm-4.6']).toBeCloseTo(0.82, 10)
    expect(s.cost!.by_provider.zhipuai).toBeCloseTo(0.82, 10)
    expect(s.unpriced_models).toEqual(['mystery-model'])
  })

  it('不注入 resolver：cost/unpriced 为 null（既有调用面零变化）', () => {
    const s = summarizeUsage([entry({})])
    expect(s.cost).toBeNull()
    expect(s.unpriced_models).toBeNull()
    expect(s.tokens.input).toBe(1_000_000)
  })

  it('createUsageAccumulator 与 summarizeUsage 同口径（流式路径共享累加器）', () => {
    const priceOf = () => ({ input: 1, output: 1 }) as const
    const acc = createUsageAccumulator(priceOf)
    acc.add(entry({}))
    acc.add(entry({ model: 'mystery-model' }))
    const streamed = acc.summary()
    const arrayed = summarizeUsage([entry({}), entry({ model: 'mystery-model' })], priceOf)
    expect(streamed.cost!.total).toBeCloseTo(arrayed.cost!.total, 12)
  })
})

describe('今日用量仪表（usageTodayView：重启回填 + 实时增量）', () => {
  it('回填当日日文件 + logRequest 增量记账，跨 fakeHome 重置', () => {
    const h = fakeHome()
    // 查价器由 daemon 启动注入（perf-p2-polish 前置拆叶）：测试里等价接上，收尾复位防泄漏
    setUsagePriceResolver(gatewayPriceResolver)
    try {
      const base = lookupPrice(undefined, 'glm-4.6')! // 快照目录价（flat 首见，不硬编码）
      const today = localIsoTs().slice(0, 10)
      const logs = path.join(process.env.MODELRDOCK_FAKE_HOME!, '.modeldock', 'logs')
      fs.mkdirSync(logs, { recursive: true })
      const line = (over: Record<string, unknown>) =>
        JSON.stringify({
          ts: `${today}T10:00:00.000+08:00`,
          harness: 'c',
          profile: 'p',
          provider: 'zhipuai',
          model: 'glm-4.6',
          path: '/v1/messages',
          status: 200,
          ms: 20,
          usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_creation_tokens: 0 },
          ...over,
        })
      // 重启回填：直接落当日日文件（网关崩溃前的旧流量）
      fs.writeFileSync(path.join(logs, `gateway-${today}.jsonl`), line({}) + '\n' + line({ status: 429 }) + '\n')
      const v1 = usageTodayView()
      expect(v1.date).toBe(today)
      expect(v1.requests).toBe(2)
      expect(v1.ok).toBe(1)
      expect(v1.failed).toBe(1)
      expect(v1.cost!.total).toBeCloseTo(base.input + base.output * 0.1, 10) // 1M 输入 + 0.1M 输出
      expect(v1.unpriced_models).toEqual([])

      // 实时增量：logRequest 热路径记账
      const rt = { ring: [], metricsLatency: new Map() } as never
      logRequest(rt, {
        ts: `${today}T11:00:00.000+08:00`,
        harness: 'c',
        profile: 'p',
        provider: 'zhipuai',
        model: 'glm-4.6',
        path: '/v1/messages',
        status: 200,
        ms: 30,
        usage: { input_tokens: 500_000, output_tokens: 50_000, cache_read_tokens: 0, cache_creation_tokens: 0 },
      } as LogEntry)
      const v2 = usageTodayView()
      expect(v2.requests).toBe(3)
      expect(v2.cost!.total).toBeCloseTo(base.input * 1.5 + base.output * 0.15, 10)
    } finally {
      setUsagePriceResolver(undefined)
      h.restore()
    }
  })
})

describe('pricing-lookup 与 usage 端点（E2E，admin 门内）', () => {
  it('pricing-lookup：目录价命中 / missing 不猜价 / 400 无 models', async () => {
    const h = fakeHome()
    try {
      const base = lookupPrice(undefined, 'glm-4.6')! // 快照目录价（flat 首见，不硬编码）
      const cfg = {
        providers: { up: { base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' } },
        profiles: { default: { provider: 'up', default_model: 'm1' } },
        harness: {},
      } as never
      const rt = buildRuntime(cfg, 'admin-token-cost')
      const server = createGatewayServer(rt, { port: 0 })
      const port = await listenEphemeral(server)
      try {
        const noAuth = await request(port, '/_modeldock/pricing-lookup', { 'content-type': 'application/json' }, JSON.stringify({ models: ['glm-4.6'] }))
        expect(noAuth.status).toBe(401) // admin 门内
        const r = await request(port, '/_modeldock/pricing-lookup', { 'x-modeldock-admin': 'admin-token-cost', 'content-type': 'application/json' }, JSON.stringify({ models: ['glm-4.6', { provider: 'ark', model: 'glm-4.6' }, 'no-such-model'] }))
        expect(r.status).toBe(200)
        const j = JSON.parse(r.body)
        expect(j.ok).toBe(true)
        expect(j.currency).toBe('usd')
        expect(j.prices['glm-4.6']).toMatchObject({ input: base.input, output: base.output })
        expect(j.prices['ark/glm-4.6']).toMatchObject({ input: base.input, output: base.output })
        expect(j.missing).toEqual(['no-such-model'])
        const bad = await request(port, '/_modeldock/pricing-lookup', { 'x-modeldock-admin': 'admin-token-cost', 'content-type': 'application/json' }, JSON.stringify({}))
        expect(bad.status).toBe(400)
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    } finally {
      h.restore()
    }
  })

  it('/_modeldock/usage 缺省带 cost；cost=0 关闭；pricing.json 非法时 pricing_error 浮出', async () => {
    const h = fakeHome()
    try {
      const base = lookupPrice(undefined, 'glm-4.6')! // 快照目录价（flat 首见，不硬编码）
      const expectCost = (inputM: number, outputM: number) => base.input * inputM + base.output * outputM
      const cfg = {
        providers: { up: { base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' } },
        profiles: { default: { provider: 'up', default_model: 'm1' } },
        harness: {},
      } as never
      const rt = buildRuntime(cfg, 'admin-token-cost')
      const server = createGatewayServer(rt, { port: 0 })
      const port = await listenEphemeral(server)
      const admin = { 'x-modeldock-admin': 'admin-token-cost' }
      try {
        const today = localIsoTs().slice(0, 10)
        logRequest(rt, {
          ts: `${today}T10:00:00.000+08:00`,
          harness: 'c',
          profile: 'p',
          provider: 'zhipuai',
          model: 'glm-4.6',
          path: '/v1/messages',
          status: 200,
          ms: 20,
          usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_creation_tokens: 0 },
        } as LogEntry)
        const r1 = JSON.parse((await request(port, `/_modeldock/usage?date=${today}`, admin)).body)
        expect(r1.usage.cost.total).toBeCloseTo(expectCost(1, 0.1), 10)
        expect(r1.usage.unpriced_models).toEqual([])
        expect(r1.pricing_error).toBeNull()
        const r2 = JSON.parse((await request(port, `/_modeldock/usage?date=${today}&cost=0`, admin)).body)
        expect(r2.usage.cost).toBeNull()

        // 覆盖文件非法：error 浮出（不阻断聚合）
        fs.mkdirSync(path.join(process.env.MODELRDOCK_FAKE_HOME!, '.modeldock'), { recursive: true })
        fs.writeFileSync(path.join(process.env.MODELRDOCK_FAKE_HOME!, '.modeldock', 'pricing.json'), '{oops')
        clearPricingMemo()
        const r3 = JSON.parse((await request(port, `/_modeldock/usage?date=${today}`, admin)).body)
        expect(r3.pricing_error).toBeTruthy()
        expect(r3.usage.cost.total).toBeCloseTo(expectCost(1, 0.1), 10) // 目录价兜底照算
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    } finally {
      h.restore()
    }
  })
})

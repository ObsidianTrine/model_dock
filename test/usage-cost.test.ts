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
  type UsageSummary,
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

describe('usage 聚合 billable 维度（createUsageAccumulator：条目已算好，只求和不重算）', () => {
  const entry = (over: Partial<LogEntry>): LogEntry =>
    ({
      ts: '2026-11-02T10:00:00.000+08:00',
      harness: 'c',
      profile: 'p',
      provider: 'zhipuai',
      model: 'glm-4.6',
      path: '/v1/messages',
      status: 200,
      usage: { input_tokens: 1_000, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
      ...over,
    }) as LogEntry

  it('全新条目求和正确（剔除缓存读的公式在条目上，聚合不加总口径字段）', () => {
    const s = summarizeUsage([
      entry({ usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 90000, cache_creation_tokens: 500, billable_tokens: 3500 } }),
      entry({ usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0, billable_tokens: 110 } }),
    ])
    expect(s.billable_tokens).toBe(3610)
    expect(s.billable_partial).toBe(false)
    // 总口径 tokens 不受 billable 影响（既有字段口径不变）
    expect(s.tokens.input).toBe(91600)
  })

  it('混入旧格式条目（usage 缺 billable_tokens 数字）→ partial=true 且和为可得部分', () => {
    const s = summarizeUsage([
      entry({ usage: { input_tokens: 500, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0, billable_tokens: 550 } }),
      entry({ usage: { input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } }), // 旧版网关日志
    ])
    expect(s.billable_tokens).toBe(550)
    expect(s.billable_partial).toBe(true)
  })

  it('无 usage 条目的窗口 → 0/false（空窗口语义）；失败条目不进和（与 tokens 同口径）', () => {
    const s = summarizeUsage([entry({ usage: undefined }), entry({ status: 429, usage: undefined })])
    expect(s.billable_tokens).toBe(0)
    expect(s.billable_partial).toBe(false)
    // 失败条目即便携带 usage 也不计（实测口径 = 成功且有 usage，与 tokens/cost 一致）
    const f = summarizeUsage([
      entry({ status: 500, usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, billable_tokens: 999_999 } }),
    ])
    expect(f.billable_tokens).toBe(0)
    expect(f.billable_partial).toBe(false)
  })
})

describe('usage 聚合 tokens_by_model 维度（模型级容灾观测：per-model token 四桶）', () => {
  const entry = (over: Partial<LogEntry>): LogEntry =>
    ({
      ts: '2026-11-02T10:00:00.000+08:00',
      harness: 'c',
      profile: 'p',
      provider: 'zhipuai',
      model: 'glm-5.3-flash',
      path: '/v1/messages',
      status: 200,
      usage: { input_tokens: 1_000, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
      ...over,
    }) as LogEntry

  it('多模型多请求：四桶按 model 分桶，全局 tokens 桶不受影响', () => {
    const s = summarizeUsage([
      entry({ usage: { input_tokens: 1_000, output_tokens: 100, cache_read_tokens: 200, cache_creation_tokens: 50 } }),
      entry({ usage: { input_tokens: 500, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 } }),
      entry({ model: 'glm-5.2', usage: { input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } }),
    ])
    // input_tokens 与全局 tokens 同口径：缓存读 + 缓存建计入
    expect(s.tokens_by_model!['glm-5.3-flash']).toEqual({
      input_tokens: 1_000 + 200 + 50 + 500,
      output_tokens: 120,
      cache_read_tokens: 200,
      cache_creation_tokens: 50,
    })
    expect(s.tokens_by_model!['glm-5.2']).toEqual({ input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 })
    // 全局 tokens 桶不变（既有口径零变化）
    expect(s.tokens.input).toBe(1_760)
    expect(s.tokens.output).toBe(121)
    expect(s.tokens.cache_read).toBe(200)
    expect(s.tokens.cache_creation).toBe(50)
    // 纯 token 观测不依赖查价器（cost=null 时照常产出）
    expect(s.cost).toBeNull()
  })

  it('缺 model 的条目跳过分桶不记账（全局桶照记）；失败与无 usage 条目不进分桶', () => {
    const s = summarizeUsage([
      entry({ model: undefined, usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 } }), // 极老日志：无 model
      entry({ status: 500, usage: { input_tokens: 999_999, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } }), // 失败请求
      entry({ usage: undefined }), // 成功但无 usage
    ])
    expect(s.tokens_by_model).toEqual({})
    expect(s.tokens.input).toBe(100) // 全局桶不受缺 model 影响
    expect(s.by_model['(unknown)']).toBeUndefined() // 不落 (unknown) 桶（与 cost 的 unpriced 口径不同：token 分桶直接跳过）
  })

  it('字段可选：不带 tokens_by_model 的旧 Summary 结构仍合法（旧消费方不破）', () => {
    const old: UsageSummary = {
      requests: 1,
      ok: 1,
      failed: 0,
      by_status: {},
      by_provider: {},
      by_model: {},
      latency: { p50: null, p95: null, p99: null },
      tokens: { input: 1, output: 2, cache_read: 0, cache_creation: 0 },
      billable_tokens: 0,
      billable_partial: false,
      cost: null,
      unpriced_models: null,
      window: { first: null, last: null },
    }
    expect(old.tokens_by_model).toBeUndefined()
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

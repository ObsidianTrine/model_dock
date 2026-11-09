// 数据面 per-harness 限额（水密舱熔断丝）测试：checkTokenLimits/recordTokenUsage 单测 +
// E2E（rpm 超限 429、daily_tokens 按 usage 累计超限、/v1/models 不受限、未配置不限）。

import http from 'node:http'
import { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { buildRuntime, checkTokenLimits, recordTokenUsage, registerEphemeralHarness } from '../src/gateway/state.js'
import type { Config } from '../src/config/types.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { localIsoTs } from '../src/util/time.js'

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function request(port: number, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, method: body ? 'POST' : 'GET' }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

describe('token limits > 纯逻辑单测（checkTokenLimits / recordTokenUsage）', () => {
  function rtWith(limits: { rpm?: number; daily_tokens?: number } | undefined) {
    const cfg = {
      providers: {},
      profiles: {},
      harness: { worker: { mode: 'gateway', ...(limits ? { limits } : {}) } },
    } as never as Config
    return buildRuntime(cfg, 'admin-tok')
  }

  it('未配置 limits 恒放行且不建状态', () => {
    const rt = rtWith(undefined)
    expect(checkTokenLimits(rt, 'worker')).toBeNull()
    expect(checkTokenLimits(rt, 'admin-test')).toBeNull() // 伪 harness（admin 请求）恒放行
    expect(rt.tokenUsage.size).toBe(0)
  })

  it('ephemeral 无 limits：恒放行但无条件建账计量；recordTokenUsage 兜底建账；admin-test 维持不建', () => {
    const rt = rtWith(undefined)
    const t0 = Date.parse('2026-11-01T10:00:00+08:00')
    registerEphemeralHarness(rt, { id: 'eph-free', ttlMinutes: 10, now: t0 })
    // 无 limits：不熔断恒放行，但状态建账（gatewayProvision 只传 taskId → 无 limits，编排器
    // 预算实测账 day_billable_tokens 依赖此账面）
    expect(checkTokenLimits(rt, 'eph-free', t0)).toBeNull()
    expect(rt.tokenUsage.get('eph-free')).toBeDefined()
    recordTokenUsage(rt, 'eph-free', { input_tokens: 100, output_tokens: 42, cache_read_tokens: 20, cache_creation_tokens: 5, billable_tokens: 147 }, t0 + 100)
    expect(rt.tokenUsage.get('eph-free')?.dayTokens).toBe(167) // 总口径：缓存读计入
    expect(rt.tokenUsage.get('eph-free')?.dayBillableTokens).toBe(147) // 可计费口径
    // 兜底建账：记账路径未经 checkTokenLimits（测试直灌等）也能建账计数
    registerEphemeralHarness(rt, { id: 'eph-record-only', ttlMinutes: 10, now: t0 })
    recordTokenUsage(rt, 'eph-record-only', { input_tokens: 1, output_tokens: 1, billable_tokens: 2 }, t0 + 100)
    expect(rt.tokenUsage.get('eph-record-only')?.dayBillableTokens).toBe(2)
    // 伪 harness（admin 请求）不在 rt.ephemeral：维持不建
    expect(checkTokenLimits(rt, 'admin-test', t0)).toBeNull()
    recordTokenUsage(rt, 'admin-test', { input_tokens: 5, output_tokens: 5 }, t0 + 100)
    expect(rt.tokenUsage.has('admin-test')).toBe(false)
  })

  it('rpm：第 rpm+1 个请求触发；窗口滑过（>60s）自动恢复', () => {
    const rt = rtWith({ rpm: 2 })
    const t0 = Date.parse('2026-11-01T10:00:00+08:00')
    expect(checkTokenLimits(rt, 'worker', t0)).toBeNull()
    expect(checkTokenLimits(rt, 'worker', t0 + 1000)).toBeNull()
    expect(checkTokenLimits(rt, 'worker', t0 + 2000)).toBe('rpm')
    expect(checkTokenLimits(rt, 'worker', t0 + 61_000)).toBeNull() // 新窗口
  })

  it('daily_tokens：usage 累计达上限后触发；跨本地日自动清零', () => {
    const rt = rtWith({ daily_tokens: 1200 })
    const t0 = Date.parse('2026-11-01T10:00:00+08:00')
    expect(checkTokenLimits(rt, 'worker', t0)).toBeNull()
    // 口径：input 1000 + 缓存读 100 + output 200 = 1300 ≥ 1200
    recordTokenUsage(rt, 'worker', { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 100, cache_creation_tokens: 0 }, t0 + 500)
    expect(checkTokenLimits(rt, 'worker', t0 + 1000)).toBe('daily_tokens')
    // 次日：清零放行
    expect(checkTokenLimits(rt, 'worker', t0 + 86_400_000)).toBeNull()
  })

  it('recordTokenUsage：无状态条目（未配 limits）静默跳过；usage 缺省不炸', () => {
    const rt = rtWith(undefined)
    expect(() => recordTokenUsage(rt, 'worker', { input_tokens: 5, output_tokens: 5 })).not.toThrow()
    expect(rt.tokenUsage.size).toBe(0)
  })

  it('day_billable_tokens（可计费口径）：按 usage.billable_tokens 累计；旧 usage 无字段从 0 起；跨日清零', () => {
    const rt = rtWith({ daily_tokens: 999_999 })
    const t0 = Date.parse('2026-11-01T10:00:00+08:00')
    checkTokenLimits(rt, 'worker', t0) // 建状态
    // 口径：billable 147（总口径 167 = input 100 + 缓存读 20 + 缓存建 5 + output 42）
    recordTokenUsage(rt, 'worker', { input_tokens: 100, output_tokens: 42, cache_read_tokens: 20, cache_creation_tokens: 5, billable_tokens: 147 }, t0 + 100)
    recordTokenUsage(rt, 'worker', { input_tokens: 100, output_tokens: 42, cache_read_tokens: 20, cache_creation_tokens: 5, billable_tokens: 147 }, t0 + 200)
    expect(rt.tokenUsage.get('worker')?.dayTokens).toBe(334) // 总口径不变
    expect(rt.tokenUsage.get('worker')?.dayBillableTokens).toBe(294) // 可计费口径
    // 旧 usage 无 billable_tokens 字段（旧网关内存态）：按 0 累加，计数自然从 0 起步
    recordTokenUsage(rt, 'worker', { input_tokens: 10, output_tokens: 1 }, t0 + 300)
    expect(rt.tokenUsage.get('worker')?.dayBillableTokens).toBe(294)
    expect(rt.tokenUsage.get('worker')?.dayTokens).toBe(345)
    // 负数防御归零；跨本地日清零（两口径同翻）
    recordTokenUsage(rt, 'worker', { input_tokens: 1, output_tokens: 1, billable_tokens: -50 }, t0 + 400)
    expect(rt.tokenUsage.get('worker')?.dayBillableTokens).toBe(294)
    recordTokenUsage(rt, 'worker', { input_tokens: 1, output_tokens: 1, billable_tokens: 7 }, t0 + 86_400_000)
    expect(rt.tokenUsage.get('worker')?.dayBillableTokens).toBe(7)
    expect(rt.tokenUsage.get('worker')?.dayTokens).toBe(2)
  })
})

describe('token limits > E2E（隔离沙箱 + 随机端口 + mock 上游）', () => {
  const TOKEN = 'mdk_tok_limits'

  /** mock 上游：/v1/messages 回 SSE（usage: input 100 / cache_read 20 / cache_create 5 / output 42 → 合计 167） */
  async function startMockUpstream(): Promise<{ port: number; close: () => void }> {
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}}}\n\n')
        res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n')
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      port: (server.address() as AddressInfo).port,
      close: () => {
        server.closeAllConnections?.()
        server.close()
      },
    }
  }

  async function setup(harness: Record<string, unknown>) {
    const h = fakeHome()
    const up = await startMockUpstream()
    const cfg = {
      version: 1,
      active_profile: 'demo',
      security: { store: 'file' },
      providers: { up: { name: 'mock', base_url: `http://127.0.0.1:${up.port}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-upstream-secret' } },
      profiles: { demo: { provider: 'up', default_model: 'preset-model' } },
      harness: { worker: { mode: 'gateway', route: 'default', token: TOKEN, ...harness } },
    } as never as Config
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const port = await listenEphemeral(server)
    return {
      rt,
      port,
      close: () => {
        server.closeAllConnections?.()
        server.close()
        up.close()
        h.restore()
      },
    }
  }

  const MSG_BODY = JSON.stringify({ model: 'preset-model', messages: [{ role: 'user', content: 'hi' }] })
  const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

  it('rpm=2：前两笔 200，第三笔 429（不打上游）；/v1/models 本地目录不受限', async () => {
    const t = await setup({ limits: { rpm: 2 } })
    try {
      expect((await request(t.port, '/v1/messages', AUTH, MSG_BODY)).status).toBe(200)
      expect((await request(t.port, '/v1/messages', AUTH, MSG_BODY)).status).toBe(200)
      const third = await request(t.port, '/v1/messages', AUTH, MSG_BODY)
      expect(third.status).toBe(429)
      expect(third.body).toContain('限流')
      expect(third.body).toContain('rpm')
      // 本地合成目录不耗上游：限流触发后仍可读
      expect((await request(t.port, '/v1/models', { authorization: `Bearer ${TOKEN}` })).status).toBe(200)
    } finally {
      t.close()
    }
  })

  it('daily_tokens=200：单笔 167 前两笔放行，第三笔（累计 334）触发日限额', async () => {
    const t = await setup({ limits: { daily_tokens: 200 } })
    try {
      expect((await request(t.port, '/v1/messages', AUTH, MSG_BODY)).status).toBe(200)
      expect((await request(t.port, '/v1/messages', AUTH, MSG_BODY)).status).toBe(200)
      expect(t.rt.tokenUsage.get('worker')?.dayTokens).toBe(334) // 167 × 2
      const third = await request(t.port, '/v1/messages', AUTH, MSG_BODY)
      expect(third.status).toBe(429)
      expect(third.body).toContain('日限额')
      expect(third.body).toContain('daily_tokens')
    } finally {
      t.close()
    }
  })

  it('未配置 limits：行为与历史版本一致（连发不限）', async () => {
    const t = await setup({})
    try {
      for (let i = 0; i < 4; i++) {
        expect((await request(t.port, '/v1/messages', AUTH, MSG_BODY)).status).toBe(200)
      }
      expect(t.rt.tokenUsage.size).toBe(0)
    } finally {
      t.close()
    }
  })

  it('GET /_modeldock/harness-usage：day_tokens（总口径）与 day_billable_tokens（可计费口径）并存', async () => {
    const t = await setup({ limits: { daily_tokens: 999_999 } })
    try {
      await request(t.port, '/v1/messages', AUTH, MSG_BODY)
      await request(t.port, '/v1/messages', AUTH, MSG_BODY)
      // mock 上游单笔：总口径 167（缓存读计入）；可计费口径 147（剔除缓存读 20）
      expect(t.rt.tokenUsage.get('worker')?.dayTokens).toBe(334)
      expect(t.rt.tokenUsage.get('worker')?.dayBillableTokens).toBe(294)
      const res = await request(t.port, '/_modeldock/harness-usage', { 'x-modeldock-admin': 'admin-token-x' })
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      const u = body.usage.worker
      expect(u.day_tokens).toBe(334)
      expect(u.day_billable_tokens).toBe(294)
      expect(u.day).toBe(localIsoTs().slice(0, 10))
    } finally {
      t.close()
    }
  })
})

// C14 / P2⑧：一次性 worker harness 供给端点（POST /_modeldock/harness/provision|revoke + TTL sweeper）。
// runtime-only：临时条目只注入网关内存（rt.config.harness / rt.tokens），不落 config.toml/secrets.json；
// token 明文只在 provision 响应出现一次。E2E（隔离沙箱 + 随机端口 + mock 上游）+ 纯逻辑单测。

import http from 'node:http'
import { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import {
  buildTokenIndex,
  buildRuntime,
  checkTokenLimits,
  registerEphemeralHarness,
  renewEphemeralHarness,
  reapplyEphemeralHarnesses,
  reloadRuntime,
  sweepEphemeralHarnesses,
  unregisterEphemeralHarness,
  EPHEMERAL_SWEEP_INTERVAL_MS,
  EPHEMERAL_TTL_DEFAULT_MINUTES,
  EPHEMERAL_TTL_MAX_MINUTES,
} from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { loadConfig, mutateConfig } from '../src/config/store.js'
import { configPath } from '../src/util/paths.js'
import type { Config } from '../src/config/types.js'

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

function adminPost(port: number, path: string, body: unknown, admin = 'admin-tok'): Promise<{ status: number; body: string }> {
  return request(port, path, { 'content-type': 'application/json', 'x-modeldock-admin': admin }, JSON.stringify(body))
}

function adminGet(port: number, path: string, admin = 'admin-tok'): Promise<{ status: number; body: string }> {
  return request(port, path, { 'x-modeldock-admin': admin })
}

/** 基础配置：无真实上游（relay 用例单独起 mock），provider/profile/persistent-harness 齐备 */
function baseConfig(): Config {
  return {
    version: 1,
    active_profile: 'demo',
    security: { store: 'file' },
    providers: {
      A: { name: 'A', base_url: 'http://a.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k1' },
    },
    profiles: {
      demo: { provider: 'A', default_model: 'm1' },
      heavy: { provider: 'A', default_model: 'm1' },
    },
    harness: { zcode: { mode: 'gateway', token: 'mdk_zcode_tok', limits: { rpm: 100 } } },
  } as never as Config
}

async function setupAsync(cfg: Config = baseConfig(), serverOpts: Parameters<typeof createGatewayServer>[1] = { port: 0 }) {
  const h = fakeHome()
  const rt = buildRuntime(cfg, 'admin-tok')
  const server = createGatewayServer(rt, serverOpts)
  const port = await listenEphemeral(server)
  return {
    rt,
    port,
    close: () => {
      server.closeAllConnections?.()
      server.close()
      h.restore()
    },
  }
}

describe('临时 harness > 纯逻辑（register / sweep / reapply，时间注入）', () => {
  it('register 注入 config.harness + token 索引；sweep 到点摘除（config/tokens/计数全清）', () => {
    const rt = buildRuntime(baseConfig(), 'adm')
    const t0 = Date.parse('2026-11-04T10:00:00+08:00')
    const st = registerEphemeralHarness(rt, { id: 'eph-a', route: 'heavy', ttlMinutes: 10, maxDailyTokens: 500, now: t0 })
    expect(st.token).toMatch(/^mdk_eph_[0-9a-f]{48}$/)
    expect(st.expiresAt).toBe(t0 + 10 * 60_000)
    // 合成条目：mode gateway + 钉定路由 + limits.daily_tokens（tokenlimits 体系零改动即生效）
    expect(rt.config.harness['eph-a']).toEqual({ mode: 'gateway', route: 'heavy', token: st.token, limits: { daily_tokens: 500 } })
    expect(rt.tokens.get(st.token)).toBe('eph-a')
    expect(sweepEphemeralHarnesses(rt, t0 + 9 * 60_000)).toEqual([])
    expect(sweepEphemeralHarnesses(rt, t0 + 10 * 60_000 + 1)).toEqual(['eph-a'])
    expect(rt.ephemeral.has('eph-a')).toBe(false)
    expect(rt.config.harness['eph-a']).toBeUndefined()
    expect(rt.tokens.has(st.token)).toBe(false)
    // 幂等：重复 unregister 返回 false
    expect(unregisterEphemeralHarness(rt, 'eph-a')).toBe(false)
  })

  it('reapply：模拟热加载整包替换 config/tokens 后，未过期条目重新注入、过期者清场', () => {
    const rt = buildRuntime(baseConfig(), 'adm')
    const t0 = Date.parse('2026-11-04T10:00:00+08:00')
    const keep = registerEphemeralHarness(rt, { id: 'eph-b', ttlMinutes: 10, now: t0 })
    registerEphemeralHarness(rt, { id: 'eph-c', ttlMinutes: 0.01, now: t0 }) // 600ms 即过期
    // 模拟 reloadRuntime 前半段：config/tokens 整包替换（盘上没有临时条目）
    const fresh = baseConfig()
    rt.config = { ...fresh, harness: { zcode: fresh.harness.zcode } }
    rt.tokens = buildTokenIndex(rt.config)
    reapplyEphemeralHarnesses(rt, t0 + 1000)
    expect(rt.ephemeral.has('eph-c')).toBe(false) // 过期清场
    expect(rt.config.harness['eph-b']?.token).toBe(keep.token) // 幸存者重新注入
    expect(rt.tokens.get(keep.token)).toBe('eph-b')
  })

  it('reapply：id 被真实 harness 占用（先 provision 后 attach 同名）时临时条目让位', () => {
    const rt = buildRuntime(baseConfig(), 'adm')
    const t0 = Date.now()
    const st = registerEphemeralHarness(rt, { id: 'eph-d', ttlMinutes: 10, now: t0 })
    // 真实接入占了同名 id（token 不同）
    ;(rt.config.harness as Record<string, { mode: string; token?: string }>)['eph-d'] = { mode: 'gateway', token: 'real-tok' }
    rt.tokens.set('real-tok', 'eph-d')
    reapplyEphemeralHarnesses(rt, t0 + 1)
    expect(rt.ephemeral.has('eph-d')).toBe(false)
    expect(rt.config.harness['eph-d']).toEqual({ mode: 'gateway', token: 'real-tok' }) // 真实条目原封不动
    expect(rt.tokens.get('real-tok')).toBe('eph-d')
    expect(rt.tokens.has(st.token)).toBe(false) // 临时 token 索引摘除
  })
})

describe('POST /_modeldock/harness/provision（admin 门内）', () => {
  it('缺省签发：自动 eph-<随机> id、token 形态、TTL 480、env 四键与 generic-env 同源', async () => {
    const t = await setupAsync()
    try {
      const r = await adminPost(t.port, '/_modeldock/harness/provision', {})
      expect(r.status).toBe(200)
      const j = JSON.parse(r.body) as Record<string, any>
      expect(j.ok).toBe(true)
      expect(j.id).toMatch(/^eph-[0-9a-f]{12}$/)
      expect(j.token).toMatch(/^mdk_eph_[0-9a-f]{48}$/)
      const ttlMs = Date.parse(j.expires_at) - Date.now()
      const expected = EPHEMERAL_TTL_DEFAULT_MINUTES * 60_000
      expect(Math.abs(ttlMs - expected)).toBeLessThan(60_000)
      expect(j.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${t.port}`)
      expect(j.env.ANTHROPIC_AUTH_TOKEN).toBe(j.token)
      expect(j.env.OPENAI_BASE_URL).toBe(`http://127.0.0.1:${t.port}/v1`)
      expect(j.env.OPENAI_API_KEY).toBe(j.token)
      // 签发即生效：token → harness → profile（跟随 active_profile=demo）
      const tv = await adminPost(t.port, '/_modeldock/tier-validate', { token: j.token })
      expect(JSON.parse(tv.body)).toMatchObject({ ok: true, harness: j.id, profile: 'demo' })
    } finally {
      t.close()
    }
  })

  it('显式 id/route/ttl/max_daily_tokens：钉定 profile 生效；token 明文不出现在任何列示端点', async () => {
    const t = await setupAsync()
    try {
      const r = await adminPost(t.port, '/_modeldock/harness/provision', { id: 'my-worker', profile: 'heavy', ttl_minutes: 30, max_daily_tokens: 1000 })
      const j = JSON.parse(r.body) as Record<string, any>
      expect(j.id).toBe('my-worker')
      expect(Math.abs(Date.parse(j.expires_at) - Date.now() - 30 * 60_000)).toBeLessThan(60_000)
      // route 字段与 profile 字段等价（编排侧惯用 route）
      const r2 = await adminPost(t.port, '/_modeldock/harness/provision', { id: 'my-worker-2', route: 'heavy' })
      expect(r2.status).toBe(200)
      // 钉定路由：tier-validate 权威回报 heavy
      const tv = await adminPost(t.port, '/_modeldock/tier-validate', { token: j.token })
      expect(JSON.parse(tv.body)).toMatchObject({ ok: true, harness: 'my-worker', profile: 'heavy' })
      // token 明文绝不回显：harness-usage / config 全文无 mdk_eph
      const usage = await adminGet(t.port, '/_modeldock/harness-usage')
      expect(usage.body).not.toContain('mdk_eph')
      const cfg = await adminGet(t.port, '/_modeldock/config')
      expect(cfg.body).not.toContain('mdk_eph')
      // harness-usage 呈现临时条目：ephemeral:true + expires_at（未配限额零计数也列出）
      const uj = JSON.parse(usage.body) as Record<string, any>
      expect(uj.usage['my-worker']).toMatchObject({ ephemeral: true, day_tokens: 0 })
      expect(typeof uj.usage['my-worker'].expires_at).toBe('string')
      // 既有口径不回归：持久 harness（配了 limits）照常出现、不带 ephemeral 标记
      // （tokenUsage 状态在首个经限流检查的请求时建立，这里直接建一条）
      checkTokenLimits(t.rt, 'zcode')
      const usage2 = JSON.parse((await adminGet(t.port, '/_modeldock/harness-usage')).body) as Record<string, any>
      expect(usage2.usage.zcode).toBeDefined()
      expect(usage2.usage.zcode.ephemeral).toBeUndefined()
    } finally {
      t.close()
    }
  })

  it('非法请求 400（ttl 边界 / max_daily / profile / id 冲突与字符集）；无 admin 头 401', async () => {
    const t = await setupAsync()
    try {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ ttl_minutes: 0 }, 'ttl_minutes'],
        [{ ttl_minutes: -1 }, 'ttl_minutes'],
        [{ ttl_minutes: 'abc' }, 'ttl_minutes'],
        [{ ttl_minutes: EPHEMERAL_TTL_MAX_MINUTES + 1 }, '上限'],
        [{ max_daily_tokens: 0 }, 'max_daily_tokens'],
        [{ max_daily_tokens: -5 }, 'max_daily_tokens'],
        [{ profile: 'nope' }, '不存在'],
        [{ id: '../evil' }, 'id 非法'],
        [{ id: 'zcode' }, '已存在'],
      ]
      for (const [body, kw] of cases) {
        const r = await adminPost(t.port, '/_modeldock/harness/provision', body)
        expect(r.status, JSON.stringify(body)).toBe(400)
        expect(r.body).toContain(kw)
      }
      const noAuth = await request(t.port, '/_modeldock/harness/provision', { 'content-type': 'application/json' }, '{}')
      expect(noAuth.status).toBe(401)
      // 全部失败请求不留痕：临时注册表仍为空
      expect(t.rt.ephemeral.size).toBe(0)
    } finally {
      t.close()
    }
  })

  it('revoke：吊销即 401、幂等（重复 revoke / 不在册 id 均放行）、不伤持久 harness；缺 id 400', async () => {
    const t = await setupAsync()
    try {
      const j = JSON.parse((await adminPost(t.port, '/_modeldock/harness/provision', { id: 'eph-r' })).body) as Record<string, any>
      expect((await adminPost(t.port, '/_modeldock/harness/revoke', { id: 'eph-r' })).body).toContain('"revoked":true')
      const tv = JSON.parse((await adminPost(t.port, '/_modeldock/tier-validate', { token: j.token })).body) as Record<string, any>
      expect(tv).toEqual({ ok: false, reason: 'unknown_token' })
      // 幂等：已吊销再吊 → ok（编排侧重试无需区分）
      expect((await adminPost(t.port, '/_modeldock/harness/revoke', { id: 'eph-r' })).body).toContain('"revoked":false')
      // 从未存在的 id 也放行
      expect((await adminPost(t.port, '/_modeldock/harness/revoke', { id: 'eph-never' })).body).toContain('"revoked":false')
      // 持久 harness 不受影响：revoke 原样放行，token 仍有效
      expect((await adminPost(t.port, '/_modeldock/harness/revoke', { id: 'zcode' })).body).toContain('"revoked":false')
      const zv = JSON.parse((await adminPost(t.port, '/_modeldock/tier-validate', { token: 'mdk_zcode_tok' })).body) as Record<string, any>
      expect(zv.ok).toBe(true)
      // 缺 id → 400
      expect((await adminPost(t.port, '/_modeldock/harness/revoke', {})).status).toBe(400)
    } finally {
      t.close()
    }
  })

  it('与持久流程的边界：detach / harness-route 明确报错；attach-plan 走未知适配器报错；harness/env 显式可取', async () => {
    const t = await setupAsync()
    try {
      const j = JSON.parse((await adminPost(t.port, '/_modeldock/harness/provision', { id: 'eph-x', route: 'heavy' })).body) as Record<string, any>
      const det = await adminPost(t.port, '/_modeldock/detach', { harness: 'eph-x' })
      expect(det.status).toBe(400)
      expect(det.body).toContain('临时凭据')
      const route = await adminPost(t.port, '/_modeldock/harness/route', { harness: 'eph-x', profile: 'demo' })
      expect(route.status).toBe(400)
      expect(route.body).toContain('临时凭据')
      const plan = await adminPost(t.port, '/_modeldock/attach/plan', { harness: 'eph-x' })
      expect(plan.status).toBe(400) // 未知适配器，明确报错不炸 500
      // harness/env 是显式取值端点（与 provision 同类，非列示）：TTL 内可重复取同一 token
      const env = JSON.parse((await adminPost(t.port, '/_modeldock/harness/env', { harness: 'eph-x' })).body) as Record<string, any>
      expect(env.token).toBe(j.token)
      expect(env.lines).toEqual([
        `export ANTHROPIC_BASE_URL=http://127.0.0.1:${t.port}`,
        `export ANTHROPIC_AUTH_TOKEN=${j.token}`,
        `export OPENAI_BASE_URL=http://127.0.0.1:${t.port}/v1`,
        `export OPENAI_API_KEY=${j.token}`,
      ])
    } finally {
      t.close()
    }
  })
})

describe('临时 harness > TTL sweeper（间隔注入 20ms）', () => {
  it('过期条目被周期清扫摘除：token 立即 401、harness-usage 不再列出', async () => {
    const t = await setupAsync(baseConfig(), { port: 0, ephemeralSweepIntervalMs: 20 })
    try {
      expect(EPHEMERAL_SWEEP_INTERVAL_MS).toBe(60_000) // 生产节奏常量不被测试无意改动
      const j = JSON.parse((await adminPost(t.port, '/_modeldock/harness/provision', { id: 'eph-t', ttl_minutes: 0.002 })).body) as Record<string, any> // ≈120ms
      const tv0 = JSON.parse((await adminPost(t.port, '/_modeldock/tier-validate', { token: j.token })).body) as Record<string, any>
      expect(tv0.ok).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 700))
      const tv1 = JSON.parse((await adminPost(t.port, '/_modeldock/tier-validate', { token: j.token })).body) as Record<string, any>
      expect(tv1).toEqual({ ok: false, reason: 'unknown_token' })
      const usage = JSON.parse((await adminGet(t.port, '/_modeldock/harness-usage')).body) as Record<string, any>
      expect(usage.usage['eph-t']).toBeUndefined()
    } finally {
      t.close()
    }
  })
})

/** mock 上游：/v1/messages 回 SSE（usage: input 100 / cache_read 20 / cache_create 5 / output 42 → 合计 167，可计费 147） */
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

describe('临时 harness > 日限额（max_daily_tokens 挂进 tokenlimits，超限 429 与 daily_tokens 一致）', () => {
  it('daily 累计达上限后 429（不打上游）；用量计入临时 harness 名下', async () => {
    const h = fakeHome()
    const up = await startMockUpstream()
    try {
      const cfg = {
        version: 1,
        active_profile: 'demo',
        security: { store: 'file' },
        providers: { A: { name: 'A', base_url: `http://127.0.0.1:${up.port}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k1' } },
        profiles: { demo: { provider: 'A', default_model: 'preset-model' }, heavy: { provider: 'A', default_model: 'preset-model' } },
        harness: {},
      } as never as Config
      const rt = buildRuntime(cfg, 'admin-tok')
      const server = createGatewayServer(rt, { port: 0 })
      const port = await listenEphemeral(server)
      const j = JSON.parse(
        (
          await adminPost(port, '/_modeldock/harness/provision', { id: 'eph-q', max_daily_tokens: 200 })
        ).body
      ) as Record<string, any>
      const MSG = JSON.stringify({ model: 'preset-model', messages: [{ role: 'user', content: 'hi' }] })
      const AUTH = { authorization: `Bearer ${j.token}`, 'content-type': 'application/json' }
      expect((await request(port, '/v1/messages', AUTH, MSG)).status).toBe(200)
      expect((await request(port, '/v1/messages', AUTH, MSG)).status).toBe(200)
      expect(rt.tokenUsage.get('eph-q')?.dayTokens).toBe(334) // 167 × 2，计入临时条目名下
      const third = await request(port, '/v1/messages', AUTH, MSG)
      expect(third.status).toBe(429)
      expect(third.body).toContain('日限额')
      expect(third.body).toContain('daily_tokens')
      server.closeAllConnections?.()
      server.close()
    } finally {
      up.close()
      h.restore()
    }
  })
})

describe('临时 harness > 无限额计量建账（gatewayProvision 预算实测账数据源）', () => {
  it('provision 不带 max_daily_tokens（无 limits）：连发不熔断、无条件建账，harness-usage day_billable_tokens>0', async () => {
    const h = fakeHome()
    const up = await startMockUpstream()
    try {
      const cfg = {
        version: 1,
        active_profile: 'demo',
        security: { store: 'file' },
        providers: { A: { name: 'A', base_url: `http://127.0.0.1:${up.port}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k1' } },
        profiles: { demo: { provider: 'A', default_model: 'preset-model' }, heavy: { provider: 'A', default_model: 'preset-model' } },
        harness: {},
      } as never as Config
      const rt = buildRuntime(cfg, 'admin-tok')
      const server = createGatewayServer(rt, { port: 0 })
      const port = await listenEphemeral(server)
      const j = JSON.parse((await adminPost(port, '/_modeldock/harness/provision', { id: 'eph-meter' })).body) as Record<string, any>
      expect(rt.config.harness['eph-meter']?.limits).toBeUndefined() // gatewayProvision 只传 taskId 的形态
      const MSG = JSON.stringify({ model: 'preset-model', messages: [{ role: 'user', content: 'hi' }] })
      const AUTH = { authorization: `Bearer ${j.token}`, 'content-type': 'application/json' }
      expect((await request(port, '/v1/messages', AUTH, MSG)).status).toBe(200)
      expect((await request(port, '/v1/messages', AUTH, MSG)).status).toBe(200) // 无 limits 仍放行（不熔断）
      // 账面两口径齐动（此前恒 0：无 limits 不建状态 + recordTokenUsage no-op）
      expect(rt.tokenUsage.get('eph-meter')?.dayTokens).toBe(334) // 167 × 2
      expect(rt.tokenUsage.get('eph-meter')?.dayBillableTokens).toBe(294) // 147 × 2（剔除缓存读）
      const usage = JSON.parse((await adminGet(port, '/_modeldock/harness-usage')).body) as Record<string, any>
      expect(usage.usage['eph-meter']).toMatchObject({ ephemeral: true, day_tokens: 334, day_billable_tokens: 294 })
      server.closeAllConnections?.()
      server.close()
    } finally {
      up.close()
      h.restore()
    }
  })
})

describe('临时 harness > 不落盘 + 热加载幸存（config.toml 零痕迹）', () => {
  it('provision 后 config.toml 无临时条目；mutateConfig 写盘不带上它；reloadRuntime 后仍有效', async () => {
    const h = fakeHome()
    try {
      // 先落一份与 baseConfig 同构的盘上配置（providers/profiles/persistent harness）
      await mutateConfig((cfg) => {
        cfg.active_profile = 'demo'
        cfg.security = { store: 'file' }
        cfg.providers = { A: { name: 'A', base_url: 'http://a.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k1' } }
        cfg.profiles = { demo: { provider: 'A', default_model: 'm1' }, heavy: { provider: 'A', default_model: 'm1' } }
        cfg.harness = { zcode: { mode: 'gateway', token: 'mdk_zcode_tok', limits: { rpm: 100 } } }
      })
      const rt = buildRuntime(await loadConfig(), 'admin-tok')
      const server = createGatewayServer(rt, { port: 0 })
      const port = await listenEphemeral(server)
      const j = JSON.parse((await adminPost(port, '/_modeldock/harness/provision', { id: 'eph-p', profile: 'heavy', max_daily_tokens: 1000 })).body) as Record<string, any>
      // ① 盘上无痕迹
      const onDisk1 = readFileSync(configPath(), 'utf8')
      expect(onDisk1).not.toContain('eph-p')
      expect(onDisk1).not.toContain('mdk_eph')
      // ② 无关写盘（mutateConfig 从盘上重读再整包写回）不把临时条目带上去
      await mutateConfig((cfg) => {
        cfg.gateway = { ...cfg.gateway, max_body_mb: 17 }
      })
      const onDisk2 = readFileSync(configPath(), 'utf8')
      expect(onDisk2).not.toContain('eph-p')
      expect(onDisk2).not.toContain('mdk_eph')
      // ③ 热加载（整包替换 config/tokens）后幸存：token → harness → profile 依旧权威可用
      await reloadRuntime(rt)
      const tv = JSON.parse((await adminPost(port, '/_modeldock/tier-validate', { token: j.token })).body) as Record<string, any>
      expect(tv).toMatchObject({ ok: true, harness: 'eph-p', profile: 'heavy' })
      server.closeAllConnections?.()
      server.close()
    } finally {
      h.restore()
    }
  })
})

describe('renewEphemeralHarness > 纯逻辑（时间注入）', () => {
  it('新到期 = max(剩余, ttl) 收敛 1440 硬顶；缩短 no-op；过期与不在册分流', () => {
    const rt = buildRuntime(baseConfig(), 'adm')
    const t0 = Date.parse('2026-11-10T01:00:00Z')
    registerEphemeralHarness(rt, { id: 'eph-m', ttlMinutes: 60, now: t0 })
    // ttl 小于剩余寿命：no-op，到期不变
    const r1 = renewEphemeralHarness(rt, 'eph-m', 10, t0 + 60_000)
    expect(r1.ok && r1.state.expiresAt).toBe(t0 + 60 * 60_000)
    // ttl 大于剩余：后移到 now + ttl
    const r2 = renewEphemeralHarness(rt, 'eph-m', 90, t0 + 60_000)
    expect(r2.ok && r2.state.expiresAt).toBe(t0 + 60_000 + 90 * 60_000)
    // 超硬顶收敛到 now + 1440min（不 400，续期口顶住即可）
    const r3 = renewEphemeralHarness(rt, 'eph-m', 5000, t0 + 2 * 60_000)
    expect(r3.ok && r3.state.expiresAt).toBe(t0 + 2 * 60_000 + EPHEMERAL_TTL_MAX_MINUTES * 60_000)
    // 仍在册但已过点（sweeper 未及摘除窗口）：拒绝，不复活
    registerEphemeralHarness(rt, { id: 'eph-dead', ttlMinutes: 1, now: t0 })
    expect(renewEphemeralHarness(rt, 'eph-dead', 30, t0 + 61_000)).toEqual({ ok: false, reason: 'expired' })
    // 未知 id / 持久 harness（不在临时注册表）：not_found
    expect(renewEphemeralHarness(rt, 'eph-ghost', 30, t0 + 62_000)).toEqual({ ok: false, reason: 'not_found' })
    expect(renewEphemeralHarness(rt, 'zcode', 30, t0 + 62_000)).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('POST /_modeldock/harness/renew（admin 门内）', () => {
  it('未过期续期：expires_at 后移到 max(旧到期, now+ttl)；缩短请求 no-op；token 不换发不回显', async () => {
    const t = await setupAsync()
    try {
      const j = JSON.parse((await adminPost(t.port, '/_modeldock/harness/provision', { id: 'eph-renew', profile: 'heavy', ttl_minutes: 30 })).body) as Record<string, any>
      const raw = await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: 'eph-renew', ttl_minutes: 45 })
      const r = JSON.parse(raw.body) as Record<string, any>
      expect(r.ok).toBe(true)
      expect(r.id).toBe('eph-renew')
      expect(r.token).toBeUndefined() // token 不换发：续期只改 expiresAt
      expect(raw.body).not.toContain('mdk_eph') // 响应不回显 token 明文
      const newMs = Date.parse(r.expires_at)
      expect(newMs).toBeGreaterThan(Date.parse(j.expires_at)) // 后移
      expect(Math.abs(newMs - Date.now() - 45 * 60_000)).toBeLessThan(60_000)
      // 原 token 仍权威有效（路由钉定不变）
      const tv = JSON.parse((await adminPost(t.port, '/_modeldock/tier-validate', { token: j.token })).body) as Record<string, any>
      expect(tv).toMatchObject({ ok: true, harness: 'eph-renew', profile: 'heavy' })
      // 缩短请求（ttl 5min < 剩余 45min）：到期不变
      const r2 = JSON.parse((await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: 'eph-renew', ttl_minutes: 5 })).body) as Record<string, any>
      expect(r2.ok).toBe(true)
      expect(r2.expires_at).toBe(r.expires_at)
    } finally {
      t.close()
    }
  })

  it('超硬顶收敛：ttl_minutes 超过 1440 时新到期收敛到 now+1440min；harness-usage 反映续后到期', async () => {
    const t = await setupAsync()
    try {
      await adminPost(t.port, '/_modeldock/harness/provision', { id: 'eph-cap', ttl_minutes: 30 })
      const r = JSON.parse((await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: 'eph-cap', ttl_minutes: 5000 })).body) as Record<string, any>
      expect(r.ok).toBe(true)
      expect(Math.abs(Date.parse(r.expires_at) - Date.now() - EPHEMERAL_TTL_MAX_MINUTES * 60_000)).toBeLessThan(60_000)
      const usage = JSON.parse((await adminGet(t.port, '/_modeldock/harness-usage')).body) as Record<string, any>
      expect(usage.usage['eph-cap'].expires_at).toBe(r.expires_at)
    } finally {
      t.close()
    }
  })

  it('已过期拒绝（410，sweeper 未及摘除窗口内不复活）；摘除后 / 非 ephemeral / 未知 id / 已吊销 404', async () => {
    const t = await setupAsync()
    try {
      await adminPost(t.port, '/_modeldock/harness/provision', { id: 'eph-dead', ttl_minutes: 0.002 }) // ≈120ms
      await adminPost(t.port, '/_modeldock/harness/provision', { id: 'eph-live', ttl_minutes: 30 })
      await new Promise((resolve) => setTimeout(resolve, 300))
      // 仍在册（sweeper 默认 60s 未跑）但已过点：410 拒绝，僵尸凭据不得复活
      const dead = await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: 'eph-dead', ttl_minutes: 30 })
      expect(dead.status).toBe(410)
      expect(dead.body).toContain('已过期')
      // 持久 harness 与未知 id：404（renew 仅作用于 provision 签发的临时条目）
      expect((await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: 'zcode', ttl_minutes: 30 })).status).toBe(404)
      expect((await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: 'eph-never', ttl_minutes: 30 })).status).toBe(404)
      // 吊销后 404
      await adminPost(t.port, '/_modeldock/harness/revoke', { id: 'eph-live' })
      expect((await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: 'eph-live', ttl_minutes: 30 })).status).toBe(404)
      // sweeper 摘除后：expired 窗口消失 → 404（与 410 分流）
      expect(sweepEphemeralHarnesses(t.rt, Date.now())).toContain('eph-dead')
      expect((await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: 'eph-dead', ttl_minutes: 30 })).status).toBe(404)
    } finally {
      t.close()
    }
  })

  it('非法请求 400（缺 harnessId / ttl 非法）；无 admin 头 401；审计全程无 token 明文', async () => {
    const t = await setupAsync()
    try {
      expect((await adminPost(t.port, '/_modeldock/harness/renew', { ttl_minutes: 30 })).status).toBe(400)
      expect((await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: 'eph-nope', ttl_minutes: 0 })).status).toBe(400)
      expect((await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: 'eph-nope', ttl_minutes: 'abc' })).status).toBe(400)
      const noAuth = await request(t.port, '/_modeldock/harness/renew', { 'content-type': 'application/json' }, '{}')
      expect(noAuth.status).toBe(401)
      const j = JSON.parse((await adminPost(t.port, '/_modeldock/harness/provision', { id: 'eph-audit' })).body) as Record<string, any>
      const rr = await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: 'eph-audit', ttl_minutes: 50 })
      expect(rr.status).toBe(200)
      const auditEntry = t.rt.ring.find((e) => e.kind === 'audit' && e.op === '续期临时凭据')
      expect(auditEntry).toBeTruthy()
      // provision 与 renew 两条审计（含 detail）全程无 token 明文：前缀与明文都不出现
      const audits = t.rt.ring.filter((e) => e.kind === 'audit')
      for (const a of audits) {
        const s = JSON.stringify(a)
        expect(s).not.toContain('mdk_eph')
        expect(s).not.toContain(j.token)
      }
    } finally {
      t.close()
    }
  })

  it('热加载幸存语义不变：renew 后 reloadRuntime，续后到期保持、token 仍权威可用', async () => {
    const h = fakeHome()
    try {
      await mutateConfig((cfg) => {
        cfg.active_profile = 'demo'
        cfg.security = { store: 'file' }
        cfg.providers = { A: { name: 'A', base_url: 'http://a.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k1' } }
        cfg.profiles = { demo: { provider: 'A', default_model: 'm1' }, heavy: { provider: 'A', default_model: 'm1' } }
        cfg.harness = { zcode: { mode: 'gateway', token: 'mdk_zcode_tok', limits: { rpm: 100 } } }
      })
      const rt = buildRuntime(await loadConfig(), 'admin-tok')
      const server = createGatewayServer(rt, { port: 0 })
      const port = await listenEphemeral(server)
      const j = JSON.parse((await adminPost(port, '/_modeldock/harness/provision', { id: 'eph-rl', profile: 'heavy' })).body) as Record<string, any>
      const r = JSON.parse((await adminPost(port, '/_modeldock/harness/renew', { harnessId: 'eph-rl', ttl_minutes: 60 })).body) as Record<string, any>
      await reloadRuntime(rt)
      expect(rt.ephemeral.get('eph-rl')?.expiresAt).toBe(Date.parse(r.expires_at))
      const tv = JSON.parse((await adminPost(port, '/_modeldock/tier-validate', { token: j.token })).body) as Record<string, any>
      expect(tv).toMatchObject({ ok: true, harness: 'eph-rl', profile: 'heavy' })
      server.closeAllConnections?.()
      server.close()
    } finally {
      h.restore()
    }
  })
})

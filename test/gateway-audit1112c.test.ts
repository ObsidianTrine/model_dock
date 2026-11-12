import { describe, expect, it } from 'vitest'
import http from 'node:http'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import { forwardWithFailover, readBodyBounded, upstreamEndpoint, UpstreamError, type ForwardOptions } from '../src/gateway/relay.js'
import { buildRuntime, markKeyCooldown, recordOutcome, seaWindowView } from '../src/gateway/state.js'
import { recordModelOutcome } from '../src/gateway/state/routing.js'
import { probe } from '../src/gateway/server.js'
import { setSecret } from '../src/config/secrets.js'
import type { Config, ProviderConfig } from '../src/config/types.js'
import type { GatewayRuntime, ResolvedTarget } from '../src/gateway/state/types.js'

// 夜航审查 cruise1112-audit-gateway 批次 C 的回归测试：
// P2-12 candidateSkip 海况稀释（未出网的本地跳过不进分桶）/ P2-6 收尾 server.ts 探针响应体有界读。
// 全部真实入口（不 mock 模块——isolate:false 共享注册表是雷区）；mock 上游 listen(0) 随机端口。

const body = Buffer.from(JSON.stringify({ model: 'm', messages: [] }))
const ROUTED = '/v1/messages'

function providerCfg(id: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { name: id, base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: `file:${id}`, priority: 0, ...over }
}

function buildRt(providers: Record<string, ProviderConfig>): GatewayRuntime {
  const cfg = { providers, profiles: {}, harness: {}, gateway: { auto_fallback: false } } as unknown as Config
  return buildRuntime(cfg, 'tok')
}

function baseOn(cfg: { providers: Record<string, ProviderConfig> }, id: string): ResolvedTarget {
  return { harness: 'test', profileName: 'p', profile: { name: 'p', provider: id }, provider: cfg.providers[id] }
}

function fwd(over: Partial<ForwardOptions> = {}): ForwardOptions {
  return { method: 'POST', path: ROUTED, headers: {}, body, idleTimeoutMs: 60_000, retries: 0, ...over }
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.()
  return new Promise((r) => server.close(() => r()))
}

/** listen(0) 后关闭的确认关闭端口：造确定性的连接拒绝（transport 失败，relay.test.ts 同配方） */
async function closedPort(): Promise<string> {
  const s = http.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  await new Promise<void>((r) => s.close(() => r()))
  return url
}

/** 分桶断言捷径：四类错误合计（0 = 纯中性/无错误） */
function seaErrCount(rt: GatewayRuntime, id: string): number {
  const sp = rt.seaErrors?.get(id)
  if (!sp) return 0
  const w = seaWindowView(sp, 3_600_000)
  return w.connect + w['429'] + w['5xx'] + w.quota
}

describe('P2-12 candidateSkip 海况稀释：未出网的本地跳过不进分桶（skipSea 旁路）', () => {
  it('recordOutcome skipSea=true：海况分桶零记账，熔断侧照旧（okStreak 清零不受旁路影响）', () => {
    const h = fakeHome()
    try {
      const rt = buildRt({})
      recordOutcome(rt, 'a', { ok: true, ms: 5 })
      expect(rt.seaErrors?.get('a')).toBeDefined()
      recordOutcome(rt, 'a', { ok: false, skipSea: true })
      const w = seaWindowView(rt.seaErrors!.get('a')!, 3_600_000)
      expect(w.total).toBe(1) // skip 不进分母（旧口径会变 2）
      expect(rt.health.get('a')!.okStreak).toBe(0) // 熔断侧照常清 streak
      recordOutcome(rt, 'a', { ok: true, ms: 5 })
      expect(rt.health.get('a')!.okStreak).toBe(1)
    } finally {
      h.restore()
    }
  })

  it('全候选 key 池为空（ghost refs）：链 skip_all 收尾，海况分桶零条目（旧口径每候选各记一笔撑大 total）', async () => {
    const h = fakeHome()
    try {
      const cfg = {
        providers: {
          a: providerCfg('a', { key_ref: 'file:ghost-a' }),
          b: providerCfg('b', { key_ref: 'file:ghost-b' }),
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers)
      const err = await forwardWithFailover(rt, baseOn(cfg, 'a'), { ...fwd(), fallbackIds: ['b'] }).then(() => null, (e) => e)
      expect(err).toBeInstanceOf(UpstreamError)
      const e = err as UpstreamError
      expect(e.candidateSkip).toBe(true)
      expect(e.routeReason).toBe('skip_all')
      expect(e.localSkip).toBe(true)
      expect(rt.seaErrors?.get('a')).toBeUndefined()
      expect(rt.seaErrors?.get('b')).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('协议端点缺失（proto_endpoint_missing）：candidateSkip 且 localSkip，海况零记账', async () => {
    const h = fakeHome()
    try {
      const cfg = { providers: { a: providerCfg('a') }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      await setSecret('a', 'sk-a', 'file')
      // provider 是 anthropic 协议、未配 endpoints.openai：客户端走 openai 协议必抛
      const err = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd({ path: '/v1/chat/completions', body: Buffer.from(JSON.stringify({ model: 'm' })) })).then(
        () => null,
        (e) => e,
      )
      const e = err as UpstreamError
      expect(e.candidateSkip).toBe(true)
      expect(e.cause).toBe('proto_endpoint_missing')
      expect(e.localSkip).toBe(true)
      expect(rt.seaErrors?.get('a')).toBeUndefined()
      // 纯函数口径也钉一下：upstreamEndpoint 抛的就是同一形态
      expect(() => upstreamEndpoint(cfg.providers.a, 'openai')).toThrow(UpstreamError)
    } finally {
      h.restore()
    }
  })

  it('全 key 冷却中（key_cooldown）：请求未出网，海况零记账', async () => {
    const h = fakeHome()
    const up = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    const base = await listen(up)
    try {
      await setSecret('a', 'sk-a', 'file')
      const cfg = { providers: { a: providerCfg('a', { base_url: base }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      markKeyCooldown(rt, 'a', 0) // 唯一把打入冷却
      const err = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd()).then(() => null, (e) => e)
      const e = err as UpstreamError
      expect(e.candidateSkip).toBe(true)
      expect(e.cause).toBe('key_cooldown')
      expect(e.localSkip).toBe(true)
      expect(rt.seaErrors?.get('a')).toBeUndefined()
    } finally {
      await close(up)
      h.restore()
    }
  })

  it('模型额度熔断快速失败（model_cooldown）：请求未出网，海况零记账', async () => {
    const h = fakeHome()
    const up = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    const base = await listen(up)
    try {
      await setSecret('a', 'sk-a', 'file')
      const cfg = { providers: { a: providerCfg('a', { base_url: base }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      for (let i = 0; i < 3; i++) recordModelOutcome(rt, 'a', 'm', { ok: false, cls: 'quota' }) // (a, m) 进熔断
      const err = await forwardWithFailover(rt, baseOn(cfg, 'a'), fwd()).then(() => null, (e) => e)
      const e = err as UpstreamError
      expect(e.candidateSkip).toBe(true)
      expect(e.attemptNote).toBe('model_cooldown')
      expect(e.localSkip).toBe(true)
      expect(rt.seaErrors?.get('a')).toBeUndefined()
    } finally {
      await close(up)
      h.restore()
    }
  })

  it('对照 · 真实出网失败照记：连接拒绝进 connect 桶、换 key 仍 401 的 key_pool_rejected 进 total 分母', async () => {
    const h = fakeHome()
    const up401 = http.createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":{"type":"authentication_error","message":"invalid x-api-key"}}')
    })
    const base = await listen(up401)
    try {
      // 连接拒绝（transport=true）：真实出网，connect 桶 +1
      const cfgDead = { providers: { dead: providerCfg('dead', { base_url: await closedPort() }) }, profiles: {}, harness: {} } as unknown as Config
      const rtDead = buildRt(cfgDead.providers)
      await setSecret('dead', 'sk-d', 'file')
      const deadErr = await forwardWithFailover(rtDead, baseOn(cfgDead, 'dead'), fwd()).then(() => null, (e) => e)
      // 单候选 transport 耗尽 → 链尾 down_all 包装（transport 在原始错误上，包装只留 cause）
      expect((deadErr as UpstreamError).routeReason).toBe('down_all')
      expect((deadErr as UpstreamError).cause).toBe('connect_failed')
      const wd = seaWindowView(rtDead.seaErrors!.get('dead')!, 3_600_000)
      expect(wd.total).toBe(1)
      expect(wd.connect).toBe(1)

      // 双 key 池逐把被 401（key_pool_rejected）：candidateSkip 但真实出网，进 total 不进错误类
      const k1 = await setSecret('c-k1', 'sk-1', 'file')
      const k2 = await setSecret('c-k2', 'sk-2', 'file')
      const cfgPool = {
        providers: { pool: providerCfg('pool', { base_url: base, key_ref: k1, keys: [k1, k2] }) },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rtPool = buildRt(cfgPool.providers)
      const poolErr = await forwardWithFailover(rtPool, baseOn(cfgPool, 'pool'), fwd()).then(() => null, (e) => e)
      const pe = poolErr as UpstreamError
      expect(pe.candidateSkip).toBe(true)
      expect(pe.cause).toBe('key_pool_rejected')
      expect(pe.localSkip).toBeUndefined() // 真实出过网（两把 key 都被上游 401）——不旁路
      const wp = seaWindowView(rtPool.seaErrors!.get('pool')!, 3_600_000)
      expect(wp.total).toBe(1)
      expect(seaErrCount(rtPool, 'pool')).toBe(0) // 401 是中性 4xx：只摊分母
    } finally {
      await close(up401)
      h.restore()
    }
  })
})

describe('P2-6 收尾：probe 响应体有界读（server.ts 探针两处 up.body.text() 换有界读）', () => {
  it('超大错误体（>1MB）：探测照常返回可读错误，不再整体进堆', async () => {
    const h = fakeHome()
    const up = http.createServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad model name' } }) + ' '.repeat(4 * 1024 * 1024))
    })
    const base = await listen(up)
    try {
      await setSecret('a', 'sk-a', 'file')
      const cfg = { providers: { a: providerCfg('a', { base_url: base }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      const r = await probe(rt, baseOn(cfg, 'a'), 'm', false, { idle: 5_000, retries: 0 })
      expect(r.ok).toBe(false)
      expect(r.status).toBe(400)
      expect(r.err).toContain('bad model name')
    } finally {
      await close(up)
      h.restore()
    }
  })

  it('超大成功体（>1MB）：ok 照常返回，usage 解析按截断降级为缺席', async () => {
    const h = fakeHome()
    const up = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"content":"' + 'x'.repeat(4 * 1024 * 1024) + '","usage":{"input_tokens":1,"output_tokens":2}}')
    })
    const base = await listen(up)
    try {
      await setSecret('a', 'sk-a', 'file')
      const cfg = { providers: { a: providerCfg('a', { base_url: base }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      const r = await probe(rt, baseOn(cfg, 'a'), 'm', false, { idle: 5_000, retries: 0 })
      expect(r.ok).toBe(true)
      expect(r.status).toBe(200)
      expect(r.usage).toBeUndefined() // 截断体 JSON.parse 失败 → usage 缺席（观测降级不致错）
    } finally {
      await close(up)
      h.restore()
    }
  })

  it('压缩错误体：解压后 message 可读（探测复用 readUpstreamErrorText 的解压口径）', async () => {
    const h = fakeHome()
    const up = http.createServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(zlib.gzipSync(Buffer.from(JSON.stringify({ error: { message: 'gzipped rejection' } }), 'utf8')))
    })
    const base = await listen(up)
    try {
      await setSecret('a', 'sk-a', 'file')
      const cfg = { providers: { a: providerCfg('a', { base_url: base }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      const r = await probe(rt, baseOn(cfg, 'a'), 'm', false, { idle: 5_000, retries: 0 })
      expect(r.ok).toBe(false)
      expect(r.err).toContain('gzipped rejection') // 旧口径 text() 直读 gzip 字节 → 乱码
    } finally {
      await close(up)
      h.restore()
    }
  })

  it('readBodyBounded（导出供 server.ts 复用）：达上限即停，块粒度截断保留头部', async () => {
    // 两个 512KB 块：块 1 累计 512KB < 上限继续；块 2 跨线即停（有界读按块粒度停，
    // 上限附近的溢出不超过一个块，与批次 B 无限流式用例同一语义）
    const chunks = [Buffer.alloc(512 * 1024, 0x61), Buffer.alloc(512 * 1024, 0x62)]
    const stream = {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c
      },
    }
    const buf = await readBodyBounded(stream as unknown as Parameters<typeof readBodyBounded>[0], 1024 * 1024)
    expect(buf.length).toBe(1024 * 1024)
    expect(buf[0]).toBe(0x61) // 头部保留
    expect(buf[buf.length - 1]).toBe(0x62) // 恰停在第二块尾（达上限即停，不再等第三块）
  })
})

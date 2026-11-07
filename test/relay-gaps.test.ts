import { describe, expect, it } from 'vitest'
import http from 'node:http'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import {
  forwardToUpstream,
  forwardWithFailover,
  readUpstreamErrorText,
  rewriteModel,
  topLevelModel,
  translateUpstreamError,
  UpstreamError,
} from '../src/gateway/relay.js'
import { acquireProviderSlot } from '../src/gateway/concurrency.js'
import { buildRuntime, recordOutcome } from '../src/gateway/state.js'
import { setSecret } from '../src/config/secrets.js'
import { fakeHome } from './helpers.js'
import type { Config, ProfileConfig, ProviderConfig } from '../src/config/types.js'
import type { ResolvedTarget } from '../src/gateway/state/types.js'

// relay.ts 缺口补测（卡 test-gap-gateway-util，2026-11-07 coverage 现场）：
// - forwardWithFailover：down_all 前置、并发闸排队超时跳候选 / 客户端断开上抛、
//   429 Retry-After 原地退避（含退避中断开）、failover_status_codes 白名单切换（5xx recordOutcome + 排空）、
//   全候选 transport 失败耗尽的 down_all 收尾
// - forwardToUpstream：x-api-key 鉴权风格、响应头超时分类（transport='timeout'）
// - 纯函数：topLevelModel 浅扫描鲁棒性、rewriteModel 全量解析回落路径、translateUpstreamError 无 model 占位、
//   readUpstreamErrorText 各压缩形态
// 全部真实入口（不 mock 模块——isolate:false 共享注册表是雷区）；mock 上游 listen(0) 随机端口。

const BODY = Buffer.from(JSON.stringify({ model: 'm', messages: [] }))
const ROUTED = '/v1/messages'

interface Mock {
  url: string
  count: () => number
  close: () => Promise<void>
}

/** 可编程 mock 上游：handler 拿 (req, res, 序号) 自行写响应；记录收到的请求头。 */
async function startMock(handler: (req: http.IncomingMessage, res: http.ServerResponse, i: number) => void): Promise<Mock & { reqs: http.IncomingMessage[] }> {
  const reqs: http.IncomingMessage[] = []
  const s = http.createServer((req, res) => {
    reqs.push(req)
    handler(req, res, reqs.length - 1)
  })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const close = () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()) })
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, reqs, count: () => reqs.length, close }
}

function providerCfg(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { name: 'p', base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k', ...over }
}

function buildRt(providers: Record<string, ProviderConfig>, gateway: Record<string, unknown> = {}): ReturnType<typeof buildRuntime> {
  return buildRuntime({ providers, profiles: {}, harness: {}, gateway: { auto_fallback: false, ...gateway } } as unknown as Config, 'tok')
}

function baseOn(cfg: Config, id: string, profileOver: Partial<ProfileConfig> = {}): ResolvedTarget {
  return {
    harness: 'test',
    profileName: 'p',
    profile: { name: 'p', provider: id, ...profileOver },
    provider: cfg.providers[id],
  }
}

function fwdOpts(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { method: 'POST', path: ROUTED, headers: {}, body: BODY, idleTimeoutMs: 5000, retries: 0, ...over }
}

describe('relay · forwardWithFailover 路由态与并发闸分支', () => {
  it('候选全部熔断：pickTarget down_all 前置短路，503 + routeReason=down_all，不打上游', async () => {
    const pa = providerCfg({ name: 'pa' })
    const rt = buildRt({ pa })
    // connect 类 3 次 → 熔断 60s
    for (let i = 0; i < 3; i++) recordOutcome(rt, 'pa', { ok: false, cls: 'connect' })
    const err = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts() as never).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(UpstreamError)
    expect((err as UpstreamError).status).toBe(503)
    expect((err as UpstreamError).routeReason).toBe('down_all')
  })

  it('并发闸排队超时且链中还有候选：跳到下一家（queue_full 留痕），不再回 429', async () => {
    const h = fakeHome()
    const mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      const pa = providerCfg({ name: 'pa', base_url: mock.url, key_ref: 'file:pa', max_concurrency: 1 })
      const pb = providerCfg({ name: 'pb', base_url: mock.url, key_ref: 'file:pb' })
      const rt = buildRt({ pa, pb }, { queue_wait_ms: 30 })
      const cfg = rt.config as Config
      const held = await acquireProviderSlot(rt, 'pa', 1, 1000, undefined) // 占满 pa 唯一槽位
      try {
        const r = await forwardWithFailover(rt, baseOn(cfg, 'pa'), {
          ...fwdOpts(),
          fallbackIds: ['pb'],
        } as never)
        expect(r.usedProviderId).toBe('pb')
        expect(r.status).toBe(200)
        expect(r.reason).toContain('queue_full:pa')
        expect(r.reason).toContain('failover_to:pb')
        expect(r.reason).toContain('replayed_from:pa')
      } finally {
        held.release()
      }
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('客户端已断开时取并发槽：aborted 错误原样上抛（不走 429 包装、不迭代候选）', async () => {
    const pa = providerCfg({ name: 'pa', max_concurrency: 1 })
    const rt = buildRt({ pa })
    const cfg = rt.config as Config
    const held = await acquireProviderSlot(rt, 'pa', 1, 1000, undefined)
    try {
      const ctrl = new AbortController()
      ctrl.abort()
      await expect(
        forwardWithFailover(rt, baseOn(cfg, 'pa'), { ...fwdOpts(), signal: ctrl.signal } as never)
      ).rejects.toThrow('aborted')
    } finally {
      held.release()
    }
  })

  it('上游 429 带 Retry-After ≤5s：原地退避后同候选重试一次（retried_429 留痕）', async () => {
    const h = fakeHome()
    const mock = await startMock((_req, res, i) => {
      if (i === 0) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
        res.end('{"error":{"message":"rate limited"}}')
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      }
    })
    try {
      await setSecret('pa', 'sk-pa', 'file')
      const pa = providerCfg({ name: 'pa', base_url: mock.url, key_ref: 'file:pa' })
      const rt = buildRt({ pa })
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts() as never)
      expect(r.status).toBe(200)
      expect(r.reason).toBe('retried_429:pa')
      expect(mock.count()).toBe(2)
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('429 退避等待期间客户端断开：sleep 中止、错误上抛，不再打第二发', async () => {
    const h = fakeHome()
    const mock = await startMock((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' })
      res.end('{"error":{"message":"rate limited"}}')
    })
    try {
      await setSecret('pa', 'sk-pa', 'file')
      const pa = providerCfg({ name: 'pa', base_url: mock.url, key_ref: 'file:pa' })
      const rt = buildRt({ pa })
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 80)
      try {
        await expect(
          forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), { ...fwdOpts(), signal: ctrl.signal } as never)
        ).rejects.toThrow('aborted')
        expect(mock.count()).toBe(1)
      } finally {
        clearTimeout(timer)
      }
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('failover_status_codes 白名单含 500：首候选 5xx 记账 + 排空后切下一候选', async () => {
    const h = fakeHome()
    const bad = await startMock((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"boom"}}')
    })
    const good = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      const pa = providerCfg({ name: 'pa', base_url: bad.url, key_ref: 'file:pa' })
      const pb = providerCfg({ name: 'pb', base_url: good.url, key_ref: 'file:pb' })
      const rt = buildRt({ pa, pb }, { failover_status_codes: [500] })
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), {
        ...fwdOpts(),
        fallbackIds: ['pb'],
      } as never)
      expect(r.usedProviderId).toBe('pb')
      expect(r.reason).toBe('failover_to:pb,replayed_from:pa')
      expect(bad.count()).toBe(1) // 排空后切换，不重试同候选
    } finally {
      await bad.close()
      await good.close()
      h.restore()
    }
  })

  it('全部候选 transport 层失败（连接拒绝）：耗尽后收尾 502 down_all（非 skip_all）', async () => {
    const h = fakeHome()
    // 先起再关：拿到一个必然无人监听的端口
    const s = http.createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const port = (s.address() as AddressInfo).port
    await new Promise<void>((r) => s.close(() => r()))
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      const dead = `http://127.0.0.1:${port}`
      const pa = providerCfg({ name: 'pa', base_url: dead, key_ref: 'file:pa' })
      const pb = providerCfg({ name: 'pb', base_url: dead, key_ref: 'file:pb' })
      const rt = buildRt({ pa, pb })
      const err = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), {
        ...fwdOpts(),
        fallbackIds: ['pb'],
      } as never).then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(UpstreamError)
      expect((err as UpstreamError).status).toBe(502)
      expect((err as UpstreamError).routeReason).toBe('down_all')
      expect((err as UpstreamError).message).toContain('连接失败')
    } finally {
      h.restore()
    }
  })
})

describe('relay · forwardToUpstream 鉴权与超时分类', () => {
  it('auth_style=x-api-key：注入 x-api-key 头且不带 authorization', async () => {
    const h = fakeHome()
    const mock = await startMock((req, res) => {
      void req
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    try {
      await setSecret('pk', 'sk-x', 'file')
      const pk = providerCfg({ name: 'pk', base_url: mock.url, key_ref: 'file:pk', auth_style: 'x-api-key' })
      const rt = buildRt({ pk })
      const r = await forwardToUpstream(rt, baseOn(rt.config as Config, 'pk'), fwdOpts() as never)
      expect(r.status).toBe(200)
      expect(mock.reqs[0].headers['x-api-key']).toBe('sk-x')
      expect(mock.reqs[0].headers.authorization).toBeUndefined()
      expect(mock.reqs[0].headers['anthropic-version']).toBe('2023-06-01')
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('响应头超时（headers_timeout_ms）：transport=timeout 分类与专属文案，与连接失败区分', async () => {
    const h = fakeHome()
    const hold = await startMock(() => { /* 收下连接但永不响应 */ })
    try {
      await setSecret('pt', 'sk-pt', 'file')
      const pt = providerCfg({ name: 'pt', base_url: hold.url, key_ref: 'file:pt' })
      const rt = buildRt({ pt }, { headers_timeout_ms: 60 })
      const err = await forwardToUpstream(rt, baseOn(rt.config as Config, 'pt'), fwdOpts() as never).then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(UpstreamError)
      expect((err as UpstreamError).status).toBe(502)
      expect((err as UpstreamError).transport).toBe('timeout')
      expect((err as UpstreamError).message).toContain('响应头超时')
    } finally {
      await hold.close()
      h.restore()
    }
  })
})

describe('relay · topLevelModel 浅扫描鲁棒性（拿不准一律 null 回落全量解析）', () => {
  it('非顶层对象 / 截断体 / 转义键 / 非法转义值 → null', () => {
    expect(topLevelModel(Buffer.from(''))).toBeNull()
    expect(topLevelModel(Buffer.from('[1,2]'))).toBeNull()
    expect(topLevelModel(Buffer.from('{'))).toBeNull() // 顶层键截断
    expect(topLevelModel(Buffer.from('{"a'))).toBeNull() // 键名截断
    expect(topLevelModel(Buffer.from('{"a"'))).toBeNull() // 缺冒号前截断
    expect(topLevelModel(Buffer.from('{"a":'))).toBeNull() // 冒号后截断
    expect(topLevelModel(Buffer.from('{"mo\\u0064el":"m"}'))).toBeNull() // 转义键放弃对比
    expect(topLevelModel(Buffer.from('{"model":"unterminated'))).toBeNull() // 字符串值截断
    expect(topLevelModel(Buffer.from('{"model":"bad\\uZZ"}'))).toBeNull() // 值解码失败
    // } 后残留垃圾是宽容侧的启发式：完整顶层对象已闭合即取值（无效体上游同样拒绝，
    // 网关不做前置校验）——行为锚点，非缺陷
    expect(topLevelModel(Buffer.from('{"model":"m"} trail'))).toBe('m')
  })

  it('嵌套结构 / 标量值跳过后仍取到顶层 model；重复键取最后；非字符串 model → undefined', () => {
    expect(topLevelModel(Buffer.from('{"a":{"b":"c"},"model":"m"}'))).toBe('m')
    expect(topLevelModel(Buffer.from('{"a":[1,{"b":"x"}],"model":"m"}'))).toBe('m')
    expect(topLevelModel(Buffer.from('{"n":5,"model":"m"}'))).toBe('m')
    expect(topLevelModel(Buffer.from('{"model":123}'))).toBeUndefined()
    expect(topLevelModel(Buffer.from('{"model":null}'))).toBeUndefined()
    expect(topLevelModel(Buffer.from('{"model":"a","model":"b"}'))).toBe('b')
  })
})

describe('relay · rewriteModel 全量解析回落路径（scan=null 时与原实现逐字节等价）', () => {
  function tgt(profileOver: Partial<ProfileConfig> = {}, modelOverride?: string): ResolvedTarget {
    return {
      harness: 'test',
      profileName: 'p',
      profile: { name: 'p', provider: 'pa', ...profileOver },
      provider: providerCfg({ name: 'pa' }),
      ...(modelOverride ? { modelOverride } : {}),
    }
  }
  const CHAT = '/v1/chat/completions'

  it('非 JSON / 数组体 / 标量体：需改写但无处可写 → 原样透传不谎报', () => {
    const t = tgt({ default_model: 'dm', aliases: { m1: 'm2' } })
    expect(rewriteModel(t, Buffer.from('not-json'), CHAT).modelAfter).toBeUndefined()
    const arr = rewriteModel(t, Buffer.from('[1]'), CHAT)
    expect(arr.body.toString()).toBe('[1]')
    expect(arr.modelAfter).toBeUndefined()
    expect(rewriteModel(t, Buffer.from('5'), CHAT).body.toString()).toBe('5')
  })

  it('转义键 model 全量解析识别：有别名命中则改写，无命中则透传且 modelAfter 保留 wire 原值', () => {
    const rewritten = rewriteModel(tgt({ aliases: { m1: 'm2' } }), Buffer.from('{"mo\\u0064el":"m1"}'), CHAT)
    expect(JSON.parse(rewritten.body.toString()).model).toBe('m2')
    expect(rewritten.modelAfter).toBe('m2')
    const kept = rewriteModel(tgt(), Buffer.from('{"mo\\u0064el":"m1"}'), CHAT)
    expect(kept.body.toString()).toBe('{"mo\\u0064el":"m1"}')
    expect(kept.modelAfter).toBe('m1')
  })
})

describe('relay · 错误体翻译与解压读面', () => {
  it('translateUpstreamError：ctx 无 model 时 ? 占位；非 JSON 错误体包 upstream_error', () => {
    const notFound = JSON.parse(translateUpstreamError(404, '{"error":{"message":"model not found"}}', { providerId: 'p1' }))
    expect(notFound.modeldock.hint).toContain('refresh')
    expect(notFound.modeldock.model).toBeUndefined()
    expect(notFound.modeldock.hint).toContain('?')
    const ctxLimit = JSON.parse(translateUpstreamError(400, 'maximum context length exceeded', { providerId: 'p1' }))
    expect(ctxLimit.modeldock.hint).toContain('上下文')
    const plain = JSON.parse(translateUpstreamError(503, 'plain text', { providerId: 'p1' }))
    expect(plain.error.type).toBe('upstream_error')
    expect(plain.error.message).toContain('plain text')
  })

  it('readUpstreamErrorText：deflate（zlib/裸流两形态）、br、大写头、无 arrayBuffer 体、zstd', async () => {
    const raw = Buffer.from('{"error":"boom"}')
    const bodyOf = (b: Buffer) => {
      const ab = new ArrayBuffer(b.byteLength)
      new Uint8Array(ab).set(b)
      return { arrayBuffer: async () => ab, text: async () => b.toString('utf8') }
    }
    expect(await readUpstreamErrorText({ 'content-encoding': 'deflate' }, bodyOf(zlib.deflateSync(raw)))).toBe(raw.toString('utf8'))
    expect(await readUpstreamErrorText({ 'content-encoding': 'deflate' }, bodyOf(zlib.deflateRawSync(raw)))).toBe(raw.toString('utf8'))
    expect(await readUpstreamErrorText({ 'content-encoding': 'br' }, bodyOf(zlib.brotliCompressSync(raw)))).toBe(raw.toString('utf8'))
    expect(await readUpstreamErrorText({ 'Content-Encoding': 'gzip' }, bodyOf(zlib.gzipSync(raw)))).toBe(raw.toString('utf8'))
    if (typeof zlib.zstdCompressSync === 'function') {
      expect(await readUpstreamErrorText({ 'content-encoding': 'zstd' }, bodyOf(zlib.zstdCompressSync(raw)))).toBe(raw.toString('utf8'))
    }
    // undici body 无 arrayBuffer（异构 UpstreamBody）：回落 text() 直读，无压缩头原样返回
    expect(await readUpstreamErrorText({}, { text: async () => 'plain-error' })).toBe('plain-error')
  })
})

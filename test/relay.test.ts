import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { UpstreamError, clientProtocolFromPath, forwardWithFailover, isConnectTimeoutError, isHeadersTimeoutError, joinUpstreamUrl, upstreamEndpoint } from '../src/gateway/relay.js'
import { buildRuntime, type ResolvedTarget } from '../src/gateway/state.js'
import { setSecret } from '../src/config/secrets.js'
import { fakeHome } from './helpers.js'
import type { Config, ProviderConfig } from '../src/config/types.js'

/** 只测 relay.ts 里真实导出的纯函数。
 *  不要在这里「复刻」实现里的正则（如 ROUTED_PATH_RE / CLAUDE_BUILTIN_RE）再断言它自己——
 *  那种测试与实现零耦合：实现改了正则，测试照样全绿（假绿），等于把断言写在了测试文件里。
 *  需要正则行为的用例一律走真实入口（clientProtocolFromPath / rewriteModel / 网关端到端）。
 *  rewriteModel 的模型名改写已由 relay-lazyparse.test.ts 覆盖，此处不重复。 */

function provider(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { name: 'p', base_url: 'https://api.example.com/v1', protocol: 'openai', auth_style: 'bearer', key_ref: 'file:p', ...over }
}

describe('relay · clientProtocolFromPath（入站 path → 出站协议）', () => {
  it('OpenAI 生态对话/补全/嵌入端点归 openai', () => {
    expect(clientProtocolFromPath('/v1/chat/completions')).toBe('openai')
    expect(clientProtocolFromPath('/v1/completions')).toBe('openai')
    expect(clientProtocolFromPath('/v1/embeddings')).toBe('openai')
  })

  it('responses 端点单独成类（Anthropic 新 Responses 形态，不能并进 openai）', () => {
    expect(clientProtocolFromPath('/v1/responses')).toBe('responses')
  })

  it('query string 不参与识别（客户端常带 ?beta=true 之类）', () => {
    expect(clientProtocolFromPath('/v1/chat/completions?temperature=0.5')).toBe('openai')
    expect(clientProtocolFromPath('/v1/responses?stream=true')).toBe('responses')
  })

  it('messages 端点与 count_tokens 走 anthropic——显式签名，不受 provider 自身协议回退带偏（openai 多协议 provider 的 endpoints.anthropic 由此可达）', () => {
    expect(clientProtocolFromPath('/v1/messages')).toBe('anthropic')
    expect(clientProtocolFromPath('/v1/messages/count_tokens')).toBe('anthropic')
    expect(clientProtocolFromPath('/v1/messages', 'openai')).toBe('anthropic')
    expect(clientProtocolFromPath('/v1/messages/count_tokens', 'openai')).toBe('anthropic')
    expect(clientProtocolFromPath('/v1/messages?beta=true', 'openai')).toBe('anthropic')
  })

  it('非对话端点回退「provider 自身协议」而不是硬编码 anthropic', () => {
    expect(clientProtocolFromPath('/v1/models')).toBe('anthropic') // 默认 fallback
    expect(clientProtocolFromPath('/v1/models', 'openai')).toBe('openai')
    expect(clientProtocolFromPath('/v1/files', 'responses')).toBe('responses')
  })
})

describe('relay · upstreamEndpoint（按协议取上游端点）', () => {
  it('默认协议可回退 base_url', () => {
    expect(upstreamEndpoint(provider(), 'openai')).toBe('https://api.example.com/v1')
  })

  it('endpoints 显式配置优先于 base_url 回退', () => {
    const p = provider({ endpoints: { openai: 'https://openai.example.com/v1', anthropic: 'https://anthropic.example.com' } })
    expect(upstreamEndpoint(p, 'anthropic')).toBe('https://anthropic.example.com')
    expect(upstreamEndpoint(p, 'openai')).toBe('https://openai.example.com/v1')
  })

  it('缺该协议端点 → 抛可操作错误，且标记 candidateSkip（路由跳下一个候选而非整条链失败）', () => {
    const p = provider({ protocol: 'anthropic', base_url: 'https://api.anthropic.com' })
    let err: unknown
    try {
      upstreamEndpoint(p, 'openai')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UpstreamError)
    const e = err as UpstreamError
    expect(e.status).toBe(400)
    expect(e.candidateSkip).toBe(true)
    expect(e.message).toContain('openai') // 文案含协议名（不锁具体语言）
    expect(e.hint).toBeTruthy()
  })
})

describe('relay · joinUpstreamUrl（出站 URL 拼接）', () => {
  it('anthropic：端点不带版本段（各厂商约定 /anthropic 直接接 /v1/messages）', () => {
    expect(joinUpstreamUrl('https://api.deepseek.com/anthropic', '/v1/messages', 'anthropic'))
      .toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(joinUpstreamUrl('https://api.anthropic.com', '/v1/messages?beta=true', 'anthropic'))
      .toBe('https://api.anthropic.com/v1/messages?beta=true')
  })

  it('openai/responses：端点已带版本段时客户端 /v1 前缀并入端点版本（避免 /v1/v1、/v4/v1）', () => {
    expect(joinUpstreamUrl('https://api.deepseek.com/v1', '/v1/chat/completions', 'openai'))
      .toBe('https://api.deepseek.com/v1/chat/completions')
    expect(joinUpstreamUrl('https://ark.example.com/api/coding/v3', '/v1/chat/completions', 'openai'))
      .toBe('https://ark.example.com/api/coding/v3/chat/completions')
    expect(joinUpstreamUrl('https://api.zhipu.com/paas/v4', '/v1/responses', 'responses'))
      .toBe('https://api.zhipu.com/paas/v4/responses')
  })

  it('openai：端点不带版本段则客户端路径整段保留', () => {
    expect(joinUpstreamUrl('https://api.deepseek.com', '/v1/chat/completions', 'openai'))
      .toBe('https://api.deepseek.com/v1/chat/completions')
  })

  it('尾部斜杠归一，query 与百分号编码原样透传', () => {
    expect(joinUpstreamUrl('https://api.example.com/v1/', '/v1/chat/completions', 'openai'))
      .toBe('https://api.example.com/v1/chat/completions')
    expect(joinUpstreamUrl('https://api.example.com/v1', '/v1/chat/completions?model=test%20model&temperature=0.5', 'openai'))
      .toBe('https://api.example.com/v1/chat/completions?model=test%20model&temperature=0.5')
  })

  it('空客户端路径只留端点（去尾斜杠）', () => {
    expect(joinUpstreamUrl('https://api.example.com/v1', '', 'openai')).toBe('https://api.example.com/v1')
  })

  it('端点不是合法 URL 时原样拼接、不抛（让后续请求自然报错，而不是在这里炸掉转发链路）', () => {
    expect(() => joinUpstreamUrl('not-a-url', '/v1/chat/completions', 'openai')).not.toThrow()
    expect(joinUpstreamUrl('not-a-url', '/v1/chat/completions', 'openai')).toBe('not-a-url/v1/chat/completions')
  })
})

describe('relay · isConnectTimeoutError（B2 重试分类：超时类不重试）', () => {
  it('超时类（含经 cause 包装 / Error 子类）判 true——这类失败已等满超时窗口，不该再重试', () => {
    expect(isConnectTimeoutError({ code: 'ETIMEDOUT' })).toBe(true)
    expect(isConnectTimeoutError({ code: 'UND_ERR_CONNECT_TIMEOUT' })).toBe(true)
    expect(isConnectTimeoutError({ cause: { code: 'ETIMEDOUT' } })).toBe(true)
    expect(isConnectTimeoutError(Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))).toBe(true)
  })

  it('拒绝类与其余错误判 false（毫秒级快速失败保留立即重试的原语义）', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EPIPE']) {
      expect(isConnectTimeoutError({ code })).toBe(false)
    }
    expect(isConnectTimeoutError(new Error('no code'))).toBe(false)
    expect(isConnectTimeoutError(undefined)).toBe(false)
  })
})

describe('relay · isHeadersTimeoutError（headers 超时单独分类：已送达≠可重放）', () => {
  it('UND_ERR_HEADERS_TIMEOUT（含 cause 包装 / Error 子类）判 true', () => {
    expect(isHeadersTimeoutError({ code: 'UND_ERR_HEADERS_TIMEOUT' })).toBe(true)
    expect(isHeadersTimeoutError({ cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })).toBe(true)
    expect(isHeadersTimeoutError(Object.assign(new Error('headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }))).toBe(true)
  })

  it('连接类 / 连接超时类 / 体超时类均判 false（分类不重叠：连接超时走 transport=true，体超时不经过本分类）', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      expect(isHeadersTimeoutError({ code })).toBe(false)
    }
    expect(isHeadersTimeoutError(new Error('no code'))).toBe(false)
    expect(isHeadersTimeoutError(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// forwardWithFailover（CORRECT-09 可观测性）：真实 rt + 真实 forwardToUpstream。
// 失败候选用「listen(0) 后关闭」的确认关闭端口造 transport 失败，成功候选用本地 mock；
// keys 走 fakeHome file 后端。不 mock forwardToUpstream——候选级错误分类必须走真实入口。
describe('relay · forwardWithFailover 可观测性（CORRECT-09）', () => {
  const body = Buffer.from(JSON.stringify({ model: 'm', messages: [] }))
  const ROUTED = '/v1/messages'

  async function closedPort(): Promise<number> {
    const s = http.createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const port = (s.address() as AddressInfo).port
    await new Promise<void>((r) => s.close(() => r()))
    return port
  }

  async function startMock(): Promise<{ url: string; close: () => Promise<void> }> {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    return { url, close: () => new Promise((r) => s.close(() => r())) }
  }

  function providerCfg(id: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
    return { name: id, base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: `file:${id}`, priority: 0, ...over }
  }

  function buildRt(providers: Record<string, ProviderConfig>, gatewayOver: Record<string, unknown> = {}) {
    const cfg = { providers, profiles: {}, harness: {}, gateway: { auto_fallback: false, ...gatewayOver } } as unknown as Config
    return buildRuntime(cfg, 'tok')
  }

  function baseOn(cfg: Config, id: string): ResolvedTarget {
    return {
      harness: 'test',
      profileName: 'p',
      profile: { name: 'p', provider: id },
      provider: cfg.providers[id],
    }
  }

  it('② 全候选 candidateSkip 耗尽：透传最后一个 skip 错误的 status/hint，routeReason=skip_all（不再谎报 down_all）', async () => {
    const h = fakeHome()
    try {
      const cfg = {
        providers: {
          a: providerCfg('a', { key_ref: 'file:ghost-a' }),
          b: providerCfg('b', { key_ref: 'file:ghost-b' }),
          c: providerCfg('c', { key_ref: 'file:ghost-c' }),
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers)
      const err = await forwardWithFailover(rt, baseOn(cfg, 'a'), { body, path: ROUTED, headers: {}, fallbackIds: ['b', 'c'] }).then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(UpstreamError)
      const e = err as UpstreamError
      expect(e.status).toBe(503) // 原 skip 错误的 status 原样透传（而非包装 502）
      expect(e.candidateSkip).toBe(true)
      expect(e.routeReason).toBe('skip_all')
      expect(e.hint).toContain('set-key') // 可操作指引保留（如「provider set-key 更新 key」）
      expect(e.message).toContain('p→c') // 最后一个候选（c）的错误原样透传
    } finally {
      h.restore()
    }
  })

  it('③ A→B→C 连续重放：replayed_from 累积全部被跳候选（原实现单变量覆盖只剩最后一跳）', async () => {
    const h = fakeHome()
    const mock = await startMock()
    try {
      const p1 = await closedPort()
      const p2 = await closedPort()
      const cfg = {
        providers: {
          a: providerCfg('a', { base_url: `http://127.0.0.1:${p1}` }),
          b: providerCfg('b', { base_url: `http://127.0.0.1:${p2}` }),
          c: providerCfg('c', { base_url: mock.url }),
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers)
      for (const id of ['a', 'b', 'c']) await setSecret(id, `sk-${id}`, 'file')
      const result = await forwardWithFailover(rt, baseOn(cfg, 'a'), { body, path: ROUTED, headers: {}, fallbackIds: ['b', 'c'] })
      expect(result.usedProviderId).toBe('c')
      expect(result.status).toBe(200)
      expect(result.reason).toBe('failover_to:c,replayed_from:a,b')
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('④ 正常 failover（transport 失败→次选成功）语义不变', async () => {
    const h = fakeHome()
    const mock = await startMock()
    try {
      const p1 = await closedPort()
      const cfg = {
        providers: {
          a: providerCfg('a', { base_url: `http://127.0.0.1:${p1}` }),
          b: providerCfg('b', { base_url: mock.url }),
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers)
      for (const id of ['a', 'b']) await setSecret(id, `sk-${id}`, 'file')
      const result = await forwardWithFailover(rt, baseOn(cfg, 'a'), { body, path: ROUTED, headers: {}, fallbackIds: ['b'] })
      expect(result.usedProviderId).toBe('b')
      expect(result.status).toBe(200)
      expect(result.reason).toBe('failover_to:b,replayed_from:a')
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('⑤ 上游 429 中文额度体识别为 quota 类：四个中文特征词逐一覆盖，不受 failover_status_codes 白名单限制恒可切换', async () => {
    const h = fakeHome()
    const ok = await startMock()
    try {
      // CORRECT-09 存疑 b（2026-11-03 核实）：QUOTA_BODY_RE 已含中文（额度/配额/余额/欠费，
      // 2026-11-01 v1.5.2 随 T28 转正一并修复），此处用真实 forwardWithFailover 逐词锁定——
      // 修复前只认英文（quota/insufficient）会漏判、致使该切换的不切
      for (const word of ['额度', '配额', '余额', '欠费']) {
        const quota = http.createServer((req, res) => {
          res.writeHead(429, { 'content-type': 'application/json' })
          res.end(`{"error":{"message":"该模型当前${word}已耗尽，请充值后重试"}}`)
        })
        await new Promise<void>((r) => quota.listen(0, '127.0.0.1', () => r()))
        const quotaUrl = `http://127.0.0.1:${(quota.address() as AddressInfo).port}`
        try {
          const cfg = {
            providers: {
              a: providerCfg('a', { base_url: quotaUrl }),
              b: providerCfg('b', { base_url: ok.url }),
            },
            profiles: {},
            harness: {},
          } as unknown as Config
          const rt = buildRt(cfg.providers)
          for (const id of ['a', 'b']) await setSecret(id, `sk-${id}`, 'file')
          // 无 failover_status_codes 配置（switchable=null）：429 本不在白名单，唯有 quota 识别可切换
          const result = await forwardWithFailover(rt, baseOn(cfg, 'a'), { body, path: ROUTED, headers: {}, fallbackIds: ['b'] })
          expect(result.usedProviderId).toBe('b')
          expect(result.status).toBe(200)
          expect(result.reason).toBe('failover_to:b,replayed_from:a')
        } finally {
          quota.close()
        }
      }
    } finally {
      await ok.close()
      h.restore()
    }
  })

  it('⑥ headers 超时（UND_ERR_HEADERS_TIMEOUT）：请求已送达上游——不改发第二候选、不计入 connect 熔断类', async () => {
    const h = fakeHome()
    const mock = await startMock()
    // 上游收下请求但永不回响应头（模拟非流式长推理 > headers_timeout_ms）
    const slow = http.createServer(() => {})
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()))
    const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`
    try {
      const cfg = {
        providers: {
          a: providerCfg('a', { base_url: slowUrl }),
          b: providerCfg('b', { base_url: mock.url }),
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers, { headers_timeout_ms: 200 })
      for (const id of ['a', 'b']) await setSecret(id, `sk-${id}`, 'file')
      // 旧分类（transport=true）会改发第二候选并 resolve 200 结果；修复后原样上抛、不再重放
      const err = await forwardWithFailover(rt, baseOn(cfg, 'a'), { body, path: ROUTED, headers: {}, fallbackIds: ['b'] }).then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(UpstreamError)
      const e = err as UpstreamError
      expect(e.transport).toBe('timeout') // 单独分类：非 transport=true（可安全重放）、非已送达应用层错误
      expect(e.status).toBe(502)
      expect(e.hint).toContain('headers_timeout_ms') // 修复建议指向配置项（键名语言中立）
      // 不计入 connect 熔断类：cls=undefined 中性，熔断窗口计数保持 0（transport 失败会 +1）
      expect(rt.health.get('a')?.errWindow.count ?? 0).toBe(0)
    } finally {
      slow.closeAllConnections()
      await new Promise<void>((r) => slow.close(() => r()))
      await mock.close()
      h.restore()
    }
  })

  it('⑦ headers 超时 + failover_status_codes 显式含 502：白名单授权后照常改发下一候选', async () => {
    const h = fakeHome()
    const mock = await startMock()
    const slow = http.createServer(() => {})
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()))
    const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`
    try {
      const cfg = {
        providers: {
          a: providerCfg('a', { base_url: slowUrl }),
          b: providerCfg('b', { base_url: mock.url }),
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers, { headers_timeout_ms: 200, failover_status_codes: [502] })
      for (const id of ['a', 'b']) await setSecret(id, `sk-${id}`, 'file')
      const result = await forwardWithFailover(rt, baseOn(cfg, 'a'), { body, path: ROUTED, headers: {}, fallbackIds: ['b'] })
      expect(result.usedProviderId).toBe('b')
      expect(result.status).toBe(200)
      expect(result.reason).toBe('failover_to:b,replayed_from:a')
      // 白名单授权的切换同样不计 connect 熔断（该类恒为中性）
      expect(rt.health.get('a')?.errWindow.count ?? 0).toBe(0)
    } finally {
      slow.closeAllConnections()
      await new Promise<void>((r) => slow.close(() => r()))
      await mock.close()
      h.restore()
    }
  })
})

describe('relay · forwardWithFailover attempts 留痕（逐候选记录 + 跳过原因短码，2026-11-08 协议不匹配排障）', () => {
  const body = Buffer.from(JSON.stringify({ model: 'm', messages: [] }))
  const ROUTED = '/v1/messages?beta=true'

  async function startMock(status: number, resBody: string): Promise<{ url: string; close: () => Promise<void> }> {
    const s = http.createServer((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(resBody)
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    return { url, close: () => new Promise((r) => s.close(() => r())) }
  }

  function providerCfg(id: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
    return { name: id, base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: `file:${id}`, priority: 0, ...over }
  }

  function buildRt(providers: Record<string, ProviderConfig>) {
    const cfg = { providers, profiles: {}, harness: {}, gateway: { auto_fallback: false } } as unknown as Config
    return buildRuntime(cfg, 'tok')
  }

  function baseOn(cfg: Config, id: string): ResolvedTarget {
    return { harness: 'test', profileName: 'p', profile: { name: 'p', provider: id }, provider: cfg.providers[id] }
  }

  it('① 协议端点缺失候选被跳过：attempts 首跳 note=proto_endpoint_missing、末跳真实 404（bigmodel→coding-plan 场景）', async () => {
    const h = fakeHome()
    const mock = await startMock(404, '{"error":{"code":"UnsupportedModel","message":"The requested model does not support the coding plan feature."}}')
    try {
      const cfg = {
        providers: {
          a: providerCfg('a', { base_url: 'http://127.0.0.1:1', protocol: 'openai' }), // openai-only：无 anthropic 端点
          b: providerCfg('b', { base_url: mock.url }),
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers)
      for (const id of ['a', 'b']) await setSecret(id, `sk-${id}`, 'file')
      const out = await forwardWithFailover(rt, baseOn(cfg, 'a'), { body, path: ROUTED, headers: {}, fallbackIds: ['b'] })
      expect(out.status).toBe(404)
      expect(out.reason).toContain('replayed_from:a')
      expect(out.cause).toBe('upstream_4xx')
      expect(out.attempts).toHaveLength(2)
      expect(out.attempts![0]).toMatchObject({ provider: 'a', note: 'proto_endpoint_missing' })
      expect(out.attempts![1].provider).toBe('b')
      expect(out.attempts![1].status).toBe(404)
      expect(typeof out.attempts![1].ms).toBe('number')
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('② 直连成功不写 attempts（日志保持精简）', async () => {
    const h = fakeHome()
    const mock = await startMock(200, '{"ok":true}')
    try {
      const cfg = { providers: { a: providerCfg('a', { base_url: mock.url }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      await setSecret('a', 'sk-a', 'file')
      const out = await forwardWithFailover(rt, baseOn(cfg, 'a'), { body, path: ROUTED, headers: {} })
      expect(out.status).toBe(200)
      expect(out.reason).toBeUndefined()
      expect(out.attempts).toBeUndefined()
      expect(out.cause).toBeUndefined()
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('③ 全候选 candidateSkip 耗尽：抛错携带 attempts，notes 全为 key_pool_empty', async () => {
    const h = fakeHome()
    try {
      const cfg = {
        providers: { a: providerCfg('a', { key_ref: 'file:ghost-a' }), b: providerCfg('b', { key_ref: 'file:ghost-b' }) },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers)
      const err = await forwardWithFailover(rt, baseOn(cfg, 'a'), { body, path: ROUTED, headers: {}, fallbackIds: ['b'] }).then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(UpstreamError)
      const e = err as UpstreamError
      expect(e.routeReason).toBe('skip_all')
      expect(e.cause).toBe('key_pool_empty')
      expect(e.attempts).toHaveLength(2)
      expect(e.attempts!.every((a) => a.provider && a.note === 'key_pool_empty')).toBe(true)
    } finally {
      h.restore()
    }
  })
})

// ---------------------------------------------------------------------------
// 模型级容灾（model_fallback M1）：同服务商内、仅额度耗尽触发——链尾合成备用模型候选。
// 真实入口（真实 forwardToUpstream + 本地 mock 上游按请求体 model 分流），不 mock 模块。
describe('relay · forwardWithFailover 模型级容灾链尾合成（model_fallback M1）', () => {
  const ROUTED = '/v1/messages'
  const QUOTA_BODY = JSON.stringify({ error: { message: 'Insufficient Balance (request_id: 1)' } })

  /** 按请求体 model 字段分流的 mock 上游：route(model) 决定响应；记录每次收到的模型名。 */
  async function startModelMock(
    route: (model: string) => { status: number; body: string }
  ): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
    const seen: string[] = []
    const s = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        let model = ''
        try {
          model = (JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { model?: string }).model ?? ''
        } catch {
          /* 非 JSON 体按空模型处理 */
        }
        seen.push(model)
        const out = route(model)
        res.writeHead(out.status, { 'content-type': 'application/json' })
        res.end(out.body)
      })
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    return {
      url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
      seen,
      close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()) }),
    }
  }

  function providerCfg(id: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
    return { name: id, base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: `file:${id}`, priority: 0, ...over }
  }

  function buildRt(providers: Record<string, ProviderConfig>, gatewayOver: Record<string, unknown> = {}) {
    const cfg = { providers, profiles: {}, harness: {}, gateway: { auto_fallback: false, ...gatewayOver } } as unknown as Config
    return buildRuntime(cfg, 'tok')
  }

  function baseOn(cfg: Config, id: string): ResolvedTarget {
    return { harness: 'test', profileName: 'p', profile: { name: 'p', provider: id }, provider: cfg.providers[id] }
  }

  function bodyOf(model: string): Buffer {
    return Buffer.from(JSON.stringify({ model, messages: [] }))
  }

  it('链尾 402 → 合成候选换备用模型 → 200：fallback_to 留痕、不打 failover_to（provider 没换）、attempts 逐跳', async () => {
    const h = fakeHome()
    const mock = await startModelMock((model) =>
      model === 'mB' ? { status: 200, body: '{"ok":true}' } : { status: 402, body: QUOTA_BODY },
    )
    try {
      await setSecret('a', 'sk-a', 'file')
      const cfg = {
        providers: { a: providerCfg('a', { base_url: mock.url, model_fallback: { mA: 'mB' } }) },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers)
      const out = await forwardWithFailover(rt, baseOn(cfg, 'a'), { body: bodyOf('mA'), path: ROUTED, headers: {} })
      expect(out.status).toBe(200)
      expect(out.usedProviderId).toBe('a')
      expect(out.reason).toBe('fallback_to:mB') // 恰为这一个 mark：无 failover_to:a、无 replayed_from:a
      expect(out.cause).toBeUndefined()
      expect(out.attempts).toHaveLength(2)
      expect(out.attempts![0]).toMatchObject({ provider: 'a', status: 402 })
      expect(out.attempts![1]).toMatchObject({ provider: 'a', status: 200 })
      expect(mock.seen).toEqual(['mA', 'mB'])
      // provider 级熔断窗口不累计 quota（分流给模型粒度）：errWindow.count 保持 0
      expect(rt.health.get('a')?.errWindow.count ?? 0).toBe(0)
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('链中段 quota 仍优先切 provider 候选（合成只在链尾）；quota 记账分流到模型粒度', async () => {
    const h = fakeHome()
    const aMock = await startModelMock((model) =>
      model === 'mB' ? { status: 200, body: '{"ok":true}' } : { status: 402, body: QUOTA_BODY },
    )
    const bMock = await startModelMock(() => ({ status: 200, body: '{"ok":true}' }))
    try {
      await setSecret('a', 'sk-a', 'file')
      await setSecret('b', 'sk-b', 'file')
      const cfg = {
        providers: {
          a: providerCfg('a', { base_url: aMock.url, model_fallback: { mA: 'mB' } }),
          b: providerCfg('b', { base_url: bMock.url }),
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers)
      const out = await forwardWithFailover(rt, baseOn(cfg, 'a'), { body: bodyOf('mA'), path: ROUTED, headers: {}, fallbackIds: ['b'] })
      expect(out.usedProviderId).toBe('b')
      expect(out.reason).toBe('failover_to:b,replayed_from:a')
      expect(aMock.seen).toEqual(['mA']) // 链中段不合成：a 只收到主模型一发
      expect(bMock.seen).toEqual(['mA'])
      // 记账分流：a 的 quota 记在模型粒度（1 笔），provider 级窗口 0
      expect(rt.modelHealth?.get('a\u0000mA')?.errWindow.count).toBe(1)
      expect(rt.health.get('a')?.errWindow.count ?? 0).toBe(0)
    } finally {
      await aMock.close()
      await bMock.close()
      h.restore()
    }
  })

  it('非额度失败不触发合成：429（无额度体）/ 5xx 原样回传且只打一发；transport 失败走 catch 更到不了合成', async () => {
    const h = fakeHome()
    for (const [status, resBody, wantCause] of [
      [429, '{"error":{"message":"rate limited, slow down"}}', 'upstream_4xx'],
      [500, '{"error":{"message":"boom"}}', 'upstream_5xx'],
    ] as const) {
      const mock = await startModelMock(() => ({ status, body: resBody }))
      try {
        await setSecret('a', 'sk-a', 'file')
        const cfg = {
          providers: { a: providerCfg('a', { base_url: mock.url, model_fallback: { mA: 'mB' } }) },
          profiles: {},
          harness: {},
        } as unknown as Config
        const rt = buildRt(cfg.providers)
        const out = await forwardWithFailover(rt, baseOn(cfg, 'a'), { body: bodyOf('mA'), path: ROUTED, headers: {} })
        expect(out.status).toBe(status)
        expect(out.cause).toBe(wantCause)
        expect(mock.seen).toEqual(['mA']) // 映射虽在，非额度不合成：只打主模型一发
      } finally {
        await mock.close()
      }
    }
    // transport 失败（连接拒绝）：异常路径，根本到不了链尾合成判定
    const s = http.createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const deadPort = (s.address() as AddressInfo).port
    await new Promise<void>((r) => s.close(() => r()))
    try {
      await setSecret('t', 'sk-t', 'file')
      const cfg = {
        providers: { t: providerCfg('t', { base_url: `http://127.0.0.1:${deadPort}`, model_fallback: { mA: 'mB' } }) },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRt(cfg.providers)
      const err = await forwardWithFailover(rt, baseOn(cfg, 't'), { body: bodyOf('mA'), path: ROUTED, headers: {} }).then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(UpstreamError)
      expect((err as UpstreamError).status).toBe(502)
      expect((err as UpstreamError).routeReason).toBe('down_all')
    } finally {
      h.restore()
    }
  })
})

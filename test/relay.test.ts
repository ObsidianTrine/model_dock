import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { UpstreamError, clientProtocolFromPath, forwardWithFailover, isConnectTimeoutError, joinUpstreamUrl, upstreamEndpoint } from '../src/gateway/relay.js'
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

  it('messages 端点与 count_tokens 走 anthropic', () => {
    expect(clientProtocolFromPath('/v1/messages')).toBe('anthropic')
    expect(clientProtocolFromPath('/v1/messages/count_tokens')).toBe('anthropic')
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

  function buildRt(providers: Record<string, ProviderConfig>) {
    const cfg = { providers, profiles: {}, harness: {}, gateway: { auto_fallback: false } } as unknown as Config
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
})

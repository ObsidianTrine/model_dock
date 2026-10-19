import { describe, expect, it } from 'vitest'
import { Agent, ProxyAgent } from 'undici'
import { buildDispatcher } from '../src/util/net.js'

/** 与 hotpath.test.ts 的「direct 单例 + env 分流冒烟」互补：这里补环境变量变体与非法输入。
 *
 *  ⚠ 代理环境变量是进程级全局：vitest 配置为 singleFork（全进程共享），不还原就会污染
 *  同进程里后续所有测试文件。所以四个变体一律「先存后删、finally 还原」——不能直接
 *  delete 了事，那会把开发者机器上真实的代理变量从整套测试里抹掉（并让后续用例走直连）。 */

const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const

function withProxyEnv(env: Partial<Record<(typeof PROXY_KEYS)[number], string>>, fn: () => void): void {
  const saved = new Map<string, string | undefined>()
  for (const k of PROXY_KEYS) {
    saved.set(k, process.env[k])
    delete process.env[k]
  }
  try {
    Object.assign(process.env, env)
    fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('net · buildDispatcher 代理分流', () => {
  it('未配置 / direct → 共享直连 Agent（单例，跨请求复用同一连接池）', () => {
    const direct = buildDispatcher(undefined)
    expect(direct).toBeInstanceOf(Agent)
    expect(buildDispatcher()).toBe(direct)
    expect(buildDispatcher('direct')).toBe(direct)
  })

  it('显式代理 URL → ProxyAgent', () => {
    expect(buildDispatcher('http://127.0.0.1:7890')).toBeInstanceOf(ProxyAgent)
  })

  it('env 模式读大写 HTTPS_PROXY / HTTP_PROXY', () => {
    withProxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' }, () => {
      expect(buildDispatcher('env')).toBeInstanceOf(ProxyAgent)
    })
    withProxyEnv({ HTTP_PROXY: 'http://127.0.0.1:7890' }, () => {
      expect(buildDispatcher('env')).toBeInstanceOf(ProxyAgent)
    })
  })

  it('env 模式兼容小写 https_proxy / http_proxy（clash 等工具常只写小写）', () => {
    withProxyEnv({ https_proxy: 'http://127.0.0.1:7890' }, () => {
      expect(buildDispatcher('env')).toBeInstanceOf(ProxyAgent)
    })
    withProxyEnv({ http_proxy: 'http://127.0.0.1:7890' }, () => {
      expect(buildDispatcher('env')).toBeInstanceOf(ProxyAgent)
    })
  })

  it('env 模式无代理变量 → 回退同一个共享直连 Agent', () => {
    withProxyEnv({}, () => {
      expect(buildDispatcher('env')).toBe(buildDispatcher(undefined))
    })
  })

  it('env 模式优先取 HTTPS_PROXY 而非 HTTP_PROXY（前者非法时直接暴露，说明读的是它）', () => {
    withProxyEnv({ HTTPS_PROXY: 'not-a-url', HTTP_PROXY: 'http://127.0.0.1:7890' }, () => {
      expect(() => buildDispatcher('env')).toThrow()
    })
  })

  it('非法 / 空代理值在构造期就抛，不静默退回直连（避免「以为走代理其实直连」）', () => {
    expect(() => buildDispatcher('')).toThrow()
    expect(() => buildDispatcher('not-a-url')).toThrow()
  })
})

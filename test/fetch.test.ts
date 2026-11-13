import { describe, expect, it } from 'vitest'
import http from 'node:http'
import { once } from 'node:events'
import { fetchModelIds, __testProxyDispatcherCount } from '../src/providers/fetch.js'
import { setSecret } from '../src/config/secrets.js'
import { fakeHome } from './helpers.js'
import type { ProviderConfig } from '../src/config/types.js'

/** 「拉取成功 + 元数据解析」的正路已由 modelmeta.test.ts 用 mock 上游覆盖；这里只补失败语义与
 *  鉴权头归属：失败必须报可操作错误（列出实际试过的候选地址）、key 缺失要在发请求前就失败、
 *  anthropic 协议要带 anthropic-version + 按 auth_style 选 x-api-key / Bearer。
 *  mock 上游一律 listen(0) 取随机端口（绝不写死端口，更不碰 8687/8890）。 */

interface Mock {
  base: string
  requests: { url: string; headers: http.IncomingHttpHeaders }[]
  close: () => void
}

async function startMock(handler: http.RequestListener): Promise<Mock> {
  const requests: { url: string; headers: http.IncomingHttpHeaders }[] = []
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers })
    handler(req, res)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => {
      server.closeAllConnections?.()
      server.close()
    },
  }
}

function provider(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { name: 't', base_url: 'http://127.0.0.1:1/v1', protocol: 'openai', auth_style: 'bearer', key_ref: 'file:none', proxy: 'direct', ...over }
}

describe('fetch · fetchModelIds 失败语义', () => {
  it('key 未设置：发请求前就失败，并给出可执行命令', async () => {
    const h = fakeHome()
    const mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm' }] }))
    })
    try {
      await expect(fetchModelIds(provider({ base_url: mock.base, key_ref: 'file:missing-key' })))
        .rejects.toThrow(/provider set-key/)
      expect(mock.requests).toHaveLength(0)
    } finally {
      mock.close()
      h.restore()
    }
  })

  it('上游所有候选都非 200：报错列出试过的地址与状态码（用户才知道该改哪个 base_url）', async () => {
    const h = fakeHome()
    const mock = await startMock((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
    try {
      const ref = await setSecret('fetch-404', 'sk-secret-should-not-leak', 'file')
      const err = await fetchModelIds(provider({ base_url: `${mock.base}/v1`, key_ref: ref })).then(
        () => null,
        (e: Error) => e
      )
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toMatch(/HTTP 404/)
      expect(err!.message).toContain('/models') // 派生出的候选地址要出现在错误里
      expect(mock.requests.length).toBeGreaterThan(0)
      // key 明文绝不能进错误信息（错误会进日志 / 界面）
      expect(err!.message).not.toContain('sk-secret-should-not-leak')
    } finally {
      mock.close()
      h.restore()
    }
  })

  it('200 但模型列表为空：不算成功，继续试后续候选直至报错', async () => {
    const h = fakeHome()
    const mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
    })
    try {
      const ref = await setSecret('fetch-empty', 'sk-test', 'file')
      await expect(fetchModelIds(provider({ base_url: mock.base, key_ref: ref })))
        .rejects.toThrow(/没有模型列表/)
      expect(mock.requests.length).toBeGreaterThan(1) // 逐个候选都试过了
    } finally {
      mock.close()
      h.restore()
    }
  })

  it('chunked 超大响应（无 content-length）→ 流式计数超限跳过，不无界缓冲（回归）', async () => {
    const h = fakeHome()
    const mock = await startMock((_req, res) => {
      // 不设 content-length → Node 自动 chunked。8MB/块 × 4 块 = 32MB > 20MB 上限；
      // 内存内 mock 同步连写可接受（真客户端侧 readBodyCapped 在 20MB 处停消费）
      res.writeHead(200, { 'content-type': 'application/json' })
      const big = Buffer.alloc(8 * 1024 * 1024, 0x78) // 'x' × 8MB
      for (let i = 0; i < 4; i++) res.write(big)
      res.end()
    })
    try {
      const ref = await setSecret('fetch-chunked-big', 'sk-test', 'file')
      await expect(fetchModelIds(provider({ base_url: mock.base, key_ref: ref })))
        .rejects.toThrow(/异常偏大|没有模型列表/)
    } finally {
      mock.close()
      h.restore()
    }
  })
})

describe('fetch · 鉴权头随协议与 auth_style 变化', () => {
  it('anthropic + x-api-key：带 anthropic-version 与 x-api-key，不带 bearer', async () => {
    const h = fakeHome()
    const mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'claude-x' }] }))
    })
    try {
      const ref = await setSecret('fetch-anthropic', 'sk-ant-test', 'file')
      const out = await fetchModelIds(
        provider({ base_url: mock.base, protocol: 'anthropic', auth_style: 'x-api-key', key_ref: ref })
      )
      expect(out.ids).toEqual(['claude-x'])
      const sent = mock.requests[0].headers
      expect(sent['anthropic-version']).toBe('2023-06-01')
      expect(sent['x-api-key']).toBe('sk-ant-test')
      expect(sent.authorization).toBeUndefined()
    } finally {
      mock.close()
      h.restore()
    }
  })
})

describe('fetch · 代理 dispatcher 缓存复用（P1-3 回归）', () => {
  it('同 proxy 连续两次 fetchModelIds 复用同一 ProxyAgent（缓存条数只 +1，fd 不逐次累积）', async () => {
    const h = fakeHome()
    // mock 兼当「代理」：handler 对任意路径（absolute-form 或 origin-form）都回 200 模型表
    const mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }))
    })
    try {
      const ref = await setSecret('fetch-proxy-cache', 'sk-test', 'file')
      const before = __testProxyDispatcherCount()
      const r1 = await fetchModelIds(provider({ base_url: `${mock.base}/v1`, key_ref: ref, proxy: mock.base }))
      expect(r1.ids).toEqual(['m1'])
      const r2 = await fetchModelIds(provider({ base_url: `${mock.base}/v1`, key_ref: ref, proxy: mock.base }))
      expect(r2.ids).toEqual(['m1'])
      expect(__testProxyDispatcherCount()).toBe(before + 1)
    } finally {
      mock.close()
      h.restore()
    }
  })

  it('resolveProxyUrl：direct/未配置 → null；显式 URL → 原样；env 读环境变量且空串视为未设', async () => {
    const { resolveProxyUrl } = await import('../src/util/net.js')
    expect(resolveProxyUrl(undefined)).toBeNull()
    expect(resolveProxyUrl('direct')).toBeNull()
    expect(resolveProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    const saved = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].map((k) => [k, process.env[k]] as const)
    try {
      for (const [k] of saved) delete process.env[k]
      expect(resolveProxyUrl('env')).toBeNull()
      process.env.HTTPS_PROXY = 'http://p:1'
      expect(resolveProxyUrl('env')).toBe('http://p:1')
      process.env.HTTPS_PROXY = ''
      expect(resolveProxyUrl('env')).toBeNull()
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

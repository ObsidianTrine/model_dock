import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { fetchEnvelopeFromUrl, listenWithRetry, projectModel } from '../src/gateway/shared.js'
import type { ModelMeta } from '../src/config/types.js'

// gateway/shared.ts 三个导出的纯单测：分享链接拉取的安全属性（fragment 不出网、10MB 封顶、协议
// 白名单、禁重定向）、端口顺延重试、模型元数据投影。全部走 listen(0) 随机端口。

interface Captured {
  url: string
  headers: http.IncomingHttpHeaders
}

const servers: http.Server[] = []
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
})

async function startStub(
  respond: (req: Captured, res: http.ServerResponse) => void
): Promise<{ port: number; seen: Captured[] }> {
  const seen: Captured[] = []
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    respond(seen[seen.length - 1], res)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return { port: (server.address() as AddressInfo).port, seen }
}

describe('fetchEnvelopeFromUrl', () => {
  it('正常拉取：fragment（口令）不发往网络，返回响应体原文', async () => {
    const stub = await startStub((_req, res) => {
      res.setHeader('content-type', 'text/plain')
      res.end('ENV-BODY')
    })
    const out = await fetchEnvelopeFromUrl(`http://127.0.0.1:${stub.port}/pull?x=1#p=secret123`)
    expect(out).toBe('ENV-BODY')
    expect(stub.seen[0].url).toBe('/pull?x=1')
    expect(stub.seen[0].url).not.toContain('secret123')
  })

  it('非 http/https 协议与非法 URL 分别抛可操作报错', async () => {
    await expect(fetchEnvelopeFromUrl('ftp://example.com/x')).rejects.toThrow('仅支持 http/https 链接')
    await expect(fetchEnvelopeFromUrl('not a url')).rejects.toThrow('链接格式不正确')
  })

  it('HTTP 404 抛「拉取失败：HTTP 404」', async () => {
    const stub = await startStub((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    await expect(fetchEnvelopeFromUrl(`http://127.0.0.1:${stub.port}/pull`)).rejects.toThrow('拉取失败：HTTP 404')
  })

  it('302 重定向被 redirect:error 拒绝，包装为「拉取失败」', async () => {
    const stub = await startStub((_req, res) => {
      res.statusCode = 302
      res.setHeader('location', 'http://127.0.0.1:1/elsewhere')
      res.end()
    })
    await expect(fetchEnvelopeFromUrl(`http://127.0.0.1:${stub.port}/pull`)).rejects.toThrow('拉取失败')
  })

  it('响应体超过 10MB 封顶：中止读取并抛「疑似异常来源」', async () => {
    const stub = await startStub((_req, res) => {
      res.end(Buffer.alloc(10 * 1024 * 1024 + 1, 97))
    })
    await expect(fetchEnvelopeFromUrl(`http://127.0.0.1:${stub.port}/pull`)).rejects.toThrow('响应体超过 10MB 上限')
  })
})

describe('listenWithRetry', () => {
  it('端口被占用：顺延到后续端口成功监听', async () => {
    const a = http.createServer()
    await new Promise<void>((r) => a.listen(0, '127.0.0.1', () => r()))
    const occupied = (a.address() as AddressInfo).port
    const b = http.createServer()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const got = await listenWithRetry(b, occupied, '127.0.0.1')
      expect(got).toBeGreaterThan(occupied)
      expect(got).toBeLessThanOrEqual(occupied + 10)
      expect((b.address() as AddressInfo).port).toBe(got)
    } finally {
      spy.mockRestore()
      await new Promise<void>((r) => b.close(() => r()))
      await new Promise<void>((r) => a.close(() => r()))
    }
  })

  it('port 0（内核分配）：返回实际监听端口', async () => {
    const s = http.createServer()
    const got = await listenWithRetry(s, 0, '127.0.0.1')
    try {
      expect(got).toBeGreaterThan(0)
      expect((s.address() as AddressInfo).port).toBe(got)
    } finally {
      await new Promise<void>((r) => s.close(() => r()))
    }
  })
})

describe('projectModel：三视图字段投影', () => {
  const meta: ModelMeta = {
    display_name: 'GLM 模型',
    context_window: 200_000,
    max_output: 32_000,
    capabilities: ['vision'],
    source: 'manual',
  }

  it('桌面视图（默认）：display_name 缺省为 null，不带 capabilities/source 内部字段', () => {
    expect(projectModel('m1', meta)).toEqual({
      id: 'm1',
      display_name: 'GLM 模型',
      context_window: 200_000,
      max_output: 32_000,
    })
    expect(projectModel('m1', meta)).not.toHaveProperty('capabilities')
    expect(projectModel('m1', meta)).not.toHaveProperty('source')
  })

  it('手机视图 nameKey：display_name 缺省回落模型 id', () => {
    const r = projectModel('m1', meta, { nameKey: true })
    expect(r.name).toBe('GLM 模型')
    const r2 = projectModel('m2', { source: 'manual' }, { nameKey: true })
    expect(r2.name).toBe('m2')
    expect(r2.display_name).toBeUndefined()
  })

  it('includeCapabilities / includeSource 按需携带；四层皆无时数值落 null', () => {
    const r = projectModel('m1', meta, { includeCapabilities: true, includeSource: true })
    expect(r.capabilities).toEqual(['vision'])
    expect(r.source).toBe('manual')
    // 明显不在内置表/目录里的 id：推测字段落 null 而非 undefined
    const unknown = projectModel('mdk-hc-unknown-model', { source: 'manual' })
    expect(unknown.context_window).toBeNull()
    expect(unknown.max_output).toBeNull()
    expect(unknown.display_name).toBeNull()
  })
})

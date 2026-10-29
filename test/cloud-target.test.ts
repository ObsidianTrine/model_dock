import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { createCloudTarget } from '../src/sync/targets/cloud.js'
import { blobRefOf } from '../src/sync/targets/types.js'

// 云端同步目标（/v1/doc 协议适配层）的分支测试：本地随机端口 stub 按用例编排响应，
// 断言实现发出的 method / url / 头 / 体，以及各状态码下的返回值与报错文案。纯单测、不碰文件系统。

interface Captured {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

const servers: http.Server[] = []
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
})

async function startStub(respond: (req: Captured, res: http.ServerResponse) => void): Promise<{ base: string; seen: Captured[] }> {
  const seen: Captured[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const captured: Captured = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      seen.push(captured)
      respond(captured, res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${port}`, seen }
}

function makeTarget(base: string): ReturnType<typeof createCloudTarget> {
  return createCloudTarget({ url: `${base}///`, token: 'tok-123', devid: 'dev1' })
}

const DOC = { rev: 3, envelope: 'ENV-3', ts: '2026-10-28T00:00:00.000Z', byDevid: 'dev2' }

describe('createCloudTarget：readManifest', () => {
  it('200：解析清单并缓存；第二次读带 if-none-match，304 走缓存', async () => {
    const stub = await startStub((req, res) => {
      if (req.headers['if-none-match'] === '3') {
        res.statusCode = 304
        res.end()
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(DOC))
    })
    const target = makeTarget(stub.base)
    const m1 = await target.readManifest()
    expect(m1).toEqual({ rev: 3, ts: DOC.ts, byDevid: 'dev2', blobRef: blobRefOf(3, 'dev1') })
    const m2 = await target.readManifest()
    expect(m2).toEqual(m1)
    expect(stub.seen).toHaveLength(2)
    expect(stub.seen[1].headers['if-none-match']).toBe('3')
  })

  it('请求剥掉 base 末尾斜杠拼出 /v1/doc，鉴权头为 Bearer', async () => {
    const stub = await startStub((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    const target = makeTarget(stub.base)
    expect(await target.readManifest()).toBeNull()
    expect(stub.seen[0].method).toBe('GET')
    expect(stub.seen[0].url).toBe('/v1/doc')
    expect(stub.seen[0].headers.authorization).toBe('Bearer tok-123')
  })

  it('404 返回 null；其余非 200 抛「读取云端文档失败（HTTP {code}）」', async () => {
    const stub = await startStub((_req, res) => {
      res.statusCode = 503
      res.end('boom')
    })
    const target = makeTarget(stub.base)
    await expect(target.readManifest()).rejects.toThrow('读取云端文档失败（HTTP 503）')
  })

  it('304 但本地无缓存：同样落「非 200」报错', async () => {
    const stub = await startStub((_req, res) => {
      res.statusCode = 304
      res.end()
    })
    const target = makeTarget(stub.base)
    await expect(target.readManifest()).rejects.toThrow('读取云端文档失败（HTTP 304）')
  })
})

describe('createCloudTarget：readBlob', () => {
  it('未拉取前抛「云端文档尚未拉取」；拉取后返回信封原文', async () => {
    const stub = await startStub((_req, res) => {
      res.end(JSON.stringify(DOC))
    })
    const target = makeTarget(stub.base)
    await expect(target.readBlob()).rejects.toThrow('云端文档尚未拉取')
    await target.readManifest()
    expect(await target.readBlob()).toBe('ENV-3')
  })
})

describe('createCloudTarget：writeManifest', () => {
  it('未暂存信封即推送：抛「推送前未暂存信封」', async () => {
    const stub = await startStub((_req, res) => res.end())
    const target = makeTarget(stub.base)
    await expect(target.writeManifest({ rev: 1, ts: 't', byDevid: 'd', blobRef: 'b' }, 0)).rejects.toThrow('推送前未暂存信封')
    expect(stub.seen).toHaveLength(0)
  })

  it('200：PUT 携带暂存信封与 if-match 基线，成功后缓存新 rev 与信封', async () => {
    const stub = await startStub((req, res) => {
      // 推送后的再读：带 if-none-match 7 进来，按真实协议回全量文档
      if (req.method === 'GET') {
        if (req.headers['if-none-match'] !== '7') {
          res.statusCode = 500
          res.end('unexpected conditional GET')
          return
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ rev: 7, envelope: 'ENV-NEW', ts: '2026-10-28T01:00:00.000Z', byDevid: 'dev1' }))
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ rev: 7 }))
    })
    const target = makeTarget(stub.base)
    await target.writeBlob(6, 'dev1', 'ENV-NEW')
    const r = await target.writeManifest(
      { rev: 6, ts: '2026-10-28T01:00:00.000Z', byDevid: 'dev1', blobRef: blobRefOf(6, 'dev1') },
      5
    )
    expect(r).toBe('ok')
    expect(stub.seen[0].method).toBe('PUT')
    expect(stub.seen[0].url).toBe('/v1/doc')
    expect(stub.seen[0].headers['if-match']).toBe('5')
    expect(stub.seen[0].headers['content-type']).toContain('application/json')
    expect(JSON.parse(stub.seen[0].body)).toEqual({ envelope: 'ENV-NEW', ts: '2026-10-28T01:00:00.000Z' })
    // 推送后：暂存槽清空、缓存信封可读；再读带 if-none-match 7，全量文档回填后信封不变
    expect(await target.readBlob()).toBe('ENV-NEW')
    await target.readManifest()
    expect(stub.seen[1].headers['if-none-match']).toBe('7')
    expect(await target.readBlob()).toBe('ENV-NEW')
    await expect(
      target.writeManifest({ rev: 7, ts: 't2', byDevid: 'dev1', blobRef: 'b' }, 7)
    ).rejects.toThrow('推送前未暂存信封')
  })

  it('409 返回 conflict；422 抛「云端拒收（疑似回滚）」；其余非 200 抛推送失败（含响应体片段）', async () => {
    const mk = async (code: number, body: string): Promise<string | Error> => {
      const stub = await startStub((_req, res) => {
        res.statusCode = code
        res.end(body)
      })
      const target = makeTarget(stub.base)
      await target.writeBlob(1, 'dev1', 'ENV')
      try {
        return await target.writeManifest({ rev: 1, ts: 't', byDevid: 'dev1', blobRef: 'b' }, 0)
      } catch (e) {
        return e as Error
      }
    }
    expect(await mk(409, '')).toBe('conflict')
    const e422 = (await mk(422, '')) as Error
    expect(e422.message).toContain('云端拒收')
    expect(e422.message).toContain('回滚')
    const e503 = (await mk(503, 'upstream boom')) as Error
    expect(e503.message).toContain('推送云端文档失败（HTTP 503）')
    expect(e503.message).toContain('upstream boom')
  })

  it('连接失败（端口已关闭）：抛「云端不可达」', async () => {
    const stub = await startStub((_req, res) => res.end())
    const port = (stub.base.match(/:(\d+)$/) as RegExpMatchArray)[1]
    await new Promise<void>((r) => servers.pop()!.close(() => r()))
    const target = createCloudTarget({ url: `http://127.0.0.1:${port}`, token: 'tok', devid: 'dev1' })
    await expect(target.readManifest()).rejects.toThrow('云端不可达')
  })
})

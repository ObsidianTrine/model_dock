import http from 'node:http'
import type net from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebdavTarget } from '../src/sync/targets/webdav.js'
import { createLocaldirTarget } from '../src/sync/targets/localdir.js'
import { createCloudTarget } from '../src/sync/targets/cloud.js'
import { fakeHome } from './helpers.js'

/**
 * 测试盲区补齐：src/sync/targets/* 分支缺口（2026-10-29 全量 coverage 实测圈出）。
 * webdav：无 dir 的根挂载、无凭据 / 仅密码（空用户名）的鉴权头、PUT 409 → MKCOL 重试成功与
 * MKCOL 失败、写前 CAS 冲突；cloud：readBlob 未拉取、writeManifest 未暂存信封、422 回滚拒收、
 * 409 conflict、成功推送 + readBlob 暂存信封、if-none-match 头携带；localdir：blob 路径越界拒绝。
 * 全部假件 listen(0) 随机端口（红线：绝不碰 8687/8890），收尾逐个关闭。
 */

function listen0(srv: http.Server): Promise<number> {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port)))
}

const closers: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const c of closers.reverse()) await c().catch(() => {})
})

interface DavReq { method: string; url: string; auth?: string; body: string }

/** 可编程 WebDAV 假件：记录请求，按 handler 返回 */
async function startDav(handler: (r: DavReq) => { code: number; body?: string }): Promise<{ port: number; reqs: DavReq[] }> {
  const reqs: DavReq[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const r: DavReq = { method: req.method ?? '', url: req.url ?? '/', auth: req.headers.authorization as string | undefined, body: Buffer.concat(chunks).toString('utf8') }
      reqs.push(r)
      const out = handler(r)
      res.writeHead(out.code, { 'content-type': 'application/json' })
      res.end(out.body ?? '')
    })
  })
  const port = await listen0(server)
  closers.push(
    () => new Promise((resolve) => server.close(() => resolve()))
  )
  return { port, reqs }
}

describe('createWebdavTarget 缺口分支', () => {
  it('无 dir：根目录直挂 modeldock-sync；无凭据：不带 authorization 头', async () => {
    const { port, reqs } = await startDav((r) => (r.method === 'GET' ? { code: 404, body: 'not found' } : { code: 405 }))
    const target = createWebdavTarget({ url: `http://127.0.0.1:${port}` })
    expect(await target.readManifest()).toBeNull()
    const manifestGet = reqs.find((r) => r.url === '/modeldock-sync/manifest.json')
    expect(manifestGet).toBeTruthy()
    expect(manifestGet!.auth).toBeUndefined()
  })

  it('仅密码（用户名缺省）：Basic 头形如 base64(":pass")；仅用户名（密码缺省）同理', async () => {
    const { port, reqs } = await startDav((r) => (r.method === 'GET' ? { code: 404 } : { code: 405 }))
    const target = createWebdavTarget({ url: `http://127.0.0.1:${port}`, password: 'pass-only' })
    await target.readManifest()
    const expected = 'Basic ' + Buffer.from(':pass-only').toString('base64')
    expect(reqs[0]!.auth).toBe(expected)

    const { port: port2, reqs: reqs2 } = await startDav((r) => (r.method === 'GET' ? { code: 404 } : { code: 405 }))
    const target2 = createWebdavTarget({ url: `http://127.0.0.1:${port2}`, username: 'user-only' })
    await target2.readManifest()
    const expected2 = 'Basic ' + Buffer.from('user-only:').toString('base64')
    expect(reqs2[0]!.auth).toBe(expected2)
  })

  it('PUT 409 → MKCOL 补建后重试成功；MKCOL 失败（403）→ 报「创建目录失败」', async () => {
    let mkcolDone = false
    const failing = await startDav((r) => {
      if (r.method === 'PUT') return { code: mkcolDone ? 201 : 409 }
      if (r.method === 'MKCOL') return { code: 403 }
      return { code: 405 }
    })
    const target = createWebdavTarget({ url: `http://127.0.0.1:${failing.port}`, username: 'u', password: 'p' })
    await expect(target.writeBlob(1, 'mdksync_a', '{"e":1}')).rejects.toThrow(/创建目录失败|Failed to create a folder/)

    mkcolDone = false
    const ok = await startDav((r) => {
      if (r.method === 'PUT') return { code: mkcolDone ? 201 : 409 }
      if (r.method === 'MKCOL') {
        mkcolDone = true
        return { code: 201 }
      }
      return { code: 405 }
    })
    const target2 = createWebdavTarget({ url: `http://127.0.0.1:${ok.port}`, username: 'u', password: 'p' })
    await target2.writeBlob(1, 'mdksync_a', '{"e":1}')
    expect(ok.reqs.some((r) => r.method === 'MKCOL')).toBe(true)
  })

  it('写前 CAS：manifest 已被他人推进（rev 不符）→ conflict，不 PUT', async () => {
    const cur = JSON.stringify({ rev: 5, ts: 't', byDevid: 'mdksync_rival', blobRef: 'blobs/5-mdksync_rival.msync' })
    const { port, reqs } = await startDav((r) => (r.method === 'GET' ? { code: 200, body: cur } : { code: 405 }))
    const target = createWebdavTarget({ url: `http://127.0.0.1:${port}`, username: 'u', password: 'p' })
    const r = await target.writeManifest({ rev: 6, ts: 't2', byDevid: 'mdksync_me', blobRef: 'blobs/6-mdksync_me.msync' }, 4)
    expect(r).toBe('conflict')
    expect(reqs.some((x) => x.method === 'PUT' && x.url.endsWith('/manifest.json'))).toBe(false)
  })
})

describe('createCloudTarget 缺口分支', () => {
  it('readBlob 未拉取 / writeManifest 未暂存信封：内部状态守卫各自报错', async () => {
    const target = createCloudTarget({ url: 'http://127.0.0.1:1', token: 'tok', devid: 'd1' })
    // @ts-expect-error 无参调用是本用例的守卫触发面（未拉取即读）
    await expect(target.readBlob()).rejects.toThrow(/尚未拉取|has not been fetched/)
    await expect(
      target.writeManifest({ rev: 1, ts: '2026-10-29T00:00:00.000Z', byDevid: 'd1', blobRef: 'blobs/1-d1.msync' }, 0)
    ).rejects.toThrow(/推送前未暂存信封|no envelope staged/)
  })

  it('readManifest 两次携带 if-none-match；304 命中缓存复用、未缓存时 304 报 HTTP 错；422 回滚拒收；409 conflict；成功推送后 readBlob 返回暂存信封', async () => {
    const stored = { rev: 5, envelope: JSON.stringify({ fmt: 'modeldock-syncenv' }) }
    let sawIfNoneMatch: string | undefined
    let sawIfMatch: string | undefined
    let serve304WithoutCache = false
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        if (req.method === 'GET' && req.url?.includes('/v1/doc')) {
          const inm = req.headers['if-none-match'] as string | undefined
          sawIfNoneMatch = inm
          if (serve304WithoutCache) {
            res.writeHead(304)
            res.end()
            return
          }
          if (inm !== undefined && String(inm) === String(stored.rev)) {
            res.writeHead(304)
            res.end()
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ rev: stored.rev, envelope: stored.envelope, ts: '2026-10-29T00:00:00.000Z', byDevid: 'mdksync_other' }))
          return
        }
        if (req.method === 'PUT' && req.url?.includes('/v1/doc')) {
          sawIfMatch = req.headers['if-match'] as string | undefined
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ts: string }
          if (body.ts.startsWith('409-')) {
            res.writeHead(409)
            res.end('conflict')
            return
          }
          if (body.ts.startsWith('422-')) {
            res.writeHead(422)
            res.end('rollback')
            return
          }
          stored.rev++
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ rev: stored.rev }))
          return
        }
        res.writeHead(405)
        res.end()
      })
    })
    const port = await listen0(server)
    closers.push(() => new Promise((r) => server.close(() => r())))
    const target = createCloudTarget({ url: `http://127.0.0.1:${port}`, token: 'tok', devid: 'd1' })

    // 未建缓存就收到 304：无缓存可复用 → 落到非 200 分支报 HTTP 304
    serve304WithoutCache = true
    await expect(target.readManifest()).rejects.toThrow(/HTTP 304/)
    serve304WithoutCache = false

    // 第一次拉取 → 200 建缓存
    const m1 = await target.readManifest()
    expect(m1?.rev).toBe(5)
    expect(sawIfNoneMatch).toBeUndefined()
    // 第二次拉取 → 带 if-none-match: 5 → 假件回 304 → 直接复用缓存清单（不发解包）
    const m2 = await target.readManifest()
    expect(m2).toEqual(m1)
    expect(sawIfNoneMatch).toBe('5')

    // 422：包时间早于云端（疑似回滚），云端拒收
    await target.writeBlob(6, 'd1', '{"fmt":"modeldock-syncenv"}')
    await expect(
      target.writeManifest({ rev: 6, ts: '422-rollback', byDevid: 'd1', blobRef: 'blobs/6-d1.msync' }, 5)
    ).rejects.toThrow(/回滚|rollback/)
    expect(sawIfMatch).toBe('5')

    // 409：他人抢先（写前暂存的信封在失败后清空，不残留到下次推送）
    await target.writeBlob(6, 'd1', '{"fmt":"modeldock-syncenv"}')
    expect(await target.writeManifest({ rev: 6, ts: '409-please', byDevid: 'd1', blobRef: 'blobs/6-d1.msync' }, 5)).toBe('conflict')

    // 成功推送：rev 前进，readBlob 返回暂存信封
    const env = JSON.stringify({ fmt: 'modeldock-syncenv', v: 1 })
    await target.writeBlob(6, 'd1', env)
    expect(await target.writeManifest({ rev: 6, ts: '2026-10-29T00:00:01.000Z', byDevid: 'd1', blobRef: 'blobs/6-d1.msync' }, 5)).toBe('ok')
    // @ts-expect-error 无参读返回暂存信封（blobRef 取内部状态）
    expect(await target.readBlob()).toBe(env)
  })
})

describe('createLocaldirTarget 缺口分支', () => {
  it('readBlob 越界 ref（../ 逃出同步根）：报「blob 路径非法」', async () => {
    const h = fakeHome()
    try {
      const target = createLocaldirTarget(h.home)
      await expect(target.readBlob('../secret.txt')).rejects.toThrow(/非法|Invalid/)
      await expect(target.readBlob('blobs/../../evil.msync')).rejects.toThrow(/非法|Invalid/)
    } finally {
      h.restore()
    }
  })
})

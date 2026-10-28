import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import { loadConfig, mutateConfig, saveConfig } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { createWebdavTarget } from '../src/sync/targets/webdav.js'
import type { SyncManifest } from '../src/sync/targets/types.js'
import { buildRuntime } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'

process.env.MODELRDOCK_DISABLE_HOLIDAY_FETCH = '1'
process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'

const homes: ReturnType<typeof fakeHome>[] = []
afterEach(() => {
  while (homes.length) homes.pop()!.restore()
})

function mkHome(): string {
  const h = fakeHome()
  homes.push(h)
  return h.home
}

/** 裸 http GET（不经 undici fetch：它会透明解压并剥掉 content-encoding，测不了 gzip 形态） */
function rawGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('loadConfig stat 记忆（PERF-27 部分收口）', () => {
  it('文件未变：重复 load 返回同一对象；mutateConfig 后读到新值', async () => {
    mkHome()
    const cfg: Config = { ...emptyConfig(), active_profile: 'a' }
    await saveConfig(cfg)
    const first = await loadConfig()
    const second = await loadConfig()
    expect(second).toBe(first) // 同一 Config 对象（parse 一次复用）
    await mutateConfig((c) => {
      c.active_profile = 'b'
    })
    const third = await loadConfig()
    expect(third).not.toBe(first)
    expect(third.active_profile).toBe('b')
  })

  it('mutateConfig 的 fn 抛错：共享对象不被污染（未落盘的改动不泄漏给后续读）', async () => {
    mkHome()
    await saveConfig({ ...emptyConfig(), active_profile: 'keep' })
    const before = await loadConfig()
    await expect(
      mutateConfig((c) => {
        c.active_profile = 'dirty'
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    const after = await loadConfig()
    expect(after.active_profile).toBe('keep')
    expect(after).not.toBe(before)
  })

  it('外部进程直写 config.toml（不经 saveConfig）：下一次 load 立即看到新内容', async () => {
    mkHome()
    await saveConfig(emptyConfig())
    await loadConfig()
    const p = path.join(process.env.MODELRDOCK_FAKE_HOME!, '.modeldock', 'config.toml')
    fs.appendFileSync(p, '\n[providers.ext]\nbase_url = "http://127.0.0.1:9"\nprotocol = "anthropic"\nauth_style = "bearer"\nkey_ref = "k"\n')
    const cfg = await loadConfig()
    expect(cfg.providers.ext?.base_url).toBe('http://127.0.0.1:9')
  })
})

/** 内存 WebDAV 假件（ETag + If-None-Match/304）：统计全量 GET 次数验证条件读生效 */
function fakeDav(): Promise<{ port: number; stats: () => { fullGets: number; notModified: number }; put: (name: string, body: string) => void; close: () => void }> {
  const store = new Map<string, { body: string; etag: string }>()
  let rev = 0
  let fullGets = 0
  let notModified = 0
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').split('/').pop() ?? '')
    if (req.method === 'GET') {
      const hit = store.get(name)
      if (!hit) {
        res.writeHead(404)
        res.end()
        return
      }
      if (req.headers['if-none-match'] === hit.etag) {
        notModified++
        res.writeHead(304, { etag: hit.etag })
        res.end()
        return
      }
      fullGets++
      res.writeHead(200, { etag: hit.etag, 'content-type': 'application/json' })
      res.end(hit.body)
      return
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        rev++
        store.set(name, { body: Buffer.concat(chunks).toString('utf8'), etag: `"v${rev}"` })
        res.writeHead(201)
        res.end()
      })
      return
    }
    res.writeHead(405)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        stats: () => ({ fullGets, notModified }),
        put: (name, body) => {
          rev++
          store.set(name, { body, etag: `"v${rev}"` })
        },
        close: () => server.close(),
      })
    })
  })
}

describe('WebDAV manifest 条件读（PERF-28）', () => {
  it('未变 tick 走 304 复用缓存（不全量下载）；远端更新后 200 取新内容', async () => {
    const dav = await fakeDav()
    try {
      const target = createWebdavTarget({ url: `http://127.0.0.1:${dav.port}/dav`, dir: 'md', username: 'u', password: 'p' })
      expect(await target.readManifest()).toBeNull()
      const m: SyncManifest = { rev: 3, ts: '2026-10-29T00:00:00Z', byDevid: 'dev-a', blobRef: 'blobs/3.dev-a.msync' }
      await target.writeManifest(m, 0)
      const first = await target.readManifest()
      expect(first?.rev).toBe(3)
      const s1 = dav.stats()
      expect(s1.fullGets).toBeGreaterThan(0)
      // 内容未变：If-None-Match 命中 304，不再全量下载，解析结果一致
      const second = await target.readManifest()
      expect(second).toEqual(first)
      const s2 = dav.stats()
      expect(s2.notModified).toBeGreaterThan(s1.notModified)
      expect(s2.fullGets).toBe(s1.fullGets)
      // 远端被另一台机器改写：etag 变化 → 200 全量取回新 rev
      dav.put('manifest.json', JSON.stringify({ ...m, rev: 4, byDevid: 'dev-b' }))
      const third = await target.readManifest()
      expect(third?.rev).toBe(4)
      expect(third?.byDevid).toBe('dev-b')
      expect(dav.stats().fullGets).toBe(s2.fullGets + 1)
    } finally {
      dav.close()
    }
  })
})

describe('控制台页 gzip（PERF-25）', () => {
  it('Accept-Encoding: gzip 发预压缩形态（独立 ETag、体量更小）；不带则原样；同形态 ETag 304', async () => {
    const h = mkHome()
    await saveConfig(emptyConfig())
    const rt = buildRuntime(emptyConfig(), 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    })
    try {
      const base = `http://127.0.0.1:${port}/_modeldock/ui`
      const gz = await rawGet(base, { 'accept-encoding': 'gzip' })
      expect(gz.status).toBe(200)
      expect(gz.headers['content-encoding']).toBe('gzip')
      const plain = await rawGet(base)
      expect(plain.status).toBe(200)
      expect(plain.headers['content-encoding']).toBeUndefined()
      // 解压后与原形态逐字节一致；压缩体确有收益
      expect(zlib.gunzipSync(gz.body).equals(plain.body)).toBe(true)
      expect(gz.body.length).toBeLessThan(plain.body.length)
      expect(gz.headers.etag).not.toBe(plain.headers.etag) // 形态不同 ETag 不同
      // 同形态条件请求命中 304
      const cond = await rawGet(base, { 'accept-encoding': 'gzip', 'if-none-match': String(gz.headers.etag) })
      expect(cond.status).toBe(304)
      expect(cond.headers.vary).toContain('Accept-Encoding')
      void h
    } finally {
      server.closeAllConnections?.()
      server.close()
    }
  })
})

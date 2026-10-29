import http from 'node:http'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { setupSyncTarget, enrollCloud } from '../src/sync/setup.js'
import { readSyncState, noteLocalSwitch, emptySyncState, updateSyncState, type SyncState } from '../src/sync/state.js'
import { targetFromState } from '../src/sync/runtime.js'
import { parseManifest } from '../src/sync/targets/types.js'
import { syncJsonPath } from '../src/util/paths.js'
import { atomicWrite } from '../src/util/fsx.js'

/**
 * 测试盲区补齐：src/sync/setup.ts 与 src/sync/state.ts、runtime.ts 错误分支
 * （2026-10-29 全量 coverage 实测圈出）。
 * setup：加入目标时最新包缺 KDF 参数（badKdf）、全新首推遇并发版本（writeManifest conflict）、
 * enrollCloud 配对失败三态（带 error.message / 非 JSON 响应 / 200 无 deviceToken）；
 * state：readSyncState 的 mode 非法 / 版本不支持 / v 缺失、noteLocalSwitch 三态；
 * runtime：targetFromState 无目标报错；targets/types：parseManifest 字段不完整。
 */

const TMP = fsSync.realpathSync.native(os.tmpdir())
const targetDirs: string[] = []
async function newTargetDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(TMP, 'modeldock-sync-target-'))
  targetDirs.push(d)
  return d
}
afterAll(async () => {
  for (const d of targetDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
})

function listen0(srv: http.Server): Promise<number> {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port)))
}

describe('setupSyncTarget 错误分支（缺口补齐）', () => {
  it('目标最新包缺 KDF 参数：报「缺少 KDF 参数」，不落 sync.json', async () => {
    const h = fakeHome()
    try {
      const dir = await newTargetDir()
      // 手摆目标：manifest 合法 + blob 是无 kdf 的残缺信封
      const root = path.join(dir, 'modeldock-sync')
      await fs.mkdir(path.join(root, 'blobs'), { recursive: true })
      await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ rev: 1, ts: '2026-10-29T00:00:00.000Z', byDevid: 'mdksync_ghost', blobRef: 'blobs/1-mdksync_ghost.msync' }, null, 2))
      await fs.writeFile(path.join(root, 'blobs', '1-mdksync_ghost.msync'), JSON.stringify({ fmt: 'modeldock-syncenv', v: 1, iv: 'x', ct: 'y' }))
      await expect(setupSyncTarget({ kind: 'localdir', dir }, 'pw', { backend: 'file' })).rejects.toThrow(/缺少 KDF 参数|missing KDF parameters/)
      expect(await readSyncState()).toBeNull() // 纯拉取失败：本机状态不落
    } finally {
      h.restore()
    }
  })

  it('全新首推遇并发版本（writeManifest 冲突）：报「其他机器同时在配置」，目标不被破坏', async () => {
    const h = fakeHome()
    try {
      // 假件：manifest 第一次 GET 返回 404（判定为全新目标），此后返回 rev5（并发者已推）
      const rival = JSON.stringify({ rev: 5, ts: '2026-10-29T00:00:00.000Z', byDevid: 'mdksync_rival', blobRef: 'blobs/5-mdksync_rival.msync' }, null, 2) + '\n'
      let manifestGets = 0
      let manifestPuts = 0
      const server = http.createServer((req, res) => {
        req.resume()
        req.on('end', () => {
          if (req.method === 'GET' && req.url?.endsWith('/manifest.json')) {
            manifestGets++
            if (manifestGets === 1) {
              res.writeHead(404)
              res.end('not found')
            } else {
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(rival)
            }
            return
          }
          if (req.method === 'PUT' && req.url?.endsWith('/manifest.json')) {
            manifestPuts++
            res.writeHead(201)
            res.end()
            return
          }
          if (req.method === 'PUT' || req.method === 'MKCOL') {
            res.writeHead(201)
            res.end()
            return
          }
          res.writeHead(405)
          res.end()
        })
      })
      const port = await listen0(server)
      await expect(setupSyncTarget({ kind: 'webdav', url: `http://127.0.0.1:${port}/dav`, dir: 'md' }, 'pw', { backend: 'file' })).rejects.toThrow(
        /其他机器同时在配置|Another machine pushed/
      )
      expect(manifestPuts).toBe(0) // CAS 拦下：manifest 未被本机首推覆盖
      await new Promise<void>((r) => server.close(() => r()))
    } finally {
      h.restore()
    }
  })
})

describe('enrollCloud 配对失败三态（缺口补齐）', () => {
  async function withPairFake(reply: { code: number; body: string }, fn: (url: string) => Promise<void>): Promise<void> {
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(reply.code, { 'content-type': 'application/json' })
        res.end(reply.body)
      })
    })
    const port = await listen0(server)
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  }

  it('403 + error.message：透出云端错误消息', async () => {
    const h = fakeHome()
    try {
      await withPairFake({ code: 403, body: JSON.stringify({ error: { message: 'bad pair code' } }) }, async (url) => {
        await expect(enrollCloud(url, 'CODE-CODE', 'pw', { backend: 'file' })).rejects.toThrow(/bad pair code/)
        await expect(enrollCloud(url, 'CODE-CODE', 'pw', { backend: 'file' })).rejects.toThrow(/HTTP 403/)
      })
    } finally {
      h.restore()
    }
  })

  it('500 纯文本（非 JSON 响应）：回退默认「配对失败」文案', async () => {
    const h = fakeHome()
    try {
      await withPairFake({ code: 500, body: 'internal oops' }, async (url) => {
        await expect(enrollCloud(url, 'CODE-CODE', 'pw', { backend: 'file' })).rejects.toThrow(/配对失败|Pairing failed/)
        await expect(enrollCloud(url, 'CODE-CODE', 'pw', { backend: 'file' })).rejects.toThrow(/HTTP 500/)
      })
    } finally {
      h.restore()
    }
  })

  it('200 但无 deviceToken：同样报配对失败', async () => {
    const h = fakeHome()
    try {
      await withPairFake({ code: 200, body: JSON.stringify({ ok: true }) }, async (url) => {
        await expect(enrollCloud(url, 'CODE-CODE', 'pw', { backend: 'file' })).rejects.toThrow(/配对失败|Pairing failed/)
      })
      expect(await readSyncState()).toBeNull()
    } finally {
      h.restore()
    }
  })
})

describe('readSyncState / noteLocalSwitch 缺口分支', () => {
  it('mode 非法：报「缺 mode 或 mode 非法」', async () => {
    const h = fakeHome()
    try {
      await atomicWrite(syncJsonPath(), JSON.stringify({ v: 1, mode: 'bogus' }), 0o600)
      await expect(readSyncState()).rejects.toThrow(/mode 非法|invalid mode/)
    } finally {
      h.restore()
    }
  })

  it('版本号不支持（v=2）：报「版本不受支持」；v 缺失：报错文案 v 为空串占位', async () => {
    const h = fakeHome()
    try {
      await atomicWrite(syncJsonPath(), JSON.stringify({ v: 2, mode: 'target', target: { kind: 'localdir', dir: 'x' } }), 0o600)
      await expect(readSyncState()).rejects.toThrow(/版本不受支持|Unsupported sync\.json version/)
      await atomicWrite(syncJsonPath(), JSON.stringify({ mode: 'target', target: { kind: 'localdir', dir: 'x' } }), 0o600)
      await expect(readSyncState()).rejects.toThrow(/v=/)
    } finally {
      h.restore()
    }
  })

  it('noteLocalSwitch：未启用（无 sync.json）与 mode=off 都静默跳过；target 态记录时间戳', async () => {
    const h = fakeHome()
    try {
      // 未启用：无 sync.json，静默返回且不落文件
      await noteLocalSwitch('2026-10-29T00:00:00.000Z')
      expect(await readSyncState()).toBeNull()

      // off：跳过
      await updateSyncState({ mode: 'off' })
      await noteLocalSwitch('2026-10-29T00:00:01.000Z')
      expect((await readSyncState())?.lastLocalSwitchTs).toBeNull()

      // target：记录（switchToService 的保护锚点）
      await updateSyncState({ mode: 'target', target: { kind: 'localdir', dir: path.join(h.home, 't') } })
      await noteLocalSwitch('2026-10-29T00:00:02.000Z')
      expect((await readSyncState())?.lastLocalSwitchTs).toBe('2026-10-29T00:00:02.000Z')
    } finally {
      h.restore()
    }
  })

  it('noteLocalSwitch：sync.json 损坏时静默跳过（读态失败按 null 处理，不抛不修）', async () => {
    const h = fakeHome()
    try {
      await atomicWrite(syncJsonPath(), '{ corrupt', 0o600)
      await expect(noteLocalSwitch('2026-10-29T00:00:03.000Z')).resolves.toBeUndefined()
    } finally {
      h.restore()
    }
  })
})

describe('runtime / manifest 解析缺口分支', () => {
  it('targetFromState：无目标（mode=off）报「未配置同步目标」', () => {
    expect(() => targetFromState({ ...emptySyncState(), mode: 'off' } as SyncState)).toThrow(/未配置同步目标|no sync target configured/)
  })

  it('parseManifest：字段不完整（缺 ts/byDevid/blobRef / rev 非整数）报可操作错误', () => {
    expect(() => parseManifest('{"rev":1}')).toThrow(/字段不完整|missing required fields/)
    expect(() => parseManifest('{"rev":1.5,"ts":"t","byDevid":"d","blobRef":"b"}')).toThrow(/字段不完整/)
    expect(() => parseManifest('{"rev":1,"ts":"","byDevid":"d","blobRef":"b"}')).toThrow(/字段不完整/)
  })
})

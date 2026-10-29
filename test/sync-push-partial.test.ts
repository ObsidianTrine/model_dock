/**
 * 测试盲区 1（docs/known-issues.md §六尾注）：engine 推送部分失败簿记。
 *
 * 引擎推送是两段写：writeBlob（信封 blob，只增不删）→ writeManifest（CAS 读-比-写）。
 * 「部分条目写失败」= 其中一段成功、另一段失败。三个目标各一例：
 *  - webdav：真·两段部分失败（blob PUT 201 落目标、manifest PUT 500）；
 *  - cloud：PUT /v1/doc 单段原子写失败（500），云端不得出现半写文档；
 *  - localdir：两段写在同一目录走 atomicWrite，第二段（manifest）失败无法跨平台确定性注入
 *    （manifest.json 变目录会在 tick 开头 readManifest 处先炸、chmod 在 POSIX 上拦不住 rename），
 *    故注入第一段失败（blobs/<rev>-<devid>.msync 为目录 → rename 三平台皆抛）——簿记断言与
 *    第二段失败完全同型（engine 对 writeBlob/writeManifest 的 throw 一视同仁）。
 *
 * 每例统一断言（安全网建立在 synctarget 的 REVIEW-06/28 回归之上）：
 *  1. sync.json 错误簿记正确：safeSyncTick 吞错返回 'skipped'，lastError/lastErrorTs 落账；
 *  2. 已成功条目不回退：目标上已写成功的部分保留；sync.json 不误推进（lastAppliedRev /
 *     lastSyncedHash / lastPushTs 冻结——否则下轮 tick 误判「已同步」静默丢改动）；
 *  3. 下一轮 tick 收敛：故障消除后 'pushed'，lastError 销账，rev/指纹前进。
 *
 * 红线遵守：零 vi.mock（singleFork 跨文件雷区）；全真实模块直调；HTTP 假件 listen(0) 随机端口；
 * 临时目录 os.tmpdir()+path.join；不碰 8687/8890。
 */
import http from 'node:http'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { loadConfig, mutateConfig, saveConfig } from '../src/config/store.js'
import { setSecret, makeKeyRef } from '../src/config/secrets.js'
import { enrollCloud, setupSyncTarget } from '../src/sync/setup.js'
import { safeSyncTick } from '../src/sync/engine.js'
import { readSyncState } from '../src/sync/state.js'
import { createLocaldirTarget } from '../src/sync/targets/localdir.js'
import type { Config } from '../config/types.js'

const targetDirs: string[] = []
afterAll(async () => {
  for (const d of targetDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
})

async function seedBase(): Promise<void> {
  await setSecret('ark', 'sk-ark-plaintext', 'file')
  await saveConfig({
    version: 1,
    language: 'zh',
    active_profile: 'main',
    security: { store: 'file' },
    providers: {
      ark: { base_url: 'https://ark.example.com/api', protocol: 'anthropic', auth_style: 'bearer', key_ref: makeKeyRef('file', 'ark') },
    },
    profiles: { main: { provider: 'ark', default_model: 'auto' } },
    harness: { 'claude-code': { mode: 'gateway', attached_at: '2026-01-01T00:00:00.000Z', files: ['/x'] } },
    gateway: { port: 12345 },
  } as Config)
}

/** 本地可同步态改动（不新增服务，免去补密钥）：default_model 是 syncdoc 的一部分 */
async function localEdit(marker: string): Promise<void> {
  await mutateConfig((c) => {
    c.profiles!.main!.default_model = marker
  })
  expect(await loadConfig()).toBeTruthy()
}

async function listen0(srv: http.Server): Promise<number> {
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
  return (srv.address() as net.AddressInfo).port
}

interface WebdavFake {
  port: number
  store: Map<string, string>
  manifestFail: boolean
  close: () => Promise<void>
}

/** 内存 WebDAV 假件：可对 manifest.json 的 PUT 注入 500（blob PUT 不受影响）——真·两段部分失败 */
async function startWebdavFake(): Promise<WebdavFake> {
  const state: WebdavFake = {
    port: 0,
    store: new Map<string, string>(),
    manifestFail: false,
    close: async () => {},
  }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const p = req.url ?? '/'
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.method === 'PUT') {
        if (state.manifestFail && p.endsWith('/manifest.json')) {
          res.statusCode = 500
          res.end('boom-manifest')
          return
        }
        state.store.set(p, body)
        res.statusCode = 201
        res.end()
        return
      }
      if (req.method === 'MKCOL') {
        state.store.set(p, '')
        res.statusCode = 201
        res.end()
        return
      }
      if (req.method === 'GET') {
        const v = state.store.get(p)
        if (v === undefined) {
          res.statusCode = 404
          res.end('not found')
          return
        }
        res.statusCode = 200
        res.end(v)
        return
      }
      res.statusCode = 405
      res.end()
    })
  })
  state.port = await listen0(server)
  state.close = () => new Promise((r) => server.close(() => r()))
  return state
}

interface CloudFake {
  port: number
  url: string
  putFail: boolean
  doc: { rev: number; envelope: string; ts: string; byDevid: string } | null
  close: () => Promise<void>
}

/** 云端假件：最小 /v1 协议（pair 免鉴权、heartbeat 恒无 desired、doc 单行 CAS + 可注入 PUT 500） */
async function startCloudFake(devid: string): Promise<CloudFake> {
  const state: CloudFake = { port: 0, url: '', putFail: false, doc: null, close: async () => {} }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.method === 'POST' && req.url === '/v1/pair') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ deviceToken: 'mdkdev_' + 'ab'.repeat(24) }))
        return
      }
      if (req.method === 'POST' && req.url === '/v1/heartbeat') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ desiredProfile: null, desiredTs: null }))
        return
      }
      if (req.method === 'GET' && req.url === '/v1/doc') {
        if (!state.doc) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'no_doc', message: 'no doc' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(state.doc))
        return
      }
      if (req.method === 'PUT' && req.url === '/v1/doc') {
        if (state.putFail) {
          res.writeHead(500)
          res.end('boom-put')
          return
        }
        const b = JSON.parse(body) as { envelope?: string; ts?: string }
        const base = Number((req.headers['if-match'] ?? NaN))
        if (!Number.isInteger(base) || base < 0 || !b.envelope || !b.ts || !Number.isFinite(Date.parse(b.ts))) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'invalid', message: 'invalid' } }))
          return
        }
        if (state.doc && state.doc.rev !== base) {
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'conflict', message: 'rev mismatch' } }))
          return
        }
        if (state.doc && Date.parse(b.ts) < Date.parse(state.doc.ts)) {
          res.writeHead(422, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'rollback_rejected', message: 'rollback' } }))
          return
        }
        state.doc = { rev: (state.doc?.rev ?? 0) + 1, envelope: b.envelope, ts: b.ts, byDevid: devid }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ rev: state.doc.rev }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  state.port = await listen0(server)
  state.url = `http://127.0.0.1:${state.port}`
  state.close = () => new Promise((r) => server.close(() => r()))
  return state
}

describe('engine 推送部分失败簿记（测试盲区 1）', () => {
  it('webdav：blob 写成功 + manifest PUT 500 → 错误落账、blob 保留、簿记冻结；修复后一轮收敛', async () => {
    const h = fakeHome()
    const fake = await startWebdavFake()
    try {
      await seedBase()
      await setupSyncTarget(
        { kind: 'webdav', url: `http://127.0.0.1:${fake.port}/dav`, dir: 'sync', username: 'u', password: 'p' },
        'pw-partial-webdav',
        { backend: 'file' }
      )
      const st0 = await readSyncState()
      expect(st0?.mode).toBe('target')
      expect(st0?.lastAppliedRev).toBe(1)
      const devid = st0!.devid
      const frozen = { hash: st0!.lastSyncedHash, pushTs: st0!.lastPushTs }

      // 注入：blob PUT 照常 201，manifest PUT 一律 500 → 真·两段部分失败
      fake.manifestFail = true
      await localEdit('v2-manifest-fail')
      expect(await safeSyncTick()).toBe('skipped')

      const st1 = await readSyncState()
      // 1) sync.json 错误簿记正确
      expect(st1?.lastError).toContain('500')
      expect(st1?.lastErrorTs).toBeTruthy()
      // 2) 已成功条目不回退：rev2 blob 已落在目标上（不回滚），manifest 仍 rev1
      expect(fake.store.get(`/dav/sync/modeldock-sync/blobs/2-${devid}.msync`)).toBeTruthy()
      const manifestOnTarget = JSON.parse(fake.store.get('/dav/sync/modeldock-sync/manifest.json')!) as { rev: number; byDevid: string }
      expect(manifestOnTarget.rev).toBe(1)
      expect(manifestOnTarget.byDevid).toBe(devid)
      //    簿记不得误推进（否则下轮误判「已同步」，本地改动静默丢失）
      expect(st1?.lastSyncedHash).toBe(frozen.hash)
      expect(st1?.lastAppliedRev).toBe(1)
      expect(st1?.lastPushTs).toBe(frozen.pushTs)

      // 3) 下一轮 tick 收敛：故障消除 → pushed，错误销账，rev/指纹前进
      fake.manifestFail = false
      expect(await safeSyncTick()).toBe('pushed')
      const st2 = await readSyncState()
      expect(st2?.lastError).toBeNull()
      expect(st2?.lastAppliedRev).toBe(2)
      expect(st2?.lastSyncedHash).not.toBe(frozen.hash)
      expect(st2?.lastPushTs).not.toBe(frozen.pushTs)
      expect((JSON.parse(fake.store.get('/dav/sync/modeldock-sync/manifest.json')!) as { rev: number }).rev).toBe(2)
      // rev2 blob 仍在（重推同 rev-devid 覆盖同名 blob，不追加不残留）
      expect(fake.store.get(`/dav/sync/modeldock-sync/blobs/2-${devid}.msync`)).toBeTruthy()
    } finally {
      await fake.close()
      h.restore()
    }
  }, 60_000)

  it('localdir：rev2 blob 落点为目录（第一段写失败）→ 错误落账、目标无半成品、簿记冻结；修复后一轮收敛', async () => {
    const h = fakeHome()
    try {
      await seedBase()
      // 同步目标目录放在 fakeHome 内，随 restore 一并清理
      const dir = path.join(h.home, 'sync-target')
      await setupSyncTarget({ kind: 'localdir', dir }, 'pw-partial-local', { backend: 'file' })
      const st0 = await readSyncState()
      expect(st0?.lastAppliedRev).toBe(1)
      const devid = st0!.devid
      const frozen = { hash: st0!.lastSyncedHash, pushTs: st0!.lastPushTs }
      const root = path.join(dir, 'modeldock-sync')

      // 注入：rev2 blob 的 rename 落点变成目录（file→dir rename 三平台皆抛，writeManifest 不再执行）
      await fs.mkdir(path.join(root, 'blobs', `2-${devid}.msync`))
      targetDirs.push(path.join(root, 'blobs', `2-${devid}.msync`)) // 兜底清理（正常路径下先 rmdir）
      await localEdit('v2-blob-fail')
      expect(await safeSyncTick()).toBe('skipped')

      const st1 = await readSyncState()
      // 1) sync.json 错误簿记正确（EISDIR/EPERM 原文入账——localdir 无 HTTP 状态码可断言）
      expect(st1?.lastError).toBeTruthy()
      expect(st1?.lastErrorTs).toBeTruthy()
      // 2) 已成功条目不回退：第一段失败 → 目标不得有任何半成品推进
      expect((await createLocaldirTarget(dir).readManifest())?.rev).toBe(1)
      expect((await createLocaldirTarget(dir).readManifest())?.byDevid).toBe(devid)
      //    rev1 blob（setup 所写）原样保留；rev2 落点仍是目录
      expect(await fs.stat(path.join(root, 'blobs', `1-${devid}.msync`))).toBeTruthy()
      expect((await fs.stat(path.join(root, 'blobs', `2-${devid}.msync`))).isDirectory()).toBe(true)
      //    簿记冻结
      expect(st1?.lastSyncedHash).toBe(frozen.hash)
      expect(st1?.lastAppliedRev).toBe(1)
      expect(st1?.lastPushTs).toBe(frozen.pushTs)

      // 3) 下一轮 tick 收敛
      await fs.rmdir(path.join(root, 'blobs', `2-${devid}.msync`))
      expect(await safeSyncTick()).toBe('pushed')
      const st2 = await readSyncState()
      expect(st2?.lastError).toBeNull()
      expect(st2?.lastAppliedRev).toBe(2)
      expect((await createLocaldirTarget(dir).readManifest())?.rev).toBe(2)
      const blob2 = await fs.stat(path.join(root, 'blobs', `2-${devid}.msync`))
      expect(blob2.isFile()).toBe(true)
    } finally {
      h.restore()
    }
  }, 60_000)

  it('cloud：PUT /v1/doc 500 → 错误落账、云端无半写文档、簿记冻结；恢复后一轮收敛到 rev2', async () => {
    const h = fakeHome()
    const fake = await startCloudFake('mdksync_cloud_dev')
    try {
      await seedBase()
      const enrolled = await enrollCloud(fake.url, 'PAIR-CODE-1', 'pw-partial-cloud', {
        devid: 'mdksync_cloud_dev',
        deviceName: 'partial-test',
        backend: 'file',
      })
      expect(enrolled.joined).toBe(false)
      expect(enrolled.rev).toBe(1)
      const st0 = await readSyncState()
      expect(st0?.mode).toBe('cloud')
      expect(st0?.lastAppliedRev).toBe(1)
      expect(fake.doc?.rev).toBe(1)
      const frozen = { hash: st0!.lastSyncedHash, pushTs: st0!.lastPushTs, envelope: fake.doc!.envelope }

      // 注入：PUT /v1/doc 一律 500（cloud 目标两段在客户端合为一次原子 PUT——「第一段成功」
      // 只是内存暂存，服务端不会出现半写文档；失败后暂存信封即弃，下轮重暂存）
      fake.putFail = true
      await localEdit('v2-cloud-fail')
      expect(await safeSyncTick()).toBe('skipped')

      const st1 = await readSyncState()
      // 1) sync.json 错误簿记正确
      expect(st1?.lastError).toContain('500')
      expect(st1?.lastErrorTs).toBeTruthy()
      // 2) 已成功条目不回退/云端完整性：文档未被部分写入，仍 rev1 + 原信封
      expect(fake.doc?.rev).toBe(1)
      expect(fake.doc?.envelope).toBe(frozen.envelope)
      //    簿记冻结
      expect(st1?.lastSyncedHash).toBe(frozen.hash)
      expect(st1?.lastAppliedRev).toBe(1)
      expect(st1?.lastPushTs).toBe(frozen.pushTs)

      // 3) 下一轮 tick 收敛（心跳 + 推送同 tick 完成）
      fake.putFail = false
      expect(await safeSyncTick()).toBe('pushed')
      const st2 = await readSyncState()
      expect(st2?.lastError).toBeNull()
      expect(st2?.lastAppliedRev).toBe(2)
      expect(st2?.lastSyncedHash).not.toBe(frozen.hash)
      expect(fake.doc?.rev).toBe(2)
      expect(fake.doc?.envelope).not.toBe(frozen.envelope)
      expect(fake.doc?.byDevid).toBe('mdksync_cloud_dev')
    } finally {
      await fake.close()
      h.restore()
    }
  }, 60_000)
})

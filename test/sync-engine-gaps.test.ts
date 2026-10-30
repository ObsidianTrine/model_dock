import http from 'node:http'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { TEST_TMP, newHome, restoreHomes, waitFor } from './helpers.js'
import { loadConfig, mutateConfig, saveConfig } from '../src/config/store.js'
import { setSecret, makeKeyRef } from '../src/config/secrets.js'
import { setupSyncTarget } from '../src/sync/setup.js'
import { DEFAULT_DEBOUNCE_MS, safeSyncTick, syncTickOnce, SyncLoop, syncStatus, remountSyncEngine, stopSyncEngine } from '../src/sync/engine.js'
import { readSyncState, updateSyncState, emptySyncState, type SyncState } from '../src/sync/state.js'
import { createLocaldirTarget } from '../src/sync/targets/localdir.js'
import { keysToCache } from '../src/sync/runtime.js'
import { deriveSyncKeys } from '../src/sync/crypto.js'
import { syncJsonPath, displayPath } from '../src/util/paths.js'
import { atomicWrite } from '../src/util/fsx.js'
import type { Config } from '../src/config/types.js'

/**
 * 测试盲区补齐：src/sync/engine.ts 分支缺口（2026-10-29 全量 coverage 实测圈出）。
 * 覆盖面：syncModeReady 对 mode=off+key 残留不放行、目标 manifest 丢失后从 rev0 重推、
 * 推送 writeManifest CAS 冲突（WebDAV 假件并发写）、cloudHeartbeat 的 currentProvider 缺失/
 * 悬空与非 200/空 body/无 applySwitch 分支、SyncLoop.tick() raw 路径与 stop 后 skipped、
 * 默认防抖（不传 debounceMs）、remountSyncEngine 挂载/幂等/摘除/坏 sync.json/云模式轮询参数、
 * syncStatus 的 cloud 与 webdav（带/不带 dir）与 localdir 视图。
 * 引擎模块内单例 loop 在文件收尾必须摘除（paused 重挂 + stopSyncEngine），防止长尾 tick 写盘串场。
 */

// 与 synctarget.test.ts 同口径：多 home 交错切换走 helpers 三件套（收尾恢复进程级原值）
const targetDirs: string[] = []
async function newTargetDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(TEST_TMP, 'modeldock-sync-target-'))
  targetDirs.push(d)
  return d
}
afterAll(async () => {
  // 引擎单例必须已摘除：paused 重挂在下方用例收尾完成，这里再兜一次
  stopSyncEngine()
  await restoreHomes()
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
    gateway: { port: 12345 },
  } as Config)
}

async function localEdit(marker: string): Promise<void> {
  await mutateConfig((c) => {
    c.profiles!.main!.default_model = marker
  })
}

function listen0(srv: http.Server): Promise<number> {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port)))
}

/** 心跳 + 云文档两用假件：hb 可编程，doc 端点是最小云协议（404→200 GET / 200 PUT 计 rev） */
function startFakeCloud(): Promise<{ port: number; hb: { code: number; body: string }; docReqs: () => number; close: () => Promise<void> }> {
  let stored = { rev: 0, envelope: '' }
  let docReqs = 0
  const hb: { code: number; body: string } = { code: 200, body: '{}' }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'POST' && req.url?.includes('/v1/heartbeat')) {
        res.writeHead(hb.code, { 'content-type': 'application/json' })
        res.end(hb.body)
        return
      }
      docReqs++
      if (req.method === 'GET' && req.url?.includes('/v1/doc')) {
        if (stored.rev === 0) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ rev: stored.rev, envelope: stored.envelope, ts: '2026-10-29T00:00:00.000Z', byDevid: 'mdksync_other' }))
        return
      }
      if (req.method === 'PUT' && req.url?.includes('/v1/doc')) {
        const body = Buffer.concat(chunks).toString('utf8')
        stored = { rev: stored.rev + 1, envelope: (JSON.parse(body) as { envelope: string }).envelope }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ rev: stored.rev }))
        return
      }
      res.writeHead(405)
      res.end()
    })
  })
  return listen0(server).then((port) => ({
    port,
    hb,
    docReqs: () => docReqs,
    close: () => new Promise((r) => server.close(() => r())),
  }))
}

describe('syncTickOnce 缺口分支', () => {
  it('mode=off 但 key 残留：syncModeReady 不放行 → skipped', async () => {
    newHome()
    await seedBase()
    const keys = deriveSyncKeys('pw', randomBytes(16), randomBytes(32))
    await updateSyncState({ mode: 'off', key: keysToCache(keys) })
    expect(await syncTickOnce()).toBe('skipped')
    expect(await safeSyncTick()).toBe('skipped')
  })

  it('目标 manifest 丢失（同步盘被清）：baseRev 回退 0 重新以 rev1 首推', async () => {
    newHome()
    await seedBase()
    const dir = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pw-repush', { backend: 'file' })
    // 目标上的 manifest 丢失（blobs 保留），本地也有新改动
    await fs.rm(path.join(dir, 'modeldock-sync', 'manifest.json'), { force: true })
    await localEdit('manifest-lost')
    expect(await syncTickOnce()).toBe('pushed')
    const st = await readSyncState()
    expect(st?.lastAppliedRev).toBe(1) // baseRev ?? 0 → rev 从 1 重新计
    const m = await createLocaldirTarget(dir).readManifest()
    expect(m?.rev).toBe(1)
  })

  it('推送时 writeManifest CAS 冲突（WebDAV 假件模拟并发写）：返回 conflict、错误记账、目标不被本机覆盖', async () => {
    // 假件：manifest.json 第一次 GET 返回 rev1（engine 的 readManifest），此后返回 rev3（并发者已推进）
    const manifestV1 = JSON.stringify({ rev: 1, ts: '2026-10-29T00:00:00.000Z', byDevid: 'mdksync_rival', blobRef: 'blobs/1-mdksync_rival.msync' }, null, 2) + '\n'
    const manifestV3 = JSON.stringify({ rev: 3, ts: '2026-10-29T00:00:03.000Z', byDevid: 'mdksync_rival', blobRef: 'blobs/3-mdksync_rival.msync' }, null, 2) + '\n'
    let manifestGets = 0
    let blobPuts = 0
    let manifestPuts = 0
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        if (req.method === 'GET' && req.url?.endsWith('/manifest.json')) {
          manifestGets++
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(manifestGets === 1 ? manifestV1 : manifestV3)
          return
        }
        if (req.method === 'PUT' && req.url?.includes('/manifest.json')) {
          manifestPuts++
          res.writeHead(201)
          res.end()
          return
        }
        if (req.method === 'PUT') {
          blobPuts++
          res.writeHead(201)
          res.end()
          return
        }
        res.writeHead(405)
        res.end()
      })
    })
    const port = await listen0(server)
    newHome()
    await seedBase()
    const keys = deriveSyncKeys('pw-cas', randomBytes(16), randomBytes(32))
    await updateSyncState({
      ...emptySyncState(),
      mode: 'target',
      target: { kind: 'webdav', url: `http://127.0.0.1:${port}/dav`, dir: 'md' },
      key: keysToCache(keys),
      devid: 'mdksync_me',
      lastAppliedRev: 1,
      lastSyncedHash: 'stale-hash', // 强制走推送分支
    } as Partial<SyncState>)
    expect(await safeSyncTick()).toBe('conflict')
    // 簿记：lastAppliedRev / lastSyncedHash 冻结，lastError 记账（他人抢先推）
    const st = await readSyncState()
    expect(st?.lastAppliedRev).toBe(1)
    expect(st?.lastSyncedHash).toBe('stale-hash')
    expect(st?.lastError).toBeTruthy()
    // blob 已写（两段写的第一段成功），manifest 未被本机覆盖（CAS 拦下）
    expect(blobPuts).toBe(1)
    expect(manifestPuts).toBe(0)
    await new Promise<void>((r) => server.close(() => r()))
  })
})

describe('cloudHeartbeat 缺口分支（真 HTTP 假件，随机端口）', () => {
  it('active_profile 缺失 / 悬空（profile 已删）：currentProvider 按 null 处理，desired 照常应用', async () => {
    const fake = await startFakeCloud()
    try {
      newHome()
      await saveConfig({ version: 1, providers: {}, profiles: {}, harness: {} }) // 无 active_profile
      const keys = deriveSyncKeys('pw-hb', randomBytes(16), randomBytes(32))
      await updateSyncState({
        ...emptySyncState(),
        mode: 'cloud',
        cloud: { url: `http://127.0.0.1:${fake.port}`, devid: 'mdksync_hb', token: 'tok', deviceName: 'x' },
        key: keysToCache(keys),
      } as Partial<SyncState>)
      const applied: string[] = []
      const applySwitch = async (svc: string): Promise<void> => { applied.push(svc) }

      fake.hb.body = JSON.stringify({ desiredProfile: 'svc-x', desiredTs: new Date().toISOString() })
      await safeSyncTick({ applySwitch })
      expect(applied).toEqual(['svc-x'])

      // 悬空：active_profile 指向已不存在的 profile → provider 解析为 null，不阻断切换
      await saveConfig({ version: 1, active_profile: 'ghost', providers: {}, profiles: {}, harness: {} })
      fake.hb.body = JSON.stringify({ desiredProfile: 'svc-y', desiredTs: new Date().toISOString() })
      await safeSyncTick({ applySwitch })
      expect(applied).toEqual(['svc-x', 'svc-y'])
    } finally {
      await fake.close()
    }
  })

  it('心跳 HTTP 非 200：报错记账；空 body：无 desired 不切；无 applySwitch：只上报不切不崩', async () => {
    const fake = await startFakeCloud()
    try {
      newHome()
      await saveConfig({ version: 1, active_profile: 'main', providers: {}, profiles: { main: { provider: 'p' } }, harness: {} })
      const keys = deriveSyncKeys('pw-hb2', randomBytes(16), randomBytes(32))
      await updateSyncState({
        ...emptySyncState(),
        mode: 'cloud',
        cloud: { url: `http://127.0.0.1:${fake.port}`, devid: 'mdksync_hb2', token: 'tok', deviceName: 'x' },
        key: keysToCache(keys),
      } as Partial<SyncState>)
      const applied: string[] = []
      const applySwitch = async (svc: string): Promise<void> => { applied.push(svc) }

      // 非 200：cloudHeartbeat 抛错 → safeSyncTick 记账
      fake.hb.code = 403
      fake.hb.body = 'denied'
      expect(await safeSyncTick({ applySwitch })).toBe('skipped')
      expect((await readSyncState())?.lastError).toContain('403')

      // 空 body（text 为空串 → JSON.parse('{}')）：desired 缺失，本 tick 继续文档推送
      fake.hb.code = 200
      fake.hb.body = ''
      expect(await safeSyncTick({ applySwitch })).toBe('pushed')
      expect(applied).toEqual([])

      // 无 applySwitch（CLI 手动 tick）：desired 存在也只上报，不切、不崩
      fake.hb.body = JSON.stringify({ desiredProfile: 'svc-z', desiredTs: new Date().toISOString() })
      expect(await syncTickOnce()).toBe('idle')
      expect(applied).toEqual([])
    } finally {
      await fake.close()
    }
  })
})

describe('SyncLoop 缺口分支', () => {
  it('tick()（raw 单飞路径）返回真实结果；stop() 后再 tick 返回 skipped', async () => {
    newHome()
    await seedBase()
    const dir = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pw-raw', { backend: 'file' })
    const loop = new SyncLoop({ pollMs: 60_000, jitterRatio: 0 })
    expect(await loop.tick()).toBe('idle') // 刚 setup 完，无本地改动
    await loop.stop()
    expect(await loop.tick()).toBe('skipped') // stopped → 一切跳过
  })

  it('单飞重入：在飞期间再 tick 合并到同一底层 tick（只推一次），收尾补跑一轮 safe tick 不回环', async () => {
    newHome()
    await seedBase()
    const dir = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pw-single', { backend: 'file' })
    await localEdit('single-flight-pending') // 留一个待推改动，让 tick 有实事做
    const loop = new SyncLoop({ pollMs: 60_000, jitterRatio: 0, watchFn: () => neverWatcher() })
    // tick() 是 async 壳：外层 promise 不同，但底层 beginTick 单飞——两个触发源共享同一次执行
    const [o1, o2] = await Promise.all([loop.tick(), loop.tick()])
    expect(o1).toBe('pushed')
    expect(o2).toBe('pushed')
    // 单飞 + trailing 补跑收敛：目标 rev 停在 2，不会因两次触发推两个版本
    await new Promise((r) => setTimeout(r, 150))
    expect(await createLocaldirTarget(dir).readManifest()).toMatchObject({ rev: 2 })
    await loop.stop()
  })

  it('轮询定时器（1s 下限钳制）到点自动 tick：本地待推改动被轮询推出', async () => {
    newHome()
    await seedBase()
    const dir = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pw-poll', { backend: 'file' })
    // stub watcher：屏蔽即时推路径，推送只能来自轮询定时器
    const loop = new SyncLoop({ pollMs: 1000, jitterRatio: 0, watchFn: () => neverWatcher() })
    loop.start()
    try {
      await new Promise((r) => setTimeout(r, 150)) // 让 start 的即时 tick 先空转完
      await localEdit('poll-timer-push')
      await waitFor(async () => (await createLocaldirTarget(dir).readManifest())?.rev === 2, 5000)
    } finally {
      await loop.stop()
    }
  }, 15_000)

  it('不传 debounceMs：文件变更走默认防抖（DEFAULT_DEBOUNCE_MS=3s）即时推送', async () => {
    newHome()
    await seedBase()
    const dir = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pw-debounce', { backend: 'file' })
    const target = createLocaldirTarget(dir)
    expect(DEFAULT_DEBOUNCE_MS).toBe(3000)
    const loop = new SyncLoop({ pollMs: 60_000, jitterRatio: 0 }) // 轮询 60s 内不会触发，推送只能来自防抖
    loop.start()
    try {
      await localEdit('debounced-push')
      await waitFor(async () => (await target.readManifest())?.rev === 2, 15000)
      expect((await loadConfig()).profiles?.main?.default_model).toBe('debounced-push')
    } finally {
      await loop.stop()
    }
  }, 30_000)
})

/** 永不触发事件的 stub watcher（带 close noop，stop() 可正常关闭）：屏蔽 fs.watch 即时推路径，隔离出轮询/手动触发 */
function neverWatcher(): fsSync.FSWatcher {
  const w = new EventEmitter() as unknown as fsSync.FSWatcher
  ;(w as unknown as { close: () => void }).close = () => {}
  return w
}

describe('remountSyncEngine / stopSyncEngine / syncStatus 缺口分支', () => {
  it('remount：挂载 → 幂等重挂 → 暂停摘除（记日志）→ 坏 sync.json 不抛 → 云模式轮询参数分支；syncStatus 四种视图', async () => {
    // —— 无 sync.json：remount 无操作 ——
    newHome()
    await seedBase()
    stopSyncEngine()
    await remountSyncEngine()
    expect((await syncStatus()).running).toBe(false)

    // —— target 模式挂载 → running；同签名重挂幂等早退 ——
    const dir = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pw-remount', { backend: 'file' })
    await remountSyncEngine()
    expect((await syncStatus()).running).toBe(true)
    await remountSyncEngine()
    expect((await syncStatus()).running).toBe(true)

    // —— 缺 key 的 target 态：签名判 null → 摘除；此时 loop 仍挂着，必须记「已停用/暂停」日志 ——
    const logs: string[] = []
    await updateSyncState({ key: undefined } as Partial<SyncState>)
    await remountSyncEngine({ log: (l) => logs.push(l) })
    expect((await syncStatus()).running).toBe(false)
    expect(logs.length).toBeGreaterThan(0)

    // —— 暂停态（loop 已摘）：remount 静默无操作 ——
    await updateSyncState({ paused: true, key: undefined } as Partial<SyncState>)
    await remountSyncEngine()

    // —— 坏 sync.json：读态抛错 → 摘除并返回，不向上抛 ——
    await atomicWrite(syncJsonPath(), '{ nope', 0o600)
    await remountSyncEngine()
    expect((await syncStatus()).running).toBe(false)

    // —— syncStatus 视图：webdav 带 dir / 不带 dir ——
    await fs.rm(syncJsonPath(), { force: true })
    const keys = keysToCache(deriveSyncKeys('pw-view', randomBytes(16), randomBytes(32)))
    await updateSyncState({ mode: 'target', target: { kind: 'webdav', url: 'https://dav.example.com/dav', dir: 'sub' }, key: keys } as Partial<SyncState>)
    let view = await syncStatus()
    expect(view.mode).toBe('target')
    expect(view.targetKind).toBe('webdav')
    expect(view.targetLabel).toBe('https://dav.example.com/dav/sub')
    await updateSyncState({ target: { kind: 'webdav', url: 'https://dav.example.com/dav' }, key: undefined } as Partial<SyncState>)
    view = await syncStatus()
    expect(view.targetLabel).toBe('https://dav.example.com/dav')

    // —— localdir 视图：label = displayPath(目录)（home 内路径会缩写 ~，本机 tmpdir 常在 home 下） ——
    await updateSyncState({ mode: 'target', target: { kind: 'localdir', dir }, key: undefined } as Partial<SyncState>)
    view = await syncStatus()
    expect(view.targetKind).toBe('localdir')
    expect(view.targetLabel).toBe(displayPath(dir))

    // —— cloud 视图（targetKind/label 走 cloud 分支） ——
    await updateSyncState({
      mode: 'cloud',
      cloud: { url: 'https://cloud.example.com', devid: 'mdksync_v', token: 'tok', deviceName: 'x' },
      key: keys,
    } as Partial<SyncState>)
    view = await syncStatus()
    expect(view.mode).toBe('cloud')
    expect(view.targetKind).toBe('cloud')
    expect(view.targetLabel).toBe('https://cloud.example.com')
    expect(view.lastAppliedRev).toBe(0)

    // —— cloud 模式但 cloud 凭据缺失（key 已缓存）：签名在 cloud 分支判 null → 不挂载，视图按 off ——
    await fs.rm(syncJsonPath(), { force: true })
    await updateSyncState({ mode: 'cloud', key: keys } as Partial<SyncState>)
    await remountSyncEngine()
    view = await syncStatus()
    expect(view.mode).toBe('off')
    expect(view.running).toBe(false)

    // —— 云模式 remount：走 cloud 轮询参数分支（60s±20%）；云端不可达只记账 ——
    await fs.rm(syncJsonPath(), { force: true })
    await updateSyncState({
      ...emptySyncState(),
      mode: 'cloud',
      cloud: { url: 'http://127.0.0.1:1', devid: 'mdksync_c', token: 'tok', deviceName: 'x' },
      key: keys,
    } as Partial<SyncState>)
    await remountSyncEngine()
    expect((await syncStatus()).running).toBe(true)
    // 收尾：paused 重挂摘除单例，杜绝长尾 tick 串场
    await updateSyncState({ paused: true })
    await remountSyncEngine()
    stopSyncEngine()
    expect((await syncStatus()).running).toBe(false)
  }, 30_000)
})

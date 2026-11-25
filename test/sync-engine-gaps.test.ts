import http from 'node:http'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { TEST_TMP, newHome, gotoHome, restoreHomes, waitFor } from './helpers.js'
import { loadConfig, mutateConfig, saveConfig } from '../src/config/store.js'
import { setSecret, makeKeyRef } from '../src/config/secrets.js'
import { setupSyncTarget } from '../src/sync/setup.js'
import { DEFAULT_DEBOUNCE_MS, safeSyncTick, syncTickOnce, SyncLoop, syncStatus, remountSyncEngine, stopSyncEngine, __testActiveSyncSig, __testTickActiveSyncLoop } from '../src/sync/engine.js'
import { readSyncState, updateSyncState, emptySyncState, type SyncState } from '../src/sync/state.js'
import { createLocaldirTarget } from '../src/sync/targets/localdir.js'
import { keysToCache } from '../src/sync/runtime.js'
import { deriveSyncKeys } from '../src/sync/crypto.js'
import { refreshDebugOn, setDebugFlag } from '../src/gateway/state/debuglog.js'
import { syncJsonPath, displayPath, logsDir } from '../src/util/paths.js'
import { atomicWrite, drainAppendStreams } from '../src/util/fsx.js'
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
  // 引擎单例必须已摘除：paused 重挂在下方用例收尾完成，这里再兜一次。
  // 必须先 await 停净再 restoreHomes——在飞 tick 的后续写盘按「当时的」home 解析路径
  // （2026-10-05 / 2026-10-30 两次写穿事故根因）
  await stopSyncEngine()
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
  } as unknown as Config)
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
    // 受控事件投递替代真实 fs.watch：慢 CI/杀软机器上事件投递延迟可达秒级（本用例 Windows CI
    // 偶发红的根因——真实事件 15s 内未到），事件到达时机由测试显式控制，防抖窗口语义改用
    // fake 时钟钉死（只 fake setTimeout/clearTimeout，真实 fs promise IO 与 Date 轮询不受影响）
    let deliver: ((event: fsSync.WatchEventType, filename: string | null) => void) | undefined
    const loop = new SyncLoop({
      pollMs: 60_000, // 轮询 60s 内不会触发：推送只能来自防抖（stub watcher 屏蔽即时推路径之外的真实事件）
      jitterRatio: 0,
      watchFn: (_p, listener) => {
        deliver = (event, filename) => listener(event, filename)
        return neverWatcher()
      },
    })
    loop.start()
    try {
      await waitFor(async () => (await target.readManifest())?.rev === 1, 15000)
      // 确定性栅栏替代时间缓冲：初始拉取 tick 的 manifest 落盘与 finally 清 inflight 之间无固定
      // 上界，50ms 启发式在慢 CI 会被穿透——事件①落在在飞窗口即被 trailing 补跑吸收（绕过防抖
      // 立即推），「窗口内不推」负断言假红；改为显式等 inflight 清空（tickSettled 只读观测面）
      await waitFor(() => loop.tickSettled, 15000)
      await localEdit('debounced-push')

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        deliver!('change', 'config.toml') // 事件① @ t=0
        vi.advanceTimersByTime(2000)
        expect((await target.readManifest())?.rev).toBe(1) // 静默 2s 不推：防抖窗口存在，不是立即推
        deliver!('change', 'config.toml') // 事件② @ t=2000：重置防抖计时器
        vi.advanceTimersByTime(2999)
        expect((await target.readManifest())?.rev).toBe(1) // 距事件①已近 5s 仍不推：重置生效；距事件②不足 3s
        vi.advanceTimersByTime(1) // t=5000：距事件②满 3s，防抖到点触发推送（真实 fs 推送链在此启动）
      } finally {
        vi.useRealTimers()
      }
      await waitFor(async () => (await target.readManifest())?.rev === 2, 30000)
      expect((await loadConfig()).profiles?.main?.default_model).toBe('debounced-push')
    } finally {
      await loop.stop()
    }
  }, 60_000)

  it('watcher 异步失效降级：无 log 实例走 console.error 兜底（双语 t() 文案），降级后轮询仍推出', async () => {
    newHome()
    await seedBase()
    const dir = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pw-watch-err', { backend: 'file' })
    let emitError: ((err: Error) => void) | undefined
    const loop = new SyncLoop({
      pollMs: 1000, // 1s 下限钳制：降级后推送只能来自轮询定时器（即时推路径已死）
      jitterRatio: 0,
      watchFn: () => {
        const w = neverWatcher()
        emitError = (err) => w.emit('error', err)
        return w
      },
      // 不传 log：复现生产构造点形态（gateway/main.ts remountSyncEngine({ applySwitch }) 恒不带 log）
    })
    loop.start()
    try {
      await waitFor(async () => (await createLocaldirTarget(dir).readManifest())?.rev === 1, 15000)
      // 确定性栅栏（同防抖用例）：等初始 tick 收尾再装 spy 投错，防尾巴噪声串进计次断言
      await waitFor(() => loop.tickSettled, 15000)
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        emitError!(new Error('EMFILE: too many open files'))
        expect(spy).toHaveBeenCalledTimes(1) // watcher 失效后 loop 内不重建 → 一次性，无重复噪声
        const line = String(spy.mock.calls[0]?.[0])
        expect(line).toContain('配置同步本地文件监听失效')
        expect(line).toContain('仅轮询同步')
        expect(line).toContain('EMFILE: too many open files')
      } finally {
        spy.mockRestore()
      }
      // 降级不哑火：本地改动经轮询定时器照常推出
      await localEdit('watch-degrade-poll-push')
      await waitFor(async () => (await createLocaldirTarget(dir).readManifest())?.rev === 2, 8000)
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
    await stopSyncEngine()
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
    await stopSyncEngine()
    expect((await syncStatus()).running).toBe(false)
  }, 30_000)

  // P-05：并发 remount 无互斥——旧实现 stopLoop 先置空 active 再 await 在飞 tick，停窗口内
  // 第二次 remount 看不到旧循环就新建，先到者恢复后又用旧签名建循环覆盖 active，留下停不掉的
  // 孤儿循环对同一目标双写。修法：模块级 promise 链互斥 + 每个 await 之后重读盘上签名。
  it('并发 remount 互斥：stop 窗口内签名再变，最终只挂最新签名的循环', async () => {
    newHome()
    await seedBase()
    await stopSyncEngine()
    const dirA = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir: dirA }, 'pw-race-a', { backend: 'file' })
    // 签名是 JSON（Windows 路径反斜杠被转义），按解析后的 target.dir 比对
    const sigDir = (sig: string | null): string | undefined => {
      if (!sig) return undefined
      return (JSON.parse(sig) as { target?: { dir?: string } }).target?.dir
    }

    let releaseGate!: () => void
    let signalEntered!: () => void
    const entered = new Promise<void>((r) => { signalEntered = r })
    const gate = new Promise<void>((r) => { releaseGate = r })

    let p1: Promise<void> | null = null
    let p2: Promise<void> | null = null
    let dirC = ''
    try {
      // 先挂 A，并给 A 的 stop() 装可控栅栏（把「停止中」窗口拉长到用例可控）
      await remountSyncEngine({ __testStopGate: () => { signalEntered(); return gate } })
      expect(sigDir(__testActiveSyncSig())).toBe(dirA)

      // 签名 B：第一次 remount 读盘后进入 stop，卡在栅栏上（active 已置空）
      const dirB = await newTargetDir()
      await setupSyncTarget({ kind: 'localdir', dir: dirB }, 'pw-race-b', { backend: 'file' })
      p1 = remountSyncEngine()
      await entered // p1 已进入「停止中」窗口

      // 停窗口内再改签名到 C 并触发第二次 remount：旧实现会趁 active 为空直接挂 C，
      // p1 恢复后再用 B 覆盖 active（C 变孤儿）。有界轮询等「第二次挂载落地」：
      // 修后 p2 排在 p1 之后、窗口内 active 仍为空，轮询超时后放行 p1（互斥本身即断言对象）。
      dirC = await newTargetDir()
      await setupSyncTarget({ kind: 'localdir', dir: dirC }, 'pw-race-c', { backend: 'file' })
      p2 = remountSyncEngine()
      const until = Date.now() + 1000
      while (Date.now() < until && sigDir(__testActiveSyncSig()) !== dirC) {
        await new Promise((r) => setTimeout(r, 10))
      }
    } finally {
      releaseGate()
    }
    await Promise.all([p1 ?? Promise.resolve(), p2 ?? Promise.resolve()])

    // 唯一活动循环必须是最新盘上签名（C）；旧实现这里是 B
    expect(sigDir(__testActiveSyncSig())).toBe(dirC)

    // 收尾：停净后无活动循环（孤儿循环会带自己的 timer/watcher 继续跑）
    await stopSyncEngine()
    expect((await syncStatus()).running).toBe(false)
    expect(__testActiveSyncSig()).toBeNull()
    expect(__testTickActiveSyncLoop()).toBeNull()
  }, 30_000)

  it('home 钉扎：env 切走后单例 loop 跳过一切 tick 零写盘，切回恢复（2026-10-30 写穿事故不变式）', async () => {
    const homeA = newHome()
    await seedBase()
    const dirA = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir: dirA }, 'pw-pin', { backend: 'file' })
    await remountSyncEngine() // 钉扎 homeA
    expect((await syncStatus()).running).toBe(true)

    // 切到 home B：B 有完整可同步态 + 待推改动，tick 仍必须整体跳过、零写入
    const homeB = newHome()
    await seedBase()
    const dirB = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir: dirB }, 'pw-pin-b', { backend: 'file' })
    await localEdit('pin-should-not-push')
    const bookkeepingBefore = fsSync.readFileSync(syncJsonPath(), 'utf8')
    expect(await __testTickActiveSyncLoop()).toBe('skipped')
    expect((await createLocaldirTarget(dirB).readManifest())?.rev).toBe(1) // 待推改动未被推出
    expect(fsSync.readFileSync(syncJsonPath(), 'utf8')).toBe(bookkeepingBefore) // 簿记零写入

    // 切回 home A：钉扎放行，tick 恢复正常（无待推改动 → idle）
    gotoHome(homeA)
    expect(await __testTickActiveSyncLoop()).toBe('idle')

    // 收尾：摘除单例（文件收尾 afterAll 再兜一次）
    await updateSyncState({ paused: true })
    await remountSyncEngine()
    await stopSyncEngine()
    expect((await syncStatus()).running).toBe(false)
  }, 30_000)
})

describe('watcher 失效降级落 debuglog（daemon 形态可观测）', () => {
  // debuglog 开关是 gateway/state 的模块级单例态（isolate:false 同 worker 跨文件共享）：
  // 每例复位三源（旗标/env），防污染 debuglog.test.ts 等同 worker 用例的开关矩阵断言
  const prevDebugEnv = process.env.MODELRDOCK_DEBUG
  afterEach(() => {
    setDebugFlag(false)
    refreshDebugOn(undefined)
    if (prevDebugEnv === undefined) delete process.env.MODELRDOCK_DEBUG
    else process.env.MODELRDOCK_DEBUG = prevDebugEnv
  })

  /** 读沙箱 logs 下全部 debug-<date>.jsonl 行（logsDir 未建即零条目） */
  function readDebugLines(): Array<Record<string, unknown>> {
    const dir = logsDir()
    if (!fsSync.existsSync(dir)) return []
    return fsSync
      .readdirSync(dir)
      .filter((f) => /^debug-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .flatMap((f) => fsSync.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  /** 复现生产构造点形态的降级 loop（恒不传 log，与 gateway/main.ts remountSyncEngine 同款）；
   *  start() 同步建 watcher，返回后 emitError 可用 */
  function startDegradeLoop(): { loop: SyncLoop; emitError: (err: Error) => void } {
    let emit: ((err: Error) => void) | undefined
    const loop = new SyncLoop({
      pollMs: 60_000, // 降级断言与推送无关：轮询拉长到用例内不触发，只盯降级事件本身
      jitterRatio: 0,
      watchFn: () => {
        const w = neverWatcher()
        emit = (err) => w.emit('error', err)
        return w
      },
    })
    loop.start()
    return { loop, emitError: (err) => emit!(err) }
  }

  it('debug 开启：降级事件落 logs/debug-<date>.jsonl（sync/watch-degrade，msg 带文案与错误详情），console 兜底保留', async () => {
    newHome()
    await seedBase()
    const dir = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pw-watch-dbg-on', { backend: 'file' })
    const { loop, emitError } = startDegradeLoop()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await waitFor(async () => (await createLocaldirTarget(dir).readManifest())?.rev === 1, 15000)
      // 确定性栅栏（同防抖用例）：等初始 tick 收尾再投错，防尾巴噪声串进计次断言
      await waitFor(() => loop.tickSettled, 15000)
      setDebugFlag(true)
      refreshDebugOn(undefined)
      emitError(new Error('EMFILE: too many open files'))
      expect(spy).toHaveBeenCalledTimes(1) // console 兜底是独立通道（前台观众），不因落盘而取消
      await drainAppendStreams() // 追加流异步建文件：读前先排空
      const hit = readDebugLines().find((l) => l.scope === 'sync' && l.op === 'watch-degrade')
      expect(hit).toBeTruthy()
      expect(hit?.level).toBe('debug')
      expect(typeof hit?.ts).toBe('string')
      const msg = String(hit?.msg)
      expect(msg).toContain('配置同步本地文件监听失效')
      expect(msg).toContain('仅轮询同步')
      expect(msg).toContain('EMFILE: too many open files')
    } finally {
      spy.mockRestore()
      await loop.stop()
    }
  }, 30_000)

  it('debug 关闭：降级只走 console 兜底，不落任何 debug-*.jsonl 条目', async () => {
    newHome()
    await seedBase()
    const dir = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pw-watch-dbg-off', { backend: 'file' })
    const { loop, emitError } = startDegradeLoop()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await waitFor(async () => (await createLocaldirTarget(dir).readManifest())?.rev === 1, 15000)
      // 确定性栅栏（同防抖用例）：等初始 tick 收尾再投错，防尾巴噪声串进计次断言
      await waitFor(() => loop.tickSettled, 15000)
      setDebugFlag(false)
      refreshDebugOn(undefined)
      delete process.env.MODELRDOCK_DEBUG // 关态口径：三源全关（env 残留 '1' 会复活开关）
      emitError(new Error('ENOSPC: no space left on device'))
      expect(spy).toHaveBeenCalledTimes(1) // console 兜底不受 debug 开关影响，照常触发
      await new Promise((r) => setTimeout(r, 150)) // 给足「若误落盘」的发生窗口再排空读盘
      await drainAppendStreams()
      expect(readDebugLines().filter((l) => l.scope === 'sync' && l.op === 'watch-degrade')).toEqual([])
    } finally {
      spy.mockRestore()
      await loop.stop()
    }
  }, 30_000)
})

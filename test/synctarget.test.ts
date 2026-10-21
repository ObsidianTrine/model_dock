import http from 'node:http'
import net from 'node:net'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig, saveConfig, mutateConfig } from '../src/config/store.js'
import { getSecret, makeKeyRef, setSecret } from '../src/config/secrets.js'
import { backupsDir } from '../src/util/paths.js'
import { setupSyncTarget } from '../src/sync/setup.js'
import { safeSyncTick, syncTickOnce, SyncLoop, syncStatus } from '../src/sync/engine.js'
import { EventEmitter } from 'node:events'
import { createLocaldirTarget } from '../src/sync/targets/localdir.js'
import { createWebdavTarget } from '../src/sync/targets/webdav.js'
import { blobRefOf } from '../src/sync/targets/types.js'
import { keysFromState } from '../src/sync/runtime.js'
import { sealWithKeys } from '../src/sync/crypto.js'
import { collectSyncdoc } from '../src/sync/collect.js'
import { readSyncState, updateSyncState } from '../src/sync/state.js'
import type { Config } from '../src/config/types.js'

/**
 * 双机/多轮沙箱：fakeHome 的 restore 会删目录、且是全局 env——这里用持久临时目录 + 手动切换 env，
 * 支持「A 改 → 切 B → B 改 → 切回 A」的交错（冲突语义必须有真交错才能触发）。
 * 本仓库 vitest 是 singleFork+isolate:false（全文件共用一个进程与 process.env）——
 * 文件收尾必须把 env 恢复到进场前的原值（不能 delete 留空），否则后续文件会写到真实 home。
 */
const PREV_FAKE_HOME = process.env.MODELRDOCK_FAKE_HOME
const PREV_MD_HOME = process.env.MODELRDOCK_HOME
// os.tmpdir() 在部分 Windows 机器返回 8.3 短名路径（如 ZHOUQI~1）：fs.watch 该目录时
// 文件事件会踩 libuv fs-event 断言（assert !_wcsnicmp(filename, dir, dirlen)）原生崩溃、
// 拖死整个测试 fork（SyncLoop 用例必崩，2026-10-21 本机实测）。native realpath 走
// GetFinalPathNameByHandle 把短名展开为长路径；普通 realpathSync 不展开。测试沙箱一律用它打底。
const TMP = fsSync.realpathSync.native(os.tmpdir())
const homes: string[] = []
const targetDirs: string[] = []
function newHome(): string {
  const h = fsSync.mkdtempSync(path.join(TMP, 'modeldock-test-'))
  homes.push(h)
  gotoHome(h)
  return h
}
function gotoHome(h: string): void {
  process.env.MODELRDOCK_FAKE_HOME = h
  delete process.env.MODELRDOCK_HOME
}
/** 每个用例独立的同步目标目录（防用例间 manifest/blob 串场） */
async function newTargetDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(TMP, 'modeldock-sync-target-'))
  targetDirs.push(d)
  return d
}
afterAll(async () => {
  if (PREV_FAKE_HOME === undefined) delete process.env.MODELRDOCK_FAKE_HOME
  else process.env.MODELRDOCK_FAKE_HOME = PREV_FAKE_HOME
  if (PREV_MD_HOME === undefined) delete process.env.MODELRDOCK_HOME
  else process.env.MODELRDOCK_HOME = PREV_MD_HOME
  for (const h of [...homes, ...targetDirs]) {
    await fs.rm(h, { recursive: true, force: true }).catch(() => {})
  }
})

async function seedBase(): Promise<void> {
  // security.store=file：引擎/导入在本机凭据写盘全在沙箱内，绝不碰真实钥匙串
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

async function readCfg(): Promise<Config> {
  return loadConfig()
}

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  throw new Error('waitFor timeout')
}

/** 内存 WebDAV 假件：GET/PUT/MKCOL + Basic 鉴权，listen(0) 随机端口（红线：绝不碰 8687/8890） */
function startWebdavFake(expectAuth?: string): Promise<{ port: number; store: Map<string, string>; close: () => Promise<void> }> {
  const store = new Map<string, string>()
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (expectAuth && req.headers.authorization !== expectAuth) {
        res.statusCode = 401
        res.end('unauthorized')
        return
      }
      const p = req.url ?? '/'
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.method === 'MKCOL') {
        store.set(p, '')
        res.statusCode = 201
        res.end()
        return
      }
      if (req.method === 'PUT') {
        store.set(p, body)
        res.statusCode = 201
        res.end()
        return
      }
      if (req.method === 'GET') {
        const v = store.get(p)
        if (v === undefined) {
          res.statusCode = 404
          res.end('not found')
          return
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(v)
        return
      }
      res.statusCode = 405
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      resolve({ port: addr.port, store, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

describe('localdir 同步目标', () => {
  it('全新目标 readManifest 为 null；推 blob/manifest 后可读；baseRev 不符报 conflict；blob 缺失可操作报错', async () => {
    const target = createLocaldirTarget(await newTargetDir())
    expect(await target.readManifest()).toBeNull()
    await target.writeBlob(1, 'mdksync_a', '{"fmt":"modeldock-syncenv"}')
    expect(await target.writeManifest({ rev: 1, ts: '2026-10-05T00:00:00.000Z', byDevid: 'mdksync_a', blobRef: 'blobs/1-mdksync_a.msync' }, 0)).toBe('ok')
    const m = await target.readManifest()
    expect(m?.rev).toBe(1)
    expect(m?.byDevid).toBe('mdksync_a')
    expect(await target.readBlob('blobs/1-mdksync_a.msync')).toBe('{"fmt":"modeldock-syncenv"}')
    expect(await target.writeManifest({ rev: 2, ts: 'x', byDevid: 'b', blobRef: 'blobs/2-b.msync' }, 0)).toBe('conflict')
    await expect(target.readBlob('blobs/9-none.msync')).rejects.toThrow(/blobs/)
  })
})

describe('WebDAV 同步目标（内存假件，随机端口）', () => {
  it('鉴权通过时四操作可用；凭据错误被 401 拦；blob 落在 modeldock-sync/blobs/', async () => {
    const expectAuth = 'Basic ' + Buffer.from('user:pass').toString('base64')
    const fake = await startWebdavFake(expectAuth)
    try {
      const target = createWebdavTarget({ url: `http://127.0.0.1:${fake.port}/dav`, dir: 'modeldock', username: 'user', password: 'pass' })
      expect(await target.readManifest()).toBeNull()
      await target.writeBlob(1, 'mdksync_a', '{"fmt":"modeldock-syncenv"}')
      expect(await target.writeManifest({ rev: 1, ts: 't', byDevid: 'mdksync_a', blobRef: 'blobs/1-mdksync_a.msync' }, 0)).toBe('ok')
      expect((await target.readManifest())?.rev).toBe(1)
      expect(await target.readBlob('blobs/1-mdksync_a.msync')).toBe('{"fmt":"modeldock-syncenv"}')
      expect([...fake.store.keys()].some((k) => k.endsWith('/modeldock/modeldock-sync/blobs/1-mdksync_a.msync'))).toBe(true)

      const bad = createWebdavTarget({ url: `http://127.0.0.1:${fake.port}/dav`, dir: 'modeldock', username: 'user', password: 'WRONG' })
      await expect(bad.readManifest()).rejects.toThrow(/401/)
    } finally {
      await fake.close()
    }
  })

  it('readBlob 拒绝越界 ref（encodeURIComponent 不编码 ..，与 localdir 前缀校验同级）', async () => {
    const expectAuth = 'Basic ' + Buffer.from('user:pass').toString('base64')
    const fake = await startWebdavFake(expectAuth)
    try {
      const target = createWebdavTarget({ url: `http://127.0.0.1:${fake.port}/dav`, dir: 'modeldock', username: 'user', password: 'pass' })
      await expect(target.readBlob('../secret.txt')).rejects.toThrow(/非法|Invalid/)
      await expect(target.readBlob('blobs/../../etc/passwd')).rejects.toThrow(/非法|Invalid/)
      await expect(target.readBlob('blobs')).rejects.toThrow(/非法|Invalid/)
      // 合法形态放行：文件缺失走「历史包缺失」而非「非法」
      await expect(target.readBlob('blobs/9-somedev.msync')).rejects.toThrow(/缺失|missing/)
    } finally {
      await fake.close()
    }
  })
})

describe('双机端到端（localdir 目标，交错沙箱）', () => {
  it('A 首推 rev1 → B 加入收敛（机器态保留）→ A 改推 rev2 → B 拉取一致；空闲 tick 幂等；sync.json 0600', async () => {
    const dir = await newTargetDir()
    // —— 机器 A：种子配置并首推 ——
    const homeA = newHome()
    await seedBase()
    const setupA = await setupSyncTarget({ kind: 'localdir', dir }, 'pass-1', { backend: 'file' })
    expect(setupA.joined).toBe(false)
    expect(setupA.rev).toBe(1)
    const stA = await readSyncState()
    expect(stA?.mode).toBe('target')
    expect(stA?.lastAppliedRev).toBe(1)
    expect(stA?.lastSyncedHash).toBeTruthy()
    if (process.platform !== 'win32') {
      const mode = (await fs.stat(path.join(homeA, '.modeldock', 'sync.json'))).mode & 0o777
      expect(mode).toBe(0o600)
    }

    // —— 机器 B：加入既有目标，自动收敛；本地临时改动被远端覆盖，机器态保留 ——
    const homeB = newHome()
    await seedBase()
    await mutateConfig((c) => {
      c.providers!.extra = { base_url: 'https://extra.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:EXTRA_KEY' }
    })
    const setupB = await setupSyncTarget({ kind: 'localdir', dir }, 'pass-1', { backend: 'file' })
    expect(setupB.joined).toBe(true)
    const cfgB = await readCfg()
    expect(Object.keys(cfgB.providers ?? {})).toEqual(['ark'])
    expect(cfgB.profiles?.main?.provider).toBe('ark')
    expect(await getSecret(makeKeyRef('file', 'ark'))).toBe('sk-ark-plaintext')
    expect(cfgB.harness?.['claude-code']).toBeTruthy()

    // B 空闲 tick：无本地改动 → idle（校验 apply 后重收集指纹稳定，不会无谓回推）
    expect(await syncTickOnce()).toBe('idle')

    // —— A 加服务推送 rev2 → B 拉取收敛 ——
    gotoHome(homeA)
    await setSecret('deepseek', 'sk-ds-plaintext', 'file')
    await mutateConfig((c) => {
      c.providers!.deepseek = { base_url: 'https://ds.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: makeKeyRef('file', 'deepseek') }
      c.profiles!.main!.default_model = 'auto-v2'
    })
    expect(await syncTickOnce()).toBe('pushed')
    expect((await readSyncState())?.lastAppliedRev).toBe(2)

    gotoHome(homeB)
    expect(await syncTickOnce()).toBe('pulled')
    const cfgB2 = await readCfg()
    expect(Object.keys(cfgB2.providers ?? {}).sort()).toEqual(['ark', 'deepseek'])
    expect(cfgB2.profiles?.main?.default_model).toBe('auto-v2')
    expect(await getSecret(makeKeyRef('file', 'deepseek'))).toBe('sk-ds-plaintext')
    expect((await readSyncState())?.lastAppliedRev).toBe(2)
  })

  it('双机并发改动 → 后推者胜，先改方留下冲突快照并应用远端（D6），收敛后可继续推', async () => {
    const dir = await newTargetDir()
    // —— A 首推 rev1 ——
    const homeA = newHome()
    await seedBase()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pass-c', { backend: 'file' })
    expect(await syncTickOnce()).toBe('idle')

    // —— B 加入 rev1，随后本地改动推 rev2 ——
    const homeB = newHome()
    await seedBase()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pass-c', { backend: 'file' })
    await setSecret('from-b', 'sk-b', 'file')
    await mutateConfig((c) => {
      c.providers!.fromB = { base_url: 'https://b.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: makeKeyRef('file', 'from-b') }
    })
    expect(await syncTickOnce()).toBe('pushed')

    // —— A 也在本地改了（停在 rev1 未拉）→ A tick 检测冲突：远端胜 + 本地快照 ——
    gotoHome(homeA)
    await setSecret('from-a', 'sk-a-pending', 'file')
    await mutateConfig((c) => {
      c.providers!.fromA = { base_url: 'https://a.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: makeKeyRef('file', 'from-a') }
    })
    expect(await syncTickOnce()).toBe('conflict')
    const cfgA = await readCfg()
    expect(cfgA.providers?.fromB).toBeTruthy()
    expect(cfgA.providers?.fromA).toBeUndefined()
    // 本机待推内容已快照，未丢失
    const snaps = (await fs.readdir(backupsDir())).filter((f) => f.startsWith('sync-conflict-'))
    expect(snaps.length).toBeGreaterThan(0)
    const snapDoc = JSON.parse(await fs.readFile(path.join(backupsDir(), snaps[0]), 'utf8'))
    expect(snapDoc.data.providers.fromA.key).toBe('sk-a-pending')
    const st = await readSyncState()
    expect(st?.lastConflictTs).toBeTruthy()
    expect(st?.lastAppliedRev).toBe(2)

    // —— B 又推 rev3，A 干净拉取：冲突提醒保留（拉取不代表差异已重做） ——
    gotoHome(homeB)
    await setSecret('from-b2', 'sk-b2', 'file')
    await mutateConfig((c) => {
      c.providers!.fromB2 = { base_url: 'https://b2.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: makeKeyRef('file', 'from-b2') }
    })
    expect(await syncTickOnce()).toBe('pushed')

    gotoHome(homeA)
    expect(await syncTickOnce()).toBe('pulled')
    expect((await readSyncState())?.lastConflictTs).toBeTruthy()
    expect((await readSyncState())?.lastAppliedRev).toBe(3)

    // —— A 再改 → 成功推送 rev4：冲突提醒自动销项 ——
    await mutateConfig((c) => {
      c.profiles!.main!.default_model = 'after-conflict'
    })
    expect(await syncTickOnce()).toBe('pushed')
    const stA3 = await readSyncState()
    expect(stA3?.lastAppliedRev).toBe(4)
    expect(stA3?.lastConflictTs).toBeNull()
  }, 60_000) // 多轮 KDF + 交错 tick 在 Windows 慢机约 30s，高于全局 20s；显式放宽避免误杀

  it('加入时口令错误被拒且可操作，目标内容不被破坏', async () => {
    const dir = await newTargetDir()
    newHome()
    await seedBase()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pass-right', { backend: 'file' })
    const mBefore = await createLocaldirTarget(dir).readManifest()
    newHome()
    await seedBase()
    await expect(setupSyncTarget({ kind: 'localdir', dir }, 'totally-wrong', { backend: 'file' })).rejects.toThrow(/口令与该同步目标不一致|passphrase does not match/)
    // 目标 manifest 未被新机器动过
    const mAfter = await createLocaldirTarget(dir).readManifest()
    expect(mAfter?.rev).toBe(mBefore?.rev)
  })
})

describe('引擎兜底与开关（单沙箱）', () => {
  it('目标不可达：安全 tick 记录 lastError 不抛出；pause 后一切跳过', async () => {
    newHome()
    await seedBase()
    const fake = await startWebdavFake('Basic ' + Buffer.from('u:p').toString('base64'))
    await setupSyncTarget({ kind: 'webdav', url: `http://127.0.0.1:${fake.port}/dav`, dir: 'modeldock', username: 'u', password: 'p' }, 'pass-off', { backend: 'file' })
    await fake.close()
    // 本地改动触发推送 → 目标已关：safeSyncTick 吞错并记账
    await mutateConfig((c) => {
      c.profiles!.main!.default_model = 'offline-test'
    })
    expect(await safeSyncTick()).toBe('skipped')
    const st = await readSyncState()
    expect(st?.lastError).toBeTruthy()
    expect(st?.lastSyncedHash).not.toBeNull()
    // pause：引擎跳过一切推拉
    await updateSyncState({ paused: true, lastError: null })
    expect(await syncTickOnce()).toBe('skipped')
  })

  it('SyncLoop：远端出新版本后轮询自动拉取；本地改文件后监听器即时推送（rev 前进）', async () => {
    newHome()
    await seedBase()
    const dir = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pass-loop', { backend: 'file' })
    const target = createLocaldirTarget(dir)

    // 模拟另一台机器直接在目标上落 rev2（用本机密钥材料密封、不同 devid）
    const st1 = await readSyncState()
    const keys = keysFromState(st1!)
    const remoteDoc = (await collectSyncdoc()).doc
    remoteDoc.data.profiles.main.default_model = 'remote-pushed'
    await target.writeBlob(2, 'mdksync_remote', JSON.stringify(sealWithKeys(remoteDoc, keys), null, 2) + '\n')
    await target.writeManifest({ rev: 2, ts: remoteDoc.ts, byDevid: 'mdksync_remote', blobRef: blobRefOf(2, 'mdksync_remote') }, 1)

    const loop = new SyncLoop({ pollMs: 50, jitterRatio: 0, debounceMs: 30 })
    loop.start()
    try {
      // 轮询自动拉取 rev2
      await waitFor(async () => (await loadConfig()).profiles?.main?.default_model === 'remote-pushed', 15000)

      // 本地改配置（真实写 config.toml → watcher 触发 → 防抖 tick 推 rev3）
      await mutateConfig((c) => {
        c.profiles!.main!.default_model = 'local-after-remote'
      })
      await waitFor(async () => (await target.readManifest())?.rev === 3, 15000)
      await waitFor(async () => (await loadConfig()).profiles?.main?.default_model === 'local-after-remote', 15000)
    } finally {
      // stop 会等在飞 tick 收尾：防止长尾写盘落到文件结束、env 被恢复后的真实 home（2026-10-05 事故根因）
      await loop.stop()
    }
  })

  it('BUG-03：watcher 异步 error 不抛未捕获异常，记日志并降级，同步状态仍可查询', async () => {
    newHome()
    await seedBase()
    const dir = await newTargetDir()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pass-watch', { backend: 'file' })

    // 桩 watcher：注入 watchFn 返回受控 EventEmitter，便于同步触发异步 'error'
    const watcher = new EventEmitter() as unknown as fsSync.FSWatcher
    const logs: string[] = []
    const loop = new SyncLoop({
      watchFn: () => watcher as fsSync.FSWatcher,
      log: (l) => logs.push(l),
    })
    loop.start()
    try {
      // start 已为 watcher 挂上 'error' 兜底 → emit 不抛、进程存活
      expect(() => watcher.emit('error', new Error('EMFILE (inotify limit)'))).not.toThrow()
      // 兜底已记日志（只损失「即时推」，轮询继续）——文案双语不在此钉死
      expect(logs.length).toBeGreaterThan(0)
      // watcher 引用已清空，stop() 不再 close 已失效的 watcher（不抛）；状态可查询
      await loop.stop()
      const st = await syncStatus()
      expect(st.mode).toBe('target')
      expect((await readSyncState())?.lastAppliedRev).toBe(1)
    } finally {
      await loop.stop()
    }
  })
})

/**
 * DRIFT-02 归并后两条 setup 路径的行为锚点（从既有端到端用例迁移，不改语义）：
 * 仅守住「已有目标→加入收敛」与「全新目标→本机作为 rev1 首推」各自的核心可观察行为。
 */
describe('setup 双路径行为锚点（DRIFT-02）', () => {
  it('全新目标：本机作为 rev1 首推，joined=false，sync.json 落库', async () => {
    const dir = await newTargetDir()
    newHome()
    await seedBase()
    const setup = await setupSyncTarget({ kind: 'localdir', dir }, 'pass-fresh', { backend: 'file' })
    expect(setup.joined).toBe(false)
    expect(setup.rev).toBe(1)
    expect(setup.report).not.toBeNull()
    const st = await readSyncState()
    expect(st?.mode).toBe('target')
    expect(st?.lastAppliedRev).toBe(1)
    expect(st?.lastSyncedHash).toBeTruthy()
    const m = await createLocaldirTarget(dir).readManifest()
    expect(m?.rev).toBe(1)
  })

  it('已有目标：B 加入收敛，应用远端 rev1（本机本地改动被远端覆盖），joined=true', async () => {
    const dir = await newTargetDir()
    newHome()
    await seedBase()
    await setupSyncTarget({ kind: 'localdir', dir }, 'pass-join', { backend: 'file' }) // A 首推 rev1
    const mBefore = await createLocaldirTarget(dir).readManifest()

    newHome() // 切到 B
    await seedBase()
    await mutateConfig((c) => {
      c.providers!.local_marker = { base_url: 'https://local.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:LOCAL' }
    })
    const setupB = await setupSyncTarget({ kind: 'localdir', dir }, 'pass-join', { backend: 'file' })
    expect(setupB.joined).toBe(true)
    expect(setupB.rev).toBe(mBefore?.rev)
    const cfgB = await readCfg()
    // 本机临时改动被远端覆盖，远端内容胜（ark 单服务、无 local_marker）
    expect(cfgB.providers?.local_marker).toBeUndefined()
    expect(Object.keys(cfgB.providers ?? {})).toEqual(['ark'])
    expect((await readSyncState())?.lastAppliedRev).toBe(mBefore?.rev)
  })
})

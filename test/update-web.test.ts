import http from 'node:http'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { saveConfig } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { setSecret } from '../src/config/secrets.js'
import { buildRuntime, mutateGatewayState, readGatewayState, startupGatewayState, writeGatewayState, type GatewayRuntime, type GatewayStateFile } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { VERSION } from '../src/version.js'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import {
  applyUpdate,
  drivePrefetchFromState,
  getUpdateStatus,
  kickUpdateCheck,
  resetUpdateStateForTests,
  restoreUpdateCheckState,
  setUpdateApiBaseForTests,
  setUpdateFetchForTests,
  watchApplyChild,
} from '../src/update/webupdate.js'
import { prefetchInflightForTests, resetPrefetchStateForTests, setPrefetchExecPathForTests } from '../src/update/prefetch.js'
import { markStagingConsumed, readStagingMeta, saveStagingMeta } from '../src/update/staging.js'
import { selectAssetName } from '../src/update/check.js'
import { detectInstallShape } from '../src/update/install.js'
import { writeUpdateProgress, updateProgressPath } from '../src/update/progress.js'
import { logsDir, modeldockDir } from '../src/util/paths.js'
import type { ReleaseManifest } from '../src/update/check.js'
import { updateDaemonArgs } from '../src/autostart.js'

const TOKEN = 'ghp_test-token'
const REPO = 'owner/repo'

// 本地伪造 GitHub releases/latest（仅检查链路；apply 不真 spawn，spawner 注入）。
// opts.asset 提供时发布带资产（预取集成用例）：assets/1 = 安装包、assets/2 = SHA256SUMS。
function startMockApi(
  tag: string,
  opts: { htmlUrl?: string | null; asset?: { name: string; body: Buffer; sums: Buffer } } = {}
): Promise<{ apiBase: string; close: () => Promise<void> }> {
  const htmlUrl = opts.htmlUrl === undefined ? `https://github.com/${REPO}/releases/tag/${tag}` : opts.htmlUrl
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === `/repos/${REPO}/releases/latest`) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            tag_name: tag,
            body: '**更新说明摘要**：一条改动\n\n### 新增\n\n- **点题**：细节',
            html_url: htmlUrl === null ? undefined : htmlUrl, // null = 发布里没有 html_url（自建镜像常见）
            assets: opts.asset
              ? [
                  { name: opts.asset.name, id: 1, size: opts.asset.body.length },
                  { name: 'SHA256SUMS', id: 2, size: opts.asset.sums.length },
                ]
              : [],
          })
        )
        return
      }
      if (opts.asset) {
        if (req.url === `/repos/${REPO}/releases/assets/1`) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(opts.asset.body)
          return
        }
        if (req.url === `/repos/${REPO}/releases/assets/2`) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(opts.asset.sums)
          return
        }
      }
      res.writeHead(404).end()
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('no port')
      resolve({ apiBase: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

async function mkRt(over: Partial<Config> = {}): Promise<GatewayRuntime> {
  const cfg: Config = {
    ...emptyConfig(),
    security: { store: 'file' },
    update: { repo: REPO, token_ref: 'file:update-token' },
    ...over,
  }
  await saveConfig(cfg)
  return buildRuntime(cfg, 'mdkadm_admin')
}

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') reject(new Error('no port'))
      else resolve(addr.port)
    })
  })
}

describe('updateDaemonArgs（纯函数，autostart 模块）', () => {
  it('尾参替换为 update --yes（复用 SEA/tsx 形态推导），不再带 --sea-gateway', () => {
    const argv = updateDaemonArgs()
    expect(argv.length).toBeGreaterThanOrEqual(3)
    expect(argv.slice(-2)).toEqual(['update', '--yes'])
    expect(argv).not.toContain('--sea-gateway')
    expect(argv[0].length).toBeGreaterThan(0)
  })
})

describe('启动重写保留 update_check（卡 28：gateway-state-rmw 问题 2）', () => {
  it('startupGatewayState 从既有状态保留 devices 与 update_check；无 lan 时不留空字段', () => {
    const out = startupGatewayState({
      existing: { pid: 1, port: 8687, admin_token: 'old', started_at: 't0', devices: ['mdk_device_a'], update_check: { at: 111, version: '1.2.3' } },
      pid: 2,
      port: 18999,
      adminToken: 'new',
      lanToken: null,
      startedAt: 't1',
    })
    expect(out).toMatchObject({ pid: 2, port: 18999, admin_token: 'new', started_at: 't1', devices: ['mdk_device_a'] })
    expect(out.update_check).toEqual({ at: 111, version: '1.2.3' })
    expect('lan_token' in out).toBe(false)
    expect('lan_port' in out).toBe(false)
    // 既有状态无 update_check 时不凭空造字段
    const bare = startupGatewayState({ existing: null, pid: 2, port: 18999, adminToken: 'new', lanToken: 'lan', lanPort: 8688, startedAt: 't1' })
    expect('update_check' in bare).toBe(false)
    expect(bare.lan_token).toBe('lan')
  })

  it('整包重写往返：update_check 跨写盘存活（restoreUpdateCheckState 从此有据可读）', async () => {
    const h = fakeHome()
    try {
      await writeGatewayState({ pid: 1, port: 8687, admin_token: 'old', started_at: 't0', update_check: { at: 111, version: '1.2.3' } })
      const existing = await readGatewayState()
      await writeGatewayState(startupGatewayState({ existing, pid: process.pid, port: 18998, adminToken: 'new', lanToken: null, startedAt: 't1' }))
      const next = await readGatewayState()
      expect(next?.update_check).toEqual({ at: 111, version: '1.2.3' })
      expect(next?.admin_token).toBe('new')
      expect(next?.pid).toBe(process.pid)
    } finally {
      h.restore()
    }
  })
})

describe('getUpdateStatus 坏 token_ref 降级（卡 28：gateway-state-rmw 问题 1）', () => {
  it('token_ref 非串（手编 config.toml）：不抛、configured=false、lastError 透出、载荷完整', async () => {
    const h = fakeHome()
    try {
      const rt = await mkRt({ update: { repo: REPO, token_ref: 123 as unknown as string } })
      const s = await getUpdateStatus(rt)
      expect(s.configured).toBe(false)
      expect(s.lastError).toBeTruthy()
      expect(s.current).toBe(VERSION)
      expect(s.checking).toBe(false)
      expect(s.available).toBe(false)
    } finally {
      h.restore()
    }
  })
})

describe('更新服务：检查 / 状态 / 应用（mock API + fakeHome）', () => {
  let cleanup: (() => Promise<void>) | null = null
  beforeEach(() => {
    resetUpdateStateForTests()
    setUpdateApiBaseForTests(null)
  })
  afterEach(async () => {
    setUpdateApiBaseForTests(null)
    setUpdateFetchForTests(null)
    await cleanup?.()
    cleanup = null
  })

  it('无令牌：匿名照常检查（公开仓库免 PAT），status 报 configured=false', async () => {
    const h = fakeHome()
    const api = await startMockApi('v999.0.0')
    cleanup = api.close
    setUpdateApiBaseForTests(api.apiBase)
    try {
      const rt = await mkRt({ update: { repo: REPO } })
      await kickUpdateCheck(rt, { force: true })
      const s = await getUpdateStatus(rt)
      expect(s.configured).toBe(false)
      expect(s.available).toBe(true)
      expect(s.latest).toBe('999.0.0')
      expect(s.lastCheckedAt).not.toBeNull()
    } finally {
      h.restore()
    }
  })

  it('有令牌 + 新版：检查后 available=true、notes 已降级为纯文本并带发布页地址；gateway.json 持久化检查时间与版本', async () => {
    const h = fakeHome()
    const api = await startMockApi('v999.0.0')
    cleanup = api.close
    setUpdateApiBaseForTests(api.apiBase)
    try {
      await setSecret('update-token', TOKEN, 'file')
      const rt = await mkRt()
      // 预置网关状态文件（生产上 gateway.json 先于检查存在；persistCheckTime 合并写回而非新建）
      await writeGatewayState({ pid: process.pid, port: 18999, admin_token: 'x', started_at: 't' })
      await kickUpdateCheck(rt, { force: true })
      const s = await getUpdateStatus(rt)
      expect(s.configured).toBe(true)
      expect(s.available).toBe(true)
      expect(s.latest).toBe('999.0.0')
      // 说明在服务端降级：markdown 标记不进卡片（卡片是纯文本框），条目结构保留
      expect(s.notes).toContain('更新说明摘要：一条改动')
      expect(s.notes).toContain('· 点题：细节')
      expect(s.notes).not.toContain('**')
      expect(s.notes).not.toContain('###')
      // summary = 摘要收口（首段 + 分节点题计数，同 CLI 检查输出）：原生小窗放全文会变成一面墙的长段落
      expect(s.summary).toBe('更新说明摘要：一条改动\n· 新增 1 项：点题')
      expect(s.summary).not.toContain('细节')
      expect(s.htmlUrl).toBe(`https://github.com/${REPO}/releases/tag/v999.0.0`)
      expect(s.sizeBytes).toBeNull() // mock 发布无资产：体积缺省 null
      expect(s.lastCheckedAt).not.toBeNull()
      const state = await readGatewayState()
      expect(state?.update_check?.at).toBe(s.lastCheckedAt)
      expect(state?.update_check?.version).toBe('999.0.0')
      expect(state?.admin_token).toBe('x') // 既有字段保留
    } finally {
      h.restore()
    }
  })

  it('发布缺 html_url（自建镜像）：htmlUrl 为 null，界面据此不显示发布页链接', async () => {
    const h = fakeHome()
    const api = await startMockApi('v999.0.0', { htmlUrl: null })
    cleanup = api.close
    setUpdateApiBaseForTests(api.apiBase)
    try {
      await setSecret('update-token', TOKEN, 'file')
      const rt = await mkRt()
      await writeGatewayState({ pid: process.pid, port: 18999, admin_token: 'x', started_at: 't' })
      await kickUpdateCheck(rt, { force: true })
      const s = await getUpdateStatus(rt)
      expect(s.available).toBe(true)
      expect(s.notes).toContain('更新说明摘要')
      expect(s.htmlUrl).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('[update].api_base 配置生效：feed 地址可指向自建源（无需测试注入钩子）', async () => {
    const h = fakeHome()
    const api = await startMockApi('v999.0.0')
    cleanup = api.close
    try {
      await setSecret('update-token', TOKEN, 'file')
      const rt = await mkRt({ update: { repo: REPO, token_ref: 'file:update-token', api_base: api.apiBase } })
      await kickUpdateCheck(rt, { force: true })
      const s = await getUpdateStatus(rt)
      expect(s.available).toBe(true)
      expect(s.latest).toBe('999.0.0')
    } finally {
      await h.restore()
    }
  })

  it('24h TTL：未 force 的 kick 在 TTL 内不再发请求（mock 换旧版本号后 latest 不变）', async () => {
    const h = fakeHome()
    const api1 = await startMockApi('v999.0.0')
    try {
      await setSecret('update-token', TOKEN, 'file')
      const rt = await mkRt()
      setUpdateApiBaseForTests(api1.apiBase)
      await kickUpdateCheck(rt, { force: true })
      expect((await getUpdateStatus(rt)).latest).toBe('999.0.0')

      await api1.close()
      const api2 = await startMockApi('v777.0.0')
      cleanup = api2.close
      setUpdateApiBaseForTests(api2.apiBase)
      // 未 force：TTL 未到 → 不会真的去查（否则 latest 会变成 777.0.0）
      await kickUpdateCheck(rt)
      expect((await getUpdateStatus(rt)).latest).toBe('999.0.0')
      // force：绕过 TTL
      await kickUpdateCheck(rt, { force: true })
      expect((await getUpdateStatus(rt)).latest).toBe('777.0.0')
    } finally {
      await h.restore()
    }
  })

  it('检查失败不占成功 TTL：lastCheckedAt 保留、failedAt 落盘（30min 重试退避），成功后清 failedAt', async () => {
    const h = fakeHome()
    try {
      const rt = await mkRt()
      await writeGatewayState({ pid: process.pid, port: 18999, admin_token: 'x', started_at: 't' })

      // 1) 成功一次（旧版）：lastCheckedAt 落盘
      let calls = 0
      let fail = false
      const manifest: ReleaseManifest = { version: '777.0.0', tagName: 'v777.0.0', notes: '', htmlUrl: '', assets: [] }
      setUpdateFetchForTests(() => {
        calls++
        if (fail) return Promise.reject(new Error('网络不可达'))
        return Promise.resolve(manifest)
      })
      await kickUpdateCheck(rt, { force: true })
      const okAt = (await getUpdateStatus(rt)).lastCheckedAt
      expect(okAt).not.toBeNull()

      // 2) 失败：lastCheckedAt 不被覆盖（成功时间保留），lastError/failedAt 记录
      fail = true
      await kickUpdateCheck(rt, { force: true })
      const s2 = await getUpdateStatus(rt)
      expect(s2.lastError).toContain('网络不可达')
      expect(s2.lastCheckedAt).toBe(okAt)
      const st2 = await readGatewayState()
      expect(st2?.update_check?.at).toBe(okAt)
      expect(st2?.update_check?.failedAt).not.toBeNull()
      expect(st2?.update_check?.version).toBe('777.0.0') // 失败不冲掉此前看到的版本

      // 3) 成功 TTL 过期后，失败退避仍生效：at 拨回 25h 前（成功 TTL 过）→ 失败退避(30min)内 → 不重试
      const st3 = await readGatewayState()
      await writeGatewayState({ ...st3!, update_check: { ...st3!.update_check!, at: Date.now() - 25 * 3600_000 } })
      await restoreUpdateCheckState()
      const before = calls
      await kickUpdateCheck(rt)
      expect(calls).toBe(before)

      // 4) failedAt 拨回 31 分钟前（退避到期）→ 非 force kick 重试成功 → failedAt 清除
      const st4 = await readGatewayState()
      await writeGatewayState({ ...st4!, update_check: { ...st4!.update_check!, failedAt: Date.now() - 31 * 60_000 } })
      await restoreUpdateCheckState()
      fail = false
      await kickUpdateCheck(rt)
      expect(calls).toBe(before + 1)
      const s4 = await getUpdateStatus(rt)
      expect(s4.lastError).toBeNull()
      const st5 = await readGatewayState()
      expect(st5?.update_check?.failedAt).toBeUndefined()
      expect(st5?.update_check?.at).toBe(s4.lastCheckedAt)
    } finally {
      h.restore()
    }
  })

  it('persistCheckTime 走 mutateGatewayState 串行队列：与并发 gateway.json 写方交错不丢 devices（旧裸 RMW 回归）', async () => {
    const h = fakeHome()
    try {
      const rt = await mkRt()
      let releaseDevices!: () => void
      const gate = new Promise<void>((r) => { releaseDevices = r })
      // 占住串行队列：gate 释放后才落盘一份带 devices 的 gateway.json
      const longWrite = mutateGatewayState(async (s) => {
        await gate
        return {
          ...(s ?? { pid: process.pid, port: 18999, admin_token: 'x', started_at: new Date().toISOString() }),
          devices: ['dev-cookie-1'],
        } as GatewayStateFile
      })
      const manifest: ReleaseManifest = { version: '999.0.0', tagName: 'v999.0.0', notes: '', htmlUrl: '', assets: [] }
      setUpdateFetchForTests(() => Promise.resolve(manifest))
      // 更新检查成功 → persistCheckTime 必须排在 longWrite 之后（旧裸 RMW 不入队，读空文件直接返回）
      const kickP = kickUpdateCheck(rt)
      releaseDevices()
      await Promise.all([longWrite, kickP])
      const final = await readGatewayState()
      expect(final?.devices).toEqual(['dev-cookie-1']) // 旧裸 RMW 下丢失
      expect(final?.update_check?.at).not.toBeNull() // 新队列下两个写都落
    } finally {
      setUpdateFetchForTests(null)
      h.restore()
    }
  })

  it('从未成功过时失败也持久化 failedAt（无 at 可保留），退避到期后重试成功补齐 at', async () => {
    const h = fakeHome()
    try {
      const rt = await mkRt()
      await writeGatewayState({ pid: process.pid, port: 18999, admin_token: 'x', started_at: 't' })
      let fail = true
      setUpdateFetchForTests(() => (fail ? Promise.reject(new Error('拉取失败')) : Promise.resolve({ version: '999.0.0', tagName: 'v999.0.0', notes: '', htmlUrl: '', assets: [] })))
      await kickUpdateCheck(rt, { force: true })
      const st1 = await readGatewayState()
      expect(st1?.update_check?.failedAt).not.toBeNull()
      expect(st1?.update_check?.at).toBeUndefined()

      // 退避内不重试
      await kickUpdateCheck(rt)
      const st2 = await readGatewayState()
      expect(st2?.update_check?.failedAt).toBe(st1!.update_check!.failedAt)

      // 退避到期 + 恢复 → 成功补齐 at/version、清 failedAt
      await writeGatewayState({ ...st2!, update_check: { failedAt: Date.now() - 31 * 60_000 } })
      await restoreUpdateCheckState()
      fail = false
      await kickUpdateCheck(rt)
      const st3 = await readGatewayState()
      expect(st3?.update_check?.at).not.toBeNull()
      expect(st3?.update_check?.failedAt).toBeUndefined()
      const s = await getUpdateStatus(rt)
      expect(s.available).toBe(true)
      expect(s.latest).toBe('999.0.0')
    } finally {
      h.restore()
    }
  })

  it('status 载荷透传 update-progress.json：更新期间界面可见进度；残留过期收 null', async () => {
    const h = fakeHome()
    try {
      const rt = await mkRt()
      await writeUpdateProgress('downloading', 300, 1000)
      const s = await getUpdateStatus(rt)
      expect(s.progress).toMatchObject({ stage: 'downloading', received: 300, total: 1000, percent: 30 })
      // at 拨回 11 分钟前：上次更新的残留文件，载荷不携带
      const raw = JSON.parse(fs.readFileSync(updateProgressPath(), 'utf8'))
      raw.at = Date.now() - 11 * 60_000
      fs.writeFileSync(updateProgressPath(), JSON.stringify(raw))
      expect((await getUpdateStatus(rt)).progress).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('applyUpdate 守卫与幂等：无新版不 spawn；有新版 spawner 注入 + 日志路径；updating 后拒绝二次', async () => {
    const h = fakeHome()
    try {
      const rt = await mkRt()
      const argv = updateDaemonArgs()
      expect(applyUpdate(rt, { argv }).started).toBe(false)

      const spawned: { argv: string[]; logFile: string }[] = []
      const r = applyUpdate(rt, { argv, latest: '999.0.0', spawner: (a, logFile) => spawned.push({ argv: a, logFile }) })
      expect(r.started).toBe(true)
      expect(r.latest).toBe('999.0.0')
      expect(spawned).toHaveLength(1)
      expect(spawned[0].argv.slice(-2)).toEqual(['update', '--yes'])
      expect(spawned[0].logFile).toContain(path.join('logs', 'update-'))

      const r2 = applyUpdate(rt, { argv, latest: '999.0.0', spawner: () => spawned.push({ argv: [], logFile: '' }) })
      expect(r2.started).toBe(false)
      expect(r2.reason).toBe('in_progress')
      expect(spawned).toHaveLength(1)
    } finally {
      h.restore()
    }
  })

  it('applyUpdate 门闩后的同步失败复位 updating 并返回 failed——不再永久卡 in_progress', async () => {
    const h = fakeHome()
    try {
      const rt = await mkRt()
      const argv = updateDaemonArgs()
      // 失败注入：logsDir() 路径被普通文件占用 → mkdirSync(recursive) 抛 EEXIST（三平台一致），
      // 不用 mock fs 就能命中门闩之后的第一个同步失败点
      fs.mkdirSync(modeldockDir(), { recursive: true })
      fs.writeFileSync(logsDir(), 'not a directory')
      const r = applyUpdate(rt, {
        argv,
        latest: '999.0.0',
        spawner: () => {
          throw new Error('should not reach spawner when mkdir failed')
        },
      })
      expect(r).toEqual({ started: false, reason: 'failed' })
      expect((await getUpdateStatus(rt)).applyError).toBeTruthy()
      // 复位后可重试：移除占位文件，同一 rt 再试成功（证明 updating 没有永久卡死）
      fs.rmSync(logsDir())
      const spawned: string[][] = []
      const r2 = applyUpdate(rt, { argv, latest: '999.0.0', spawner: (a, lf) => spawned.push(a) || void lf })
      expect(r2.started).toBe(true)
      expect(spawned).toHaveLength(1)
    } finally {
      h.restore()
    }
  })

  it('watchApplyChild：子进程退出而网关未重启 → 从日志尾提取失败原因、复位 updating', async () => {
    const h = fakeHome()
    try {
      const rt = await mkRt()
      const argv = updateDaemonArgs()
      const logFile = path.join(os.tmpdir(), `watch-apply-test-${Date.now()}.log`)
      fs.writeFileSync(logFile, 'step1 ok\n✗ 当前是开发态（tsx 直跑源码），不支持自更新\n')
      applyUpdate(rt, { argv, latest: '999.0.0', spawner: () => {} })
      const child = new EventEmitter()
      watchApplyChild(child, logFile, { delayMs: 10 })
      child.emit('exit', 1)
      await new Promise((r) => setTimeout(r, 80))
      const s = await getUpdateStatus(rt)
      expect(s.applyError).toBe('当前是开发态（tsx 直跑源码），不支持自更新')
      // 失败后复位 updating：用户可以直接重试
      const r2 = applyUpdate(rt, { argv, latest: '999.0.0', spawner: () => {} })
      expect(r2.started).toBe(true)
      expect((await getUpdateStatus(rt)).applyError).toBeNull() // 新 apply 清空旧失败
      fs.rmSync(logFile, { force: true })
    } finally {
      h.restore()
    }
  })

  it('watchApplyChild：子进程 spawn 失败只发 error（不发 exit）→ 立即按失败收尾、updating 复位可重试', async () => {
    const h = fakeHome()
    try {
      const rt = await mkRt()
      const argv = updateDaemonArgs()
      const logFile = path.join(os.tmpdir(), `watch-apply-error-${Date.now()}.log`)
      fs.writeFileSync(logFile, '✗ spawn failed\n')
      applyUpdate(rt, { argv, latest: '999.0.0', spawner: () => {} })
      const child = new EventEmitter()
      watchApplyChild(child, logFile, { delayMs: 10 })
      child.emit('error', new Error('ENOENT')) // Node 不保证跟随 exit；error 应立即失败
      const s = await getUpdateStatus(rt)
      expect(s.applyError).toBe('spawn failed')
      // 未卡 in_progress：失败后 updating 复位，可直接重试
      const r2 = applyUpdate(rt, { argv, latest: '999.0.0', spawner: () => {} })
      expect(r2.started).toBe(true)
      fs.rmSync(logFile, { force: true })
    } finally {
      h.restore()
    }
  })

  it('watchApplyChild：先 error 后 exit 不双触发（settled 防重入，失败只收尾一次）', async () => {
    const h = fakeHome()
    try {
      const rt = await mkRt()
      const argv = updateDaemonArgs()
      const logFile = path.join(os.tmpdir(), `watch-apply-double-${Date.now()}.log`)
      fs.writeFileSync(logFile, '✗ spawn failed\n')
      applyUpdate(rt, { argv, latest: '999.0.0', spawner: () => {} })
      const child = new EventEmitter()
      watchApplyChild(child, logFile, { delayMs: 10 })
      child.emit('error', new Error('EACCES'))
      child.emit('exit', 1) // 迟到的 exit 不应再次触发失败收尾
      await new Promise((r) => setTimeout(r, 80))
      const s = await getUpdateStatus(rt)
      expect(s.applyError).toBe('spawn failed')
      const r2 = applyUpdate(rt, { argv, latest: '999.0.0', spawner: () => {} }) // 仍可重试，说明 updating 只被复位一次且干净
      expect(r2.started).toBe(true)
      fs.rmSync(logFile, { force: true })
    } finally {
      h.restore()
    }
  })

  it('kickUpdateCheck：并发同步两次调用（不 await 首次）底层拉取只执行一次（inflight 在任何 await 前同步占位）', async () => {
    const h = fakeHome()
    try {
      const rt = await mkRt({ update: { repo: REPO } }) // 无 token_ref，跳过 getSecret
      let fetches = 0
      setUpdateFetchForTests(async (_repo, _token, _apiBase): Promise<ReleaseManifest> => {
        fetches++
        await new Promise((r) => setTimeout(r, 20))
        return { version: '999.0.0', tagName: 'v999.0.0', notes: '', htmlUrl: 'https://github.com/owner/repo', assets: [] }
      })
      const p1 = kickUpdateCheck(rt, { force: true })
      const p2 = kickUpdateCheck(rt, { force: true }) // 不 await p1 的同步并发——修前两路都穿透、双拉
      await Promise.all([p1, p2])
      expect(fetches).toBe(1)
      expect((await getUpdateStatus(rt)).latest).toBe('999.0.0')
    } finally {
      h.restore()
    }
  })

  it('applyUpdate：latest 不高于当前版本 → no_update 且绝不 spawn', async () => {
    const h = fakeHome()
    try {
      const rt = await mkRt()
      const r = applyUpdate(rt, { argv: updateDaemonArgs(), latest: VERSION, spawner: () => { throw new Error('must not spawn') } })
      expect(r.started).toBe(false)
      expect(r.reason).toBe('no_update')
    } finally {
      h.restore()
    }
  })
})

describe('server 更新端点（admin 门内）', () => {
  it('未鉴权 401；鉴权后 status/apply/check 响应正确；apply 无新版不 spawn', async () => {
    resetUpdateStateForTests() // 服务用例的 manifest/updating 残留会让 apply 误判（模块级状态）
    const h = fakeHome()
    // 匿名检查不再被令牌门槛挡下：check 端点会真发请求，须挂本地 mock；
    // tag 用旧版本——manifest 不抬成可更新，apply 才走 no_update 路径（绝不 spawn 真更新器）
    const api = await startMockApi('v0.9.9')
    setUpdateApiBaseForTests(api.apiBase)
    let closeAll: (() => void) | null = null
    try {
      const cfg: Config = { ...emptyConfig(), security: { store: 'file' }, update: { repo: REPO } }
      await saveConfig(cfg)
      const rt = buildRuntime(cfg, 'mdkadm_admin')
      const server = createGatewayServer(rt, { port: 0 })
      const port = await listenEphemeral(server)
      closeAll = () => { server.closeAllConnections?.(); server.close() }
      const base = `http://127.0.0.1:${port}`
      const auth = { 'x-modeldock-admin': 'mdkadm_admin' }

      const noAuth = await fetch(`${base}/_modeldock/admin/update/status`)
      expect(noAuth.status).toBe(401)

      const status = await fetch(`${base}/_modeldock/admin/update/status`, { headers: auth })
      expect(status.status).toBe(200)
      const sj = (await status.json()) as { current: string; available: boolean; configured: boolean; notes: string | null; htmlUrl: string | null }
      expect(sj.current).toBe(VERSION)
      expect(sj.available).toBe(false)
      expect(sj.configured).toBe(false) // 无 token_ref
      expect(sj.notes).toBeNull()
      expect(sj.htmlUrl).toBeNull()

      const apply = await fetch(`${base}/_modeldock/admin/update/apply`, { method: 'POST', headers: auth })
      expect(apply.status).toBe(200)
      const aj = (await apply.json()) as { ok: boolean; reason?: string }
      expect(aj.ok).toBe(false)
      expect(aj.reason).toBe('no_update')

      const check = await fetch(`${base}/_modeldock/admin/update/check`, { method: 'POST', headers: auth })
      expect(check.status).toBe(200)
      expect(((await check.json()) as { ok: boolean }).ok).toBe(true)
      // 排空 POST check 背后的 fire-and-forget kick：其完成态（checking 收口）若跨用例漂移，
      // 会改写下一个用例窗口内的守卫态（本文件「force 撞在飞」组曾踩）。终态判据：checking=false
      // 且 lastCheckedAt 已落（v0.9.9 检查成功）
      for (let i = 0; i < 100; i++) {
        const s = await getUpdateStatus(rt)
        if (!s.checking && s.lastCheckedAt != null) break
        await new Promise((r) => setTimeout(r, 20))
      }
    } finally {
      setUpdateApiBaseForTests(null)
      closeAll?.()
      await api.close()
      await h.restore()
    }
  })
})

describe('预取与 force 升级语义（v1.8 预取）', () => {
  let cleanup: (() => Promise<void>) | null = null
  beforeEach(() => {
    resetUpdateStateForTests()
    resetPrefetchStateForTests()
    setUpdateApiBaseForTests(null)
  })
  afterEach(async () => {
    setUpdateApiBaseForTests(null)
    setUpdateFetchForTests(null)
    setPrefetchExecPathForTests(null)
    await cleanup?.()
    cleanup = null
  })

  function manifestOf(tag: string): ReleaseManifest {
    return { version: tag.replace(/^v/, ''), tagName: tag, notes: 'n', htmlUrl: '', assets: [] }
  }

  // 预取集成用例的资产名：必须与 selectAssetName(安装形态) 精确一致，mock 才能被 findAsset 命中
  const PF_EXEC = '/usr/local/bin/modeldock'
  const PF_SHAPE = detectInstallShape(PF_EXEC, process.platform, process.env.LOCALAPPDATA, false)
  const PF_ASSET = selectAssetName(PF_SHAPE, process.platform, process.arch, '999.0.0')!
  const PF_ASSET_BODY = Buffer.from('PREFETCH-KICK-BODY')

  it('force 撞在飞真查：被该次检查满足（底层只查一次，不重复拉）', async () => {
    const h = fakeHome()
    try {
      await setSecret('update-token', TOKEN, 'file')
      const rt = await mkRt()
      let calls = 0
      let release: (m: ReleaseManifest) => void = () => {}
      let started: () => void = () => {}
      const startedP = new Promise<void>((r) => {
        started = r
      })
      setUpdateFetchForTests(async () => {
        calls++
        return new Promise<ReleaseManifest>((resolve) => {
          started() // fetch 真被调用（deferred 已建）才放行下一步——getSecret/代理探测是宏任务
          release = resolve
        })
      })
      // 哑 apiBase：fetchOverride 拦截在网络之前，且跳过跨用例共享的 sysproxy 解析缓存（全序跑下曾挂）
      setUpdateApiBaseForTests('http://127.0.0.1:9')
      // 在飞 kick 用 force 起手（越过守卫直挂 deferred）；fire-and-forget kick 的跨用例尾流（server
      // 端点用例的 void check）可能在本用例窗口内改写守卫态，force 起手对本用例语义无损且免疫
      resetUpdateStateForTests()
      const first = kickUpdateCheck(rt, { force: true }) // 在飞真查（挂在 deferred 上）
      await startedP
      await kickUpdateCheck(rt, { force: true }) // 撞在飞：排队升级，立即返回
      release(manifestOf('v999.0.0'))
      await first
      await new Promise((r) => setTimeout(r, 10)) // 给可能的重查留出暴露窗口
      expect(calls).toBe(1) // force 被刚完成的真查满足，不再二次拉
      expect((await getUpdateStatus(rt)).latest).toBe('999.0.0')
    } finally {
      h.restore()
    }
  })

  it('force 撞在飞 TTL-skip：升级为真查，绝不带旧缓存收场', async () => {
    const h = fakeHome()
    try {
      await setSecret('update-token', TOKEN, 'file')
      const rt = await mkRt()
      let calls = 0
      let release: (m: ReleaseManifest) => void = () => {}
      let started: () => void = () => {}
      setUpdateFetchForTests(async () => {
        calls++
        if (calls === 1) return manifestOf('v999.0.0') // 第一查立即放行，建立 24h TTL 窗口
        return new Promise<ReleaseManifest>((resolve) => {
          started()
          release = resolve
        })
      })
      // 哑 apiBase（fetchOverride 拦截在网络之前）：与上方用例同口径，绕开跨用例 sysproxy 缓存
      setUpdateApiBaseForTests('http://127.0.0.1:9')
      await kickUpdateCheck(rt, { force: true })
      expect(calls).toBe(1)
      // 第二查（非 force）：在飞，将命中 TTL 守卫；此刻 force 进来必须把它升级成真查
      const startedP = new Promise<void>((r) => {
        started = r
      })
      const second = kickUpdateCheck(rt)
      await kickUpdateCheck(rt, { force: true }) // 同一宏任务内升级：早于 kickA 的守卫求值
      await startedP // fetch#2 已被调用
      release(manifestOf('v888.0.0'))
      await second
      expect(calls).toBe(2) // TTL-skip 被升级为真查
      expect((await getUpdateStatus(rt)).latest).toBe('888.0.0')
    } finally {
      h.restore()
    }
  })

  it('manifest 全量持久化进 gateway.json；restoreUpdateCheckState 恢复 latest/时间戳（重启后不空窗）', async () => {
    const h = fakeHome()
    try {
      await setSecret('update-token', TOKEN, 'file')
      const rt = await mkRt()
      // persistCheckTime 只在既有 gateway.json 上合并写（无文件返回 null 不新建）——预置一份
      await writeGatewayState({ pid: process.pid, port: 18999, admin_token: 'x', started_at: 't' })
      setUpdateFetchForTests(async () => manifestOf('v999.0.0'))
      await kickUpdateCheck(rt, { force: true })
      const state = await readGatewayState()
      expect(state?.update_check?.manifest).toMatchObject({ version: '999.0.0', tagName: 'v999.0.0' })
      expect(state?.update_check?.manifest?.assets).toEqual([])
      // 模拟重启：内存清空 → restore → latest/时间戳/全量 manifest 全回来
      resetUpdateStateForTests()
      await restoreUpdateCheckState()
      const s = await getUpdateStatus(rt)
      expect(s.latest).toBe('999.0.0')
      expect(s.available).toBe(true)
      expect(s.lastCheckedAt).not.toBeNull()
    } finally {
      h.restore()
    }
  })

  it('status 载荷透传 staged：ready/consumed 语义正确', async () => {
    const h = fakeHome()
    try {
      await setSecret('update-token', TOKEN, 'file')
      const rt = await mkRt()
      expect((await getUpdateStatus(rt)).staged).toBeNull()
      await saveStagingMeta({
        version: '999.0.0',
        tagName: 'v999.0.0',
        assetName: 'modeldock-999.0.0-darwin-arm64.tar.gz',
        assetId: 1,
        size: 10,
        etag: null,
        url: null,
        received: 10,
        sumsVerified: true,
        ready: true,
        consumed: false,
        error: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      })
      expect((await getUpdateStatus(rt)).staged).toMatchObject({ version: '999.0.0', ready: true, received: 10, total: 10 })
      await markStagingConsumed('999.0.0')
      expect((await getUpdateStatus(rt)).staged).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('kick 成功且 available 自动驱动预取（集成）：staged ready；prefetch=false 关闭', async () => {
    const h = fakeHome()
    const api = await startMockApi('v999.0.0', {
      asset: { name: PF_ASSET, body: PF_ASSET_BODY, sums: Buffer.from(`${crypto.createHash('sha256').update(PF_ASSET_BODY).digest('hex')}  ${PF_ASSET}\n`) },
    })
    cleanup = api.close
    setUpdateApiBaseForTests(api.apiBase)
    setPrefetchExecPathForTests('/usr/local/bin/modeldock')
    try {
      await setSecret('update-token', TOKEN, 'file')
      const rt = await mkRt()
      await kickUpdateCheck(rt, { force: true })
      // 预取在飞/收敛（fire-and-forget：轮询 inflight）
      for (let i = 0; i < 400 && !prefetchInflightForTests(); i++) await new Promise((r) => setTimeout(r, 5))
      const p = prefetchInflightForTests()
      if (p) await p
      expect((await getUpdateStatus(rt)).staged).toMatchObject({ version: '999.0.0', ready: true })
      // prefetch=false：换新槽位也不预取（staged 保持 null——consumed 后清账本）
      const rtOff = await mkRt({ update: { repo: REPO, token_ref: 'file:update-token', prefetch: false } })
      resetUpdateStateForTests()
      resetPrefetchStateForTests()
      await saveStagingMeta({
        version: '888.0.0',
        tagName: 'v888.0.0',
        assetName: 'old.tar.gz',
        assetId: 9,
        size: 1,
        etag: null,
        url: null,
        received: 0,
        sumsVerified: false,
        ready: false,
        consumed: false,
        error: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      })
      await kickUpdateCheck(rtOff, { force: true })
      await new Promise((r) => setTimeout(r, 20))
      // 预取被关：旧槽位没被换掉、也没发起下载
      expect((await readStagingMeta())?.version).toBe('888.0.0')
    } finally {
      h.restore()
    }
  })

  it('重启恢复后 drivePrefetchFromState 补/续预取：半成品槽位跨重启收敛到 ready', async () => {
    const h = fakeHome()
    const assetBody = Buffer.from('PREFETCH-RESTART-BODY')
    const sums = Buffer.from(`${crypto.createHash('sha256').update(assetBody).digest('hex')}  ${PF_ASSET}\n`)
    const api = await startMockApi('v999.0.0', { asset: { name: PF_ASSET, body: assetBody, sums } })
    cleanup = api.close
    setUpdateApiBaseForTests(api.apiBase)
    setPrefetchExecPathForTests('/usr/local/bin/modeldock')
    try {
      await setSecret('update-token', TOKEN, 'file')
      const rt = await mkRt()
      // persistCheckTime 只在既有 gateway.json 上合并写——预置一份
      await writeGatewayState({ pid: process.pid, port: 18999, admin_token: 'x', started_at: 't' })
      // 第一次检查：持久化 manifest 全量（含 assets）
      await kickUpdateCheck(rt, { force: true })
      // 模拟重启：内存清空 → 从 gateway.json 恢复 → 预置半成品槽位（断点续传起点）
      resetUpdateStateForTests()
      await restoreUpdateCheckState()
      await saveStagingMeta({
        version: '999.0.0',
        tagName: 'v999.0.0',
        assetName: PF_ASSET,
        assetId: 1,
        size: assetBody.length,
        etag: null,
        url: null,
        received: 0,
        sumsVerified: false,
        ready: false,
        consumed: false,
        error: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      })
      drivePrefetchFromState(rt)
      for (let i = 0; i < 400 && !prefetchInflightForTests(); i++) await new Promise((r) => setTimeout(r, 5))
      const p = prefetchInflightForTests()
      if (p) await p
      const st = await getUpdateStatus(rt)
      expect(st.available).toBe(true) // 恢复的 manifest 让徽标不空窗
      expect(st.staged).toMatchObject({ version: '999.0.0', ready: true, received: assetBody.length })
    } finally {
      h.restore()
    }
  })
})

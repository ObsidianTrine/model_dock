import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { saveConfig } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { setSecret } from '../src/config/secrets.js'
import { buildRuntime, readGatewayState, writeGatewayState, type GatewayRuntime } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { VERSION } from '../src/version.js'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import {
  applyUpdate,
  getUpdateStatus,
  kickUpdateCheck,
  resetUpdateStateForTests,
  setUpdateApiBaseForTests,
  watchApplyChild,
} from '../src/update/webupdate.js'
import { updateDaemonArgs } from '../src/autostart.js'

const TOKEN = 'ghp_test-token'
const REPO = 'owner/repo'

// 本地伪造 GitHub releases/latest（仅检查链路；apply 不真 spawn，spawner 注入）
function startMockApi(tag: string, opts: { htmlUrl?: string | null } = {}): Promise<{ apiBase: string; close: () => Promise<void> }> {
  const htmlUrl = opts.htmlUrl === undefined ? `https://github.com/${REPO}/releases/tag/${tag}` : opts.htmlUrl
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === `/repos/${REPO}/releases/latest`) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            tag_name: tag,
            body: '**更新说明摘要**：一条改动\n\n### 新增\n\n- **点题**：细节',
            html_url: htmlUrl === null ? undefined : htmlUrl, // null = 发布里没有 html_url（自建镜像常见）
            assets: [],
          })
        )
        return
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

describe('更新服务：检查 / 状态 / 应用（mock API + fakeHome）', () => {
  let cleanup: (() => Promise<void>) | null = null
  beforeEach(() => {
    resetUpdateStateForTests()
    setUpdateApiBaseForTests(null)
  })
  afterEach(async () => {
    setUpdateApiBaseForTests(null)
    await cleanup?.()
    cleanup = null
  })

  it('无令牌：kick 静默跳过，status 报 configured=false', async () => {
    const h = fakeHome()
    try {
      const rt = await mkRt({ update: {} })
      await kickUpdateCheck(rt, { force: true })
      const s = await getUpdateStatus(rt)
      expect(s.configured).toBe(false)
      expect(s.lastCheckedAt).toBeNull()
      expect(s.available).toBe(false)
      expect(s.notes).toBeNull()
      expect(s.htmlUrl).toBeNull()
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
    } finally {
      closeAll?.()
      await h.restore()
    }
  })
})

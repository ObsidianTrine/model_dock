import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import { buildRuntime } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import type { Config } from '../src/config/types.js'
import { saveConfig, mutateConfig } from '../src/config/store.js'
import { resetUiPresence } from '../src/gateway/presence.js'
import { parse as tomlParse } from 'smol-toml'
import { configPath } from '../src/util/paths.js'

// 本文件只碰 tray-state / tray-lite / ui-presence / switch / service-update / attach（无转发、无定时窗口），
// 但 overview 重建会读日历缓存与模型目录兜底：与 gateway.test.ts 同口径禁用出站请求。
process.env.MODELRDOCK_DISABLE_HOLIDAY_FETCH = '1'
process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

const ADMIN = { 'x-modeldock-admin': 'admin-token-x' }

// 客户端「已安装」判定有环境变量注入点（MODELRDOCK_FAKE_<ID>_PRESENT，presence.ts fakePresence）：
// 开发机 PATH 上真装着 codex/dsh 等，会把它们混进 clients 列表——除被测客户端外一律强制「未安装」，
// 用例内需要在场再置 '1'（首测 claude-code）。与 gateway.test.ts 的桌面 presence 隔离同口径。
const ADAPTER_IDS = ['claude-code', 'zcode', 'dsh', 'codex', 'opencode', 'mimo-code', 'mimo-desktop', 'workbuddy']
const presenceKey = (id: string): string => `MODELRDOCK_FAKE_${id.toUpperCase().replace(/-/g, '_')}_PRESENT`
beforeEach(() => {
  // presence（轻量模式在场）是跨文件共享的模块态：本文件断言它，先复位再跑
  resetUiPresence()
  for (const id of ADAPTER_IDS) process.env[presenceKey(id)] = '0'
})
afterEach(() => {
  for (const id of ADAPTER_IDS) delete process.env[presenceKey(id)]
})

async function setup(): Promise<{ gwPort: string; home: string; closeAll: () => void }> {
  const h = fakeHome()
  const cfg: Config = {
    version: 1,
    active_profile: 'demo',
    security: { store: 'file' }, // 固定 file 存储，避免受系统默认(keychain)影响
    providers: {
      up: {
        name: 'mock',
        base_url: 'http://127.0.0.1:9',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'sk-up',
        models: { 'preset-model': { source: 'preset' } },
      },
      alt: {
        name: 'alt-svc',
        base_url: 'http://127.0.0.1:9',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'sk-alt',
        models: { 'alt-a': { source: 'preset' }, 'alt-b': { source: 'preset' } },
      },
    },
    profiles: { demo: { provider: 'up', default_model: 'preset-model' } },
    harness: {},
  }
  await saveConfig(cfg)
  const rt = buildRuntime(cfg, 'admin-token-x')
  const server = createGatewayServer(rt, { port: 0 })
  const gwPort = String(await listenEphemeral(server))
  return {
    gwPort,
    home: h.home,
    closeAll: () => {
      server.closeAllConnections?.()
      server.close()
      h.restore()
    },
  }
}

describe('GET /_modeldock/tray-state（托盘状态数据源 + 轻量模式派生态）', () => {
  it('未鉴权 401；瘦身载荷：无 UI 打开时 trayLite 为真、services 带模型目录与 defaultModel、clients 只含已安装客户端', async () => {
    const t = await setup()
    // claude-code 需要命令在 PATH 才算已安装：测试注入 presence（gateway.test.ts 的桌面客户端同款机制）
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
    try {
      const base = `http://127.0.0.1:${t.gwPort}/_modeldock`
      expect((await fetch(base + '/tray-state')).status).toBe(401)

      // 先真实接入一次 claude-code（走控制台同款 attach/apply），clients 才有行
      const att = await fetch(base + '/attach/apply', {
        method: 'POST',
        headers: { ...ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({ harness: 'claude-code' }),
      })
      expect(att.status).toBe(200)

      const res = await fetch(base + '/tray-state', { headers: ADMIN })
      expect(res.status).toBe(200)
      const j: any = await res.json()
      expect(j.ok).toBe(true)
      expect(j.trayLite).toBe(true) // 测试无 UI 打开 → 派生轻量模式为真
      expect(j.current).toEqual({ id: 'up', label: 'mock', model: 'preset-model' })
      expect(j.autoPin).toBeNull()
      expect(j.scheduleApplied).toBe(false)
      expect(j.services).toHaveLength(2)
      const up = j.services.find((s: any) => s.id === 'up')
      expect(up).toMatchObject({ id: 'up', label: 'mock', inUse: true, enabled: true, down: false, defaultModel: 'preset-model' })
      expect(up.models).toEqual([{ id: 'preset-model', display: null }])
      const cc = j.clients.find((c: any) => c.id === 'claude-code')
      expect(cc).toMatchObject({
        id: 'claude-code',
        attached: true,
        mode: 'gateway',
        route: null, // route: 'default'（跟随全局）投影为 null
        followsActive: true,
        service: 'mock',
        pinnedProvider: null,
      })
      // 未安装的客户端不出现：zcode presence 强制 0 → 不得出现；mimo-code/generic-env 的
      // installed 判定依赖宿主机文件（generic-env 恒已安装），不做全列表相等断言
      expect(j.clients.some((c: any) => c.id === 'zcode')).toBe(false)
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      t.closeAll()
    }
  })

  it('轻量模式闭环：/ui 打开即退出并撤销广播、/tray-lite 广播可感知、ui-presence 心跳与离场、旧 /tray-only 404、残留 tray_lite 键读入剥除', async () => {
    const t = await setup()
    try {
      const base = `http://127.0.0.1:${t.gwPort}/_modeldock`
      const post = (p: string, body: unknown) =>
        fetch(base + p, {
          method: 'POST',
          headers: { ...ADMIN, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      const getState = async () => (await (await fetch(base + '/tray-state', { headers: ADMIN })).json()) as any
      const getOverview = async () => (await (await fetch(base + '/overview', { headers: ADMIN })).json()) as any

      // 初始：无任何 UI 打开 → 派生轻量模式为真
      expect((await getState()).trayLite).toBe(true)

      // 无凭据的 /ui 请求（本机程序探测/预取）不算「UI 打开」：不退出轻量模式（2026-10 复审收窄）
      expect((await fetch(base + '/ui')).status).toBe(200)
      expect((await getState()).trayLite).toBe(true)

      // 打开控制台页面（托盘开控制台 / 双击 app / 浏览器，?token= 登录后带 cookie/头重取，
      // 同走 GET /_modeldock/ui）→ 自动退出轻量模式
      expect((await fetch(base + '/ui', { headers: ADMIN })).status).toBe(200)
      expect((await getState()).trayLite).toBe(false)

      // 托盘点「轻量模式」→ 广播关闭请求；页面还开着（在场未过期）→ trayLite 仍 false，
      // overview 携带请求时间戳供页面感知（缓存已随 /tray-lite 失效，读到的是新值）
      const req = await post('/tray-lite', {})
      expect(req.status).toBe(200)
      expect(((await req.json()) as any).trayLite).toBe(false)
      const ov1: any = await getOverview()
      expect(ov1.gateway.trayLite).toBe(false)
      expect(ov1.gateway.trayLiteRequest).toBeGreaterThan(0)

      // 页面心跳续场；离场信标（pagehide sendBeacon 同款）→ 即刻回到轻量模式
      expect((await post('/ui-presence', {})).status).toBe(200)
      expect((await getState()).trayLite).toBe(false)
      expect((await post('/ui-presence', { leaving: true })).status).toBe(200)
      expect((await getState()).trayLite).toBe(true)
      // 广播字段不随在场过期清零（多页同开时慢页不漏收），由页面按「新于上次所见」去重
      expect((await getOverview()).gateway.trayLiteRequest).toBeGreaterThan(0)

      // 新页面加载：自动退出轻量模式 + 清广播 + overview 缓存同步失效（首拉不得拿到旧广播，防误自关）
      expect((await fetch(base + '/ui', { headers: ADMIN })).status).toBe(200)
      expect((await getState()).trayLite).toBe(false)
      expect((await getOverview()).gateway.trayLiteRequest).toBe(0)

      // 旧「仅托盘模式」端点已移除（v1.4.0 曾用名）
      expect((await post('/tray-only', { enabled: true })).status).toBe(404)

      // 残留 tray_lite 键：读入即剥除，任一次配置写盘都以剥除后的形态整包重写，不再落回盘
      await mutateConfig((cfg) => {
        cfg.gateway = { ...(cfg.gateway ?? {}), tray_lite: false } as typeof cfg.gateway
      })
      expect((tomlParse(fs.readFileSync(configPath(), 'utf8')) as any).gateway.tray_lite).toBe(false)
      await mutateConfig(() => {})
      expect((tomlParse(fs.readFileSync(configPath(), 'utf8')) as any).gateway.tray_lite).toBeUndefined()
    } finally {
      t.closeAll()
    }
  })

  it('tray-state 跟随 switch / service-update：current、autoPin、inUse、defaultModel 即时反映', async () => {
    const t = await setup()
    try {
      const base = `http://127.0.0.1:${t.gwPort}/_modeldock`
      const post = (p: string, body: unknown) =>
        fetch(base + p, {
          method: 'POST',
          headers: { ...ADMIN, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })

      // 切到 alt 服务（hSwitch 链路：active_profile + auto_route_provider 钉定一次落盘）
      expect((await post('/switch', { service: 'alt' })).status).toBe(200)
      let j: any = await (await fetch(base + '/tray-state', { headers: ADMIN })).json()
      expect(j.current.id).toBe('alt')
      expect(j.autoPin).toBe('alt')
      const alt = j.services.find((s: any) => s.id === 'alt')
      expect(alt.inUse).toBe(true)
      expect(alt.defaultModel).toBe('alt-a') // switchToService 自动建 profile 取目录首个模型

      // 默认模型改到 alt-b（hServiceUpdate 链路；烤模型同步对本 fixture 无烘焙客户端为空操作）
      expect((await post('/service/update', { provider: 'alt', default_model: 'alt-b' })).status).toBe(200)
      j = await (await fetch(base + '/tray-state', { headers: ADMIN })).json()
      expect(j.services.find((s: any) => s.id === 'alt').defaultModel).toBe('alt-b')

      // 清钉定回「自动选路」：current 回到默认路由的 up，autoPin 清空
      expect((await post('/auto-route', { provider: null })).status).toBe(200)
      j = await (await fetch(base + '/tray-state', { headers: ADMIN })).json()
      expect(j.autoPin).toBeNull()
      expect(j.current.id).toBe('alt') // active_profile 已是 auto-alt，默认路由跟随
    } finally {
      t.closeAll()
    }
  })

  it('托盘请求（x-modeldock-source: tray）的审计来源记为 tray', async () => {
    const t = await setup()
    try {
      const base = `http://127.0.0.1:${t.gwPort}/_modeldock`
      const res = await fetch(base + '/switch', {
        method: 'POST',
        headers: { ...ADMIN, 'content-type': 'application/json', 'x-modeldock-source': 'tray' },
        body: JSON.stringify({ service: 'alt' }),
      })
      expect(res.status).toBe(200)
      const logs: any = await (await fetch(base + '/logs?n=50', { headers: ADMIN })).json()
      const audits = logs.logs.filter((l: any) => l.kind === 'audit')
      const last = audits[audits.length - 1]
      expect(last.op).toBe('切换服务')
      expect(last.source).toBe('tray')
      // 对照：不带来源头的 admin 请求仍记 token
      await fetch(base + '/reload', { method: 'POST', headers: ADMIN })
      const logs2: any = await (await fetch(base + '/logs?n=50', { headers: ADMIN })).json()
      const audits2 = logs2.logs.filter((l: any) => l.kind === 'audit')
      expect(audits2[audits2.length - 1].source).toBe('token')
    } finally {
      t.closeAll()
    }
  })
})

import { describe, expect, it, afterEach, vi } from 'vitest'
import http from 'node:http'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { buildRuntime, reloadRuntime, type GatewayRuntime } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { createSyncOffer, startLanServer, stopLan } from '../src/gateway/lan.js'
import { discoverPeers } from '../src/gateway/discover.js'
import { getSecret, makeKeyRef, setSecret } from '../src/config/secrets.js'
import { openEnvelope } from '../src/sync/crypto.js'
import { validateSyncdoc } from '../src/sync/types.js'
import type { Config } from '../src/config/types.js'

// 本文件先于 gateway.test.ts 加载 server.js 时（vitest isolate:false 共享模块注册表），
// 必须同样 mock autostart——否则 gateway.test.ts 后挂的 mock 绑不回已实例化的 server.js
// 静态绑定，其 autostart 用例会走到真实 launchctl（10s 超时失败）。mock 形状与 gateway.test.ts 一致。
vi.mock('../src/autostart.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/autostart.js')>()
  let installed = false
  return {
    ...original,
    autostartOverview: () => ({ installed, kind: 'launchd' as const }),
    installAutostart: async () => {
      installed = true
      return { kind: 'launchd' as const, file: '/fake/com.modeldock.gateway.plist', argv: ['modeldock', '--sea-gateway'], started: false }
    },
    uninstallAutostart: async () => {
      const was = installed
      installed = false
      return { removed: '/fake/com.modeldock.gateway.plist', wasInstalled: was }
    },
  }
})

const osHostname = (): string => os.hostname()

process.env.MODELRDOCK_DISABLE_HOLIDAY_FETCH = '1'
process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'

const LAN_TOKEN = 'mdklan_' + 'c'.repeat(32)
const ADMIN_A = 'mdkadm_pull_a'
const ADMIN_B = 'mdkadm_pull_b'

// 双 fakeHome 双网关（A=分享机，B=拉取机）同进程端到端：严格串行（A 完成后才切 env 到 B），
// 收尾逆序 restore（与 test/lansync.test.ts 同口径）。

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn()
    } catch {
      /* 收尾互不拖累 */
    }
  }
  cleanups.length = 0
  vi.useRealTimers()
})

function useHome(): string {
  const h = fakeHome()
  cleanups.push(h.restore)
  return h.home
}

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

async function seedShareMachine(): Promise<void> {
  await setSecret('ark', 'sk-ark-pull-plaintext', 'file')
  await saveConfig({
    version: 1,
    active_profile: 'main',
    providers: {
      ark: { name: '方舟', base_url: 'https://ark.example.com/api', protocol: 'anthropic', auth_style: 'bearer', key_ref: makeKeyRef('file', 'ark') },
      envprov: { base_url: 'https://env.example.com/v1', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:ARK_KEY' },
    },
    profiles: { main: { provider: 'ark', default_model: 'auto' } },
    harness: { 'claude-code': { mode: 'gateway', attached_at: '2026-01-01T00:00:00.000Z' } },
  })
}

/** A 机：8687 管理面（offer 端点）+ LAN 监听器（直拉端点），共享同一 rt */
async function startMachineA(): Promise<{ rt: GatewayRuntime; gwPort: number; lanPort: number }> {
  useHome()
  await seedShareMachine()
  const rt = buildRuntime(await loadConfig(), ADMIN_A)
  const lan = await startLanServer(rt, { port: 0, token: LAN_TOKEN, host: '127.0.0.1' })
  cleanups.push(() => stopLan(rt))
  const server = createGatewayServer(rt, { port: 0 })
  const gwPort = await listenEphemeral(server)
  cleanups.push(() => server.close())
  return { rt, gwPort, lanPort: lan.port, home: process.env.MODELRDOCK_FAKE_HOME ?? '' }
}

/** B 机：空配置（新机首启状态），只有 8687 管理面 */
async function startMachineB(): Promise<{ rt: GatewayRuntime; gwPort: number; home: string }> {
  useHome()
  // security.store=file：测试进程内避免 defaultStore() 写真实钥匙串（darwin）
  await saveConfig({ version: 1, security: { store: 'file' }, providers: {}, profiles: {}, harness: {} })
  const rt = buildRuntime(await loadConfig(), ADMIN_B)
  const server = createGatewayServer(rt, { port: 0 })
  const gwPort = await listenEphemeral(server)
  cleanups.push(() => server.close())
  return { rt, gwPort, home: process.env.MODELRDOCK_FAKE_HOME ?? '' }
}

describe('sync-lan-pull 同网直拉迁移', () => {
  it('offer：空配置与 LAN 未开启时 400 可操作报错；正常时 urls 带口令 fragment、信封可解开', async () => {
    useHome()
    await saveConfig({ version: 1, providers: {}, profiles: {}, harness: {} })
    const rt = buildRuntime(await loadConfig(), ADMIN_A)
    await startLanServer(rt, { port: 0, token: LAN_TOKEN, host: '127.0.0.1' })
    cleanups.push(() => stopLan(rt))

    // 空配置：无可导出
    await expect(createSyncOffer(rt)).rejects.toThrow(/没有可导出|nothing to export/i)

    // LAN 未开启（stopLan 清掉 rt.lan）
    stopLan(rt)
    await expect(createSyncOffer(rt)).rejects.toThrow(/手机远程未开启|Mobile console is off/)

    // 正常：填上配置、重启 LAN 监听
    await seedShareMachine()
    await reloadRuntime(rt)
    await startLanServer(rt, { port: 0, token: LAN_TOKEN, host: '127.0.0.1' })
    const offer = await createSyncOffer(rt)
    expect(offer.expiresIn).toBe(600)
    expect(offer.urls.length).toBeGreaterThanOrEqual(1)
    const u = new URL(offer.urls[0])
    expect(u.pathname).toBe('/m/sync/pull')
    expect(u.searchParams.get('t')).toMatch(/^[0-9a-f]{48}$/)
    const passphrase = decodeURIComponent(u.hash.slice(3))
    expect(passphrase).toBeTruthy()

    // 信封可用 fragment 口令解开（先拉取验证内容正确性）
    const res = await fetch(`http://127.0.0.1:${rt.lan!.port}/m/sync/pull?t=${u.searchParams.get('t')}`)
    expect(res.status).toBe(200)
    const env = JSON.parse(await res.text())
    const doc = validateSyncdoc(openEnvelope(env, passphrase))
    expect(Object.keys(doc.data.providers)).toContain('ark')
  })

  it('pull：正确 token 200 且取走即焚（二拉 404）、错 token 404、过期 410', async () => {
    useHome()
    await seedShareMachine()
    const rt = buildRuntime(await loadConfig(), ADMIN_A)
    await startLanServer(rt, { port: 0, token: LAN_TOKEN, host: '127.0.0.1' })
    cleanups.push(() => stopLan(rt))
    const base = `http://127.0.0.1:${rt.lan!.port}/m/sync/pull`

    // 无 offer / 错 token：404
    expect((await fetch(`${base}?t=${'f'.repeat(48)}`)).status).toBe(404)
    const offer = await createSyncOffer(rt)
    const t0 = new URL(offer.urls[0]).searchParams.get('t')
    expect((await fetch(`${base}?t=${'e'.repeat(48)}`)).status).toBe(404)

    // 正确 token：200（信封 JSON），取走即焚
    const ok = await fetch(`${base}?t=${t0}`)
    expect(ok.status).toBe(200)
    expect(JSON.parse(await ok.text())).toHaveProperty('fmt')
    expect((await fetch(`${base}?t=${t0}`)).status).toBe(404)

    // 过期：新建 offer 后只伪造时钟（不动定时器，fetch/undici 不受影响）
    const offer2 = await createSyncOffer(rt)
    const t1 = new URL(offer2.urls[0]).searchParams.get('t')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000)
      expect((await fetch(`${base}?t=${t1}`)).status).toBe(410)
    } finally {
      vi.useRealTimers()
    }
  })

  it('端到端：A 生成 offer → B 粘贴链接直拉预览 → 确认导入；票据单次；预览响应不含 key 明文', async () => {
    const a = await startMachineA()
    const offerRes = await fetch(`http://127.0.0.1:${a.gwPort}/_modeldock/sync/offer`, {
      method: 'POST',
      headers: { 'x-modeldock-admin': ADMIN_A },
    })
    expect(offerRes.status).toBe(200)
    const offer = (await offerRes.json()) as { ok: boolean; urls: string[]; expiresIn: number }
    expect(offer.ok).toBe(true)
    const u = new URL(offer.urls[0])
    const token = u.searchParams.get('t') as string
    const passphrase = decodeURIComponent(u.hash.slice(3))

    const b = await startMachineB()
    const bAdmin = { 'x-modeldock-admin': ADMIN_B, 'content-type': 'application/json' }
    // B 换 127.0.0.1 直拉（CI 上网卡 IP 不稳定；直拉语义与局域网 IP 同构）
    const pullUrl = `http://127.0.0.1:${a.lanPort}/m/sync/pull?t=${token}`

    const prev = await fetch(`http://127.0.0.1:${b.gwPort}/_modeldock/sync/import`, {
      method: 'POST',
      headers: bAdmin,
      body: JSON.stringify({ phase: 'preview', source: { kind: 'url', url: pullUrl, passphrase } }),
    })
    expect(prev.status).toBe(200)
    const pj = (await prev.json()) as {
      ok: boolean
      ticket: string
      report: { providers: string[]; profiles: string[]; presetCount: number; envKeyRefs: string[] }
      meta: { createdBy: string }
    }
    expect(pj.ok).toBe(true)
    expect(pj.report.providers.sort()).toEqual(['ark', 'envprov'])
    expect(pj.report.profiles).toEqual(['main'])
    expect(pj.report.envKeyRefs).toEqual(['envprov'])
    expect(pj.meta.createdBy).toBeTruthy()
    // 预览响应不回传 key 明文
    expect(JSON.stringify(pj)).not.toContain('sk-ark-pull-plaintext')

    // 确认导入：凭 ticket 应用（一次拉取一次 PBKDF2）
    const apply = await fetch(`http://127.0.0.1:${b.gwPort}/_modeldock/sync/import`, {
      method: 'POST',
      headers: bAdmin,
      body: JSON.stringify({ phase: 'apply', source: { kind: 'ticket', ticket: pj.ticket } }),
    })
    expect(apply.status).toBe(200)
    const aj = (await apply.json()) as { ok: boolean; report: { keysRestored?: number } }
    expect(aj.ok).toBe(true)
    expect(aj.report.keysRestored).toBe(1)

    // B 配置已逐字段替换；key 按本机后端重存
    const after = await loadConfig()
    expect(Object.keys(after.providers).sort()).toEqual(['ark', 'envprov'])
    expect(after.providers.ark.base_url).toBe('https://ark.example.com/api')
    expect(after.profiles).toEqual({ main: { provider: 'ark', default_model: 'auto' } })
    expect(await getSecret(after.providers.ark.key_ref!)).toBe('sk-ark-pull-plaintext')
    // 机器态不动：B 的 admin token / 空机 harness 不被替换
    expect(Object.keys(after.harness)).toEqual([])

    // 票据单次：同一 ticket 二次 apply → 400
    const apply2 = await fetch(`http://127.0.0.1:${b.gwPort}/_modeldock/sync/import`, {
      method: 'POST',
      headers: bAdmin,
      body: JSON.stringify({ phase: 'apply', source: { kind: 'ticket', ticket: pj.ticket } }),
    })
    expect(apply2.status).toBe(400)
  })

  it('错口令 / 篡改包体 / 未知来源类型：预览 400', async () => {
    const a = await startMachineA()
    // collectSyncdoc 读进程级全局路径：offer 必须在切到 B 的 home 之前生成（生产单机单进程无此问题）。
    // offer 单槽（新顶旧）：offer1 拉走信封留作 file 源篡改用例；offer2 留给错口令 URL 用例
    const offer1 = (await (await fetch(`http://127.0.0.1:${a.gwPort}/_modeldock/sync/offer`, { method: 'POST', headers: { 'x-modeldock-admin': ADMIN_A } })).json()) as { urls: string[] }
    const u1 = new URL(offer1.urls[0])
    const envelopeText = await (await fetch(`http://127.0.0.1:${a.lanPort}/m/sync/pull?t=${u1.searchParams.get('t')}`)).text()
    const pass1 = decodeURIComponent(u1.hash.slice(3))
    const offer2 = (await (await fetch(`http://127.0.0.1:${a.gwPort}/_modeldock/sync/offer`, { method: 'POST', headers: { 'x-modeldock-admin': ADMIN_A } })).json()) as { urls: string[] }
    const u2 = new URL(offer2.urls[0])
    const pass2 = decodeURIComponent(u2.hash.slice(3))

    const b = await startMachineB()
    const bAdmin = { 'x-modeldock-admin': ADMIN_B, 'content-type': 'application/json' }
    const post = (body: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${b.gwPort}/_modeldock/sync/import`, { method: 'POST', headers: bAdmin, body: JSON.stringify(body) })

    // 错口令：拉取成功（焚毁 offer2）但拆封失败 → 400
    const wrong = await post({ phase: 'preview', source: { kind: 'url', url: `http://127.0.0.1:${a.lanPort}/m/sync/pull?t=${u2.searchParams.get('t')}`, passphrase: 'wrong-' + pass2 } })
    expect(wrong.status).toBe(400)
    const wj = (await wrong.json()) as { error: { message: string } }
    expect(wj.error.message).toMatch(/口令不正确/)

    // 非法协议：400（协议白名单）
    expect((await post({ phase: 'preview', source: { kind: 'url', url: 'ftp://127.0.0.1/x', passphrase: 'x' } })).status).toBe(400)

    // 未知来源类型：400
    expect((await post({ phase: 'preview', source: { kind: 'magic', file: '{}' } })).status).toBe(400)

    // file 源 + 篡改包体：400（GCM 完整性拦截）
    const env = JSON.parse(envelopeText) as { ct: string }
    const raw = Buffer.from(env.ct, 'base64')
    raw[0] ^= 0xff
    env.ct = raw.toString('base64')
    const tampered = await post({ phase: 'preview', source: { kind: 'file', file: JSON.stringify(env), passphrase: pass1 } })
    expect(tampered.status).toBe(400)
  })
})

describe('配置包桌面导出（/config/export）', () => {
  it('空配置 400 可操作报错；口令为空 400；正常导出返回文件名，信封可解开且不含 key 明文', async () => {
    useHome()
    await saveConfig({ version: 1, providers: {}, profiles: {}, harness: {} })
    const rt = buildRuntime(await loadConfig(), ADMIN_A)
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    cleanups.push(() => server.close())
    const admin = { 'x-modeldock-admin': ADMIN_A, 'content-type': 'application/json' }

    // 空配置：无可导出（与 offer 同一 assertExportable 口径）
    const empty = await fetch(`http://127.0.0.1:${gwPort}/_modeldock/config/export`, { method: 'POST', headers: admin, body: JSON.stringify({ passphrase: 'pw-1' }) })
    expect(empty.status).toBe(400)

    await seedShareMachine()
    await reloadRuntime(rt)
    // 口令为空
    const noPw = await fetch(`http://127.0.0.1:${gwPort}/_modeldock/config/export`, { method: 'POST', headers: admin, body: JSON.stringify({}) })
    expect(noPw.status).toBe(400)

    // 正常导出：文件名带本地时间到秒（同一天多次导出不再互相覆盖）；响应整体为密文信封，不含 key 明文；口令可解开
    const res = await fetch(`http://127.0.0.1:${gwPort}/_modeldock/config/export`, { method: 'POST', headers: admin, body: JSON.stringify({ passphrase: 'pw-desk-1' }) })
    expect(res.status).toBe(200)
    const j = (await res.json()) as { ok: boolean; envelope: unknown; filename: string }
    expect(j.ok).toBe(true)
    expect(j.filename).toMatch(/^modeldock-config-\d{8}-\d{6}\.msync$/)
    expect(JSON.stringify(j)).not.toContain('sk-ark-pull-plaintext')
    const doc = validateSyncdoc(openEnvelope(j.envelope, 'pw-desk-1'))
    expect(Object.keys(doc.data.providers)).toContain('ark')
  })

  it('端到端：A 桌面导出 .msync → B 以 file 来源预览/导入，配置逐字段替换、机器态不动', async () => {
    const a = await startMachineA()
    const exp = await fetch(`http://127.0.0.1:${a.gwPort}/_modeldock/config/export`, {
      method: 'POST',
      headers: { 'x-modeldock-admin': ADMIN_A, 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'pw-wechat-1' }),
    })
    expect(exp.status).toBe(200)
    const pkg = (await exp.json()) as { ok: boolean; envelope: unknown }

    const b = await startMachineB()
    const bAdmin = { 'x-modeldock-admin': ADMIN_B, 'content-type': 'application/json' }
    const prev = await fetch(`http://127.0.0.1:${b.gwPort}/_modeldock/sync/import`, {
      method: 'POST',
      headers: bAdmin,
      body: JSON.stringify({ phase: 'preview', source: { kind: 'file', file: JSON.stringify(pkg.envelope), passphrase: 'pw-wechat-1' } }),
    })
    expect(prev.status).toBe(200)
    const pj = (await prev.json()) as { ok: boolean; ticket: string; report: { providers: string[] } }
    expect(pj.ok).toBe(true)
    expect(pj.report.providers.sort()).toEqual(['ark', 'envprov'])

    const apply = await fetch(`http://127.0.0.1:${b.gwPort}/_modeldock/sync/import`, {
      method: 'POST',
      headers: bAdmin,
      body: JSON.stringify({ phase: 'apply', source: { kind: 'ticket', ticket: pj.ticket } }),
    })
    expect(apply.status).toBe(200)
    const after = await loadConfig()
    expect(Object.keys(after.providers).sort()).toEqual(['ark', 'envprov'])
    expect(after.profiles).toEqual({ main: { provider: 'ark', default_model: 'auto' } })
    expect(await getSecret(after.providers.ark.key_ref!)).toBe('sk-ark-pull-plaintext')
    // 机器态不动：B 的 admin token / 空机 harness 不被替换
    expect(Object.keys(after.harness)).toEqual([])
  })

  it('apply 直发源一键直达：file / url 免票据单请求应用（导入 UI 去预览步后的服务端语义）', async () => {
    const a = await startMachineA()
    // file 直发：桌面导出 .msync → 直接 phase=apply
    const exp = await fetch(`http://127.0.0.1:${a.gwPort}/_modeldock/config/export`, {
      method: 'POST',
      headers: { 'x-modeldock-admin': ADMIN_A, 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'pw-direct-1' }),
    })
    expect(exp.status).toBe(200)
    const pkg = (await exp.json()) as { ok: boolean; envelope: unknown }

    const b = await startMachineB()
    const bAdmin = { 'x-modeldock-admin': ADMIN_B, 'content-type': 'application/json' }
    const post = (source: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${b.gwPort}/_modeldock/sync/import`, { method: 'POST', headers: bAdmin, body: JSON.stringify({ phase: 'apply', source }) })

    // 错口令：与预览同一 resolveDoc 校验 → 400
    const wrong = await post({ kind: 'file', file: JSON.stringify(pkg.envelope), passphrase: 'wrong-pw' })
    expect(wrong.status).toBe(400)

    const applyFile = await post({ kind: 'file', file: JSON.stringify(pkg.envelope), passphrase: 'pw-direct-1' })
    expect(applyFile.status).toBe(200)
    const aj = (await applyFile.json()) as { ok: boolean; report: { providers: string[] } }
    expect(aj.ok).toBe(true)
    expect(aj.report.providers.sort()).toEqual(['ark', 'envprov'])
    const after = await loadConfig()
    expect(Object.keys(after.providers).sort()).toEqual(['ark', 'envprov'])
    expect(await getSecret(after.providers.ark.key_ref!)).toBe('sk-ark-pull-plaintext')

    // url 直发：一次性拉取链接被这一单请求直接消费（拉取 + 应用不拆两步）
    const offer = (await (await fetch(`http://127.0.0.1:${a.gwPort}/_modeldock/sync/offer`, { method: 'POST', headers: { 'x-modeldock-admin': ADMIN_A } })).json()) as { urls: string[] }
    const u = new URL(offer.urls[0])
    const pullUrl = `http://127.0.0.1:${a.lanPort}/m/sync/pull?t=${u.searchParams.get('t')}`
    const pass = decodeURIComponent(u.hash.slice(3))

    const c = await startMachineB()
    const applyUrl = await fetch(`http://127.0.0.1:${c.gwPort}/_modeldock/sync/import`, {
      method: 'POST',
      headers: { 'x-modeldock-admin': ADMIN_B, 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'apply', source: { kind: 'url', url: pullUrl, passphrase: pass } }),
    })
    expect(applyUrl.status).toBe(200)
    const after2 = await loadConfig()
    expect(Object.keys(after2.providers).sort()).toEqual(['ark', 'envprov'])
    expect(after2.profiles).toEqual({ main: { provider: 'ark', default_model: 'auto' } })
    // offer 单次：链接已被上面的 apply 消费，再次拉取 → 404（链接无效或已被使用）
    const again = await fetch(pullUrl)
    expect(again.status).toBe(404)
  })
})

describe('sync-nearby 附近电脑确认式直拉', () => {
  it('发现：LAN 开启时可被搜寻到（127.0.0.1 单播应答），stopLan 后不再应答；应答不含密钥', async () => {
    useHome()
    await seedShareMachine()
    const rt = buildRuntime(await loadConfig(), ADMIN_A)
    const lan = await startLanServer(rt, { port: 0, token: LAN_TOKEN, host: '127.0.0.1' })
    cleanups.push(() => stopLan(rt))
    const peers = await discoverPeers({ timeoutMs: 1500 })
    const mine = peers.filter((p) => p.port === lan.port)
    expect(mine.length).toBeGreaterThanOrEqual(1)
    expect(mine[0].name).toBe(osHostname())
    // 排除自己：exclude 后不再出现
    const excluded = await discoverPeers({ timeoutMs: 1200, exclude: { name: osHostname(), port: lan.port } })
    expect(excluded.some((p) => p.port === lan.port)).toBe(false)
    stopLan(rt)
    const afterStop = await discoverPeers({ timeoutMs: 1200 })
    expect(afterStop.some((p) => p.port === lan.port)).toBe(false)
  })

  it('端到端：B 搜到 A → request-remote 敲门 → A 确认卡允许 → B 自动拉取 granted → 票据导入成功', async () => {
    const a = await startMachineA()
    const b = await startMachineB()
    const bAdmin = { 'x-modeldock-admin': ADMIN_B, 'content-type': 'application/json' }

    // B 搜寻附近电脑，找到 A（127.0.0.1 单播应答；本机其他实例可能一并出现，按端口定位）
    const disc = await (await fetch(`http://127.0.0.1:${b.gwPort}/_modeldock/sync/discover`, { method: 'POST', headers: bAdmin })).json()
    const peer = (disc.peers as Array<{ ip: string; port: number; name: string }>).find((p) => p.port === a.lanPort)
    expect(peer).toBeTruthy()

    // B 点选 A → 敲门（后台任务）→ 立即拿到 requestId
    const reqRes = await fetch(`http://127.0.0.1:${b.gwPort}/_modeldock/sync/request-remote`, {
      method: 'POST',
      headers: bAdmin,
      body: JSON.stringify({ ips: peer!.ips, port: peer!.port }),
    })
    expect(reqRes.status).toBe(200)
    const { requestId } = (await reqRes.json()) as { requestId: string }

    // A 的 overview 出现待确认请求（含请求方主机名）。敲门是后台异步任务且 overview 有 2s TTL 缓存：
    // 轮询等待（最多 ~5s），不在单次 GET 上赌时序
    let overview: { syncRequest: { nonce: string; from: string } | null } | null = null
    for (let i = 0; i < 25 && !(overview && overview.syncRequest); i++) {
      await new Promise((r) => setTimeout(r, 200))
      const ovRes = await fetch(`http://127.0.0.1:${a.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': ADMIN_A } })
      overview = (await ovRes.json()) as { syncRequest: { nonce: string; from: string } | null }
    }
    expect(overview && overview.syncRequest).toBeTruthy()
    expect(overview!.syncRequest!.from).toBe(osHostname())

    // A 允许 → B 轮询 remote-status 直到 granted（信封已自动拉回、验签、出票据）
    // createSyncOffer→collectSyncdoc 走进程级全局路径：approve 期间临时切回 A home（生产单机单进程无此问题）
    const bHome = process.env.MODELRDOCK_FAKE_HOME
    process.env.MODELRDOCK_FAKE_HOME = a.home
    const approve = await fetch(`http://127.0.0.1:${a.gwPort}/_modeldock/sync/offer-approve`, {
      method: 'POST',
      headers: { 'x-modeldock-admin': ADMIN_A, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: overview.syncRequest!.nonce, approve: true }),
    })
    process.env.MODELRDOCK_FAKE_HOME = bHome
    expect(approve.status).toBe(200)
    let granted: { status: string; ticket: string; report: { providers: string[] }; meta: { createdBy: string } } | null = null
    for (let i = 0; i < 20 && !granted; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const st = (await (await fetch(`http://127.0.0.1:${b.gwPort}/_modeldock/sync/remote-status?id=${requestId}`, { headers: { 'x-modeldock-admin': ADMIN_B } })).json()) as { status: string; ticket?: string; report?: { providers: string[] }; meta?: { createdBy: string } }
      if (st.status === 'granted') granted = st as typeof granted
      expect(st.status).not.toBe('denied')
      expect(st.status).not.toBe('failed')
    }
    expect(granted).toBeTruthy()
    expect(granted!.report.providers.sort()).toEqual(['ark', 'envprov'])
    expect(JSON.stringify(granted)).not.toContain('sk-ark-pull-plaintext')

    // B 确认导入：凭票据应用
    const apply = await fetch(`http://127.0.0.1:${b.gwPort}/_modeldock/sync/import`, {
      method: 'POST',
      headers: bAdmin,
      body: JSON.stringify({ phase: 'apply', source: { kind: 'ticket', ticket: granted!.ticket } }),
    })
    expect(apply.status).toBe(200)
    const after = await loadConfig()
    expect(Object.keys(after.providers).sort()).toEqual(['ark', 'envprov'])
    expect(await getSecret(after.providers.ark.key_ref!)).toBe('sk-ark-pull-plaintext')
  })

  it('A 侧裁决流：拒绝立即传导；允许后 grant 单次焚毁、overview 清槽；限频与坏参数 4xx', async () => {
    const a = await startMachineA()
    const aLan = `http://127.0.0.1:${a.lanPort}`
    const aAdmin = { 'x-modeldock-admin': ADMIN_A, 'content-type': 'application/json' }
    const knock = (nonce: string, from = 'B-mac'): Promise<Response> =>
      fetch(`${aLan}/m/sync/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce, from }) })

    // 端到端用例可能刚发生过 knock（同源 127.0.0.1 限频窗口内）：只伪造时钟不动定时器，拨过限频窗口
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 15 * 1000)

      // 坏参数：nonce 格式非法 400
      expect((await knock('short')).status).toBe(400)
      // 正常敲门 + 限频：同一来源 10s 内第二发 429
      const nonce1 = 'a'.repeat(48)
      expect((await knock(nonce1)).status).toBe(200)
      expect((await knock('b'.repeat(48))).status).toBe(429)

      // overview 出现待确认请求
      const ov = (await (await fetch(`http://127.0.0.1:${a.gwPort}/_modeldock/overview`, { headers: aAdmin })).json()) as { syncRequest: { nonce: string; from: string } }
      expect(ov.syncRequest.nonce).toBe(nonce1)

      // 未裁决时 grant 轮询 404（B 侧继续等）
      expect((await fetch(`${aLan}/m/sync/grant?n=${nonce1}`)).status).toBe(404)

      // 拒绝：grant 返回 403 denied，overview 清槽
      await fetch(`http://127.0.0.1:${a.gwPort}/_modeldock/sync/offer-approve`, { method: 'POST', headers: aAdmin, body: JSON.stringify({ nonce: nonce1, approve: false }) })
      const denied = await fetch(`${aLan}/m/sync/grant?n=${nonce1}`)
      expect(denied.status).toBe(403)
      expect(((await denied.json()) as { denied: boolean }).denied).toBe(true)
      expect(((await (await fetch(`http://127.0.0.1:${a.gwPort}/_modeldock/overview`, { headers: aAdmin })).json()) as { syncRequest: unknown }).syncRequest).toBeNull()

      // 拨过限频窗口再来一轮：允许 → grant 返回 url+passphrase 且单次焚毁
      vi.setSystemTime(Date.now() + 15 * 1000)
      const nonce2 = 'c'.repeat(48)
      expect((await knock(nonce2)).status).toBe(200)
      const approved = await fetch(`http://127.0.0.1:${a.gwPort}/_modeldock/sync/offer-approve`, { method: 'POST', headers: aAdmin, body: JSON.stringify({ nonce: nonce2, approve: true }) })
      expect(approved.status).toBe(200)
      const g1 = await fetch(`${aLan}/m/sync/grant?n=${nonce2}`)
      expect(g1.status).toBe(200)
      const gj = (await g1.json()) as { url: string; passphrase: string }
      expect(gj.url).toContain('/m/sync/pull?t=')
      expect(gj.passphrase).toBeTruthy()
      expect((await fetch(`${aLan}/m/sync/grant?n=${nonce2}`)).status).toBe(404)

      // nonce 不匹配的裁决（槽已被顶掉/伪造）400
      const forged = await fetch(`http://127.0.0.1:${a.gwPort}/_modeldock/sync/offer-approve`, { method: 'POST', headers: aAdmin, body: JSON.stringify({ nonce: 'd'.repeat(48), approve: true }) })
      expect(forged.status).toBe(400)
    } finally {
      vi.useRealTimers()
    }
  })
})

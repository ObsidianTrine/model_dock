import { describe, expect, it, afterEach } from 'vitest'
import { fakeHome } from './helpers.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { buildRuntime, type GatewayRuntime } from '../src/gateway/state.js'
import { startLanServer, stopLan, type LanHandle } from '../src/gateway/lan.js'
import { ensureDir, atomicWrite, readTextIfExists } from '../src/util/fsx.js'
import { gatewayStatePath, modeldockDir, presetsJsonPath } from '../src/util/paths.js'
import { getSecret, makeKeyRef, setSecret } from '../src/config/secrets.js'
import type { Config } from '../src/config/types.js'

process.env.MODELRDOCK_DISABLE_HOLIDAY_FETCH = '1'
process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'

const TOKEN = 'mdklan_' + 'b'.repeat(32)
const AUTH = { authorization: `Bearer ${TOKEN}` }

// 双 fakeHome 双网关（A=导出机，B=导入机）同进程端到端：严格串行（A 导出完成后才切 env 到 B），
// 收尾逆序 restore。secrets 模块级缓存在同进程跨 home 复用——断言走公开 API 语义（与 test/syncexport.test.ts 同口径）。

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
})

function useHome(): { home: string } {
  const h = fakeHome()
  cleanups.push(h.restore)
  return { home: h.home }
}

async function startLan(cfg: Config): Promise<{ rt: GatewayRuntime; handle: LanHandle; base: string }> {
  await ensureDir(modeldockDir())
  await saveConfig(cfg)
  const rt = buildRuntime(await loadConfig(), 'mdkadm_test')
  const handle = await startLanServer(rt, { port: 0, token: TOKEN, host: '127.0.0.1' })
  cleanups.push(() => stopLan(rt))
  return { rt, handle, base: `http://127.0.0.1:${handle.port}` }
}

async function seedMachineA(): Promise<void> {
  await setSecret('ark', 'sk-ark-lan-plaintext', 'file')
  await saveConfig({
    version: 1,
    active_profile: 'main',
    providers: {
      ark: { name: '方舟', base_url: 'https://ark.example.com/api', protocol: 'anthropic', auth_style: 'bearer', key_ref: makeKeyRef('file', 'ark') },
      envprov: { base_url: 'https://env.example.com/v1', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:ARK_KEY' },
    },
    profiles: { main: { provider: 'ark', default_model: 'auto' } },
    harness: { 'claude-code': { mode: 'gateway', attached_at: '2026-01-01T00:00:00.000Z' } },
    gateway: { schedule: { enabled: false, windows: [{ start: '09:00', end: '18:00', target: 'ark', dayFilter: 'workday' }] } },
  })
  await atomicWrite(presetsJsonPath(), JSON.stringify([{ id: 'corp', label: 'Corp', vendor: 'Corp', base_url: 'https://corp.example.com', protocol: 'openai', auth_style: 'bearer' }], null, 2) + '\n')
}

async function seedMachineB(): Promise<void> {
  // security.store=file：测试进程内避免 defaultStore() 写真实钥匙串（darwin）
  await saveConfig({
    version: 1,
    language: 'en',
    active_profile: 'old-route',
    security: { store: 'file' },
    providers: { stale: { base_url: 'https://stale.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:STALE' } },
    profiles: { 'old-route': { provider: 'stale' } },
    harness: { dsh: { mode: 'file', attached_at: '2026-02-02T00:00:00.000Z' } },
    gateway: { schedule: { enabled: true, windows: [{ start: '00:00', end: '23:59', target: 'stale' }] } },
  })
  await atomicWrite(presetsJsonPath(), JSON.stringify([{ id: 'old', label: 'Old', vendor: 'Old', base_url: 'https://old.example.com', protocol: 'openai', auth_style: 'bearer' }], null, 2) + '\n')
  await atomicWrite(gatewayStatePath(), JSON.stringify({ admin_token: 'mdk_b_local', port: 18999 }, null, 2) + '\n')
}

describe('LAN 配置同步（/m 页导出/导入）', () => {
  it('A 机导出 → B 机预览 → 确认应用：可同步态替换、机器态保留、响应与包体均无 key 明文', async () => {
    // ── A 机（家里）：导出 ──
    useHome()
    await seedMachineA()
    const a = await startLan(await loadConfig())
    const exp = await fetch(`${a.base}/m/api/sync/export`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'lan-pass-1' }),
    })
    expect(exp.status).toBe(200)
    expect(exp.headers.get('content-disposition')).toContain('.msync')
    const envText = await exp.text()
    expect(envText).toContain('modeldock-syncenv')
    // 加密包内不得出现 key 明文（D2：出机器即密文）
    expect(envText).not.toContain('sk-ark-lan-plaintext')
    expect(envText).not.toContain('ark.example.com')

    // ── B 机（公司）：预览 → 确认 → 应用 ──
    useHome()
    await seedMachineB()
    const before = await loadConfig()
    const beforeGatewayJson = await readTextIfExists(gatewayStatePath())
    const b = await startLan(await loadConfig())

    const prev = await fetch(`${b.base}/m/api/sync/import`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'preview', file: envText, passphrase: 'lan-pass-1' }),
    })
    expect(prev.status).toBe(200)
    const pj = (await prev.json()) as { ok: boolean; report: { providers: string[]; profiles: string[]; presetCount: number; scheduleRules: number; envKeyRefs: string[] }; meta: { createdBy: string } }
    expect(pj.ok).toBe(true)
    expect(pj.report.providers.sort()).toEqual(['ark', 'envprov'])
    expect(pj.report.profiles).toEqual(['main'])
    expect(pj.report.presetCount).toBe(1)
    expect(pj.report.scheduleRules).toBe(1)
    expect(pj.report.envKeyRefs).toEqual(['envprov'])
    expect(pj.meta.createdBy).toBeTruthy()
    // 预览响应不回传 doc 本体/明文
    expect(JSON.stringify(pj)).not.toContain('sk-ark-lan-plaintext')
    expect(JSON.stringify(pj)).not.toContain('base_url')

    const apply = await fetch(`${b.base}/m/api/sync/import`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'apply', file: envText, passphrase: 'lan-pass-1' }),
    })
    expect(apply.status).toBe(200)
    const aj = (await apply.json()) as { ok: boolean; report: { keysRestored?: number } }
    expect(aj.ok).toBe(true)
    expect(aj.report.keysRestored).toBe(1)

    const after = await loadConfig()
    // 可同步态逐字段替换
    expect(Object.keys(after.providers).sort()).toEqual(['ark', 'envprov'])
    expect(after.providers.ark.base_url).toBe('https://ark.example.com/api')
    expect(after.profiles).toEqual({ main: { provider: 'ark', default_model: 'auto' } })
    expect(after.gateway?.schedule?.windows).toEqual([{ start: '09:00', end: '18:00', target: 'ark', dayFilter: 'workday' }])
    // 每机「启用」开关属机器态：保持 B 的 true（A 是 false）
    expect(after.gateway?.schedule?.enabled).toBe(true)
    // 机器态一律不动
    expect(after.harness).toEqual(before.harness)
    expect(after.active_profile).toBe('old-route')
    expect(after.language).toBe('en')
    expect(await readTextIfExists(gatewayStatePath())).toBe(beforeGatewayJson)
    // key 按本机后端重存且明文正确
    expect(await getSecret(after.providers.ark.key_ref!)).toBe('sk-ark-lan-plaintext')
    // 自定义预设整体替换
    const presetsRaw = JSON.parse((await readTextIfExists(presetsJsonPath())) as string)
    expect((Array.isArray(presetsRaw) ? presetsRaw : presetsRaw.presets).map((p: { id: string }) => p.id)).toEqual(['corp'])
  })

  it('错口令：预览 400 且文案可操作', async () => {
    useHome()
    await seedMachineA()
    const a = await startLan(await loadConfig())
    const exp = await fetch(`${a.base}/m/api/sync/export`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'right' }) })
    const envText = await exp.text()

    useHome()
    await seedMachineB()
    const b = await startLan(await loadConfig())
    const res = await fetch(`${b.base}/m/api/sync/import`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'preview', file: envText, passphrase: 'wrong' }),
    })
    expect(res.status).toBe(400)
    const j = (await res.json()) as { ok: boolean; error: string }
    expect(j.ok).toBe(false)
    expect(j.error).toMatch(/口令不正确/)
  })

  it('篡改包体：预览 400（GCM/完整性拦截）', async () => {
    useHome()
    await seedMachineA()
    const a = await startLan(await loadConfig())
    const exp = await fetch(`${a.base}/m/api/sync/export`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'pw' }) })
    const env = JSON.parse(await exp.text()) as { ct: string }
    const raw = Buffer.from(env.ct, 'base64')
    raw[0] ^= 0xff
    env.ct = raw.toString('base64')

    useHome()
    await seedMachineB()
    const b = await startLan(await loadConfig())
    const res = await fetch(`${b.base}/m/api/sync/import`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'preview', file: JSON.stringify(env), passphrase: 'pw' }),
    })
    expect(res.status).toBe(400)
  })

  it('空配置导出 400；未带令牌 403；/m 页含配置同步卡片', async () => {
    useHome()
    await saveConfig({ version: 1, providers: {}, profiles: {}, harness: {} })
    const a = await startLan(await loadConfig())
    const empty = await fetch(`${a.base}/m/api/sync/export`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'pw' }) })
    expect(empty.status).toBe(400)
    const j = (await empty.json()) as { error: string }
    expect(j.error).toMatch(/没有可导出|nothing to export/i)

    const noauth = await fetch(`${a.base}/m/api/sync/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'pw' }) })
    expect(noauth.status).toBe(403)

    const page = await fetch(`${a.base}/m`, { headers: { authorization: `Bearer ${AUTH.authorization.slice(7)}` } })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('data-i18n="配置同步||Config sync"')
    expect(html).toContain('id="expBtn"')
    expect(html).toContain('id="impFile"')
    // 导入一键直达：按钮就是「导入」（data-i18n 双语在位），不再有预览确认按钮
    expect(html).toContain('id="impBtn"')
    expect(html).toContain('data-i18n="导入||Import"')
    expect(html).not.toContain('id="impApplyBtn"')
    // 导入的文件选择框不得带 accept：iOS 选择器按类型过滤，.msync 未注册会被灰掉选不中
    // （实测同一文件改名 .json 可选、.txt 与 .msync 不可选）；放开过滤才能列出文件
    expect(html).not.toMatch(/<input[^>]*id="impFile"[^>]*accept/)
    // iPhone 导出后要指明落盘位置（「文件」App → 下载项），否则用户找不到包
    expect(html).toContain('「文件」App')
  })

  it('PWA：manifest/图标持令牌可取、无令牌 403；页面含主屏引导与 meta', async () => {
    useHome()
    await saveConfig({ version: 1, providers: { p: { base_url: 'https://p.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:P' } }, profiles: {}, harness: {} })
    const a = await startLan(await loadConfig())

    // 无令牌一律 403
    expect((await fetch(`${a.base}/m/manifest.webmanifest`)).status).toBe(403)
    expect((await fetch(`${a.base}/m/icon-192.png`)).status).toBe(403)

    // manifest：start_url 带令牌（iOS 主屏独立窗口存储隔离，靠它自举种 cookie）
    const mf = await fetch(`${a.base}/m/manifest.webmanifest`, { headers: AUTH })
    expect(mf.status).toBe(200)
    expect(mf.headers.get('content-type')).toContain('manifest+json')
    const mj = (await mf.json()) as { start_url: string; display: string; icons: Array<{ src: string; sizes: string }> }
    expect(mj.start_url).toBe(`/m?token=${TOKEN}`)
    expect(mj.display).toBe('standalone')
    expect(mj.icons.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512'])

    // 图标：合法 PNG（魔数）
    for (const p of ['icon-192.png', 'icon-512.png']) {
      const ic = await fetch(`${a.base}/m/${p}`, { headers: AUTH })
      expect(ic.status).toBe(200)
      expect(ic.headers.get('content-type')).toBe('image/png')
      const buf = Buffer.from(await ic.arrayBuffer())
      expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
      expect(buf.length).toBeGreaterThan(1000)
    }

    // 页面：PWA meta 与主屏引导标记
    const page = await fetch(`${a.base}/m`, { headers: AUTH })
    const html = await page.text()
    expect(html).toContain('rel="manifest"')
    expect(html).toContain('rel="apple-touch-icon"')
    expect(html).toContain('apple-mobile-web-app-capable')
    expect(html).toContain('id="a2hsBtn"')
    expect(html).toContain('id="a2hsCard"')
  })
})

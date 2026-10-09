import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { atomicWrite, readTextIfExists } from '../src/util/fsx.js'
import { gatewayStatePath, presetsJsonPath } from '../src/util/paths.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { getSecret, makeKeyRef, setSecret } from '../src/config/secrets.js'
import { exportFileName, exportSyncdoc, previewImport, applyImportedDoc } from '../src/sync/exportImport.js'
import type { Config, ProviderConfig } from '../src/config/types.js'

const restoreFns: Array<() => void> = []
afterAll(() => {
  for (const r of restoreFns.reverse()) r()
})

function useHome(): { home: string } {
  const fh = fakeHome()
  restoreFns.push(fh.restore)
  return { home: fh.home }
}

async function seedMachineA(): Promise<void> {
  // 服务 A：file 后端 key；服务 B：env 引用；服务 C：明文内嵌 key_ref
  await setSecret('ark', 'sk-ark-plaintext', 'file')
  await saveConfig({
    version: 1,
    language: 'zh',
    active_profile: 'main',
    providers: {
      ark: { base_url: 'https://ark.example.com/api', protocol: 'anthropic', auth_style: 'bearer', key_ref: makeKeyRef('file', 'ark') },
      envprov: { base_url: 'https://env.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:ARK_KEY' },
      plainprov: { base_url: 'https://plain.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'sk-inline-plain' },
    },
    profiles: {
      main: { provider: 'ark', default_model: 'auto', aliases: { 'claude-*': 'auto' } },
      backup: { provider: 'envprov', fallback: ['ark'] },
    },
    harness: { 'claude-code': { mode: 'gateway', attached_at: '2026-01-01T00:00:00.000Z', files: ['/x'] } },
    gateway: { port: 12345, schedule: { enabled: false, windows: [{ start: '09:00', end: '18:00', target: 'ark', dayFilter: 'workday' }] } },
  })
  await atomicWrite(presetsJsonPath(), JSON.stringify([{ id: 'corp', label: 'Corp', vendor: 'Corp', base_url: 'https://corp.example.com', protocol: 'openai', auth_style: 'bearer' }], null, 2) + '\n')
}

/** 机器 B 的机器态种子（导入后必须原样保留） */
async function seedMachineBMachineState(): Promise<void> {
  await atomicWrite(gatewayStatePath(), JSON.stringify({ admin_token: 'mdk_local_secret', port: 4321 }, null, 2) + '\n')
  await saveConfig({
    version: 1,
    language: 'en',
    active_profile: 'old-local-route',
    providers: { stale: { base_url: 'https://stale.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:STALE_KEY' } },
    profiles: { stalep: { provider: 'stale' } },
    harness: { dsh: { mode: 'file', attached_at: '2026-02-02T00:00:00.000Z', files: ['/y'] } },
    gateway: { port: 4321, schedule: { enabled: true, windows: [{ start: '00:00', end: '23:59', target: 'stale' }] } },
  })
  await atomicWrite(presetsJsonPath(), JSON.stringify([{ id: 'old-local-preset', label: 'Old', vendor: 'Old', base_url: 'https://old.example.com', protocol: 'openai', auth_style: 'bearer' }], null, 2) + '\n')
}

async function readCfg(): Promise<Config> {
  return loadConfig()
}

describe('加密配置包 导出→导入（双沙箱端到端）', () => {
  it('新机导入：本机没有任何路由时自动选首个 profile（否则导入完等于没有服务在供）', async () => {
    const a = useHome()
    await seedMachineA()
    const msyncPath = path.join(a.home, 'export-new-machine.msync')
    await exportSyncdoc(msyncPath, '口令')
    // 全新机器：空配置，没有 active_profile（新电脑零配置导入的典型起点）
    useHome()
    await saveConfig({ version: 1, providers: {}, profiles: {}, harness: {} })
    const doc = (await previewImport(msyncPath, '口令')).doc
    await applyImportedDoc(doc, { backend: 'file' })
    const after = await readCfg()
    expect(after.active_profile).toBe('main')
    expect(after.profiles[after.active_profile!]!.provider).toBe('ark')
  })

  it('导出→换机导入→可同步态逐字段一致、机器态原样保留', async () => {
    const a = useHome()
    await seedMachineA()
    const msyncPath = path.join(a.home, 'export.msync')
    const { report } = await exportSyncdoc(msyncPath, '正确口令')
    expect(report.providers.sort()).toEqual(['ark', 'envprov', 'plainprov'])
    expect(report.profiles.sort()).toEqual(['backup', 'main'])
    expect(report.presetCount).toBe(1)
    expect(report.scheduleRules).toBe(1)
    // 导出机：env 引用保留、不嵌入明文
    expect(report.envKeyRefs).toEqual(['envprov'])
    // 导出文件权限 0600（NTFS 不认权限位，跳过）
    if (process.platform !== 'win32') {
      expect(fs.statSync(msyncPath).mode & 0o777).toBe(0o600)
    }

    // ── 换机器：全新 fakeHome，先铺机器态 ──
    useHome()
    await seedMachineBMachineState()
    const before = await readCfg()
    const beforeGatewayJson = await readTextIfExists(gatewayStatePath())

    const preview = await previewImport(msyncPath, '正确口令')
    expect(preview.report.providers.sort()).toEqual(['ark', 'envprov', 'plainprov'])
    expect(preview.doc.data.providers.ark!.key).toBe('sk-ark-plaintext')
    expect(preview.doc.data.providers.envprov!.key).toBeUndefined()
    expect(preview.doc.data.providers.envprov!.key_ref).toBe('env:ARK_KEY')

    const applied = await applyImportedDoc(preview.doc, { backend: 'file' })
    expect(applied.keysRestored).toBe(2) // ark（file 解析）+ plainprov（明文内嵌转正规存储）

    const after = await readCfg()
    // 可同步态逐字段替换
    expect(Object.keys(after.providers).sort()).toEqual(['ark', 'envprov', 'plainprov'])
    expect(after.providers.ark).toEqual<ProviderConfig>({
      base_url: 'https://ark.example.com/api',
      protocol: 'anthropic',
      auth_style: 'bearer',
      key_ref: expect.any(String),
    })
    expect(after.providers.plainprov.key_ref).toMatch(/^file:/)
    expect(after.profiles).toEqual({
      main: { provider: 'ark', default_model: 'auto', aliases: { 'claude-*': 'auto' } },
      backup: { provider: 'envprov', fallback: ['ark'] },
    })
    expect(after.gateway?.schedule?.windows).toEqual([{ start: '09:00', end: '18:00', target: 'ark', dayFilter: 'workday' }])
    // 每机「启用」开关是机器态：保持导入前的 true（来源机是 false）
    expect(after.gateway?.schedule?.enabled).toBe(true)
    expect(after.gateway?.port).toBe(4321)
    // 机器态一律不动
    expect(after.harness).toEqual(before.harness)
    expect(after.active_profile).toBe('old-local-route')
    expect(after.language).toBe('en')
    expect(await readTextIfExists(gatewayStatePath())).toBe(beforeGatewayJson)
    // key 明文已按目标机 file 后端重存
    expect(await getSecret(after.providers.ark.key_ref!)).toBe('sk-ark-plaintext')
    // 自定义预设整体替换
    const presetsRaw = JSON.parse(await readTextIfExists(presetsJsonPath()) as string)
    expect(Array.isArray(presetsRaw) ? presetsRaw : presetsRaw.presets).toHaveLength(1)
  })

  it('错误口令导入失败（文案可操作）', async () => {
    const a = useHome()
    await seedMachineA()
    const msyncPath = path.join(a.home, 'export.msync')
    await exportSyncdoc(msyncPath, 'pw-right')
    useHome()
    await expect(previewImport(msyncPath, 'pw-wrong')).rejects.toThrow(/口令不正确/)
  })

  it('篡改包内容失败（GCM 认证拦截）', async () => {
    const a = useHome()
    await seedMachineA()
    const msyncPath = path.join(a.home, 'export.msync')
    await exportSyncdoc(msyncPath, 'pw')
    const env = JSON.parse(fs.readFileSync(msyncPath, 'utf8'))
    const raw = Buffer.from(env.ct, 'base64')
    raw[0] ^= 0xff
    env.ct = raw.toString('base64')
    const tampered = path.join(a.home, 'tampered.msync')
    fs.writeFileSync(tampered, JSON.stringify(env, null, 2), { mode: 0o600 })
    useHome()
    await expect(previewImport(tampered, 'pw')).rejects.toThrow()
  })

  it('空配置导出被拒绝并给出可操作提示', async () => {
    const h = useHome()
    await saveConfig({ version: 1, providers: {}, profiles: {}, harness: {} })
    await expect(exportSyncdoc(path.join(h.home, 'x.msync'), 'pw')).rejects.toThrow(/没有可导出|nothing to export/i)
  })
})

describe('导出包文件名（exportFileName）', () => {
  // 一律用本地时间构造 Date 再读回本地字段，断言在任何时区下都成立：
  // 这正是要防的回归——旧实现用 toISOString()（恒为 UTC），北京时间 08:00 前导出的包会标成前一天
  it('精确到秒且用本地时间：YYYYMMDD-HHMMSS', () => {
    expect(exportFileName(new Date(2026, 9, 7, 15, 30, 42))).toBe('modeldock-config-20261007-153042.msync')
    // 同日不同秒 → 不同名（同一天多次导出不再互相覆盖，也不用靠浏览器加 (1)(2)）
    expect(exportFileName(new Date(2026, 9, 7, 15, 30, 43))).not.toBe(exportFileName(new Date(2026, 9, 7, 15, 30, 42)))
    // 同日同时刻 → 同名（纯函数，无随机成分）
    expect(exportFileName(new Date(2026, 9, 7, 15, 30, 42))).toBe(exportFileName(new Date(2026, 9, 7, 15, 30, 42)))
  })

  it('文件名只用数字与连字符：不含 NTFS/各平台非法字符（冒号、星号、斜杠等）', () => {
    const name = exportFileName(new Date(2026, 0, 2, 3, 4, 5))
    expect(name).toBe('modeldock-config-20260102-030405.msync')
    expect(/[:*?"<>|/\\]/.test(name)).toBe(false)
  })

  it('月/日/时分秒补零，跨日不串位', () => {
    expect(exportFileName(new Date(2026, 0, 1, 0, 0, 0))).toBe('modeldock-config-20260101-000000.msync')
    expect(exportFileName(new Date(2026, 11, 31, 23, 59, 59))).toBe('modeldock-config-20261231-235959.msync')
  })
})

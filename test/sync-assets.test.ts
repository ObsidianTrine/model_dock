import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import {
  applyAssets,
  assetKeyToPath,
  collectAssetFiles,
  isSafeAssetKey,
  normalizeAssetDir,
  ASSET_MAX_FILE_BYTES,
  ASSET_MAX_FILES,
  ASSET_MAX_TOTAL_BYTES,
} from '../src/sync/assets.js'
import { applySyncdoc, collectSyncdoc } from '../src/sync/collect.js'
import { validateSyncdoc, type Syncdoc } from '../src/sync/types.js'
import { saveConfig } from '../src/config/store.js'
import { emptyConfig } from '../src/config/types.js'

const homes: ReturnType<typeof fakeHome>[] = []
afterEach(() => {
  while (homes.length) homes.pop()!.restore()
})

function mkHome(): string {
  const h = fakeHome()
  homes.push(h)
  return h.home
}

function write(home: string, rel: string[], content: string | Buffer): string {
  const p = path.join(home, ...rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}

function fakeDoc(files: Record<string, string>): Syncdoc {
  return {
    fmt: 'modeldock-syncdoc',
    v: 1,
    ts: new Date().toISOString(),
    data: { providers: {}, profiles: {}, userPresets: [], scheduleRules: [], ...(Object.keys(files).length ? { assets: { files } } : {}) },
  }
}

describe('资产路径安全（isSafeAssetKey / assetKeyToPath / normalizeAssetDir）', () => {
  it('相对 POSIX 路径合法；绝对路径、..、盘符、反斜杠、排除段全部拒绝', () => {
    const home = mkHome()
    expect(isSafeAssetKey('.agents/skills/demo/SKILL.md')).toBe(true)
    expect(isSafeAssetKey('.claude/CLAUDE.md')).toBe(true)
    expect(isSafeAssetKey('../etc/passwd')).toBe(false)
    expect(isSafeAssetKey('a/../../b')).toBe(false)
    expect(isSafeAssetKey('/etc/passwd')).toBe(false)
    expect(isSafeAssetKey('C:/Users/x')).toBe(false)
    expect(isSafeAssetKey('a\\b')).toBe(false)
    expect(isSafeAssetKey('')).toBe(false)
    expect(isSafeAssetKey('.modeldock/secrets.json')).toBe(false)
    expect(isSafeAssetKey('skills/node_modules/x.js')).toBe(false)
    expect(assetKeyToPath('.claude/CLAUDE.md')).toBe(path.join(home, '.claude', 'CLAUDE.md'))
    expect(assetKeyToPath('../x')).toBeNull()
  })

  it('normalizeAssetDir：~/x 与绝对路径归一化为家目录相对 POSIX；home 外与排除目录报错', () => {
    const home = mkHome()
    const abs = path.join(home, 'docs', 'notes')
    expect(normalizeAssetDir(abs)).toBe('docs/notes')
    expect(normalizeAssetDir('~/docs/notes')).toBe('docs/notes')
    expect(() => normalizeAssetDir(path.join(path.dirname(home), 'outside'))).toThrow()
    expect(() => normalizeAssetDir(path.join(home, '.modeldock', 'logs'))).toThrow(/\.modeldock/)
  })
})

describe('资产收集（collectAssetFiles）', () => {
  it('收集文本、跳过二进制与 node_modules、不跟随符号链接；目录缺失视为空', () => {
    const home = mkHome()
    write(home, ['.agents', 'skills', 'demo', 'SKILL.md'], '---\nname: demo\n---\nbody')
    write(home, ['.agents', 'skills', 'demo', 'logo.png'], Buffer.from([0x89, 0x50, 0x00, 0x4e]))
    write(home, ['.agents', 'skills', 'demo', 'node_modules', 'dep', 'index.js'], 'x')
    let symlinkCreated = false
    try {
      fs.symlinkSync(path.join(path.dirname(home), 'outside'), path.join(home, '.agents', 'skills', 'demo', 'link'))
      symlinkCreated = true
    } catch {
      /* Windows 无符号链接权限：跳过该断言 */
    }
    const a = collectAssetFiles(['.agents/skills'])
    expect(Object.keys(a.files)).toEqual(['.agents/skills/demo/SKILL.md'])
    expect(a.skipped).toEqual(['.agents/skills/demo/logo.png'])
    if (symlinkCreated) {
      expect(Object.keys(a.files).some((k) => k.includes('link'))).toBe(false)
      expect(fs.existsSync(path.join(path.dirname(home), 'outside', 'COLLECTED'))).toBe(false)
    }
    // 目录不存在：空结果（另一台机器同步后才出现的目录是正常态）
    expect(collectAssetFiles(['.nope/missing'])).toEqual({ files: {}, skipped: [] })
  })

  it('单文件超 512KB 跳过不报错；文件数超上限或总量超限抛可操作报错', () => {
    const home = mkHome()
    write(home, ['big', 'huge.md'], 'a'.repeat(ASSET_MAX_FILE_BYTES + 1))
    expect(collectAssetFiles(['big'])).toEqual({ files: {}, skipped: ['big/huge.md'] })

    const home2 = mkHome()
    for (let i = 0; i <= ASSET_MAX_FILES; i++) write(home2, ['many', `f${i}.md`], 'x')
    expect(() => collectAssetFiles(['many'])).toThrow()

    const home3 = mkHome()
    for (let i = 0; i < 10; i++) write(home3, ['heavy', `f${i}.md`], 'a'.repeat(500 * 1024))
    expect(() => collectAssetFiles(['heavy'])).toThrow()
    expect(ASSET_MAX_TOTAL_BYTES).toBe(4 * 1024 * 1024)
  })
})

describe('syncdoc 集成：collectSyncdoc 带上白名单资产；validateSyncdoc 把关', () => {
  it('config.sync_assets 配置后 assets 随包；未配置不带 assets 键', async () => {
    const home = mkHome()
    write(home, ['skills', 'a', 'SKILL.md'], 'demo')
    const cfg = emptyConfig()
    cfg.sync_assets = { dirs: ['skills'] }
    await saveConfig(cfg)
    const { doc, report } = await collectSyncdoc()
    expect(doc.data.assets?.files['skills/a/SKILL.md']).toBe('demo')
    expect(report.assetsFiles).toBe(1)

    const cfg2 = emptyConfig()
    await saveConfig(cfg2)
    const r2 = await collectSyncdoc()
    expect(r2.doc.data.assets).toBeUndefined()
  })

  it('validateSyncdoc：assets 路径穿越/超限/非字符串在校验期拒绝', () => {
    expect(() => validateSyncdoc(fakeDoc({ '../evil': 'x' }))).toThrow()
    expect(() => validateSyncdoc(fakeDoc({ '.modeldock/secrets.json': '{}' }))).toThrow()
    expect(() => validateSyncdoc(fakeDoc({ ok: 123 as unknown as string }))).toThrow()
    expect(() => validateSyncdoc(fakeDoc({ big: 'a'.repeat(ASSET_MAX_FILE_BYTES + 1) }))).toThrow()
    const ok = validateSyncdoc(fakeDoc({ '.claude/CLAUDE.md': '# hi' }))
    expect(ok.data.assets?.files['.claude/CLAUDE.md']).toBe('# hi')
    // 无 assets 的旧包照常通过（SCHEMA_VERSION 不变的向后兼容）
    expect(validateSyncdoc(fakeDoc({})).data.assets).toBeUndefined()
  })
})

describe('资产应用（applySyncdoc → applyAssets）', () => {
  it('写入差异文件（含新建父目录）、二次应用零写入、不删除本机多出的文件；0600 权限', async () => {
    const home = mkHome()
    await saveConfig(emptyConfig())
    write(home, ['.agents', 'skills', 'keep.md'], 'local only')
    write(home, ['.claude', 'CLAUDE.md'], '# old content')

    const r1 = await applySyncdoc(fakeDoc({ '.agents/skills/demo/SKILL.md': 'demo', '.claude/CLAUDE.md': '# new content' }), { backend: 'file' })
    expect(r1.assetsWritten).toBe(2)
    expect(fs.readFileSync(path.join(home, '.agents', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('demo')
    expect(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# new content')
    // 本机多出的文件保留（绝不删除）
    expect(fs.readFileSync(path.join(home, '.agents', 'skills', 'keep.md'), 'utf8')).toBe('local only')
    if (process.platform !== 'win32') {
      // NTFS 不认权限位：仅 POSIX 断言
      expect(fs.statSync(path.join(home, '.claude', 'CLAUDE.md')).mode & 0o777).toBe(0o600)
    }

    // 内容一致：零写入
    const r2 = await applySyncdoc(fakeDoc({ '.agents/skills/demo/SKILL.md': 'demo', '.claude/CLAUDE.md': '# new content' }), { backend: 'file' })
    expect(r2.assetsWritten).toBe(0)
  })

  it('applyAssets 自身防线：不安全 key / 超限内容拒绝，不做任何写入', async () => {
    mkHome()
    await expect(applyAssets({ '../evil.md': 'x' })).rejects.toThrow()
    await expect(applyAssets({ 'big.md': 'a'.repeat(ASSET_MAX_FILE_BYTES + 1) })).rejects.toThrow()
  })
})

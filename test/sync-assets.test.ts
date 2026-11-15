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

  it('白名单根目录本身是符号链接：不跟随、不入包、不打断收集（与内部软链同口径）', () => {
    const home = mkHome()
    // 软链根指向 ~/.modeldock（排除段）：secrets.json 不得收进包里；跳过但不 throw——
    // throw 会把整条多机同步打停（providers/profiles 陪葬），软链挂载（~/skills → 别处）是合法形态
    write(home, ['.modeldock', 'secrets.json'], '{"k":"v"}')
    write(home, ['skills2', 'a.md'], 'hello')
    let linked = false
    try {
      fs.symlinkSync(path.join(home, '.modeldock'), path.join(home, 'skills'))
      linked = true
    } catch {
      /* Windows 无符号链接权限：跳过该断言 */
    }
    if (linked) {
      const warnings: string[] = []
      const a = collectAssetFiles(['skills', 'skills2'], { onWarning: (l) => warnings.push(l) })
      expect(Object.keys(a.files)).toEqual(['skills2/a.md']) // 软链根跳过，其余目录照常收集
      expect(a.skipped.some((s) => s.startsWith('skills/'))).toBe(true) // 诊断进 skipped 报告
      expect(warnings.join('\n')).toContain('skills') // 诊断同时走日志钩子
      expect(JSON.stringify(a.files)).not.toContain('secrets') // 安全属性：密钥不入包
    }
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
      // NTFS 不认权限位：仅 POSIX 断言。新文件缺省 0644（不再 0600 强制改写——
      // 白名单资产含脚本，跨机同步不该丢可执行位/共享位）
      expect(fs.statSync(path.join(home, '.claude', 'CLAUDE.md')).mode & 0o777).toBe(0o644)
    }

    // 内容一致：零写入
    const r2 = await applySyncdoc(fakeDoc({ '.agents/skills/demo/SKILL.md': 'demo', '.claude/CLAUDE.md': '# new content' }), { backend: 'file' })
    expect(r2.assetsWritten).toBe(0)
  })

  it('保留既有文件权限位：0755 脚本同步后仍可执行（对照 restoreSnapshot 保留 rec.mode 口径）', async () => {
    const home = mkHome()
    await saveConfig(emptyConfig())
    const script = path.join(home, '.agents', 'skills', 'demo', 'run.sh')
    write(home, ['.agents', 'skills', 'demo', 'run.sh'], '#!/bin/sh\necho v1\n')
    if (process.platform !== 'win32') fs.chmodSync(script, 0o755)

    const r = await applySyncdoc(fakeDoc({ '.agents/skills/demo/run.sh': '#!/bin/sh\necho v2\n' }), { backend: 'file' })
    expect(r.assetsWritten).toBe(1)
    if (process.platform !== 'win32') {
      // 旧实现 0600 强制改写会把可执行位打掉；现在既有 mode 原样保留
      expect(fs.statSync(script).mode & 0o777).toBe(0o755)
      expect(fs.readFileSync(script, 'utf8')).toBe('#!/bin/sh\necho v2\n')
    }
  })

  it('applyAssets 自身防线：不安全 key / 超限内容拒绝，不做任何写入', async () => {
    mkHome()
    await expect(applyAssets({ '../evil.md': 'x' })).rejects.toThrow()
    await expect(applyAssets({ 'big.md': 'a'.repeat(ASSET_MAX_FILE_BYTES + 1) })).rejects.toThrow()
  })
})

describe('applyAssets 导入侧软链守卫（写穿防线，跳过+告警口径对齐导出侧 139d01f）', () => {
  function trySymlink(target: string, linkPath: string): boolean {
    try {
      fs.symlinkSync(target, linkPath)
      return true
    } catch {
      /* Windows 无符号链接权限：按 a3d24c2 先例跳过该用例 */
      return false
    }
  }

  it('中间目录是符号链接：该 key 拒写并告警、软链指向处零落盘；同包其余 key 照常写入（故障隔离）', async () => {
    const home = mkHome()
    fs.mkdirSync(path.join(home, 'elsewhere'), { recursive: true })
    if (!trySymlink(path.join(home, 'elsewhere'), path.join(home, 'skills'))) return
    const warnings: string[] = []
    const r = await applyAssets(
      { 'skills/a.md': 'punch through', '.claude/CLAUDE.md': '# ok' },
      { onWarning: (l) => warnings.push(l) }
    )
    // 故障隔离：正常 key 照常写入
    expect(r.written).toEqual(['.claude/CLAUDE.md'])
    expect(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# ok')
    // 软链段 key 拒写：进 skipped（带原因）+ 告警双通道
    expect(r.skipped.map((s) => s.key)).toEqual(['skills/a.md'])
    expect(r.skipped[0].reason).toContain('skills/a.md')
    expect(warnings.join('\n')).toContain('skills/a.md')
    expect(warnings.join('\n')).toContain('软链')
    // 软链指向处零落盘，软链本身未被 mkdirSync 顶掉
    expect(fs.readdirSync(path.join(home, 'elsewhere'))).toEqual([])
    expect(fs.lstatSync(path.join(home, 'skills')).isSymbolicLink()).toBe(true)
  })

  it('~/skills → ~/.modeldock：包内 skills/config.toml 不得写穿覆盖真实 ~/.modeldock/config.toml', async () => {
    const home = mkHome()
    write(home, ['.modeldock', 'config.toml'], 'real config')
    if (!trySymlink(path.join(home, '.modeldock'), path.join(home, 'skills'))) return
    const warnings: string[] = []
    const r = await applyAssets(
      { 'skills/config.toml': 'EVIL', '.claude/keep.md': 'fine' },
      { onWarning: (l) => warnings.push(l) }
    )
    // isSafeAssetKey 只看字符串段（'skills' 非排除段）拦不住——fs 软链守卫必须在写入前拦下
    expect(fs.readFileSync(path.join(home, '.modeldock', 'config.toml'), 'utf8')).toBe('real config')
    expect(r.skipped.map((s) => s.key)).toContain('skills/config.toml')
    expect(r.written).toEqual(['.claude/keep.md'])
    expect(warnings.join('\n')).toContain('skills/config.toml')
  })

  it('最终段是文件符号链接：同样拒写，软链本身不被 rename 顶掉、指向文件原样', async () => {
    const home = mkHome()
    write(home, ['.modeldock', 'config.toml'], 'real config')
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    if (!trySymlink(path.join(home, '.modeldock', 'config.toml'), path.join(home, '.claude', 'CLAUDE.md'))) return
    const r = await applyAssets({ '.claude/CLAUDE.md': 'NEW' })
    expect(r.skipped.map((s) => s.key)).toEqual(['.claude/CLAUDE.md'])
    expect(r.written).toEqual([])
    expect(fs.readlinkSync(path.join(home, '.claude', 'CLAUDE.md'))).toBe(path.join(home, '.modeldock', 'config.toml'))
    expect(fs.readFileSync(path.join(home, '.modeldock', 'config.toml'), 'utf8')).toBe('real config')
  })

  it('无软链路径行为零变化：照常写入、skipped 为空、无告警；unchanged 口径不变', async () => {
    const home = mkHome()
    const warnings: string[] = []
    const r = await applyAssets(
      { '.claude/CLAUDE.md': '# v1', '.agents/skills/s.md': 'x' },
      { onWarning: (l) => warnings.push(l) }
    )
    expect(r.written.sort()).toEqual(['.agents/skills/s.md', '.claude/CLAUDE.md'])
    expect(r.unchanged).toBe(0)
    expect(r.skipped).toEqual([])
    expect(warnings).toEqual([])
    expect(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# v1')
    const r2 = await applyAssets({ '.claude/CLAUDE.md': '# v1' })
    expect(r2.unchanged).toBe(1)
    expect(r2.written).toEqual([])
    expect(r2.skipped).toEqual([])
  })

  it('applySyncdoc 透传 log：资产软链告警经 log 钩子可达（engine 网关日志 / CLI 打印的公共底座）', async () => {
    const home = mkHome()
    await saveConfig(emptyConfig())
    // 软链目标是沙箱的 ~/.modeldock 数据目录：内容须是合法 TOML（applySyncdoc 内部 loadConfig 要读它）
    write(home, ['.modeldock', 'config.toml'], 'language = "zh"\n')
    if (!trySymlink(path.join(home, '.modeldock'), path.join(home, 'skills'))) return
    const logs: string[] = []
    const r = await applySyncdoc(
      fakeDoc({ 'skills/config.toml': 'EVIL', '.claude/ok.md': 'fine' }),
      { backend: 'file', log: (l) => logs.push(l) }
    )
    expect(r.assetsWritten).toBe(1)
    expect(logs.join('\n')).toContain('skills/config.toml')
    // applySyncdoc 的 mutateConfig 会整包重序列化 config.toml，精确内容不比对——只断言包内
    // EVIL 内容未写穿进真实配置
    expect(fs.readFileSync(path.join(home, '.modeldock', 'config.toml'), 'utf8')).not.toContain('EVIL')
  })
})

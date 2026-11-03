import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { changedFiles, gateCliEntry, gateLint, gateNativeScan, gatePortScan, gateScopePurity, gateTypecheck, globToRegExp, runCmd, GateError } from '../../.agents/scripts/orchestrator/gates.mjs'
import { git, mkRepo } from './helpers.js'

/** 在临时仓库建 feature 分支并写一组文件提交，供门禁 diff 检查。 */
function featureCommit(repo: string, files: Record<string, string>) {
  git(repo, 'checkout -b feature/gates')
  for (const [f, content] of Object.entries(files)) {
    const p = path.join(repo, f)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  git(repo, 'add -A')
  git(repo, `commit -m "gate fixture ${Object.keys(files).join(',')}"`)
}

describe('orchestrator gates > glob 匹配', () => {
  it('**/精确/单段 * 的行为', () => {
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true)
    expect(globToRegExp('src/**').test('docs/x.md')).toBe(false)
    expect(globToRegExp('test/*.test.ts').test('test/a.test.ts')).toBe(true)
    expect(globToRegExp('test/*.test.ts').test('test/a/b.test.ts')).toBe(false)
    expect(globToRegExp('src/cli.ts').test('src/cli.ts')).toBe(true)
  })
})

describe('orchestrator gates > runCmd', () => {
  it('成功与失败各返回 ok/output', async () => {
    const ok = await runCmd('node -e "process.stdout.write(\'hi\')"', process.cwd())
    expect(ok.ok).toBe(true)
    expect(ok.output).toContain('hi')
    const bad = await runCmd('node -e "process.exit(3)"', process.cwd())
    expect(bad.ok).toBe(false)
    expect(bad.exitCode).toBe(3)
  })

  it('超时：命令按进程树终止并带超时标记（runCmd 已异步化，spawnSync 杀不到孙进程树的回归）', async () => {
    const t0 = Date.now()
    const r = await runCmd('node -e "setTimeout(() => {}, 60000)"', process.cwd(), 1500)
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(124)
    expect(r.output).toContain('超时')
    expect(Date.now() - t0).toBeLessThan(15000) // 及时返回，不等满 60s
  })
})

describe('orchestrator gates > port_scan（限定 src/**）', () => {
  it('src 新增 listen(8687) → 抛红线 GateError', () => {
    const repo = mkRepo()
    try {
      featureCommit(repo.root, { 'src/bad.ts': `const s = net.createServer()\ns.listen(8687, '127.0.0.1')\n` })
      expect(() => gatePortScan(repo.root)).toThrowError(/port_scan.*8687/)
    } finally {
      repo.cleanup()
    }
  })

  it('文档/测试合法提及 8687 → 通过（防误杀）', () => {
    const repo = mkRepo()
    try {
      featureCommit(repo.root, {
        'docs/port.md': '生产端口是 8687，dev 是 8890。\n',
        'test/gw.test.ts': `// 测试不监听 8687\nexpect(8687).toBe(8687)\n`,
        'src/ok.ts': 'export const note = "见 AGENTS.md 8687 红线"\n',
      })
      const r = gatePortScan(repo.root)
      expect(r.ok).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('protectedPorts 空 → 跳过（可移植缺省：无配置不做端口红线）', () => {
    const repo = mkRepo()
    try {
      featureCommit(repo.root, { 'src/bad.ts': `s.listen(8687, '127.0.0.1')\n` })
      expect(gatePortScan(repo.root, 'develop', [])).toMatchObject({ ok: true, skipped: true })
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator gates > native_scan', () => {
  it('未触及 package.json → checked:false', () => {
    const repo = mkRepo()
    try {
      featureCommit(repo.root, { 'src/a.ts': 'x\n' })
      expect(gateNativeScan(repo.root)).toMatchObject({ ok: true, checked: false })
    } finally {
      repo.cleanup()
    }
  })

  it('packageManager 非 npm 系 → 跳过（可移植缺省：非 Node 项目不做 native 扫描）', () => {
    const repo = mkRepo()
    try {
      featureCommit(repo.root, { 'package.json': JSON.stringify({ name: 'x', dependencies: { 'evil-native': '^1' } }) })
      fs.mkdirSync(path.join(repo.root, 'node_modules', 'evil-native'), { recursive: true })
      fs.writeFileSync(path.join(repo.root, 'node_modules', 'evil-native', 'binding.gyp'), '{}')
      expect(gateNativeScan(repo.root, 'develop', 'cargo')).toMatchObject({ ok: true, skipped: true })
    } finally {
      repo.cleanup()
    }
  })

  it('新增依赖含 binding.gyp/.node → 红线 failed', () => {
    const repo = mkRepo()
    try {
      // 在 feature 分支上改 package.json（新增依赖）+ 伪造 node_modules 里的 native 痕迹
      featureCommit(repo.root, { 'package.json': JSON.stringify({ name: 'x', dependencies: { 'evil-native': '^1' } }) })
      fs.mkdirSync(path.join(repo.root, 'node_modules', 'evil-native'), { recursive: true })
      fs.writeFileSync(path.join(repo.root, 'node_modules', 'evil-native', 'binding.gyp'), '{}')
      expect(() => gateNativeScan(repo.root)).toThrowError(/native_scan.*evil-native/)
    } finally {
      repo.cleanup()
    }
  })

  it('新增纯 JS 依赖（无 native 痕迹）→ 通过', () => {
    const repo = mkRepo()
    try {
      featureCommit(repo.root, { 'package.json': JSON.stringify({ name: 'x', dependencies: { 'pure-js': '^1' } }) })
      fs.mkdirSync(path.join(repo.root, 'node_modules', 'pure-js'), { recursive: true })
      fs.writeFileSync(path.join(repo.root, 'node_modules', 'pure-js', 'index.js'), 'export {}')
      expect(gateNativeScan(repo.root)).toMatchObject({ ok: true, checked: true, newDeps: ['pure-js'] })
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator gates > scope_purity / cli_entry', () => {
  it('越界文件列出；src/cli.ts 触及被标记', () => {
    const repo = mkRepo()
    try {
      featureCommit(repo.root, {
        'src/allowed.ts': 'x\n',
        'src/cli.ts': '// touched\n',
        'docs/stray.md': '越界\n',
      })
      const purity = gateScopePurity(repo.root, ['src/allowed.ts', 'src/cli.ts'])
      expect(purity.outside).toEqual(['docs/stray.md'])
      // cli_entry 新契约：返回被触及的核心路径列表（缺省读 workflow.json corePaths）
      expect(gateCliEntry(repo.root)).toEqual(['src/cli.ts'])
      expect(gateCliEntry(repo.root, 'develop', ['not/here.ts'])).toEqual([])
      expect(changedFiles(repo.root)).toContain('src/cli.ts')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator gates > lint / typecheck（未配置跳过、失败可调试）', () => {
  it('未配置（null）→ skipped，不抛错', async () => {
    const repo = mkRepo()
    try {
      await expect(gateLint(repo.root, null)).resolves.toMatchObject({ ok: true, skipped: true })
      await expect(gateTypecheck(repo.root, null)).resolves.toMatchObject({ ok: true, skipped: true })
    } finally {
      repo.cleanup()
    }
  })

  it('命令通过返回 ok；失败抛 GateError（gate 名对应、output 带命令输出）', async () => {
    const repo = mkRepo()
    try {
      expect((await gateLint(repo.root, 'node -e "process.stdout.write(\'lint-ok\')"')).ok).toBe(true)
      expect((await gateTypecheck(repo.root, 'node -e "process.exit(0)"')).ok).toBe(true)
      try {
        await gateTypecheck(repo.root, 'node -e "process.stderr.write(\'ts-error\'); process.exit(2)"')
        expect.unreachable('应当抛出 GateError')
      } catch (e) {
        expect(e).toBeInstanceOf(GateError)
        expect(e.gate).toBe('typecheck')
        expect(e.output).toContain('ts-error')
      }
      try {
        await gateLint(repo.root, 'node -e "process.exit(1)"')
        expect.unreachable('应当抛出 GateError')
      } catch (e) {
        expect(e).toBeInstanceOf(GateError)
        expect(e.gate).toBe('lint')
      }
    } finally {
      repo.cleanup()
    }
  })
})

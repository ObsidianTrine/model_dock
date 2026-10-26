// agent-init 测试：新项目落地脚本端到端（子进程跑真实脚本，无 mock）。
// 覆盖：workflow.json 生成（探测缺省 + flag 覆盖）、双客户端 hook 合并式注册（幂等、
// 保留既有配置、损坏 JSON 容错）、AGENTS.md 骨架（缺失才写）、前置校验可操作报错。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WORKTREE_ROOT = path.resolve(process.cwd()) // vitest 的 cwd = 仓库根（worktree 内）
const AGENT_INIT = path.join(WORKTREE_ROOT, '.agents', 'scripts', 'agent-init.mjs')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

function runInit(fixture: string, args: string[] = []): RunResult {
  // spawnSync 而非 execFileSync：成功路径也要收 stderr（告警走 console.error 且 exit 0）
  const r = spawnSync('node', [AGENT_INIT, ...args], { cwd: fixture, encoding: 'utf8' })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 最小目标项目夹具：.agents/scripts 占位（init 只探测存在性）+ 可选 package.json / lockfile / .github。 */
function mkFixture(opts: { packageJson?: Record<string, unknown>; lockfile?: string; github?: boolean; zcode?: string; claude?: string; agentsMd?: boolean } = {}): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-init-'))
  fs.mkdirSync(path.join(root, '.agents', 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(root, '.agents', 'scripts', 'feature-branch.mjs'), '// fixture stub\n')
  if (opts.packageJson) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(opts.packageJson))
  if (opts.lockfile) fs.writeFileSync(path.join(root, opts.lockfile), '')
  if (opts.github) fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true })
  if (opts.zcode !== undefined) {
    fs.mkdirSync(path.join(root, '.zcode'), { recursive: true })
    fs.writeFileSync(path.join(root, '.zcode', 'config.json'), opts.zcode)
  }
  if (opts.claude !== undefined) {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), opts.claude)
  }
  if (opts.agentsMd) fs.writeFileSync(path.join(root, 'AGENTS.md'), '# 既有指南\n')
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))

describe('agent-init > workflow.json 生成', () => {
  it('--defaults：探测缺省全生效（package.json/lockfile/.github），version=1', () => {
    const f = mkFixture({
      packageJson: { name: 'my-app', scripts: { test: 'node test.js', build: 'node build.js' } },
      lockfile: 'package-lock.json',
      github: true,
    })
    try {
      const r = runInit(f.root, ['--defaults'])
      expect(r.status).toBe(0)
      const cfg = readJson(path.join(f.root, '.agents', 'workflow.json'))
      expect(cfg).toMatchObject({
        version: 1,
        projectName: 'my-app',
        baseBranch: 'develop', // 无 git 仓库 → 缺省 develop
        testCmd: 'node test.js',
        setupCmd: 'npm ci --prefer-offline',
        buildCmd: 'node build.js',
        packageManager: 'npm',
        releasePaths: ['.github/workflows/'],
      })
      // 关闭型缺省：未问到的红线字段一律不出现（缺省即关闭）
      expect(cfg.protectedPorts).toBeUndefined()
      expect(cfg.corePaths).toBeUndefined()
      expect(cfg.gatewayLogDir).toBeUndefined()
      expect(r.stdout).toContain('手工收尾清单')
    } finally {
      f.cleanup()
    }
  })

  it('flag 覆盖：--protected-ports/--review-notes/--base-branch/--env-prefix 优先于探测', () => {
    const f = mkFixture({ packageJson: { name: 'my-app', scripts: { test: 'node test.js' } } })
    try {
      const r = runInit(f.root, ['--defaults', '--base-branch', 'main', '--protected-ports', '7000, 7001', '--review-notes', '端口 7000 红线', '--env-prefix', 'MYTEAM'])
      expect(r.status).toBe(0)
      const cfg = readJson(path.join(f.root, '.agents', 'workflow.json'))
      expect(cfg.baseBranch).toBe('main')
      expect(cfg.protectedPorts).toEqual(['7000', '7001'])
      expect(cfg.reviewNotes).toBe('端口 7000 红线')
      expect(cfg.envPrefix).toBe('MYTEAM')
    } finally {
      f.cleanup()
    }
  })

  it('已存在 workflow.json（无 --force）→ exit 1 可操作报错，不覆盖', () => {
    const f = mkFixture({ packageJson: { name: 'my-app', scripts: {} } })
    try {
      expect(runInit(f.root, ['--defaults']).status).toBe(0)
      const wfPath = path.join(f.root, '.agents', 'workflow.json')
      const before = fs.readFileSync(wfPath, 'utf8')
      const r2 = runInit(f.root, ['--defaults'])
      expect(r2.status).toBe(1)
      expect(r2.stderr).toContain('--force')
      expect(fs.readFileSync(wfPath, 'utf8')).toBe(before)
      // --force 重生成成功
      expect(runInit(f.root, ['--defaults', '--force']).status).toBe(0)
    } finally {
      f.cleanup()
    }
  })

  it('.agents 未拷贝 → exit 1 指向拷贝步骤', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-init-empty-'))
    try {
      const r = runInit(root, ['--defaults'])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('cp -r')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('agent-init > hook 注册（合并式、幂等、保留既有配置）', () => {
  it('双客户端注册齐全；既有无关配置原样保留；--force 重跑不产生重复条目', () => {
    const f = mkFixture({
      packageJson: { name: 'my-app', scripts: {} },
      zcode: JSON.stringify({ language: 'zh', hooks: { enabled: false, events: { PreToolUse: [] } } }),
      claude: JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }),
    })
    try {
      expect(runInit(f.root, ['--defaults']).status).toBe(0)
      const zc = readJson(path.join(f.root, '.zcode', 'config.json'))
      expect(zc.language).toBe('zh') // 无关字段保留
      expect(zc.hooks.enabled).toBe(true) // 被纠正为 true（enabled false 时 hook 不运行）
      const zcMatchers = zc.hooks.events.PreToolUse.map((e: { matcher: string }) => e.matcher)
      expect(zcMatchers).toContain('Edit|Write|MultiEdit|NotebookEdit')
      expect(zcMatchers).toContain('Bash')
      const cl = readJson(path.join(f.root, '.claude', 'settings.json'))
      expect(cl.permissions.allow).toEqual(['Bash(npm test)']) // 既有配置保留
      const clMatchers = cl.hooks.PreToolUse.map((e: { matcher: string }) => e.matcher)
      expect(clMatchers).toContain('Bash')

      const countCommands = (entries: Array<{ hooks: Array<{ command: string }> }>) =>
        entries.flatMap((e) => e.hooks).filter((h) => h.command.includes('policy-zcode')).length
      expect(countCommands(zc.hooks.events.PreToolUse)).toBe(1)
      expect(countCommands(cl.hooks.PreToolUse)).toBe(1)

      // --force 重跑：同 matcher+command 去重，不翻倍
      expect(runInit(f.root, ['--defaults', '--force']).status).toBe(0)
      const zc2 = readJson(path.join(f.root, '.zcode', 'config.json'))
      expect(countCommands(zc2.hooks.events.PreToolUse)).toBe(1)
    } finally {
      f.cleanup()
    }
  })

  it('既有 zcode 配置损坏 JSON → 告警跳过不炸，claude 侧照常注册', () => {
    const f = mkFixture({ packageJson: { name: 'my-app', scripts: {} }, zcode: '{ not json' })
    try {
      const r = runInit(f.root, ['--defaults'])
      expect(r.status).toBe(0)
      expect(r.stderr).toContain('config.json')
      expect(fs.readFileSync(path.join(f.root, '.zcode', 'config.json'), 'utf8')).toBe('{ not json') // 不覆盖
      const cl = readJson(path.join(f.root, '.claude', 'settings.json'))
      expect(cl.hooks.PreToolUse.length).toBeGreaterThan(0)
    } finally {
      f.cleanup()
    }
  })
})

describe('agent-init > AGENTS.md 骨架', () => {
  it('缺失才生成（含项目名与红线占位）；已存在保持不动', () => {
    const f = mkFixture({ packageJson: { name: 'my-app', scripts: {} }, agentsMd: true })
    try {
      expect(runInit(f.root, ['--defaults']).status).toBe(0)
      expect(fs.readFileSync(path.join(f.root, 'AGENTS.md'), 'utf8')).toBe('# 既有指南\n')
      // --skip-agents-md 也不生成
      const f2 = mkFixture({ packageJson: { name: 'app2', scripts: {} } })
      try {
        expect(runInit(f2.root, ['--defaults', '--skip-agents-md']).status).toBe(0)
        expect(fs.existsSync(path.join(f2.root, 'AGENTS.md'))).toBe(false)
        expect(runInit(f2.root, ['--defaults', '--force']).status).toBe(0)
        const md = fs.readFileSync(path.join(f2.root, 'AGENTS.md'), 'utf8')
        expect(md).toContain('# app2 — 项目指南')
        expect(md).toContain('feature-branch.mjs start')
      } finally {
        f2.cleanup()
      }
    } finally {
      f.cleanup()
    }
  })
})

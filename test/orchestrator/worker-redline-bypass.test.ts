// P0 修复回归：worker 红线间接旁路收敛（2026-11）。
// 威胁模型：headless worker 有 worktree 内 Edit/Write 权限——
//   ① 把 git push 夹进 package.json 的 scripts.test 再跑白名单 `npm test`
//     （命令前缀白名单与 hook 都只看命令文本，脚本载荷不可见）；
//   ② 篡改 worktree 内 hook/policy 副本使拦截失效（hook 经相对 import 载入副本）。
// 收敛：writeWorkerSettings 把 hook 命令锚定主仓（worker 写不到）；hook 放行脚本执行
// 类命令前做环境校验（package.json 相对 HEAD 的 scripts diff + hook/policy 完整性）。
// hook 以子进程方式端到端测试（cwd/输入可控）；裁决走 policy.mjs 同一来源。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkRepo, git } from './helpers.js'
import {
  hookIntegrityVerdict,
  scriptsTamperVerdict,
  triggersScriptExecGuard,
} from '../../.agents/scripts/policy.mjs'
import { workerHookCommand, writeWorkerSettings } from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'

const WT_ROOT = path.resolve(process.cwd()) // vitest cwd = 仓库根（worktree 内）
const SRC_HOOK = path.join(WT_ROOT, '.agents', 'hooks', 'policy-worker.mjs')

/** 带完整 hook 副本的测试仓库（生产形态：.agents/hooks/ 随仓库 checkout）。 */
function mkHookRepo() {
  const repo = mkRepo()
  fs.mkdirSync(path.join(repo.root, '.agents', 'hooks'), { recursive: true })
  fs.copyFileSync(SRC_HOOK, path.join(repo.root, '.agents', 'hooks', 'policy-worker.mjs'))
  git(repo.root, 'add -A')
  git(repo.root, 'commit -m hook')
  return repo
}

/** 跑 hook 子进程：stdin 喂 PreToolUse 事件，返回 exit 与 stderr。 */
function runHook(hookPath: string, cwd: string, command: string, tool = 'Bash') {
  const r = spawnSync('node', [hookPath], {
    cwd,
    input: JSON.stringify({ tool_name: tool, cwd, tool_input: { command } }),
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  return { exit: r.status ?? 1, stderr: r.stderr ?? '' }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('worker 红线旁路收敛 > package.json scripts 篡改', () => {
  it('未提交篡改 scripts.test → npm test 被 hook 拦截（exit 2，指明 package.json 与恢复办法）', () => {
    const repo = mkHookRepo()
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repo.root, 'package.json'), 'utf8'))
      pkg.scripts.test = 'git push origin main && echo pwned'
      fs.writeFileSync(path.join(repo.root, 'package.json'), JSON.stringify(pkg))
      const r = runHook(path.join(repo.root, '.agents', 'hooks', 'policy-worker.mjs'), repo.root, 'npm test')
      expect(r.exit).toBe(2)
      expect(r.stderr).toContain('package.json')
      expect(r.stderr).toContain('git commit')
    } finally {
      repo.cleanup()
    }
  })

  it('篡改已提交 → 放行（合法 deps 任务的正常路径；提交内容由 L2 人工门禁兜底）', () => {
    const repo = mkHookRepo()
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repo.root, 'package.json'), 'utf8'))
      pkg.scripts.test = 'node -e "process.exit(0)"'
      fs.writeFileSync(path.join(repo.root, 'package.json'), JSON.stringify(pkg))
      git(repo.root, 'add package.json')
      git(repo.root, 'commit -m deps')
      const r = runHook(path.join(repo.root, '.agents', 'hooks', 'policy-worker.mjs'), repo.root, 'npm test')
      expect(r.exit).toBe(0)
    } finally {
      repo.cleanup()
    }
  })

  it('git add 暂存未提交仍拦（diff HEAD 覆盖暂存区）', () => {
    const repo = mkHookRepo()
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repo.root, 'package.json'), 'utf8'))
      pkg.scripts.test = 'node -e "process.exit(0)"'
      fs.writeFileSync(path.join(repo.root, 'package.json'), JSON.stringify(pkg))
      git(repo.root, 'add package.json')
      const r = runHook(path.join(repo.root, '.agents', 'hooks', 'policy-worker.mjs'), repo.root, 'npm test')
      expect(r.exit).toBe(2)
    } finally {
      repo.cleanup()
    }
  })

  it('其他文件未提交改动不拦（校验只看 package.json，正常开发流不受影响）', () => {
    const repo = mkHookRepo()
    try {
      fs.appendFileSync(path.join(repo.root, 'README.md'), '\nchange\n')
      const r = runHook(path.join(repo.root, '.agents', 'hooks', 'policy-worker.mjs'), repo.root, 'npm test')
      expect(r.exit).toBe(0)
    } finally {
      repo.cleanup()
    }
  })
})

describe('worker 红线旁路收敛 > hook/policy 完整性（worktree 相对路径回退形态）', () => {
  /** 主仓 + linked worktree（hook 副本随提交进入 worktree，模拟旧版相对路径注册形态）。 */
  function mkWorktreeFixture() {
    const repo = mkHookRepo()
    const wt = path.join(repo.root, '.agents', 'worktrees', 'integrity-probe')
    git(repo.root, `worktree add -b integrity-probe "${wt}"`)
    return { repo, wt }
  }

  it('干净 worktree 基线 → npm test 放行', () => {
    const { repo, wt } = mkWorktreeFixture()
    try {
      const r = runHook(path.join(wt, '.agents', 'hooks', 'policy-worker.mjs'), wt, 'npm test')
      expect(r.exit).toBe(0)
    } finally {
      repo.cleanup()
    }
  })

  it('篡改 worktree 内 policy.mjs（hook import 的策略文件）→ 拦截；还原 → 放行', () => {
    const { repo, wt } = mkWorktreeFixture()
    try {
      const hook = path.join(wt, '.agents', 'hooks', 'policy-worker.mjs')
      fs.appendFileSync(path.join(wt, '.agents', 'scripts', 'policy.mjs'), '\n// tampered\n')
      const blocked = runHook(hook, wt, 'npm test')
      expect(blocked.exit).toBe(2)
      expect(blocked.stderr).toContain('policy.mjs')
      git(wt, 'checkout -- .agents/scripts/policy.mjs')
      expect(runHook(hook, wt, 'npm test').exit).toBe(0)
    } finally {
      repo.cleanup()
    }
  })

  it('篡改 hook 自身（语法有效改动）→ 拦截；还原 → 放行', () => {
    const { repo, wt } = mkWorktreeFixture()
    try {
      const hook = path.join(wt, '.agents', 'hooks', 'policy-worker.mjs')
      fs.appendFileSync(hook, '\n// tampered\n')
      const blocked = runHook(hook, wt, 'npm test')
      expect(blocked.exit).toBe(2)
      expect(blocked.stderr).toContain('policy-worker.mjs')
      git(wt, 'checkout -- .agents/hooks/policy-worker.mjs')
      expect(runHook(hook, wt, 'npm test').exit).toBe(0)
    } finally {
      repo.cleanup()
    }
  })

  it('非 git 会话目录（无基线）整体跳过环境校验——npm test 照常放行', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-nogit-'))
    try {
      expect(runHook(SRC_HOOK, dir, 'npm test').exit).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('worker 红线旁路收敛 > hook 命令锚定主仓', () => {
  it('worktree 会话 → hook 命令为主仓绝对路径（worker 写不到的副本）', () => {
    const repo = mkHookRepo()
    try {
      const wt = path.join(repo.root, '.agents', 'worktrees', 'anchor-probe')
      git(repo.root, `worktree add -b anchor-probe "${wt}"`)
      const cmd = workerHookCommand(wt)
      expect(cmd.startsWith('node "')).toBe(true)
      expect(cmd).toContain(path.join(repo.root, '.agents', 'hooks', 'policy-worker.mjs').replace(/\\/g, '/'))
    } finally {
      repo.cleanup()
    }
  })

  it('主仓会话 → 自身绝对路径；非 git 会话 → 回退相对路径（hook 侧完整性校验兜底）', () => {
    const repo = mkHookRepo()
    try {
      expect(workerHookCommand(repo.root)).toContain('/.agents/hooks/policy-worker.mjs')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-nogit-'))
      try {
        expect(workerHookCommand(dir)).toBe('node .agents/hooks/policy-worker.mjs')
        expect(workerHookCommand(null)).toBe('node .agents/hooks/policy-worker.mjs')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      repo.cleanup()
    }
  })

  it('writeWorkerSettings 写入锚定命令（settings 结构不变）', () => {
    const repo = mkHookRepo()
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-settings-'))
      try {
        const p = path.join(dir, 'worker-settings.json')
        writeWorkerSettings(p, { ANTHROPIC_AUTH_TOKEN: 'tok' }, repo.root)
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
        expect(parsed.hooks.PreToolUse[0].matcher).toBe('Bash|PowerShell')
        expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe(workerHookCommand(repo.root))
        expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe('tok')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      repo.cleanup()
    }
  })
})

describe('worker 红线旁路收敛 > 触发器与校验函数（纯函数）', () => {
  const cfg = { testCmd: ['npx vitest run'], buildCmd: 'npm run build', lintCmd: null, typecheckCmd: null }

  it('triggersScriptExecGuard：npm 家族全认（含 install 生命周期脚本），testCmd/buildCmd 前缀认，其他不认', () => {
    expect(triggersScriptExecGuard('npm test', cfg)).toBe(true)
    expect(triggersScriptExecGuard('npm run build', cfg)).toBe(true)
    expect(triggersScriptExecGuard('npm install', cfg)).toBe(true)
    expect(triggersScriptExecGuard('VAR=x npm test', cfg)).toBe(true)
    expect(triggersScriptExecGuard('npx vitest run test/a.test.ts', cfg)).toBe(true)
    expect(triggersScriptExecGuard('npm run build:sea', cfg)).toBe(true) // npm 家族：任意 run 脚本都触发（保守从严）
    expect(triggersScriptExecGuard('npx vitest', cfg)).toBe(false) // 非家族首词且非 testCmd 词边界前缀
    expect(triggersScriptExecGuard('git add -A', cfg)).toBe(false)
    expect(triggersScriptExecGuard('npx prettier --write .', cfg)).toBe(false)
    expect(triggersScriptExecGuard('', cfg)).toBe(false)
  })

  it('scriptsTamperVerdict / hookIntegrityVerdict：非 git 会话返回 null（不适用）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-nogit-'))
    try {
      expect(scriptsTamperVerdict(dir)).toBeNull()
      expect(hookIntegrityVerdict(SRC_HOOK, dir)).toBeNull()
      expect(scriptsTamperVerdict('')).toBeNull()
      expect(hookIntegrityVerdict('', dir)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scriptsTamperVerdict：干净仓库 null，篡改后给可操作 verdict', () => {
    const repo = mkHookRepo()
    try {
      expect(scriptsTamperVerdict(repo.root)).toBeNull()
      const pkg = JSON.parse(fs.readFileSync(path.join(repo.root, 'package.json'), 'utf8'))
      pkg.scripts.test = 'git push origin main'
      fs.writeFileSync(path.join(repo.root, 'package.json'), JSON.stringify(pkg))
      const v = scriptsTamperVerdict(repo.root)
      expect(v?.rule).toBe('scripts-tamper')
      expect(v?.reason).toContain('package.json')
      expect(v?.advice).toContain('git commit')
    } finally {
      repo.cleanup()
    }
  })
})

// spawn-shell（agents-crossplatform-spawn）定向回归：
// 1) Windows .cmd 包装命令（npm/claude）的 spawn shell 分支——纯函数断言，任意 OS 可跑；
// 2) findRepoRoot 双实现统一（--git-common-dir 语义）——linked worktree 内跑真实脚本，
//    断言 queue/worktree 都锚在主仓库而非 worktree（--show-toplevel 旧行为会锚进 worktree）。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { buildClaudeArgs, claudeSpawnInvocation } from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'
import { quoteArgsForShell, shellSpawnOptions } from '../../.agents/scripts/orchestrator/spawn-shell.mjs'
import { git, mkRepo } from './helpers.js'

describe('spawn-shell > shellSpawnOptions 平台分支', () => {
  it('win32 补 shell: true；unix 不加（sh -c 会改变进程组/信号语义，杀树依赖进程组）', () => {
    const base = { cwd: '/x', stdio: 'inherit' }
    expect(shellSpawnOptions('win32', base)).toEqual({ cwd: '/x', stdio: 'inherit', shell: true })
    expect(shellSpawnOptions('linux', base)).toEqual({ cwd: '/x', stdio: 'inherit' })
    expect(shellSpawnOptions('darwin', base)).toEqual({ cwd: '/x', stdio: 'inherit' })
    expect(shellSpawnOptions('win32')).toEqual({ shell: true })
  })
})

describe('spawn-shell > claudeSpawnInvocation 双分支', () => {
  it('win32：shell: true + detached 关 + 含空格参数包引号；unix：无 shell + detached + args 原样', () => {
    const args = buildClaudeArgs({ maxTurns: 5, settingsFile: '/tmp/dir with space/settings.json' })
    const win = claudeSpawnInvocation('win32', args, { cwd: '/wt', envPatch: { TEST_TOKEN: 'tk' } })
    expect(win.cmd).toBe('claude')
    expect(win.options.shell).toBe(true)
    expect(win.options.detached).toBe(false)
    expect(win.options.cwd).toBe('/wt')
    expect(win.options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(win.options.env).toEqual(expect.objectContaining({ TEST_TOKEN: 'tk' }))
    // --allowedTools 的 "Bash(git add:*)" 族与 --settings 路径含空格 → 包引号（否则拼行被拆）
    const settingsIdx = win.args.indexOf('--settings')
    expect(settingsIdx).toBeGreaterThan(-1)
    expect(win.args[settingsIdx + 1]).toBe('"/tmp/dir with space/settings.json"')
    expect(win.args).toContain('"Bash(git add:*)"')

    const unix = claudeSpawnInvocation('darwin', args, { cwd: '/wt', envPatch: { TEST_TOKEN: 'tk' } })
    expect('shell' in unix.options).toBe(false)
    expect(unix.options.detached).toBe(true)
    expect(unix.args).toEqual(args)
  })

  it('quoteArgsForShell：不含空格/引号的参数原样；内部引号转义', () => {
    expect(quoteArgsForShell(['-p', 'stream-json', '--verbose'], false)).toEqual(['-p', 'stream-json', '--verbose'])
    expect(quoteArgsForShell(['a b', 'c'], true)).toEqual(['"a b"', 'c'])
    expect(quoteArgsForShell(['he"llo'], true)).toEqual(['"he\\"llo"'])
  })
})

/** 清掉测试构造的 worktree（remove + 删分支；失败吞掉——cleanup 尽力而为）。 */
function cleanupWt(repoRoot: string, wt: string, branch: string): void {
  try { git(repoRoot, `worktree remove --force "${wt}"`) } catch { /* 已不在则忽略 */ }
  try { git(repoRoot, `branch -D ${branch}`) } catch { /* 已不在则忽略 */ }
}

describe('findRepoRoot 统一 > linked worktree 内锚定主仓库根', () => {
  it('orchestrator status：queue 锚在主仓库，不落进 worktree', () => {
    const repo = mkRepo()
    const wt = path.join(repo.root, '.agents', 'worktrees', 'probe-wt')
    try {
      git(repo.root, `worktree add "${wt}" -b feature/probe-wt develop`)
      const orch = path.join(repo.root, '.agents', 'scripts', 'orchestrator.mjs')
      const r = spawnSync('node', [orch, 'status'], { cwd: wt, encoding: 'utf8' })
      expect(r.status).toBe(0)
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending'))).toBe(true)
      expect(fs.existsSync(path.join(wt, '.agents', 'orchestrator', 'queue'))).toBe(false)
    } finally {
      cleanupWt(repo.root, wt, 'feature/probe-wt')
      repo.cleanup()
    }
  })

  it('feature-branch start：新 worktree 建在主仓库的 worktrees 目录', () => {
    const repo = mkRepo()
    const wt = path.join(repo.root, '.agents', 'worktrees', 'probe-wt')
    try {
      git(repo.root, `worktree add "${wt}" -b feature/probe-wt develop`)
      const fb = path.join(repo.root, '.agents', 'scripts', 'feature-branch.mjs')
      const r = spawnSync('node', [fb, 'start', 'probe-anchor'], { cwd: wt, encoding: 'utf8' })
      expect(r.status).toBe(0)
      expect(fs.existsSync(path.join(repo.root, '.agents', 'worktrees', 'probe-anchor'))).toBe(true)
      expect(fs.existsSync(path.join(wt, '.agents', 'worktrees', 'probe-anchor'))).toBe(false)
    } finally {
      // start 的 worktree 无提交，finish 走「nothing to merge」清理路径
      spawnSync('node', [path.join(repo.root, '.agents', 'scripts', 'feature-branch.mjs'), 'finish', 'probe-anchor'], {
        cwd: repo.root, encoding: 'utf8',
      })
      cleanupWt(repo.root, wt, 'feature/probe-wt')
      repo.cleanup()
    }
  })
})

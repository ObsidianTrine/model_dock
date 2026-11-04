// P0 修复回归：finish 验证命令超时按整树收割（2026-11）。
// 旧实现 spawnSync(cmd, {shell:true, timeout}) 的超时只杀 shell 直接子进程——vitest/node
// 孙进程树全部孤儿化，继续持有 worktree 句柄，Windows 上令随后的 worktree 清理 rename
// 报 EBUSY/EPERM（gates.mjs 的 runCmd 早已是 detached+killTree，finish 没有回灌）。
// 新实现 finish 验证步骤复用 runCmd（stdio 直通保持 live 输出），超时上限可经
// FINISH_TESTCMD_TIMEOUT_MS 注入（缺省 20min，对齐门禁口径）。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkRepo, git } from './helpers.js'

function runScript(repo: string, args: string[], env: Record<string, string> = {}, timeout = 120_000) {
  const script = path.join(repo, '.agents', 'scripts', 'feature-branch.mjs')
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
  })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** start + 在 worktree 提交一个改动，构造可验证（非空提交）的 finish 前置状态。 */
function startAndCommit(repo: string, id: string) {
  const s = runScript(repo, ['start', id])
  expect(s.status).toBe(0)
  const wt = path.join(repo, '.agents', 'worktrees', id)
  fs.appendFileSync(path.join(wt, 'README.md'), '\nchange\n')
  git(wt, 'add -A')
  git(wt, 'commit -m work')
  return wt
}

describe('finish 验证超时 > 整树收割', () => {
  it('testCmd 挂死：finish 超时终止且孙进程不留孤儿（旧实现只杀 shell，node 孙进程再活 60s）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finish-tree-'))
    const pidFile = path.join(tmp, 'child.pid')
    // testCmd：node 子进程把自己的 pid 落盘后长睡——它挂在 shell 之下（孙进程），
    // 若只杀 shell，pidFile 里的进程会继续存活 60s
    const repo = mkRepo({
      testCmd: `node -e "const fs=require('fs');fs.writeFileSync(process.env.TT_PID, String(process.pid));setTimeout(() => {}, 60000)"`,
    })
    try {
      startAndCommit(repo.root, 'tree-probe')
      const f = runScript(
        repo.root,
        ['finish', 'tree-probe'],
        { FINISH_LOCK_WAIT_SECONDS: '0', FINISH_TESTCMD_TIMEOUT_MS: '2000', TT_PID: pidFile },
        90_000,
      )
      expect(f.status).not.toBe(0)
      expect(f.out).toContain('超时')
      expect(f.out).toContain('verification failed')
      const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim())
      expect(childPid).toBeGreaterThan(0)
      expect(alive(childPid)).toBe(false) // 整树收割：孙进程已被终止
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
      repo.cleanup()
    }
  })

  it('快速 testCmd → finish 正常合并（runCmd 直通路径零回归）', () => {
    const repo = mkRepo({ testCmd: 'node -e "process.exit(0)"' })
    try {
      startAndCommit(repo.root, 'fast-probe')
      const f = runScript(repo.root, ['finish', 'fast-probe'], { FINISH_LOCK_WAIT_SECONDS: '0' }, 120_000)
      expect(f.status).toBe(0)
      expect(f.out).toContain('Merged')
    } finally {
      repo.cleanup()
    }
  })
})

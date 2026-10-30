// finish 锁判活回归（心跳改造，2026-10-30）：旧实现 pidAlive 用 process.kill(pid,0)，
// Windows 上属主退出后 pid 被复用 → 死锁被误判为活 → 排队者永远拿不到锁（实证踩中：
// 多 agent 串行 finish 时属主已合并落盘、进程成僵尸或已退，后来者被无限拒绝）。
// 新实现按心跳 beat 判陈旧；pid 仅作诊断记录。子进程跑真实 feature-branch.mjs，
// 用「无 worktree 的任务名」当锁后探针：过了锁必死在 "no worktree for task"。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { mkRepo } from './helpers.js'

const LOCK_REL = path.join('.agents', 'worktrees', '.finish.lock')

/** 在临时仓库里跑一次 finish（无 worktree 的任务名 = 锁后探针），返回结果与锁状态。
 *  FINISH_LOCK_WAIT_SECONDS=0：本套件钉的是**判活分类**语义（心跳新鲜度），不是等待
 *  行为——finish 锁自 T13 起默认有界等待 300s（FINISH_LOCK_WAIT_SECONDS 可调），不关掉
 *  等待的话「新鲜锁拒绝」用例会白等 300s 撞测试超时（实跑踩中）。 */
function runFinish(repo: string, task: string) {
  const script = path.join(repo, '.agents', 'scripts', 'feature-branch.mjs')
  const r = spawnSync(process.execPath, [script, 'finish', task], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, FINISH_LOCK_WAIT_SECONDS: '0' },
  })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  return { status: r.status, out, lockExists: fs.existsSync(path.join(repo, LOCK_REL)) }
}

function writeLock(repo: string, payload: unknown) {
  fs.mkdirSync(path.join(repo, '.agents', 'worktrees'), { recursive: true })
  fs.writeFileSync(path.join(repo, LOCK_REL), typeof payload === 'string' ? payload : JSON.stringify(payload))
}

describe('finish 锁判活（心跳）', () => {
  it('beat 新鲜 → 拒绝（活锁保护），锁原样保留', () => {
    const repo = mkRepo()
    try {
      writeLock(repo.root, { pid: process.pid, task: 'other', time: new Date().toISOString(), beat: Date.now() })
      const r = runFinish(repo.root, 'bench-fresh')
      expect(r.out).toContain('another finish is already running')
      expect(r.lockExists).toBe(true) // 拒绝路径不动锁（exit handler 只在成功持锁后注册）
    } finally {
      repo.cleanup()
    }
  })

  it('beat 陈旧 + pid 活着（复用形态）→ 接管：越过锁死在 no worktree，锁被接管者清理', () => {
    const repo = mkRepo()
    try {
      // pid 填测试进程自己（必然存活）——旧代码 pidAlive=true 会拒绝，正是要钉死的回归
      writeLock(repo.root, { pid: process.pid, task: 'ghost', time: new Date().toISOString(), beat: Date.now() - 120_000 })
      const r = runFinish(repo.root, 'bench-stale-beat')
      expect(r.out).not.toContain('another finish is already running')
      expect(r.out).toContain('no worktree for task')
      expect(r.lockExists).toBe(false) // die 触发 exit handler，属主是自己 → 清理
    } finally {
      repo.cleanup()
    }
  })

  it('旧版锁（无 beat）：time 新鲜 → 拒绝；time 超 30min → 接管（滚动升级两态）', () => {
    const repo = mkRepo()
    try {
      writeLock(repo.root, { pid: process.pid, task: 'legacy', time: new Date().toISOString() })
      const fresh = runFinish(repo.root, 'bench-legacy-fresh')
      expect(fresh.out).toContain('another finish is already running')
      expect(fresh.lockExists).toBe(true)

      writeLock(repo.root, { pid: process.pid, task: 'legacy', time: new Date(Date.now() - 31 * 60_000).toISOString() })
      const stale = runFinish(repo.root, 'bench-legacy-stale')
      expect(stale.out).toContain('no worktree for task')
      expect(stale.lockExists).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('损坏锁（非 JSON）→ 视为陈锁接管', () => {
    const repo = mkRepo()
    try {
      writeLock(repo.root, '{corrupt!!')
      const r = runFinish(repo.root, 'bench-corrupt')
      expect(r.out).not.toContain('another finish is already running')
      expect(r.out).toContain('no worktree for task')
    } finally {
      repo.cleanup()
    }
  })
})

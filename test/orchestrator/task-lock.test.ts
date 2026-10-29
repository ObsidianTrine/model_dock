// 任务级互斥锁测试（task-lock.mjs，docs design-orchestrator 10.6）：
// 同任务双驱动被拒、陈锁自动接管、正常闭环释放、abandon 存活守卫。
// 库级用例直接驱动模块（普通临时目录即可）；端到端走 CLI 子进程 + 临时仓库
// （mock 后端），与 integration.test.ts 同配方。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardText, mkRepo, runOrch, tryOrch } from './helpers.js'
import {
  acquireTaskLock,
  readTaskLock,
  releaseTaskLock,
  taskLockPath,
} from '../../.agents/scripts/orchestrator/task-lock.mjs'

/** 拿一个确定已退出的 pid（spawn 即退的子进程）：陈锁构造用。 */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 30_000 })
  return r.pid ?? 0
}

/** 测试播种锁文件（acquireTaskLock 自带建目录，直写需要先建父目录）。 */
function seedLock(dir: string, id: string, lock: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(taskLockPath(dir, id)), { recursive: true })
  fs.writeFileSync(taskLockPath(dir, id), JSON.stringify(lock))
}

function submitCard(repo: string, id: string) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id }))
  runOrch(repo, `submit "${cardFile}"`)
}

describe('task-lock > 锁语义（库级）', () => {
  it('活锁拒绝：持锁进程存活时 acquire 返回 held:false + owner', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-lib-'))
    try {
      seedLock(dir, 't-live', { pid: process.pid, task: 't-live', cmd: 'run' })
      const r = acquireTaskLock(dir, 't-live')
      expect(r.held).toBe(false)
      if (!r.held) {
        expect(r.owner.pid).toBe(process.pid)
        expect(r.unremovable).toBeUndefined()
      }
      // 拒绝时不该动别人的锁
      expect(readTaskLock(dir, 't-live')?.pid).toBe(process.pid)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('陈锁自动接管：持锁进程已死时 acquire 成功并换上自己的 pid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-lib-'))
    try {
      seedLock(dir, 't-stale', { pid: deadPid(), task: 't-stale', cmd: 'run' })
      const r = acquireTaskLock(dir, 't-stale')
      expect(r.held).toBe(true)
      expect(readTaskLock(dir, 't-stale')?.pid).toBe(process.pid)
      releaseTaskLock(dir, 't-stale')
      expect(fs.existsSync(taskLockPath(dir, 't-stale'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('释放只删自己持有的锁；无锁文件时 acquire 直接成功', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-lib-'))
    try {
      // 无锁 → 成功
      expect(acquireTaskLock(dir, 't-fresh').held).toBe(true)
      // 把锁内容换成别人的（已死 pid）→ release 不得误删
      seedLock(dir, 't-fresh', { pid: deadPid(), task: 't-fresh' })
      releaseTaskLock(dir, 't-fresh')
      expect(fs.existsSync(taskLockPath(dir, 't-fresh'))).toBe(true)
      fs.rmSync(taskLockPath(dir, 't-fresh'), { force: true })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非法 task id 抛错（锁文件名内嵌 id，挡路径注入）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-lib-'))
    try {
      expect(() => taskLockPath(dir, '../escape')).toThrow(/不合法/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('task-lock > run 端到端（CLI + mock 后端）', () => {
  it('已有进行中闭环（活锁）时 run 被拒，任务卡留在 pending', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'locked')
      // 模拟另一个 run 进程持锁：pid 用当前测试进程（对子进程而言存活）
      fs.writeFileSync(taskLockPath(repo.root, 'locked'), JSON.stringify({ pid: process.pid, task: 'locked', cmd: 'run' }))
      const r = tryOrch(repo.root, 'run locked --backend mock')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('已有进行中的闭环')
      expect(r.stderr).toContain(String(process.pid))
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'locked.md'))).toBe(true)
      // 没有留下 worktree / 分支半成品
      expect(fs.existsSync(path.join(repo.root, '.agents', 'worktrees', 'locked'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('陈锁自动接管：崩溃残留的锁不阻塞恢复，闭环照常跑完且锁已释放', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'crashy')
      fs.writeFileSync(taskLockPath(repo.root, 'crashy'), JSON.stringify({ pid: deadPid(), task: 'crashy', cmd: 'run', acquired_at: new Date().toISOString() }))
      const r = runOrch(repo.root, 'run crashy --backend mock')
      expect(r.stdout).toContain('接管陈旧任务锁')
      expect(fs.existsSync(taskLockPath(repo.root, 'crashy'))).toBe(false)
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'awaiting-human', 'crashy.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('正常闭环结束后锁已释放（无残留锁文件）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'flow')
      runOrch(repo.root, 'run flow --backend mock')
      expect(fs.existsSync(taskLockPath(repo.root, 'flow'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('abandon 守卫：闭环存活时拒绝；陈锁（崩溃残留）时可正常放弃', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'doomed')
      fs.writeFileSync(taskLockPath(repo.root, 'doomed'), JSON.stringify({ pid: process.pid, task: 'doomed', cmd: 'run' }))
      const refused = tryOrch(repo.root, 'abandon doomed')
      expect(refused.status).not.toBe(0)
      expect(refused.stderr).toContain('闭环仍在运行')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'doomed.md'))).toBe(true)

      fs.writeFileSync(taskLockPath(repo.root, 'doomed'), JSON.stringify({ pid: deadPid(), task: 'doomed', cmd: 'run' }))
      runOrch(repo.root, 'abandon doomed')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'failed', 'doomed.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })
})

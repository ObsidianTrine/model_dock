// host-guard 撞窗归因单测（2026-11-22 深夜 finish 门禁产品套件三连红事故的修复配套）：
// teardown 对账发现漂移时，按宿主仓活跃任务锁（.run-<id>.lock 心跳判活）分流——
// 活跃锁 → 报错前置 [orchestrator-collision] 归因段 + 落 node_modules/.orch-collision.flag
// marker（feature-branch finish 读它决定「等待重试」的机器契约）；陈锁/无锁 → 消息与
// 行为维持现状、绝不写 marker。两种情况都照旧 throw（归因 ≠ 放行，fail-closed 不变）。
// 全程自造临时 git 仓（os.tmpdir + path.join），零宿主仓触达；锁文件直接伪造 JSON，
// 不真起进程；marker 落点随 vitest cwd（worktree node_modules），前后必清防残留误判。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHostGuard } from './host-guard.mjs'

/** 与 host-guard.mjs writeCollisionMarker 同一路径契约（字面量不得改）。 */
const MARKER = path.join(process.cwd(), 'node_modules', '.orch-collision.flag')

const GIT_READY = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
})()

/** git 对象落盘/异步收尾可能让 rmSync 瞬间 EBUSY/EPERM：退避重试（同 host-guard.test.ts）。 */
function rmRfRetry(p: string): void {
  const backoffMs = [10, 50, 100, 250, 500, 1000]
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(code) || i >= backoffMs.length) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs[i])
    }
  }
}

/** marker 前后必清：残留 flag 会让「无 marker」断言假红，也会污染后续真实 finish 的读数。 */
function removeMarker(): void {
  try { fs.rmSync(MARKER, { force: true }) } catch { /* 尽力而为 */ }
}

interface Fixture {
  root: string
  cleanup(): void
}

/** 最小 git 仓：初始提交 + 一张队列卡（漂移手段 = 卡迁移，纯 fs 即可触发对账差异）。 */
function mkGitRepo(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-guard-collision-'))
  const g = (args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  g(['init'])
  g(['config', 'user.email', 'guard@local'])
  g(['config', 'user.name', 'guard'])
  fs.writeFileSync(path.join(root, 'README.md'), '# collision fixture\n')
  g(['add', '-A'])
  g(['commit', '-m', 'init'])
  fs.mkdirSync(path.join(root, '.agents', 'orchestrator', 'queue', 'blocked'), { recursive: true })
  fs.writeFileSync(path.join(root, '.agents', 'orchestrator', 'queue', 'blocked', 'card-a.md'), '---\nid: card-a\n---\n')
  return { root, cleanup: () => rmRfRetry(root) }
}

/** 直接伪造任务锁 JSON（结构同 task-lock.mjs：{ pid, task, cmd, acquired_at, beat }）。 */
function writeLock(repoRoot: string, taskId: string, info: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(repoRoot, '.agents', 'orchestrator', `.run-${taskId}.lock`),
    JSON.stringify(info),
  )
}

/** 制造对账漂移：队列卡 blocked → merged（模拟编排器流转）。 */
function drift(repo: Fixture): void {
  const q = path.join(repo.root, '.agents', 'orchestrator', 'queue')
  fs.mkdirSync(path.join(q, 'merged'), { recursive: true })
  fs.renameSync(path.join(q, 'blocked', 'card-a.md'), path.join(q, 'merged', 'card-a.md'))
}

/** 捕 teardown 的报错文本并归一换行（win CRLF → LF，文本断言统一口径）。 */
function teardownError(teardown: () => void): string {
  try {
    teardown()
  } catch (e) {
    return String((e as Error).message).replace(/\r\n/g, '\n')
  }
  return ''
}

interface CollisionFlag {
  at: number
  summary: string
  sources: Array<{ taskId: string; holder?: string; pid: number; beatAgeMs: number | null }>
}

const maybeGit = GIT_READY ? describe : describe.skip

maybeGit('host-guard-collision > 归因命中', () => {
  beforeEach(removeMarker)
  afterEach(removeMarker)

  it('活跃锁（心跳新鲜）+ 漂移 → throw 带 [orchestrator-collision] 归因段 + marker 落盘且内容正确', () => {
    const repo = mkGitRepo()
    try {
      writeLock(repo.root, 'probe-task', {
        pid: 4194304, // 不存在的 pid：心跳新鲜即判活，不依赖探活
        task: 'probe-task',
        cmd: 'run',
        acquired_at: new Date().toISOString(),
        beat: Date.now(),
      })
      const teardown = startHostGuard(repo.root)
      drift(repo)
      const msg = teardownError(teardown)
      expect(msg).toContain('宿主仓被改动') // 现有对账明细一字不减
      expect(msg).toContain('[orchestrator-collision]')
      expect(msg).toContain('probe-task')
      expect(msg).toContain('疑似编排器撞窗')
      // marker 机器契约：at 近期 + sources 含该锁全字段
      expect(fs.existsSync(MARKER)).toBe(true)
      const flag = JSON.parse(fs.readFileSync(MARKER, 'utf8')) as CollisionFlag
      expect(Date.now() - flag.at).toBeLessThan(60_000)
      expect(flag.summary).toContain('撞窗')
      expect(flag.sources).toHaveLength(1)
      expect(flag.sources[0].taskId).toBe('probe-task')
      expect(flag.sources[0].holder).toBe('run')
      expect(flag.sources[0].pid).toBe(4194304)
      expect(typeof flag.sources[0].beatAgeMs).toBe('number')
    } finally {
      repo.cleanup()
    }
  })

  it('旧版锁（无 beat，pid 存活 + acquired_at 新鲜兜底）→ 归因命中（legacy 路径）', () => {
    const repo = mkGitRepo()
    try {
      // pid 用本测试进程：必然存活，跨平台稳定触发 isAlive 兜底路径
      writeLock(repo.root, 'legacy-task', {
        pid: process.pid,
        task: 'legacy-task',
        cmd: 'run',
        acquired_at: new Date().toISOString(),
      })
      const teardown = startHostGuard(repo.root)
      drift(repo)
      const msg = teardownError(teardown)
      expect(msg).toContain('[orchestrator-collision]')
      expect(msg).toContain('legacy-task')
      expect(fs.existsSync(MARKER)).toBe(true)
      const flag = JSON.parse(fs.readFileSync(MARKER, 'utf8')) as CollisionFlag
      expect(flag.sources.map((s) => s.taskId)).toEqual(['legacy-task'])
      expect(flag.sources[0].beatAgeMs).toBeNull() // 无 beat 字段 → beatAgeMs = null
    } finally {
      repo.cleanup()
    }
  })
})

maybeGit('host-guard-collision > 归因未命中（现状不变）', () => {
  beforeEach(removeMarker)
  afterEach(removeMarker)

  it('陈锁（心跳静默 70s）+ 漂移 → 照常 throw，无归因前缀、无 marker', () => {
    const repo = mkGitRepo()
    try {
      writeLock(repo.root, 'stale-task', {
        pid: process.pid,
        task: 'stale-task',
        cmd: 'run',
        acquired_at: new Date().toISOString(),
        beat: Date.now() - 70_000, // 超 60s 陈锁阈值（同 task-lock.mjs TASK_LOCK_STALE_MS）
      })
      const teardown = startHostGuard(repo.root)
      drift(repo)
      const msg = teardownError(teardown)
      expect(msg).toContain('宿主仓被改动') // 照旧红（fail-closed 不因归因逻辑松动）
      expect(msg).not.toContain('[orchestrator-collision]')
      expect(msg).not.toContain('stale-task')
      expect(fs.existsSync(MARKER)).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('无锁 + 漂移 → 同陈锁：报错文本维持现状、绝不写 marker', () => {
    const repo = mkGitRepo()
    try {
      const teardown = startHostGuard(repo.root)
      drift(repo)
      const msg = teardownError(teardown)
      expect(msg).toContain('宿主仓被改动')
      expect(msg).not.toContain('[orchestrator-collision]')
      expect(fs.existsSync(MARKER)).toBe(false)
    } finally {
      repo.cleanup()
    }
  })
})

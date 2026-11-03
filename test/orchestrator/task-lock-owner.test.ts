// P0 修复回归：任务锁 pid 属主校验 + 孤儿 worker 清理防误杀（2026-11）。
// 旧实现 isAlive(pid) 判活会被 pid 复用骗过：陈锁属主早已退出、pid 被无辜新进程顶掉
// → 假活锁（后来者永远拿不到锁）+ cleanupOrphanWorker/报错文案把无辜进程当属主误杀
// （评测集 2026-10-finish-lock-pid-reuse 同型，feature-branch finish 锁已用心跳修过）。
// 收敛：任务锁改用心跳 beat 判活（与 finish 锁同方案）；孤儿清理杀树前比对进程运行
// 时长与 spawn 事件时刻。

import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardText, mkRepo, runOrch } from './helpers.js'
import {
  acquireTaskLock,
  readTaskLock,
  releaseTaskLock,
  taskLockLooksLive,
  taskLockPath,
  TASK_LOCK_STALE_MS,
} from '../../.agents/scripts/orchestrator/task-lock.mjs'
import { isAlive, orphanOwnership, processElapsedMs } from '../../.agents/scripts/orchestrator/kill-tree.mjs'
import { logDir } from '../../.agents/scripts/orchestrator/events.mjs'

/** 确定已退出的 pid（spawn 即退）：陈锁构造用。 */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 30_000 })
  return r.pid ?? 0
}

/** 确定存活的休眠进程：活锁/孤儿构造用。detached = 独立进程组（killTree 的组杀可命中）。 */
function liveSleeper(ms = 30_000) {
  const c = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore', detached: true })
  return c.pid ?? 0
}

/**
 * 进程是否已被终止。isAlive（kill(pid,0)）对 zombie 恒真：父进程（本测试）在 execSync
 * 阻塞期间不收割子进程，被杀的孤儿以 Z 状态挂着——杀树验证必须穿透 zombie。
 * unix 用 ps stat 判 Z；Windows 无 zombie 概念，isAlive 即真实状态。
 */
function terminated(pid: number): boolean {
  if (!isAlive(pid)) return true
  if (process.platform === 'win32') return false
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  const st = (r.stdout ?? '').trim()
  return st === '' || st.startsWith('Z')
}

function seedLock(dir: string, id: string, lock: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(taskLockPath(dir, id)), { recursive: true })
  fs.writeFileSync(taskLockPath(dir, id), JSON.stringify(lock))
}

function placeRunningCard(repo: string, id: string) {
  const dir = path.join(repo, '.agents', 'orchestrator', 'queue', 'running')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${id}.md`), cardText({ id }))
}

/** 手工播种 worker_spawned 事件（ts 可控，恢复路径 cleanupOrphanWorker 的输入）。 */
function seedSpawnEvent(repo: string, id: string, pid: number, ageMs: number) {
  const dir = logDir(repo, id)
  fs.mkdirSync(dir, { recursive: true })
  const ts = new Date(Date.now() - ageMs).toISOString()
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    JSON.stringify({ ts, seq: 1, type: 'worker_spawned', role: 'worker', backend: 'mock', pid }) + '\n',
  )
}

describe('task-lock > 心跳判活（pid 复用防呆）', () => {
  it('心跳陈旧 + pid 活着（复用形态）→ 接管换属主：旧实现 isAlive 误判活锁', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-owner-'))
    const sleeper = liveSleeper()
    try {
      seedLock(dir, 't-reuse', { pid: sleeper, task: 't-reuse', cmd: 'run', acquired_at: new Date(Date.now() - 10 * 60_000).toISOString(), beat: Date.now() - 120_000 })
      const r = acquireTaskLock(dir, 't-reuse')
      expect(r.held).toBe(true)
      expect(readTaskLock(dir, 't-reuse')?.pid).toBe(process.pid)
      releaseTaskLock(dir, 't-reuse')
      expect(fs.existsSync(taskLockPath(dir, 't-reuse'))).toBe(false)
    } finally {
      try { process.kill(sleeper) } catch { /* 已退 */ }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('心跳新鲜 + pid 活着 → 拒绝（真实活锁保护，行为不变）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-owner-'))
    const sleeper = liveSleeper()
    try {
      seedLock(dir, 't-fresh', { pid: sleeper, task: 't-fresh', cmd: 'run', acquired_at: new Date().toISOString(), beat: Date.now() })
      const r = acquireTaskLock(dir, 't-fresh')
      expect(r.held).toBe(false)
      if (!r.held) expect(r.owner?.pid).toBe(sleeper)
      expect(readTaskLock(dir, 't-fresh')?.pid).toBe(sleeper) // 拒绝路径不动别人的锁
    } finally {
      try { process.kill(sleeper) } catch { /* 已退 */ }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('旧版锁（无 beat）滚动兼容：acquired_at 新鲜 + 活 pid → 拒绝；超 30min → 接管', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-owner-'))
    const sleeper = liveSleeper()
    try {
      seedLock(dir, 't-legacy', { pid: sleeper, task: 't-legacy', cmd: 'run', acquired_at: new Date().toISOString() })
      expect(acquireTaskLock(dir, 't-legacy').held).toBe(false)

      seedLock(dir, 't-legacy', { pid: sleeper, task: 't-legacy', cmd: 'run', acquired_at: new Date(Date.now() - 31 * 60_000).toISOString() })
      expect(acquireTaskLock(dir, 't-legacy').held).toBe(true)
      releaseTaskLock(dir, 't-legacy')
    } finally {
      try { process.kill(sleeper) } catch { /* 已退 */ }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('taskLockLooksLive：损坏/空锁 false；beat 新鲜 true、静默 false；旧版锁按 isAlive+30min 兜底', () => {
    const sleeper = liveSleeper()
    try {
      expect(taskLockLooksLive(null)).toBe(false)
      expect(taskLockLooksLive({ task: 'x' })).toBe(false)
      expect(taskLockLooksLive({ pid: sleeper, beat: Date.now() })).toBe(true)
      expect(taskLockLooksLive({ pid: sleeper, beat: Date.now() - TASK_LOCK_STALE_MS - 1000 })).toBe(false)
      // 旧版锁：pid 复用（进程活着但 acquired_at 超 30min）不再判活——本修复的核心语义
      expect(taskLockLooksLive({ pid: sleeper, acquired_at: new Date().toISOString() })).toBe(true)
      expect(taskLockLooksLive({ pid: sleeper, acquired_at: new Date(Date.now() - 31 * 60_000).toISOString() })).toBe(false)
      expect(taskLockLooksLive({ pid: deadPid(), acquired_at: new Date().toISOString() })).toBe(false)
    } finally {
      try { process.kill(sleeper) } catch { /* 已退 */ }
    }
  })

  it('新锁携带 beat 字段（持有期间可判活），释放即清', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-owner-'))
    try {
      expect(acquireTaskLock(dir, 't-beat').held).toBe(true)
      const lock = readTaskLock(dir, 't-beat')
      expect(Number.isFinite(lock?.beat)).toBe(true)
      releaseTaskLock(dir, 't-beat')
      expect(fs.existsSync(taskLockPath(dir, 't-beat'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('orphanOwnership / processElapsedMs（属主判定纯函数）', () => {
  it('运行时长 ≈ 事件距今 → ours；显著更年轻/更老 → recycled；不可测 → unknown', () => {
    const now = Date.now()
    expect(orphanOwnership(new Date(now - 3600_000).toISOString(), 3600_000, now)).toBe('ours')
    // pid 复用主形态：事件 1h 前、进程 1min 前才启动（显著年轻）
    expect(orphanOwnership(new Date(now - 3600_000).toISOString(), 60_000, now)).toBe('recycled')
    // 事件前就在跑（比事件老得多）同样不可能是本次 spawn
    expect(orphanOwnership(new Date(now - 60_000).toISOString(), 3600_000, now)).toBe('recycled')
    expect(orphanOwnership(new Date(now - 3600_000).toISOString(), null, now)).toBe('unknown')
    expect(orphanOwnership('garbage', 1000, now)).toBe('unknown')
    expect(orphanOwnership(undefined, 1000, now)).toBe('unknown')
  })

  it('processElapsedMs：活进程返回非负时长，死进程/非法 pid 返回 null', () => {
    const self = processElapsedMs(process.pid)
    expect(Number.isFinite(self)).toBe(true)
    expect(self ?? -1).toBeGreaterThanOrEqual(0)
    const gone = deadPid()
    if (!isAlive(gone)) {
      // pid 若被瞬时复用（Windows 偶发）则跳过断言，避免 CI 假红
      expect(processElapsedMs(gone)).toBeNull()
    }
    expect(processElapsedMs(0)).toBeNull()
    expect(processElapsedMs(-1)).toBeNull()
  })
})

describe('task-lock > 孤儿清理属主校验（run 端到端，mock 后端）', () => {
  it('pid 被复用（进程显著年轻于 spawn 事件）→ 跳过终止，不误杀无辜进程', () => {
    const repo = mkRepo()
    const sleeper = liveSleeper()
    try {
      placeRunningCard(repo.root, 'orphan-reuse')
      seedSpawnEvent(repo.root, 'orphan-reuse', sleeper, 2 * 3600_000) // 事件 2h 前：现 pid 必非当时代 worker
      runOrch(repo.root, 'run orphan-reuse --backend mock')
      expect(isAlive(sleeper)).toBe(true) // 无辜进程存活（旧实现被 taskkill /T /F 误杀）
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'awaiting-human', 'orphan-reuse.md'))).toBe(true)
    } finally {
      try { process.kill(sleeper) } catch { /* 已退 */ }
      repo.cleanup()
    }
  })

  it('属主一致（进程与 spawn 事件同龄）→ 照常收割孤儿进程树', () => {
    const repo = mkRepo()
    const sleeper = liveSleeper()
    try {
      placeRunningCard(repo.root, 'orphan-ours')
      seedSpawnEvent(repo.root, 'orphan-ours', sleeper, 0) // 事件≈现在：运行时长≈事件距今 → 属主一致
      runOrch(repo.root, 'run orphan-ours --backend mock')
      expect(terminated(sleeper)).toBe(true)
    } finally {
      try { process.kill(sleeper) } catch { /* 已退 */ }
      repo.cleanup()
    }
  })
})

// 工业级加固测试：调度器互斥锁（陈锁接管/活锁拒绝/子进程豁免）+ cmdRun 异常落
// blocked（backend spawn 失败不悬 running）+ nightly 通知（摘要构建与 dryRun 投递）。

import { describe, expect, it, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  acquireSchedulerLock,
  releaseSchedulerLock,
  schedulerLockPath,
  SCHED_LOCK_ENV,
} from '../../.agents/scripts/orchestrator/run-lock.mjs'
import { notify, buildNightlySummary, NIGHTLY_WEBHOOK_ENV } from '../../.agents/scripts/orchestrator/notify.mjs'
import { cardText, mkRepo, runOrch, tryOrch } from './helpers.js'

const savedEnv: Record<string, string | undefined> = {}
function withEnv(kv: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(kv)) {
    savedEnv[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
    delete savedEnv[k]
  }
})

describe('hardening > 调度器互斥锁（run-lock）', () => {
  it('空仓 acquire→held；release 只删自己持有的锁', () => {
    const repo = mkRepo()
    try {
      const a = acquireSchedulerLock(repo.root, 'test-drain')
      expect(a.held).toBe(true)
      const lock = JSON.parse(fs.readFileSync(schedulerLockPath(repo.root), 'utf8'))
      expect(lock.pid).toBe(process.pid)
      expect(lock.cmd).toBe('test-drain')
      releaseSchedulerLock(repo.root)
      expect(fs.existsSync(schedulerLockPath(repo.root))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('持有进程已死（陈锁）自动接管；存活则拒绝并报 pid', () => {
    const repo = mkRepo()
    try {
      const lockDir = path.dirname(schedulerLockPath(repo.root))
      fs.mkdirSync(lockDir, { recursive: true })
      // 死 pid：起一个立即退出的进程拿 pid
      const dead = spawnSync('node', ['-e', 'process.exit(0)'])
      fs.writeFileSync(schedulerLockPath(repo.root), JSON.stringify({ pid: dead.pid, cmd: 'gone', acquired_at: 'x' }))
      const stale = acquireSchedulerLock(repo.root, 'taker')
      expect(stale.held).toBe(true) // 陈锁接管，不死锁

      // 活 pid：拒绝
      const sleeper = spawn('node', ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'ignore' })
      try {
        fs.writeFileSync(schedulerLockPath(repo.root), JSON.stringify({ pid: sleeper.pid, cmd: 'busy' }))
        const busy = acquireSchedulerLock(repo.root, 'second')
        expect(busy.held).toBe(false)
        expect(busy.owner.pid).toBe(sleeper.pid)
      } finally {
        sleeper.kill()
      }
    } finally {
      repo.cleanup()
    }
  })

  it('父调度器持锁时子进程豁免（env 标记）', () => {
    const repo = mkRepo()
    try {
      const r = acquireSchedulerLock(repo.root, 'nightly')
      expect(r.held).toBe(true)
      try {
        withEnv({ [SCHED_LOCK_ENV]: '1' }) // 模拟 nightly spawn 的 drain/run 子进程环境
        const child = acquireSchedulerLock(repo.root, 'drain')
        expect(child.held).toBe(true)
        expect(child.inherited).toBe(true) // 豁免而非覆盖父锁
        expect(JSON.parse(fs.readFileSync(schedulerLockPath(repo.root), 'utf8')).pid).toBe(process.pid)
      } finally {
        releaseSchedulerLock(repo.root)
      }
    } finally {
      repo.cleanup()
    }
  })

  it('drain 撞活锁：提示退出且不跑任务；run 单卡不受锁影响', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'c.md')
      fs.writeFileSync(cardFile, cardText({ id: 'locked-task' }))
      runOrch(repo.root, `submit "${cardFile}"`)

      const sleeper = spawn('node', ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'ignore' })
      try {
        fs.mkdirSync(path.dirname(schedulerLockPath(repo.root)), { recursive: true })
        fs.writeFileSync(schedulerLockPath(repo.root), JSON.stringify({ pid: sleeper.pid, cmd: 'nightly', acquired_at: 'x' }))
        const out = runOrch(repo.root, 'drain --backend mock')
        expect(out.stdout).toContain('调度器已在运行')
        expect(fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending'))).toContain('locked-task.md') // 没被调度
      } finally {
        sleeper.kill()
      }
    } finally {
      repo.cleanup()
    }
  })
})

describe('hardening > backend 异常不悬 running（落 blocked）', () => {
  it('run 遇 spawn 失败 → 卡转 blocked/、failed 事件带原因、exit 非 0', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'c.md')
      fs.writeFileSync(cardFile, cardText({ id: 'crash-task' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      const r = tryOrch(repo.root, 'run crash-task --backend mock', { ORCH_MOCK_SPAWN_ERROR: '1' })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('异常中断')
      expect(r.stderr).toContain('blocked')
      const blockedDir = path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked')
      expect(fs.readdirSync(blockedDir)).toContain('crash-task.md')
      const events = fs
        .readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'crash-task', 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      expect(events.some((e: any) => e.type === 'failed' && /异常中断/.test(e.reason))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('陈锁不阻塞后续 drain（接管后照常调度）', () => {
    const repo = mkRepo()
    try {
      const dead = spawnSync('node', ['-e', 'process.exit(0)'])
      const lockDir = path.dirname(schedulerLockPath(repo.root))
      fs.mkdirSync(lockDir, { recursive: true })
      fs.writeFileSync(schedulerLockPath(repo.root), JSON.stringify({ pid: dead.pid, cmd: 'crashed-scheduler' }))
      const cardFile = path.join(repo.root, 'c.md')
      fs.writeFileSync(cardFile, cardText({ id: 'after-crash' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      const out = runOrch(repo.root, 'drain --backend mock')
      expect(out.stdout).toContain('接管陈旧调度器锁')
      // 接管后调度正常：卡离开 pending 进入闭环（L3 卡落 awaiting-human 等人工，不出 pending 才是异常）
      const pendingDir = path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending')
      expect(fs.readdirSync(pendingDir)).not.toContain('after-crash.md')
      const awaitingDir = path.join(repo.root, '.agents', 'orchestrator', 'queue', 'awaiting-human')
      const mergedDir = path.join(repo.root, '.agents', 'orchestrator', 'queue', 'merged')
      const settled = [...fs.readdirSync(awaitingDir), ...fs.readdirSync(mergedDir)]
      expect(settled).toContain('after-crash.md')
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

describe('hardening > nightly 通知（notify）', () => {
  it('buildNightlySummary：正常/降级/异常三态', () => {
    expect(buildNightlySummary({ created: 2, awaiting: 1, pending: 0 })).toContain('✓ 巡检完成')
    expect(buildNightlySummary({ created: 2, awaiting: 1, pending: 0 })).toContain('新卡 2、待审 1、待调度 0')
    expect(buildNightlySummary({ degraded: true })).toContain('漂移降级生效中')
    expect(buildNightlySummary({ autoRan: 3 })).toContain('夜间已自动跑 3')
    expect(buildNightlySummary({ error: 'claude CLI 不在 PATH' })).toContain('✗ 巡检异常：claude CLI 不在 PATH')
  })

  it('notify dryRun：webhook 通道拼 POST payload；macOS 通道拼 osascript；正文引号被剥', async () => {
    withEnv({ [NIGHTLY_WEBHOOK_ENV]: 'https://example.com/hook' })
    const r = await notify({ title: 'T', body: '含"引号"的正文', dryRun: true })
    expect(r.delivered.join('\n')).toContain('webhook POST https://example.com/hook')
    if (process.platform === 'darwin') {
      expect(r.delivered.join('\n')).toContain('osascript')
      expect(r.delivered.join('\n')).not.toContain('"引号"') // 引号剥除，防 osascript 注入
    }
  })

  it('notify 无任何配置时静默（delivered 为空或仅平台通道）', async () => {
    withEnv({ [NIGHTLY_WEBHOOK_ENV]: undefined })
    await expect(notify({ body: 'x', dryRun: true })).resolves.toBeTruthy()
  })

  it('nightly 端到端：跑完释放调度器锁（下一次 nightly 可直接再跑）', () => {
    const repo = mkRepo()
    try {
      runOrch(repo.root, 'nightly')
      expect(fs.existsSync(schedulerLockPath(repo.root))).toBe(false)
      const again = runOrch(repo.root, 'nightly')
      expect(again.stdout).toContain('nightly 摘要') // 未被陈锁卡住
    } finally {
      repo.cleanup()
    }
  })
})

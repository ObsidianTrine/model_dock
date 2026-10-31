// 任务卡认领（claim-before-execute）回归：feature-branch start 检测到队列同 id 卡在
// pending/ 时自动认领（抢任务锁 + pending→running + manual_claimed 事件），finish
// 成功后落 merged/（manual_merged）。防的是「人工 agent 不走 orchestrator run——卡
// 状态不更新，drain 误派/误转 blocked、不同 task-id 撞同一张卡」（2026-10-30 卡 22
// 实际撞车）。子进程跑真实 feature-branch.mjs；编排器兼容性（ORCHESTRATOR_CLOSURE
// 跳过认领、ORCHESTRATOR_GATE_HEAD 跳过落卡）单列用例钉死。

import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { cardText, eventsOf, git, mkRepo } from './helpers.js'

const FB = (repo: string) => path.join(repo, '.agents', 'scripts', 'feature-branch.mjs')
const QUEUE = (repo: string) => path.join(repo, '.agents', 'orchestrator', 'queue')
const LOCK = (repo: string, id: string) => path.join(repo, '.agents', 'orchestrator', `.run-${id}.lock`)

function placeCard(repo: string, state: string, id: string) {
  fs.mkdirSync(path.join(QUEUE(repo), state), { recursive: true })
  fs.writeFileSync(path.join(QUEUE(repo), state, `${id}.md`), cardText({ id }))
}

function cardState(repo: string, id: string): string | null {
  for (const s of ['pending', 'running', 'reviewing', 'awaiting-human', 'merged', 'failed', 'blocked']) {
    if (fs.existsSync(path.join(QUEUE(repo), s, `${id}.md`))) return s
  }
  return null
}

interface RunResult {
  status: number | null
  out: string
}

function runFb(repo: string, args: string[], env: Record<string, string> = {}, timeout = 120_000): RunResult {
  const r = spawnSync(process.execPath, [FB(repo), ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
  })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

/** 在 worktree 里做一个可合并的提交。 */
function commitIn(repo: string, id: string, file: string) {
  const wt = path.join(repo, '.agents', 'worktrees', id)
  fs.writeFileSync(path.join(wt, file), 'x\n')
  git(wt, 'add -A')
  git(wt, 'commit -m "task work"')
}

describe('feature-branch 认领 > start', () => {
  it('pending 卡 → 自动认领：卡迁 running/、锁落盘、事件留痕、list 标 claimed', () => {
    const repo = mkRepo()
    try {
      placeCard(repo.root, 'pending', 'claim-target')
      const r = runFb(repo.root, ['start', 'claim-target'])
      expect(r.status).toBe(0)
      expect(cardState(repo.root, 'claim-target')).toBe('running')
      // 锁的生命周期 = start 进程（exit handler 退出即删）：持久认领记录是卡在 running/，
      // 锁只守「两个 start 并发认领」的窄窗口——启动完成后断言其已释放。
      expect(fs.existsSync(LOCK(repo.root, 'claim-target'))).toBe(false)
      const events = eventsOf(repo.root, 'claim-target')
      expect(events.some((e) => e.type === 'manual_claimed')).toBe(true)
      // list 输出带 claimed 标记：其他 agent 一眼看出在岗
      const list = runFb(repo.root, ['list'])
      expect(list.out).toContain('claimed')
    } finally {
      repo.cleanup()
    }
  })

  it('无队列 / 无同 id 卡 → 行为与从前完全一致（可移植性）', () => {
    const repo = mkRepo()
    try {
      const r = runFb(repo.root, ['start', 'plain-work'])
      expect(r.status).toBe(0)
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator'))).toBe(false) // 不建任何队列痕迹
      // 队列在、但 id 不匹配：同样不认领
      placeCard(repo.root, 'pending', 'other-task')
      const r2 = runFb(repo.root, ['start', 'another-task'])
      expect(r2.status).toBe(0)
      expect(cardState(repo.root, 'another-task')).toBeNull()
      expect(fs.existsSync(LOCK(repo.root, 'another-task'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('活锁（pid 存活的持有者）→ 拒绝认领，卡留 pending/、不建 worktree', () => {
    const repo = mkRepo()
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    try {
      placeCard(repo.root, 'pending', 'contested')
      fs.mkdirSync(path.join(repo.root, '.agents', 'orchestrator'), { recursive: true })
      fs.writeFileSync(
        LOCK(repo.root, 'contested'),
        JSON.stringify({ pid: sleeper.pid!, task: 'contested', cmd: 'someone else', acquired_at: new Date().toISOString() }),
      )
      const r = runFb(repo.root, ['start', 'contested'])
      expect(r.status).toBe(1)
      expect(r.out).toContain('already claimed')
      expect(cardState(repo.root, 'contested')).toBe('pending') // 认领被拒，卡原位
      expect(fs.existsSync(path.join(repo.root, '.agents', 'worktrees', 'contested'))).toBe(false)
    } finally {
      sleeper.kill()
      repo.cleanup()
    }
  })

  it('陈锁（pid 已死）→ 自动接管，认领照常完成', () => {
    const repo = mkRepo()
    try {
      placeCard(repo.root, 'pending', 'stale-claim')
      fs.mkdirSync(path.join(repo.root, '.agents', 'orchestrator'), { recursive: true })
      fs.writeFileSync(
        LOCK(repo.root, 'stale-claim'),
        JSON.stringify({ pid: 999_999_999, task: 'stale-claim', cmd: 'dead holder', acquired_at: new Date(Date.now() - 3_600_000).toISOString() }),
      )
      const r = runFb(repo.root, ['start', 'stale-claim'])
      expect(r.status).toBe(0)
      expect(cardState(repo.root, 'stale-claim')).toBe('running')
    } finally {
      repo.cleanup()
    }
  })

  it('ORCHESTRATOR_CLOSURE=1（编排器闭环上下文）→ 认领整体跳过，卡留在 pending/', () => {
    const repo = mkRepo()
    try {
      placeCard(repo.root, 'pending', 'closure-task')
      const r = runFb(repo.root, ['start', 'closure-task'], { ORCHESTRATOR_CLOSURE: '1' })
      expect(r.status).toBe(0) // worktree 照常创建
      expect(fs.existsSync(path.join(repo.root, '.agents', 'worktrees', 'closure-task'))).toBe(true)
      expect(cardState(repo.root, 'closure-task')).toBe('pending') // 卡由 cmdRun 状态机负责
      expect(fs.existsSync(LOCK(repo.root, 'closure-task'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('分支已存在 → 拒绝信息附队列卡状态（接手者可分辨「残留」与「在岗」）', () => {
    const repo = mkRepo()
    try {
      placeCard(repo.root, 'pending', 'dup-task')
      runFb(repo.root, ['start', 'dup-task'])
      const r2 = runFb(repo.root, ['start', 'dup-task'])
      expect(r2.status).toBe(1)
      expect(r2.out).toContain('branch feature/dup-task already exists')
      expect(r2.out).toContain('queue card "dup-task" is in running/')
    } finally {
      repo.cleanup()
    }
  })

  it('认领后 worktree add 失败 → 回滚：卡回 pending/、锁释放', () => {
    const repo = mkRepo()
    try {
      placeCard(repo.root, 'pending', 'rollback-task')
      // 占住 worktree 落点：git worktree add 必败
      const wtDir = path.join(repo.root, '.agents', 'worktrees', 'rollback-task')
      fs.mkdirSync(wtDir, { recursive: true })
      fs.writeFileSync(path.join(wtDir, 'blocker.txt'), 'occupied')
      const r = runFb(repo.root, ['start', 'rollback-task'])
      expect(r.status).toBe(1)
      expect(cardState(repo.root, 'rollback-task')).toBe('pending') // 回滚归位
      expect(fs.existsSync(LOCK(repo.root, 'rollback-task'))).toBe(false) // 锁已释放
    } finally {
      repo.cleanup()
    }
  })
})

describe('feature-branch 认领 > finish', () => {
  it('running 卡 → 落 merged/ + manual_merged 事件（人工路径）', () => {
    const repo = mkRepo()
    try {
      placeCard(repo.root, 'pending', 'done-task')
      expect(runFb(repo.root, ['start', 'done-task']).status).toBe(0)
      commitIn(repo.root, 'done-task', 'fix.txt')
      const r = runFb(repo.root, ['finish', 'done-task'], { FINISH_LOCK_WAIT_SECONDS: '0' })
      expect(r.status).toBe(0)
      expect(cardState(repo.root, 'done-task')).toBe('merged')
      expect(eventsOf(repo.root, 'done-task').some((e) => e.type === 'manual_merged')).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('ORCHESTRATOR_GATE_HEAD（approve 路径）→ 落卡跳过，卡归属闭环状态机', () => {
    const repo = mkRepo()
    try {
      placeCard(repo.root, 'pending', 'gate-task')
      expect(runFb(repo.root, ['start', 'gate-task'], { ORCHESTRATOR_CLOSURE: '1' }).status).toBe(0)
      // 闭环语义：卡在 running/（cmdRun 迁的），先手动摆到位
      fs.mkdirSync(path.join(QUEUE(repo.root), 'running'), { recursive: true })
      fs.renameSync(path.join(QUEUE(repo.root), 'pending', 'gate-task.md'), path.join(QUEUE(repo.root), 'running', 'gate-task.md'))
      commitIn(repo.root, 'gate-task', 'fix.txt')
      const head = git(path.join(repo.root, '.agents', 'worktrees', 'gate-task'), 'rev-parse HEAD').trim()
      const r = runFb(
        repo.root,
        ['finish', 'gate-task', '--skip-test'],
        { ORCHESTRATOR_GATE_HEAD: head, FINISH_LOCK_WAIT_SECONDS: '0' },
      )
      expect(r.status).toBe(0)
      expect(cardState(repo.root, 'gate-task')).toBe('running') // 落卡跳过：awaiting-human→merged 由 doApprove 负责
    } finally {
      repo.cleanup()
    }
  })

  it('非 running 卡（awaiting-human 等）不动，交还编排器状态机', () => {
    const repo = mkRepo()
    try {
      placeCard(repo.root, 'awaiting-human', 'human-task')
      expect(runFb(repo.root, ['start', 'human-task']).status).toBe(0) // other-state：不认领但照常开工
      expect(cardState(repo.root, 'human-task')).toBe('awaiting-human')
      commitIn(repo.root, 'human-task', 'fix.txt')
      const r = runFb(repo.root, ['finish', 'human-task'], { FINISH_LOCK_WAIT_SECONDS: '0' })
      expect(r.status).toBe(0)
      expect(cardState(repo.root, 'human-task')).toBe('awaiting-human') // 未被 finish 动过
    } finally {
      repo.cleanup()
    }
  })

  it('空分支（无可合并提交）→ 照常落 merged/（与编排器空任务 approve 同语义）', () => {
    const repo = mkRepo()
    try {
      placeCard(repo.root, 'pending', 'empty-task')
      expect(runFb(repo.root, ['start', 'empty-task']).status).toBe(0)
      const r = runFb(repo.root, ['finish', 'empty-task'], { FINISH_LOCK_WAIT_SECONDS: '0' })
      expect(r.status).toBe(0)
      expect(cardState(repo.root, 'empty-task')).toBe('merged')
    } finally {
      repo.cleanup()
    }
  })
})


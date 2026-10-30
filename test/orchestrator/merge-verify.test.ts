// merge-verify-once（T13）定向回归：
//   ① gate 验证过当前树 → approve 路径 finish 跳过锁内重复全量（testCmd 只跑一次）
//   ② develop 前进 / worktree HEAD 与 gate 记录不一致 → --skip-test 被拒、回落全量
//   ③ 并发 finish 不再 fail-fast：有界等待（FINISH_LOCK_WAIT_SECONDS，0 = 恢复立即失败）
//   ④ 人工 --skip-test（无 ORCHESTRATOR_GATE_HEAD）原语义不变；陈锁（属主已死）自动接管不变
//   ⑤ orchestrator doApprove 撞锁 → 有界重试 → merge_lock_wait 事件；解锁后重 approve 成功
// 夹具沿用 helpers.mkRepo（真实脚本在临时仓库里跑），testCmd 换成计数器命令：
// 每次执行向 MV_COUNTER 文件追加一个 '1'，用它断言「全量测试到底跑了几遍」。

import { describe, expect, it } from 'vitest'
import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardText, eventsOf, git, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

const WORKTREE_ROOT = path.resolve(process.cwd()) // vitest cwd = 仓库根（worktree 内）

// 计数 testCmd：双引号包 -e 脚本（helpers 默认命令同款形态，三平台 shell 安全）
const COUNTER_CMD = 'node -e "require(\'fs\').appendFileSync(process.env.MV_COUNTER,\'1\')"'

function mkCounter(): { file: string; count: () => number; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-counter-'))
  const file = path.join(dir, 'count')
  return {
    file,
    count: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

/** 在临时仓库里直接跑 feature-branch.mjs（允许失败版，stderr/stdout 分开拿）。 */
function fb(repo: string, args: string, env: Record<string, string> = {}): { status: number; out: string; err: string } {
  const script = path.join(WORKTREE_ROOT, '.agents', 'scripts', 'feature-branch.mjs')
  try {
    const out = execSync(`node "${script}" ${args}`, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    return { status: 0, out: out ?? '', err: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, out: err.stdout ?? '', err: err.stderr ?? '' }
  }
}

function wtGit(wt: string, args: string): string {
  return execSync(`git ${args}`, { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** 在任务 worktree 里提交一个文件，返回该 worktree 的 HEAD（finish 需分支有提交才走合并路径）。 */
function commitInWorktree(repo: string, id: string, name: string): string {
  const wt = path.join(repo, '.agents', 'worktrees', id)
  fs.writeFileSync(path.join(wt, `${name}.md`), `${name} @ ${Date.now()}\n`)
  wtGit(wt, 'add -A')
  wtGit(wt, '-c user.name=test -c user.email=test@local commit -m "chore: task change"')
  return wtGit(wt, 'rev-parse HEAD')
}

function lockPath(repo: string): string {
  return path.join(repo, '.agents', 'worktrees', '.finish.lock')
}

/** 起一个存活 30s 的占位进程，把它的 pid 写进 .finish.lock（模拟并发 finish 持锁者）。 */
function writeLiveHolderLock(repo: string, task = 'holder'): { stop: () => void } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  fs.writeFileSync(lockPath(repo), JSON.stringify({ pid: child.pid, task, time: new Date().toISOString() }))
  const pid = child.pid!
  return {
    stop: () => {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      try { fs.rmSync(lockPath(repo), { force: true }) } catch { /* nothing to clean */ }
    },
  }
}

describe('feature-branch finish 门禁快捷路径（T13）', () => {
  it('① gate head 一致 + develop 未前进 → 跳过全量（计数器 0），正常合并', () => {
    const c = mkCounter()
    const repo = mkRepo({ testCmd: COUNTER_CMD })
    try {
      fb(repo.root, 'start gs-ok')
      const head = commitInWorktree(repo.root, 'gs-ok', 'note')
      const r = fb(repo.root, 'finish gs-ok --skip-test', { ORCHESTRATOR_GATE_HEAD: head, MV_COUNTER: c.file })
      expect(r.status).toBe(0)
      expect(r.out).toContain('skipping the duplicate full test run')
      expect(c.count()).toBe(0)
      expect(git(repo.root, 'log --oneline -1')).toContain("Merge branch 'feature/gs-ok'")
      expect(fs.existsSync(path.join(repo.root, '.agents', 'worktrees', 'gs-ok'))).toBe(false)
    } finally {
      repo.cleanup()
      c.cleanup()
    }
  })

  it('②a worktree HEAD 与 gate 记录不一致 → 拒绝跳过、回落全量（计数器 1）', () => {
    const c = mkCounter()
    const repo = mkRepo({ testCmd: COUNTER_CMD })
    try {
      fb(repo.root, 'start gs-hm')
      commitInWorktree(repo.root, 'gs-hm', 'note')
      const r = fb(repo.root, 'finish gs-hm --skip-test', { ORCHESTRATOR_GATE_HEAD: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', MV_COUNTER: c.file })
      expect(r.status).toBe(0)
      expect(r.out).toContain('--skip-test declined')
      expect(r.out).toContain('worktree tree changed since the gate run')
      expect(c.count()).toBe(1)
      expect(git(repo.root, 'log --oneline -1')).toContain("Merge branch 'feature/gs-hm'")
    } finally {
      repo.cleanup()
      c.cleanup()
    }
  })

  it('②b develop 已前进 → 拒绝跳过、rebase 后回落全量（计数器 1）', () => {
    const c = mkCounter()
    const repo = mkRepo({ testCmd: COUNTER_CMD })
    try {
      fb(repo.root, 'start gs-behind')
      const head = commitInWorktree(repo.root, 'gs-behind', 'note')
      // develop 前进一提交：gate head 仍「匹配」，但 rebase 会重写树 → 必须回落全量
      //（定点 add README.md：worktree 目录不能被 add -A 收成 gitlink——夹具 .gitignore 已挡，双保险）
      fs.appendFileSync(path.join(repo.root, 'README.md'), 'advance\n')
      git(repo.root, 'add README.md')
      git(repo.root, 'commit -m advance')
      const r = fb(repo.root, 'finish gs-behind --skip-test', { ORCHESTRATOR_GATE_HEAD: head, MV_COUNTER: c.file })
      expect(r.status).toBe(0)
      expect(r.out).toContain('--skip-test declined')
      expect(r.out).toContain('advanced by 1 commit')
      expect(c.count()).toBe(1)
      expect(git(repo.root, 'log --oneline -1')).toContain("Merge branch 'feature/gs-behind'")
    } finally {
      repo.cleanup()
      c.cleanup()
    }
  })

  it('④ 人工 --skip-test（无 ORCHESTRATOR_GATE_HEAD）→ 原语义直接跳过，不拒不给', () => {
    const c = mkCounter()
    const repo = mkRepo({ testCmd: COUNTER_CMD })
    try {
      fb(repo.root, 'start gs-human')
      commitInWorktree(repo.root, 'gs-human', 'note')
      const r = fb(repo.root, 'finish gs-human --skip-test', { MV_COUNTER: c.file })
      expect(r.status).toBe(0)
      expect(r.out).not.toContain('declined')
      expect(c.count()).toBe(0)
      expect(git(repo.root, 'log --oneline -1')).toContain("Merge branch 'feature/gs-human'")
    } finally {
      repo.cleanup()
      c.cleanup()
    }
  })
})

describe('feature-branch finish 锁行为（T13）', () => {
  it('③a 持锁者存活 → 有界等待，超时退出并提示 waited', () => {
    const repo = mkRepo()
    let holder: { stop: () => void } | null = null
    try {
      fb(repo.root, 'start lk-wait')
      commitInWorktree(repo.root, 'lk-wait', 'note')
      holder = writeLiveHolderLock(repo.root)
      const r = fb(repo.root, 'finish lk-wait', { FINISH_LOCK_WAIT_SECONDS: '1' })
      expect(r.status).toBe(1)
      expect(r.err).toContain('still running after waiting')
      // 超时失败发生在动任何 git 状态之前：worktree 与分支原样保留
      expect(fs.existsSync(path.join(repo.root, '.agents', 'worktrees', 'lk-wait'))).toBe(true)
    } finally {
      holder?.stop()
      repo.cleanup()
    }
  }, 30_000)

  it('③b FINISH_LOCK_WAIT_SECONDS=0 → 恢复 legacy fail-fast（already running）', () => {
    const repo = mkRepo()
    let holder: { stop: () => void } | null = null
    try {
      fb(repo.root, 'start lk-fast')
      commitInWorktree(repo.root, 'lk-fast', 'note')
      holder = writeLiveHolderLock(repo.root)
      const r = fb(repo.root, 'finish lk-fast', { FINISH_LOCK_WAIT_SECONDS: '0' })
      expect(r.status).toBe(1)
      expect(r.err).toContain('another finish is already running')
      expect(r.err).not.toContain('waiting')
    } finally {
      holder?.stop()
      repo.cleanup()
    }
  })

  it('③c 持锁者中途释放锁 → 等待方拿到锁完成合并', () => {
    const c = mkCounter()
    const repo = mkRepo({ testCmd: COUNTER_CMD })
    try {
      fb(repo.root, 'start lk-rel')
      commitInWorktree(repo.root, 'lk-rel', 'note')
      // 占位进程持有锁 5s 后删锁再继续存活：等待方轮询应先见「存活持有者」、后拿到释放的锁
      //（留足余量——测试机高负载时 finish 子进程冷启可能晚于更短的延迟）
      const child = spawn(
        process.execPath,
        ['-e', 'const fs=require("fs");setTimeout(()=>fs.unlinkSync(process.argv[1]),5000);setTimeout(()=>{},20000)', lockPath(repo.root)],
        { stdio: 'ignore' },
      )
      const holderPid = child.pid!
      fs.writeFileSync(lockPath(repo.root), JSON.stringify({ pid: holderPid, task: 'holder', time: new Date().toISOString() }))
      try {
        const r = fb(repo.root, 'finish lk-rel', { FINISH_LOCK_WAIT_SECONDS: '30', MV_COUNTER: c.file })
        expect(r.status).toBe(0)
        expect(r.out).toContain('waiting up to 30s')
        expect(git(repo.root, 'log --oneline -1')).toContain("Merge branch 'feature/lk-rel'")
      } finally {
        try { process.kill(holderPid, 'SIGKILL') } catch { /* already gone */ }
      }
    } finally {
      repo.cleanup()
      c.cleanup()
    }
  }, 60_000)

  it('⑤ 陈锁（心跳停跳）→ 自动接管语义不变，正常合并', async () => {
    const c = mkCounter()
    const repo = mkRepo({ testCmd: COUNTER_CMD })
    try {
      fb(repo.root, 'start lk-stale')
      commitInWorktree(repo.root, 'lk-stale', 'note')
      // 造「属主已死」的陈锁：锁判活自心跳改造（beat 每 15s 续期）后按 beat 新鲜度裁决，
      // pid 不再参与判活（Windows pid 复用 + 僵尸态都会让 kill(pid,0) 误报存活——
      // 本用例首版造「已退出 pid」就撞上：无 beat 的锁按 legacy 30min 阈值判活，等待方
      // 白等）。直接写「beat 停跳 2 分钟」的锁：心跳语义下的属主已死，接管应立即发生。
      fs.writeFileSync(lockPath(repo.root), JSON.stringify({
        pid: process.pid,
        task: 'crashed',
        time: new Date().toISOString(),
        beat: Date.now() - 120_000,
      }))
      const r = fb(repo.root, 'finish lk-stale', { MV_COUNTER: c.file })
      expect(r.status).toBe(0)
      expect(git(repo.root, 'log --oneline -1')).toContain("Merge branch 'feature/lk-stale'")
    } finally {
      repo.cleanup()
      c.cleanup()
    }
  })
})

describe('orchestrator approve 集成（T13）', () => {
  it('① 自动合并：gate 一次全量 + approve 走快捷路径（计数器只 +1）', () => {
    const c = mkCounter()
    const repo = mkRepo({ testCmd: COUNTER_CMD })
    try {
      const cardFile = path.join(repo.root, 'card-auto1.md')
      fs.writeFileSync(cardFile, cardText({ id: 'auto1', gate: 'L1', files_hint: ['docs/**'] }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run auto1 --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md', MV_COUNTER: c.file })
      expect(readCard(repo.root, 'merged', 'auto1')).toBeTruthy()
      // gate 记录了 worktree HEAD（快捷路径的安全前提）
      const testGate = eventsOf(repo.root, 'auto1').find((e) => e.type === 'gate_result' && e.gate === 'npm_test' && e.result === 'pass')
      expect(typeof testGate?.head).toBe('string')
      expect((testGate?.head as string).length).toBeGreaterThanOrEqual(40)
      // 全量只跑一遍：gate 一次，锁内 finish 不再重跑
      expect(c.count()).toBe(1)
    } finally {
      repo.cleanup()
      c.cleanup()
    }
  })

  it('② 人工 approve 同样走快捷路径（计数器只 +1）', () => {
    const c = mkCounter()
    const repo = mkRepo({ testCmd: COUNTER_CMD })
    try {
      const cardFile = path.join(repo.root, 'card-man1.md')
      fs.writeFileSync(cardFile, cardText({ id: 'man1', gate: 'L3', files_hint: ['docs/**'] }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run man1 --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md', MV_COUNTER: c.file })
      expect(readCard(repo.root, 'awaiting-human', 'man1')).toBeTruthy()
      const approve = runOrch(repo.root, 'approve man1', { MV_COUNTER: c.file })
      expect(approve.stdout).toContain('已合并')
      expect(c.count()).toBe(1)
    } finally {
      repo.cleanup()
      c.cleanup()
    }
  })

  it('⑤ 撞锁 → 有界重试后失败记 merge_lock_wait；解锁后重新 approve 成功', () => {
    const c = mkCounter()
    const repo = mkRepo({ testCmd: COUNTER_CMD })
    let holder: { stop: () => void } | null = null
    try {
      const cardFile = path.join(repo.root, 'card-man2.md')
      fs.writeFileSync(cardFile, cardText({ id: 'man2', gate: 'L3', files_hint: ['docs/**'] }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run man2 --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md', MV_COUNTER: c.file })
      expect(readCard(repo.root, 'awaiting-human', 'man2')).toBeTruthy()

      // 持锁者存活 + finish 锁等待关死 + orchestrator 重试压到 1 次 300ms → 快速失败
      holder = writeLiveHolderLock(repo.root)
      const failed = tryOrch(repo.root, 'approve man2', {
        MV_COUNTER: c.file,
        FINISH_LOCK_WAIT_SECONDS: '0',
        ORCH_FINISH_RETRY_ATTEMPTS: '1',
        ORCH_FINISH_RETRY_DELAY_MS: '300',
      })
      expect(failed.status).toBe(1)
      expect(failed.stderr).toContain('another finish is already running')
      expect(eventsOf(repo.root, 'man2').map((e) => e.type)).toContain('merge_lock_wait')
      // 任务卡滞留 awaiting-human（不丢）
      expect(readCard(repo.root, 'awaiting-human', 'man2')).toBeTruthy()

      // 解锁后重新 approve：finish 正常完成（快捷路径跳过全量，计数器仍 1）
      holder.stop()
      holder = null
      fs.rmSync(lockPath(repo.root), { force: true })
      const ok = runOrch(repo.root, 'approve man2', { MV_COUNTER: c.file })
      expect(ok.stdout).toContain('已合并')
      expect(c.count()).toBe(1)
    } finally {
      holder?.stop()
      repo.cleanup()
      c.cleanup()
    }
  }, 30_000)
})

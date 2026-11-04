// 任务级互斥锁测试（task-lock.mjs，.agents/docs design-orchestrator 10.6）：
// 同任务双驱动被拒、陈锁自动接管、正常闭环释放、abandon 存活守卫。
// 库级用例直接驱动模块（普通临时目录即可）；端到端走 CLI 子进程 + 临时仓库
// （mock 后端），与 integration.test.ts 同配方。

import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
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

/** 拿一个确定存活的外部 pid（长睡子进程）：活锁构造用——不能再用本进程 pid，
 *  acquire 对本进程已持有同把锁走重入豁免（held:true），不再按「他人持有」拒绝。 */
function livePid(): number {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' })
  return c.pid ?? 0
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
  it('活锁拒绝：持锁进程（他人）存活时 acquire 返回 held:false + owner', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-lib-'))
    const sleeper = livePid()
    try {
      seedLock(dir, 't-live', { pid: sleeper, task: 't-live', cmd: 'run' })
      const r = acquireTaskLock(dir, 't-live')
      expect(r.held).toBe(false)
      if (!r.held) {
        expect(r.owner.pid).toBe(sleeper)
        expect(r.unremovable).toBeUndefined()
      }
      // 拒绝时不该动别人的锁
      expect(readTaskLock(dir, 't-live')?.pid).toBe(sleeper)
    } finally {
      try { process.kill(sleeper) } catch { /* 已退 */ }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('重入豁免：同进程二次 acquire held:true；内层 release 不删锁，外层 release 才删', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-lib-'))
    try {
      expect(acquireTaskLock(dir, 't-reent').held).toBe(true) // 外层
      expect(acquireTaskLock(dir, 't-reent').held).toBe(true) // 内层（嵌套闭环）：旧实现这里 die 自指报错
      releaseTaskLock(dir, 't-reent') // 内层释放：锁文件还在（外层仍持有）
      expect(fs.existsSync(taskLockPath(dir, 't-reent'))).toBe(true)
      releaseTaskLock(dir, 't-reent') // 外层释放：删锁
      expect(fs.existsSync(taskLockPath(dir, 't-reent'))).toBe(false)
      // 全部释放后再 acquire 走正常路径
      expect(acquireTaskLock(dir, 't-reent').held).toBe(true)
      releaseTaskLock(dir, 't-reent')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exit handler 属主校验：进程退出时锁已易主（他人活锁）则不误删', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-exit-'))
    const sleeper = livePid()
    try {
      // 子进程：acquire（注册 exit hook、写自己的 pid）→ 把锁内容换成他人活锁 → 退出。
      // 旧实现 exit handler 无属主校验直接 rmSync——会删掉他人活锁、放行第三者双驱动
      const script = [
        "import fs from 'node:fs'",
        "import path from 'node:path'",
        "import { pathToFileURL } from 'node:url'",
        'const { acquireTaskLock } = await import(pathToFileURL(process.env.TL_MJS).href)',
        "acquireTaskLock(process.env.TL_DIR, 't-exit')",
        "fs.writeFileSync(path.join(process.env.TL_DIR, '.agents', 'orchestrator', '.run-t-exit.lock'), process.env.TL_LOCK)",
      ].join('\n')
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: {
          ...process.env,
          TL_DIR: dir,
          TL_MJS: path.resolve(import.meta.dirname, '../../.agents/scripts/orchestrator/task-lock.mjs'),
          TL_LOCK: JSON.stringify({ pid: sleeper, task: 't-exit', cmd: 'other' }),
        },
        encoding: 'utf8',
        timeout: 30_000,
      })
      expect(r.status).toBe(0)
      expect(readTaskLock(dir, 't-exit')?.pid).toBe(sleeper) // 他人活锁原样保留
    } finally {
      try { process.kill(sleeper) } catch { /* 已退 */ }
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

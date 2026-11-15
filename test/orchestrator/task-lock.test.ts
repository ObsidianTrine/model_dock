// 任务级互斥锁测试（task-lock.mjs，.agents/docs design-orchestrator 10.6）：
// 同任务双驱动被拒、陈锁自动接管、正常闭环释放、abandon 存活守卫。
// 库级用例直接驱动模块（普通临时目录即可）；端到端走 CLI 子进程 + 临时仓库
// （mock 后端），与 integration.test.ts 同配方。

import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { cardText, mkRepo, runOrch, runOrchInproc, tryOrch } from './helpers.js'
import { readLockJson, sleepSyncMs } from '../../.agents/scripts/orchestrator/lockio.mjs'
import {
  acquireTaskLock,
  readTaskLock,
  releaseTaskLock,
  taskLockBeatOnce,
  taskLockPath,
} from '../../.agents/scripts/orchestrator/task-lock.mjs'

const LOCKIO_URL = pathToFileURL(path.resolve(import.meta.dirname, '../../.agents/scripts/orchestrator/lockio.mjs')).href

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

async function submitCard(repo: string, id: string) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id }))
  await runOrchInproc(repo, `submit "${cardFile}"`)
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

describe('task-lock > 心跳原子写与读方加固（lockio，2026-11 P2 双驱动防线）', () => {
  it('并发心跳原子写：读方全程裸 parse 不遇坏 JSON，结束后无 tmp 残留', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-atomic-'))
    const lockPath = path.join(dir, '.run-beat.lock')
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, beat: 0 }))
    // 两个 worker 线程各连写 50 拍（tmp+rename 原子写）；主线程裸 readFileSync+JSON.parse
    // 赛跑——旧原地截断重写形态下读方必然撞上半个 JSON，原子写下一个都不该出现
    const script = [
      `const { parentPort, workerData } = require('node:worker_threads')`,
      `import(${JSON.stringify(LOCKIO_URL)}).then(({ writeLockAtomic, sleepSyncMs }) => {`,
      `  for (let i = 0; i < workerData.writes; i++) {`,
      `    writeLockAtomic(workerData.lock, JSON.stringify({ pid: workerData.pid, seq: i, thread: workerData.idx, beat: Date.now() }))`,
      `    sleepSyncMs(1)`,
      `  }`,
      `  parentPort.postMessage('done')`,
      `})`,
    ].join('\n')
    const workers = [0, 1].map((idx) =>
      new Worker(script, { eval: true, workerData: { lock: lockPath, writes: 50, idx, pid: 4242 } })
    )
    const exited = workers.map((w) => new Promise<number>((resolve) => w.on('exit', (code) => resolve(code ?? -1))))
    let parseFailures = 0
    let reads = 0
    const readUntil = Date.now() + 1500
    while (Date.now() < readUntil) {
      try {
        JSON.parse(fs.readFileSync(lockPath, 'utf8'))
        reads++
      } catch {
        parseFailures++
      }
      sleepSyncMs(1)
    }
    const codes = await Promise.all(exited)
    expect(codes).toEqual([0, 0])
    expect(parseFailures).toBe(0)
    expect(reads).toBeGreaterThan(10)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(4242)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 30_000)

  it('读方加固：瞬时坏 JSON（写窗口）退避重读恢复，不误判陈锁接管（修复前这里会 held:true 双驱动）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-flash-'))
    const sleeper = livePid()
    try {
      fs.mkdirSync(path.dirname(taskLockPath(dir, 't-flash')), { recursive: true })
      const good = JSON.stringify({ pid: sleeper, task: 't-flash', cmd: 'run', beat: Date.now() })
      // worker 先启动握手就绪，再由 SAB 旗标触发写——写延迟 ~1ms，确定性落在首读（坏）
      // 与 80ms 重读（好）之间；worker 启动慢（CI 负载）也不至于漂出重读窗
      const sab = new SharedArrayBuffer(4)
      const w = new Worker(
        [
          `const { parentPort, workerData } = require('node:worker_threads')`,
          `const fs = require('node:fs')`,
          `const flag = new Int32Array(workerData.sab)`,
          `parentPort.postMessage('ready')`,
          `const timer = setInterval(() => {`,
          `  if (Atomics.load(flag, 0) !== 1) return`,
          `  clearInterval(timer)`,
          `  try { fs.writeFileSync(workerData.lock, workerData.payload) } catch { /* 主线程已清理 */ }`,
          `  parentPort.postMessage('written')`,
          `}, 1)`,
        ].join('\n'),
        { eval: true, workerData: { sab, lock: taskLockPath(dir, 't-flash'), payload: good } }
      )
      await new Promise<void>((resolve) => w.on('message', (m) => { if (m === 'ready') resolve() }))
      fs.writeFileSync(taskLockPath(dir, 't-flash'), '{torn') // 半个 JSON：写窗口形态
      const written = new Promise<void>((resolve) => w.on('message', (m) => { if (m === 'written') resolve() }))
      Atomics.store(new Int32Array(sab), 0, 1)
      const r = acquireTaskLock(dir, 't-flash')
      expect(r.held).toBe(false)
      if (!r.held) expect(r.owner.pid).toBe(sleeper)
      await written
      expect(readTaskLock(dir, 't-flash')?.pid).toBe(sleeper) // 接管未发生，他人活锁原样
    } finally {
      try { process.kill(sleeper) } catch { /* 已退 */ }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('读方加固不放过真陈锁：坏 JSON 重读后仍坏 → 照常接管', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-corrupt-'))
    try {
      fs.mkdirSync(path.dirname(taskLockPath(dir, 't-corrupt')), { recursive: true })
      fs.writeFileSync(taskLockPath(dir, 't-corrupt'), '{broken')
      const r = acquireTaskLock(dir, 't-corrupt')
      expect(r.held).toBe(true)
      expect(readTaskLock(dir, 't-corrupt')?.pid).toBe(process.pid)
      releaseTaskLock(dir, 't-corrupt')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('taskLockBeatOnce：属主续写 beat（原子落盘仍可解析）；他人锁不动（易主防御）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-beat-'))
    try {
      seedLock(dir, 't-beat', { pid: process.pid, task: 't-beat', cmd: 'run', beat: 1 })
      taskLockBeatOnce(taskLockPath(dir, 't-beat'))
      const info = readTaskLock(dir, 't-beat')
      expect(info?.pid).toBe(process.pid)
      expect(info?.beat).toBeGreaterThan(1)
      const foreign = { pid: 999_999, task: 't-beat2', cmd: 'run', beat: 42 }
      seedLock(dir, 't-beat2', foreign)
      taskLockBeatOnce(taskLockPath(dir, 't-beat2'))
      expect(readTaskLock(dir, 't-beat2')).toEqual(foreign)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readLockJson：无锁文件返回 null（不重读）；坏 JSON 退避重读一次', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-read-'))
    try {
      expect(readLockJson(path.join(dir, 'absent.lock'))).toBeNull()
      const p = path.join(dir, 'x.lock')
      fs.writeFileSync(p, '{nope')
      expect(readLockJson(p)).toBeNull()
      fs.writeFileSync(p, JSON.stringify({ pid: 7, beat: 9 }))
      expect(readLockJson(p)).toEqual({ pid: 7, beat: 9 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('task-lock > run 端到端（CLI + mock 后端）', () => {
  it('已有进行中闭环（活锁）时 run 被拒，任务卡留在 pending', async () => {
    const repo = mkRepo()
    try {
      await submitCard(repo.root, 'locked')
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

  it('陈锁自动接管：崩溃残留的锁不阻塞恢复，闭环照常跑完且锁已释放', async () => {
    const repo = mkRepo()
    try {
      await submitCard(repo.root, 'crashy')
      fs.writeFileSync(taskLockPath(repo.root, 'crashy'), JSON.stringify({ pid: deadPid(), task: 'crashy', cmd: 'run', acquired_at: new Date().toISOString() }))
      const r = runOrch(repo.root, 'run crashy --backend mock')
      expect(r.stdout).toContain('接管陈旧任务锁')
      expect(fs.existsSync(taskLockPath(repo.root, 'crashy'))).toBe(false)
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'awaiting-human', 'crashy.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('正常闭环结束后锁已释放（无残留锁文件）', async () => {
    const repo = mkRepo()
    try {
      await submitCard(repo.root, 'flow')
      runOrch(repo.root, 'run flow --backend mock')
      expect(fs.existsSync(taskLockPath(repo.root, 'flow'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('abandon 守卫：闭环存活时拒绝；陈锁（崩溃残留）时可正常放弃', async () => {
    const repo = mkRepo()
    try {
      await submitCard(repo.root, 'doomed')
      fs.writeFileSync(taskLockPath(repo.root, 'doomed'), JSON.stringify({ pid: process.pid, task: 'doomed', cmd: 'run' }))
      const refused = await runOrchInproc(repo.root, 'abandon doomed')
      expect(refused.status).not.toBe(0)
      expect(refused.stderr).toContain('闭环仍在运行')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'doomed.md'))).toBe(true)

      fs.writeFileSync(taskLockPath(repo.root, 'doomed'), JSON.stringify({ pid: deadPid(), task: 'doomed', cmd: 'run' }))
      await runOrchInproc(repo.root, 'abandon doomed')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'failed', 'doomed.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })
})

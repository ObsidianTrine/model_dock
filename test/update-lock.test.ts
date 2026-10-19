import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { acquireUpdateLock, updateLockPath } from '../src/update/lock.js'
import { updateProgressPath } from '../src/update/progress.js'

// 纯 fs 逻辑、进程内零 mock，天然与别的测试文件互不干扰（isolate:false 共享注册表不受影响）。

/** 造一个「已死进程」的 pid：起一个立即退出的子进程，spawnSync 返回时它已不在（测试窗口内 pid 不会复用） */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 })
  return r.pid ?? -1
}

/** 直写进度文件（不走 writeUpdateProgress，避开模块级节流状态） */
function writeProgress(stage: string): void {
  fs.mkdirSync(path.dirname(updateProgressPath()), { recursive: true })
  fs.writeFileSync(
    updateProgressPath(),
    JSON.stringify({ stage, received: 0, total: 100, percent: 0, error: null, at: Date.now() }) + '\n'
  )
}

describe('update lock（跨进程更新互斥）', () => {
  it('独占持有：第二个并发获取被拒（可操作报错），release 后可再取', async () => {
    const h = fakeHome()
    try {
      const release = await acquireUpdateLock()
      const lockFile = updateLockPath()
      expect(fs.existsSync(lockFile)).toBe(true)
      expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.pid)

      await expect(acquireUpdateLock()).rejects.toThrow(/另一个更新进程正在运行/)

      release()
      expect(fs.existsSync(lockFile)).toBe(false)
      const release2 = await acquireUpdateLock()
      release2()
    } finally {
      h.restore()
    }
  })

  it('release 只删自己的锁：文件被他人覆盖后 release 不动它', async () => {
    const h = fakeHome()
    try {
      const release = await acquireUpdateLock()
      fs.writeFileSync(updateLockPath(), JSON.stringify({ pid: process.pid + 1, startedAt: new Date().toISOString() }))
      release()
      expect(JSON.parse(fs.readFileSync(updateLockPath(), 'utf8')).pid).toBe(process.pid + 1)
    } finally {
      h.restore()
    }
  })

  it('陈锁接管：持有者已死 → 自动接管', async () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(path.dirname(updateLockPath()), { recursive: true })
      fs.writeFileSync(updateLockPath(), JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }))
      const release = await acquireUpdateLock()
      expect(JSON.parse(fs.readFileSync(updateLockPath(), 'utf8')).pid).toBe(process.pid)
      release()
    } finally {
      h.restore()
    }
  })

  it('陈锁接管：锁超时（持有者活着但超 1 小时）→ 接管', async () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(path.dirname(updateLockPath()), { recursive: true })
      const old = new Date(Date.now() - 61 * 60_000).toISOString()
      fs.writeFileSync(updateLockPath(), JSON.stringify({ pid: process.pid, startedAt: old }))
      const release = await acquireUpdateLock()
      release()
    } finally {
      h.restore()
    }
  })

  it('锁超时但持有者存活且更新在途（进度文件新鲜非终态）→ 拒绝接管', async () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(path.dirname(updateLockPath()), { recursive: true })
      const old = new Date(Date.now() - 61 * 60_000).toISOString()
      fs.writeFileSync(updateLockPath(), JSON.stringify({ pid: process.pid, startedAt: old }))
      writeProgress('downloading')
      await expect(acquireUpdateLock()).rejects.toThrow(/另一个更新进程正在运行/)
      // 锁未被接管：仍是原持有者的锁
      expect(JSON.parse(fs.readFileSync(updateLockPath(), 'utf8')).startedAt).toBe(old)
    } finally {
      h.restore()
    }
  })

  it('锁超时且持有者存活、进度已终态（done）→ 照旧接管', async () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(path.dirname(updateLockPath()), { recursive: true })
      const old = new Date(Date.now() - 61 * 60_000).toISOString()
      fs.writeFileSync(updateLockPath(), JSON.stringify({ pid: process.pid, startedAt: old }))
      writeProgress('done')
      const release = await acquireUpdateLock()
      expect(JSON.parse(fs.readFileSync(updateLockPath(), 'utf8')).pid).toBe(process.pid)
      release()
    } finally {
      h.restore()
    }
  })

  it('损坏锁（空文件）→ 接管', async () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(path.dirname(updateLockPath()), { recursive: true })
      fs.writeFileSync(updateLockPath(), '')
      const release = await acquireUpdateLock()
      release()
      expect(fs.existsSync(updateLockPath())).toBe(false)
    } finally {
      h.restore()
    }
  })
})

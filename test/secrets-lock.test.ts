import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { acquireFileLock, __testSetLockTiming } from '../src/util/fsx.js'
import {
  SecretsError,
  getSecret,
  invalidateSecretsCache,
  secretsLockPath,
  setSecret,
  __testSetDpapiBatch,
} from '../src/config/secrets.js'
import { fakeHome, waitFor } from './helpers.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** secrets 写锁防陈锁误抢占（2026-10-30 生产覆盖事故同型路径）：
 *  mutateFileSecrets 全程持锁做 DPAPI 解密+加密（win32 spawn PowerShell，最坏 ~40s ≫
 *  lockStaleMs 15s），另一进程按陈锁抢入临界区 →「读整表→改→整表写回」后写覆盖先写，
 *  静默丢刚设置的 key。修复取「持锁喂狗」方案（决策与理由见 worktree NOTES.md）：
 *  活持有者心跳刷新锁 mtime，陈锁判定永不满足；死者（崩溃/被杀）心跳随进程消失，抢占语义不变。
 *  等价证明口径（验收二选一之后者）：锁内慢操作场景，第二进程抢占不再成立、不再双写。 */
describe('secrets 写锁：持锁喂狗防陈锁误抢占（fix-core-reliability 修复点 1）', () => {
  it('持锁心跳：慢持有者占锁超过陈锁阈值，锁文件 mtime 持续刷新、陈锁判定永不满足，release 后锁正常释放', async () => {
    const h = fakeHome()
    const lock = secretsLockPath()
    // 心跳 40ms / 陈锁阈值 200ms：占锁 400ms（2 倍阈值）——无心跳时此刻早已可被抢占
    __testSetLockTiming({ heartbeatMs: 40, staleMs: 200 })
    try {
      const release = await acquireFileLock(lock)
      const first = fs.statSync(lock).mtimeMs
      await sleep(400)
      const st = fs.statSync(lock)
      expect(st.mtimeMs).toBeGreaterThan(first) // mtime 被心跳刷新过
      expect(Date.now() - st.mtimeMs).toBeLessThan(200) // 陈锁判定不满足：抢占分支进不去
      release()
      expect(fs.existsSync(lock)).toBe(false) // 归属校验删除照常
    } finally {
      __testSetLockTiming()
      h.restore()
    }
  })

  it('对照：无心跳（间隔远大于陈锁阈值）时陈锁判定会满足——旧实现的抢占窗口真实存在，用例判据非恒真', async () => {
    const h = fakeHome()
    const lock = secretsLockPath()
    __testSetLockTiming({ heartbeatMs: 60_000, staleMs: 100 })
    try {
      const release = await acquireFileLock(lock)
      await sleep(250)
      expect(Date.now() - fs.statSync(lock).mtimeMs).toBeGreaterThan(100) // 旧实现此处会被第二进程抢占
      release()
    } finally {
      __testSetLockTiming()
      h.restore()
    }
  })

  it('慢持有者占锁期间走真实 mutate 路径的 setSecret 拿锁失败（可操作报错）而不是闯入临界区双写；释放后恢复正常', async () => {
    const h = fakeHome()
    const lock = secretsLockPath()
    // 心跳 50ms / 陈锁阈值 300ms / 抢锁总超时 700ms：持有者模拟「临界区内慢 DPAPI」——
    // 直接 acquireFileLock 持锁不放（等价另一进程正在 mutateFileSecrets 的解密/加密里）。
    // 旧实现：300ms 后持锁者被当陈锁抢占，setSecret 成功 → 双写者 → 丢更新；
    // 新实现：心跳保活，setSecret 等满抢锁超时拿可操作报错，绝不闯入。
    __testSetLockTiming({ heartbeatMs: 50, staleMs: 300, acquireTimeoutMs: 700 })
    try {
      const release = await acquireFileLock(lock)
      let caught: unknown
      try {
        await setSecret('no-preempt', 'sk-v', 'file')
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(SecretsError) // secrets 锁超时的可操作报错（非静默、非抢占成功）
      expect((caught as Error).message).toContain('secrets') // 指向 secrets.json.lock
      expect(fs.existsSync(lock)).toBe(true) // 抢占未发生：锁仍是持有者的
      release()
      expect(fs.existsSync(lock)).toBe(false)
      // 释放后恢复正常：写入 + 读取往返一致
      const ref = await setSecret('no-preempt', 'sk-v', 'file')
      expect(await getSecret(ref)).toBe('sk-v')
    } finally {
      __testSetLockTiming()
      invalidateSecretsCache()
      h.restore()
    }
  })

  it('win32 端到端：mutate 锁内慢 DPAPI 加密期间，第二进程按陈锁抢占被喂狗阻断，setSecret 完整落地', async () => {
    if (process.platform !== 'win32') return // DPAPI 是 win32 file 后端专属；跨平台通用防线见上方用例
    const h = fakeHome()
    const lock = secretsLockPath()
    __testSetLockTiming({ heartbeatMs: 50, staleMs: 200, acquireTimeoutMs: 300 })
    try {
      invalidateSecretsCache()
      __testSetDpapiBatch(async (_script, b64In) => {
        await sleep(400) // 模拟 PowerShell spawn 慢（真实最坏 2 次重试 × 10s 超时）
        return b64In // base64 恒等：加密前缀拼接即往返
      })
      // A：走真实 mutateFileSecrets 路径持锁，DPAPI 加密在锁内 400ms > 陈锁阈值 200ms
      const a = setSecret('dpapi-slow', 'sk-slow', 'file')
      await waitFor(() => fs.existsSync(lock)) // A 已拿锁、正在锁内慢加密
      // B：模拟另一进程直接抢锁（绕过本进程队列，与跨进程实况同构）——
      // 旧实现 200ms 后按陈锁 unlink 抢入，与 A 同处临界区形成双写者
      await expect(acquireFileLock(lock)).rejects.toThrow()
      await expect(a).resolves.toBe('file:dpapi-slow')
      expect(await getSecret('file:dpapi-slow')).toBe('sk-slow') // 刚设置的 key 未被覆盖丢失
    } finally {
      __testSetDpapiBatch()
      __testSetLockTiming()
      invalidateSecretsCache()
      h.restore()
    }
  })

  it('并发两个 setSecret（进程内队列串行）：两 key 都落盘，互不覆盖（丢更新防线回归网）', async () => {
    const h = fakeHome()
    try {
      invalidateSecretsCache()
      await Promise.all([setSecret('lock-a', 'v-a', 'file'), setSecret('lock-b', 'v-b', 'file')])
      expect(await getSecret('file:lock-a')).toBe('v-a')
      expect(await getSecret('file:lock-b')).toBe('v-b')
    } finally {
      invalidateSecretsCache()
      h.restore()
    }
  })
})

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { pruneExpiredLogs } from '../src/gateway/state.js'
import { logsDir } from '../src/util/paths.js'
import { appendLine } from '../src/util/fsx.js'

/** 距 now 偏移 offsetDays 天的日文件名（本地时区，与 state.ts 落盘命名 entry.ts.slice(0,10) 同构） */
function dayName(prefix: 'gateway' | 'audit', offsetDays: number, now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${prefix}-${d.getFullYear()}-${mm}-${dd}.jsonl`
}

describe('JSONL 日志保留期清理', () => {
  it('超期日文件删除；边界（第 30 天保留、第 31 天删除）、未来日期与不匹配命名的文件不动', async () => {
    const h = fakeHome()
    try {
      const now = new Date()
      fs.mkdirSync(logsDir(), { recursive: true })
      const expired = [dayName('gateway', 31, now), dayName('audit', 40, now), dayName('gateway', 120, now)]
      const kept = [dayName('gateway', 30, now), dayName('audit', 5, now), dayName('gateway', 0, now), dayName('gateway', -365, now)]
      const decoys = ['gateway-foo.jsonl', 'audit-2026-13-99.jsonl', 'gateway-2020-01-01.jsonl.bak', 'other.txt']
      for (const n of [...expired, ...kept, ...decoys]) fs.writeFileSync(path.join(logsDir(), n), '{}\n')
      const pruned = await pruneExpiredLogs(30, now)
      expect(pruned).toBe(expired.length)
      for (const n of expired) expect(fs.existsSync(path.join(logsDir(), n))).toBe(false)
      for (const n of [...kept, ...decoys]) expect(fs.existsSync(path.join(logsDir(), n))).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('log_retention_days=0 禁用清理，全部保留', async () => {
    const h = fakeHome()
    try {
      const now = new Date()
      fs.mkdirSync(logsDir(), { recursive: true })
      const all = [dayName('gateway', 400, now), dayName('audit', 400, now)]
      for (const n of all) fs.writeFileSync(path.join(logsDir(), n), '{}\n')
      expect(await pruneExpiredLogs(0, now)).toBe(0)
      expect(await pruneExpiredLogs(-1, now)).toBe(0)
      for (const n of all) expect(fs.existsSync(path.join(logsDir(), n))).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('日志目录不存在返回 0 不抛错', async () => {
    const h = fakeHome()
    try {
      expect(await pruneExpiredLogs(30)).toBe(0)
    } finally {
      h.restore()
    }
  })

  it('常驻流池持有句柄的日文件先关流再删（Windows 上有本进程 fd 时 unlink 报 EPERM）', async () => {
    const h = fakeHome()
    try {
      const now = new Date()
      fs.mkdirSync(logsDir(), { recursive: true })
      const full = path.join(logsDir(), dayName('gateway', 40, now))
      fs.writeFileSync(full, '{"seed":1}\n')
      appendLine(full, '{"x":1}\n')
      // closeAppendStream 会等流 open+close 完成才返回，fd 必然已释放，删除在 Windows 上也不撞 EPERM
      expect(await pruneExpiredLogs(30, now)).toBe(1)
      expect(fs.existsSync(full)).toBe(false)
    } finally {
      h.restore()
    }
  })
})

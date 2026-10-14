import { describe, expect, it, beforeEach } from 'vitest'
import fs from 'node:fs'
import { fakeHome } from './helpers.js'
import {
  writeUpdateProgress,
  readUpdateProgress,
  resetUpdateProgressThrottleForTests,
  updateProgressPath,
} from '../src/update/progress.js'

// 更新进度文件（update-progress.json）：update --yes 子进程写、托盘/控制台读。
// 节流与残留过期是两个关键行为（读不到进度 = 界面回到「毫无动静」的老问题）。
describe('update-progress.json 进度文件', () => {
  beforeEach(() => resetUpdateProgressThrottleForTests())

  it('写入→读回：阶段/字节/百分比成对落盘', async () => {
    const h = fakeHome()
    try {
      await writeUpdateProgress('downloading', 0, 1000)
      expect(await readUpdateProgress()).toMatchObject({ stage: 'downloading', received: 0, total: 1000, percent: 0 })
      // 同阶段百分比变化有 200ms 合并窗：等待窗口过后再写（真实下载中回调间隔远大于此）
      await new Promise((r) => setTimeout(r, 250))
      await writeUpdateProgress('downloading', 500, 1000)
      const p = await readUpdateProgress()
      expect(p?.percent).toBe(50)
      expect(p?.received).toBe(500)
      expect(fs.existsSync(updateProgressPath())).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('节流：200ms 内阶段与百分比均未变化不落盘；阶段变化立即落盘', async () => {
    const h = fakeHome()
    try {
      await writeUpdateProgress('downloading', 0, 1000)
      await writeUpdateProgress('downloading', 5, 1000) // percent 仍 0、阶段同、<200ms → 不落盘
      expect((await readUpdateProgress())?.received).toBe(0)
      await writeUpdateProgress('verifying', 1000, 1000) // 阶段变化 → 立即落盘
      expect((await readUpdateProgress())?.stage).toBe('verifying')
    } finally {
      h.restore()
    }
  })

  it('终态总是落盘：done=100%，failed 带错误信息', async () => {
    const h = fakeHome()
    try {
      await writeUpdateProgress('downloading', 100, 1000)
      await writeUpdateProgress('done', 1000, 1000)
      const p = await readUpdateProgress()
      expect(p?.stage).toBe('done')
      expect(p?.percent).toBe(100)
      await writeUpdateProgress('failed', 0, 0, '网络不可达')
      const f = await readUpdateProgress()
      expect(f?.stage).toBe('failed')
      expect(f?.error).toBe('网络不可达')
    } finally {
      h.restore()
    }
  })

  it('残留过期：at 超过 10 分钟读出 null（上次更新的残留不展示）', async () => {
    const h = fakeHome()
    try {
      await writeUpdateProgress('done', 1000, 1000)
      // 手工把 at 拨回 11 分钟前
      const raw = JSON.parse(fs.readFileSync(updateProgressPath(), 'utf8'))
      raw.at = Date.now() - 11 * 60_000
      fs.writeFileSync(updateProgressPath(), JSON.stringify(raw))
      expect(await readUpdateProgress()).toBeNull()
    } finally {
      h.restore()
    }
  })
})

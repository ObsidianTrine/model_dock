// watch 连续自治运行测试（mock 后端）：周期闭环（drain → scan）、stop 文件即停、
// drift 降级自动退出、瞬时故障 blocked 卡的一次性有痕重探（投机执行）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { appendEvent } from '../../.agents/scripts/orchestrator/events.mjs'
import { cardText, eventsOf, mkRepo, readCard, runOrch } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

describe('orchestrator watch > 周期闭环', () => {
  it('周期 1 drain pending 到 awaiting-human；周期 2 队列空走 scan 后退出', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'w-card')
      const out = runOrch(repo.root, 'watch --max-cycles 2 --interval 0 --backend mock')
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('watch 周期 1')
      expect(out.stdout).toContain('watch 周期 2')
      expect(out.stdout).toContain('已达 --max-cycles 2')
      expect(readCard(repo.root, 'awaiting-human', 'w-card')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 90_000)

  it('stop 文件即停：首周期检测到即退出并清掉 stop 文件', () => {
    const repo = mkRepo()
    try {
      const stop = path.join(repo.root, '.agents', 'orchestrator', '.watch-stop')
      fs.mkdirSync(path.dirname(stop), { recursive: true })
      fs.writeFileSync(stop, '')
      const out = runOrch(repo.root, 'watch --max-cycles 5 --interval 0 --backend mock')
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('.watch-stop')
      expect(out.stdout).toContain('watch 退出')
      expect(fs.existsSync(stop)).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('drift 降级生效：watch 直接退出（保险丝不允许自己插回去）', () => {
    const repo = mkRepo()
    try {
      fs.mkdirSync(path.join(repo.root, '.agents', 'orchestrator'), { recursive: true })
      fs.writeFileSync(path.join(repo.root, '.agents', 'orchestrator', 'degraded.json'), JSON.stringify({ degraded_at: new Date().toISOString(), reason: '测试注入' }))
      const out = runOrch(repo.root, 'watch --max-cycles 3 --interval 0 --backend mock')
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('drift 降级')
      expect(out.stdout).toContain('watch 退出')
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('autopilot 关闭：队列空周期只 scan 不 propose（无 planner 会话）', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'watch --max-cycles 1 --interval 0 --backend mock')
      expect(out.stdout).not.toContain('propose（autopilot 需求综合）')
    } finally {
      repo.cleanup()
    }
  }, 60_000)
})

describe('orchestrator watch > 瞬时故障 blocked 卡的有痕重探（投机执行）', () => {
  it('blocked+瞬时签名 → speculative_resume 留痕 → resume 续跑到 awaiting-human', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'w-rescue')
      // 手工把卡摆成「worker 异常结束 + 瞬时签名」的 blocked 现场（伪造事件流：
      // pid 用必死的 999999，防 cleanupOrphanWorker 误杀活进程）
      const logsDir = path.join(repo.root, '.agents', 'orchestrator', 'logs', 'w-rescue')
      fs.mkdirSync(logsDir, { recursive: true })
      appendEvent(logsDir, 'task_accepted', {})
      appendEvent(logsDir, 'worker_spawned', { backend: 'mock', pid: 999999 })
      appendEvent(logsDir, 'worker_stderr_tail', { text: 'request failed: ECONNRESET socket hang up (429 too many requests)' })
      appendEvent(logsDir, 'blocked', { reason: '未产出结果块（worker 异常结束）' })
      fs.renameSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'w-rescue.md'), path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', 'w-rescue.md'))

      const out = runOrch(repo.root, 'watch --max-cycles 1 --interval 0 --backend mock')
      expect(out.stdout).toContain('有痕重探一次')
      const types = eventsOf(repo.root, 'w-rescue').map((e) => e.type)
      expect(types).toContain('speculative_resume')
      // 重探 = resume 闭环：mock worker done → 门禁 → 审查 → gate L3 落 awaiting-human
      expect(readCard(repo.root, 'awaiting-human', 'w-rescue')).toBeTruthy()

      // 终态卡不再重探（每卡终身一次）：再跑一个周期无新 speculative_resume
      fs.renameSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'awaiting-human', 'w-rescue.md'), path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', 'w-rescue.md'))
      runOrch(repo.root, 'watch --max-cycles 1 --interval 0 --backend mock')
      expect(eventsOf(repo.root, 'w-rescue').filter((e) => e.type === 'speculative_resume')).toHaveLength(1)
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('熔断卡（circuit_breaker 在案）与自报 stuck 卡不重探', () => {
    const repo = mkRepo()
    try {
      for (const id of ['w-cb', 'w-stuck']) {
        submitCard(repo.root, id)
        const logsDir = path.join(repo.root, '.agents', 'orchestrator', 'logs', id)
        fs.mkdirSync(logsDir, { recursive: true })
        appendEvent(logsDir, 'task_accepted', {})
        appendEvent(logsDir, 'worker_stderr_tail', { text: 'ECONNRESET 429' })
        if (id === 'w-cb') appendEvent(logsDir, 'circuit_breaker', { reason: 'max_test_iterations', detail: '6/5' })
        appendEvent(logsDir, 'blocked', { reason: id === 'w-cb' ? '未产出结果块（worker 异常结束）' : 'worker 自报 stuck' })
        fs.renameSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', `${id}.md`), path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', `${id}.md`))
      }
      const out = runOrch(repo.root, 'watch --max-cycles 1 --interval 0 --backend mock')
      expect(out.stdout).not.toContain('有痕重探一次')
      expect(readCard(repo.root, 'blocked', 'w-cb')).toBeTruthy()
      expect(readCard(repo.root, 'blocked', 'w-stuck')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 90_000)
})

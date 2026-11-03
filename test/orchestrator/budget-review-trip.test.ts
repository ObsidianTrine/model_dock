// 审查段熔断收敛（回归）：wall/token 熔断若在审查段触发，旧实现的 tripped 检查只在
// worker spawn close 之后——审查返工 continue 回循环顶会再 spawn 一个完全无 wall 限制的
// worker 会话（熔断后白烧一整轮）。修复后循环顶有熔断收敛闸：任何 continue 路径先过它。
// 同时验证 reviewer 的 budget_snapshot 计入同一预算（旧实现只落盘不记账，审查段对
// max_tokens 熔断失明）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cardText, mkRepo, runOrch, tryOrch } from './helpers.js'

function readEvents(repoRoot: string, taskId: string): Array<Record<string, any>> {
  return fs
    .readFileSync(path.join(repoRoot, '.agents', 'orchestrator', 'logs', taskId, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

describe('budget：审查段熔断收敛 + reviewer 记账', () => {
  it('审查段触发 max_tokens → 循环顶收敛落 blocked，不再 spawn 第二个 worker 会话', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'c.md')
      // max_tokens=10000：worker 自报 6000 不触发（把场景隔离到「审查段」），
      // reviewer 注入 999999 触发熔断；blockers=1 走审查返工 continue（旧实现逃逸窗口）
      fs.writeFileSync(cardFile, cardText({ id: 'rev-trip', budget: { max_tokens: 10000, max_wall_minutes: 30 } }))
      runOrch(repo.root, `submit "${cardFile}"`)
      const r = tryOrch(repo.root, 'run rev-trip --backend mock', {
        ORCH_MOCK_REVIEW_BLOCKERS: '1',
        ORCH_MOCK_REVIEW_TOKENS: '999999',
      })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('预算熔断')

      expect(fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked'))).toContain('rev-trip.md')
      const events = readEvents(repo.root, 'rev-trip')
      // 每个会话落两条 worker_spawned（orchestrator 一条带 attempt + mock 后端一条带 pid）：
      // 1 个会话 = 2 条；旧实现审查返工逃逸会再 spawn 一个会话 = 4 条
      const spawns = events.filter((e) => e.type === 'worker_spawned' && e.role !== 'reviewer')
      expect(spawns).toHaveLength(2)
      expect(spawns.every((e) => (e.attempt ?? 0) === 0)).toBe(true) // 无 attempt≥1 的返工会话
      const cb = events.find((e) => e.type === 'circuit_breaker')
      expect(cb?.reason).toBe('max_tokens')
      expect(events.some((e) => e.type === 'blocked' && e.reason === 'budget:max_tokens')).toBe(true)
      // reviewer 的 snapshot 事件照常落盘（记账可见性）
      expect(events.some((e) => e.type === 'budget_snapshot' && e.tokens_in === 999999)).toBe(true)
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('reviewer 不注入超额 token 时照常走完闭环（记账不误伤正常流）', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'c.md')
      fs.writeFileSync(cardFile, cardText({ id: 'rev-ok' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run rev-ok --backend mock')
      const settled = [
        ...fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'awaiting-human')),
        ...fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'merged')),
      ]
      expect(settled).toContain('rev-ok.md')
    } finally {
      repo.cleanup()
    }
  }, 180_000)
})

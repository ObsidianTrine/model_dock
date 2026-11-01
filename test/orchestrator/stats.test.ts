// stats 运行度量测试：从 events.jsonl 聚合每卡画像与全局汇总（--json 机器可读）。
// 全程 mock 后端（零外部调用），断言聚合口径而不是具体数值（wall 随环境波动）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cardText, mkRepo, runOrch } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

describe('orchestrator stats > 聚合口径', () => {
  it('--json 输出每卡行与汇总；state/outcome/队列计数对齐真实落位', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'st-await') // gate L3 缺省 → awaiting-human（无终态事件）
      runOrch(repo.root, 'run st-await --backend mock')
      submitCard(repo.root, 'st-block')
      runOrch(repo.root, 'run st-block --backend mock', { ORCH_MOCK_WORKER_STATUS: 'stuck' })

      const r = runOrch(repo.root, 'stats --days 7 --json')
      const parsed = JSON.parse(r.stdout)
      expect(parsed.summary.window_days).toBe(7)
      expect(parsed.summary.tasks_started).toBe(2)

      const awaitRow = parsed.rows.find((x: { id: string }) => x.id === 'st-await')
      expect(awaitRow).toMatchObject({ state: 'awaiting-human', outcome: 'awaiting-human' })
      expect(awaitRow.wall_min).toBeGreaterThanOrEqual(0)
      expect(awaitRow.turns).toBeGreaterThanOrEqual(0)
      expect(awaitRow.debug_iter).toBe(0)
      expect(awaitRow.follow_ups).toBe(0)

      const blockRow = parsed.rows.find((x: { id: string }) => x.id === 'st-block')
      expect(blockRow).toMatchObject({ state: 'blocked', outcome: 'blocked' })

      expect(parsed.summary.queue.pending).toBe(0)
      expect(parsed.summary.queue['awaiting-human']).toBe(1)
      expect(parsed.summary.queue.blocked).toBe(1)
      expect(parsed.summary.settled).toBe(1) // blocked 是终态，awaiting-human 不是
      expect(parsed.summary.merged).toBe(0)
      expect(parsed.summary.merge_rate).toBe(0)
      expect(parsed.summary.total_tokens_peak).toBeGreaterThanOrEqual(0)
    } finally {
      repo.cleanup()
    }
  })

  it('人类可读输出：标题行 + 每卡 key=value 行 + 汇总行', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'st-h')
      runOrch(repo.root, 'run st-h --backend mock')
      const r = runOrch(repo.root, 'stats')
      expect(r.stdout).toContain('编排运行度量')
      expect(r.stdout).toContain('st-h')
      expect(r.stdout).toContain('汇总')
    } finally {
      repo.cleanup()
    }
  })

  it('窗口过滤与空日志：days 外的任务不计；全新仓库给可操作提示', () => {
    const repo = mkRepo()
    try {
      // 只 submit 不 run：logs/ 无 events.jsonl → 不计入
      submitCard(repo.root, 'st-norun')
      const empty = runOrch(repo.root, 'stats --json')
      const parsed = JSON.parse(empty.stdout)
      expect(parsed.summary.tasks_started).toBe(0)
      expect(parsed.rows).toEqual([])

      const human = runOrch(repo.root, 'stats')
      expect(human.stdout).toContain('最近 7 天没有任务启动')
    } finally {
      repo.cleanup()
    }
  })

  it('日志残留（卡已不在队列）不阻断度量：state 降级标注、行照出', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'st-ok')
      runOrch(repo.root, 'run st-ok --backend mock')
      // 事后把卡文件挪走（模拟 reconcile 场景外的残留日志）：stats 只读，行照出
      fs.rmSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'awaiting-human', 'st-ok.md'))
      const r = runOrch(repo.root, 'stats --json')
      const parsed = JSON.parse(r.stdout)
      expect(parsed.summary.tasks_started).toBe(1)
      expect(parsed.rows[0]).toMatchObject({ state: '(日志残留)', outcome: 'unknown' })
      expect(parsed.summary.queue['awaiting-human']).toBe(0)
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator stats > 安全晴雨表（near_miss）', () => {
  it('瞬时故障卡（重试 3 次 blocked + 调查包）：summary.near_miss 各字段计数正确', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'st-nm')
      // mock 瞬时故障：原地重试 3 次（10ms 退避）→ blocked（未产出结果块）→ VDR 归档
      runOrch(repo.root, 'run st-nm --backend mock', { ORCH_MOCK_TRANSIENT: '1', ORCH_RETRY_WAIT_MS: '10' })
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'st-nm', 'incident.md'))).toBe(true)

      const r = runOrch(repo.root, 'stats --days 7 --json')
      const parsed = JSON.parse(r.stdout)
      expect(parsed.summary.near_miss).toMatchObject({
        watchdog: 0, // mock 后端跳过进展看门狗
        xte: 0, // 单会话零提交 streak=1，未达连续 2 会话阈值
      })
      expect(parsed.summary.near_miss.retries).toBeGreaterThanOrEqual(3)
      expect(parsed.summary.near_miss.incidents).toBeGreaterThanOrEqual(1)
      // 行级同步可查
      const row = parsed.rows.find((x: { id: string }) => x.id === 'st-nm')
      expect(row.retries).toBeGreaterThanOrEqual(3)
      expect(row.incident).toBe(1)

      const human = runOrch(repo.root, 'stats')
      expect(human.stdout).toContain('安全晴雨表')
      expect(human.stdout).toContain('近乎事故')
    } finally {
      repo.cleanup()
    }
  })
})

// 审查引擎故障快速落 blocked 测试（2026-11-03 夜航实证驱动）：reviewBackend.spawn 返回
// exitCode≠0 且输出无 REVIEW_SUMMARY 契约块 = 引擎死了不是审查意见——不烧审查返工轮，
// 直接 blocked + review_engine_failed 留痕 + 事故调查包。exitCode=0 无契约块维持既有
// 保守路径（blockers=1 进返工，超限熔断）。全程 mock（零外部调用）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cardText, eventsOf, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

describe('orchestrator review > 引擎故障快速落 blocked', () => {
  it('exitCode=1 且无契约块 → review_engine_failed + blocked，不触发审查返工', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'rev-fail', { gate: 'L1', files_hint: ['src/**'] })
      const r = tryOrch(repo.root, 'run rev-fail --backend mock --review-backend mock', {
        ORCH_MOCK_REVIEW_FAIL: '1',
        ORCH_MOCK_FILE: 'src/feat.ts',
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('审查引擎故障')
      expect(r.stderr).toContain('unrecognized_model') // stderr 尾进报错，可操作
      const events = eventsOf(repo.root, 'rev-fail')
      const types = events.map((e) => e.type)
      expect(types).toContain('review_engine_failed')
      expect(types).not.toContain('review_iteration') // 没烧返工轮
      expect(types).not.toContain('review_verdict') // 引擎故障不算审查意见
      expect(types).not.toContain('auto_merge') // 更不该合并
      const failed = events.find((e) => e.type === 'review_engine_failed')
      expect(failed).toMatchObject({ backend: 'mock', exitCode: 1 })
      expect(readCard(repo.root, 'blocked', 'rev-fail')).toBeTruthy()
      // 事故调查包归档（与 worker stuck 同等处置）
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'rev-fail', 'incident.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('exitCode=0 无契约块 → 维持既有保守路径：进审查返工轮，不误判引擎故障', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'rev-novd', { gate: 'L1', files_hint: ['src/**'] })
      // 保守路径：审查无契约块按 blockers=1 进返工轮，返工轮 worker 会话真实续跑。
      // （orch-mock-role-detection 卡前：fixup prompt 内嵌含 REVIEW_SUMMARY 字样的失败输出，
      // mock 按正文嗅探把二次 spawn 误判成 reviewer → worker 无结果块 → 假性 blocked exit 0
      // ——旧断言 status=0 钉的正是那个 bug 产物。显式角色契约后返工轮真正跑 worker，
      // 审查恒无契约块 → 返工烧满走 max_review_iterations 熔断 die，exit 1。）
      const r = tryOrch(repo.root, 'run rev-novd --backend mock --review-backend mock', {
        ORCH_MOCK_REVIEW_NOVERDICT: '1',
        ORCH_MOCK_FILE: 'src/feat.ts',
      })
      expect(r.status).toBe(1) // 返工烧满熔断 die（与引擎故障 exit 1 同码，路径不同——见 circuit_breaker 断言）
      const events = eventsOf(repo.root, 'rev-novd')
      const types = events.map((e) => e.type)
      expect(types).toContain('review_verdict') // 引擎活着，判定照记（blockers=-1）
      expect(types).toContain('review_iteration') // 返工轮照走
      expect(types).not.toContain('review_engine_failed') // 不误判成引擎故障
      expect(events.find((e) => e.type === 'circuit_breaker')).toMatchObject({ reason: 'max_review_iterations' }) // 熔断路径钉死
      const workerDones = types.filter((t) => t === 'worker_done').length
      expect(workerDones).toBeGreaterThanOrEqual(2) // 返工轮 worker 真实续跑（修复前第 2 会话被误判成 reviewer、无结果块）
      expect(readCard(repo.root, 'blocked', 'rev-novd')).toBeTruthy() // 终局仍保守落 blocked
    } finally {
      repo.cleanup()
    }
  })
})

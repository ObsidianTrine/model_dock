// 质量漂移监控测试：revert 统计 / 超阈值自动降级 / 降级期间不自动合并 / --clear 恢复（docs 10.5）

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DRIFT_THRESHOLD, evaluateDrift, readDegraded, clearDegraded, degradedFile } from '../../.agents/scripts/orchestrator/drift.mjs'
import { eventsOf, git, mkRepo, runOrch, cardText } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}, body?: string) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }, body))
  runOrch(repo, `submit "${cardFile}"`)
}

/** 建一个自动合并的任务（gate=L1 + docs 改动 → L0 自动合并）；每个任务独立文件，revert 不冲突。 */
function autoMergeTask(repo: string, id: string) {
  submitCard(repo, id, { gate: 'L1', files_hint: ['docs/**'] })
  runOrch(repo, `run ${id} --backend mock`, { ORCH_MOCK_FILE: `docs/notes-${id}.md` })
  expect(fs.existsSync(path.join(repo, '.agents', 'orchestrator', 'queue', 'merged', `${id}.md`))).toBe(true)
}

describe('orchestrator drift > 回溯失败率统计与自动降级', () => {
  it('无 revert 时失败率 0，不降级', () => {
    const repo = mkRepo()
    try {
      autoMergeTask(repo.root, 'ok1')
      const r = evaluateDrift(repo.root, `${repo.root}/.agents/orchestrator/queue`)
      expect(r.autoTotal).toBe(1)
      expect(r.autoReverted).toBe(0)
      expect(r.rate).toBe(0)
      expect(r.degraded).toBeNull()
      expect(readDegraded(repo.root)).toBeNull()
    } finally {
      repo.cleanup()
    }
  })

  // 真实跑 4-5 个完整 orchestrator 闭环（每闭环 git worktree + 4 门禁 + merge 全子进程），
  // Windows/CI 慢机上会超全局 20s，重用例显式放宽（实测本机 ~30s）
  it('失败率超 20% → 自动写降级标记；阈值内不降级', () => {
    const repo = mkRepo()
    try {
      // 4 个自动合并，revert 其中 1 个 = 25% > 20% 阈值
      for (const id of ['a1', 'a2', 'a3', 'a4']) autoMergeTask(repo.root, id)
      const bad = git(repo.root, 'log develop --format=%H --grep="Merge branch \'feature/a1\'"')
      git(repo.root, `revert -m 1 --no-edit ${bad.split('\n')[0]}`)
      const r = evaluateDrift(repo.root, `${repo.root}/.agents/orchestrator/queue`)
      expect(r.autoReverted).toBe(1)
      expect(r.rate).toBeGreaterThan(DRIFT_THRESHOLD)
      const d = readDegraded(repo.root)
      expect(d).not.toBeNull()
      expect(d.reason).toContain('超阈值')
      expect(d.failed_tasks).toEqual(['a1'])
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('恰好 20% 不降级（严格大于）；幂等不覆盖首次降级时间', () => {
    const repo = mkRepo()
    try {
      for (const id of ['b1', 'b2', 'b3', 'b4', 'b5']) autoMergeTask(repo.root, id)
      const bad = git(repo.root, 'log develop --format=%H --grep="Merge branch \'feature/b1\'"')
      git(repo.root, `revert -m 1 --no-edit ${bad.split('\n')[0]}`)
      const r = evaluateDrift(repo.root, `${repo.root}/.agents/orchestrator/queue`)
      expect(r.rate).toBe(0.2)
      expect(r.degraded).toBeNull() // 0.2 不大于 0.2
      // 人为降级后再次 evaluate，degraded_at 不变
      fs.writeFileSync(degradedFile(repo.root), JSON.stringify({ degraded_at: '2026-01-01T00:00:00.000Z', reason: '手工放置' }))
      evaluateDrift(repo.root, `${repo.root}/.agents/orchestrator/queue`)
      expect(readDegraded(repo.root).degraded_at).toBe('2026-01-01T00:00:00.000Z')
      clearDegraded(repo.root)
    } finally {
      repo.cleanup()
    }
  }, 60_000)
})

describe('orchestrator drift > 降级期间自动合并回人工', () => {
  it('degraded.json 存在时 gate=L1 + L0 改动也不自动，转 awaiting-human', () => {
    const repo = mkRepo()
    try {
      fs.mkdirSync(path.join(repo.root, '.agents', 'orchestrator'), { recursive: true })
      fs.writeFileSync(degradedFile(repo.root), JSON.stringify({ degraded_at: new Date().toISOString(), reason: '测试降级' }))
      submitCard(repo.root, 'during', { gate: 'L1', files_hint: ['docs/**'] })
      const run = runOrch(repo.root, 'run during --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(run.stdout).toContain('awaiting-human')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'awaiting-human', 'during.md'))).toBe(true)
      const types = eventsOf(repo.root, 'during').map((e) => e.type)
      expect(types).not.toContain('auto_merge')
      expect(eventsOf(repo.root, 'during').find((e) => e.type === 'awaiting_human')?.reason).toBe('drift_degraded')
      // 人工恢复后同配置任务恢复自动
      runOrch(repo.root, 'drift --clear')
      submitCard(repo.root, 'after', { gate: 'L1', files_hint: ['docs/**'] })
      const run2 = runOrch(repo.root, 'run after --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(run2.stdout).toContain('自动合并')
    } finally {
      repo.cleanup()
    }
  })

  it('drift 命令输出报告；无样本时提示', () => {
    const repo = mkRepo()
    try {
      const empty = runOrch(repo.root, 'drift')
      expect(empty.stdout).toContain('尚无自动合并样本')
      autoMergeTask(repo.root, 'rep1')
      const full = runOrch(repo.root, 'drift')
      expect(full.stdout).toContain('状态正常')
      expect(full.stdout).toContain('自动合并: 1')
    } finally {
      repo.cleanup()
    }
  })
})

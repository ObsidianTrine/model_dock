// P0 任务质量闸门 e2e（2026-11-15）：复诵核对事实注入 / acceptance 申报对账 / reviewer
// 契约行补问 / submit 验收 L0 校验——mock 后端端到端，秒级零外部调用。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cardText, eventsOf, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}, body?: string) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }, body))
  runOrch(repo, `submit "${cardFile}"`)
}

/** 读决策留底（logs/<id>/decisions/review-*.json）：writeDecisionTrace 的 record = { ts, kind, input, output, parsed, meta }。 */
function reviewDecisions(repo: string, id: string): Array<Record<string, unknown>> {
  const dir = path.join(repo, '.agents', 'orchestrator', 'logs', id, 'decisions')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('review-') && f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
}

describe('orchestrator 任务质量闸门 > 复诵核对事实注入审查（①）', () => {
  it('worker 未复诵（NOTES 停在 start 模板）→ 预检事实进 reviewer prompt（决策留底可证）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'recite-absent')
      runOrch(repo.root, 'run recite-absent --backend mock')
      const inputs = reviewDecisions(repo.root, 'recite-absent').map((d) => String(d.input)).join('\n')
      expect(inputs).toContain('编排器预检事实')
      expect(inputs).toContain('start 模板原文')
      expect(inputs).not.toContain('<NOTES.md 复诵段')
    } finally {
      repo.cleanup()
    }
  })

  it('worker 复诵进 NOTES → 复诵段注入 reviewer；任务照常落人工闸门', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'recite-present')
      runOrch(repo.root, 'run recite-present --backend mock', { ORCH_MOCK_NOTES_RECITE: '1' })
      const inputs = reviewDecisions(repo.root, 'recite-present').map((d) => String(d.input)).join('\n')
      expect(inputs).toContain('<NOTES.md 复诵段')
      expect(inputs).toContain('目的地（目标）')
      expect(readCard(repo.root, 'awaiting-human', 'recite-present')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator 任务质量闸门 > acceptance 申报对账（③）', () => {
  it('自报缺口（0/1）→ 不等门禁直接返工；反复缺口熔断 blocked', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'acc-gap', { gate: 'L1', files_hint: ['docs/**'] })
      const r = tryOrch(repo.root, 'run acc-gap --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md', ORCH_MOCK_WORKER_ACCEPTANCE: '0/1' })
      expect(r.status).toBe(1) // 熔断走 exitRun（die）
      const types = eventsOf(repo.root, 'acc-gap').map((e) => e.type)
      expect(types).toContain('acceptance_shortfall')
      expect(types).toContain('debug_iteration')
      expect(types).toContain('circuit_breaker')
      expect(readCard(repo.root, 'blocked', 'acc-gap')).toBeTruthy()
      // 缺口返工不等门禁：熔断前没有任何 gate_result（门禁在修复后的下一轮才跑）
      expect(types).not.toContain('gate_result')
    } finally {
      repo.cleanup()
    }
  })

  it('申报满足（1/1）→ 无缺口事件，正常走完闭环落 awaiting-human', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'acc-ok')
      runOrch(repo.root, 'run acc-ok --backend mock', { ORCH_MOCK_WORKER_ACCEPTANCE: '1/1' })
      const types = eventsOf(repo.root, 'acc-ok').map((e) => e.type)
      expect(types).not.toContain('acceptance_shortfall')
      expect(types).toContain('gate_result')
      expect(readCard(repo.root, 'awaiting-human', 'acc-ok')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator 任务质量闸门 > reviewer 契约行补问（⑤）', () => {
  it('首轮缺汇总行 → 补问一轮补出 → 恢复正常落闸门（不烧返工轮）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'retry-ok')
      runOrch(repo.root, 'run retry-ok --backend mock', { ORCH_MOCK_REVIEW_NOVERDICT_ONCE: '1' })
      const types = eventsOf(repo.root, 'retry-ok').map((e) => e.type)
      expect(types).toContain('review_verdict_retry')
      const retry = eventsOf(repo.root, 'retry-ok').find((e) => e.type === 'review_verdict_retry')
      expect(retry?.resolved).toBe(true)
      expect(types).not.toContain('review_iteration') // 补问恢复，没烧返工轮
      expect(readCard(repo.root, 'awaiting-human', 'retry-ok')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('补问仍缺汇总行 → 落回保守判罚（blockers=1 进返工）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'retry-fail', { gate: 'L1', files_hint: ['src/**'] })
      tryOrch(repo.root, 'run retry-fail --backend mock --review-backend mock', {
        ORCH_MOCK_REVIEW_NOVERDICT: '1',
        ORCH_MOCK_FILE: 'src/feat.ts',
      })
      const retry = eventsOf(repo.root, 'retry-fail').find((e) => e.type === 'review_verdict_retry')
      expect(retry?.resolved).toBe(false)
      expect(eventsOf(repo.root, 'retry-fail').map((e) => e.type)).toContain('review_iteration')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator 任务质量闸门 > submit 验收标准 L0 校验（②）', () => {
  it('空洞验收标准拒绝提交（报错带修复示例）；补锚点后可提交', () => {
    const repo = mkRepo()
    try {
      const weak = path.join(repo.root, 'card-weak.md')
      fs.writeFileSync(weak, cardText({ id: 'weak-acc' }).replace('- 通过（npx vitest run 全绿）', '- 通过\n- 完成'))
      const r = tryOrch(repo.root, `submit "${weak}"`)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('L0 校验')
      expect(r.stderr).toContain('npx vitest run') // 修复示例可操作
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'weak-acc.md'))).toBe(false)
      const good = path.join(repo.root, 'card-good.md')
      fs.writeFileSync(good, cardText({ id: 'good-acc' }).replace('- 通过（npx vitest run 全绿）', '- npx vitest run test/a.test.ts 全绿'))
      runOrch(repo.root, `submit "${good}"`)
      expect(readCard(repo.root, 'pending', 'good-acc')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })
})

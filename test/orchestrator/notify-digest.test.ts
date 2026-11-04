// 任务通报（按任务号为话题）纯函数用例：humanTokens / taskStateTag / buildPhaseLine /
// buildTaskDigest / buildTaskRoster / buildSailSummary 花名册。事件序列取自 2026-11-02
// 首航实卡 docs-nightly-webhook-envs 的真实事件形状（类型与字段名以此为准）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import {
  buildPhaseLine,
  buildTaskDigest,
  buildTaskRoster,
  humanTokens,
  taskStateTag,
} from '../../.agents/scripts/orchestrator/notify.mjs'
import { buildSailSummary } from '../../.agents/scripts/orchestrator/sail.mjs'
import { cardPath, ensureQueue, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'
import { cardText, mkRepo } from './helpers.js'

/** 首航实卡 docs-nightly-webhook-envs 的事件序列（省略 worker_turn/budget_snapshot 高频流）。 */
function realVoyageEvents() {
  return [
    { seq: 1, ts: 't1', type: 'budget_profile', backend: 'zcode-headless' },
    { seq: 2, ts: 't2', type: 'tier_resolved', tier: null, worker_model: 'glm-5.3-flash', review_model: 'glm-5.3-flash' },
    { seq: 3, ts: 't3', type: 'task_accepted', backend: 'zcode-headless' },
    { seq: 6, ts: 't6', type: 'worker_spawned', backend: 'zcode-headless', attempt: 0 },
    { seq: 9, ts: 't9', type: 'worker_done', summary: '.agents/docs/ai-pipeline-guide.md 通知段落补齐 AGENTS_NIGHTLY_WEBHOOK / AGENTS_ORCH_WEBHOOK 双变量、旧名兼容说明、飞书自定义关键词提醒与钥匙串防明文命令示例，docs-lint 全绿' },
    { seq: 10, ts: 't10', type: 'gate_result', gate: 'npm_test', result: 'pass', scoped: 'l0' },
    { seq: 11, ts: 't11', type: 'gate_result', gate: 'port_scan', result: 'pass' },
    { seq: 12, ts: 't12', type: 'review_verdict', blockers: 0, suggestions: 1, notes: 0 },
    { seq: 13, ts: 't13', type: 'auto_merge', level: 'L0', gate: 'L1' },
    { seq: 14, ts: 't14', type: 'merged', merge_commit: '407fae32d24c21b697775494feb250bdfa76b44b', auto: true },
    { seq: 15, ts: 't15', type: 'budget_snapshot', tokens_in: 2144339, tokens_out: 3950, elapsed_min: 6 },
  ]
}

describe('orchestrator notify digest > humanTokens', () => {
  it('百万级 M、千级 k、零/负/非数返回空串', () => {
    expect(humanTokens(2144339)).toBe('2.1M')
    expect(humanTokens(1_000_000)).toBe('1M')
    expect(humanTokens(360248)).toBe('360k')
    expect(humanTokens(999)).toBe('999')
    expect(humanTokens(0)).toBe('')
    expect(humanTokens(-5)).toBe('')
    expect(humanTokens(undefined)).toBe('')
  })
})

describe('orchestrator notify digest > taskStateTag', () => {
  it('四种落位状态有中文标签；未知状态原样兜底', () => {
    expect(taskStateTag('merged')).toBe('✅ 已出港')
    expect(taskStateTag('awaiting-human')).toBe('⏸ 待船东放行')
    expect(taskStateTag('failed')).toBe('✗ 退关')
    expect(taskStateTag('blocked')).toBe('⚠ 搁浅')
    expect(taskStateTag('running')).toBe('⚠ running')
    expect(taskStateTag(undefined)).toBe('⚠ ?')
  })
})

describe('orchestrator notify digest > buildPhaseLine', () => {
  it('真实事件序列 → 完整阶段链（派发→执行→门禁→审查→合并）', () => {
    expect(buildPhaseLine(realVoyageEvents())).toBe('zcode → 6m/2.1M tok → 门禁过 → 审查通过/1建议 → 自动合并 407fae3')
  })

  it('档位、重试、引擎升级、门禁失败、人工合并各段如实呈现', () => {
    const events = [
      { seq: 1, ts: 't', type: 'task_accepted', backend: 'zcode-headless' },
      { seq: 2, ts: 't', type: 'tier_resolved', tier: 'ahead-1' },
      { seq: 3, ts: 't', type: 'worker_spawned', attempt: 2 },
      { seq: 4, ts: 't', type: 'engine_escalated', from: 'zcode-headless', to: 'claude-headless', reason: 'prompt_oversize' },
      { seq: 5, ts: 't', type: 'budget_snapshot', tokens_in: 5000, elapsed_min: 2 },
      { seq: 6, ts: 't', type: 'gate_result', gate: 'npm_test', result: 'fail' },
      { seq: 7, ts: 't', type: 'review_verdict', blockers: 2, suggestions: 0 },
      { seq: 8, ts: 't', type: 'merged', merge_commit: 'abc1234def', auto: false },
    ]
    expect(buildPhaseLine(events)).toBe('zcode·ahead-1·重试2次 → ⏫切claude → 2m/5k tok → 门禁✗ → 审查2阻塞 → 人工合并 abc1234')
  })

  it('空事件流与缺段事件不产生空箭头', () => {
    expect(buildPhaseLine([])).toBe('')
    expect(buildPhaseLine(undefined)).toBe('')
    expect(buildPhaseLine([{ seq: 1, ts: 't', type: 'merged', merge_commit: 'abc12345678', auto: true }])).toBe('自动合并 abc1234')
  })
})

describe('orchestrator notify digest > buildTaskDigest', () => {
  it('完整数据 → 为什么/成果/过程/结果四段齐全，主题行为【任务号】+状态', () => {
    const digest = buildTaskDigest({
      taskId: 'docs-nightly-webhook-envs',
      state: 'merged',
      reason: '审查通过，自动出港',
      why: '更新 .agents/docs/ai-pipeline-guide.md「通知」段落，补齐双 webhook 变量',
      events: realVoyageEvents(),
    })
    const lines = digest.split('\n')
    expect(lines[0]).toBe('【docs-nightly-webhook-envs】✅ 已出港')
    expect(digest).toContain('为什么：更新 .agents/docs/ai-pipeline-guide.md「通知」段落')
    expect(digest).toContain('成果：.agents/docs/ai-pipeline-guide.md 通知段落补齐')
    expect(digest).toContain('过程：zcode → 6m/2.1M tok')
    expect(lines[lines.length - 1]).toBe('结果：审查通过，自动出港')
  })

  it('无事件流无目标 → 退化为【id】状态 + 结果两行（旧 buildSettleSummary 等价形态）', () => {
    expect(buildTaskDigest({ taskId: 'x', state: 'blocked', reason: '预算熔断 max_tokens' })).toBe(
      '【x】⚠ 搁浅\n结果：预算熔断 max_tokens',
    )
  })

  it('超长目标/成果按行内上限截断，不撑爆通知', () => {
    const digest = buildTaskDigest({
      taskId: 't',
      state: 'merged',
      why: '长'.repeat(120),
      events: [{ seq: 1, ts: 't', type: 'worker_done', summary: '长'.repeat(150) }],
    })
    const why = digest.split('\n').find((l) => l.startsWith('为什么：'))
    const done = digest.split('\n').find((l) => l.startsWith('成果：'))
    expect(why!.length).toBeLessThanOrEqual('为什么：'.length + 80)
    expect(done!.length).toBeLessThanOrEqual('成果：'.length + 100)
  })
})

describe('orchestrator notify digest > buildTaskRoster', () => {
  it('按任务号逐行列出状态与目标；超 max 截断注总数', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `task-${i}`, state: i % 2 ? 'merged' : 'blocked' }))
    const roster = buildTaskRoster(tasks, { max: 8, infoOf: (t) => ({ goal: `目标-${t.id}` }) })
    const lines = roster.split('\n')
    expect(lines).toHaveLength(9)
    expect(lines[0]).toBe('- 【task-0】⚠ 搁浅：目标-task-0')
    expect(lines[1]).toBe('- 【task-1】✅ 已出港：目标-task-1')
    expect(lines[8]).toBe('…共 10 张（余略）')
  })

  it('空列表返回空串；infoOf 查不到目标只列 id 与状态', () => {
    expect(buildTaskRoster([])).toBe('')
    expect(buildTaskRoster([{ id: 'a', state: 'merged' }])).toBe('- 【a】✅ 已出港')
  })
})

describe('orchestrator notify digest > buildSailSummary 花名册', () => {
  it('收帆摘要在计数行下按任务号列出落位卡与目标首行', () => {
    const repo = mkRepo()
    try {
      const root = queueRoot(repo.root)
      ensureQueue(root)
      fs.writeFileSync(cardPath(root, 'merged', 'docs-a'), cardText({ id: 'docs-a', type: 'docs' }, '补齐夜航通知文档'))
      fs.writeFileSync(cardPath(root, 'blocked', 'feat-b'), cardText({ id: 'feat-b', type: 'feature' }, '扩展 schedule 的 sail 模式'))
      const summary = buildSailSummary({
        root: repo.root,
        minutes: 5,
        actualMinutes: 7,
        dispatchedTotal: 2,
        endState: { merged: ['docs-a'], 'awaiting-human': [], blocked: ['feat-b'], failed: [], pending: [] },
      })
      expect(summary).toContain('✓ 自由航行结束')
      expect(summary).toContain('出港 1、待放行 0、搁浅/退关 1、待调度 0')
      expect(summary).toContain('- 【docs-a】✅ 已出港：补齐夜航通知文档')
      expect(summary).toContain('- 【feat-b】⚠ 搁浅：扩展 schedule 的 sail 模式')
    } finally {
      repo.cleanup()
    }
  })

  it('无落位卡时不含花名册段；root 缺失不抛错（老调用形态兼容）', () => {
    const bare = buildSailSummary({ minutes: 5, actualMinutes: 5, dispatchedTotal: 0, endState: { merged: [], 'awaiting-human': [], blocked: [], failed: [], pending: [] } })
    expect(bare).not.toContain('【')
    const noRoot = buildSailSummary({ minutes: 5, actualMinutes: 5, dispatchedTotal: 1, endState: { merged: ['x'], 'awaiting-human': [], blocked: [], failed: [], pending: [] } })
    expect(noRoot).toContain('- 【x】✅ 已出港')
  })
})

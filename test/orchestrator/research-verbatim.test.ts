// research-verbatim：L2 逐字校验失败自动重试与非逐字降级（spec research-verbatim-precision 任务 2）——
// 逐字失败一票终审改为：先追加逐字摘录契约重试一次（与「无契约块」重试共享 MAX_ATTEMPTS=3
// 会话上限），仍败走 downgradeNonVerbatimClaims 降级保留（non_verbatim: true、status 强制
// partial、不进 contradicted 一票否决、fabricated_claims 红旗计数不变封顶 needs_review）。
// 单元：downgradeNonVerbatimClaims（强制 partial / 非 supported / 不进否决 / note 标注）+
// buildVerbatimRetryPrompt 契约句。
// e2e（runOrch+mock）：PARAPHRASE_ONCE 重试后逐字恢复（fabricated_claims=0）；PARAPHRASE
// 重试仍败（claims 保留带 non_verbatim、fabricated_claims>0、decision 封顶 needs_review）；
// 非逐字 contradicted 撤销否决（不派仲裁、不 unsafe）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { downgradeNonVerbatimClaims, verifyClaimVerbatim, scoreVerdict, writeBrief } from '../../.agents/scripts/orchestrator/research.mjs'
import { buildVerbatimRetryPrompt } from '../../.agents/scripts/orchestrator/prompt.mjs'
import { mkRepo, runOrch } from './helpers.js'

const TODAY = new Date().toISOString().slice(0, 10)

/** 五段齐全的最小 brief：结论行带数字（供 L1 回查全命中 → evidence=100）。 */
const BRIEF_BODY = [
  '# 结论',
  'mock 调研结论：DeepSeek V4.1 周下载 56.5T 份额 43.6% [1]。',
  '',
  '# 选项对比',
  '- 方案 A：mock——优劣占位。',
  '',
  '# 引用',
  `- ${TODAY} https://docs.example.com/probe — 支撑 [1]`,
  '',
  '# 建议',
  'mock 建议占位。',
  '',
  '# 罗盘对齐',
  'mock 对齐说明占位。',
].join('\n')

const SNAPSHOT = 'url: https://docs.example.com/probe\n\n榜单页：DeepSeek V4.1 周下载 56.5T、份额 43.6%'

describe('orchestrator research-verbatim > downgradeNonVerbatimClaims', () => {
  it('status 强制 partial（非 supported）、non_verbatim 留痕、note 前缀标注（原 note 保留）', () => {
    const out = downgradeNonVerbatimClaims([
      '改写版 claim A（字符串入参：verifyClaimVerbatim 的 fabricated 产物）',
      { claim: '改写版 claim B', status: 'contradicted', note: '与快照矛盾' },
      { claim: '改写版 claim C', status: 'supported' },
    ])
    expect(out).toHaveLength(3)
    for (const c of out) {
      expect(c.status).toBe('partial')
      expect(c.status).not.toBe('supported')
      expect(c.non_verbatim).toBe(true)
      expect(c.note.startsWith('非逐字摘录（复核改写）')).toBe(true)
    }
    expect(out[0].claim).toContain('改写版 claim A')
    expect(out[1].note).toContain('原 note：与快照矛盾') // 原 note 保留
    expect(out[2].note).toBe('非逐字摘录（复核改写）') // 无原 note 不留尾巴
  })

  it('不进否决：原 contradicted 降级后 veto 解除；fabricated>0 红旗封顶 needs_review 不撤', () => {
    const downgraded = downgradeNonVerbatimClaims([{ claim: '改写版 claim', status: 'contradicted', note: '与快照矛盾' }])
    const v = scoreVerdict({ claims: downgraded, fabricatedCount: 1, citation: 90, evidence: 80 })
    expect(v.veto).toBe(false)
    expect(v.usage.internal_decision).toBe('needs_review')
    expect(v.usage.external_doc).toBe('undetermined')
  })

  it('verifyClaimVerbatim fabricated 字符串直通降级：端到端形状（字符串 → claim 对象）', () => {
    const { fabricated } = verifyClaimVerbatim([{ claim: 'DeepSeek V4.1 下载量全球第一（改写版）', status: 'supported' }], BRIEF_BODY)
    expect(fabricated).toHaveLength(1)
    const out = downgradeNonVerbatimClaims(fabricated)
    expect(out[0].claim).toBe('DeepSeek V4.1 下载量全球第一（改写版）')
    expect(out[0]).toMatchObject({ status: 'partial', non_verbatim: true })
  })
})

describe('orchestrator research-verbatim > buildVerbatimRetryPrompt', () => {
  it('重试段带逐字摘录契约关键句（逐字摘录 / [n] 豁免 / 改写作废 / 完整契约块）', () => {
    const p = buildVerbatimRetryPrompt(1, 2)
    expect(p).toContain('逐字摘自 brief 原文')
    expect(p).toContain('[n] 引用标注剥除不算改写')
    expect(p).toContain('改写、概括、增删词一律作废')
    expect(p).toContain('```agents-verdict```')
    expect(p).toContain('第 1 次输出有 2 条')
  })
})

describe('orchestrator research-verbatim > verify 重试与降级 e2e（mock）', () => {
  function mkVerbatimRepo(id: string) {
    const repo = mkRepo()
    const root = repo.root
    writeBrief(root, { id, title: 't', question: 'q', backend: 'mock', body: BRIEF_BODY })
    const srcDir = path.join(root, '.agents', 'orchestrator', 'research', id, 'sources')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, '1.txt'), SNAPSHOT)
    return { repo, root }
  }
  const readVerdict = (root: string, id: string) =>
    JSON.parse(fs.readFileSync(path.join(root, '.agents', 'orchestrator', 'research', id, 'verdict.json'), 'utf8'))

  it('重试后逐字恢复：PARAPHRASE_ONCE 第一次改写、重试逐字 → fabricated_claims=0、decision ok', () => {
    const { repo, root } = mkVerbatimRepo('vb-recover')
    try {
      const out = runOrch(root, 'research verify vb-recover --backend mock', { ORCH_MOCK_REVIEW_PARAPHRASE_ONCE: '1' })
      const verdict = readVerdict(root, 'vb-recover')
      expect(verdict.fabricated_claims).toBe(0)
      expect(verdict.claims).toHaveLength(1)
      expect(verdict.claims[0].non_verbatim).toBeUndefined()
      expect(verdict.claims[0].status).toBe('supported')
      expect(verdict.claims[0].by).toBe('l1')
      expect(verdict.usage.internal_decision).toBe('ok')
      expect(out.stdout).toContain('追加逐字摘录契约重试') // 重试确实发生
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('重试仍败：claims 保留且带 non_verbatim、fabricated_claims>0、decision 封顶 needs_review', () => {
    const { repo, root } = mkVerbatimRepo('vb-downgrade')
    try {
      runOrch(root, 'research verify vb-downgrade --backend mock', { ORCH_MOCK_REVIEW_PARAPHRASE: '1' })
      const verdict = readVerdict(root, 'vb-downgrade')
      expect(verdict.claims).toHaveLength(1) // 不再丢弃
      expect(verdict.claims[0].non_verbatim).toBe(true)
      expect(verdict.claims[0].status).toBe('partial')
      expect(verdict.claims[0].note).toContain('非逐字摘录（复核改写）')
      expect(verdict.fabricated_claims).toBeGreaterThan(0)
      expect(verdict.usage.internal_decision).toBe('needs_review')
      expect(verdict.reasons.join('\n')).toContain('降级保留')
      expect(verdict.claims[0].status).not.toBe('supported') // L1 不升格
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('非逐字 contradicted 撤销否决：PARAPHRASE+BLOCKERS → 不派仲裁、veto 解除、needs_review（非 unsafe）', () => {
    const { repo, root } = mkVerbatimRepo('vb-veto')
    try {
      runOrch(root, 'research verify vb-veto --backend mock', { ORCH_MOCK_REVIEW_PARAPHRASE: '1', ORCH_MOCK_REVIEW_BLOCKERS: '1' })
      const verdict = readVerdict(root, 'vb-veto')
      expect(verdict.claims[0].status).toBe('partial') // contradicted → 降级 partial（撤销否决而非降权）
      expect(verdict.claims[0].non_verbatim).toBe(true)
      expect(verdict.arbitration).toBeNull() // contradicted 面收窄为纯逐字 claim，无仲裁对象
      expect(verdict.usage.internal_decision).toBe('needs_review')
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

// research-arbitration：仲裁轮（2026-11-09 实测驱动）——
// L2 复核船无联网、只拿快照裁断，快照自身误导（published_time 元数据语义）时矛盾可能
// 是误报（实测：公告页 published_time=2025-06 被当事件日期，四来源证实 1 月正确）。
// verify 判出 contradicted → 自动派联网仲裁会话（≥2 独立带日期来源，upheld 才翻案）。
// 单元：parseArbitrationBlock 契约解析 / arbitrateClaims 合并语义（保守：翻不了维持否决）。
// e2e（mock）：upheld 解除否决 / overturned 维持 / 仲裁失败 fail-closed / 配置关闭。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArbitrationBlock, arbitrateClaims, writeBrief } from '../../.agents/scripts/orchestrator/research.mjs'
import { mkRepo, runOrch } from './helpers.js'

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-arb-'))
}

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

describe('orchestrator research-arbitration > parseArbitrationBlock', () => {
  it('合规块解析出 rulings；非法 JSON / 非法枚举 / 超 10 条整块作废（fail-closed）', () => {
    const ok = parseArbitrationBlock(
      ['前言。', '```agents-arbitration', JSON.stringify({ rulings: [{ claim: '某 claim', ruling: 'upheld', sources: ['- 2026-11-09 https://a.com — 官方'], reasoning: '四来源一致' }] }), '```'].join('\n'),
    )
    expect(ok).not.toBeNull()
    expect(ok!.rulings).toHaveLength(1)
    expect(ok!.rulings[0]).toMatchObject({ claim: '某 claim', ruling: 'upheld' })
    expect(parseArbitrationBlock('```agents-arbitration\n{broken\n```')).toBeNull()
    expect(parseArbitrationBlock('```agents-arbitration\n{"rulings":[{"claim":"c","ruling":"maybe"}]}\n```')).toBeNull()
    expect(parseArbitrationBlock('```agents-arbitration\n{"rulings":[]}\n```')).toBeNull()
    const many = { rulings: Array.from({ length: 11 }, (_, i) => ({ claim: `c${i}`, ruling: 'upheld' })) }
    expect(parseArbitrationBlock('```agents-arbitration\n' + JSON.stringify(many) + '\n```')).toBeNull()
  })
})

describe('orchestrator research-arbitration > arbitrateClaims 合并语义', () => {
  const claims = () => [
    { claim: 'claim A', status: 'contradicted', note: '与快照矛盾', by: 'l2' },
    { claim: 'claim B', status: 'contradicted', note: '', by: 'l2' },
    { claim: 'claim C', status: 'supported', note: '', by: 'l1' },
  ]

  it('upheld → 翻案 partial + 仲裁轮 note（非 supported：外部证据与快照不同证据面）', () => {
    const cs = claims() as any
    const { stats } = arbitrateClaims(cs, [{ claim: 'claim A', ruling: 'upheld', sources: [], reasoning: '' }])
    expect(cs[0].status).toBe('partial')
    expect(cs[0].note).toContain('仲裁轮')
    expect(cs[2].status).toBe('supported') // 非 contradicted 不动
    expect(stats).toEqual({ upheld: 1, overturned: 0, undetermined: 0, unmatched: 0 })
  })

  it('overturned / undetermined 维持 contradicted（保守：翻不了案不放行）；裁定与 claim 逐字匹配不上计 unmatched', () => {
    const cs = claims() as any
    const { stats } = arbitrateClaims(cs, [
      { claim: 'claim A', ruling: 'overturned', sources: [], reasoning: '' },
      { claim: 'claim B  改写版', ruling: 'upheld', sources: [], reasoning: '' }, // 空白归一后仍不一致 → unmatched
      { claim: '不存在的 claim', ruling: 'upheld', sources: [], reasoning: '' },
    ])
    expect(cs[0].status).toBe('contradicted')
    expect(cs[0].note).toContain('矛盾成立')
    expect(stats).toEqual({ upheld: 0, overturned: 1, undetermined: 0, unmatched: 2 })
  })
})

describe('orchestrator research-arbitration > verify 仲裁 e2e（mock）', () => {
  function mkArbRepo() {
    const repo = mkRepo()
    const root = repo.root
    writeBrief(root, { id: 'arb-me', title: 't', question: 'q', backend: 'mock', body: BRIEF_BODY })
    const srcDir = path.join(root, '.agents', 'orchestrator', 'research', 'arb-me', 'sources')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, '1.txt'), SNAPSHOT)
    return { repo, root }
  }
  const readVerdict = (root: string) =>
    JSON.parse(fs.readFileSync(path.join(root, '.agents', 'orchestrator', 'research', 'arb-me', 'verdict.json'), 'utf8'))

  it('upheld：contradicted → 翻案 partial，一票否决解除（unsafe → needs_review），verdict.arbitration 留痕 + 台账 l2-arbitration', () => {
    const { repo, root } = mkArbRepo()
    try {
      runOrch(root, 'research verify arb-me --backend mock', { ORCH_MOCK_REVIEW_BLOCKERS: '1' }) // 仲裁缺省 upheld
      const verdict = readVerdict(root)
      expect(verdict.claims[0].status).toBe('partial')
      expect(verdict.claims[0].note).toContain('仲裁轮')
      expect(verdict.arbitration).toMatchObject({ ran: true, upheld: 1, overturned: 0, undetermined: 0, veto_cleared: true, backend: 'mock' })
      expect(verdict.usage.internal_decision).toBe('needs_review')
      expect(verdict.reasons.join('\n')).toContain('一票否决解除')
      const ledger = fs.readFileSync(path.join(root, '.agents', 'orchestrator', 'research', 'ledger.jsonl'), 'utf8')
      expect(ledger).toContain('"kind":"l2-arbitration"')
      expect(ledger).toContain('"veto_cleared":true')
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('overturned：外部来源证实矛盾 → 维持 contradicted 与 unsafe（veto_cleared=false）', () => {
    const { repo, root } = mkArbRepo()
    try {
      runOrch(root, 'research verify arb-me --backend mock', { ORCH_MOCK_REVIEW_BLOCKERS: '1', ORCH_MOCK_ARB_RULING: 'overturned' })
      const verdict = readVerdict(root)
      expect(verdict.claims[0].status).toBe('contradicted')
      expect(verdict.claims[0].note).toContain('矛盾成立')
      expect(verdict.arbitration).toMatchObject({ ran: true, overturned: 1, veto_cleared: false })
      expect(verdict.usage.internal_decision).toBe('unsafe')
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('仲裁会话 2 连败（无契约块）→ fail-closed 维持 unsafe，verdict.arbitration.failed=true', () => {
    const { repo, root } = mkArbRepo()
    try {
      runOrch(root, 'research verify arb-me --backend mock', { ORCH_MOCK_REVIEW_BLOCKERS: '1', ORCH_MOCK_ARB_INVALID: '1' })
      const verdict = readVerdict(root)
      expect(verdict.usage.internal_decision).toBe('unsafe')
      expect(verdict.arbitration).toMatchObject({ ran: true, failed: true })
      expect(verdict.claims[0].status).toBe('contradicted')
    } finally {
      repo.cleanup()
    }
  }, 180_000)

  it('research.arbitration=false → 不派仲裁轮（verdict.arbitration=null，unsafe 直判）', () => {
    const repo = mkRepo({ extra: { research: { arbitration: false } } })
    const root = repo.root
    try {
      writeBrief(root, { id: 'arb-off', title: 't', question: 'q', backend: 'mock', body: BRIEF_BODY })
      const srcDir = path.join(root, '.agents', 'orchestrator', 'research', 'arb-off', 'sources')
      fs.mkdirSync(srcDir, { recursive: true })
      fs.writeFileSync(path.join(srcDir, '1.txt'), SNAPSHOT)
      runOrch(root, 'research verify arb-off --backend mock', { ORCH_MOCK_REVIEW_BLOCKERS: '1' })
      const verdict = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'orchestrator', 'research', 'arb-off', 'verdict.json'), 'utf8'))
      expect(verdict.arbitration).toBeNull()
      expect(verdict.usage.internal_decision).toBe('unsafe')
      expect(verdict.claims[0].status).toBe('contradicted')
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

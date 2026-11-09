// verdict-fuzzy：判定链两处小改进（2026-11-10 对拍驱动）——
// ① verifyClaimVerbatim 两级制：一级精确包含（现状不变、无标注）+ 二级 fuzzy 词元重叠放行
//    轻度转述（阈值宁严勿松：0.85 最佳等长窗口 Jaccard 拦改写拼接 / 90% 词元包含拦无中生有 /
//    ≥4 词元拦碎句偶然命中）。编造/改写拼接/残留方括号标注一律 fabricated——防编造底线用例钉死。
// ② slugifyTopic 短 slug 加 sha256 哈希尾：中文主题折叠后信息量近零（「LLM 输出可信度…」→
//    llm、纯中文 → topic），哈希尾保唯一性与可溯源性（同输入同哈希、跨平台确定）；长 slug 不变。
// e2e（mock）：verifyBriefOnce 的 fabricated 红旗 log 文案不变 + fuzzy 放行计数 log 出现，
// verdict.json claims 带 verbatim:'fuzzy' 标注、精确命中条目无标注（向后兼容）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { verifyClaimVerbatim, slugifyTopic, writeBrief } from '../../.agents/scripts/orchestrator/research.mjs'
import { mkRepo, runOrch } from './helpers.js'

const TODAY = new Date().toISOString().slice(0, 10)

/** 五段齐全的可回查样例 brief（与 research.test.ts 的 CLAIM_BODY 同款，fuzzy 判据在其上标定）。 */
const CLAIM_BODY = [
  '# 结论',
  'DeepSeek V4.1 周下载 56.5T，占 43.6%；2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜 [1]。',
  '',
  '# 选项对比',
  '- DeepSeek V4.1：用量第一。',
  '',
  '# 引用',
  '- 2026-11-08 https://a.com/rankings — 支撑',
  '',
  '# 建议',
  '预设库补齐用量第一。',
  '',
  '# 罗盘对齐',
  '对齐配置托管定位。',
].join('\n')

describe('orchestrator verdict-fuzzy > verifyClaimVerbatim 两级制', () => {
  it('一级精确包含：valid 且无 verbatim 标注（向后兼容现状回归）', () => {
    const v = verifyClaimVerbatim(
      [{ claim: 'DeepSeek V4.1 周下载 56.5T，占 43.6%；2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜 [1]。', status: 'supported' }],
      CLAIM_BODY,
    )
    expect(v.valid).toHaveLength(1)
    expect(v.fabricated).toHaveLength(0)
    expect(v.valid[0]).not.toHaveProperty('verbatim')
    // 省略 [n] 的剥标注复述同样走一级（现状豁免面不回退）
    const bare = verifyClaimVerbatim(
      [{ claim: 'DeepSeek V4.1 周下载 56.5T，占 43.6%；2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜。', status: 'supported' }],
      CLAIM_BODY,
    )
    expect(bare.valid).toHaveLength(1)
    expect(bare.valid[0]).not.toHaveProperty('verbatim')
  })

  it('二级 fuzzy：轻度转述（空白段换序、词元重叠达标）→ valid 且 verbatim:"fuzzy"', () => {
    // 结论句两段换序：词元集合与 brief 完全一致、词序不同——对拍里复核模型转述的典型形态
    const para = verifyClaimVerbatim(
      [{ claim: '2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜，DeepSeek V4.1 周下载 56.5T，占 43.6%。', status: 'supported' }],
      CLAIM_BODY,
    )
    expect(para.valid).toHaveLength(1)
    expect(para.fabricated).toHaveLength(0)
    expect(para.valid[0].verbatim).toBe('fuzzy')
    expect(para.valid[0].status).toBe('supported') // fuzzy 只标注，不动 status/note
  })

  it('编造（brief 外实体/数字/结论）→ fabricated（防编造底线钉死）', () => {
    const fab = verifyClaimVerbatim(
      [{ claim: 'Claude Opus 4.6 于 2027-03 发布，市占率 71.2% 领跑企业榜。', status: 'supported' }],
      CLAIM_BODY,
    )
    expect(fab.valid).toHaveLength(0)
    expect(fab.fabricated).toHaveLength(1)
  })

  it('改写拼接（两处各取一半拼新句，最佳窗口词元重叠 <0.85）→ fabricated', () => {
    // 前半取自结论句、后半取自建议段：词元 100% 能在 brief 找到（包含线拦不住），
    // 但任何等长窗口最多盖住一半源句——0.85 Jaccard 线专门拦这种拼接
    const stitch = verifyClaimVerbatim(
      [{ claim: 'GPT-6 与 Kimi K3.1 领跑质量榜，预设库补齐用量第一。', status: 'supported' }],
      CLAIM_BODY,
    )
    expect(stitch.valid).toHaveLength(0)
    expect(stitch.fabricated).toHaveLength(1)
  })

  it('空串 / 剥 [n] 后为空 / 超 120 字符 → fabricated（现状回归）', () => {
    const v = verifyClaimVerbatim(
      [
        { claim: '', status: 'supported' },
        { claim: '[1] [2] [3]', status: 'supported' },
        { claim: 'x'.repeat(121), status: 'supported' },
      ],
      CLAIM_BODY,
    )
    expect(v.valid).toHaveLength(0)
    expect(v.fabricated).toHaveLength(3)
  })

  it('剥 [n] 后残留 [2026]/[1m] 类标注：不给 fuzzy（引用标注形状违规宁丢不放）', () => {
    const y = verifyClaimVerbatim(
      [{ claim: 'DeepSeek V4.1 周下载 56.5T，占 43.6%；2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜 [2026]。', status: 'supported' }],
      CLAIM_BODY,
    )
    expect(y.valid).toHaveLength(0)
    expect(y.fabricated).toHaveLength(1)
    const m = verifyClaimVerbatim(
      [{ claim: 'DeepSeek V4.1 周下载 56.5T，占 43.6%；2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜 [1m]。', status: 'supported' }],
      CLAIM_BODY,
    )
    expect(m.valid).toHaveLength(0)
    expect(m.fabricated).toHaveLength(1)
  })
})

describe('orchestrator verdict-fuzzy > slugifyTopic 短 slug 哈希尾', () => {
  it('短 slug 加 8 位 hex 哈希尾：llm → llm-<8hex>、纯中文 → topic-<8hex>；同输入同哈希（确定性）', () => {
    expect(slugifyTopic('LLM 输出可信度判定机制的业界现状')).toMatch(/^llm-[0-9a-f]{8}$/)
    expect(slugifyTopic('大模型评测方法综述')).toMatch(/^topic-[0-9a-f]{8}$/)
    // 确定性可复现：同输入恒同 id
    expect(slugifyTopic('LLM 输出可信度判定机制的业界现状')).toBe(slugifyTopic('LLM 输出可信度判定机制的业界现状'))
  })

  it('长 slug（≥6）不加尾；同短 slug 不同文本哈希尾不同；仍满足 TASK_ID_RE 字符集', () => {
    expect(slugifyTopic('llm trust probe')).toBe('llm-trust-probe')
    expect(slugifyTopic('x'.repeat(80))).toBe('x'.repeat(48)) // 截断 48 不变
    const a = slugifyTopic('LLM 可信度')
    const b = slugifyTopic('LLM 解释性')
    expect(a).toMatch(/^llm-[0-9a-f]{8}$/)
    expect(b).toMatch(/^llm-[0-9a-f]{8}$/)
    expect(a).not.toBe(b) // 同 slug 不同主题 → 不同哈希尾（唯一性）
    expect(slugifyTopic('A_B.C')).toMatch(/^[a-z0-9][a-z0-9-]*$/) // brief id 同规字符集
  })
})

describe('orchestrator verdict-fuzzy > verifyBriefOnce log 与落盘（e2e mock）', () => {
  /** 结论行带多个空白段：mock 的换序转述注入需要 ≥2 个空白段才构成非逐字。 */
  const FUZZY_BODY = [
    '# 结论',
    'mock 调研结论：DeepSeek V4.1 周下载 56.5T，份额 43.6% [1]。',
    '',
    '# 选项对比',
    '- DeepSeek V4.1：用量第一。',
    '',
    '# 引用',
    `- ${TODAY} https://a.com/rankings — 支撑 [1]`,
    '',
    '# 建议',
    '预设库补齐用量第一。',
    '',
    '# 罗盘对齐',
    '对齐配置托管定位。',
  ].join('\n')

  it('fabricated 红旗 log（降级保留口径）+ fuzzy 放行计数 log 出现；claims 带 verbatim 标注、编造条降级保留', () => {
    const repo = mkRepo()
    try {
      writeBrief(repo.root, { id: 'fz-probe', title: 't', question: 'q', backend: 'mock', body: FUZZY_BODY })
      const out = runOrch(repo.root, 'research verify fz-probe --backend mock', { ORCH_MOCK_REVIEW_FUZZY: '1' })
      // 编造条先触发逐字重试（t2 链路），重试仍败降级保留——红旗文案不回退
      expect(out.stdout).toContain('↻ 1 条 claim 非逐字摘录——追加逐字摘录契约重试')
      expect(out.stdout).toContain('⚠ 1 条 claim 非逐字摘录——降级保留（non_verbatim，编造红旗封顶 needs_review）')
      expect(out.stdout).toContain('· 1 条 claim 轻度转述按 fuzzy 放行')
      const verdict = JSON.parse(
        fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'research', 'fz-probe', 'verdict.json'), 'utf8'),
      )
      expect(verdict.fabricated_claims).toBe(1)
      const fuzzyClaim = verdict.claims.find((c: any) => c.verbatim === 'fuzzy')
      expect(fuzzyClaim).toBeTruthy()
      expect(fuzzyClaim.status).toBe('supported') // fuzzy 只标注，不降级
      const downgraded = verdict.claims.find((c: any) => c.non_verbatim)
      expect(downgraded).toBeTruthy() // 编造条走降级保留，不与 fuzzy 混淆
      expect(downgraded.status).toBe('partial')
      expect(downgraded.verbatim).toBeUndefined()
      expect(verdict.claims.some((c: any) => !('verbatim' in c) && !c.non_verbatim)).toBe(true) // 精确命中条目无标注（向后兼容）
      expect(verdict.claims.some((c: any) => !('verbatim' in c))).toBe(true) // 精确命中条目无标注（向后兼容）
    } finally {
      repo.cleanup()
    }
  }, 180_000)

  it('无注入时行为不变：精确回显全 valid、无 fuzzy log、无 verbatim 标注（现状回归）', () => {
    const repo = mkRepo()
    try {
      writeBrief(repo.root, { id: 'fz-plain', title: 't', question: 'q', backend: 'mock', body: FUZZY_BODY })
      const out = runOrch(repo.root, 'research verify fz-plain --backend mock')
      expect(out.stdout).not.toContain('轻度转述按 fuzzy 放行')
      expect(out.stdout).not.toContain('非逐字摘录已丢弃')
      const verdict = JSON.parse(
        fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'research', 'fz-plain', 'verdict.json'), 'utf8'),
      )
      expect(verdict.fabricated_claims).toBe(0)
      for (const c of verdict.claims) expect(c.verbatim).toBeUndefined()
    } finally {
      repo.cleanup()
    }
  }, 180_000)
})

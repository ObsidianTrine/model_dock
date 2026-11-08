// research.mjs / researcher 会话测试：brief 契约解析与校验、落盘、引用快照、
// prompt 契约、researcher 工具面（buildClaudeArgs web 模式）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseBriefBlock,
  extractCitations,
  extractDatedCitations,
  extractClaimTokens,
  citationDepthStats,
  validateBriefBody,
  writeBrief,
  readBrief,
  listBriefs,
  snapshotCitations,
  assessBrief,
  crossCheckClaims,
  verifyClaimVerbatim,
  scoreVerdict,
  parseVerdictBlock,
  appendResearchLedger,
  readLedgerStats,
  VERDICT_SCHEMA,
  BRIEF_MARKER,
} from '../../.agents/scripts/orchestrator/research.mjs'
import { buildResearchPrompt, CARD_MARKER } from '../../.agents/scripts/orchestrator/prompt.mjs'
import { buildClaudeArgs, RESEARCH_TOOLS } from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'
import { mkRepo, runOrch } from './helpers.js'

/** 测试固定时钟：fixtures 的访问日期随它生成（陈旧日期 gate 让写死日期在 7 天后必红）。 */
const TODAY = new Date().toISOString().slice(0, 10)

/** 五段齐全的可回查样例 brief（L1/L2/e2e 共用，模块级作用域）。 */
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
  '预设库补齐用量头部。',
  '',
  '# 罗盘对齐',
  '对齐配置托管定位。',
].join('\n')

const BRIEF_BODY = [
  '# 结论',
  'claude CLI 接第三方网关时 WebSearch 常不可用，WebFetch 可用 [1]。',
  '',
  '# 选项对比',
  '- 仅 WebFetch：直取已知来源，覆盖窄但稳。',
  '',
  '# 引用',
  `- ${TODAY} https://docs.example.com/websearch — 官方工具说明，支撑 [1]`,
  `- ${TODAY} https://blog.example.com/gateway — 实测记录，支撑 [1]`,
  '',
  '# 建议',
  'selftest 实测后再启用调研管线。',
  '',
  '# 罗盘对齐',
  '对齐「headless 舰队保持可调研」目标。',
].join('\n')

function briefBlockText(overrides: Record<string, string> = {}): string {
  return [
    '调研完成。',
    '',
    '```' + BRIEF_MARKER,
    `id: ${overrides.id ?? 'websearch-fallback'}`,
    `title: ${overrides.title ?? 'WebSearch 降级调研'}`,
    overrides.body ?? BRIEF_BODY,
    '```',
  ].join('\n')
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-test-'))
}

describe('orchestrator research > brief 契约', () => {
  it('parseBriefBlock：提取 id/title/body；缺 meta 或缺块返回 null', () => {
    const parsed = parseBriefBlock(briefBlockText())
    expect(parsed?.id).toBe('websearch-fallback')
    expect(parsed?.title).toBe('WebSearch 降级调研')
    expect(parsed?.body).toContain('# 结论')
    expect(parsed?.body).not.toContain('id:')
    expect(parseBriefBlock('没有契约块')).toBeNull()
    expect(parseBriefBlock('```' + BRIEF_MARKER + '\n缺 meta\n```')).toBeNull()
  })

  it('extractCitations：URL 去重保序、去尾部标点', () => {
    expect(extractCitations('见 https://a.com/x。与 https://b.com/y, 再提 https://a.com/x;')).toEqual([
      'https://a.com/x',
      'https://b.com/y',
    ])
  })

  it('validateBriefBody：五段齐全 + 带当日日期引用达标；缺段/缺引用给可操作报错', () => {
    expect(() => validateBriefBody(BRIEF_BODY, { minCitations: 1, today: TODAY })).not.toThrow()
    expect(validateBriefBody(BRIEF_BODY, { minCitations: 1, today: TODAY }).citations).toHaveLength(2)
    expect(() => validateBriefBody(BRIEF_BODY, { minCitations: 3, today: TODAY })).toThrow(/引用数不足.*≥3/)
    const noCite = BRIEF_BODY.replace(new RegExp(`^- ${TODAY} .+$`, 'gm'), '')
    expect(() => validateBriefBody(noCite, { today: TODAY })).toThrow(/无引用的调研不可对账|引用数不足/)
    const noSection = BRIEF_BODY.replace('# 选项对比', '# 其他')
    expect(() => validateBriefBody(noSection, { today: TODAY })).toThrow(/缺少「# 选项对比」段/)
  })

  it('validateBriefBody：编造引用防线（2026-11-08 首跑事故）——裸 URL 不计数、未来/陈旧日期拒收', () => {
    const today = '2026-11-08'
    // 裸 URL 行不计入：契约要求每行以访问日期开头
    const bare = BRIEF_BODY.replace(new RegExp(`^- ${TODAY} `, 'gm'), '- ')
    expect(extractDatedCitations(bare)).toHaveLength(0)
    expect(() => validateBriefBody(bare, { today })).toThrow(/带访问日期的引用 0 条/)
    // 未来日期 = 编造信号
    const future = BRIEF_BODY.replace(new RegExp(TODAY, 'g'), '2026-12-01')
    expect(() => validateBriefBody(future, { today })).toThrow(/引用日期在未来/)
    // 陈旧日期 = 拿旧数据冒充本次核查（首跑实录：2023）
    const stale = BRIEF_BODY.replace(new RegExp(TODAY, 'g'), '2023-12-10')
    expect(() => validateBriefBody(stale, { today })).toThrow(/引用访问日期陈旧/)
    // 跨午夜容忍窗：昨天日期放行
    const yesterday = BRIEF_BODY.replace(new RegExp(TODAY, 'g'), '2026-11-07')
    expect(() => validateBriefBody(yesterday, { today })).not.toThrow()
    // 部分陈旧也拒（任一行命中即拒）
    const mixed = BRIEF_BODY.replace(
      new RegExp(`^- ${TODAY} (https://blog\\.example\\.com/gateway)`, 'm'),
      '- 2023-01-01 $1',
    )
    expect(() => validateBriefBody(mixed, { today })).toThrow(/引用访问日期陈旧/)
  })

  it('writeBrief/readBrief/listBriefs：落盘 + 回读 + 清单；同 id 重写与非法 id 拒绝', () => {
    const root = tmpRoot()
    try {
      const dir = writeBrief(root, { id: 'websearch-fallback', title: 't', question: 'q', backend: 'mock', body: BRIEF_BODY })
      expect(fs.existsSync(path.join(dir, 'brief.md'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'meta.json'))).toBe(true)
      const brief = readBrief(root, 'websearch-fallback')
      expect(brief?.meta.question).toBe('q')
      expect(brief?.citations).toHaveLength(2)
      expect(listBriefs(root)).toEqual(['websearch-fallback'])
      expect(() => writeBrief(root, { id: 'websearch-fallback', title: 't', body: BRIEF_BODY })).toThrow(/已存在/)
      expect(() => writeBrief(root, { id: 'BAD_ID', title: 't', body: BRIEF_BODY })).toThrow(/不合法/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('snapshotCitations：快照成功与失败都尽力而为、绝不抛错', async () => {
    const root = tmpRoot()
    try {
      writeBrief(root, { id: 'snap-test', title: 't', body: BRIEF_BODY })
      const calls: string[] = []
      const snap = await snapshotCitations(root, 'snap-test', {
        fetchImpl: (async (url: string) => {
          calls.push(url)
          if (String(url).includes('blog')) throw new Error('boom')
          return { ok: true, status: 200, text: async () => 'page content' }
        }) as unknown as typeof fetch,
        timeoutMs: 1000,
      })
      expect(calls).toHaveLength(2)
      expect(snap.ok).toEqual(['https://docs.example.com/websearch'])
      expect(snap.failed).toHaveLength(1)
      expect(fs.readFileSync(path.join(root, '.agents/orchestrator/research/snap-test/sources/1.txt'), 'utf8')).toContain('page content')
      expect(await snapshotCitations(root, 'not-exist')).toEqual({ ok: [], failed: [] })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('orchestrator research > prompt 与工具面', () => {
  it('buildResearchPrompt：问题/契约五段/引用下限注入；goals 可选段；不含施工卡标记', () => {
    const withGoals = buildResearchPrompt('第三方网关的 WebSearch 可用性？', process.cwd(), { goalsText: '1. 舰队可调研', minCitations: 2 })
    expect(withGoals).toContain('调研问题：第三方网关的 WebSearch 可用性？')
    expect(withGoals).toContain('```' + BRIEF_MARKER)
    expect(withGoals).toContain('# 罗盘对齐')
    expect(withGoals).toContain('至少 2 条')
    expect(withGoals).toContain('1. 舰队可调研')
    expect(withGoals).not.toContain('```' + CARD_MARKER)
    const noGoals = buildResearchPrompt('q', process.cwd())
    expect(noGoals).not.toContain('## 项目罗盘（goals.md')
    expect(noGoals).toContain('至少 1 条')
  })

  it('buildResearchPrompt：编造引用防线——注入今天日期、引用日期契约行、来源核查要求', () => {
    const today = '2026-11-08'
    const p = buildResearchPrompt('q', process.cwd(), { today })
    expect(p).toContain(`今天是 ${today}`)
    expect(p).toContain(`- ${today} <URL> — <来源名>`)
    expect(p).toContain(`每行必须以今天的访问日期 ${today} 开头`)
    expect(p).toContain('未来或陈旧日期视为编造')
    expect(p).toContain('一手来源')
    expect(p).toContain('独立来源交叉')
    expect(p).toContain('不要为了凑引用数编造来源')
    expect(p).toContain('训练知识可能过时')
  })

  it('buildClaudeArgs web 模式：只读 + 联网白名单、无 acceptEdits（fail-closed）；readonly/worker 契约不回归', () => {
    const web = buildClaudeArgs({ maxTurns: 25, web: true })
    const webIdx = web.indexOf('--allowedTools')
    expect(web.slice(webIdx + 1, webIdx + 1 + RESEARCH_TOOLS.length)).toEqual(RESEARCH_TOOLS)
    expect(RESEARCH_TOOLS).toContain('WebFetch')
    expect(RESEARCH_TOOLS).toContain('WebSearch')
    // zsearch MCP 搜索工具（BigModel 搜索包）：白名单放行；server 未注册时多余项无害
    expect(RESEARCH_TOOLS).toContain('mcp__zsearch__web_search')
    expect(RESEARCH_TOOLS).not.toContain('Bash')
    expect(RESEARCH_TOOLS).not.toContain('Edit')
    expect(web).not.toContain('--permission-mode')
    // 调研船解耦选型：model 透传成 --model（2026-11-08 glm-4.5-air 事故）
    const withModel = buildClaudeArgs({ maxTurns: 25, web: true, model: 'glm-5.3-flash' })
    expect(withModel).toContain('--model')
    expect(withModel[withModel.indexOf('--model') + 1]).toBe('glm-5.3-flash')
    expect(buildClaudeArgs({ maxTurns: 25, web: true })).not.toContain('--model')
    const ro = buildClaudeArgs({ maxTurns: 10, readonly: true })
    expect(ro).toContain('Read')
    expect(ro).not.toContain('WebFetch')
    const worker = buildClaudeArgs({ maxTurns: 10 })
    expect(worker).toContain('--permission-mode')
    expect(worker).toContain('Edit')
  })
})

describe('orchestrator research > 可信度判定（L1/L2/L3）', () => {
  it('extractClaimTokens：数字+单位与型号名；排除年份/日期碎片/序号/引用段', () => {
    const tokens = extractClaimTokens(CLAIM_BODY)
    expect(tokens).toContain('56.5T')
    expect(tokens).toContain('43.6%')
    expect(tokens).toContain('V4.1')
    expect(tokens).toContain('GPT-6')
    expect(tokens).toContain('K3.1')
    expect(tokens).not.toContain('2026')
    expect(tokens).not.toContain('09')
    expect(tokens).not.toContain('2026-11-08')
  })

  it('crossCheckClaims：命中/未命中/命中率；无快照或无 token → checked=0', () => {
    const r = crossCheckClaims(CLAIM_BODY, [{ url: 'https://a.com/rankings', text: '榜单页：DeepSeek V4.1 周下载 56.5T、份额 43.6%、GPT-6 领跑' }])
    expect(r.checked).toBeGreaterThan(0)
    expect(r.hits).toBeGreaterThanOrEqual(3)
    expect(r.misses).toContain('K3.1')
    expect(crossCheckClaims(CLAIM_BODY, []).checked).toBe(0)
  })

  it('citationDepthStats：深链/根路径比', () => {
    const body = '# 引用\n- 2026-11-08 https://openrouter.ai/rankings — 深链\n- 2026-11-08 https://lmsys.org/ — 根路径'
    expect(citationDepthStats(body)).toEqual({ deep: 1, root: 1, total: 2, ratio: 0.5 })
  })

  it('verifyClaimVerbatim：逐字摘录通过；改写/超长判 fabricated（v3 防线）', () => {
    const ok = [{ claim: 'DeepSeek V4.1 周下载 56.5T，占 43.6%；2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜 [1]。', status: 'supported' }]
    const v = verifyClaimVerbatim(ok, CLAIM_BODY)
    expect(v.valid).toHaveLength(1)
    expect(v.fabricated).toHaveLength(0)
    // 跨行/多空格归一后仍算逐字
    const wrapped = verifyClaimVerbatim([{ claim: 'DeepSeek V4.1 周下载\n  56.5T，占 43.6%；2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜 [1]。', status: 'supported' }], CLAIM_BODY)
    expect(wrapped.valid).toHaveLength(1)
    // 改写 → fabricated
    const para = verifyClaimVerbatim([{ claim: 'DeepSeek V4.1 下载量全球第一（改写版）', status: 'supported' }], CLAIM_BODY)
    expect(para.valid).toHaveLength(0)
    expect(para.fabricated).toHaveLength(1)
  })

  it('scoreVerdict：null 传染 / contradicted 一票否决 / fabricated 封顶 / coverage 门槛 / overall 重归一', () => {
    const claimsOk = [{ claim: 'a', status: 'supported' }, { claim: 'b', status: 'supported' }]
    // 维度齐全 + 高分 → decision ok
    const good = scoreVerdict({ claims: claimsOk, fabricatedCount: 0, citation: 90, evidence: 80, gates: {} })
    expect(good.scores.coverage).toBe(100)
    expect(good.scores.coherence).toBe(100)
    expect(good.usage.internal_decision).toBe('ok')
    expect(good.usage.external_doc).toBe('ok')
    expect(good.level).toBe('pass')
    // contradicted 一票否决（即使其他分很高）
    const vetoed = scoreVerdict({ claims: [...claimsOk, { claim: 'c', status: 'contradicted' }], citation: 90, evidence: 90 })
    expect(vetoed.veto).toBe(true)
    expect(vetoed.usage.internal_decision).toBe('unsafe')
    expect(vetoed.usage.external_doc).toBe('unsafe')
    // fabricated 封顶 needs_review（红旗 ≠ 否决）
    const fab = scoreVerdict({ claims: claimsOk, fabricatedCount: 2, citation: 90, evidence: 80 })
    expect(fab.usage.internal_decision).toBe('needs_review')
    // coverage 低于硬底线 50 → 不得 ok（10 条只核 2 条）
    const lowCov = scoreVerdict({ claims: [...claimsOk, ...Array.from({ length: 8 }, (_, i) => ({ claim: `x${i}`, status: 'unverifiable' }))], citation: 90, evidence: 80 })
    expect(lowCov.scores.coverage).toBe(20)
    expect(lowCov.usage.internal_decision).toBe('needs_review')
    // evidence null（无快照）→ overall null + undetermined（不可核 ≠ 0 分）
    const unk = scoreVerdict({ claims: claimsOk, citation: 90, evidence: null })
    expect(unk.scores.overall).toBeNull()
    expect(unk.usage.internal_decision).toBe('undetermined')
    expect(unk.level).toBe('unknown')
    // citation 缺失 → overall 重归一（0.4/0.35/0.10），仍可判
    const noCite = scoreVerdict({ claims: claimsOk, citation: null, evidence: 80 })
    expect(noCite.scores.overall).toBe(Math.round((80 * 0.4 + 100 * 0.35 + 100 * 0.1) / 0.85))
    // 自定义阈值：coherence 门槛提到 90 → 80 分 coherence 落 needs_review
    const strict = scoreVerdict({ claims: [{ claim: 'a', status: 'partial' }], citation: 90, evidence: 80, gates: { decision: { coherence: 90 } } })
    expect(strict.usage.internal_decision).toBe('needs_review')
    // unverifiable 拖 coverage 不拖 coherence
    const partialUnv = scoreVerdict({ claims: [{ claim: 'a', status: 'supported' }, { claim: 'b', status: 'unverifiable' }], citation: 90, evidence: 80 })
    expect(partialUnv.scores.coherence).toBe(100)
    expect(partialUnv.scores.coverage).toBe(50)
  })

  it('parseVerdictBlock：JSON 契约（claims 枚举/上限校验）；非法返回 null', () => {
    const block = '复核完成。\n\n```agents-verdict\n' + JSON.stringify({
      claims: [{ claim: 'DeepSeek V4.1 周下载 56.5T', status: 'supported', note: '快照命中' }, { claim: 'OpenHands ~89k stars', status: 'contradicted', note: '两处引文矛盾' }],
      blockers: ['星数矛盾'],
    }) + '\n```'
    expect(parseVerdictBlock(block)).toEqual({
      claims: [
        { claim: 'DeepSeek V4.1 周下载 56.5T', status: 'supported', note: '快照命中' },
        { claim: 'OpenHands ~89k stars', status: 'contradicted', note: '两处引文矛盾' },
      ],
      blockers: ['星数矛盾'],
    })
    expect(parseVerdictBlock('没有契约块')).toBeNull()
    expect(parseVerdictBlock('```agents-verdict\n{bad json}\n```')).toBeNull()
    expect(parseVerdictBlock('```agents-verdict\n' + JSON.stringify({ claims: [{ claim: 'x', status: '极高' }] }) + '\n```')).toBeNull()
    expect(parseVerdictBlock('```agents-verdict\n' + JSON.stringify({ claims: [] }) + '\n```')).toBeNull()
  })

  it('assessBrief（L1-only）+ 台账：verdict/2 落盘（claims 空 → coverage/coherence null → 决策 undetermined）', () => {
    const root = tmpRoot()
    try {
      writeBrief(root, { id: 'verify-me', title: 't', body: CLAIM_BODY })
      const srcDir = path.join(root, '.agents/orchestrator/research/verify-me/sources')
      fs.mkdirSync(srcDir, { recursive: true })
      fs.writeFileSync(path.join(srcDir, '1.txt'), 'url: https://a.com/rankings\n\n榜单页：DeepSeek V4.1 周下载 56.5T、份额 43.6%、GPT-6 领跑')
      const verdict = assessBrief(root, 'verify-me', { model: 'glm-5.3-flash' })
      expect(verdict.schema).toBe(VERDICT_SCHEMA)
      expect(verdict.advisory).toBe(true)
      expect(verdict.scores.evidence).toBeGreaterThan(0)
      expect(verdict.scores.coverage).toBeNull()
      expect(verdict.scores.overall).toBeNull()
      expect(verdict.usage.browse).toBe('ok')
      expect(verdict.usage.internal_decision).toBe('undetermined')
      expect(verdict.level).toBe('unknown')
      expect(JSON.parse(fs.readFileSync(path.join(root, '.agents/orchestrator/research/verify-me/verdict.json'), 'utf8')).brief_id).toBe('verify-me')
      appendResearchLedger(root, { kind: 'l1', brief_id: 'verify-me', model: 'glm-5.3-flash', level: 'warn', hit_rate: 0.8 })
      appendResearchLedger(root, { kind: 'l1', brief_id: 'other', model: 'glm-4.5-air', level: 'fail', hit_rate: 0.2 })
      const stats = readLedgerStats(root)
      const m53 = stats.find((s) => s.model === 'glm-5.3-flash')
      const air = stats.find((s) => s.model === 'glm-4.5-air')
      expect(m53.runs).toBe(1)
      expect(m53.avg_hit_rate).toBe(0.8)
      expect(air.levels.fail).toBe(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('orchestrator research > verify e2e（mock）', () => {
  it('research verify（v2 契约）：claim 逐字校验 + 维度分 + usage 矩阵 + 台账 + stats 可读', () => {
    const repo = mkRepo()
    try {
      const root = repo.root
      writeBrief(root, { id: 'verify-me', title: 't', question: 'q', backend: 'mock', body: CLAIM_BODY })
      const srcDir = path.join(root, '.agents', 'orchestrator', 'research', 'verify-me', 'sources')
      fs.mkdirSync(srcDir, { recursive: true })
      fs.writeFileSync(path.join(srcDir, '1.txt'), 'url: https://a.com/rankings\n\n榜单页：DeepSeek V4.1 周下载 56.5T、份额 43.6%、GPT-6 与 Kimi K3.1 领跑')
      runOrch(repo.root, 'research verify verify-me --backend mock')
      const verdict = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'orchestrator', 'research', 'verify-me', 'verdict.json'), 'utf8'))
      expect(verdict.schema).toBe('modeldock.research.verdict/2')
      expect(verdict.claims).toHaveLength(1)
      expect(verdict.claims[0].status).toBe('supported')
      expect(verdict.claims[0].by).toBe('l1') // L1 数字回查自动标注优先（确定性优先于 LLM 意见）
      expect(verdict.fabricated_claims).toBe(0)
      expect(verdict.scores.coverage).toBe(100)
      expect(verdict.usage.internal_decision).toBe('ok')
      expect(verdict.usage.external_doc).toBe('ok')
      const ledger = fs.readFileSync(path.join(root, '.agents', 'orchestrator', 'research', 'ledger.jsonl'), 'utf8')
      expect(ledger).toContain('"kind":"l2"')
      expect(ledger).toContain('"decision":"ok"')
      const out = runOrch(repo.root, 'research stats')
      expect(out.stdout).toContain('次判定')
      // 否决链路：blockers>0 → mock 判 contradicted → 一票否决
      runOrch(repo.root, 'research verify verify-me --backend mock', { ORCH_MOCK_REVIEW_BLOCKERS: '1' })
      const vetoed = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'orchestrator', 'research', 'verify-me', 'verdict.json'), 'utf8'))
      expect(vetoed.claims[0].status).toBe('contradicted')
      expect(vetoed.usage.internal_decision).toBe('unsafe')
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

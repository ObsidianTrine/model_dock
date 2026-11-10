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
  assessSnapshotUsability,
  buildResearchNotifyBody,
  crossCheckClaims,
  verifyClaimVerbatim,
  stripInlineCitations,
  normalizeClaimStatuses,
  scoreVerdict,
  readVerdict,
  readVerdictDetailed,
  verdictGateBlocks,
  parseVerdictBlock,
  appendResearchLedger,
  readLedgerStats,
  VERDICT_SCHEMA,
  BRIEF_MARKER,
} from '../../.agents/scripts/orchestrator/research.mjs'
import { buildResearchPrompt, buildVerifierPrompt, CARD_MARKER } from '../../.agents/scripts/orchestrator/prompt.mjs'
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
    // 部分陈旧也拒（任一行命中即拒）；其余引用日期先对齐 today 再只改一行——
    // fixture 引用日期随跑测日 TODAY 生成，与固定 today 混用时未对齐行会被「未来日期」抢先报错（2026-11-10 实测）
    const mixed = BRIEF_BODY.replace(new RegExp(TODAY, 'g'), today).replace(
      new RegExp(`^- ${today} (https://blog\\.example\\.com/gateway)`, 'm'),
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

  it('snapshotCitations：快照成功与失败都尽力而为、绝不抛错（2026-11-10 分类语义：HTTP 200 但可见文本 <400 → skeleton，不计入 ok）', async () => {
    const root = tmpRoot()
    try {
      writeBrief(root, { id: 'snap-test', title: 't', body: BRIEF_BODY })
      const calls: string[] = []
      const snap = await snapshotCitations(root, 'snap-test', {
        fetchImpl: (async (url: string) => {
          calls.push(url)
          if (String(url).includes('blog')) throw new Error('boom') // 永久类失败：不重试
          return { ok: true, status: 200, text: async () => 'page content' }
        }) as unknown as typeof fetch,
        timeoutMs: 1000,
      })
      expect(calls).toHaveLength(2)
      // ok 语义收窄：skeleton 不再计入 ok；snapshots 逐条分类（含 index/url/status/via）
      expect(snap.ok).toEqual([])
      expect(snap.failed.map((f: any) => f.url)).toEqual(['https://blog.example.com/gateway'])
      expect(snap.snapshots.map((s: any) => s.status)).toEqual(['skeleton', 'failed'])
      expect(snap.snapshots.every((s: any) => s.via === 'direct')).toBe(true)
      expect(fs.readFileSync(path.join(root, '.agents/orchestrator/research/snap-test/sources/1.txt'), 'utf8')).toContain('page content')
      expect(await snapshotCitations(root, 'not-exist')).toEqual({ ok: [], failed: [], snapshots: [] })
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

  it('buildVerifierPrompt：硬性要求 1 含行内 [n] 引用豁免句（prompt 契约锁定，2026-11-10）', () => {
    const p = buildVerifierPrompt(CLAIM_BODY, '快照文本', process.cwd())
    const req1 = p.split('\n').find((l) => l.startsWith('1. claim'))
    expect(req1).toContain('逐字摘自 brief 原文')
    expect(req1).toContain('行内 [n] 引用标注可省略')
  })

  it('buildVerifierPrompt：status 枚举五行不回退（枚举集合零改动）', () => {
    const p = buildVerifierPrompt(CLAIM_BODY, '快照文本', process.cwd())
    for (const head of ['- supported：', '- partial：', '- unsupported：', '- contradicted：', '- unverifiable：']) {
      expect(p).toContain(head)
    }
    expect(p).toContain('status 枚举（只允许这五个）')
  })

  it('buildVerifierPrompt：partial 三条判定标准 + supported 正面定义（rubric 校准，2026-11-10）', () => {
    const p = buildVerifierPrompt(CLAIM_BODY, '快照文本', process.cwd())
    // partial 三条判定标准关键句
    expect(p).toContain('快照仅覆盖 claim 的部分承重断言')
    expect(p).toContain('数字方向一致但数值或范围不符')
    expect(p).toContain('依据是对快照内容的转述/归纳')
    // supported 正面定义句
    expect(p).toContain('全部承重断言')
    const supportedLine = p.split('\n').find((l) => l.startsWith('- supported：'))
    expect(supportedLine).toContain('都有快照直接依据')
    expect(supportedLine).toContain('就不算 supported')
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

  it('stripInlineCitations + verifyClaimVerbatim：剥 [n] 后逐字通过（行内引用豁免）', () => {
    // 纯函数本身：剥 1-3 位数字标注，其余方括号内容不动
    expect(stripInlineCitations('A [1] B [42] C')).toBe('A B C')
    expect(stripInlineCitations('A [2026] B [1m]')).toBe('A [2026] B [1m]')
    // claim 省略 [n]、brief 带 [n]：剥后逐字 → 通过
    const v = verifyClaimVerbatim(
      [{ claim: 'DeepSeek V4.1 周下载 56.5T，占 43.6%；2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜。', status: 'supported' }],
      CLAIM_BODY,
    )
    expect(v.valid).toHaveLength(1)
    expect(v.fabricated).toHaveLength(0)
    // 通过的 claim 保留原始归一文本（[n] 不被改写进存储值）
    expect(v.valid[0].claim).toBe('DeepSeek V4.1 周下载 56.5T，占 43.6%；2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜。')
  })

  it('verifyClaimVerbatim：[2026]/[1m] 不豁免——仅差非数字标注仍 fabricated', () => {
    // brief 是 …质量榜 [1]。；claim 换成 [2026]/[1m]：不豁免，剥后对不上 → fabricated
    const y = verifyClaimVerbatim([{ claim: 'DeepSeek V4.1 周下载 56.5T，占 43.6%；2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜 [2026]。', status: 'supported' }], CLAIM_BODY)
    expect(y.valid).toHaveLength(0)
    expect(y.fabricated).toHaveLength(1)
    const m = verifyClaimVerbatim([{ claim: 'DeepSeek V4.1 周下载 56.5T，占 43.6%；2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜 [1m]。', status: 'supported' }], CLAIM_BODY)
    expect(m.valid).toHaveLength(0)
    expect(m.fabricated).toHaveLength(1)
  })

  it('verifyClaimVerbatim：空白归一叠加 [n] 豁免组合——跨行 + 多空格 + 省略 [n] 仍逐字通过', () => {
    const combo = verifyClaimVerbatim(
      [{ claim: 'DeepSeek V4.1 周下载\n  56.5T，占 43.6%；2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜。', status: 'supported' }],
      CLAIM_BODY,
    )
    expect(combo.valid).toHaveLength(1)
    expect(combo.fabricated).toHaveLength(0)
  })

  it('normalizeClaimStatuses：note 自认无快照/无直据的 supported 降级 unsupported（downgraded 留痕、note 保留）；真 supported 与非 supported 不误伤', () => {
    const out = normalizeClaimStatuses([
      { claim: 'a', status: 'supported', note: '快照缺失，无法对账' }, // 命中：自相矛盾
      { claim: 'b', status: 'supported', note: '快照命中，数字一致' }, // 真 supported：不误伤
      { claim: 'c', status: 'supported', note: '' }, // 无 note：不动
      { claim: 'd', status: 'partial', note: '无直据' }, // 非 supported：不动
      { claim: 'e', status: 'unsupported', note: '查无出处' }, // 本就 unsupported：不动、不加标记
    ])
    expect(out[0]).toEqual({ claim: 'a', status: 'unsupported', note: '快照缺失，无法对账', downgraded: true })
    expect(out[1]).toEqual({ claim: 'b', status: 'supported', note: '快照命中，数字一致' })
    expect(out[2]).toEqual({ claim: 'c', status: 'supported', note: '' })
    expect(out[3]).toEqual({ claim: 'd', status: 'partial', note: '无直据' })
    expect(out[4]).toEqual({ claim: 'e', status: 'unsupported', note: '查无出处' })
    // 降级词面覆盖：各关键词都命中（快照仅/未提供/截断/不可见/无任何直据）
    for (const note of ['快照仅部分可对', '来源未提供', '页面截断', '原文不可见', '无任何直据', '无出处']) {
      expect(normalizeClaimStatuses([{ claim: 'x', status: 'supported', note }])[0].status).toBe('unsupported')
    }
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

  it('scoreVerdict：claims 全灭 + fabricated>0 → needs_review 升格（复核契约被违反是红旗，不是「没测」）；browse 恒 ok', () => {
    // 全灭 + 编造：在 null→undetermined 之前判 needs_review（null 维不再传染成 undetermined）
    const wiped = scoreVerdict({ claims: [], fabricatedCount: 10, citation: 90, evidence: 80 })
    expect(wiped.usage.internal_decision).toBe('needs_review')
    expect(wiped.usage.browse).toBe('ok')
    expect(wiped.usage.external_doc).toBe('undetermined')
    expect(wiped.scores.overall).toBeNull()
    expect(wiped.level).toBe('unknown')
    // 对照：全灭但无 fabricated → 仍 undetermined（数据不足以判定）
    const plain = scoreVerdict({ claims: [], fabricatedCount: 0, citation: 90, evidence: 80 })
    expect(plain.usage.internal_decision).toBe('undetermined')
  })

  it('verdictGateBlocks：usage=unsafe 或任一 claim contradicted 阻断；ok/needs_review/undetermined/verdict 缺席放行', () => {
    expect(verdictGateBlocks({ usage: { internal_decision: 'unsafe' }, claims: [] })).toBe(true)
    // claims 否决独立生效：usage 未标 unsafe（如旧 verdict / 手改文件）也拦——同源双保险
    expect(verdictGateBlocks({ usage: { internal_decision: 'needs_review' }, claims: [{ claim: 'a', status: 'contradicted' }] })).toBe(true)
    expect(verdictGateBlocks({ usage: { internal_decision: 'ok' }, claims: [{ claim: 'a', status: 'supported' }] })).toBe(false)
    expect(verdictGateBlocks({ usage: { internal_decision: 'needs_review' }, claims: [{ claim: 'a', status: 'unsupported' }] })).toBe(false)
    expect(verdictGateBlocks({ usage: { internal_decision: 'undetermined' }, claims: [] })).toBe(false)
    // verdict 缺席（旧 brief / 未跑 L1）与非对象输入一律放行
    expect(verdictGateBlocks(null)).toBe(false)
    expect(verdictGateBlocks(undefined)).toBe(false)
    expect(verdictGateBlocks('garbage')).toBe(false)
  })

  it('readVerdict：不存在/损坏返回 null（放行口径），合法 JSON 原样返回', () => {
    const root = tmpRoot()
    try {
      expect(readVerdict(root, 'no-such-brief')).toBeNull()
      expect(readVerdict(root, '')).toBeNull()
      const dir = path.join(root, '.agents', 'orchestrator', 'research', 'b1')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'verdict.json'), '{oops')
      expect(readVerdict(root, 'b1')).toBeNull()
      fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ schema: VERDICT_SCHEMA, usage: { internal_decision: 'ok' } }))
      expect(readVerdict(root, 'b1')?.usage?.internal_decision).toBe('ok')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('readVerdictDetailed：三态区分——正常 { verdict } / 存在但损坏 { corrupt } / 不存在 null', () => {
    const root = tmpRoot()
    try {
      expect(readVerdictDetailed(root, 'no-such-brief')).toBeNull()
      expect(readVerdictDetailed(root, '')).toBeNull()
      const dir = path.join(root, '.agents', 'orchestrator', 'research', 'b2')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'verdict.json'), '{手改损坏')
      const corrupt = readVerdictDetailed(root, 'b2')
      expect(corrupt?.corrupt).toBe(true)
      expect(corrupt?.verdict).toBeNull()
      expect(readVerdict(root, 'b2')).toBeNull() // 旧消费方语义不变（放行口径）
      fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ schema: VERDICT_SCHEMA, usage: { internal_decision: 'ok' } }))
      expect(readVerdictDetailed(root, 'b2')?.corrupt).toBeUndefined()
      expect(readVerdictDetailed(root, 'b2')?.verdict?.usage?.internal_decision).toBe('ok')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('scoreVerdict：strong_support 观测指标——全 supported→100、含 partial 按整数、全 unverifiable→null', () => {
    // 全 supported → 100
    expect(scoreVerdict({ claims: [{ claim: 'a', status: 'supported' }, { claim: 'b', status: 'supported' }], citation: 90, evidence: 80 }).scores.strong_support).toBe(100)
    // 含 partial：分母只数已核承重结论（unverifiable 不计）——2 supported + 1 partial / 3 → 67
    const mixed = scoreVerdict({
      claims: [
        { claim: 'a', status: 'supported' },
        { claim: 'b', status: 'supported' },
        { claim: 'c', status: 'partial' },
        { claim: 'd', status: 'unverifiable' },
        { claim: 'e', status: 'unverifiable' },
      ],
      citation: 90, evidence: 80,
    })
    expect(mixed.scores.strong_support).toBe(67)
    // unsupported / contradicted 计分母不计分子
    const bad = scoreVerdict({ claims: [{ claim: 'a', status: 'supported' }, { claim: 'b', status: 'unsupported' }, { claim: 'c', status: 'contradicted' }], citation: 90, evidence: 80 })
    expect(bad.scores.strong_support).toBe(33)
    // 全 unverifiable → checked 空 → null；claims 空 → null
    expect(scoreVerdict({ claims: [{ claim: 'a', status: 'unverifiable' }], citation: 90, evidence: 80 }).scores.strong_support).toBeNull()
    expect(scoreVerdict({ claims: [], citation: 90, evidence: 80 }).scores.strong_support).toBeNull()
  })

  it('scoreVerdict：决策快照——strong_support 为纯派生观测值，usage/overall 与判分语义逐字段不变', () => {
    // 快照 1：全 supported 高分——整体返回对象逐字段锁定（overall 加权 0.15*90+0.4*80+0.35*100+0.1*100 = 91）
    expect(scoreVerdict({ claims: [{ claim: 'a', status: 'supported' }, { claim: 'b', status: 'supported' }], fabricatedCount: 0, citation: 90, evidence: 80, gates: {} })).toEqual({
      scores: { citation: 90, evidence: 80, coherence: 100, coverage: 100, strong_support: 100, overall: 91 },
      usage: { browse: 'ok', internal_decision: 'ok', external_doc: 'ok' },
      veto: false,
      contradicted_count: 0,
      level: 'pass',
    })
    // 快照 2：partial + 自定义门槛——strong_support=0 不参与决策（coherence 50 < 90 → needs_review，overall 73）
    expect(scoreVerdict({ claims: [{ claim: 'a', status: 'partial' }], fabricatedCount: 0, citation: 90, evidence: 80, gates: { decision: { coherence: 90 } } })).toEqual({
      scores: { citation: 90, evidence: 80, coherence: 50, coverage: 100, strong_support: 0, overall: 73 },
      usage: { browse: 'ok', internal_decision: 'needs_review', external_doc: 'undetermined' },
      veto: false,
      contradicted_count: 0,
      level: 'warn',
    })
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

  it('readLedgerStats：L2 条目按 researcher_model 分组（model 是复核船）；旧条目无 researcher_model 回退 model', () => {
    const root = tmpRoot()
    try {
      // 新口径 L2 条目：model=复核船（verifier-x），researcher_model=调研船
      appendResearchLedger(root, { kind: 'l2', brief_id: 'a', model: 'verifier-x', researcher_model: 'glm-5.3-flash', level: 'pass', hit_rate: 0.9 })
      // 新口径 L1 条目：model=researcher_model=调研船
      appendResearchLedger(root, { kind: 'l1', brief_id: 'b', model: 'glm-5.3-flash', researcher_model: 'glm-5.3-flash', level: 'warn', hit_rate: 0.5 })
      // 旧条目：无 researcher_model → 回退按 model 分组（向后兼容）
      appendResearchLedger(root, { kind: 'l1', brief_id: 'c', model: 'glm-4.5-air', level: 'fail', hit_rate: 0.1 })
      const stats = readLedgerStats(root)
      expect(stats).toHaveLength(2) // 复核船 verifier-x 不单独成档——按调研船归并
      const m53 = stats.find((s) => s.model === 'glm-5.3-flash')
      const air = stats.find((s) => s.model === 'glm-4.5-air')
      expect(m53?.runs).toBe(2)
      expect(m53?.avg_hit_rate).toBeCloseTo(0.7)
      expect(air?.runs).toBe(1)
      expect(air?.levels.fail).toBe(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('readLedgerStats：avg_strong_support 聚合——含字段条目取均值、缺字段条目跳过、全缺 → null', () => {
    const root = tmpRoot()
    try {
      // m-a：两条带 strong_support（100/50）+ 一条旧口径缺字段 → 均值 75（缺字段不进分母）
      appendResearchLedger(root, { kind: 'l2', brief_id: 'a', model: 'v', researcher_model: 'm-a', level: 'pass', strong_support: 100 })
      appendResearchLedger(root, { kind: 'l2', brief_id: 'b', model: 'v', researcher_model: 'm-a', level: 'warn', strong_support: 50 })
      appendResearchLedger(root, { kind: 'l2', brief_id: 'c', model: 'v', researcher_model: 'm-a', level: 'warn' })
      // m-b：全缺 strong_support → null（与 avg_hit_rate 同款 null 语义）
      appendResearchLedger(root, { kind: 'l1', brief_id: 'd', model: 'm-b', level: 'fail', hit_rate: 0.3 })
      const stats = readLedgerStats(root)
      const a = stats.find((s) => s.model === 'm-a')
      expect(a?.runs).toBe(3)
      expect(a?.avg_strong_support).toBe(75)
      expect(stats.find((s) => s.model === 'm-b')?.avg_strong_support).toBeNull()
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
      // verdict.model=调研船（L1 verdict 写入者，此处回落 brief.backend）；复核船在 verifier
      expect(verdict.model).toBe('mock')
      expect(verdict.verifier.model).toBeNull()
      expect(verdict.scores.coverage).toBe(100)
      expect(verdict.scores.strong_support).toBe(100) // L1 回查全命中 → supported → 完全支撑率 100（观测）
      expect(verdict.usage.internal_decision).toBe('ok')
      expect(verdict.usage.external_doc).toBe('ok')
      const ledger = fs.readFileSync(path.join(root, '.agents', 'orchestrator', 'research', 'ledger.jsonl'), 'utf8')
      expect(ledger).toContain('"kind":"l2"')
      expect(ledger).toContain('"strong_support":100') // l2 台账条目带 strong_support
      expect(ledger).toContain('"decision":"ok"')
      expect(ledger).toContain('"researcher_model":"mock"') // L3 台账带调研船口径（model 是复核船，未指定 → null）
      const out = runOrch(repo.root, 'research stats')
      expect(out.stdout).toContain('次判定')
      // 否决链路：blockers>0 → mock 判 contradicted → 仲裁轮 overturned（外部证实矛盾）
      // → 一票否决维持（缺省 upheld 会翻案解除——仲裁 e2e 见 research-arbitration.test.ts）
      runOrch(repo.root, 'research verify verify-me --backend mock', { ORCH_MOCK_REVIEW_BLOCKERS: '1', ORCH_MOCK_ARB_RULING: 'overturned' })
      const vetoed = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'orchestrator', 'research', 'verify-me', 'verdict.json'), 'utf8'))
      expect(vetoed.claims[0].status).toBe('contradicted')
      expect(vetoed.usage.internal_decision).toBe('unsafe')
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

describe('orchestrator research > 快照骨架识别与完成通知', () => {
  const HEAD_PAGE = '<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="description" content="app"/><script src="/x.js"></script></head><body class="dark"><div id="root"></div></body></html>'

  it('assessSnapshotUsability：骨架页（可见文本 <400）判 unusable；正文页判 usable', () => {
    const head = assessSnapshotUsability(`url: https://x.com\nfetched_at: t\n\n${HEAD_PAGE}`)
    expect(head.usable).toBe(false)
    expect(head.visibleChars).toBeLessThan(400)
    const rich = assessSnapshotUsability(`url: https://x.com\nfetched_at: t\n\n${'榜单正文内容。'.repeat(60)}`)
    expect(rich.usable).toBe(true)
  })

  it('loadSnapshots 标注 usable；assessBrief 带 snapshots 字段与骨架 reason（只标注不改判级/evidence 口径）', () => {
    const root = tmpRoot()
    try {
      writeBrief(root, { id: 'sk-test', title: 't', body: CLAIM_BODY })
      const srcDir = path.join(root, '.agents/orchestrator/research/sk-test/sources')
      fs.mkdirSync(srcDir, { recursive: true })
      fs.writeFileSync(path.join(srcDir, '1.txt'), `url: https://a.com/rankings\n\n${HEAD_PAGE}`)
      const verdict = assessBrief(root, 'sk-test', { model: 'glm-5.3-flash' })
      expect(verdict.snapshots).toEqual({ total: 1, usable: 0, skeleton: 1 })
      expect(verdict.reasons.join('\n')).toMatch(/骨架页/)
      // 只标注不改口径：claim 回查仍吃全部快照（meta 也可佐证），evidence 不因骨架置 null
      expect(verdict.scores.evidence).not.toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('buildResearchNotifyBody：维度分行含四维与 strong_support（观测）；四维全 null 不出维度行', () => {
    const body = buildResearchNotifyBody({
      brief_id: 'b2', level: 'pass',
      scores: { citation: 90, evidence: 80, coherence: 100, coverage: 100, strong_support: 100, overall: 91 },
      usage: { browse: 'ok', internal_decision: 'ok', external_doc: 'ok' },
    })
    const dim = body.split('\n').find((l) => l.startsWith('维度分:'))
    expect(dim).toBe('维度分: evidence=80 coherence=100 coverage=100% citation=90 strong_support=100')
    // 四维全 null（L1 纯空壳 / 缺 scores）→ 省略整行，通知行数不膨胀
    const bare = buildResearchNotifyBody({ brief_id: 'b3', level: 'unknown', scores: { overall: null }, usage: {} })
    expect(bare.split('\n').find((l) => l.startsWith('维度分:'))).toBeUndefined()
  })

  it('buildResearchNotifyBody：判级/usage/claims 统计/理由截断成通知正文', () => {
    const body = buildResearchNotifyBody({
      brief_id: 'b1', level: 'warn',
      scores: { overall: 58 },
      usage: { browse: 'ok', internal_decision: 'unsafe', external_doc: 'unsafe' },
      claims: [{ claim: 'a', status: 'contradicted' }, { claim: 'b', status: 'unsupported' }, { claim: 'c', status: 'supported' }],
      reasons: ['[contradicted] x——y', '第二条', '第三条', '第四条'],
      blockers: ['星数矛盾'],
    })
    expect(body).toContain('⚠️ b1——warn（overall 58）')
    expect(body).toContain('decision=unsafe')
    expect(body).toContain('claims: 1 contradicted / 1 unsupported / 共 3 条')
    expect(body).toContain('blockers: 星数矛盾')
    expect(body.split('\n').length).toBeLessThanOrEqual(7) // reasons 截前 3 条
  })
})

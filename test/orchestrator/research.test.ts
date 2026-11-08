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
  validateBriefBody,
  writeBrief,
  readBrief,
  listBriefs,
  snapshotCitations,
  assessBrief,
  crossCheckClaims,
  citationDepthStats,
  computeVerdict,
  extractClaimTokens,
  parseVerdictBlock,
  appendResearchLedger,
  readLedgerStats,
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

  it('computeVerdict：判级与降级（快照缺失 unknown；低命中 fail；中命中 warn；高命中 pass；深链比降级）', () => {
    const depth = { deep: 9, root: 1, total: 10, ratio: 0.9 }
    expect(computeVerdict({ briefBody: 'x', snapshotsOk: false, claimCheck: { checked: 10, hits: 8, hit_rate: 0.8, misses: [] }, depth }).level).toBe('unknown')
    expect(computeVerdict({ briefBody: 'x', snapshotsOk: true, claimCheck: { checked: 0, hits: 0, hit_rate: null, misses: [] }, depth }).level).toBe('unknown')
    expect(computeVerdict({ briefBody: 'x', snapshotsOk: true, claimCheck: { checked: 10, hits: 9, hit_rate: 0.9, misses: [] }, depth }).level).toBe('pass')
    expect(computeVerdict({ briefBody: 'x', snapshotsOk: true, claimCheck: { checked: 10, hits: 5, hit_rate: 0.5, misses: ['a'] }, depth }).level).toBe('warn')
    expect(computeVerdict({ briefBody: 'x', snapshotsOk: true, claimCheck: { checked: 10, hits: 2, hit_rate: 0.2, misses: ['a'] }, depth }).level).toBe('fail')
    // 高命中但全是根路径引用 → 降级 warn
    expect(computeVerdict({ briefBody: 'x', snapshotsOk: true, claimCheck: { checked: 10, hits: 9, hit_rate: 0.9, misses: [] }, depth: { deep: 2, root: 8, total: 10, ratio: 0.2 } }).level).toBe('warn')
  })

  it('parseVerdictBlock：L2 契约解析；缺失/非法判级返回 null', () => {
    const block = '复核完成。\n\n```agents-verdict\nlevel: medium\nblockers: 1\n# 理由\n- 部分支撑\n- 疑点：口径未标\n```'
    expect(parseVerdictBlock(block)).toEqual({ level: 'medium', blockers: 1, reasons: ['部分支撑', '疑点：口径未标'] })
    expect(parseVerdictBlock('没有契约块')).toBeNull()
    expect(parseVerdictBlock('```agents-verdict\nlevel: 极高\nblockers: 0\n```')).toBeNull()
  })

  it('assessBrief + 台账：落 verdict.json；appendResearchLedger/readLedgerStats 聚合', () => {
    const root = tmpRoot()
    try {
      writeBrief(root, { id: 'verify-me', title: 't', body: CLAIM_BODY })
      const srcDir = path.join(root, '.agents/orchestrator/research/verify-me/sources')
      fs.mkdirSync(srcDir, { recursive: true })
      fs.writeFileSync(path.join(srcDir, '1.txt'), 'url: https://a.com/rankings\n\n榜单页：DeepSeek V4.1 周下载 56.5T、份额 43.6%、GPT-6 领跑')
      const verdict = assessBrief(root, 'verify-me', { model: 'glm-5.3-flash' })
      expect(verdict.level).toBe('pass')
      expect(JSON.parse(fs.readFileSync(path.join(root, '.agents/orchestrator/research/verify-me/verdict.json'), 'utf8')).brief_id).toBe('verify-me')
      appendResearchLedger(root, { kind: 'l1', brief_id: 'verify-me', model: 'glm-5.3-flash', level: 'pass', hit_rate: 0.8 })
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
  it('research verify：L2 复核合并 L1 落 verdict.json + 记台账 + stats 可读', () => {
    const repo = mkRepo()
    try {
      const root = repo.root
      writeBrief(root, { id: 'verify-me', title: 't', question: 'q', backend: 'mock', body: CLAIM_BODY })
      const srcDir = path.join(root, '.agents', 'orchestrator', 'research', 'verify-me', 'sources')
      fs.mkdirSync(srcDir, { recursive: true })
      fs.writeFileSync(path.join(srcDir, '1.txt'), 'url: https://a.com/rankings\n\n榜单页：DeepSeek V4.1 周下载 56.5T、份额 43.6%、GPT-6 领跑')
      runOrch(repo.root, 'research verify verify-me --backend mock')
      const verdict = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'orchestrator', 'research', 'verify-me', 'verdict.json'), 'utf8'))
      expect(verdict.l2.level).toBe('high')
      expect(verdict.level).toBe('pass')
      const ledger = fs.readFileSync(path.join(root, '.agents', 'orchestrator', 'research', 'ledger.jsonl'), 'utf8')
      expect(ledger).toContain('"kind":"l2"')
      const out = runOrch(repo.root, 'research stats')
      expect(out.stdout).toContain('次判定')
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

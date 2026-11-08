// research.mjs / researcher 会话测试：brief 契约解析与校验、落盘、引用快照、
// prompt 契约、researcher 工具面（buildClaudeArgs web 模式）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseBriefBlock,
  extractCitations,
  validateBriefBody,
  writeBrief,
  readBrief,
  listBriefs,
  snapshotCitations,
  BRIEF_MARKER,
} from '../../.agents/scripts/orchestrator/research.mjs'
import { buildResearchPrompt, CARD_MARKER } from '../../.agents/scripts/orchestrator/prompt.mjs'
import { buildClaudeArgs, RESEARCH_TOOLS } from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'

const BRIEF_BODY = [
  '# 结论',
  'claude CLI 接第三方网关时 WebSearch 常不可用，WebFetch 可用 [1]。',
  '',
  '# 选项对比',
  '- 仅 WebFetch：直取已知来源，覆盖窄但稳。',
  '',
  '# 引用',
  '- 2026-11-08 https://docs.example.com/websearch — 官方工具说明，支撑 [1]',
  '- 2026-11-08 https://blog.example.com/gateway — 实测记录，支撑 [1]',
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

  it('validateBriefBody：五段齐全 + 引用达标；缺段/缺引用给可操作报错', () => {
    expect(() => validateBriefBody(BRIEF_BODY, { minCitations: 1 })).not.toThrow()
    expect(validateBriefBody(BRIEF_BODY, { minCitations: 1 }).citations).toHaveLength(2)
    expect(() => validateBriefBody(BRIEF_BODY, { minCitations: 3 })).toThrow(/引用数不足.*≥3/)
    const noCite = BRIEF_BODY.replace(/^- 2026-11-08 .+$/gm, '')
    expect(() => validateBriefBody(noCite)).toThrow(/无引用的调研不可对账|引用数不足/)
    const noSection = BRIEF_BODY.replace('# 选项对比', '# 其他')
    expect(() => validateBriefBody(noSection)).toThrow(/缺少「# 选项对比」段/)
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

  it('buildClaudeArgs web 模式：只读 + 联网白名单、无 acceptEdits（fail-closed）；readonly/worker 契约不回归', () => {
    const web = buildClaudeArgs({ maxTurns: 25, web: true })
    const webIdx = web.indexOf('--allowedTools')
    expect(web.slice(webIdx + 1, webIdx + 1 + RESEARCH_TOOLS.length)).toEqual(RESEARCH_TOOLS)
    expect(RESEARCH_TOOLS).toContain('WebFetch')
    expect(RESEARCH_TOOLS).toContain('WebSearch')
    expect(RESEARCH_TOOLS).not.toContain('Bash')
    expect(RESEARCH_TOOLS).not.toContain('Edit')
    expect(web).not.toContain('--permission-mode')
    const ro = buildClaudeArgs({ maxTurns: 10, readonly: true })
    expect(ro).toContain('Read')
    expect(ro).not.toContain('WebFetch')
    const worker = buildClaudeArgs({ maxTurns: 10 })
    expect(worker).toContain('--permission-mode')
    expect(worker).toContain('Edit')
  })
})

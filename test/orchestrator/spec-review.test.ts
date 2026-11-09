// spec-review：spec 三件套 agent 分层审查（.agents/conventions/spec-review.md 的机器面）——
// L0 确定性检查（三件套齐全/任务段/依赖 DAG/files_hint/红线扫描/TBD/基线漂移）、
// finding 定位对账（防编造）、服务端裁决重算（加权/null 传染/fabricated 降档/build_ready 矩阵）、
// mock e2e（approve 主路 / P0 rework / 幽灵 finding 剔除 / 无契约块 die）。
// advisory 纪律：审查不改变拆卡权——e2e 断言 review-verdict.json 落盘 + advisory:true。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSpecL0Checks, auditSpecFindings, computeSpecVerdict, parseSpecVerdictBlock, SPECVERDICT_MARKER } from '../../.agents/scripts/orchestrator/spec-review.mjs'
import { writeSpec } from '../../.agents/scripts/orchestrator/spec.mjs'
import { mkRepo, runOrch, tryOrch } from './helpers.js'

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spec-review-'))
}

function fixtureSpec(repoRoot: string, overrides: Partial<{ id: string; tasks: string; design: string; requirements: string }> = {}): string {
  const id = overrides.id ?? 'fixture-spec'
  // 引用的仓库文件须真实存在（files_hint 存在性是 L0 检查项）
  fs.mkdirSync(path.join(repoRoot, 'src', 'util'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'src', 'config'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'src', 'util', 'paths.ts'), '// fixture\n')
  fs.writeFileSync(path.join(repoRoot, 'src', 'config', 'store.ts'), '// fixture\n')
  const tasks =
    overrides.tasks ??
    [
      '## 任务 1: 第一件事',
      '- 目标: 把 A 做了',
      '- 文件: src/util/paths.ts',
      '- 完成条件: 相关测试全绿',
      '- 依赖: 无',
      '',
      '## 任务 2: 第二件事',
      '- 目标: 把 B 做了',
      '- 文件: src/util/paths.ts, src/config/store.ts',
      '- 完成条件: 相关测试全绿',
      '- 依赖: 任务 1',
    ].join('\n')
  writeSpec(repoRoot, {
    id,
    title: 'fixture 规格',
    requirements: overrides.requirements ?? '# 需求\n\n- 作为用户，我希望 A 与 B 就绪，以便测试。',
    design: overrides.design ?? '# 技术设计\n\n现状：src/util/paths.ts 承担路径工具（fixture 假设）。\n\n## 方案\n\n改 paths.ts 与 store.ts。\n',
    tasks,
  })
  return id
}

describe('runSpecL0Checks', () => {
  it('三件套齐全 + 依赖 DAG + 路径存在 → 全 pass', () => {
    const root = tmpRoot()
    const id = fixtureSpec(root)
    const l0 = runSpecL0Checks(root, id)
    expect(l0.ok).toBe(true)
    expect(l0.checks.every((c: { status: string }) => c.status === 'pass')).toBe(true)
    expect(l0.checks.find((c: { name: string }) => c.name === '依赖 DAG')?.detail).toContain('1 条依赖边')
  })

  it('悬空依赖 → fail；成环 → fail', () => {
    const root = tmpRoot()
    const id = fixtureSpec(root, {
      tasks: [
        '## 任务 1: A',
        '- 目标: x',
        '- 文件: src/util/paths.ts',
        '- 完成条件: y',
        '- 依赖: 任务 9',
      ].join('\n'),
    })
    const l0 = runSpecL0Checks(root, id)
    expect(l0.ok).toBe(false)
    expect(l0.checks.some((c: { name: string; status: string }) => c.name === '依赖存在' && c.status === 'fail')).toBe(true)
  })

  it('成环检测', () => {
    const root = tmpRoot()
    const id = fixtureSpec(root, {
      tasks: [
        '## 任务 1: A',
        '- 目标: x',
        '- 文件: src/util/paths.ts',
        '- 完成条件: y',
        '- 依赖: 任务 2',
        '',
        '## 任务 2: B',
        '- 目标: x',
        '- 文件: src/util/paths.ts',
        '- 完成条件: y',
        '- 依赖: 任务 1',
      ].join('\n'),
    })
    const l0 = runSpecL0Checks(root, id)
    expect(l0.ok).toBe(false)
    expect(l0.checks.some((c: { name: string; status: string }) => c.name === '依赖 DAG' && c.status === 'fail')).toBe(true)
  })

  it('files_hint 指向不存在路径 → warn（拟新建文件合法，裁决交 L2）', () => {
    const root = tmpRoot()
    const id = fixtureSpec(root, {
      tasks: [
        '## 任务 1: A',
        '- 目标: x',
        '- 文件: src/no-such-dir/ghost.ts',
        '- 完成条件: y',
        '- 依赖: 无',
      ].join('\n'),
    })
    const l0 = runSpecL0Checks(root, id)
    expect(l0.ok).toBe(true)
    expect(l0.checks.find((c: { name: string; status: string }) => c.name === 'files_hint 存在')?.status).toBe('warn')
    expect(l0.checks.find((c: { name: string }) => c.name === 'files_hint 存在')?.detail).toContain('src/no-such-dir/ghost.ts')
  })

  it('红线关键词命中收集 + TBD 计数（命中≠违规，待 L2 裁决）', () => {
    const root = tmpRoot()
    const id = fixtureSpec(root, {
      design: '# 技术设计\n\n绝不触碰 8687 生产端口；网关地址不得写死 ~/.modeldock。\n\n## 方案\n\n细节待定。',
    })
    const l0 = runSpecL0Checks(root, id)
    expect(l0.redlineHits.map((h: { name: string }) => h.name)).toEqual(expect.arrayContaining(['protectedPorts', '硬编码-家目录']))
    expect(l0.tbdCount).toBeGreaterThanOrEqual(1)
    expect(l0.ok).toBe(true) // 关键词命中不构成结构 fail
  })

  it('基线漂移：HEAD 提交晚于 spec 落盘 → warn（mkRepo 有 init commit，回拨 created_at 构造）', () => {
    const repo = mkRepo()
    try {
      const id = fixtureSpec(repo.root)
      const metaPath = path.join(repo.root, '.agents', 'orchestrator', 'specs', id, 'meta.json')
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      meta.created_at = '2000-01-01T00:00:00'
      fs.writeFileSync(metaPath, JSON.stringify(meta))
      const l0 = runSpecL0Checks(repo.root, id)
      expect(l0.baselineDrift).toBe(true)
      expect(l0.checks.find((c: { name: string }) => c.name === '基线漂移')?.status).toBe('warn')
    } finally {
      repo.cleanup()
    }
  })
})

describe('auditSpecFindings（防编造定位对账）', () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'src.ts'), '行一\n行二 export const A = 1\n')

  it('真实文件 + 可逐字定位 claim → audited', () => {
    const { audited, fabricated } = auditSpecFindings(root, [{ severity: 'P1', file: 'src.ts', section: '第 2 行', claim: 'export const A = 1', why: 'x', fix: 'y' }])
    expect(audited).toHaveLength(1)
    expect(fabricated).toHaveLength(0)
  })

  it('claim 不在文中 → fabricated；幽灵文件 → fabricated', () => {
    const { fabricated } = auditSpecFindings(root, [
      { severity: 'P1', file: 'src.ts', section: '', claim: '这句话根本不在文件里', why: 'x', fix: 'y' },
      { severity: 'P2', file: 'no-such/ghost.md', section: '第 1 行', claim: '', why: 'x', fix: 'y' },
    ])
    expect(fabricated).toHaveLength(2)
    expect(fabricated[0].fabricated_reason).toContain('逐字定位')
    expect(fabricated[1].fabricated_reason).toContain('不存在')
  })

  it('行号越界 → fabricated；越出仓库路径 → fabricated', () => {
    const root = tmpRoot()
    fs.writeFileSync(path.join(root, 'src.ts'), '行一\n行二 export const A = 1\n')
    const outsideDir = `${root}-outside`
    fs.mkdirSync(outsideDir, { recursive: true })
    fs.writeFileSync(path.join(outsideDir, 'outside.md'), 'x')
    const relOutside = path.relative(root, path.join(outsideDir, 'outside.md'))
    const { fabricated } = auditSpecFindings(root, [
      { severity: 'P2', file: 'src.ts', section: '第 999 行', claim: '', why: 'x', fix: 'y' },
      { severity: 'P2', file: relOutside, section: '第 1 行', claim: '', why: 'x', fix: 'y' },
    ])
    expect(fabricated).toHaveLength(2)
    expect(fabricated[0].fabricated_reason).toContain('越界')
    expect(fabricated[1].fabricated_reason).toContain('越出仓库')
  })
})

describe('computeSpecVerdict（服务端权威裁决）', () => {
  const DIMS = { completeness: 85, unambiguity: 80, consistency: 85, testability: 85, feasibility: 90 }

  it('加权聚合：85/80/85/85/90 → 8450/100=84.5 → round 85（approve 带）', () => {
    const v = computeSpecVerdict({ dimensions: DIMS, findings: [], gates: { redlines: 'pass' }, fabricatedCount: 0 })
    expect(v.overall).toBe(85)
    expect(v.build_ready).toBe('approve_to_build')
  })

  it('任一维度 null → overall null + undetermined（null 传染）', () => {
    const v = computeSpecVerdict({ dimensions: { ...DIMS, consistency: null }, findings: [], gates: { redlines: 'pass' }, fabricatedCount: 0 })
    expect(v.overall).toBeNull()
    expect(v.build_ready).toBe('undetermined')
  })

  it('P0≥2 → rework（overall 高也压不住）', () => {
    const v = computeSpecVerdict({ dimensions: DIMS, findings: [{ severity: 'P0' }, { severity: 'P0' }], gates: { redlines: 'pass' }, fabricatedCount: 0 })
    expect(v.build_ready).toBe('rework')
  })

  it('红线 fail → blocked（一票）', () => {
    const v = computeSpecVerdict({ dimensions: DIMS, findings: [], gates: { redlines: 'fail' }, fabricatedCount: 0 })
    expect(v.build_ready).toBe('blocked')
  })

  it('fabricated>0 → overall-15 降档（85-15=70 → needs_revision）', () => {
    const v = computeSpecVerdict({ dimensions: DIMS, findings: [], gates: { redlines: 'pass' }, fabricatedCount: 1 })
    expect(v.overall).toBe(70)
    expect(v.build_ready).toBe('needs_revision')
  })
})

describe('parseSpecVerdictBlock', () => {
  it('合规 JSON 契约块解析；结构非法返回 null', () => {
    const good = `前言\n\n\`\`\`${SPECVERDICT_MARKER}\n${JSON.stringify({ spec: 'x', gates: { redlines: 'pass', notes: [] }, dimensions: { completeness: 80, unambiguity: 80, consistency: 80, testability: 80, feasibility: 80 }, findings: [{ severity: 'P2', file: 'a.md', section: '§1', claim: '', why: 'w', fix: 'f' }], usage: { build_ready: 'approve_to_build' }, advisory: true })}\n\`\`\`\n`
    expect(parseSpecVerdictBlock(good)?.dimensions.completeness).toBe(80)
    expect(parseSpecVerdictBlock('没有契约块')).toBeNull()
    const bad = `\`\`\`${SPECVERDICT_MARKER}\n${JSON.stringify({ dimensions: { completeness: 999 }, findings: [] })}\n\`\`\``
    expect(parseSpecVerdictBlock(bad)).toBeNull() // 维度越界
  })
})

describe('spec review e2e（mock 后端）', () => {
  it('主路：L0 全绿 + mock 审查 → review-verdict.json 落盘 + advisory + 台账', () => {
    const repo = mkRepo()
    try {
      const id = fixtureSpec(repo.root)
      const out = runOrch(repo.root, `spec review ${id} --backend mock`)
      expect(out.stdout).toContain('spec 审查')
      expect(out.stdout).toContain('approve_to_build')
      const verdict = JSON.parse(fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'specs', id, 'review-verdict.json'), 'utf8'))
      expect(verdict.schema).toBe('spec-verdict/1')
      expect(verdict.advisory).toBe(true)
      expect(verdict.usage.build_ready).toBe('approve_to_build')
      expect(verdict.findings).toHaveLength(1)
      // L3 台账（复用 research ledger，kind=spec-review）：overall 85（1 条 P2 不降档）
      const ledger = path.join(repo.root, '.agents', 'orchestrator', 'research', 'ledger.jsonl')
      const entry = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e: { kind?: string }) => e.kind === 'spec-review')
      expect(entry?.spec_id).toBe(id)
      expect(entry?.overall).toBe(85)
    } finally {
      repo.cleanup()
    }
  })

  it('P0×2 → rework；幽灵 finding 被剔除并降档', () => {
    const repo = mkRepo()
    try {
      const id = fixtureSpec(repo.root)
      const out = runOrch(repo.root, `spec review ${id} --backend mock`, { ORCH_MOCK_SPEC_REVIEW_BLOCKERS: '2', ORCH_MOCK_SPEC_REVIEW_FABRICATED: '1' })
      expect(out.stdout).toContain('rework')
      expect(out.stdout).toContain('定位对账失败')
      const verdict = JSON.parse(fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'specs', id, 'review-verdict.json'), 'utf8'))
      expect(verdict.usage.build_ready).toBe('rework')
      expect(verdict.fabricatedFindings).toHaveLength(1)
      expect(verdict.findings).toHaveLength(2)
      // overall 85-15(fabricated 降档)=70；p0=2 → rework
      expect(verdict.overall).toBe(70)
    } finally {
      repo.cleanup()
    }
  })

  it('L0 结构性 fail（悬空依赖）直接 die，不烧 L2 会话', () => {
    const repo = mkRepo()
    try {
      const id = fixtureSpec(repo.root, {
        tasks: [
          '## 任务 1: A',
          '- 目标: x',
          '- 文件: src/util/paths.ts',
          '- 完成条件: y',
          '- 依赖: 任务 9',
        ].join('\n'),
      })
      const out = tryOrch(repo.root, `spec review ${id} --backend mock`)
      expect(out.status).toBe(1)
      expect(out.stderr).toContain('L0 结构性检查未过')
    } finally {
      repo.cleanup()
    }
  })

  it('无契约块 → 2 次重试后 die', () => {
    const repo = mkRepo()
    try {
      const id = fixtureSpec(repo.root)
      const out = tryOrch(repo.root, `spec review ${id} --backend mock`, { ORCH_MOCK_SPEC_REVIEW_INVALID: '1' })
      expect(out.status).toBe(1)
      expect(out.stderr).toContain('未产出合规 spec-verdict')
    } finally {
      repo.cleanup()
    }
  })
})

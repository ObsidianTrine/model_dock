import { describe, expect, it } from 'vitest'
import { buildRules, classifyRisk, matchPattern } from '../scripts/pr-risk-tier.mjs'

describe('matchPattern', () => {
  it('目录 /** 前缀匹配（不吞同级近名目录）', () => {
    expect(matchPattern('docs/**', 'docs/usage.md')).toBe(true)
    expect(matchPattern('docs/**', 'docsx/usage.md')).toBe(false)
    expect(matchPattern('.github/workflows/**', '.github/workflows/test.yml')).toBe(true)
  })

  it('目录尾斜杠（.agents/workflow.json releasePaths 形态）按前缀匹配', () => {
    expect(matchPattern('.github/workflows/', '.github/workflows/test.yml')).toBe(true)
    expect(matchPattern('.github/workflows/', '.github/workflow-x/y.yml')).toBe(false)
  })

  it('*.ext 按扩展名匹配任意层级', () => {
    expect(matchPattern('*.md', 'README.md')).toBe(true)
    expect(matchPattern('*.md', 'docs/usage.md')).toBe(true)
    expect(matchPattern('*.md', 'src/cli.ts')).toBe(false)
  })

  it('无通配符为精确路径匹配', () => {
    expect(matchPattern('src/cli.ts', 'src/cli.ts')).toBe(true)
    expect(matchPattern('src/cli.ts', 'src/cli/basic.ts')).toBe(false)
  })

  it('Windows 反斜杠路径归一后匹配', () => {
    expect(matchPattern('.github/workflows/**', '.github\\workflows\\test.yml')).toBe(true)
    expect(matchPattern('src\\cli.ts', 'src/cli.ts')).toBe(true)
  })
})

describe('classifyRisk', () => {
  const rules = buildRules({
    corePaths: ['src/cli.ts', 'src/config/secrets.ts'],
    releasePaths: ['.github/workflows/', 'scripts/build-sea.mjs']
  })

  it('命中 corePaths / releasePaths → 高风险，且给出规则与命中文件', () => {
    const r = classifyRisk(['src/config/secrets.ts', 'README.md'], rules)
    expect(r.tier).toBe('high')
    const high = r.hits.filter((h: { tier: string; files: string[] }) => h.tier === 'high')
    expect(high.some((h: { files: string[] }) => h.files.includes('src/config/secrets.ts'))).toBe(true)
    expect(r.unmatched).toEqual([])
  })

  it('纯文档 → 低风险', () => {
    const r = classifyRisk(['README.md', 'docs/ai-review-system.md', 'CHANGELOG.md'], rules)
    expect(r.tier).toBe('low')
  })

  it('普通源码（未命中任何规则）→ 中风险', () => {
    const r = classifyRisk(['src/util/diff.ts', 'test/store.test.ts'], rules)
    expect(r.tier).toBe('medium')
    expect(r.unmatched).toEqual(['src/util/diff.ts', 'test/store.test.ts'])
  })

  it('文档 + 高风险混合 → 取最高档，文档不拉低等级', () => {
    const r = classifyRisk(['docs/usage.md', '.github/workflows/test.yml'], rules)
    expect(r.tier).toBe('high')
  })

  it('文档 + 普通源码混合 → 中风险（未覆盖面不默认放行）', () => {
    const r = classifyRisk(['docs/usage.md', 'src/util/diff.ts'], rules)
    expect(r.tier).toBe('medium')
  })

  it('空列表 → 低风险（调用方应避免传空，见 CLI 的空列表提示）', () => {
    const r = classifyRisk([], rules)
    expect(r.tier).toBe('low')
  })

  it('脚本补充规则：安装器与密钥注入面 → 高风险', () => {
    const full = buildRules({ corePaths: [], releasePaths: [] })
    expect(classifyRisk(['scripts/installer.iss'], full).tier).toBe('high')
    expect(classifyRisk(['scripts/inno/setup.iss'], full).tier).toBe('high')
    expect(classifyRisk(['src/gateway/proxy.ts'], full).tier).toBe('high')
  })
})

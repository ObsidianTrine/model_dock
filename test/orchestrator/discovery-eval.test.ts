// discovery-eval.mjs 纯函数测试：案例 schema 校验与确定性评分（dry-run 语义零消耗）。

import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { loadCases, gradeCase } from '../../.agents/scripts/discovery-eval.mjs'

const REPO = process.cwd() // vitest cwd = worktree 仓库根

describe('discovery-eval > 案例与评分', () => {
  it('loadCases：真实评测集 schema 通过，字段口径正确', () => {
    const cases = loadCases(REPO)
    expect(cases.length).toBeGreaterThanOrEqual(2)
    for (const c of cases) {
      expect(c.id).toBeTruthy()
      expect(c.question).toBeTruthy()
      expect(c.mustFind.length).toBeGreaterThan(0)
      expect(c.mustFindAny).toBeGreaterThan(0)
    }
    // --cases 过滤
    const one = loadCases(REPO, ['headless-websearch-fallback'])
    expect(one).toHaveLength(1)
  })

  it('loadCases：三道真实事故考题在列（总数 ≥5），schema 校验通过', () => {
    const cases = loadCases(REPO)
    expect(cases.length).toBeGreaterThanOrEqual(5)
    const byId = new Map(cases.map((c) => [c.id, c]))
    // 事故①：训练先验冒充检索现状——双口径现状关键词 + 当日引用 gate 兜底
    const stale = byId.get('stale-priors-vs-current-landscape')
    expect(stale).toBeTruthy()
    expect(stale!.mustFind).toEqual(['openrouter', 'jetbrains'])
    expect(stale!.mustFindAny).toBe(2)
    expect(stale!.minCitations).toBe(1)
    // 事故②：一手来源 vs 二手转述——双源交叉（引用 ≥2）
    const primary = byId.get('primary-source-vs-secondhand')
    expect(primary).toBeTruthy()
    expect(primary!.mustFind).toEqual(['官方', 'docs'])
    expect(primary!.minCitations).toBe(2)
    // 事故②变体：伪造/错配仓库 URL——多仓库核实（引用 ≥3）+ github.com 必现
    const fab = byId.get('fabricated-repo-urls')
    expect(fab).toBeTruthy()
    expect(fab!.mustFind).toContain('github.com')
    expect(fab!.minCitations).toBe(3)
  })

  it('loadCases：坏 schema 给可操作报错', () => {
    expect(() => loadCases(path.join(REPO, 'test', 'fixtures', 'no-such-dir-xyz'))).toThrow(/不存在/)
  })

  it('gradeCase：引用达标 + 关键词命中 → PASS；缺引用/命中不足 → FAIL 带原因', () => {
    const c = { id: 'x', question: 'q', goals: '', minCitations: 1, mustFind: ['websearch', 'webfetch'], mustFindAny: 2 }
    const good = [
      '# 结论',
      'WebSearch 与 WebFetch 的取舍 [1]。',
      '',
      '# 选项对比',
      '- 仅 WebFetch：稳。',
      '',
      '# 引用',
      '- 2026-11-08 https://a.com — 说明 websearch 与 webfetch',
      '',
      '# 建议',
      '先 selftest。',
      '',
      '# 罗盘对齐',
      '对齐舰队可调研目标。',
    ].join('\n')
    expect(gradeCase(c, good, { today: '2026-11-08' }).pass).toBe(true)
    expect(gradeCase(c, good, { today: '2026-11-08' }).citations).toBe(1)
    const noCite = good.replace(/^- 2026-11-08 .+$/m, '')
    expect(gradeCase(c, noCite, { today: '2026-11-08' }).pass).toBe(false)
    expect(gradeCase(c, noCite, { today: '2026-11-08' }).reasons[0]).toMatch(/引用|段/)
    // 陈旧日期 = 编造防线（gate 与 validateBriefBody 同口径）
    expect(gradeCase(c, good, { today: '2027-01-01' }).pass).toBe(false)
    expect(gradeCase(c, good, { today: '2027-01-01' }).reasons[0]).toMatch(/引用访问日期陈旧/)
    const missKey = good.replace('WebSearch 与 WebFetch 的取舍 [1]。', '别的结论。').replace('说明 websearch 与 webfetch', '依据')
    expect(gradeCase(c, missKey, { today: '2026-11-08' }).pass).toBe(false)
    expect(gradeCase(c, missKey, { today: '2026-11-08' }).reasons[0]).toMatch(/关键词命中/)
    expect(gradeCase(c, null).pass).toBe(false)
  })

  it('dry-run CLI：真实评测集零消耗列出案例（退出码 0）', () => {
    const out = execSync(`node "${path.join(REPO, '.agents', 'scripts', 'discovery-eval.mjs')}" --list`, {
      cwd: REPO,
      encoding: 'utf8',
    })
    expect(out).toContain('dry-run')
    expect(out).toContain('headless-websearch-fallback')
  })
})

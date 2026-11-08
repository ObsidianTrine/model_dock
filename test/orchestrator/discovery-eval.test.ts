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
    expect(gradeCase(c, good).pass).toBe(true)
    expect(gradeCase(c, good).citations).toBe(1)
    const noCite = good.replace(/^- 2026-11-08 .+$/m, '')
    expect(gradeCase(c, noCite).pass).toBe(false)
    expect(gradeCase(c, noCite).reasons[0]).toMatch(/引用|段/)
    const missKey = good.replace('WebSearch 与 WebFetch 的取舍 [1]。', '别的结论。').replace('说明 websearch 与 webfetch', '依据')
    expect(gradeCase(c, missKey).pass).toBe(false)
    expect(gradeCase(c, missKey).reasons[0]).toMatch(/关键词命中/)
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

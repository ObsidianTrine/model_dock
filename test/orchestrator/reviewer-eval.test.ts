import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildEvalPrompt,
  buildMaterial,
  extractDiff,
  filterCases,
  gradeOutput,
  loadCases,
  parseCaseHeader,
  parseExpect,
  reviewDisciplineText,
} from '../../.agents/scripts/reviewer-eval.mjs'

const ROOT = process.cwd() // vitest cwd = 仓库根（worktree 内跑即 worktree 根）
const CASES_DIR = path.join(ROOT, '.agents', 'review-evals', 'reviewer', 'cases')
const SCRIPT = path.join(ROOT, '.agents', 'scripts', 'reviewer-eval.mjs')

function reviewerEvalDirs(): number {
  const logs = path.join(ROOT, '.agents', 'orchestrator', 'logs')
  if (!fs.existsSync(logs)) return 0
  return fs.readdirSync(logs).filter((d) => d.startsWith('reviewer-eval-')).length
}

// ---------------------------------------------------------------- 案例格式校验（真实仓库集）

describe('reviewer-eval 评测集格式', () => {
  const cases = loadCases(CASES_DIR)

  it('案例数量达标（≥8，含 ≥1 个 clean 负样本）且 id 唯一', () => {
    expect(cases.length).toBeGreaterThanOrEqual(8)
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
    expect(cases.filter((c) => c.expect.clean).length).toBeGreaterThanOrEqual(1)
  })

  it('目录无孤儿文件（每个文件都属于某个 <id>.diff.md / <id>.expect.md 对）', () => {
    const files = fs.readdirSync(CASES_DIR)
    const ids = new Set(cases.map((c) => c.id))
    for (const f of files) {
      const m = /^(.+)\.(diff|expect)\.md$/.exec(f)
      expect(m, `孤儿文件：${f}`).not.toBeNull()
      expect(ids.has(m![1]), `孤儿文件：${f}`).toBe(true)
    }
  })

  it('每个案例头部元信息齐全（考点/goal/acceptance/files_hint）且 diff 围栏非空', () => {
    for (const c of cases) {
      expect(c.header.kaodian.trim(), `${c.id} 缺考点注释`).not.toBe('')
      expect(c.header.goal.trim(), `${c.id} 缺 goal`).not.toBe('')
      expect(c.header.acceptance.trim(), `${c.id} 缺 acceptance`).not.toBe('')
      expect(c.header.filesHint.trim(), `${c.id} 缺 files_hint`).not.toBe('')
      expect(c.diffText.trim(), `${c.id} diff 为空`).not.toBe('')
      expect(c.diffText).toContain('diff --git')
    }
  })

  it('非负样本 expect 至少 1 个应抓阻塞点；clean 负样本应抓为空', () => {
    for (const c of cases) {
      if (c.expect.clean) {
        expect(c.expect.blockers, `${c.id} 是 clean 负样本，应抓必须为空`).toHaveLength(0)
      } else {
        expect(c.expect.blockers.length, `${c.id} 应抓为空（非负样本必须有期望阻塞点）`).toBeGreaterThanOrEqual(1)
      }
      for (const b of c.expect.blockers) {
        expect(['P0', 'P1', 'P2']).toContain(b.level)
        expect(b.keywords.length, `${c.id} 阻塞点关键词为空`).toBeGreaterThanOrEqual(1)
        for (const k of b.keywords) expect(k, `${c.id} 关键词含空白：${k}`).not.toMatch(/\s/)
      }
      for (const n of c.expect.noise) {
        for (const k of n.keywords) expect(k, `${c.id} 噪音关键词含空白：${k}`).not.toMatch(/\s/)
      }
    }
  })

  it('考点覆盖任务要求的问题域（红线/越界/平台/i18n/假绿/负样本）', () => {
    const all = cases.map((c) => c.id)
    expect(all).toContain('port-redline') // 端口 8687/8890
    expect(all).toContain('scope-drift') // 越界改动
    expect(all).toContain('hardcoded-home-path') // 硬编码路径绕过 paths.ts
    expect(all).toContain('bypass-atomicwrite') // 绕过 atomicWrite
    expect(all).toContain('import-meta-sea') // import.meta 误用
    expect(all).toContain('windows-sep-signal') // Windows 不兼容
    expect(all).toContain('i18n-single-lang') // i18n 单语违反
    expect(all).toContain('test-false-green') // 测试断言假绿
    expect(all).toContain('clean-deadcode-removal') // 干净负样本
  })
})

// ---------------------------------------------------------------- 解析与评分（纯函数）

describe('reviewer-eval 解析与评分', () => {
  it('parseExpect：clean 缺省 false，应抓/噪音/说明行分流正确', () => {
    const e = parseExpect(
      ['<!-- 考点：x -->', '', '# 期望判定', '', 'clean: true', '', '## 应抓（阻塞点）', '', '（负样本：无）', '', '## 不应抓（噪音）', '- 关键词: 缩进|分号 — 风格', '- 自由说明不参与评分'].join('\n'),
    )
    expect(e.clean).toBe(true)
    expect(e.blockers).toHaveLength(0)
    expect(e.noise).toEqual([{ keywords: ['缩进', '分号'], desc: '风格' }])
    expect(e.notes).toHaveLength(1)
  })

  it('parseExpect：应抓行带级别与说明；全角冒号与 em-dash 容错', () => {
    const e = parseExpect(['## 应抓（阻塞点）', '- [P0] 关键词：8687|8890 — 一票否决'].join('\n'))
    expect(e.blockers[0]).toMatchObject({ level: 'P0', keywords: ['8687', '8890'], desc: '一票否决' })
  })

  it('gradeOutput：命中/漏报/噪音误报/超额阻塞计数', () => {
    const expectObj = {
      clean: false,
      blockers: [
        { level: 'P0', keywords: ['8687'], desc: '端口' },
        { level: 'P1', keywords: ['0600'], desc: '权限' },
      ],
      noise: [{ keywords: ['魔法数字'], desc: '建议级' }],
      notes: [],
    }
    const out = '发现 2 个问题：1) 监听 8687 生产端口；2) 老代码有魔法数字。\nREVIEW_SUMMARY: blockers=2 suggestions=0 notes=0'
    const g = gradeOutput(expectObj, out)
    expect(g.status).toBe('partial_miss')
    expect(g.hits.map((h) => h.desc)).toEqual(['端口'])
    expect(g.misses.map((m) => m.desc)).toEqual(['权限'])
    expect(g.noiseHits.map((n) => n.desc)).toEqual(['建议级'])
    expect(g.excessBlockers).toBe(1) // blockers=2 但只命中 1 个期望点
    expect(g.contractMissing).toBe(false)
  })

  it('gradeOutput：全中且无噪音 = pass；全漏 = miss_all', () => {
    const expectObj = { clean: false, blockers: [{ level: 'P0', keywords: ['import.meta'], desc: 'sea' }], noise: [], notes: [] }
    expect(gradeOutput(expectObj, '使用 import.meta.url 违反红线\nREVIEW_SUMMARY: blockers=1 suggestions=0 notes=0').status).toBe('pass')
    expect(gradeOutput(expectObj, '改动没问题\nREVIEW_SUMMARY: blockers=0 suggestions=0 notes=0').status).toBe('miss_all')
  })

  it('gradeOutput：clean 负样本报阻塞（契约行或「发现 N 个问题」）即误报', () => {
    const clean = { clean: true, blockers: [], noise: [], notes: [] }
    expect(gradeOutput(clean, '没问题\nREVIEW_SUMMARY: blockers=0 suggestions=1 notes=0').status).toBe('pass')
    expect(gradeOutput(clean, '发现 1 个问题：xxx\nREVIEW_SUMMARY: blockers=1 suggestions=0 notes=0').status).toBe('fp')
    expect(gradeOutput(clean, '发现 2 个问题：xxx（没写契约行）').status).toBe('fp')
  })

  it('gradeOutput：缺 REVIEW_SUMMARY 契约行要标记（审查者没守输出契约）', () => {
    const expectObj = { clean: false, blockers: [{ level: 'P0', keywords: ['8687'], desc: '端口' }], noise: [], notes: [] }
    const g = gradeOutput(expectObj, '发现 1 个问题：8687 出现在测试里')
    expect(g.contractMissing).toBe(true)
    expect(g.status).toBe('pass') // 关键词命中仍计命中，契约缺失单列
  })

  it('extractDiff / parseCaseHeader：考点注释不进 diff 正文（防泄答案）', () => {
    const md = fs.readFileSync(path.join(CASES_DIR, 'port-redline.diff.md'), 'utf8')
    const diff = extractDiff(md)
    expect(diff).not.toContain('考点')
    expect(diff).toContain('8687')
    const header = parseCaseHeader(md)
    expect(header.kaodian).toContain('端口')
    expect(header.filesHint).toContain('test/gateway')
  })

  it('filterCases：未知 id 报错并列出可用清单（防打错字静默全烧）', () => {
    const all = loadCases(CASES_DIR)
    expect(() => filterCases(all, 'no-such-case')).toThrowError(/no-such-case/)
    expect(filterCases(all, `${all[0].id}, ${all[1].id} `).map((c) => c.id)).toEqual([all[0].id, all[1].id])
  })
})

// ---------------------------------------------------------------- prompt / 材料组装

describe('reviewer-eval 审查输入组装', () => {
  it('REVIEW.md 摘要截 8000 字符（对齐 orchestrator 口径）并附截断说明', () => {
    const longRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-eval-'))
    try {
      fs.writeFileSync(path.join(longRoot, 'REVIEW.md'), 'x'.repeat(9000))
      const d = reviewDisciplineText(longRoot)
      expect(d.length).toBeLessThan(9000)
      expect(d).toContain('已截断')
      fs.writeFileSync(path.join(longRoot, 'REVIEW.md'), '短纪律')
      expect(reviewDisciplineText(longRoot)).toBe('短纪律')
      expect(reviewDisciplineText(path.join(longRoot, 'no-such-dir'))).toBe('')
    } finally {
      fs.rmSync(longRoot, { recursive: true, force: true })
    }
  })

  it('buildMaterial / buildEvalPrompt：材料含纪律+diff；prompt 含文件引用与契约行且远小于 30k', () => {
    const material = buildMaterial('红线清单', 'diff --git a/x b/x\n+bad\n')
    expect(material).toContain('红线清单')
    expect(material).toContain('diff --git a/x b/x')
    const prompt = buildEvalPrompt({ goal: '修 bug', acceptance: '测试全绿', filesHint: 'src/x/**', materialPath: '/tmp/material.md' })
    expect(prompt).toContain('/tmp/material.md')
    expect(prompt).toContain('src/x/**')
    expect(prompt).toContain('REVIEW_SUMMARY: blockers=')
    expect(prompt).toContain('阻塞/建议/提示')
    expect(prompt.length).toBeLessThan(30_000) // zcode headless argv 上限防线
  })
})

// ---------------------------------------------------------------- 子进程链路（不 spawn 任何 LLM 后端）

describe('reviewer-eval CLI 链路', () => {
  it('默认 dry-run 与 --list 零 spawn：退出 0、列出全部案例、不创建输出目录', () => {
    const before = reviewerEvalDirs()
    for (const args of [[], ['--list']]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
      expect(r.status, r.stderr).toBe(0)
      for (const c of loadCases(CASES_DIR)) expect(r.stdout).toContain(c.id)
      if (args.length === 0) expect(r.stdout).toContain('零消耗')
      else expect(r.stdout).toContain('应抓')
    }
    expect(reviewerEvalDirs()).toBe(before) // 没有输出目录被创建 = 没有 spawn 发生
  })

  it('--run 缺 --backend 快速失败（真跑必须显式指定，防误触烧钱）', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--run'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
    expect(r.status).toBe(1)
    expect(`${r.stderr}${r.stdout}`).toContain('必须显式')
  })

  it('--grade 对假造输出静态评分：命中/漏报/误报计数与 score.json 落盘', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-eval-grade-'))
    try {
      fs.writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify({
          version: 1,
          startedAt: '2026-11-03T00:00:00Z',
          backend: 'claude-headless',
          model: 'test-model',
          maxTurns: 30,
          timeoutMinutes: 10,
          repoRoot: ROOT,
          casesDir: CASES_DIR,
          cases: [
            { id: 'port-redline', status: 'ok', goal: 'g', filesHint: 'h', clean: false, blockers: 1 },
            { id: 'clean-deadcode-removal', status: 'ok', goal: 'g', filesHint: 'h', clean: true, blockers: 0 },
            { id: 'scope-drift', status: 'failed', error: '模拟超时' },
          ],
        }),
      )
      fs.writeFileSync(
        path.join(dir, 'port-redline.expect.json'),
        JSON.stringify({ id: 'port-redline', header: { goal: 'g', kaodian: 'k', acceptance: 'a', filesHint: 'h' }, expect: { clean: false, blockers: [{ level: 'P0', keywords: ['8687'], desc: '端口' }], noise: [{ keywords: ['缩进'], desc: '风格' }], notes: [] } }),
      )
      // 审出端口 + 顺带报了噪音（缩进）→ 命中 1 + 误报 1
      fs.writeFileSync(path.join(dir, 'port-redline.output.txt'), '发现 1 个问题：测试监听 8687。\nREVIEW_SUMMARY: blockers=1 suggestions=0 notes=0\n顺带：缩进不规范。')
      fs.writeFileSync(
        path.join(dir, 'clean-deadcode-removal.expect.json'),
        JSON.stringify({ id: 'clean-deadcode-removal', header: { goal: 'g', kaodian: 'k', acceptance: 'a', filesHint: 'h' }, expect: { clean: true, blockers: [], noise: [], notes: [] } }),
      )
      fs.writeFileSync(path.join(dir, 'clean-deadcode-removal.output.txt'), '改动干净。\nREVIEW_SUMMARY: blockers=0 suggestions=0 notes=0')
      const r = spawnSync(process.execPath, [SCRIPT, '--grade', dir], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
      expect(r.status, r.stderr).toBe(0)
      const score = JSON.parse(fs.readFileSync(path.join(dir, 'score.json'), 'utf8'))
      expect(score.summary.cases).toBe(3)
      expect(score.summary.pass).toBe(1) // clean 负样本未报阻塞
      expect(score.summary.failed).toBe(1) // scope-drift 模拟超时
      expect(score.summary.missedBlockers).toBe(0)
      expect(score.summary.falsePositives).toBe(1) // port-redline 噪音命中（缩进）
      const portRow = score.rows.find((x: { id: string }) => x.id === 'port-redline')
      expect(portRow.status).toBe('fp_noise')
      expect(portRow.noiseHits[0].matched).toContain('缩进')
      expect(fs.existsSync(path.join(dir, 'report.md'))).toBe(true)
      expect(r.stdout).toContain('误报')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

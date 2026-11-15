import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFixupPrompt, buildPromptFileRefBody, buildReviewerPrompt, buildReviewRetryPrompt, buildWorkerPrompt, checkRecitation, parseAcceptanceDeclared, parseResultBlock, parseReviewVerdict, RESULT_MARKER } from '../../.agents/scripts/orchestrator/prompt.mjs'
import { loadCard } from '../../.agents/scripts/orchestrator/queue.mjs'
import { cardText } from './helpers.js'

const card = () => loadCard(cardText(), 'card.md')

function ctx(repoRoot: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prompt-'))
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 测试 AGENTS\n\n端口红线。\n')
  fs.mkdirSync(path.join(dir, 'playbooks'))
  fs.writeFileSync(path.join(dir, 'playbooks', 'feature-branch.md'), '# playbook 全文\n')
  return { repoRoot: dir, worktreePath: path.join(dir, 'worktree'), playbooksDir: path.join(dir, 'playbooks') }
}

describe('orchestrator prompt > worker prompt 五层组装', () => {
  it('系统层/流程层/任务层/环境层/契约层全部注入', () => {
    const c = ctx(os.tmpdir())
    const p = buildWorkerPrompt(card(), c)
    expect(p).toContain('# 测试 AGENTS') // 系统层
    expect(p).toContain('# playbook 全文') // 流程层
    expect(p).toContain('测试任务目标') // 任务层-目标
    expect(p).toContain('验收标准') // 任务层-验收
    expect(p).toContain(c.worktreePath) // 环境层
    expect(p).toContain('所有编辑必须使用此目录下的绝对路径')
    expect(p).toContain('```' + RESULT_MARKER) // 契约层
    expect(p).toContain('status: done | stuck')
  })

  it('缺失 playbook 给明确报错', () => {
    const c = ctx(os.tmpdir())
    const bad = { meta: { ...card().meta, workflows: ['no-such-playbook'] }, body: card().body }
    expect(() => buildWorkerPrompt(bad as never, c)).toThrowError(/no-such-playbook/)
  })
})

describe('orchestrator prompt > 契约块解析', () => {
  it('标准块：done + files_changed JSON 数组', () => {
    const out = parseResultBlock(`前面的话\n\n\`\`\`${RESULT_MARKER}\nstatus: done\nsummary: 修好了\nfiles_changed: ["src/a.ts", "test/a.test.ts"]\ntests: pass\nnotes_updated: true\n\`\`\`\n`)
    expect(out).toMatchObject({ status: 'done', summary: '修好了', tests: 'pass', notes_updated: true })
    expect(out?.files_changed).toEqual(['src/a.ts', 'test/a.test.ts'])
  })

  it('stuck 块与容错逗号数组', () => {
    const out = parseResultBlock('```' + RESULT_MARKER + '\nstatus: stuck\nsummary: 缺信息\nfiles_changed: src/a.ts, test/b.ts\ntests: fail\nnotes_updated: false\n```')
    expect(out?.status).toBe('stuck')
    expect(out?.files_changed).toEqual(['src/a.ts', 'test/b.ts'])
    expect(out?.notes_updated).toBe(false)
  })

  it('无结果块返回 null', () => {
    expect(parseResultBlock('worker 忘了输出契约块')).toBeNull()
  })
})

describe('orchestrator prompt > 审查', () => {
  it('reviewer prompt 含目标/红线（reviewNotes 注入）/REVIEW_SUMMARY 汇总行要求与 diff', () => {
    const p = buildReviewerPrompt(card(), 'diff --git a/x b/x', '端口 8687/8890、native addon')
    expect(p).toContain('测试任务目标')
    expect(p).toContain('8687/8890')
    expect(p).toContain('native addon')
    expect(p).toContain('REVIEW_SUMMARY: blockers=')
    expect(p).toContain('diff --git')
  })

  it('reviewNotes 缺省时 prompt 不含红线括注', () => {
    const p = buildReviewerPrompt(card(), 'diff --git a/x b/x')
    expect(p).toContain('破坏项目红线？')
    expect(p).not.toContain('8687')
  })

  it('verdict 三级计数解析', () => {
    expect(parseReviewVerdict('...正文...\nREVIEW_SUMMARY: blockers=1 suggestions=2 notes=3')).toEqual({ blockers: 1, suggestions: 2, notes: 3 })
    expect(parseReviewVerdict('没有汇总行')).toBeNull()
  })

  it('验收标准编号成清单并要求逐条 pass/fail（Task-first review）', () => {
    const multiText = cardText({ id: 'acc-multi' }).replace(
      '- 通过（npx vitest run 全绿）',
      '- npx vitest run test/a.test.ts 全绿\n- GET /health 应返回 200'
    )
    const multi = loadCard(multiText, 'c.md')
    const p = buildReviewerPrompt(multi, 'diff')
    expect(p).toContain('逐条核对验收标准（共 2 条')
    expect(p).toContain('1. npx vitest run test/a.test.ts 全绿')
    expect(p).toContain('2. GET /health 应返回 200')
  })

  it('reviewContext 注入复诵段与预检事实；不传时无复诵条目', () => {
    const withCtx = buildReviewerPrompt(card(), 'diff', '', '', { notesRecap: 'NOTES 复诵内容', recitationFact: '' })
    expect(withCtx).toContain('5. **复诵核对**')
    expect(withCtx).toContain('<NOTES.md 复诵段')
    expect(withCtx).toContain('NOTES 复诵内容')
    const factOnly = buildReviewerPrompt(card(), 'diff', '', '', { notesRecap: '', recitationFact: 'NOTES.md 仍是 start 模板原文' })
    expect(factOnly).toContain('编排器预检事实：NOTES.md 仍是 start 模板原文')
    expect(factOnly).not.toContain('<NOTES.md 复诵段')
    const noCtx = buildReviewerPrompt(card(), 'diff')
    expect(noCtx).not.toContain('复诵核对')
  })
})

describe('orchestrator prompt > 复诵核对（checkRecitation，① 机器面）', () => {
  it('复诵关键词命中 ≥2 → present；空 NOTES → 事实句', () => {
    const ok = checkRecitation('# NOTES\n- 目的地（目标）：x\n- 交货标准（验收标准）：y\n', card())
    expect(ok.present).toBe(true)
    expect(ok.fact).toBe('')
    const empty = checkRecitation('', card())
    expect(empty.present).toBe(false)
    expect(empty.fact).toContain('复诵协议未执行')
  })

  it('start 模板原文 → 模板事实句；目标文本重叠 → present', () => {
    const tpl = '# 任务交接 NOTES — t\n- 船位（已完成）：\n<一句话说明本任务要达成什么>\n'
    const r1 = checkRecitation(tpl, card())
    expect(r1.present).toBe(false)
    expect(r1.fact).toContain('start 模板原文')
    const r2 = checkRecitation('我把「测试任务目标」这件事做完了', card())
    expect(r2.present).toBe(true)
  })
})

describe('orchestrator prompt > acceptance 申报解析与契约行补问（③⑤）', () => {
  it('parseAcceptanceDeclared 解析 m/n；自由文本/缺失/0 分母/倒挂（met>total）返回 null（旧契约块兼容）', () => {
    expect(parseAcceptanceDeclared('2/3')).toEqual({ met: 2, total: 3 })
    expect(parseAcceptanceDeclared(' 1 / 1 ')).toEqual({ met: 1, total: 1 })
    expect(parseAcceptanceDeclared('全部满足')).toBeNull()
    expect(parseAcceptanceDeclared(undefined)).toBeNull()
    expect(parseAcceptanceDeclared('0/0')).toBeNull()
    // 倒挂申报（修复前 "5/2" 照单全收为 {met:5,total:2}）：与「解析不出」同路径跳过对账
    expect(parseAcceptanceDeclared('5/2')).toBeNull()
    expect(parseAcceptanceDeclared('99 / 1')).toBeNull()
    expect(parseAcceptanceDeclared('3/3')).toEqual({ met: 3, total: 3 }) // 边界：met==total 合法
  })

  it('buildReviewRetryPrompt 只求补汇总行，带上一轮输出截尾，不重放 diff', () => {
    const p = buildReviewRetryPrompt('审查正文……\n结论若干')
    expect(p).toContain('REVIEW_SUMMARY: blockers=')
    expect(p).toContain('审查正文')
    expect(p).not.toContain('```diff')
  })

  it('契约块模板（含收缩体）带 acceptance 申报行', () => {
    const c = ctx(os.tmpdir())
    expect(buildWorkerPrompt(card(), c)).toContain('acceptance: <已满足的验收条数>/<总条数>')
    const body = buildPromptFileRefBody({ promptPath: '/p.md', card: card(), originalChars: 21_000 })
    expect(body).toContain('acceptance: <已满足的验收条数>/<总条数>')
  })
})

describe('orchestrator prompt > fixup prompt', () => {
  it('注入失败尾部与轮次；超长输出截到 200 行', () => {
    const c = ctx(os.tmpdir())
    const longOutput = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n')
    const p = buildFixupPrompt(card(), c, 'test_failure', longOutput, 2)
    expect(p).toContain('第 2 次返工')
    expect(p).toContain('test_failure')
    expect(p).not.toContain('line-100\n') // 前 300 行被截掉
    expect(p).toContain('line-499') // 尾部保留
  })
})

describe('orchestrator prompt > 大 prompt 落文件收缩体（D17）', () => {
  it('引用全文路径 + worktree 路径 + 目标/验收/红线摘要 + 契约块模板；体量远小于阈值', () => {
    const c = ctx(os.tmpdir())
    const full = '/repo/.agents/orchestrator/logs/t1/prompt-full.md'
    const body = buildPromptFileRefBody({ promptPath: full, card: card(), ctx: c, originalChars: 42_000 })
    expect(body).toContain(full)
    expect(body).toContain('42000') // 原始字符数如实标注
    expect(body).toContain(c.worktreePath)
    expect(body).toContain('测试任务目标') // 目标摘要
    expect(body).toContain('验收标准') // 验收摘要
    expect(body).toContain('```' + RESULT_MARKER) // 契约块模板内联（worker 不读全文也能正确收尾）
    expect(body).toContain('status: done | stuck')
    expect(body.length).toBeLessThan(4000) // 收缩体恒远小于 zcode argv 30k 上限
  })

  it('红线段可选注入；无 ctx 时省略 worktree 段', () => {
    const c = ctx(os.tmpdir())
    const cardWithRedlines = loadCard(cardText({}, '目标内容。\n\n# 红线\n- 禁止动 8687'), 'card.md')
    const body = buildPromptFileRefBody({ promptPath: '/p.md', card: cardWithRedlines, ctx: c, originalChars: 21_000 })
    expect(body).toContain('禁止动 8687')
    const noCtx = buildPromptFileRefBody({ promptPath: '/p.md', card: card(), originalChars: 21_000 })
    expect(noCtx).not.toContain('工作目录（worktree）')
    expect(noCtx).toContain('/p.md')
  })
})

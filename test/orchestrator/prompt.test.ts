import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFixupContextSections, buildFixupPrompt, buildPromptFileRefBody, buildReviewerPrompt, buildReviewRetryPrompt, buildWorkerPrompt, checkRecitation, extractFirstError, FIXUP_FIRST_ERROR_HEADING, FIXUP_GATE_HEADING, FIXUP_PREV_RESULT_HEADING, FIXUP_SECTION_CAP_CHARS, formatPrevResult, parseAcceptanceDeclared, parseResultBlock, parseReviewVerdict, RESULT_MARKER } from '../../.agents/scripts/orchestrator/prompt.mjs'
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

  it('纪律层 0.5 任务理解回执：位于复诵之后、报告 done 之前（先理解后干活）', () => {
    const c = ctx(os.tmpdir())
    const p = buildWorkerPrompt(card(), c)
    const receiptAt = p.indexOf('0.5. 任务理解回执')
    const repeatAt = p.indexOf('复诵即承诺')
    const doneAt = p.indexOf('1. 报告 done 之前')
    expect(receiptAt).toBeGreaterThan(repeatAt)
    expect(receiptAt).toBeLessThan(doneAt)
    expect(p).toContain('主体（做的是什么东西/谁）') // 四要素分解
    expect(p).toContain('禁止猜一个占位主体硬干到底') // 查证失败必须停船要信息
    expect(p).toContain('先调研，后动工') // 卡面资料只是起点，须独立检索核验
    expect(p).toContain('残留盘点') // 改造类任务三分类：旧主体遗留人类特征一律清除
    expect(p).toContain('关联内容全量过滤') // 换主体须同步标题/文案/aria/注释
    expect(p).toContain('grep 旧主体名归零')
    expect(p).toContain('可测量指标') // 造型/视觉任务：形容词不算验收标准
    expect(p).toContain('ship-selfcheck.mjs') // 机器清单随卡下发：检查动作外置脚本
    expect(p).toContain('输出全绿并原文贴进报告')
    expect(p).toContain('不许带未申报的假设')
  })

  it('纪律层 0.5 瘦身：检查动作迁往脚本后，prompt 长度不随事故线性膨胀', () => {
    const c = ctx(os.tmpdir())
    const p = buildWorkerPrompt(card(), c)
    const receipt = p.slice(p.indexOf('0.5. 任务理解回执'), p.indexOf('1. 报告 done 之前'))
    // 0.5 保留意图层，机器检查细节外置 selfcheck 脚本；上界防回弹
    expect(receipt.length).toBeLessThan(1400)
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

  it('维度 0 需求保真度：始终存在且先于维度 1；卡带背景时注入原始需求作对照基准', () => {
    const plain = buildReviewerPrompt(card(), 'diff --git a/x b/x')
    const fidelityAt = plain.indexOf('0. 需求保真度')
    const goalAt = plain.indexOf('1. 逐条核对验收标准')
    expect(fidelityAt).toBeGreaterThan(-1)
    expect(fidelityAt).toBeLessThan(goalAt)
    expect(plain).toContain('主体不符直接计阻塞项')
    expect(plain).not.toContain('背景与原始需求') // 无背景卡不注入对照节

    const withBg = loadCard(cardText({}, '测试任务目标。\n\n# 背景\n原始需求（逐字）：做一只大嘴鸟骑自行车的页面'), 'card.md')
    const p = buildReviewerPrompt(withBg, 'diff --git a/x b/x')
    expect(p).toContain('# 背景与原始需求（保真度对照基准）')
    expect(p).toContain('原始需求（逐字）：做一只大嘴鸟骑自行车的页面')
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

describe('orchestrator prompt > fixup 三段定向上下文（2026-11-15 P1-⑦）', () => {
  it('三段小节标记恒存在；门禁摘要与上轮 result block 有料时注入内容', () => {
    const c = ctx(os.tmpdir())
    const p = buildFixupPrompt(card(), c, 'test_failure', 'FAIL test/a.test.ts > 用例', 1, {
      gateName: 'npm_test',
      gateCriteria: '测试命令「npm test」在 worktree 内执行，退出码非 0 即失败',
      prevResult: { status: 'done', summary: '实现完成', files_changed: ['src/a.ts'], tests: 'pass', acceptance: '2/3', notes_updated: true },
    })
    expect(p).toContain(FIXUP_GATE_HEADING)
    expect(p).toContain(FIXUP_FIRST_ERROR_HEADING)
    expect(p).toContain(FIXUP_PREV_RESULT_HEADING)
    expect(p).toContain('- 失败门禁：npm_test')
    expect(p).toContain('退出码非 0 即失败')
    expect(p).toContain('status: done')
    expect(p).toContain('summary: 实现完成')
    expect(p).toContain('files_changed: ["src/a.ts"]')
    expect(p).toContain('acceptance: 2/3')
    expect(p).toContain('notes_updated: true')
  })

  it('首个错误取自完整输出头部：FAIL 在头部、尾 200 行里没有 FAIL 仍注入（根因不再被截）', () => {
    const c = ctx(os.tmpdir())
    const lines = ['run started', 'FAIL test/head.test.ts > 根因用例', 'AssertionError: expected true to be false']
    for (let i = 0; i < 500; i++) lines.push(`noise-${i}`)
    const p = buildFixupPrompt(card(), c, 'test_failure', lines.join('\n'), 1)
    expect(p).toContain('FAIL test/head.test.ts > 根因用例')
    expect(p).toContain('AssertionError: expected true to be false')
    expect(p).toContain('run started') // 前置上下文
    expect(p).not.toContain('noise-100\n') // 头部噪音行不被反向带入
    expect(p).toContain('noise-499') // 尾 200 行块照常保留（既有行为不回归）
  })

  it('首个错误提取不到时优雅降级：段内说明行，不报错', () => {
    const c = ctx(os.tmpdir())
    const p = buildFixupPrompt(card(), c, 'build_failure', '一切正常但退出码 1\n没有任何失败行形态', 1)
    expect(p).toContain(FIXUP_FIRST_ERROR_HEADING)
    expect(p).toContain('未能从失败输出提取首个错误')
    expect(p).toContain('## 失败输出（截取尾部 200 行）') // 基础形状仍在
  })

  it('上轮 result block 缺失（不传 fixupCtx）时优雅降级：段内说明行', () => {
    const c = ctx(os.tmpdir())
    const p = buildFixupPrompt(card(), c, 'test_failure', 'FAIL x', 1)
    expect(p).toContain(FIXUP_PREV_RESULT_HEADING)
    expect(p).toContain('未取得上轮 result block')
    expect(p).toContain('失败门禁：（本轮失败非门禁触发或记录缺失）')
  })

  it('三段各有 4KB 截断上限：超长 criteria 精确截到 4096；各段总长受控', () => {
    const c = ctx(os.tmpdir())
    const p = buildFixupPrompt(card(), c, 'test_failure', 'FAIL\n' + 'z'.repeat(10_000), 1, {
      gateName: 'npm_test',
      gateCriteria: 'x'.repeat(10_000),
      prevResult: { summary: 'y'.repeat(10_000) },
    })
    // criteria 单段精确截断（capSection 从头截）
    expect(p.includes('x'.repeat(FIXUP_SECTION_CAP_CHARS))).toBe(true)
    expect(p.includes('x'.repeat(FIXUP_SECTION_CAP_CHARS + 1))).toBe(false)
    // 按小节标记切分：三段各自总长 ≤ cap + 标题/说明行开销
    const sec = p.slice(p.indexOf(FIXUP_GATE_HEADING), p.indexOf('## 失败输出'))
    const gateSeg = sec.slice(0, sec.indexOf(FIXUP_FIRST_ERROR_HEADING))
    const feSeg = sec.slice(sec.indexOf(FIXUP_FIRST_ERROR_HEADING), sec.indexOf(FIXUP_PREV_RESULT_HEADING))
    const prevSeg = sec.slice(sec.indexOf(FIXUP_PREV_RESULT_HEADING))
    for (const seg of [gateSeg, feSeg, prevSeg]) {
      expect(seg.length).toBeLessThanOrEqual(FIXUP_SECTION_CAP_CHARS + 200)
    }
  })

  it('extractFirstError：\\r\\n 归一化后命中；无失败行返回 null；预算保错误行本体不被前置超长行吃掉', () => {
    expect(extractFirstError('before\r\nFAIL real\r\nafter')).toBe('before\nFAIL real\nafter')
    expect(extractFirstError('nothing wrong here at all')).toBeNull()
    const guarded = extractFirstError(`${'A'.repeat(6000)}\nFAIL real\nB`)
    expect(guarded).toBe('FAIL real\nB') // 超长前置行被丢弃，错误行本体完整
    expect(guarded!.length).toBeLessThanOrEqual(FIXUP_SECTION_CAP_CHARS)
    expect(extractFirstError('FAIL\n' + 'z'.repeat(10_000))!.length).toBeLessThanOrEqual(FIXUP_SECTION_CAP_CHARS)
  })

  it('formatPrevResult：字段直排，undefined 剔除；非对象返回 null', () => {
    expect(formatPrevResult({ status: 'done', notes_updated: false, extra: undefined })).toBe('status: done\nnotes_updated: false')
    expect(formatPrevResult({ files_changed: ['a.ts', 'b.ts'] })).toBe('files_changed: ["a.ts","b.ts"]')
    expect(formatPrevResult(null)).toBeNull()
    expect(formatPrevResult({})).toBeNull()
  })

  it('buildFixupContextSections 独立可用（与 buildFixupPrompt 同源降级口径）', () => {
    const sec = buildFixupContextSections({ gateName: 'lint', gateCriteria: 'lint 命令', failureOutput: 'FAIL x', prevResult: { status: 'done' } })
    expect(sec).toContain(FIXUP_GATE_HEADING)
    expect(sec).toContain('FAIL x')
    expect(sec).toContain('status: done')
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

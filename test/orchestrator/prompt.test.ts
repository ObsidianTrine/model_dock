import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFixupPrompt, buildReviewerPrompt, buildWorkerPrompt, parseResultBlock, parseReviewVerdict, RESULT_MARKER } from '../../.agents/scripts/orchestrator/prompt.mjs'
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

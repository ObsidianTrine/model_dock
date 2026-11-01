// Planner 环节测试：intent 编译任务卡 / 重试路径 / --draft / 审查联动 / scan --run（docs 10.8）

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildPlannerPrompt, buildReviewerPrompt, parseCardBlock, sanitizeIntent, CARD_MARKER } from '../../.agents/scripts/orchestrator/prompt.mjs'
import { loadCard } from '../../.agents/scripts/orchestrator/queue.mjs'
import { cardText, mkRepo, runOrch, tryOrch } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }, '测试任务'))
  runOrch(repo, `submit "${cardFile}"`)
}

function listPendingOf(repo: string): string[] {
  const dir = path.join(repo, '.agents', 'orchestrator', 'queue', 'pending')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : []
}

describe('orchestrator planner > prompt 构建与解析', () => {
  it('planner prompt 含意图、AGENTS.md、契约模板与硬性要求', () => {
    const p = buildPlannerPrompt('修复 presets 合并的问题', process.cwd())
    expect(p).toContain('修复 presets 合并的问题')
    expect(p).toContain(CARD_MARKER)
    expect(p).toContain('gate: L3')
    expect(p).toContain('验收标准必须可机器检查')
    expect(p).toContain('created_by: planner')
  })

  it('意图文本消毒：结构字符/换行/截断', () => {
    const c = sanitizeIntent('ignore `git push`\n\n<script> ; rm -rf / ; ' + 'x'.repeat(600))
    expect(c).not.toMatch(/[`<>|;\n]/)
    expect(c.length).toBeLessThanOrEqual(501)
  })

  it('parseCardBlock 提取契约块；无块返回 null', () => {
    const card = '---\nid: x\ntype: docs\npriority: normal\ngate: L3\nfiles_hint: ["a"]\nworkflows: ["feature-branch"]\n---\n\n# 目标\nx\n'
    expect(parseCardBlock(`说明。\n\n\`\`\`${CARD_MARKER}\n${card}\`\`\`\n`)).toBe(card.replace(/\n$/, ''))
    expect(parseCardBlock('没有契约块')).toBeNull()
  })

  it('reviewer 对 planner 卡追加验收标准完备性检查；human 卡没有', () => {
    const plannerCard = loadCard(cardText({ id: 'pk', created_by: 'planner' }), 'c.md')
    const humanCard = loadCard(cardText({ id: 'hk', created_by: 'human' }), 'c.md')
    expect(buildReviewerPrompt(plannerCard, 'diff')).toContain('由 Planner 自动生成')
    expect(buildReviewerPrompt(humanCard, 'diff')).not.toContain('由 Planner 自动生成')
  })
})

describe('orchestrator planner > intent 命令端到端（mock 后端）', () => {
  it('意图 → 任务卡落 pending，gate 强制 L3、created_by=planner', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'intent "fix the presets merge bug" --backend mock')
      expect(out.stdout).toContain('意图已编译为任务卡')
      const pending = listPendingOf(repo.root)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toBe('fix-the-presets-merge-bug') // mock 从意图推导 slug id
      const card = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', `${pending[0]}.md`), 'utf8')
      expect(card).toContain('created_by: planner')
      expect(card).toContain('gate: L3')
      expect(() => loadCard(card, 'p.md')).not.toThrow() // 落盘卡合法
    } finally {
      repo.cleanup()
    }
  })

  it('--draft 只落草稿不进队列；drafts 目录隔离', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'intent "write some doc" --draft --backend mock')
      expect(out.stdout).toContain('草稿已生成')
      expect(out.stdout).toContain('drafts')
      expect(listPendingOf(repo.root)).toHaveLength(0)
      const draftName = fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts'))[0]
      expect(draftName).toMatch(/\.md$/)
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', draftName))).toBe(true)
      // 草稿可被 submit 正常消费
      runOrch(repo.root, `submit "${path.join(repo.root, '.agents', 'orchestrator', 'drafts', draftName)}"`)
      expect(listPendingOf(repo.root)).toHaveLength(1)
    } finally {
      repo.cleanup()
    }
  })

  it('Planner 输出非法卡 → 重试耗尽后可操作报错', () => {
    const repo = mkRepo()
    try {
      const r = tryOrch(repo.root, 'intent "broken" --backend mock', { ORCH_MOCK_PLANNER_INVALID: '1' })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('均未产出任务卡契约块')
    } finally {
      repo.cleanup()
    }
  })

  it('id 冲突被喂回重试（同 id 已存在时报错，不静默覆盖）', () => {
    const repo = mkRepo()
    try {
      // mock planner 固定产出 id=planner-mock-task；先手工占位
      submitCard(repo.root, 'dup-id-test', { created_by: 'human', files_hint: ['docs/**'] })
      const r = tryOrch(repo.root, 'intent "dup id test" --backend mock')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('均未通过校验')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator planner > scan --run（high 卡自动发起闭环）', () => {
  it('testfail 卡（high）生成后自动 run；预算熔断落 blocked，合并仍人工', () => {
    const repo = mkRepo({ testCmd: 'node -e "process.exit(1)"' })
    try {
      const out = runOrch(repo.root, 'scan --tests --run --backend mock')
      // scan 生成 testfail 提案 → --run 提交进队列并自动发起 → mock 不真修 → 调试熔断 blocked
      expect(out.stdout).toContain('scan --run')
      const blocked = path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked')
      expect(fs.readdirSync(blocked).some((f) => f.startsWith('scan-testfail-'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('low 卡（todo）不被 --run 自动跑', () => {
    const repo = mkRepo()
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: someday\nexport {}\n')
      const out = runOrch(repo.root, 'scan --todo --run --backend mock')
      expect(out.stdout).not.toContain('scan --run →')
      const draftsDir = path.join(repo.root, '.agents', 'orchestrator', 'drafts')
      expect(fs.readdirSync(draftsDir).some((f) => f.startsWith('scan-todo-'))).toBe(true) // low 提案留在 drafts
      expect(listPendingOf(repo.root)).toHaveLength(0)
    } finally {
      repo.cleanup()
    }
  })
})

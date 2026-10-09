import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_BUDGET, STATES, ensureQueue, findCard, loadCard, listCards, moveCard, parseYamlSubset, queueRoot, validateCard } from '../../.agents/scripts/orchestrator/queue.mjs'
import { cardText, mkRepo } from './helpers.js'

describe('orchestrator queue > YAML 子集解析', () => {
  it('标量/内联数组/块数组/一层嵌套/注释', () => {
    const out = parseYamlSubset(`
# 整行注释
id: fix-a            # 行尾注释
count: 42
ratio: 1.5
flag: true
empty: null
inline: [a, b, "c d"]
budget:
  max_turns: 30
  max_tokens: 100000
files_hint:
  - src/**
  - test/**
`)
    expect(out).toMatchObject({
      id: 'fix-a',
      count: 42,
      ratio: 1.5,
      flag: true,
      empty: null,
      inline: ['a', 'b', 'c d'],
      budget: { max_turns: 30, max_tokens: 100000 },
      files_hint: ['src/**', 'test/**'],
    })
  })

  it('解析失败给出行号的可操作报错', () => {
    expect(() => parseYamlSubset('id: ok\n这不是yaml!!!\n')).toThrowError(/第 2 行/)
    expect(() => parseYamlSubset('a: 1\n  b: 2\n')).toThrowError(/缩进/)
  })
})

describe('orchestrator queue > 任务卡校验', () => {
  it('完整卡通过；budget 缺失字段回落默认值（熔断不可关闭）', () => {
    const { meta } = loadCard(cardText(), 'card.md')
    expect(meta.id).toBe('test-task')
    for (const k of Object.keys(DEFAULT_BUDGET)) {
      expect((meta.budget as Record<string, number>)[k]).toBe(DEFAULT_BUDGET[k as keyof typeof DEFAULT_BUDGET])
    }
  })

  it('缺 id / 非法 type / gate 非法 / 空 files_hint → 可操作报错', () => {
    expect(() => loadCard(cardText({ id: '' }))).toThrowError(/id/)
    expect(() => loadCard(cardText({ id: 'Bad_ID' }))).toThrowError(/id/)
    expect(() => loadCard(cardText({ type: 'hack' }))).toThrowError(/type/)
    expect(() => loadCard(cardText({ gate: 'L2' }))).toThrowError(/L2.*永人工|核心路径/)
    expect(() => loadCard(cardText({ gate: 'X9' }))).toThrowError(/gate/)
    expect(() => loadCard(cardText({ files_hint: [] }))).toThrowError(/files_hint/)
  })

  it('gate 允许 L0/L1/L3，缺省回落 L3（最保守）', () => {
    for (const gate of ['L0', 'L1', 'L3']) {
      const { meta } = loadCard(cardText({ gate }))
      expect(meta.gate).toBe(gate)
    }
    // 显式省略 gate：从文本里去掉该行再解析
    const noGate = cardText({}).split('\n').filter((l) => !l.startsWith('gate:')).join('\n')
    expect(loadCard(noGate).meta.gate).toBe('L3')
  })

  it('budget 显式非法值报错（不允许无预算运行）', () => {
    expect(() => loadCard(cardText({ budget: { max_turns: -1 } }))).toThrowError(/max_turns/)
    expect(() => loadCard(cardText({ budget: { max_tokens: 'abc' } }))).toThrowError(/max_tokens/)
  })

  it('缺少 "# 目标" 段落报错', () => {
    expect(() => loadCard('---\nid: x\ntype: docs\npriority: low\ngate: L3\nfiles_hint: ["a"]\nworkflows: ["feature-branch"]\n---\n\n正文没有目标\n')).toThrowError(/目标/)
  })
})

describe('orchestrator queue > 状态机', () => {
  it('7 个状态目录建齐；合法迁移 rename 成功；非法迁移拒绝', () => {
    const repo = mkRepo()
    try {
      const root = queueRoot(repo.root)
      ensureQueue(root)
      for (const s of STATES) expect(fs.existsSync(path.join(root, s))).toBe(true)

      fs.writeFileSync(cardPathOf(root, 'pending', 't1'), cardText({ id: 't1' }))
      moveCard(root, 't1', 'pending', 'running')
      expect(fs.existsSync(path.join(root, 'running', 't1.md'))).toBe(true)
      moveCard(root, 't1', 'running', 'reviewing')
      moveCard(root, 't1', 'reviewing', 'awaiting-human')
      moveCard(root, 't1', 'awaiting-human', 'merged')
      expect(findCard(root, 't1')?.state).toBe('merged')

      // 终态无出边
      expect(() => moveCard(root, 't1', 'merged', 'pending')).toThrowError(/非法状态迁移/)
      // 跳变拒绝：pending → awaiting-human
      fs.writeFileSync(cardPathOf(root, 'pending', 't2'), cardText({ id: 't2' }))
      expect(() => moveCard(root, 't2', 'pending', 'awaiting-human')).toThrowError(/pending → \[running\]/)
      // 卡片不存在报错
      expect(() => moveCard(root, 'ghost', 'pending', 'running')).toThrowError(/不存在/)
    } finally {
      repo.cleanup()
    }
  })

  it('findCard 扫全部状态；listCards 按目录列 id', () => {
    const repo = mkRepo()
    try {
      const root = queueRoot(repo.root)
      ensureQueue(root)
      fs.writeFileSync(cardPathOf(root, 'blocked', 'b1'), cardText({ id: 'b1' }))
      fs.writeFileSync(cardPathOf(root, 'blocked', 'a1'), cardText({ id: 'a1' }))
      expect(findCard(root, 'b1')?.state).toBe('blocked')
      expect(findCard(root, 'nope')).toBeNull()
      expect(listCards(root, 'blocked')).toEqual(['a1', 'b1'])
    } finally {
      repo.cleanup()
    }
  })
})

function cardPathOf(root: string, state: string, id: string): string {
  return path.join(root, state, `${id}.md`)
}

// validateCard 直接暴露于模块——确认导出可用（防误删）
it('validateCard 独立导出可用', () => {
  const meta = validateCard({ id: 'ok-1', type: 'docs', gate: 'L3', files_hint: ['a'], workflows: ['feature-branch'] })
  expect(meta.priority).toBe('normal')
  expect(meta.budget.max_turns).toBe(DEFAULT_BUDGET.max_turns)
})

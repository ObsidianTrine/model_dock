// propose 需求综合测试（mock planner，零外部调用）：目标面/巡检信号进 prompt、
// 提案落 drafts（proposal: true / created_by planner / gate L3）、autopilot 白名单
// 自动提交（gate→L1）与提交后的可合并性（docs 提案 drain 全链到 merged）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildProposePrompt, parseCardBlocks } from '../../.agents/scripts/orchestrator/prompt.mjs'
import { readGoals } from '../../.agents/scripts/orchestrator/goals.mjs'
import { listCards, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'
import { mkRepo, runOrch } from './helpers.js'

describe('orchestrator propose > prompt 构建与解析', () => {
  it('buildProposePrompt：目标面/信号/队列现状/上限注入；无目标面降级提示', () => {
    const p = buildProposePrompt({ goals: '1. 网关 p99 达标', signals: '- scan-ki-perf-15（refactor/normal）：改 key 全表重加密', queueSummary: 'pending=0', maxCards: 2, repoRoot: process.cwd() })
    expect(p).toContain('网关 p99 达标')
    expect(p).toContain('scan-ki-perf-15')
    expect(p).toContain('pending=0')
    expect(p).toContain('至多 2 张')
    expect(p).toContain('proposal: true')
    const p2 = buildProposePrompt({ goals: null, signals: '', queueSummary: '', maxCards: 1, repoRoot: process.cwd() })
    expect(p2).toContain('未提供 goals.md')
  })

  it('parseCardBlocks：多卡全部提取；无块返回空数组', () => {
    const two = '前置说明\n```agents-card\n---\nid: a\n---\n卡A\n```\n中缝\n```agents-card\n---\nid: b\n---\n卡B\n```'
    expect(parseCardBlocks(two)).toHaveLength(2)
    expect(parseCardBlocks('没有块')).toEqual([])
  })

  it('readGoals：缺失/空文件 = null（无目标面降级）；有内容原样返回', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-goals-'))
    try {
      expect(readGoals(dir)).toBeNull()
      const ap = path.join(dir, '.agents', 'orchestrator')
      fs.mkdirSync(ap, { recursive: true })
      fs.writeFileSync(path.join(ap, 'goals.md'), '\n')
      expect(readGoals(dir)).toBeNull()
      fs.writeFileSync(path.join(ap, 'goals.md'), '# 目标\n- 稳定全绿\n')
      expect(readGoals(dir)).toContain('稳定全绿')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('orchestrator propose > 端到端（mock planner）', () => {
  it('propose：提案落 drafts（proposal/created_by/gate 归一）；autopilot 关闭不提交', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'propose --backend mock')
      expect(out.stdout).toContain('落提案 1 张')
      const draftsDir = path.join(repo.root, '.agents', 'orchestrator', 'drafts')
      const drafts = fs.readdirSync(draftsDir).filter((f) => f.endsWith('.md'))
      expect(drafts).toEqual(['planner-mock-task.md'])
      const text = fs.readFileSync(path.join(draftsDir, 'planner-mock-task.md'), 'utf8')
      expect(text).toContain('proposal: true')
      expect(text).toMatch(/created_by: planner/)
      expect(text).toContain('gate: L3')
      expect(listCards(queueRoot(repo.root), 'pending')).toHaveLength(0) // 未授权：只提案不提交
    } finally {
      repo.cleanup()
    }
  })

  it('autopilot 开启（白名单 docs）：提案自动提交 pending 且 gate→L1；drain 全链 merged', () => {
    const repo = mkRepo({ extra: { autopilot: { enabled: true, autoSubmitTypes: ['docs'], autoDrainPerCycle: 3 } } })
    try {
      const out = runOrch(repo.root, 'propose --backend mock')
      expect(out.stdout).toContain('autopilot 已提交提案')
      expect(out.stdout).toContain('gate=L1')
      expect(listCards(queueRoot(repo.root), 'pending')).toEqual(['planner-mock-task'])
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', 'planner-mock-task.md'))).toBe(false)
      const pending = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'planner-mock-task.md'), 'utf8')
      expect(pending).toContain('gate: L1')
      expect(pending).toContain('proposal: true')
      // 提交后可被常规闭环消费：mock worker 写 docs 文件 → 实际分级 L0 → gate L1 自动合并
      const drained = runOrch(repo.root, 'drain --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(drained.stdout).toContain('自动合并')
      expect(listCards(queueRoot(repo.root), 'merged')).toEqual(['planner-mock-task'])
    } finally {
      repo.cleanup()
    }
  }, 90_000)

  it('autopilot 开启但白名单外（refactor 提案）：只落 drafts 不提交', () => {
    // TODO 信号卡 type=refactor；白名单只有 docs → scan 产物不自动提交
    const repo = mkRepo({ extra: { autopilot: { enabled: true, autoSubmitTypes: ['docs'] } } })
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: 保持提案态\nexport {}\n')
      const out = runOrch(repo.root, 'scan --todo')
      expect(out.stdout).toContain('不自动提交')
      expect(out.stdout).toContain('autoSubmitTypes')
      expect(listCards(queueRoot(repo.root), 'pending')).toHaveLength(0)
    } finally {
      repo.cleanup()
    }
  })

  it('goals.md 目标面存在时进 planner prompt（mock 会话照常产出）', () => {
    const repo = mkRepo()
    try {
      const ap = path.join(repo.root, '.agents', 'orchestrator')
      fs.mkdirSync(ap, { recursive: true })
      fs.writeFileSync(path.join(ap, 'goals.md'), '# 项目目标面\n\n## 核心目标\n1. 文档自动化提案链路稳定\n')
      const out = runOrch(repo.root, 'propose --backend mock')
      expect(out.status).toBe(0)
      expect(fs.existsSync(path.join(ap, 'drafts', 'planner-mock-task.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })
})

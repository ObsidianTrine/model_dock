// nightly 测试：巡检编排端到端——scan 落卡 + drift 报告 + 摘要；默认零烧钱（不跑 worker）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { listCards, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'
import { mkRepo, runOrch } from './helpers.js'

describe('orchestrator nightly > 巡检编排端到端', () => {
  it('TODO 信号出提案落 drafts + 漂移报告 + 摘要；无 --auto 不跑 worker（提案不进队列）', () => {
    const repo = mkRepo()
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: 待办事项\nexport {}\n')
      const out = runOrch(repo.root, 'nightly')
      expect(out.stdout).toContain('nightly 巡检')
      expect(out.stdout).toContain('已生成提案：drafts/scan-todo-')
      expect(out.stdout).toContain('质量漂移报告')
      expect(out.stdout).toContain('nightly 摘要')
      expect(out.stdout).toContain('待调度（pending）: 0')
      const pending = listCards(queueRoot(repo.root), 'pending')
      expect(pending).toHaveLength(0)
      const drafts = fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts')).filter((f) => f.endsWith('.md'))
      expect(drafts).toHaveLength(1)
      // 提案是 scanner 产物：worker 未被拉起（无事件日志）
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', drafts[0].replace(/\.md$/, '')))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('重复跑同夜去重（内容不变 → 同 id → 已存在跳过）', () => {
    const repo = mkRepo()
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: 同一条\nexport {}\n')
      runOrch(repo.root, 'nightly')
      const again = runOrch(repo.root, 'nightly')
      expect(again.stdout).toContain('已存在，跳过')
      expect(listCards(queueRoot(repo.root), 'pending')).toHaveLength(0)
      expect(fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts')).filter((f) => f.endsWith('.md'))).toHaveLength(1)
    } finally {
      repo.cleanup()
    }
  })

  it('无信号仓库：不落提案 + 空队列摘要（audit 无 lock 的容错警告属预期）', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'nightly')
      expect(out.stdout).not.toContain('已生成提案')
      expect(out.stdout).toContain('待调度（pending）: 0')
      expect(out.stdout).toContain('nightly 摘要')
    } finally {
      repo.cleanup()
    }
  })

  it('--plan：planner 需求综合（mock）出提案进 drafts，摘要含人工审阅指引', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'nightly --plan --backend mock')
      expect(out.stdout).toContain('nightly --plan → propose')
      const drafts = fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts')).filter((f) => f.endsWith('.md'))
      expect(drafts.some((f) => f.startsWith('planner-'))).toBe(true)
      const proposal = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', drafts.find((f) => f.startsWith('planner-'))), 'utf8')
      expect(proposal).toContain('proposal: true')
      expect(proposal).toContain('gate: L3')
      expect(out.stdout).toContain('批量 submit')
    } finally {
      repo.cleanup()
    }
  })
})

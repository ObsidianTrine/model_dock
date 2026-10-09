// 队列自动调度测试：pickNextCard 排序与容错（docs 10.3）

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { cardText, mkRepo } from './helpers.js'
import { ensureQueue, pickNextCard, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'

function writeCard(repo: string, overrides: Record<string, unknown>) {
  const id = String(overrides.id)
  fs.writeFileSync(
    `${repo}/.agents/orchestrator/queue/pending/${id}.md`,
    cardText(overrides),
  )
}

describe('orchestrator drain > pickNextCard 自动调度', () => {
  it('priority 排序：high > normal > low', () => {
    const repo = mkRepo()
    try {
      const root = queueRoot(repo.root)
      ensureQueue(root)
      writeCard(repo.root, { id: 'a-low', priority: 'low', created_at: '2026-10-01T01:00:00+08:00' })
      writeCard(repo.root, { id: 'b-normal', priority: 'normal', created_at: '2026-10-01T02:00:00+08:00' })
      writeCard(repo.root, { id: 'c-high', priority: 'high', created_at: '2026-10-01T03:00:00+08:00' })
      expect(pickNextCard(root)?.id).toBe('c-high')
    } finally {
      repo.cleanup()
    }
  })

  it('同优先级按 created_at 升序（先到先跑）', () => {
    const repo = mkRepo()
    try {
      const root = queueRoot(repo.root)
      ensureQueue(root)
      writeCard(repo.root, { id: 'late', created_at: '2026-10-01T12:00:00+08:00' })
      writeCard(repo.root, { id: 'early', created_at: '2026-10-01T08:00:00+08:00' })
      expect(pickNextCard(root)?.id).toBe('early')
    } finally {
      repo.cleanup()
    }
  })

  it('损坏卡跳过不阻塞调度', () => {
    const repo = mkRepo()
    try {
      const root = queueRoot(repo.root)
      ensureQueue(root)
      fs.writeFileSync(`${repo.root}/.agents/orchestrator/queue/pending/broken.md`, '不是合法任务卡')
      writeCard(repo.root, { id: 'good', created_at: '2026-10-01T08:00:00+08:00' })
      expect(pickNextCard(root)?.id).toBe('good')
    } finally {
      repo.cleanup()
    }
  })

  it('空队列返回 null', () => {
    const repo = mkRepo()
    try {
      ensureQueue(queueRoot(repo.root))
      expect(pickNextCard(queueRoot(repo.root))).toBeNull()
    } finally {
      repo.cleanup()
    }
  })
})

// 队列自动调度测试：pickNextCard 排序与容错（docs 10.3）+ drain spawn 失败容错（串行/并行）

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cardText, mkRepo, eventsOf, readCard, runDrainWithoutNode, runOrch } from './helpers.js'
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

// ---------------------------------------------------------------------------
// spawn 失败容错（注入化：helpers.runDrainWithoutNode 让内层 spawnSync('node') 三平台
// 必然 ENOENT——引擎预检只探 worker CLI，这里防的是预检过后 node 起不来的窄窗口）
// ---------------------------------------------------------------------------

describe('orchestrator drain > run 子进程 spawn 失败容错', () => {
  it('串行：卡转 blocked + failed 事件留痕 + drain 退出 0（不 die 空转、不误报退出码）', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-enoent.md')
      fs.writeFileSync(cardFile, cardText({ id: 'enoent-serial' }))
      runOrch(repo.root, `submit "${cardFile}"`)

      const r = runDrainWithoutNode(repo.root, ['drain', '--backend', 'mock'])
      expect(r.status).toBe(0)
      expect(r.output).toContain('run 子进程启动失败')
      expect(r.output).toContain('继续调度')
      expect(r.output).toContain('队列已清空')
      expect(r.output).toContain('blocked 1') // 收官 tally 口径
      // 卡显式落位 blocked/（不悬 pending——否则死循环防护会 die 整批）
      expect(readCard(repo.root, 'blocked', 'enoent-serial')).toContain('enoent-serial')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'enoent-serial.md'))).toBe(false)
      // 事件留痕：failed 附原因，可 resume 可审计
      const failed = eventsOf(repo.root, 'enoent-serial').find((e) => e.type === 'failed')
      expect(String(failed?.reason)).toContain('run 子进程启动失败')
    } finally {
      repo.cleanup()
    }
  })

  it('并行（--workers 2）：spawn error 清理 active + pump 继续 + 退出 0（原 T15③ 行为不回退）', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-enoentp.md')
      fs.writeFileSync(cardFile, cardText({ id: 'enoent-parallel' }))
      runOrch(repo.root, `submit "${cardFile}"`)

      const r = runDrainWithoutNode(repo.root, ['drain', '--workers', '2', '--backend', 'mock'])
      expect(r.status).toBe(0)
      expect(r.output).toContain('run 子进程启动失败')
      // 并行路径语义：卡留 pending、两次调度后拉黑告警（人工检查执行环境后 resume）
      expect(r.output).toContain('两次被调度仍在 pending')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'enoent-parallel.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('串行死循环防护拉黑化：确定性失败卡（ui_check 未配）转 blocked，其余 pending 照常跑完、drain 退出 0', () => {
    // 回归：旧实现「连续两轮选中同一卡即 die 整批」——一张配错 ui_check 的卡烧掉
    // 当晚整个 drain/nightly（剩余合法 pending 全部不跑）。对齐并行路径：每任务计数，
    // 第 2 次选中且仍在 pending 即拉黑转 blocked（附原因，可 resume），继续调度。
    const repo = mkRepo() // 不配 uiCheckCmd
    try {
      // 走正式 submit（建 pending/ 目录 + schema 校验），直写 pending/ 会 ENOENT
      for (const overrides of [{ id: 'bad-ui', ui_check: true }, { id: 'good-one' }]) {
        const f = path.join(repo.root, `card-${overrides.id}.md`)
        fs.writeFileSync(f, cardText(overrides))
        runOrch(repo.root, `submit "${f}"`)
      }
      const r = runOrch(repo.root, 'drain --backend mock')
      expect(r.status).toBe(0) // 不再 die 整批
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', 'bad-ui.md'))).toBe(true)
      // 坏卡原因可 resume：failed 事件留痕带 resume 提示语义
      const failed = eventsOf(repo.root, 'bad-ui').find((e) => e.type === 'failed') as Record<string, unknown> | undefined
      expect(String(failed?.reason)).toContain('pending')
      // 好卡照常闭环（mock 全流程 → awaiting-human / merged）
      const settled = [
        ...fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'awaiting-human')),
        ...fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'merged')),
      ]
      expect(settled).toContain('good-one.md')
    } finally {
      repo.cleanup()
    }
  }, 180_000)
})

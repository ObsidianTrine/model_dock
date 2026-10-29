// 并行调度测试：hintsOverlap 分区互斥 + drain --workers 并发（docs 10.6）

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { hintsOverlap } from '../../.agents/scripts/policy.mjs'
import { eventsOf, mkRepo, runOrch, cardText } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}, body?: string) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }, body))
  runOrch(repo, `submit "${cardFile}"`)
}

describe('orchestrator parallel > hintsOverlap 分区互斥判定', () => {
  it('不同目录前缀可并行；同前缀或完全通配独占', () => {
    expect(hintsOverlap(['docs/**'], ['test/**'])).toBe(false) // 固定前缀不同 → 可并行（** 只是"该目录下一切"）
    expect(hintsOverlap(['src/**'], ['docs/**'])).toBe(false)
    expect(hintsOverlap(['src/cli.ts'], ['src/gateway/x.ts'])).toBe(true) // 首段同为 src，保守相交
    expect(hintsOverlap(['**'], ['**'])).toBe(true) // 首段即通配 = 完全通配，独占
    expect(hintsOverlap([], ['docs/**'])).toBe(true) // 未声明 = 独占
    expect(hintsOverlap(['CHANGELOG.md'], ['test/a.test.ts'])).toBe(false)
  })
})

describe('orchestrator parallel > drain --workers 并发调度', () => {
  it('不同分区的任务并发跑（交错证据：后启动任务在前一任务完成前出现）', () => {
    const repo = mkRepo()
    try {
      // 两个不同分区（docs / test），worker=2；mock 有 delay 时按任务 id 写 docs/notes-<id>.md：
      // p1（docs 区）改动落自己分区 → L0 自动合并；p2（test 区）改动越界回人工——
      // 但两个任务"同时在跑"的交错证据不受影响：p2 启动（worktree_ready）早于 p1 结束（merged）
      submitCard(repo.root, 'p1', { gate: 'L1', files_hint: ['docs/**'] })
      submitCard(repo.root, 'p2', { gate: 'L1', files_hint: ['test/**'] })
      const out = runOrch(repo.root, 'drain --workers 2 --backend mock', { ORCH_MOCK_DELAY_MS: '800' })
      expect(out.stdout).toContain('队列已清空：本次 drain 共跑完 2 个任务（并发 2）')
      const p1Events = eventsOf(repo.root, 'p1')
      const p2Events = eventsOf(repo.root, 'p2')
      const p1Merged = new Date(p1Events.find((e) => e.type === 'merged')?.ts).getTime()
      const p2Ready = new Date(p2Events.find((e) => e.type === 'worktree_ready')?.ts).getTime()
      expect(Number.isNaN(p1Merged)).toBe(false)
      expect(Number.isNaN(p2Ready)).toBe(false)
      expect(p2Ready).toBeLessThan(p1Merged)
    } finally {
      repo.cleanup()
    }
  })

  it('同分区任务自动串行（hint 相交不并发）', () => {
    const repo = mkRepo()
    try {
      // 两个任务同在 docs 区（首段相同 → hintsOverlap=true），mock 有 delay 时按 id 写 docs/notes-<id>.md（L0 自动合并）
      submitCard(repo.root, 's1', { gate: 'L1', files_hint: ['docs/**'] })
      submitCard(repo.root, 's2', { gate: 'L1', files_hint: ['docs/**'] })
      const out = runOrch(repo.root, 'drain --workers 2 --backend mock', { ORCH_MOCK_DELAY_MS: '600' })
      expect(out.stdout).toContain('队列已清空：本次 drain 共跑完 2 个任务（并发 2）')
      // 串行证据：s2 的 worktree_ready 晚于 s1 的 merged（同分区，等前一个结束才启动）
      const s1Merged = new Date(eventsOf(repo.root, 's1').find((e) => e.type === 'merged')?.ts).getTime()
      const s2Ready = new Date(eventsOf(repo.root, 's2').find((e) => e.type === 'worktree_ready')?.ts).getTime()
      expect(Number.isNaN(s1Merged)).toBe(false)
      expect(s2Ready).toBeGreaterThanOrEqual(s1Merged)
    } finally {
      repo.cleanup()
    }
  })

  it('workers=1 保持串行语义（默认路径不回归）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'w1')
      submitCard(repo.root, 'w2')
      const out = runOrch(repo.root, 'drain --backend mock')
      expect(out.stdout).toContain('队列已清空：本次 drain 共跑完 2 个任务。') // 串行版结尾无"（并发 N）"
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator parallel > drain --max 烧钱上限', () => {
  it('--workers 3 --max 1 且 3 张可跑卡：实际发射数 = 1（其余留 pending）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'm1', { gate: 'L1', files_hint: ['docs/**'] })
      submitCard(repo.root, 'm2', { gate: 'L1', files_hint: ['test/**'] })
      submitCard(repo.root, 'm3', { gate: 'L1', files_hint: ['src/**'] })
      const out = runOrch(repo.root, 'drain --workers 3 --max 1 --backend mock')
      // pump() 首轮在同步循环里逐个 launch：内层只受 workers 约束的话会一口气发满 3 个
      // （child exit 异步事件插不进同步 for 循环），--max 形同虚设。发射数以 drain 头计数。
      expect((out.stdout.match(/═══ drain /g) ?? []).length).toBe(1)
      expect(out.stdout).toContain('已达 --max 1 轮上限')
      const pendingDir = path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending')
      expect(fs.existsSync(path.join(pendingDir, 'm2.md'))).toBe(true)
      expect(fs.existsSync(path.join(pendingDir, 'm3.md'))).toBe(true)
      expect(eventsOf(repo.root, 'm1').some((e) => e.type === 'worktree_ready')).toBe(true)
      expect(eventsOf(repo.root, 'm2')).toHaveLength(0)
      expect(eventsOf(repo.root, 'm3')).toHaveLength(0)
    } finally {
      repo.cleanup()
    }
  })

  it('串行路径 --max 语义不回退（--workers 缺省仍逐次发射前检查）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'sm1', { gate: 'L1', files_hint: ['docs/**'] })
      submitCard(repo.root, 'sm2', { gate: 'L1', files_hint: ['test/**'] })
      const out = runOrch(repo.root, 'drain --max 1 --backend mock')
      expect((out.stdout.match(/═══ drain /g) ?? []).length).toBe(1)
      expect(out.stdout).toContain('已达 --max 1 轮上限')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'sm2.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })
})

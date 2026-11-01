// nightly 测试：巡检编排端到端——scan 落卡 + drift 报告 + 摘要；默认零烧钱（不跑 worker）。
// 另覆盖幂等补跑（nightly-state）：中断恢复 + 双跑防护（Windows 强制重启后 nightly 静默缺失的防护）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { listCards, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'
import { readNightlyState, writeNightlyState } from '../../.agents/scripts/orchestrator/nightly-state.mjs'
import { mkRepo, runOrch } from './helpers.js'

describe('orchestrator nightly > 巡检编排端到端', () => {
  it('TODO 信号落卡 + 漂移报告 + 摘要；无 --auto 不跑 worker（卡留在 pending）', () => {
    const repo = mkRepo()
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: 待办事项\nexport {}\n')
      const out = runOrch(repo.root, 'nightly')
      expect(out.stdout).toContain('nightly 巡检')
      expect(out.stdout).toContain('已生成任务卡：pending/scan-todo-')
      expect(out.stdout).toContain('质量漂移报告')
      expect(out.stdout).toContain('nightly 摘要')
      expect(out.stdout).toContain('待调度（pending）: 1')
      expect(out.stdout).toContain('drain') // 人工推进指引
      const pending = listCards(queueRoot(repo.root), 'pending')
      expect(pending).toHaveLength(1)
      // 卡是 scanner 产物、L3 兜底：worker 未被拉起（无事件日志）
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', pending[0]))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('重复跑同夜去重（内容不变 → 同 id → 已存在跳过；同刻二跑须 --manual 绕过双跑防护）', () => {
    const repo = mkRepo()
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: 同一条\nexport {}\n')
      runOrch(repo.root, 'nightly')
      // 同刻第二次触发：调度器语境（非 TTY）被 20h 双跑防护跳过（见「幂等补跑」组）——
      // 人工语境（--manual）才重跑巡检，去重靠内容哈希
      const again = runOrch(repo.root, 'nightly --manual')
      expect(again.stdout).toContain('已存在，跳过')
      expect(listCards(queueRoot(repo.root), 'pending')).toHaveLength(1)
    } finally {
      repo.cleanup()
    }
  })

  it('无信号仓库：不落卡 + 空队列摘要（audit 无 lock 的容错警告属预期）', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'nightly')
      expect(out.stdout).not.toContain('已生成任务卡')
      expect(out.stdout).toContain('待调度（pending）: 0')
      expect(out.stdout).toContain('nightly 摘要')
    } finally {
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 幂等补跑（nightly-state）：runOrch 的子进程 stdin 非 TTY = 调度器语境
// ---------------------------------------------------------------------------

describe('orchestrator nightly > 幂等补跑（中断恢复 + 双跑防护）', () => {
  it('距上次完成不足 20h 且非人工触发：跳过（exit 0、不巡检），--manual 强跑放行并落 finishedAt', () => {
    const repo = mkRepo()
    try {
      const H = 3_600_000
      writeNightlyState(repo.root, {
        startedAt: new Date(Date.now() - 2 * H).toISOString(),
        finishedAt: new Date(Date.now() - 1 * H).toISOString(),
        result: {},
      })
      const out = runOrch(repo.root, 'nightly')
      expect(out.stdout).toContain('nightly 跳过')
      expect(out.stdout).toContain('双跑')
      expect(out.stdout).not.toContain('nightly 巡检') // 未真正执行巡检
      expect(out.stdout).toContain('--manual') // 给出强跑指引
      // 状态未动：完成记录没有被改成「未收尾」（否则 20h 防护失明）
      const st = readNightlyState(repo.root)
      expect(st?.finishedAt).toBeTruthy()

      // --manual 显式人工触发：不受限，正常执行；但不参与调度器状态机——
      // manual 完成态若覆盖 finishedAt，当晚 02:30 调度触发会因「距上次完成
      // <20h 且非人工」被双跑防护误挡（2026-11-01 设计修正，见 cmdNightly）
      const m = runOrch(repo.root, 'nightly --manual')
      expect(m.stdout).toContain('nightly 巡检')
      expect(m.stdout).toContain('nightly 摘要')
      const st2 = readNightlyState(repo.root)
      expect(st2?.finishedAt).toBeTruthy() // 调度器自己的完成记录保持原样
      expect(st2?.startedAt).toBe(st?.startedAt) // 未被 manual 改写
    } finally {
      repo.cleanup()
    }
  })

  it('--manual 不写调度器 state（无先前 state 时跑完也不创建）', () => {
    const repo = mkRepo()
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: manual state 隔离\nexport {}\n')
      const out = runOrch(repo.root, 'nightly --manual')
      expect(out.stdout).toContain('nightly 摘要') // 巡检真跑了
      expect(readNightlyState(repo.root)).toBeNull() // 但不留调度器运行记录
    } finally {
      repo.cleanup()
    }
  })

  it('上次未收尾（finishedAt 缺失）：记 nightly_recovered + 照常执行接续', () => {
    const repo = mkRepo()
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: 中断恢复场景\nexport {}\n')
      writeNightlyState(repo.root, { startedAt: new Date(Date.now() - 3_600_000).toISOString(), finishedAt: null })
      const out = runOrch(repo.root, 'nightly')
      expect(out.stdout).toContain('nightly_recovered')
      expect(out.stdout).toContain('已生成任务卡') // 巡检照常执行
      const st = readNightlyState(repo.root)
      expect(st?.finishedAt).toBeTruthy() // 正常收尾落完成态
    } finally {
      repo.cleanup()
    }
  })
})

// no_commit 偏航升 actuate（2026-11-15 质量专项 P1-⑥）测试：模式 × 命中 4 象限全覆盖。
// 两层：纯逻辑（createXteAlarm 直调，临时 git 仓对账 HEAD，零编排进程）+ mock 后端集成
// （编排接线、熔断落位、收敛退出码）。observe 档「行为不变」断言沿用既有 xte.test.ts 口径
// （只留痕、流程照常）；actuate 档断言与看门狗 circuit_break 同款落位（xte_alarm + 
// circuit_breaker(xte_no_commit) + 卡 blocked + 正常收敛）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createXteAlarm } from '../../.agents/scripts/orchestrator/xte.mjs'
import { appendEvent, readEvents } from '../../.agents/scripts/orchestrator/events.mjs'
import { cardText, eventsOf, git, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

type XteAlarm = ReturnType<typeof createXteAlarm>
type XteHit = { rule: string; detail: string; actuate: boolean } | null

// ---- 纯逻辑层：临时 git 仓 + 直调 createXteAlarm ----

function mkUnitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xte-act-unit-'))
  git(dir, 'init')
  git(dir, 'config user.email t@local')
  git(dir, 'config user.name t')
  git(dir, 'commit --allow-empty -m init')
  return dir
}

/** git 句柄/对象落盘滞后可能瞬时 EBUSY/ENOTEMPTY（win 高发）：退避重试兜底。 */
function rmRetry(p: string): void {
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(code) || i >= 5) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, [10, 50, 100, 250, 500][i])
    }
  }
}

/** 跑一个 worker 会话（before → 可选提交 → after），返回 after 的判定值。 */
function runSession(alarm: XteAlarm, wt: string, commit = false): XteHit {
  alarm.beforeWorkerSession()
  if (commit) git(wt, 'commit --allow-empty -m work')
  return alarm.afterWorkerSession()
}

describe('xte no_commit 双档 > 纯逻辑 4 象限', () => {
  it('observe + 命中：第 2 个零提交会话报警一次，actuate=false（只留痕），此后不重报', () => {
    const wt = mkUnitRepo()
    try {
      const qd = path.join(wt, 'logs', 't1')
      const logs: string[] = []
      const alarm = createXteAlarm(qd, wt, { mode: 'observe', log: (m: string) => logs.push(m) })
      expect(runSession(alarm, wt)).toBeNull() // 第 1 会话零提交：streak 1 不报
      const hit = runSession(alarm, wt) // 第 2 会话零提交：streak 2 报警
      expect(hit?.rule).toBe('no_commit')
      expect(hit?.actuate).toBe(false)
      expect(logs.join('\n')).toContain('只留痕不动作')
      const alarms = readEvents(qd).filter((e: { type: string }) => e.type === 'xte_alarm')
      expect(alarms).toHaveLength(1)
      expect(alarms[0]).toMatchObject({ rule: 'no_commit' })
      expect(String(alarms[0].detail)).toContain('零新提交')
      expect(runSession(alarm, wt)).toBeNull() // 已报过：不重报
      expect(readEvents(qd).filter((e: { type: string }) => e.type === 'xte_alarm')).toHaveLength(1)
    } finally {
      rmRetry(wt)
    }
  })

  it('actuate + 命中：返回 actuate=true（熔断落位由编排侧消费），日志措辞如实升级', () => {
    const wt = mkUnitRepo()
    try {
      const qd = path.join(wt, 'logs', 't1')
      const logs: string[] = []
      const alarm = createXteAlarm(qd, wt, { mode: 'actuate', log: (m: string) => logs.push(m) })
      expect(runSession(alarm, wt)).toBeNull() // streak 1：不动作（actuate 也要连续 2 次）
      const hit = runSession(alarm, wt) // streak 2：actuate 升级
      expect(hit?.rule).toBe('no_commit')
      expect(hit?.actuate).toBe(true)
      expect(logs.join('\n')).toContain('actuate')
      expect(logs.join('\n')).not.toContain('只留痕不动作') // actuate 档不得再说「不动作」
      expect(readEvents(qd).filter((e: { type: string }) => e.type === 'xte_alarm')).toHaveLength(1)
    } finally {
      rmRetry(wt)
    }
  })

  it('observe + 未命中：会话有新提交重置 streak，永不报警', () => {
    const wt = mkUnitRepo()
    try {
      const qd = path.join(wt, 'logs', 't1')
      const alarm = createXteAlarm(qd, wt, { mode: 'observe', log: () => {} })
      expect(runSession(alarm, wt)).toBeNull() // 零提交：streak 1
      expect(runSession(alarm, wt, true)).toBeNull() // 有提交：streak 清零
      expect(runSession(alarm, wt)).toBeNull() // 零提交：streak 1（不连续，不报）
      expect(readEvents(qd).filter((e: { type: string }) => e.type === 'xte_alarm')).toHaveLength(0)
    } finally {
      rmRetry(wt)
    }
  })

  it('actuate + 未命中：同样永不报警（actuate 只放宽动作档，不放宽判定口径）', () => {
    const wt = mkUnitRepo()
    try {
      const qd = path.join(wt, 'logs', 't1')
      const alarm = createXteAlarm(qd, wt, { mode: 'actuate', log: () => {} })
      expect(runSession(alarm, wt)).toBeNull()
      expect(runSession(alarm, wt, true)).toBeNull()
      expect(runSession(alarm, wt)).toBeNull()
      expect(readEvents(qd).filter((e: { type: string }) => e.type === 'xte_alarm')).toHaveLength(0)
    } finally {
      rmRetry(wt)
    }
  })

  it('actuate 档下 test_loop 恒不升级（只有 no_commit 有熔断语义）；resume 播种防重报', () => {
    const wt = mkUnitRepo()
    try {
      const qd = path.join(wt, 'logs', 't1')
      const alarm = createXteAlarm(qd, wt, { mode: 'actuate', log: () => {} })
      appendEvent(qd, 'gate_result', { gate: 'npm_test', result: 'fail' })
      appendEvent(qd, 'gate_result', { gate: 'npm_test', result: 'fail' })
      alarm.testLoop() // 命中 test_loop：只留痕
      const evs = readEvents(qd).filter((e: { type: string }) => e.type === 'xte_alarm')
      expect(evs).toHaveLength(1)
      expect(evs[0]).toMatchObject({ rule: 'test_loop' })
      // resume 跨进程：新实例从事件播种 fired，同规则不重报（actuate 档同口径）
      const alarm2 = createXteAlarm(qd, wt, { mode: 'actuate', log: () => {} })
      alarm2.testLoop()
      expect(readEvents(qd).filter((e: { type: string }) => e.type === 'xte_alarm')).toHaveLength(1)
    } finally {
      rmRetry(wt)
    }
  })
})

// ---- 集成层：mock 后端跑真实编排接线（4 象限）----

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

describe('xte no_commit 双档 > mock 集成 4 象限', () => {
  it('observe + 命中：xte_alarm 留痕、无 xte 熔断，任务按既有路径落 blocked（不改变流程）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'xte-act-obs')
      tryOrch(repo.root, 'run xte-act-obs --backend mock', { ORCH_MOCK_REVIEW_BLOCKERS: '1', ORCH_MOCK_NO_COMMIT: '1' })
      const evs = eventsOf(repo.root, 'xte-act-obs')
      expect(evs.filter((e) => e.type === 'xte_alarm' && e.rule === 'no_commit')).toHaveLength(1)
      expect(evs.filter((e) => e.type === 'circuit_breaker' && e.reason === 'xte_no_commit')).toHaveLength(0)
      expect(readCard(repo.root, 'blocked', 'xte-act-obs')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('actuate + 命中：第 2 个零提交会话末熔断——circuit_breaker(xte_no_commit) + 卡 blocked + 正常收敛不再开新会话', () => {
    const repo = mkRepo({ extra: { watchdog: { mode: 'actuate' } } })
    try {
      submitCard(repo.root, 'xte-act-halt')
      const r = runOrch(repo.root, 'run xte-act-halt --backend mock', { ORCH_MOCK_REVIEW_BLOCKERS: '1', ORCH_MOCK_NO_COMMIT: '1' })
      expect(r.status).toBe(0) // 与看门狗熔断同款：return 收敛走 finally，非 die
      expect(r.stdout).toContain('偏航熔断')
      const evs = eventsOf(repo.root, 'xte-act-halt')
      expect(evs.filter((e) => e.type === 'xte_alarm' && e.rule === 'no_commit')).toHaveLength(1)
      const breaks = evs.filter((e) => e.type === 'circuit_breaker' && e.reason === 'xte_no_commit')
      expect(breaks).toHaveLength(1)
      expect(String(breaks[0].detail)).toContain('零新提交')
      // 会话计数用 budget_baseline（每 worker 会话恰好 1 条；worker_spawned 被 mock 后端
      // 透传二次追加 + reviewer 会话复用同型事件，不可作会话计数口径）
      expect(evs.filter((e) => e.type === 'budget_baseline')).toHaveLength(2) // 第 2 会话末熔断：不再开第 3 个会话
      expect(readCard(repo.root, 'blocked', 'xte-act-halt')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('actuate + 未命中：每会话有提交，零偏航零熔断，照常落 awaiting-human', () => {
    const repo = mkRepo({ extra: { watchdog: { mode: 'actuate' } } })
    try {
      submitCard(repo.root, 'xte-act-ok')
      runOrch(repo.root, 'run xte-act-ok --backend mock') // mock 默认每会话 git commit
      const evs = eventsOf(repo.root, 'xte-act-ok')
      expect(evs.filter((e) => e.type === 'xte_alarm')).toHaveLength(0)
      expect(evs.filter((e) => e.type === 'circuit_breaker')).toHaveLength(0)
      expect(readCard(repo.root, 'awaiting-human', 'xte-act-ok')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('observe + 未命中：无报警，流程照常（对照组）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'xte-obs-ok')
      runOrch(repo.root, 'run xte-obs-ok --backend mock')
      expect(eventsOf(repo.root, 'xte-obs-ok').filter((e) => e.type === 'xte_alarm' && e.rule === 'no_commit')).toHaveLength(0)
      expect(readCard(repo.root, 'awaiting-human', 'xte-obs-ok')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

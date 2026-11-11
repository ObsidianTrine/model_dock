// D6.5 分层审核超时委托（autoapprove sweep）定向测试：
//   单元：workflow-config resolveAutoApprove 缺省 / 合法显式值 / 非法值回落告警；
//         run-lock acquireSchedulerLockRetry 有界重试（抢锁失败 60s×10 缺省，参数可注入）
//   e2e（mkRepo + mock 后端跑真实闭环到 awaiting-human）：
//     ① 超时 + blockers=0 → 按推荐自动合并（merged/，autoapprove_decision + merged auto:true）
//     ② 超时 + blockers>0 → 自动返工（doRetry 完整闭环），maxAutoRetry=1 第二次超限留人
//     ③ 无 review_verdict / 最后是 review_engine_failed → fail-closed 不动作
//     ④ 拍板窗口未过 → 不动作
//     ⑤ enabled=false → 只报告不动作（零事件零迁移）
//     ⑥ --dry-run → 只报告不动作
//     ⑦ drift 降级 → sweep 整体跳过 + autoapprove_skipped{drift_degraded} 留痕（二次去重）
//     ⑧ scope_outside 落位的卡超时 → 不自动批示（红线⑤：范围失控不该静默合并）
//     ⑨ 调度器锁被持有界重试：耗尽后放弃不批示（2026-11-11 巡航修复：旧实现单次抢锁
//       失败即退出，多卡 drain 期间 detached sweep 的自动批示静默落空；重试参数 env 注入）
//     ⑩ 重试窗口内锁释放 → 接管陈锁照常批示（不再静默失效）
//   spec 分层超时（opt-in，autoApprove.specBuild.enabled 缺省关）：显式开启 + approve_to_build
//     超时 → 自动拆卡（progress.json 幂等锚）；缺省不拆卡；rework 不动；动作带 specId 进 digest
// fail-closed 五条红线是回归锚：没有审查结论 / 范围失控的卡超时也绝不自动批示。

import { describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { writeSpec } from '../../.agents/scripts/orchestrator/spec.mjs'
import { appendEvent } from '../../.agents/scripts/orchestrator/events.mjs'
import { acquireSchedulerLockRetry, releaseSchedulerLock, schedulerLockPath } from '../../.agents/scripts/orchestrator/run-lock.mjs'
import { cardText, eventsOf, mkRepo, runOrch } from './helpers.js'

// timeoutMinutes=1：回拨 10 分钟的结论远超窗口；detached sweep（run 落位自动拉起）的
// 睡眠也只有 1.5 分钟，测试收尾后空转自灭，不拖累套件
const AA_CFG = { enabled: true, timeoutMinutes: 1, maxAutoRetry: 1 }

function queueDir(repo: string, state: string): string {
  return path.join(repo, '.agents', 'orchestrator', 'queue', state)
}

function cardIn(repo: string, state: string, id: string): boolean {
  return fs.existsSync(path.join(queueDir(repo, state), `${id}.md`))
}

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}): void {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

/** 把该卡最后一条 review_verdict 事件的时间戳回拨 N 分钟（模拟拍板窗口已过）。 */
function rewindLastVerdict(repo: string, id: string, minutes = 10): void {
  const f = path.join(repo, '.agents', 'orchestrator', 'logs', id, 'events.jsonl')
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = JSON.parse(lines[i]) as { type?: string; ts?: string }
    if (e.type === 'review_verdict') {
      e.ts = new Date(Date.now() - minutes * 60_000).toISOString()
      lines[i] = JSON.stringify(e)
      break
    }
  }
  fs.writeFileSync(f, `${lines.join('\n')}\n`)
}

/** 追加一条时间戳回拨的事件（模拟 blockers 审查结论 / 引擎故障收尾等现场）。 */
function appendRewoundEvent(repo: string, id: string, fields: Record<string, unknown>, minutesAgo = 10): void {
  const f = path.join(repo, '.agents', 'orchestrator', 'logs', id, 'events.jsonl')
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const last = JSON.parse(lines[lines.length - 1]) as { seq?: number }
  const ev = { ts: new Date(Date.now() - minutesAgo * 60_000).toISOString(), seq: (last.seq ?? 0) + 1, ...fields }
  fs.appendFileSync(f, `${JSON.stringify(ev)}\n`)
}

/** 本地 webhook 收信台（listen(0)，与 notify-digest.test.ts 同款——digest 断言用）。 */
function startWebhook(): Promise<{ url: string; posts: Array<{ title: string; body: string }>; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const posts: Array<{ title: string; body: string }> = []
    const srv = http.createServer((req, res) => {
      let data = ''
      req.on('data', (c: Buffer) => (data += c.toString()))
      req.on('end', () => {
        let title = ''
        let body = ''
        try {
          const j = JSON.parse(data)
          title = String(j.title ?? '')
          body = String(j.body ?? '')
        } catch {
          body = data
        }
        posts.push({ title, body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        posts,
        close: () => new Promise((r) => srv.close(() => r())),
      })
    })
  })
}

describe('workflow-config > resolveAutoApprove（D6.5）', () => {
  function cfgOf(extra: Record<string, unknown>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cfg-'))
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify({ baseBranch: 'main', ...extra }))
    try {
      return loadWorkflowConfig(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('键缺失 → 缺省 { enabled: true, timeoutMinutes: 3, maxAutoRetry: 1, specBuild: { enabled: false } }，不告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(cfgOf({}).autoApprove).toEqual({ enabled: true, timeoutMinutes: 3, maxAutoRetry: 1, specBuild: { enabled: false } })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('合法显式值生效（specBuild.enabled 为独立开关：任务卡自动合并缺省语义不变，spec 拆卡缺省关）', () => {
    expect(cfgOf({ autoApprove: { enabled: true, timeoutMinutes: 7, maxAutoRetry: 2 } }).autoApprove).toEqual({ enabled: true, timeoutMinutes: 7, maxAutoRetry: 2, specBuild: { enabled: false } })
    expect(cfgOf({ autoApprove: { enabled: false } }).autoApprove).toEqual({ enabled: false, timeoutMinutes: 3, maxAutoRetry: 1, specBuild: { enabled: false } })
    expect(cfgOf({ autoApprove: { specBuild: { enabled: true } } }).autoApprove.specBuild).toEqual({ enabled: true })
    expect(cfgOf({ autoApprove: { specBuild: { enabled: false } } }).autoApprove.specBuild).toEqual({ enabled: false })
  })

  it('非法值回落缺省并逐项 console.warn（enabled 非布尔 / 非正整数 timeout / 负数 retry / specBuild 非对象 / specBuild.enabled 非布尔 / 整键非对象）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(cfgOf({ autoApprove: { enabled: 'yes' } }).autoApprove).toEqual({ enabled: true, timeoutMinutes: 3, maxAutoRetry: 1, specBuild: { enabled: false } })
      expect(cfgOf({ autoApprove: { timeoutMinutes: 0 } }).autoApprove.timeoutMinutes).toBe(3)
      expect(cfgOf({ autoApprove: { timeoutMinutes: -2 } }).autoApprove.timeoutMinutes).toBe(3)
      expect(cfgOf({ autoApprove: { timeoutMinutes: 1.5 } }).autoApprove.timeoutMinutes).toBe(3)
      expect(cfgOf({ autoApprove: { maxAutoRetry: -1 } }).autoApprove.maxAutoRetry).toBe(1)
      expect(cfgOf({ autoApprove: { maxAutoRetry: 'x' } }).autoApprove.maxAutoRetry).toBe(1)
      expect(cfgOf({ autoApprove: { specBuild: 'on' } }).autoApprove.specBuild).toEqual({ enabled: false })
      expect(cfgOf({ autoApprove: { specBuild: { enabled: 'yes' } } }).autoApprove.specBuild).toEqual({ enabled: false })
      expect(cfgOf({ autoApprove: 'on' }).autoApprove).toEqual({ enabled: true, timeoutMinutes: 3, maxAutoRetry: 1, specBuild: { enabled: false } })
      expect(warn.mock.calls.length).toBeGreaterThanOrEqual(8)
      expect(String(warn.mock.calls[0]?.[0])).toContain('autoApprove')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('orchestrator autoapprove > e2e（mock 闭环）', () => {
  it('① 超时 + blockers=0 → 按推荐自动合并', () => {
    const repo = mkRepo({ workerBackend: 'mock', extra: { autoApprove: AA_CFG } })
    try {
      submitCard(repo.root, 'aa-merge', { gate: 'L3' })
      runOrch(repo.root, 'run aa-merge --backend mock')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-merge')).toBe(true)
      rewindLastVerdict(repo.root, 'aa-merge')
      const r = runOrch(repo.root, 'autoapprove')
      expect(cardIn(repo.root, 'merged', 'aa-merge')).toBe(true)
      expect(cardIn(repo.root, 'awaiting-human', 'aa-merge')).toBe(false)
      expect(r.stdout).toContain('自动合并')
      const evts = eventsOf(repo.root, 'aa-merge')
      expect(evts.some((e) => e.type === 'autoapprove_decision' && e.decision === 'merge' && e.source === 'timeout')).toBe(true)
      expect(evts.some((e) => e.type === 'merged' && e.auto === true)).toBe(true)
    } finally {
      repo.cleanup()
    }
  }, 180_000)

  it('② 超时 + blockers>0 → 自动返工；maxAutoRetry=1 第二次超限留人', () => {
    const repo = mkRepo({ workerBackend: 'mock', extra: { autoApprove: AA_CFG } })
    try {
      submitCard(repo.root, 'aa-retry', { gate: 'L3' })
      runOrch(repo.root, 'run aa-retry --backend mock')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-retry')).toBe(true)
      // 注入一条 blockers=1 的审查结论（回拨 10 分钟）——「审查判了阻塞」的推荐是返工不是合并
      appendRewoundEvent(repo.root, 'aa-retry', { type: 'review_verdict', blockers: 1, suggestions: 0, notes: 0 })
      runOrch(repo.root, 'autoapprove')
      // doRetry 走完整闭环（mock 干净环境重跑）→ 卡重新落回 awaiting-human，而非合并
      expect(cardIn(repo.root, 'awaiting-human', 'aa-retry')).toBe(true)
      expect(cardIn(repo.root, 'merged', 'aa-retry')).toBe(false)
      let evts = eventsOf(repo.root, 'aa-retry')
      expect(evts.some((e) => e.type === 'autoapprove_decision' && e.decision === 'retry' && e.source === 'timeout')).toBe(true)
      expect(evts.some((e) => e.type === 'human_gate' && e.decision === 'retry' && String(e.note ?? '').includes('超时自动按审查结论返工（分层审核）'))).toBe(true)
      // 第二次：maxAutoRetry=1 已用尽 → 超限跳过留人（fail-closed：不合并也不无限返工）
      appendRewoundEvent(repo.root, 'aa-retry', { type: 'review_verdict', blockers: 1, suggestions: 0, notes: 0 })
      const r2 = runOrch(repo.root, 'autoapprove')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-retry')).toBe(true)
      evts = eventsOf(repo.root, 'aa-retry')
      expect(evts.filter((e) => e.type === 'autoapprove_decision' && e.decision === 'retry')).toHaveLength(1)
      expect(evts.some((e) => e.type === 'autoapprove_skipped' && e.reason === 'retry_limit')).toBe(true)
      expect(r2.stdout).toContain('返工超限留人')
    } finally {
      repo.cleanup()
    }
  }, 240_000)

  it('③a 无 review_verdict 的手造闸门卡 → fail-closed 不动作', () => {
    const repo = mkRepo({ extra: { autoApprove: AA_CFG } })
    try {
      submitCard(repo.root, 'aa-noverdict')
      fs.renameSync(path.join(queueDir(repo.root, 'pending'), 'aa-noverdict.md'), path.join(queueDir(repo.root, 'awaiting-human'), 'aa-noverdict.md'))
      const r = runOrch(repo.root, 'autoapprove')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-noverdict')).toBe(true)
      expect(cardIn(repo.root, 'merged', 'aa-noverdict')).toBe(false)
      expect(eventsOf(repo.root, 'aa-noverdict').some((e) => e.type === 'autoapprove_skipped' && e.reason === 'no_verdict')).toBe(true)
      expect(r.stdout).toContain('fail-closed')
    } finally {
      repo.cleanup()
    }
  })

  it('③b 最后是 review_engine_failed → fail-closed 不动作', () => {
    const repo = mkRepo({ workerBackend: 'mock', extra: { autoApprove: AA_CFG } })
    try {
      submitCard(repo.root, 'aa-engfail', { gate: 'L3' })
      runOrch(repo.root, 'run aa-engfail --backend mock')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-engfail')).toBe(true)
      rewindLastVerdict(repo.root, 'aa-engfail')
      // 引擎故障收尾晚于 review_verdict：结论不可信，绝不按旧结论自动合并
      appendRewoundEvent(repo.root, 'aa-engfail', { type: 'review_engine_failed', backend: 'mock', exitCode: 1 }, 5)
      const r = runOrch(repo.root, 'autoapprove')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-engfail')).toBe(true)
      expect(cardIn(repo.root, 'merged', 'aa-engfail')).toBe(false)
      expect(eventsOf(repo.root, 'aa-engfail').some((e) => e.type === 'autoapprove_skipped' && e.reason === 'no_verdict')).toBe(true)
      expect(r.stdout).toContain('fail-closed')
    } finally {
      repo.cleanup()
    }
  }, 180_000)

  it('④ 拍板窗口未过 → 不动作留人', () => {
    const repo = mkRepo({ workerBackend: 'mock', extra: { autoApprove: AA_CFG } })
    try {
      submitCard(repo.root, 'aa-fresh', { gate: 'L3' })
      runOrch(repo.root, 'run aa-fresh --backend mock')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-fresh')).toBe(true)
      const r = runOrch(repo.root, 'autoapprove') // 结论是新鲜的，不回拨
      expect(cardIn(repo.root, 'awaiting-human', 'aa-fresh')).toBe(true)
      expect(eventsOf(repo.root, 'aa-fresh').some((e) => e.type === 'autoapprove_decision')).toBe(false)
      expect(r.stdout).toContain('拍板窗口未过')
    } finally {
      repo.cleanup()
    }
  }, 180_000)

  it('⑤ enabled=false → 只报告不动作（零事件零迁移）', () => {
    const repo = mkRepo({ workerBackend: 'mock', extra: { autoApprove: { enabled: false, timeoutMinutes: 1, maxAutoRetry: 1 } } })
    try {
      submitCard(repo.root, 'aa-off', { gate: 'L3' })
      runOrch(repo.root, 'run aa-off --backend mock')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-off')).toBe(true)
      rewindLastVerdict(repo.root, 'aa-off')
      const r = runOrch(repo.root, 'autoapprove')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-off')).toBe(true)
      expect(eventsOf(repo.root, 'aa-off').some((e) => String(e.type).startsWith('autoapprove_'))).toBe(false)
      expect(r.stdout).toContain('enabled=false')
      expect(r.stdout).toContain('建议，未执行')
    } finally {
      repo.cleanup()
    }
  }, 180_000)

  it('⑥ --dry-run → 只报告不动作', () => {
    const repo = mkRepo({ workerBackend: 'mock', extra: { autoApprove: AA_CFG } })
    try {
      submitCard(repo.root, 'aa-dry', { gate: 'L3' })
      runOrch(repo.root, 'run aa-dry --backend mock')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-dry')).toBe(true)
      rewindLastVerdict(repo.root, 'aa-dry')
      const r = runOrch(repo.root, 'autoapprove --dry-run')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-dry')).toBe(true)
      expect(cardIn(repo.root, 'merged', 'aa-dry')).toBe(false)
      expect(eventsOf(repo.root, 'aa-dry').some((e) => String(e.type).startsWith('autoapprove_'))).toBe(false)
      expect(r.stdout).toContain('dry-run')
      expect(r.stdout).toContain('自动合并（建议，未执行）')
    } finally {
      repo.cleanup()
    }
  }, 180_000)

  it('⑦ drift 降级期间 sweep 整体跳过并留痕（二次 sweep 去重）', () => {
    const repo = mkRepo({ workerBackend: 'mock', extra: { autoApprove: AA_CFG } })
    try {
      submitCard(repo.root, 'aa-degraded', { gate: 'L3' })
      runOrch(repo.root, 'run aa-degraded --backend mock')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-degraded')).toBe(true)
      rewindLastVerdict(repo.root, 'aa-degraded')
      fs.mkdirSync(path.join(repo.root, '.agents', 'orchestrator'), { recursive: true })
      fs.writeFileSync(path.join(repo.root, '.agents', 'orchestrator', 'degraded.json'), JSON.stringify({ degraded_at: new Date().toISOString(), reason: '手工降级（测试）' }))
      runOrch(repo.root, 'autoapprove')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-degraded')).toBe(true)
      expect(cardIn(repo.root, 'merged', 'aa-degraded')).toBe(false)
      const evts = eventsOf(repo.root, 'aa-degraded')
      expect(evts.some((e) => e.type === 'autoapprove_skipped' && e.reason === 'drift_degraded')).toBe(true)
      // 二次 sweep：同一原因不重复留痕，也不动作
      runOrch(repo.root, 'autoapprove')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-degraded')).toBe(true)
      expect(eventsOf(repo.root, 'aa-degraded').filter((e) => e.type === 'autoapprove_skipped' && e.reason === 'drift_degraded')).toHaveLength(1)
    } finally {
      repo.cleanup()
    }
  }, 180_000)

  it('⑧ scope_outside 落位的卡超时不自动批示（红线⑤：范围失控不该静默合并）', () => {
    const repo = mkRepo({ extra: { autoApprove: AA_CFG } })
    try {
      submitCard(repo.root, 'aa-scope')
      fs.renameSync(path.join(queueDir(repo.root, 'pending'), 'aa-scope.md'), path.join(queueDir(repo.root, 'awaiting-human'), 'aa-scope.md'))
      // 手造闸门现场：审查结论 blockers=0（推荐合并）+ 落位原因 scope_outside，均超拍板窗口
      const logsDir = path.join(repo.root, '.agents', 'orchestrator', 'logs', 'aa-scope')
      fs.mkdirSync(logsDir, { recursive: true })
      appendEvent(logsDir, 'task_accepted', {})
      appendRewoundEvent(repo.root, 'aa-scope', { type: 'review_verdict', blockers: 0, suggestions: 0, notes: 0 })
      appendRewoundEvent(repo.root, 'aa-scope', { type: 'awaiting_human', reason: 'scope_outside' }, 9)
      const r = runOrch(repo.root, 'autoapprove')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-scope')).toBe(true)
      expect(cardIn(repo.root, 'merged', 'aa-scope')).toBe(false)
      const evts = eventsOf(repo.root, 'aa-scope')
      expect(evts.some((e) => e.type === 'autoapprove_skipped' && e.reason === 'scope_outside')).toBe(true)
      expect(evts.some((e) => e.type === 'autoapprove_decision')).toBe(false) // 不合并也不返工
      expect(r.stdout).toContain('范围失控留人')
      // 二次 sweep：同一原因不重复留痕，也不动作
      runOrch(repo.root, 'autoapprove')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-scope')).toBe(true)
      expect(eventsOf(repo.root, 'aa-scope').filter((e) => e.type === 'autoapprove_skipped' && e.reason === 'scope_outside')).toHaveLength(1)
    } finally {
      repo.cleanup()
    }
  })

  it('⑨ 调度器锁被持有界重试：耗尽后放弃不批示（重试参数 env 注入，2026-11-11 巡航修复）', () => {
    const repo = mkRepo({ extra: { autoApprove: AA_CFG } })
    try {
      submitCard(repo.root, 'aa-lockwait', { gate: 'L3' })
      fs.renameSync(path.join(queueDir(repo.root, 'pending'), 'aa-lockwait.md'), path.join(queueDir(repo.root, 'awaiting-human'), 'aa-lockwait.md'))
      // 锁文件指向还活着的测试进程——sweep 子进程判「他人持有且存活」，有界重试后放弃
      fs.mkdirSync(path.join(repo.root, '.agents', 'orchestrator'), { recursive: true })
      fs.writeFileSync(
        schedulerLockPath(repo.root),
        JSON.stringify({ pid: process.pid, cmd: 'drain', acquired_at: new Date().toISOString() }),
      )
      const r = runOrch(repo.root, 'autoapprove', { ORCH_AA_LOCK_RETRY_MS: '30', ORCH_AA_LOCK_RETRY_MAX: '2' })
      expect(r.stdout).toContain('重试（1/2）')
      expect(r.stdout).toContain('重试（2/2）')
      expect(r.stdout).toContain('放弃')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-lockwait')).toBe(true)
      expect(cardIn(repo.root, 'merged', 'aa-lockwait')).toBe(false)
      expect(eventsOf(repo.root, 'aa-lockwait').some((e) => String(e.type).startsWith('autoapprove_'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('⑩ 重试窗口内锁释放（陈锁接管）→ 拿到锁照常批示（不再单次失败即静默退出）', async () => {
    const repo = mkRepo({ workerBackend: 'mock', extra: { autoApprove: AA_CFG } })
    try {
      submitCard(repo.root, 'aa-lockok', { gate: 'L3' })
      runOrch(repo.root, 'run aa-lockok --backend mock')
      expect(cardIn(repo.root, 'awaiting-human', 'aa-lockok')).toBe(true)
      rewindLastVerdict(repo.root, 'aa-lockok')
      // 锁属主是「孤儿 sleeper」（1.2s 后自灭）：经中转进程派生后孤儿化（launchd/init 收尸）
      // ——若直接做测试进程的子进程，测试进程阻塞在 execSync 里无法 reap，sleeper 成僵尸，
      // sweep 的 isAlive 在整个 runOrch 期间恒真，重试永远不成功（实测踩中）
      const sleeperPid = await new Promise<number>((resolve, reject) => {
        const middle = spawn(
          process.execPath,
          [
            '-e',
            `const { spawn } = require('node:child_process');
             const c = spawn(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200)'], { stdio: 'ignore', detached: true });
             c.unref();
             process.stdout.write(String(c.pid));`,
          ],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        )
        let out = ''
        middle.stdout?.on('data', (c: Buffer) => (out += c.toString()))
        middle.on('close', () => resolve(Number(out.trim())))
        middle.on('error', reject)
      })
      expect(sleeperPid).toBeGreaterThan(0)
      fs.mkdirSync(path.join(repo.root, '.agents', 'orchestrator'), { recursive: true })
      fs.writeFileSync(
        schedulerLockPath(repo.root),
        JSON.stringify({ pid: sleeperPid, cmd: 'drain', acquired_at: new Date().toISOString() }),
      )
      const r = runOrch(repo.root, 'autoapprove', { ORCH_AA_LOCK_RETRY_MS: '100', ORCH_AA_LOCK_RETRY_MAX: '30' })
      expect(r.stdout).toContain('重试（1/30）')
      expect(cardIn(repo.root, 'merged', 'aa-lockok')).toBe(true)
      expect(r.stdout).toContain('自动合并')
      expect(eventsOf(repo.root, 'aa-lockok').some((e) => e.type === 'autoapprove_decision' && e.decision === 'merge' && e.source === 'timeout')).toBe(true)
    } finally {
      repo.cleanup()
    }
  }, 180_000)
})

describe('orchestrator autoapprove > spec 分层超时（opt-in：autoApprove.specBuild.enabled，2026-11-11 巡航修复）', () => {
  // spec 拆卡是「拆卡人工拍板」闸门的委托——缺省关，显式开启才生效（与卡级 enabled 缺省开不同轴）
  const SPEC_AA_CFG = { ...AA_CFG, specBuild: { enabled: true } }

  function fixtureSpecVerdict(repo: string, id: string, buildReady: string, minutesAgo = 10): void {
    writeSpec(repo, {
      id,
      title: 'autoapprove fixture 规格',
      requirements: '# 需求\n\n- 作为用户，我希望 fixture 就绪。',
      design: '# 技术设计\n\n现状：docs 占位。\n\n## 方案\n\n新增说明文档。\n',
      tasks: ['## 任务 1:写文档', '- 目标: 新增 docs/aa-spec.md', '- 文件: docs/**', '- 完成条件: docs/aa-spec.md 存在', '- 依赖: 无'].join('\n'),
    })
    fs.writeFileSync(
      path.join(repo, '.agents', 'orchestrator', 'specs', id, 'review-verdict.json'),
      JSON.stringify({ schema: 'spec-verdict/1', spec: id, created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), usage: { build_ready: buildReady } }),
    )
  }

  it('缺省（未开 specBuild）→ approve_to_build 超时也不自动拆卡（拆卡人工闸缺省不委托）', () => {
    const repo = mkRepo({ extra: { autoApprove: AA_CFG } })
    try {
      fixtureSpecVerdict(repo.root, 'aa-spec-default-off', 'approve_to_build')
      const r = runOrch(repo.root, 'autoapprove')
      expect(fs.existsSync(path.join(queueDir(repo.root, 'pending'), 'aa-spec-default-off-t1.md'))).toBe(false)
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'specs', 'aa-spec-default-off', 'progress.json'))).toBe(false)
      expect(r.stdout).not.toContain('spec 自动拆卡')
      expect(r.stdout).not.toContain('spec 拍板窗口未过')
    } finally {
      repo.cleanup()
    }
  })

  it('显式开启 + approve_to_build 超时 → 自动拆卡进 pending/（progress.json 幂等锚）', () => {
    const repo = mkRepo({ extra: { autoApprove: SPEC_AA_CFG } })
    try {
      fixtureSpecVerdict(repo.root, 'aa-spec', 'approve_to_build')
      const r = runOrch(repo.root, 'autoapprove')
      expect(fs.existsSync(path.join(queueDir(repo.root, 'pending'), 'aa-spec-t1.md'))).toBe(true)
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'specs', 'aa-spec', 'progress.json'))).toBe(true)
      expect(r.stdout).toContain('spec 自动拆卡')
      // 已 build 过（progress.json 在）→ 二次 sweep 不重复拆卡
      fs.rmSync(path.join(queueDir(repo.root, 'pending'), 'aa-spec-t1.md'))
      runOrch(repo.root, 'autoapprove')
      expect(fs.existsSync(path.join(queueDir(repo.root, 'pending'), 'aa-spec-t1.md'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('显式开启后 rework/blocked 结论与窗口未过 → 仍不拆卡（红线：审查有 blockers 的 spec 永不自动放行）', () => {
    const repo = mkRepo({ extra: { autoApprove: SPEC_AA_CFG } })
    try {
      fixtureSpecVerdict(repo.root, 'aa-spec2', 'rework')
      fixtureSpecVerdict(repo.root, 'aa-spec3', 'approve_to_build', 0) // 窗口未过
      const r = runOrch(repo.root, 'autoapprove')
      expect(fs.existsSync(path.join(queueDir(repo.root, 'pending'), 'aa-spec2-t1.md'))).toBe(false)
      expect(fs.existsSync(path.join(queueDir(repo.root, 'pending'), 'aa-spec3-t1.md'))).toBe(false)
      expect(r.stdout).toContain('spec 拍板窗口未过')
    } finally {
      repo.cleanup()
    }
  })

  it('opt-in 拆卡动作进 digest 队列带 specId（规格尾行接线，notifyAutoApproveAction spec=true 透传 taskId）', async () => {
    const hook = await startWebhook()
    const prev = process.env.AGENTS_ORCH_WEBHOOK
    process.env.AGENTS_ORCH_WEBHOOK = hook.url
    const repo = mkRepo({
      extra: {
        projectName: 'digest-e2e',
        autoApprove: SPEC_AA_CFG,
        notify: { digest: { enabled: true, quietWindowSec: 1 } }, // detached flusher 1s 后发，测后等它自灭
      },
    })
    try {
      fixtureSpecVerdict(repo.root, 'aa-spec', 'approve_to_build')
      runOrch(repo.root, 'autoapprove')
      expect(fs.existsSync(path.join(queueDir(repo.root, 'pending'), 'aa-spec-t1.md'))).toBe(true)
      await new Promise((r) => setTimeout(r, 2500)) // 等 detached flush（quietWindowSec=1）发完自灭
      const digestPosts = hook.posts.filter((p) => p.title.startsWith('【DigestE2e】'))
      expect(digestPosts.length).toBeGreaterThanOrEqual(1)
      expect(digestPosts.some((p) => p.body.includes('📋 规格 aa-spec：0/1 ✅'))).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.AGENTS_ORCH_WEBHOOK
      else process.env.AGENTS_ORCH_WEBHOOK = prev
      await hook.close()
      repo.cleanup()
    }
  }, 30_000)
})

describe('orchestrator autoapprove > acquireSchedulerLockRetry（run-lock 有界重试）', () => {
  function tmpRepo(): { root: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-lockretry-'))
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
  }

  it('锁被活进程持有：每轮 log 一行重试、maxAttempts 耗尽 log 放弃并返回 held:false', async () => {
    const repo = tmpRepo()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      fs.mkdirSync(path.join(repo.root, '.agents', 'orchestrator'), { recursive: true })
      // 本测试进程就是「活的持有者」——isAlive 为真，重试永不成功
      fs.writeFileSync(schedulerLockPath(repo.root), JSON.stringify({ pid: process.pid, cmd: 'drain', acquired_at: new Date().toISOString() }))
      const lock = await acquireSchedulerLockRetry(repo.root, 'autoapprove', { intervalMs: 10, maxAttempts: 3 })
      expect(lock.held).toBe(false)
      expect(lock.owner).toMatchObject({ pid: process.pid, cmd: 'drain' })
      const logs = logSpy.mock.calls.map((c) => String(c[0]))
      expect(logs.some((l) => l.includes('重试（1/3）'))).toBe(true)
      expect(logs.some((l) => l.includes('重试（2/3）'))).toBe(true)
      expect(logs.some((l) => l.includes('重试（3/3）'))).toBe(true)
      expect(logs.some((l) => l.includes('放弃'))).toBe(true)
    } finally {
      logSpy.mockRestore()
      repo.cleanup()
    }
  })

  it('锁空闲 / 陈锁（属主已退出）：首轮即拿到或自动接管，无重试 log', async () => {
    const repo = tmpRepo()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      // 空闲：立即持有
      let lock = await acquireSchedulerLockRetry(repo.root, 'autoapprove', { intervalMs: 10, maxAttempts: 3 })
      expect(lock.held).toBe(true)
      expect(logSpy.mock.calls.map((c) => String(c[0])).some((l) => l.includes('重试（'))).toBe(false)
      releaseSchedulerLock(repo.root)
      // 陈锁：属主用已退出的 pid（取一条已结束进程的 pid 现场造）——自动接管
      const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid
      fs.mkdirSync(path.join(repo.root, '.agents', 'orchestrator'), { recursive: true })
      fs.writeFileSync(schedulerLockPath(repo.root), JSON.stringify({ pid: dead, cmd: 'nightly', acquired_at: new Date().toISOString() }))
      lock = await acquireSchedulerLockRetry(repo.root, 'autoapprove', { intervalMs: 10, maxAttempts: 3 })
      expect(lock.held).toBe(true)
    } finally {
      logSpy.mockRestore()
      releaseSchedulerLock(repo.root)
      repo.cleanup()
    }
  })
})

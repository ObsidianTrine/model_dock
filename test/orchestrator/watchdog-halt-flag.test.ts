// DM-03（2026-11-25 审计）：看门狗熔断停机标志置位过晚。
// 证据：circuit_break 分支顺序是 killTree → moveCard → await settleNotify → watchdogHalted=true；
// await 期间 killTree 触发的 worker close 先被派发，主循环读到 watchdogHalted=false，越过
// 「熔断收敛」防线——瞬时故障判定会把卡在已落位（blocked/reviewing）后再派一个 worker。
// 修法两条：① watchdogHalted 在 killTree 之后、第一个 await 之前置位；② 内层会话循环顶
// 断言卡仍在 running/，不在则 return（不派新会话）。
//
// 可测性：watchdogSpawn 在 mock 后端下为 null（判定会话不跑），settleNotify 也没有测试注入缝，
// 无法从 CLI 集成路径真实触发 circuit_break。这里用两条互补断言钉住修复：
//  - 源码顺序锚点：熔断分支的置位顺序（修前红：flag 在 await 之后）；
//  - 等效交错集成：瞬时故障重试等待期间把卡移出 running/（模拟看门狗落位），主循环不得再派
//    worker——正是审计描述的交错路径。

import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cardText, eventsOf, mkRepo } from './helpers.js'
import { ensureQueue, moveCard, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'

const ORCH = fileURLToPath(new URL('../../.agents/scripts/orchestrator.mjs', import.meta.url))

/** 截取 runWatchdogCheck 的 circuit_break 分支（到该函数 catch 之前）。 */
function circuitBreakBlock(): string {
  const src = fs.readFileSync(ORCH, 'utf8')
  const start = src.indexOf("} else if (action === 'circuit_break') {")
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf('    } catch {', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('watchdog halt flag > 熔断落位顺序（源码锚点）', () => {
  it('killTree 之后、第一个 await settleNotify 之前置位 watchdogHalted', () => {
    const block = circuitBreakBlock()
    const killIdx = block.indexOf('killTree(livePid)')
    const flagIdx = block.indexOf('watchdogHalted = true')
    // 用真实调用形态锚定（注释里也出现「await settleNotify」字样，不能只搜方法名）
    const awaitIdx = block.indexOf('await settleNotify(repoRoot')
    expect(killIdx).toBeGreaterThan(-1)
    expect(flagIdx).toBeGreaterThan(killIdx)
    // 修前红：置位在 await 之后，await 期间派发的 close 事件会越过防线
    expect(awaitIdx).toBeGreaterThan(flagIdx)
  })

  it('内层会话循环顶：派发前断言卡仍在 running/，不在则 return', () => {
    const src = fs.readFileSync(ORCH, 'utf8')
    const guardIdx = src.indexOf('const liveCard = findCard(root, taskId)')
    const sessionIdx = src.indexOf('const sessionStartMs = Date.now()')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(sessionIdx).toBeGreaterThan(guardIdx) // 断言在会话起点（派发）之前
    const head = src.slice(guardIdx, sessionIdx)
    expect(head).toMatch(/if \(!liveCard \|\| liveCard\.state !== 'running'\)/)
    expect(head).toMatch(/return;/)
  })
})

describe('watchdog halt flag > 卡离开 running 后不再派发（等效交错集成）', () => {
  it('瞬时故障重试等待期间卡被落位 blocked → 主循环收敛，不再 spawn 第二个 worker', async () => {
    const repo = mkRepo()
    let child: ReturnType<typeof spawn> | null = null
    try {
      const root = queueRoot(repo.root)
      ensureQueue(root)
      fs.writeFileSync(path.join(root, 'running', 'halt-guard.md'), cardText({ id: 'halt-guard' }))
      const out: string[] = []
      child = spawn(process.execPath, [ORCH, 'run', 'halt-guard', '--backend', 'mock'], {
        cwd: repo.root,
        env: { ...process.env, ORCH_MOCK_TRANSIENT: '1', ORCH_RETRY_WAIT_MS: '1500' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', (d) => out.push(String(d)))
      child.stderr!.setEncoding('utf8')
      child.stderr!.on('data', (d) => out.push(String(d)))

      // worker_retry 写于退避等待之前：等到它 = 主循环正处在 await 里，此时卡仍在 running/
      const deadline = Date.now() + 30_000
      for (;;) {
        if (eventsOf(repo.root, 'halt-guard').some((e) => e.type === 'worker_retry')) break
        if (Date.now() > deadline) throw new Error('等待 worker_retry 超时（mock 瞬时故障未触发）')
        await new Promise((r) => setTimeout(r, 25))
      }
      // 模拟看门狗落位：熔断分支会把卡 moveCard 到 blocked/（有提交则 reviewing/）
      moveCard(root, 'halt-guard', 'running', 'blocked')

      const code = await new Promise<number | null>((resolve) => child!.once('close', resolve))
      const events = eventsOf(repo.root, 'halt-guard')
      const retries = events.filter((e) => e.type === 'worker_retry')
      // 只有一次瞬时重试 = 主循环在循环顶收敛；修前会继续派第二个 worker（retries ≥ 2）
      expect(retries).toHaveLength(1)
      expect(code).toBe(0)
      expect(out.join('')).toContain('已离开 running')
      expect(fs.existsSync(path.join(root, 'blocked', 'halt-guard.md'))).toBe(true)
    } finally {
      if (child && child.exitCode === null) {
        try { child.kill() } catch { /* 已退出 */ }
      }
      repo.cleanup()
    }
  }, 120_000)
})

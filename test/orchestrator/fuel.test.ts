// B5 燃油软告警测试：Budget 低油量（80%）单测（直接 import budget.mjs）+ mock 集成
// （budget_low_fuel 事件 + 收尾令注入 inbox）。软告警不降硬熔断——断言无 circuit_breaker。

import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Budget } from '../../.agents/scripts/orchestrator/budget.mjs'
import { cardText, eventsOf, mkRepo, runOrch } from './helpers.js'

function mkCard(overrides: Record<string, unknown> = {}) {
  return { meta: { budget: { max_tokens: 7500, max_wall_minutes: 10, ...overrides } } }
}

describe('budget > 低油量单测（tokens 路径）', () => {
  it('account 恰好 80% 触发一次；继续涨到 85% 不重复触发', () => {
    const emit = vi.fn()
    const b = new Budget(mkCard(), emit)
    b.account(4200, 1800) // 6000/7500 = 80%（mock 会话 usage 的同款数字）
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({ kind: 'tokens', pct: 80, tokens_in: 6000 })
    b.account(1500, 375) // 6375/7500 = 85%——低水位标志位已置，不再触发
    expect(emit).toHaveBeenCalledTimes(1)
    expect(b.tripped).toBe(false) // 软告警不是熔断
  })

  it('不足 80% 不触发；恰好 80% 必命中（交叉相乘整数比较，0.8 浮点误差不漏报）', () => {
    const emit = vi.fn()
    const b = new Budget(mkCard(), emit)
    b.account(5999, 0) // 79.99%：不触发
    expect(emit).not.toHaveBeenCalled()
    const b2 = new Budget(mkCard(), emit)
    b2.account(6000, 0) // 恰好 80%：`tokens >= max*0.8` 的浮点写法（6000 >= 6000.0000000000004）会漏报，交叉相乘必须命中
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('硬熔断阈值不变：超 100% 仍 trip，且不再发软告警', () => {
    const emit = vi.fn()
    const b = new Budget(mkCard({ max_tokens: 5000 }), emit)
    b.account(4200, 1800) // 6000 > 5000：先过 80% 触发软告警，再超限熔断
    expect(emit).toHaveBeenCalledTimes(1)
    expect(b.tripped).toBe(true)
    expect(b.tripReason?.reason).toBe('max_tokens')
  })
})

describe('budget > 低油量单测（wall 定时器路径）', () => {
  it('wall 过 80% 定时器触发一次回调（fake timers，不真等）；硬熔断定时器独立', () => {
    vi.useFakeTimers()
    try {
      const emit = vi.fn()
      const b = new Budget(mkCard({ max_wall_minutes: 10 }), emit) // 硬熔断 600s，软告警 480s
      vi.advanceTimersByTime(480_000)
      expect(emit).toHaveBeenCalledTimes(1)
      expect(emit).toHaveBeenCalledWith({ kind: 'wall', pct: 80 })
      vi.advanceTimersByTime(120_000) // 到 600s：硬熔断照常 trip（软告警不降熔断）
      expect(b.tripped).toBe(true)
      expect(b.tripReason?.reason).toBe('max_wall_minutes')
      expect(emit).toHaveBeenCalledTimes(1) // wall 软告警仍只一次
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('orchestrator 燃油软告警 > 集成（mock）', () => {
  it('80% 阈值：budget_low_fuel 事件留痕 + 收尾令注入 inbox；硬熔断不误触', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-fuel-low.md')
      fs.writeFileSync(cardFile, cardText({ id: 'fuel-low', budget: { max_tokens: 7500 } }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run fuel-low --backend mock')

      const low = eventsOf(repo.root, 'fuel-low').filter((e) => e.type === 'budget_low_fuel')
      expect(low).toHaveLength(1) // 单会话恰好触顶一次；重复触发即标志位失效
      expect(low[0]).toMatchObject({ kind: 'tokens', pct: 80, tokens_in: 6000 })

      const inbox = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'fuel-low', 'inbox.md'), 'utf8')
      expect(inbox).toContain('【船长收尾令】燃油余量不足 20%')
      expect(inbox).toContain('不要再开新战线')

      // 软告警不降熔断：6000 < 7500，全程无 circuit_breaker
      expect(eventsOf(repo.root, 'fuel-low').map((e) => e.type)).not.toContain('circuit_breaker')
    } finally {
      repo.cleanup()
    }
  })

  it('余量充足（>80%）不告警、不写 inbox', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-fuel-ok.md')
      fs.writeFileSync(cardFile, cardText({ id: 'fuel-ok', budget: { max_tokens: 500000 } }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run fuel-ok --backend mock')
      expect(eventsOf(repo.root, 'fuel-ok').some((e) => e.type === 'budget_low_fuel')).toBe(false)
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'fuel-ok', 'inbox.md'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })
})

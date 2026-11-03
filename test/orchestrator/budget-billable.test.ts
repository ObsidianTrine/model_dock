// Budget 可计费口径（billable，剔除缓存读）单测：GLM 网关缓存读占大头，旧「缓存读计入
// 输入」口径下 max_tokens 预算虚胖、熔断形同虚设。熔断与低油量告警改用 billable；旧口径
// 字段（tokens/sessionMax）保留兼容；旧事件无拆分字段时 billable 退化为旧口径。

import { describe, expect, it, vi } from 'vitest'
import { Budget, billableTokens } from '../../.agents/scripts/orchestrator/budget.mjs'

function mkCard(maxTokens: number) {
  return { meta: { budget: { max_tokens: maxTokens, max_wall_minutes: 10 } } }
}

describe('budget > 可计费口径（billable，剔除缓存读）', () => {
  it('缓存读占比高：billable 显著小于旧口径 tokens；缓存读单列；旧口径超限不误熔断', () => {
    const b = new Budget(mkCard(1_000_000))
    b.account(1_900_000, 100_000, 1_500_000)
    expect(b.tokens).toBe(2_000_000) // 旧口径不变（兼容 stats/交接油量等历史消费方）
    expect(b.cacheRead).toBe(1_500_000) // 缓存读单列观测
    expect(b.billable).toBe(500_000) // (1.9M − 1.5M) + 0.1M
    expect(b.tripped).toBe(false) // 旧口径 2M > 1M 也不熔断——熔断只看 billable
  })

  it('熔断按 billable 触发：cacheRead 缺省（旧事件）退化为旧口径照常熔断', () => {
    const b = new Budget(mkCard(100_000))
    b.account(500_000, 0) // 无拆分字段 → billable = tokens_in，行为与旧版一致
    expect(b.billable).toBe(500_000)
    expect(b.tripped).toBe(true)
    expect(b.tripReason?.reason).toBe('max_tokens') // 熔断原因名不变（blocked 归因兼容）
    expect(b.tripReason?.detail).toContain('可计费口径')
  })

  it('缓存读把 billable 压在限内不误熔断；跨会话 committed 分段入账正确', () => {
    const b = new Budget(mkCard(100_000))
    b.account(90_000, 5_000, 80_000) // billable 15k，旧口径 95k——都不超限
    expect(b.tripped).toBe(false)
    b.beginSession() // 会话入账 committed（billable 同步入账）
    expect(b.committedBillable).toBe(15_000)
    expect(b.committedCacheRead).toBe(80_000)
    b.account(120_000, 10_000, 100_000) // 新会话 billable 30k，合计 45k
    expect(b.billable).toBe(45_000)
    expect(b.tripped).toBe(false)
    b.account(200_000, 50_000, 0) // 本会话 billable 250k → 合计 265k > 100k
    expect(b.tripped).toBe(true)
  })

  it('低油量软告警按 billable 计算并携带 tokens_billable（缓存读不虚报油量）', () => {
    const emit = vi.fn()
    const b = new Budget(mkCard(100_000), emit)
    b.account(450_000, 0, 400_000) // billable 50k = 50%：不告警（旧口径 450k 已 4.5 倍超限）
    expect(emit).not.toHaveBeenCalled()
    expect(b.tripped).toBe(false)
    b.account(450_000, 40_000, 400_000) // billable 90k = 90%：告警一次
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({ kind: 'tokens', pct: 90, tokens_in: 490_000, tokens_billable: 90_000 })
  })

  it('billableTokens 纯函数：缺省/非法 cacheRead 按 0 退化为旧口径，负数防御归零', () => {
    expect(billableTokens(1000, 100, 800)).toBe(300)
    expect(billableTokens(1000, 100)).toBe(1100)
    expect(billableTokens(1000, 100, undefined)).toBe(1100)
    expect(billableTokens(1000, 100, -5)).toBe(1100)
    expect(billableTokens(1000, 100, 2000)).toBe(100) // 拆分异常（缓存读>输入）不为负
  })
})

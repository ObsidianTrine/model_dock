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

describe('budget > 实测账（accountMeasured，A4 harness-usage 轮询）', () => {
  it('首次采样固化基线：同 harness 既有流量不落入本任务预算（防跨任务假阳性）', () => {
    const b = new Budget(mkCard(100_000))
    expect(b.accountMeasured(3_000_000)).toBe(true) // harness 当日已有 3M（此前任务/其他流量）→ 基线
    expect(b.tripped).toBe(false) // 直接拿 day 总额判定会瞬间熔断——基线增量口径不误杀
    expect(b.accountMeasured(3_050_000)).toBe(true) // 本任务消耗 50k
    expect(b.measuredBillable).toBe(50_000)
    expect(b.tripped).toBe(false)
    expect(b.accountMeasured(3_200_000)).toBe(true) // 本任务消耗 200k > 100k → 熔断
    expect(b.tripped).toBe(true)
    expect(b.tripReason?.reason).toBe('max_tokens') // 归因口径不变（blocked 事件兼容）
    expect(b.tripReason?.detail).toContain('网关实测口径')
  })

  it('判定基线取 max(自报, 实测增量)：实测只抬高不回写自报账（stats/reconcile 口径不动）', () => {
    const b = new Budget(mkCard(100_000))
    b.account(10_000, 5_000) // 自报 billable 15k
    b.accountMeasured(500_000) // 基线 500k（起点），实测增量 0
    expect(b.billable).toBe(15_000) // 自报账不被实测覆盖
    b.accountMeasured(620_000) // 实测增量 120k > 自报 15k → 熔断按实测
    expect(b.tripped).toBe(true)
    // 自报账字段原样（budget_snapshot 消费方兼容）
    const b2 = new Budget(mkCard(100_000))
    b2.accountMeasured(400_000)
    b2.account(50_000, 0, 0) // 自报 50k
    expect(b2.billable).toBe(50_000)
    expect(b2.tokens).toBe(50_000)
  })

  it('非法值（负数/NaN）拒绝入账返回 false，行为不回退（自报账兜底）', () => {
    const b = new Budget(mkCard(100_000))
    expect(b.accountMeasured(-5)).toBe(false)
    expect(b.accountMeasured(Number.NaN)).toBe(false)
    expect(b.measuredBaseline).toBeNull()
    expect(b.tripped).toBe(false)
    // 拒绝后自报账仍正常熔断
    b.account(200_000, 0)
    expect(b.tripped).toBe(true)
  })

  it('实测增量驱动低油量软告警（80%，只触发一次）', () => {
    const emit = vi.fn()
    const b = new Budget(mkCard(100_000), emit)
    b.accountMeasured(1_000_000) // 基线
    b.accountMeasured(1_085_000) // 实测增量 85k = 85% → 告警一次
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toMatchObject({ kind: 'tokens', pct: 85, tokens_billable: 85_000 })
    b.accountMeasured(1_090_000) // 90%：不再重复告警（软告警一次红线不变）
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('跨午夜重锚：采样跌破基线即新的一天——旧日消耗 carryover 接力，任务总账跨日连续', () => {
    const b = new Budget(mkCard(100_000))
    b.accountMeasured(3_000_000) // 基线（当日已有 3M）
    b.accountMeasured(3_040_000) // 旧日消耗 40k
    expect(b.measuredBillable).toBe(40_000)
    b.accountMeasured(150) // 跨午夜：网关日账清零 → 采样跌破基线 → 重锚（carryover 40k）
    expect(b.measuredBaseline).toBe(150)
    expect(b.measuredBillable).toBe(40_000) // 旧日定格，总账不断档
    b.accountMeasured(50_150) // 新日消耗 50k → 总账 90k
    expect(b.measuredBillable).toBe(90_000)
    // 不重锚的旧行为此处增量钳 0：总账停在 40k，熔断低敏感直到新日烧回 3M
    b.accountMeasured(120_000) // 新日累计 120k → 总账 160k > 100k → 熔断
    expect(b.tripped).toBe(true)
    expect(b.tripReason?.reason).toBe('max_tokens')
  })

  it('重锚防抖与防御：同日回落（未跌破基线）不重锚不缩账；正常单调路径行为不变', () => {
    const b = new Budget(mkCard(100_000))
    b.accountMeasured(2_000_000) // 基线
    b.accountMeasured(2_010_000) // +10k
    b.accountMeasured(2_005_000) // 同日回落（高于基线，理论不出现）：不重锚，max 单调保持总账
    expect(b.measuredBaseline).toBe(2_000_000)
    expect(b.measuredBillable).toBe(10_000)
    b.accountMeasured(2_006_000) // 续航：增量钳 0，总账不缩
    expect(b.measuredBaseline).toBe(2_000_000)
    expect(b.measuredBillable).toBe(10_000)
    // 真跨午夜：跌破基线才重锚
    b.accountMeasured(150)
    expect(b.measuredBaseline).toBe(150)
    expect(b.measuredBillable).toBe(10_000) // carryover 接力
    b.accountMeasured(5_150)
    expect(b.measuredBillable).toBe(15_000)
    // 正常单调路径（无跨日）行为与旧版逐字段一致
    const b2 = new Budget(mkCard(100_000))
    b2.accountMeasured(500_000)
    b2.accountMeasured(560_000)
    expect(b2.measuredBillable).toBe(60_000)
    expect(b2.measuredCarryover).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { buildRuntime, readRequestLogDay, usageTodayView } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { PROBE_BUDGET_TOKENS_DEFAULT, PROBE_REGISTRY, PROBE_TIER_TOKENS, getProbeDef, probeEstimateTokens } from '../src/gateway/probe/registry.js'
import { probeBudgetState, probeMonthBreakdown, probeMonthKey, probeMonthSpend, readProbeLedger, recordProbeLedgerEntry } from '../src/gateway/probe/ledger.js'
import { runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeRunner, ProbeTransport } from '../src/gateway/probe/engine.js'
import { localDateStr } from '../src/util/time.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// 探针独立账本（provider-probe-suite 任务 1）：
// - registry 每项含成本档字段；多请求探针（P2/P10/P14）累计口径 = 单次运行内全部请求
// - 八字段条目（tag=probe：probe_id/provider/key 指纹/model/实际 tokens/预估 tokens/耗时/时间戳）
// - 月度预算 budget_tokens 缺省 50000 硬闸：达额后 run() 返回 budget-exhausted 且上游请求数 0
// - 与真实流量 usageToday/请求日志双向隔离

function mkRt(): GatewayRuntime {
  return buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const okTransport: ProbeTransport = async () => ({ status: 200, ms: 1 })
const okRunner: ProbeRunner = async (ctx) => {
  const resp = await ctx.transport({ providerId: ctx.target.providerId, model: ctx.target.model })
  return { state: 'healthy', status: resp.status, calls: [{ tokens: 10, ms: resp.ms, status: resp.status }] }
}

function ledgerEntry(over: Partial<Parameters<typeof recordProbeLedgerEntry>[0]> = {}): void {
  recordProbeLedgerEntry({
    tag: 'probe',
    probe_id: 'p1',
    provider: 'acme',
    key_fp: 'fp1',
    model: 'm',
    tokens: 200,
    estimated_tokens: 200,
    ms: 10,
    ts: new Date().toISOString(),
    ...over,
  })
}

describe('probe-ledger · registry 成本档', () => {
  it('每项含成本档字段且累计口径=单次运行内全部请求；P2/P10/P14 多请求累计口径落字段', () => {
    expect(PROBE_REGISTRY).toHaveLength(16) // P1–P15 + ctx 预留槽位
    for (const def of PROBE_REGISTRY) {
      expect(['S', 'M', 'L', 'none']).toContain(def.cost)
      expect(def.unitTokens).toBe(PROBE_TIER_TOKENS[def.cost])
      expect(def.cumulative).toBe('run-total')
      expect(def.requests === 'per-key' || typeof def.requests === 'number').toBe(true)
    }
    // 多请求探针的请求基数：P2 逐把 key、P10 逐题 20、P14 五轮 5
    expect(getProbeDef('p2')?.requests).toBe('per-key')
    expect(getProbeDef('p10')?.requests).toBe(20)
    expect(getProbeDef('p14')?.requests).toBe(5)
    // 预估 = Σ(该次运行内全部请求的档位上限)：P10 = 20×S、P14 = 5×M
    expect(probeEstimateTokens(getProbeDef('p10')!)).toBe(20 * PROBE_TIER_TOKENS.S)
    expect(probeEstimateTokens(getProbeDef('p14')!)).toBe(5 * PROBE_TIER_TOKENS.M)
    // ctx 预留槽位 not-implemented；P15 零 token
    expect(getProbeDef('ctx')?.status).toBe('reserved')
    expect(getProbeDef('p15')?.cost).toBe('none')
    expect(probeEstimateTokens(getProbeDef('p15')!)).toBe(0)
    // jittery 名单与 design 一致
    expect(PROBE_REGISTRY.filter((d) => d.kind === 'jittery').map((d) => d.id).sort()).toEqual(['p10', 'p12', 'p13', 'p14'])
  })
})

describe('probe-ledger · 八字段条目', () => {
  it('条目含 tag=probe 与八字段，读回一致', async () => {
    const h = fakeHome()
    try {
      ledgerEntry({ probe_id: 'p3', provider: 'up1', key_fp: 'fpx', model: 'mm', tokens: 123, estimated_tokens: 2000, ms: 45 })
      const entries = await readProbeLedger()
      expect(entries).toHaveLength(1)
      const e = entries[0]
      expect(e.tag).toBe('probe')
      expect(e.probe_id).toBe('p3')
      expect(e.provider).toBe('up1')
      expect(e.key_fp).toBe('fpx')
      expect(e.model).toBe('mm')
      expect(e.tokens).toBe(123)
      expect(e.estimated_tokens).toBe(2000)
      expect(e.ms).toBe(45)
      expect(typeof e.ts).toBe('string')
    } finally {
      h.restore()
    }
  })
})

describe('probe-ledger · 月度预算硬闸', () => {
  it('月度花费达 50000（缺省预算）后 run() 返回 budget-exhausted 且上游请求数 0', async () => {
    const h = fakeHome()
    try {
      const now = new Date()
      for (let i = 0; i < 25; i++) {
        ledgerEntry({ probe_id: 'p3', provider: `up${i}`, tokens: 2000, estimated_tokens: 2000, ts: now.toISOString() })
      } // 25 × 2000 = 50000
      const rt = mkRt()
      const st = await probeBudgetState(rt)
      expect(st.budget).toBe(PROBE_BUDGET_TOKENS_DEFAULT)
      expect(st.spent).toBe(50000)
      expect(st.exhausted).toBe(true)
      let calls = 0
      const transport: ProbeTransport = async () => {
        calls++
        return { status: 200, ms: 1 }
      }
      const r = await runProbeSuite(rt, {
        probeIds: ['p1', 'p3'],
        targets: [{ providerId: 'acme', model: 'm', keyFp: 'fp1' }],
        transport,
        runner: okRunner,
        confirmed: true,
      })
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('budget-exhausted')
      expect(r.upstreamRequests).toBe(0)
      expect(calls).toBe(0)
      expect(r.skipped.map((s) => s.reason)).toEqual(['budget-exhausted', 'budget-exhausted'])
      // 调高预算后：正常派发并在账本留痕
      ;(rt.config as Config & { probe?: { budget_tokens?: number } }).probe = { budget_tokens: 50_100 }
      const r2 = await runProbeSuite(rt, {
        probeIds: ['p1'],
        targets: [{ providerId: 'fresh', model: 'm', keyFp: 'fp2' }],
        transport: okTransport,
        runner: okRunner,
        confirmed: true,
      })
      expect(r2.ok).toBe(true)
      expect(r2.upstreamRequests).toBe(1)
      const entries = await readProbeLedger()
      expect(entries.filter((e) => e.provider === 'fresh')).toHaveLength(1)
    } finally {
      h.restore()
    }
  })

  it('预算按自然月计：上月花费不计入当月', async () => {
    const h = fakeHome()
    try {
      const today = new Date()
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15) // 15 日安全（无月末溢出）
      ledgerEntry({ tokens: 999_999, ts: lastMonth.toISOString() })
      const rt = mkRt()
      const st = await probeBudgetState(rt)
      expect(st.exhausted).toBe(false)
      expect(st.spent).toBe(0)
      let calls = 0
      const transport: ProbeTransport = async () => {
        calls++
        return { status: 200, ms: 1 }
      }
      const r = await runProbeSuite(rt, {
        probeIds: ['p1'],
        targets: [{ providerId: 'acme', model: 'm', keyFp: 'fp1' }],
        transport,
        runner: okRunner,
        confirmed: true,
      })
      expect(r.ok).toBe(true)
      expect(calls).toBe(1)
    } finally {
      h.restore()
    }
  })

  it('budget_tokens 覆盖读数：配置段未落地前按防御式读取生效', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      ;(rt.config as Config & { probe?: { budget_tokens?: number } }).probe = { budget_tokens: 100 }
      ledgerEntry({ tokens: 100 })
      const st = await probeBudgetState(rt)
      expect(st.budget).toBe(100)
      expect(st.exhausted).toBe(true)
    } finally {
      h.restore()
    }
  })
})

describe('probe-ledger · 聚合与隔离', () => {
  it('按自然月聚合、按 probe_id 分解；跨月不计', async () => {
    const h = fakeHome()
    try {
      const today = new Date()
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15)
      ledgerEntry({ probe_id: 'p1', tokens: 100, ts: today.toISOString() })
      ledgerEntry({ probe_id: 'p3', tokens: 300, ts: today.toISOString() })
      ledgerEntry({ probe_id: 'p3', tokens: 500, ts: lastMonth.toISOString() })
      const entries = await readProbeLedger()
      expect(probeMonthSpend(entries)).toBe(400)
      const b = probeMonthBreakdown(entries)
      expect(b.month).toBe(probeMonthKey(today))
      expect(b.total).toBe(400)
      expect(b.requests).toBe(2)
      expect(b.by_probe).toEqual({ p1: 100, p3: 300 })
    } finally {
      h.restore()
    }
  })

  it('探针账本与真实流量今日用量/请求日志双向隔离', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const usageBefore = JSON.stringify(usageTodayView())
      const r = await runProbeSuite(rt, {
        probeIds: ['p1'],
        targets: [{ providerId: 'acme', model: 'm', keyFp: 'fp1' }],
        transport: okTransport,
        runner: okRunner,
        confirmed: true,
      })
      expect(r.upstreamRequests).toBe(1)
      const entries = await readProbeLedger()
      expect(entries).toHaveLength(1)
      expect(entries[0].tokens).toBe(10)
      // usageToday 不因探针花费变化；请求日志零新增
      expect(JSON.stringify(usageTodayView())).toBe(usageBefore)
      expect(readRequestLogDay(localDateStr())).toHaveLength(0)
    } finally {
      h.restore()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Server } from 'node:http'
import { buildRuntime, logRequest } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { runProbeScheduleTick, startProbeSchedule } from '../src/gateway/probe/schedule.js'
import type { ProbeTransport } from '../src/gateway/probe/engine.js'
import { keyFingerprint, getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { readProbeLedger, recordProbeLedgerEntry } from '../src/gateway/probe/ledger.js'
import { P1_CANARY } from '../src/gateway/probe/runners/p1.js'
import { P15_SOURCE } from '../src/gateway/probe/runners/p15.js'
import { fakeHome, waitFor } from './helpers.js'
import { drainAppendStreams } from '../src/util/fsx.js'
import { localIsoTs } from '../src/util/time.js'
import type { Config } from '../src/config/types.js'

// 探针周期调度（provider-probe-suite 任务 13）：缺省（schedule_hours 空或 cost_ack=false）tick
// 只跑 P15 被动聚合、上游推理请求数为 0；cost_ack=true 且小时命中且预算内时周期探针（P1）执行；
// 预算耗尽后主动面 tick 变 no-op（budget-exhausted 零请求）；定时器生命周期对齐
// startModelProbeLoop（server close 清理、可注入短间隔）。transport/now 注入 mock 与钉死小时，
// 不真实起服务、不触上游（红线：测试零出站）。

const H = 3600_000

function mkRt(providers: Record<string, unknown>, probe?: Record<string, unknown>): GatewayRuntime {
  return buildRuntime(
    { providers, profiles: {}, harness: {}, ...(probe ? { probe } : {}) } as unknown as Config,
    'tok'
  )
}

const providerCfg = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'acme',
  base_url: 'https://acme.test',
  protocol: 'openai',
  auth_style: 'bearer',
  // 无 scheme 前缀的 key_ref = 明文 key（parseKeyRef plain 语义）：测试免密钥后端
  key_ref: 'sk-upa-plain-key',
  models: { m: {} },
  ...overrides,
})

const okBody = (): string =>
  JSON.stringify({ model: 'm', choices: [{ message: { content: P1_CANARY } }], usage: { input_tokens: 5, output_tokens: 2 } })

/** 计数 mock transport：P1 回文 200（7 tokens）；P15 不触 transport，计数即上游推理请求数 */
const countingTransport = (): { transport: ProbeTransport; calls: () => number } => {
  let n = 0
  return {
    calls: () => n,
    transport: async () => {
      n++
      return { status: 200, ms: 3, bodyText: okBody(), usage: { input_tokens: 5, output_tokens: 2 } }
    },
  }
}

/** 种一条窗口内请求日志（ts 取 agoMs 前） */
const seedLog = (rt: GatewayRuntime, provider: string, agoMs: number, status: number): void => {
  logRequest(rt, {
    ts: localIsoTs(new Date(Date.now() - agoMs)),
    harness: 'claude-code',
    profile: 'main',
    provider,
    model: 'm',
    path: '/v1/messages',
    status,
  })
}

describe('probe-schedule · 缺省零 token（schedule_hours 空且 cost_ack=false）', () => {
  it('tick 后上游推理请求数为 0，P15 被动聚合结果更新（verdict 翻被动证据）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ upA: providerCfg(), upE: providerCfg({ name: 'echo', key_ref: 'plain:sk-upe-key' }) })
      seedLog(rt, 'upA', H, 502) // provider 侧失败 → degraded
      seedLog(rt, 'upE', H, 200) // 窗口全绿 → healthy
      await drainAppendStreams()

      const t = countingTransport()
      const r = await runProbeScheduleTick(rt, { transport: t.transport })
      expect(t.calls()).toBe(0) // 缺省周期面零上游推理请求（船东硬约束）
      expect(r.hourHit).toBe(false) // schedule_hours 空：主动面时间门永不命中
      expect(r.active).toBeUndefined()
      expect(r.passive).toBeDefined()
      expect(r.passive?.upstreamRequests).toBe(0)

      // P15 聚合结果更新：被动证据落 (provider, '-', model) 三元组（引擎占位口径）
      expect(getProbeVerdict(rt, 'upA', '-', 'm')?.state).toBe('degraded')
      expect(getProbeVerdict(rt, 'upA', '-', 'm')?.evidence.status).toBe(502)
      expect(getProbeVerdict(rt, 'upA', '-', 'm')?.evidence.source).toBe(P15_SOURCE)
      expect(getProbeVerdict(rt, 'upE', '-', 'm')?.state).toBe('healthy')
      expect((await readProbeLedger()).length).toBe(0) // 零 token：账本零新增
    } finally {
      h.restore()
    }
  })

  it('[probe].enabled=false：整轮零动作（被动面也不跑）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ upA: providerCfg() }, { enabled: false, cost_ack: true, schedule_hours: [9] })
      const t = countingTransport()
      const r = await runProbeScheduleTick(rt, { now: new Date(2026, 5, 1, 9, 30), transport: t.transport })
      expect(t.calls()).toBe(0)
      expect(r.hourHit).toBe(false)
      expect(r.passive).toBeUndefined()
      expect(r.active).toBeUndefined()
    } finally {
      h.restore()
    }
  })
})

describe('probe-schedule · cost_ack 授权 + 小时门', () => {
  it('cost_ack=true 且当前小时 ∈ schedule_hours 且预算内：周期探针（P1）执行，P15 照常', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ upA: providerCfg() }, { cost_ack: true, schedule_hours: [9] })
      const t = countingTransport()
      const r = await runProbeScheduleTick(rt, { now: new Date(2026, 5, 1, 9, 30), transport: t.transport })
      expect(r.hourHit).toBe(true)
      expect(r.active?.ok).toBe(true)
      expect(r.active?.dispatched).toBe(1)
      expect(t.calls()).toBe(1) // P1 单请求探针
      expect(r.passive).toBeDefined() // P15 恒跑
      expect(r.passive?.upstreamRequests).toBe(0)

      // P1 verdict：主 key 指纹三元组 + canary 回显归 healthy
      const fp = keyFingerprint('sk-upa-plain-key')
      expect(getProbeVerdict(rt, 'upA', fp, 'm')?.state).toBe('healthy')
      expect(getProbeVerdict(rt, 'upA', fp, 'm')?.evidence.source).toBe('probe:p1')
      // 账本入账（探针独立账本）
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(1)
      expect(ledger[0].probe_id).toBe('p1')
      expect(ledger[0].tokens).toBe(7)
    } finally {
      h.restore()
    }
  })

  it('cost_ack=true 但当前小时 ∉ schedule_hours：主动面不跑（P15 照常）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ upA: providerCfg() }, { cost_ack: true, schedule_hours: [9] })
      const t = countingTransport()
      const r = await runProbeScheduleTick(rt, { now: new Date(2026, 5, 1, 10, 30), transport: t.transport })
      expect(r.hourHit).toBe(false)
      expect(r.active).toBeUndefined()
      expect(t.calls()).toBe(0)
      expect(r.passive).toBeDefined()
    } finally {
      h.restore()
    }
  })

  it('disabled_ids 排除 p1：小时命中也不跑主动面', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ upA: providerCfg() }, { cost_ack: true, schedule_hours: [9], disabled_ids: ['p1'] })
      const t = countingTransport()
      const r = await runProbeScheduleTick(rt, { now: new Date(2026, 5, 1, 9, 30), transport: t.transport })
      expect(r.hourHit).toBe(true)
      expect(r.active).toBeUndefined()
      expect(t.calls()).toBe(0)
      expect(r.passive).toBeDefined()
    } finally {
      h.restore()
    }
  })
})

describe('probe-schedule · 预算闸联动', () => {
  it('预算耗尽：主动面 tick 变 no-op（budget-exhausted 零请求、账本零新增、P1 verdict 不立）；P15 零 token 照常', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ upA: providerCfg() }, { cost_ack: true, schedule_hours: [9], budget_tokens: 100 })
      seedLog(rt, 'upA', H, 200) // 被动面有证据可落
      await drainAppendStreams()
      // 预置当月账本 150 tokens ≥ 预算 100
      recordProbeLedgerEntry({ tag: 'probe', probe_id: 'p1', provider: 'upA', key_fp: 'seed', model: 'm', tokens: 150, estimated_tokens: 200, ms: 1, ts: new Date().toISOString() })
      const ledgerBefore = (await readProbeLedger()).length

      const t = countingTransport()
      const r = await runProbeScheduleTick(rt, { now: new Date(2026, 5, 1, 9, 30), transport: t.transport })
      expect(r.hourHit).toBe(true)
      expect(r.active?.ok).toBe(false)
      expect(r.active?.reason).toBe('budget-exhausted')
      expect(r.active?.skipped.some((s) => s.probeId === 'p1' && s.reason === 'budget-exhausted')).toBe(true)
      expect(t.calls()).toBe(0) // 零上游推理请求
      expect((await readProbeLedger()).length).toBe(ledgerBefore) // 账本零新增
      // P1 主动 verdict 不立（唯一证据是被动面）
      expect(getProbeVerdict(rt, 'upA', keyFingerprint('sk-upa-plain-key'), 'm')).toBeUndefined()
      expect(getProbeVerdict(rt, 'upA', '-', 'm')?.state).toBe('healthy')
      expect(getProbeVerdict(rt, 'upA', '-', 'm')?.evidence.source).toBe(P15_SOURCE)
    } finally {
      h.restore()
    }
  })
})

describe('probe-schedule · 定时器生命周期（对齐 startModelProbeLoop）', () => {
  it('注入短间隔周期触发；server close 后定时器清零（tick 停止）', async () => {
    const h = fakeHome()
    try {
      // schedule_hours 全 24 小时：tick 的真实时钟小时恒命中，主动面每 tick 可观测
      const rt = mkRt({ upA: providerCfg() }, { cost_ack: true, schedule_hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] })
      const t = countingTransport()
      // 裸 EventEmitter 充当 server（startProbeSchedule 只挂 'close' 监听）：零监听零端口
      const server = new EventEmitter() as unknown as Server
      const timers = startProbeSchedule(rt, server, { initialDelayMs: 20, intervalMs: 60, transport: t.transport })
      expect(timers.length).toBe(2) // 首查 + 循环
      await waitFor(() => t.calls() >= 2, 5000, 10) // 注入短间隔生效：周期触发 ≥2 轮
      server.emit('close') // server close → 清理定时器
      const atClose = t.calls()
      await new Promise((r) => setTimeout(r, 200))
      expect(t.calls()).toBe(atClose) // close 后 tick 停止（定时器清零的行为面）
    } finally {
      h.restore()
    }
  })
})

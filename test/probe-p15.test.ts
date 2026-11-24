import { describe, expect, it } from 'vitest'
import { buildRuntime, logRequest } from '../src/gateway/state.js'
import type { GatewayRuntime, LogEntry } from '../src/gateway/state.js'
import { runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport } from '../src/gateway/probe/engine.js'
import { P15_SOURCE, P15_WINDOW_MS, aggregateProviderSignals, p15SignalState, runP15 } from '../src/gateway/probe/runners/p15.js'
import { verdictKey, getProbeVerdict } from '../src/gateway/probe/verdict.js'
import type { ProbeVerdict } from '../src/gateway/state/types.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { readRequestLogWindow } from '../src/gateway/state/logs.js'
import { fakeHome } from './helpers.js'
import { drainAppendStreams } from '../src/util/fsx.js'
import { localIsoTs } from '../src/util/time.js'
import type { Config } from '../src/config/types.js'

// P15 被动聚合（provider-probe-suite 任务 3）：滚动 24h 聚合请求日志 cause 与状态码 → 逐
// provider 错误分布；执行期间 0 上游请求（零 token）；被动新证据经 applyVerdictEvidence 同一
// 入口刷新 freshness（source=passive:p15）；窗口零活动 noEvidence 跳过（不空刷新 freshness）。

const H = 3600_000

function mkRt(): GatewayRuntime {
  return buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

describe('probe-p15 · 聚合分布（注入条目数一致）', () => {
  it('注入 10 条窗口内 + 1 条窗口外日志：聚合逐 provider 分布与条目一一对应', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const now = Date.now()
      const seed = (e: Partial<LogEntry> & { provider: string; agoMs: number }): void => {
        logRequest(rt, {
          ts: localIsoTs(new Date(now - e.agoMs)),
          harness: 'claude-code',
          profile: 'main',
          provider: e.provider,
          ...(e.model ? { model: e.model } : { model: 'm' }),
          path: '/v1/messages',
          ...(e.status != null ? { status: e.status } : {}),
          ...(e.err ? { err: e.err } : {}),
          ...(e.cause ? { cause: e.cause } : {}),
        })
      }
      seed({ provider: 'upA', agoMs: 2 * H, status: 200 })
      seed({ provider: 'upA', agoMs: 1 * H, status: 200 })
      seed({ provider: 'upA', agoMs: H / 2, status: 502, cause: 'upstream_5xx', err: 'bad gateway' })
      seed({ provider: 'upB', agoMs: 2 * H, status: 401, cause: 'unauthorized', err: 'invalid api key' })
      seed({ provider: 'upC', agoMs: 1 * H, status: 402, err: 'insufficient quota' })
      seed({ provider: 'upD', agoMs: 1 * H, err: 'connect ECONNREFUSED', cause: 'connect_failed' })
      seed({ provider: 'upE', agoMs: 2 * H, status: 200 })
      seed({ provider: 'upE', agoMs: H / 2, status: 200 })
      seed({ provider: 'upL', agoMs: 1 * H, cause: 'key_pool_empty', err: 'no usable key' }) // 本地失败：不归档
      seed({ provider: 'upL', agoMs: H / 2, status: 429, cause: 'queue_full' }) // 本地排队超额：不归档
      seed({ provider: 'upG', agoMs: 25 * H, status: 200 }) // 窗口外：不计入
      await drainAppendStreams()

      const fromMs = now - P15_WINDOW_MS
      const agg = aggregateProviderSignals(readRequestLogWindow(fromMs, now), fromMs, now)
      expect(agg.total).toBe(10) // 窗口外 1 条不计
      expect(agg.providers).toHaveLength(6) // upG 零窗口活动不出现

      const a = agg.providers.find((p) => p.provider === 'upA')!
      expect(a.requests).toBe(3)
      expect(a.ok).toBe(2)
      expect(a.failed).toBe(1)
      expect(a.by_status['200']).toBe(2)
      expect(a.by_status['502']).toBe(1)
      expect(a.by_cause['upstream_5xx']).toBe(1)
      expect(a.by_class.degraded).toBe(1)
      expect(a.last_error?.status).toBe(502)
      expect(a.last_error?.err).toBe('bad gateway')

      const d = agg.providers.find((p) => p.provider === 'upD')!
      expect(d.by_status['n/a']).toBe(1)
      expect(d.by_class.unreachable).toBe(1)
      expect(d.last_error?.err).toBe('connect ECONNREFUSED')

      const l = agg.providers.find((p) => p.provider === 'upL')!
      expect(l.requests).toBe(2)
      expect(l.failed).toBe(0) // 本地原因不计 provider 侧失败
      expect(l.by_cause['key_pool_empty']).toBe(1)
      expect(l.by_cause['queue_full']).toBe(1)
      expect(p15SignalState(l)).toBeUndefined() // 只有本地失败：不下结论

      expect(p15SignalState(agg.providers.find((p) => p.provider === 'upB'))).toBe('auth-dead')
      expect(p15SignalState(agg.providers.find((p) => p.provider === 'upC'))).toBe('quota')
      expect(p15SignalState(agg.providers.find((p) => p.provider === 'upE'))).toBe('healthy')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p15 · 零上游请求与被动 freshness', () => {
  it('执行期间 transport 0 次调用、账本 0 新条目；被动证据刷新 freshness（source=passive:p15）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const now = Date.now()
      const seed = (e: Partial<LogEntry> & { provider: string; agoMs: number }): void => {
        logRequest(rt, {
          ts: localIsoTs(new Date(now - e.agoMs)),
          harness: 'claude-code',
          profile: 'main',
          provider: e.provider,
          model: 'm',
          path: '/v1/messages',
          ...(e.status != null ? { status: e.status } : {}),
          ...(e.err ? { err: e.err } : {}),
          ...(e.cause ? { cause: e.cause } : {}),
        })
      }
      seed({ provider: 'upA', agoMs: H, status: 502, cause: 'upstream_5xx', err: 'bad gateway' })
      seed({ provider: 'upB', agoMs: H, status: 401, err: 'invalid api key' })
      seed({ provider: 'upC', agoMs: H, status: 402, err: 'insufficient quota' })
      seed({ provider: 'upD', agoMs: H, err: 'connect ECONNREFUSED', cause: 'connect_failed' })
      seed({ provider: 'upE', agoMs: H, status: 200 })
      await drainAppendStreams()

      // 预置旧 verdict：upE（应被动翻 healthy + 刷新 freshness）、upF（零窗口活动，不空刷新）
      const seedVerdict = (provider: string, fp: string, state: ProbeVerdict['state'], at: number): void => {
        if (!rt.probeVerdicts) rt.probeVerdicts = new Map()
        rt.probeVerdicts.set(verdictKey(provider, fp, 'm'), { provider, keyFp: fp, model: 'm', state, evidence: { source: 'probe:p1', at } })
      }
      const oldAt = now - 2 * 24 * H
      seedVerdict('upE', 'fpE', 'degraded', oldAt)
      seedVerdict('upF', 'fpF', 'degraded', oldAt)

      const ledgerBefore = (await readProbeLedger()).length
      let transportCalls = 0
      const transport: ProbeTransport = async () => {
        transportCalls++
        return { status: 200, ms: 1 }
      }
      const targets = ['upA', 'upB', 'upC', 'upD', 'upE', 'upF'].map((p, i) => ({ providerId: p, model: 'm', keyFp: `fp${p.slice(2) || i}` }))
      const r = await runProbeSuite(rt, { probeIds: ['p15'], targets, transport, runner: runP15 })
      expect(transportCalls).toBe(0) // 全程零上游请求
      expect(r.upstreamRequests).toBe(0)
      expect((await readProbeLedger()).length).toBe(ledgerBefore) // 零 token：账本零新增
      expect(r.skipped).toHaveLength(0)

      expect(getProbeVerdict(rt, 'upA', 'fpA', 'm')?.state).toBe('degraded')
      expect(getProbeVerdict(rt, 'upA', 'fpA', 'm')?.evidence.status).toBe(502)
      expect(getProbeVerdict(rt, 'upA', 'fpA', 'm')?.evidence.source).toBe(P15_SOURCE)
      expect(getProbeVerdict(rt, 'upB', 'fpB', 'm')?.state).toBe('auth-dead')
      expect(getProbeVerdict(rt, 'upB', 'fpB', 'm')?.evidence.err).toBe('invalid api key')
      expect(getProbeVerdict(rt, 'upC', 'fpC', 'm')?.state).toBe('quota')
      expect(getProbeVerdict(rt, 'upD', 'fpD', 'm')?.state).toBe('unreachable')
      const ve = getProbeVerdict(rt, 'upE', 'fpE', 'm')
      expect(ve?.state).toBe('healthy') // 24h 全绿流量：被动翻 healthy
      expect(ve?.evidence.at).toBeGreaterThan(oldAt) // freshness 已刷新
      const vf = getProbeVerdict(rt, 'upF', 'fpF', 'm')
      expect(vf?.state).toBe('degraded')
      expect(vf?.evidence.at).toBe(oldAt) // 窗口零活动：不空刷新（不架空 7 天 stale）
    } finally {
      h.restore()
    }
  })

  it('provider 在主动探针冷却期内：P15 豁免冷却照常聚合（零请求无限流风险）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const now = Date.now()
      logRequest(rt, { ts: localIsoTs(new Date(now - H)), harness: 'claude-code', profile: 'main', provider: 'upB', model: 'm', path: '/v1/messages', status: 200 })
      await drainAppendStreams()
      // 模拟 P1 刚吃到 429：upB 在探针冷却期
      if (!rt.probeRuntime) rt.probeRuntime = { cooldown: new Map(), inflight: new Set() }
      rt.probeRuntime.cooldown.set('upB', Date.now() + 10 * 60_000)

      const transport: ProbeTransport = async () => ({ status: 200, ms: 1 })
      const r = await runProbeSuite(rt, { probeIds: ['p15'], targets: [{ providerId: 'upB', model: 'm', keyFp: 'fpB' }], transport, runner: runP15 })
      expect(r.skipped.filter((s) => s.reason === 'cooldown')).toHaveLength(0)
      expect(r.dispatched).toBe(1)
      expect(getProbeVerdict(rt, 'upB', 'fpB', 'm')?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p15 · 延迟分位旁注（diag-modal-probe-ui）', () => {
  it('窗口内带耗时样本聚合 p50/p95/n 进 advisory.latency（最近秩法，与错误分布同窗）；无样本不挂空档', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const now = Date.now()
      const seed = (e: Partial<LogEntry> & { provider: string; agoMs: number; ms?: number }): void => {
        logRequest(rt, {
          ts: localIsoTs(new Date(now - e.agoMs)),
          harness: 'claude-code',
          profile: 'main',
          provider: e.provider,
          model: 'm',
          path: '/v1/messages',
          ...(e.status != null ? { status: e.status } : {}),
          ...(e.ms != null ? { ms: e.ms } : {}),
          ...(e.err ? { err: e.err } : {}),
          ...(e.cause ? { cause: e.cause } : {}),
        })
      }
      // upA：5 条成功样本（升序后 200/800/1200/2000/3000）→ p50=取[2]=1200、p95=取[4]=3000
      seed({ provider: 'upA', agoMs: 5 * H, status: 200, ms: 3000 })
      seed({ provider: 'upA', agoMs: 4 * H, status: 200, ms: 800 })
      seed({ provider: 'upA', agoMs: 3 * H, status: 200, ms: 1200 })
      seed({ provider: 'upA', agoMs: 2 * H, status: 200, ms: 2000 })
      seed({ provider: 'upA', agoMs: H, status: 200, ms: 200 })
      // upB：有成功流量但零耗时字段 → healthy 且不挂 latency（不产空档旁注）
      seed({ provider: 'upB', agoMs: H, status: 200 })
      await drainAppendStreams()

      const transport: ProbeTransport = async () => ({ status: 200, ms: 1 })
      const r = await runProbeSuite(rt, {
        probeIds: ['p15'],
        targets: [
          { providerId: 'upA', model: 'm', keyFp: 'fpA' },
          { providerId: 'upB', model: 'm', keyFp: 'fpB' },
        ],
        transport,
        runner: runP15,
      })
      expect(r.skipped).toHaveLength(0)
      const va = getProbeVerdict(rt, 'upA', 'fpA', 'm')
      expect(va?.state).toBe('healthy')
      expect(va?.advisory).toEqual({ latency: { p50: 1200, p95: 3000, n: 5 } })
      const vb = getProbeVerdict(rt, 'upB', 'fpB', 'm')
      expect(vb?.state).toBe('healthy')
      expect(vb?.advisory).toBeUndefined()
    } finally {
      h.restore()
    }
  })
})

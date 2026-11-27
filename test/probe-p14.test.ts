import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { providerProbeInCooldown, runProbeSuite, registerProbeRunProgress, clearProbeRunProgress } from '../src/gateway/probe/engine.js'
import type { ProbeTransport } from '../src/gateway/probe/engine.js'
import { P14_MAJORITY, P14_ROUNDS, runP14 } from '../src/gateway/probe/runners/p14.js'
import { nearestRankPercentile } from '../src/gateway/probe/runners/shared.js'
import { applyVerdictEvidence, getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// P14 性能画像（provider-probe-suite 任务 12）：连续 5 轮流式小请求测 TTFT 与 tokens-per-sec，
// 输出 p50/p95 分位数（最近秩法：5 样本排序后 p50 取 [2]、p95 取 [4]）。jittery 类 3 采样由
// 引擎调度（单样本 = 完整 5 轮）；多数派 ≥3/5 成功记 healthy。mock transport 直接注入计时
// 数组（chunks 逐片到达时刻 = P3 的传输层计时接缝），零网络、零端口，fakeHome 隔离落盘。

function mkRt(): GatewayRuntime {
  return buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const TARGET = { providerId: 'acme', model: 'glm-4.6', keyFp: 'fp1' }

type Round = { ttft: number; completion: number } | { status: number; body?: string } | 'net'

/** 逐轮行为的 mock 上游：成功轮回双分片 SSE（首片到达 = ttft，末片 = ttft+500，总耗时 =
 *  ttft+1000 → 生成窗口恒 1000ms，tps 数值 = completion_tokens），按调用序循环取轮 */
function perfMock(rounds: Round[]): { transport: ProbeTransport; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = []
  let call = 0
  const transport: ProbeTransport = async (req) => {
    const r = rounds[call++ % rounds.length]
    bodies.push(JSON.parse((req.body ?? Buffer.alloc(0)).toString('utf8')) as Record<string, unknown>)
    if (r === 'net') throw new Error('ECONNRESET')
    if ('status' in r) return { status: r.status, ms: 5, bodyText: r.body ?? '{"error":{"message":"boom"}}' }
    const ms = r.ttft + 1000
    return {
      status: 200,
      ms,
      bodyText: 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\ndata: [DONE]\n',
      chunks: [r.ttft, r.ttft + 500],
      usage: { completion_tokens: r.completion, prompt_tokens: 10 },
    }
  }
  return { transport, bodies }
}

const runP14Suite = (rt: GatewayRuntime, transport: ProbeTransport) =>
  runProbeSuite(rt, { probeIds: ['p14'], targets: [TARGET], transport, runner: runP14, confirmed: true })

describe('probe-p14 · 5 轮画像', () => {
  it('全 5 轮成功：advisory 含 p50/p95 字段且样本数为 5，分位数取值符合最近秩法；3 采样共识后 healthy', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      // TTFT 值序 [180,120,140,100,160] → 排序 [100,120,140,160,180]：p50=140、p95=180
      // completion 值序 [250,100,150,50,200]（生成窗口恒 1s → tps 同值）→ 排序后 p50=150、p95=250
      const { transport, bodies } = perfMock([
        { ttft: 180, completion: 250 },
        { ttft: 120, completion: 100 },
        { ttft: 140, completion: 150 },
        { ttft: 100, completion: 50 },
        { ttft: 160, completion: 200 },
      ])
      const r = await runP14Suite(rt, transport)
      expect(r.ok).toBe(true)
      expect(r.upstreamRequests).toBe(15) // jittery 3 采样 × 5 轮
      expect(r.estimate).toBe(5 * 2000) // M 档 × 5 请求 run-total
      // 请求确为流式 + M 档钳制 200
      expect(bodies).toHaveLength(15)
      expect(bodies.every((b) => b.stream === true && b.max_tokens === 200)).toBe(true)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      // 全新三元组：3 个一致 healthy 样本达成共识后翻状态（jittery 3 取中位）
      expect(v?.state).toBe('healthy')
      const a = v?.advisory as {
        rounds: number
        ok: number
        samples: Array<{ ms: number; ttft: number; tps: number }>
        ttft_p50: number | null
        ttft_p95: number | null
        tps_p50: number | null
        tps_p95: number | null
      }
      expect(a.rounds).toBe(5)
      expect(a.ok).toBe(5)
      expect(a.samples).toHaveLength(5)
      // p50 与 p95 两字段都在且有值（最近秩：排序 [2] 与 [4]）
      expect(a.ttft_p50).toBe(140)
      expect(a.ttft_p95).toBe(180)
      expect(a.tps_p50).toBe(150)
      expect(a.tps_p95).toBe(250)
      // 证据耗时 = 成功轮 ms 的 p50（ms = ttft+1000 → 排序 [1100,1120,1140,1160,1180] → [2]=1140）
      expect(v?.evidence.ms).toBe(1140)
      // 账本逐请求条目：15 条，M 档预估 2000，实际 tokens = completion + 10
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(15)
      expect(ledger.every((e) => e.probe_id === 'p14' && e.estimated_tokens === 2000)).toBe(true)
      expect(r.tokens).toBe((250 + 100 + 150 + 50 + 200 + 10 * 5) * 3)
    } finally {
      h.restore()
    }
  })

  it('usage 缺席轮次：ttft 分位数仍在、tps 分位数为 null（不进 tps 统计）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      let call = 0
      const transport: ProbeTransport = async () => {
        const ttft = [100, 140, 120, 160, 110][call++ % 5]
        return {
          status: 200,
          ms: ttft + 800,
          bodyText: 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
          chunks: [ttft, ttft + 400],
        }
      }
      await runP14Suite(rt, transport)
      const a = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')?.advisory as {
        ok: number
        ttft_p50: number | null
        tps_p50: number | null
        tps_p95: number | null
        samples: Array<{ ms: number; ttft: number; tps?: number }>
      }
      expect(a.ok).toBe(5)
      expect(a.ttft_p50).toBe(120)
      expect(a.tps_p50).toBeNull()
      expect(a.tps_p95).toBeNull()
      expect(a.samples.every((s) => s.tps === undefined)).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('多数派边界：恰好 3/5 成功仍记 healthy（单轮抖动由分位数吸收）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = perfMock([
        { ttft: 100, completion: 50 },
        { ttft: 120, completion: 60 },
        { ttft: 140, completion: 70 },
        { status: 500 },
        { status: 500 },
      ])
      await runP14Suite(rt, transport)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('healthy')
      expect(P14_MAJORITY).toBe(3)
      expect(P14_ROUNDS).toBe(5)
    } finally {
      h.restore()
    }
  })
})

describe('probe-p14 · 失败归档', () => {
  it('全部 500：degraded（过半失败翻状态）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = perfMock([{ status: 500 }])
      await runP14Suite(rt, transport)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.status).toBe(500)
      expect(v?.evidence.err).toBe('boom')
    } finally {
      h.restore()
    }
  })

  it('任一轮 401：硬失败一票定音 auth-dead', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = perfMock([
        { ttft: 100, completion: 50 },
        { status: 401, body: '{"error":{"message":"invalid api key"}}' },
        { ttft: 120, completion: 60 },
        { ttft: 140, completion: 70 },
        { ttft: 160, completion: 80 },
      ])
      await runP14Suite(rt, transport)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('auth-dead')
      expect(v?.evidence.err).toBe('invalid api key')
    } finally {
      h.restore()
    }
  })

  it('429：整样本 rateLimited 交引擎退避重试，重试仍 429 进 provider 冷却；限流样本未达 3 采样共识不翻状态', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'glm-4.6', source: 'probe:p1', kind: 'canary', state: 'healthy', evidence: { at: Date.now(), status: 200 } })
      const { transport } = perfMock([{ status: 429, body: '{"error":{"message":"rate limited"}}' }])
      const r = await runP14Suite(rt, transport)
      expect(r.upstreamRequests).toBe(10) // 样本 5 轮 + 退避重试 5 轮，全部 429
      // 两次限流样本（主张 degraded）与既有 healthy 冲突但不足 3 采样：维持原状态、证据标 unverified
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('healthy')
      expect(v?.evidence.unverified).toBe(true)
      expect(providerProbeInCooldown(rt, 'acme')).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('5 轮全网络失败：unreachable，零账本条目', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = perfMock(['net'])
      const r = await runP14Suite(rt, transport)
      expect(r.upstreamRequests).toBe(0)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('unreachable')
      expect(v?.evidence.err).toBe('ECONNRESET')
      expect((v?.advisory as { ok: number }).ok).toBe(0)
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(0)
    } finally {
      h.restore()
    }
  })
})

describe('probe-p14 · 最近秩分位数纯函数', () => {
  it('5 样本：p50 取排序 [2]、p95 取 [4]（card 指定口径）', () => {
    const xs = [3, 1, 2, 5, 4]
    expect(nearestRankPercentile(xs, 50)).toBe(3)
    expect(nearestRankPercentile(xs, 95)).toBe(5)
    expect(nearestRankPercentile([10, 20, 30, 40, 50], 50)).toBe(30)
    expect(nearestRankPercentile([10, 20, 30, 40, 50], 95)).toBe(50)
  })

  it('边界：空集 undefined、单样本取自身、输入不被原地排序', () => {
    expect(nearestRankPercentile([], 50)).toBeUndefined()
    expect(nearestRankPercentile([42], 95)).toBe(42)
    const input = [5, 1, 3]
    nearestRankPercentile(input, 50)
    expect(input).toEqual([5, 1, 3])
    // 非 5 样本也成立：n=4 → p50 排序后第 2 个
    expect(nearestRankPercentile([9, 7, 8, 6], 50)).toBe(7)
  })
})

describe('probe-p14 · 轮次进度与注册清理（p14-progress）', () => {
  it('runId 传入时 rt.probeRunProgress 收到逐轮上报，终态 round=5/rounds=5/probe=p14；不传 runId 零写入', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const mock = perfMock([{ ttft: 100, completion: 50 }])
      await runProbeSuite(rt, { probeIds: ['p14'], targets: [TARGET], transport: mock.transport, runner: runP14, confirmed: true, runId: 't1' })
      // jittery 3 采样 = 15 轮全跑完，last-writer-wins 仍是最后一轮 5/5
      expect(rt.probeRunProgress!.get('t1')).toMatchObject({ probe: 'p14', provider: 'acme', round: P14_ROUNDS, rounds: P14_ROUNDS })
      // 不传 runId：Map 不建不写（CLI 直跑零开销）
      const rt2 = mkRt()
      const mock2 = perfMock([{ ttft: 100, completion: 50 }])
      await runProbeSuite(rt2, { probeIds: ['p14'], targets: [TARGET], transport: mock2.transport, runner: runP14, confirmed: true })
      expect(rt2.probeRunProgress).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('registerProbeRunProgress 建位（rounds=0）+ 15min 陈旧清扫；clearProbeRunProgress 删除', () => {
    const rt = mkRt()
    rt.probeRunProgress = new Map()
    rt.probeRunProgress.set('old', { probe: 'p1', provider: 'acme', round: 1, rounds: 1, at: Date.now() - 16 * 60_000 })
    registerProbeRunProgress(rt, 'r1', 'acme', ['p14'])
    expect(rt.probeRunProgress.get('r1')).toMatchObject({ probe: 'p14', provider: 'acme', round: 0, rounds: 0 })
    expect(rt.probeRunProgress.has('old')).toBe(false) // 注册顺带清扫陈旧条目
    clearProbeRunProgress(rt, 'r1')
    expect(rt.probeRunProgress.has('r1')).toBe(false)
  })
})

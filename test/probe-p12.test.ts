import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport } from '../src/gateway/probe/engine.js'
import { P12_PROMPT, runP12 } from '../src/gateway/probe/runners/p12.js'
import { applyVerdictEvidence, getProbeVerdict, replayProbeVerdicts } from '../src/gateway/probe/verdict.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { fakeHome } from './helpers.js'
import { drainAppendStreams } from '../src/util/fsx.js'
import type { Config } from '../src/config/types.js'

// P12 身份核对（provider-probe-suite 任务 3）：响应 model 字段（transport 透传的 modelAfter，
// mfGate 改写后最终模型）与请求模型比对 + 自述问句观测。恒 advisory：modelAfter 与请求模型
// 不符时 verdict 状态不变、仅追加 advisory 字段；jittery 目录走 3 样本。

function mkRt(): GatewayRuntime {
  return buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const target = { providerId: 'acme', model: 'm1', keyFp: 'fp1' }

const identityBody = (served: string): string =>
  JSON.stringify({ model: served, choices: [{ message: { content: 'I am the model behind this endpoint.' } }] })

const runP12Suite = (rt: GatewayRuntime, transport: ProbeTransport) =>
  runProbeSuite(rt, { probeIds: ['p12'], targets: [target], transport, runner: runP12, confirmed: true })

describe('probe-p12 · advisory 永不翻状态', () => {
  it('modelAfter 与请求模型不符：既有 verdict 状态不变、仅追加 advisory 字段', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      // 先由 P1（canary）立 healthy 状态
      applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'm1', source: 'probe:p1', kind: 'canary', state: 'healthy', evidence: { at: Date.now(), status: 200 } })
      let calls = 0
      const bodies: string[] = []
      const transport: ProbeTransport = async (req) => {
        calls++
        bodies.push(req.body?.toString('utf8') ?? '')
        return { status: 200, ms: 3, bodyText: identityBody('m1'), modelAfter: 'srv-glm-4.7-air' }
      }
      const r = await runP12Suite(rt, transport)
      // jittery 3 取中位采样：3 次上游调用（每次都只产 advisory，不主张状态）
      expect(calls).toBe(3)
      expect(r.upstreamRequests).toBe(3)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'm1')
      expect(v?.state).toBe('healthy') // 状态纹丝不动
      expect(v?.advisory).toBeDefined()
      expect(v?.advisory?.match).toBe(false)
      expect(v?.advisory?.requested).toBe('m1')
      expect(v?.advisory?.actual).toBe('srv-glm-4.7-air')
      expect(String(v?.advisory?.note)).toContain('m1')
      // 自述问句进了请求体
      expect(bodies[0]).toContain('exact model identifier')
      expect(bodies).toHaveLength(3)
    } finally {
      h.restore()
    }
  })

  it('modelAfter 与请求模型一致：advisory.match=true，同样不翻状态', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'm1', source: 'probe:p1', kind: 'canary', state: 'degraded', evidence: { at: Date.now(), status: 500 } })
      const transport: ProbeTransport = async () => ({
        status: 200,
        ms: 2,
        bodyText: identityBody('m1'),
        modelAfter: 'm1',
      })
      await runP12Suite(rt, transport)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'm1')
      expect(v?.state).toBe('degraded') // 一致的 advisory 也不改判（包括不「洗白」旧状态）
      expect(v?.advisory?.match).toBe(true)
      expect(v?.advisory?.note).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('全新三元组跑 P12：状态停在 unverified（jittery 不立状态），advisory 落旁注并随 JSONL 回放保留', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => ({
        status: 200,
        ms: 2,
        bodyText: identityBody('srv-other'),
        modelAfter: 'srv-other',
      })
      await runP12Suite(rt, transport)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'm1')
      expect(v?.state).toBe('unverified')
      expect(v?.advisory?.match).toBe(false)
      // advisory 随 probe-<date>.jsonl 持久化，重启回放不丢（观测面可复核）；
      // 常驻流池先排空刷盘（新进程回放读不到未刷盘的缓冲）
      await drainAppendStreams()
      const rt2 = mkRt()
      await replayProbeVerdicts(rt2)
      const v2 = getProbeVerdict(rt2, 'acme', 'fp1', 'm1')
      expect(v2?.state).toBe('unverified')
      expect(v2?.advisory?.match).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('上游错误（401 等）：P12 也不翻状态，错误入证据、advisory.match=null', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'm1', source: 'probe:p1', kind: 'canary', state: 'quota', evidence: { at: Date.now(), status: 402 } })
      const transport: ProbeTransport = async () => ({
        status: 401,
        ms: 4,
        bodyText: JSON.stringify({ error: { message: 'invalid api key' } }),
      })
      await runP12Suite(rt, transport)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'm1')
      expect(v?.state).toBe('quota') // 身份核对永远不越权改判（401 归 P1 定罪）
      expect(v?.evidence.status).toBe(401)
      expect(v?.advisory?.match).toBeNull()
      expect(v?.evidence.err).toBe('invalid api key')
    } finally {
      h.restore()
    }
  })

  it('调用入探针账本（3 样本 3 条目，S 档预估）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => ({
        status: 200,
        ms: 2,
        bodyText: identityBody('m1'),
        modelAfter: 'm1',
        usage: { input_tokens: 4, output_tokens: 1 },
      })
      await runP12Suite(rt, transport)
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(3)
      expect(ledger.every((e) => e.probe_id === 'p12' && e.tokens === 5 && e.estimated_tokens === 200)).toBe(true)
    } finally {
      h.restore()
    }
  })
})

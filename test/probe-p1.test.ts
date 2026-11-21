import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { probeCooldownUntil, runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport } from '../src/gateway/probe/engine.js'
import { P1_CANARY, runP1 } from '../src/gateway/probe/runners/p1.js'
import { getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { fakeHome } from './helpers.js'
import type { Config, ProviderConfig } from '../src/config/types.js'

// P1 鉴权回声（provider-probe-suite 任务 3）：mock 上游分别驱动五种归档（healthy/auth-dead/
// quota/unreachable/degraded），断言 verdict 与归档一致；quota 判定复用 relay 的 isQuotaError
// （402 与 429+额度特征归 quota，普通 429 走引擎退避+冷却）；三协议路径拼装经 probeWire 与
// server.ts probe() 同源；调用入探针账本（探针独立账本，不进请求日志）。

function mkRt(providers: Record<string, unknown> = {}): GatewayRuntime {
  return buildRuntime({ providers, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const providerCfg = (protocol: string): Record<string, unknown> => ({
  name: 'acme',
  base_url: 'https://acme.test',
  protocol,
  auth_style: 'bearer',
  key_ref: 'plain:sk-probe-p1-key',
})

const targetOf = (providerId = 'acme', model = 'm', keyFp = 'fp1') => ({ providerId, model, keyFp })

const okBody = (): string =>
  JSON.stringify({ model: 'm', choices: [{ message: { content: P1_CANARY } }], usage: { input_tokens: 5, output_tokens: 2 } })

const runP1Suite = (rt: GatewayRuntime, transport: ProbeTransport, target = targetOf()) =>
  runProbeSuite(rt, { probeIds: ['p1'], targets: [target], transport, runner: runP1, confirmed: true })

describe('probe-p1 · 五态归档', () => {
  it('200 精确回显 MODELDOCK-OK → healthy（canary 单样本）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ acme: providerCfg('openai') })
      let calls = 0
      const transport: ProbeTransport = async (req) => {
        calls++
        expect(req.path).toBe('/v1/chat/completions')
        expect(req.body?.toString('utf8')).toContain(P1_CANARY)
        return { status: 200, ms: 7, bodyText: okBody(), usage: { input_tokens: 5, output_tokens: 2 } }
      }
      const r = await runP1Suite(rt, transport)
      expect(calls).toBe(1) // canary 单样本
      expect(r.upstreamRequests).toBe(1)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'm')
      expect(v?.state).toBe('healthy')
      expect(v?.evidence.status).toBe(200)
      expect(v?.evidence.source).toBe('probe:p1')
      // 账本：usage 合计入账（5+2），预估按 S 档 200
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(1)
      expect(ledger[0].probe_id).toBe('p1')
      expect(ledger[0].tokens).toBe(7)
      expect(ledger[0].estimated_tokens).toBe(200)
      expect(ledger[0].key_fp).toBe('fp1')
    } finally {
      h.restore()
    }
  })

  it('200 但回显不匹配 → degraded（宁严勿松）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => ({
        status: 200,
        ms: 5,
        bodyText: JSON.stringify({ choices: [{ message: { content: 'hello there' } }] }),
      })
      await runP1Suite(rt, transport)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'm')
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.err).toContain('MODELDOCK-OK')
    } finally {
      h.restore()
    }
  })

  it('401/403 → auth-dead；500/400 等其余 4xx/5xx → degraded', async () => {
    const h = fakeHome()
    try {
      for (const [status, expected] of [
        [401, 'auth-dead'],
        [403, 'auth-dead'],
        [500, 'degraded'],
        [404, 'degraded'],
      ] as const) {
        const rt = mkRt()
        const transport: ProbeTransport = async () => ({
          status,
          ms: 4,
          bodyText: JSON.stringify({ error: { message: `upstream ${status}` } }),
        })
        await runP1Suite(rt, transport, { providerId: 'acme', model: `m-${expected}-${status}`, keyFp: 'fp1' })
        const v = getProbeVerdict(rt, 'acme', `fp1`, `m-${expected}-${status}`)
        expect(v?.state, `status ${status}`).toBe(expected)
        expect(v?.evidence.status).toBe(status)
        expect(v?.evidence.err).toBe(`upstream ${status}`)
      }
    } finally {
      h.restore()
    }
  })

  it('402 → quota；429+额度特征 → quota（isQuotaError 单一口径，不触发冷却）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => ({ status: 402, ms: 3, bodyText: 'insufficient balance' })
      await runP1Suite(rt, transport, targetOf('acme', 'm-402', 'fp1'))
      expect(getProbeVerdict(rt, 'acme', 'fp1', 'm-402')?.state).toBe('quota')
      expect(probeCooldownUntil(rt, 'acme')).toBeUndefined() // 额度死不是限流：不退避不冷却

      const rt2 = mkRt()
      const transport2: ProbeTransport = async () => ({
        status: 429,
        ms: 3,
        bodyText: JSON.stringify({ error: { message: 'AccountQuotaExceeded: 额度不足' } }),
      })
      await runP1Suite(rt2, transport2, targetOf('acme', 'm-429q', 'fp1'))
      expect(getProbeVerdict(rt2, 'acme', 'fp1', 'm-429q')?.state).toBe('quota')
      expect(probeCooldownUntil(rt2, 'acme')).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('普通 429（无额度特征）→ degraded + 引擎退避重试 + provider 探针冷却', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => ({
        status: 429,
        ms: 2,
        headers: { 'retry-after': '0' },
        bodyText: 'too many requests',
      })
      const r = await runP1Suite(rt, transport)
      expect(r.upstreamRequests).toBe(2) // 首样本 + 退避重试
      expect(getProbeVerdict(rt, 'acme', 'fp1', 'm')?.state).toBe('degraded')
      expect(probeCooldownUntil(rt, 'acme')).not.toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('transport 抛错（网络失败）→ unreachable', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' })
      }
      await runP1Suite(rt, transport)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'm')
      expect(v?.state).toBe('unreachable')
      expect(v?.evidence.err).toContain('ECONNREFUSED')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p1 · 三协议拼装', () => {
  it('anthropic/responses/openai 按协议拼路径与回复抽取（与 server.ts probe() 同源 wire）', async () => {
    const h = fakeHome()
    try {
      // anthropic：/v1/messages + content[].text 抽取
      const rtA = mkRt({ acme: providerCfg('anthropic') })
      const seen: Array<{ path?: string; body: string }> = []
      const tA: ProbeTransport = async (req) => {
        seen.push({ path: req.path, body: req.body?.toString('utf8') ?? '' })
        return { status: 200, ms: 1, bodyText: JSON.stringify({ content: [{ type: 'text', text: ` ${P1_CANARY} ` }] }) }
      }
      await runP1Suite(rtA, tA)
      expect(seen[0].path).toBe('/v1/messages')
      expect(JSON.parse(seen[0].body).max_tokens).toBe(16)
      expect(getProbeVerdict(rtA, 'acme', 'fp1', 'm')?.state).toBe('healthy') // trim 后全等

      // responses：/v1/responses + max_output_tokens + output[].content[].text 抽取
      const rtR = mkRt({ acme: providerCfg('responses') })
      const tR: ProbeTransport = async (req) => {
        seen.push({ path: req.path, body: req.body?.toString('utf8') ?? '' })
        return {
          status: 200,
          ms: 1,
          bodyText: JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: P1_CANARY }] }] }),
        }
      }
      await runP1Suite(rtR, tR, targetOf('acme', 'mr', 'fp2'))
      expect(seen[1].path).toBe('/v1/responses')
      expect(JSON.parse(seen[1].body).max_output_tokens).toBe(16)
      expect(getProbeVerdict(rtR, 'acme', 'fp2', 'mr')?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })
})

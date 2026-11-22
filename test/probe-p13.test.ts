import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { runProbeSuite, providerProbeInCooldown } from '../src/gateway/probe/engine.js'
import type { ProbeTransport, ProbeUpstreamResponse } from '../src/gateway/probe/engine.js'
import { P13_PADDING, P13_USER_PROMPT, p13CacheReadOf, runP13 } from '../src/gateway/probe/runners/p13.js'
import { getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// P13 缓存探测 runner（provider-probe-suite 任务 9）：同 payload 两发，第二次的缓存读数
// （anthropic cache_read_input_tokens / openai prompt_tokens_details.cached_tokens）>0 判支持，
// 两次均 0 判不支持（degraded + advisory.supported=false，不判死）。jittery 类：runner 单次
// 两发判定，3 取中位共识在 verdict 层（单次样本不翻状态，连续 3 样本一致才定论）。
// max_tokens 自有钳制 ≤32。缓存读数从 bodyText 取（engine transport 的 usage 投影丢嵌套字段）。

function mkRt(providers: Record<string, { protocol: string }> = {}): GatewayRuntime {
  return buildRuntime({ providers, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const TARGET = { providerId: 'acme', model: 'glm-4.6', keyFp: 'fp1' }

interface CapturedBody {
  messages?: Array<{ role: string; content: string }>
  system?: unknown
  instructions?: unknown
  max_tokens?: number
  max_output_tokens?: number
  stream?: boolean
}

/** openai 形态缓存 mock：按「成功响应计数」的奇偶决定当发是第一发（无缓存）还是第二发
 *  （命中缓存）——429 不计成功数，引擎退避重跑 runner 后计数口径不乱。 */
function openaiCacheTransport(secondCached: number): { transport: ProbeTransport; bodies: CapturedBody[] } {
  const bodies: CapturedBody[] = []
  let okCalls = 0
  const transport: ProbeTransport = async (req) => {
    if (req.body) bodies.push(JSON.parse(req.body.toString('utf8')) as CapturedBody)
    okCalls++
    const cached = okCalls % 2 === 0 ? secondCached : 0
    const respBody =
      okCalls % 2 === 0
        ? JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 1200, completion_tokens: 1, prompt_tokens_details: { cached_tokens: cached } } })
        : JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 1200, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } } })
    const usage: Record<string, number> = { prompt_tokens: 1200, completion_tokens: 1 }
    const resp: ProbeUpstreamResponse = { status: 200, ms: 10, bodyText: respBody, usage }
    return resp
  }
  return { transport, bodies }
}

/** anthropic 形态缓存 mock：第二发 usage.cache_read_input_tokens>0 */
function anthropicCacheTransport(): ProbeTransport {
  let okCalls = 0
  return async (req) => {
    okCalls++
    const second = okCalls % 2 === 0
    const usage = second
      ? { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 }
      : { input_tokens: 1201, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 1200 }
    return {
      status: 200,
      ms: 10,
      bodyText: JSON.stringify({ content: [{ type: 'text', text: 'OK' }], usage }),
      usage: usage as Record<string, number>,
    }
  }
}

const runP13Suite = (rt: GatewayRuntime, transport: ProbeTransport) =>
  runProbeSuite(rt, { probeIds: ['p13'], targets: [TARGET], transport, runner: runP13, confirmed: true })

describe('probe-p13 · 请求拼装（同 payload 两发 + 钳制）', () => {
  it('两发字节级同 payload；max_tokens≤32（P13 自有钳制，非 200）；垫料进 system 槽', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport, bodies } = openaiCacheTransport(1024)
      await runP13Suite(rt, transport)
      expect(bodies).toHaveLength(6) // jittery 3 样本 × 两发
      for (const b of bodies) {
        expect(b.max_tokens).toBe(32)
        expect(b.stream).toBe(false)
        expect(b.messages?.[0]?.role).toBe('system')
        expect(b.messages?.[0]?.content).toBe(P13_PADDING)
        expect(b.messages?.[1]?.content).toBe(P13_USER_PROMPT)
      }
      expect(bodies[0].messages).toEqual(bodies[1].messages) // 同请求：内容逐字段一致
      expect(P13_PADDING.length).toBeGreaterThan(4000) // 垫到千 token 量级（缓存最小长度门槛）
    } finally {
      h.restore()
    }
  })

  it('anthropic：顶层 system 块数组带 cache_control ephemeral 断点；responses 走 instructions + max_output_tokens≤32', async () => {
    const h = fakeHome()
    try {
      const rtA = mkRt({ upa: { protocol: 'anthropic' } })
      const bodiesA: CapturedBody[] = []
      const anthropicUp = anthropicCacheTransport()
      const tA: ProbeTransport = async (req) => {
        bodiesA.push(req.body ? (JSON.parse(req.body.toString('utf8')) as CapturedBody) : {})
        return anthropicUp(req)
      }
      await runProbeSuite(rtA, { probeIds: ['p13'], targets: [{ providerId: 'upa', model: 'm', keyFp: 'fpa' }], transport: tA, runner: runP13, confirmed: true })
      const sys = bodiesA[0].system as Array<{ type: string; text: string; cache_control: { type: string } }>
      expect(Array.isArray(sys)).toBe(true)
      expect(sys[0]?.cache_control).toEqual({ type: 'ephemeral' })
      expect(bodiesA[0].max_tokens).toBe(32)

      const rtR = mkRt({ upr: { protocol: 'responses' } })
      const bodiesR: CapturedBody[] = []
      const tR: ProbeTransport = async (req) => {
        bodiesR.push(req.body ? (JSON.parse(req.body.toString('utf8')) as CapturedBody) : {})
        return { status: 200, ms: 5, bodyText: JSON.stringify({ usage: { prompt_tokens_details: { cached_tokens: 0 } } }) }
      }
      await runProbeSuite(rtR, { probeIds: ['p13'], targets: [{ providerId: 'upr', model: 'm', keyFp: 'fpr' }], transport: tR, runner: runP13, confirmed: true })
      expect(typeof bodiesR[0].instructions).toBe('string')
      expect(bodiesR[0].max_output_tokens).toBe(32)
      expect(bodiesR[0].max_tokens).toBeUndefined()
    } finally {
      h.restore()
    }
  })
})

describe('probe-p13 · 判定（第二次命中通过 / 两次均 0 不支持）', () => {
  it('第二发 cached_tokens>0：3 样本共识后 healthy，advisory.supported=true', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const r = await runP13Suite(rt, openaiCacheTransport(1024).transport)
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('healthy')
      expect(v?.advisory?.supported).toBe(true)
      expect(v?.advisory?.secondCacheRead).toBe(1024)
      expect(r.upstreamRequests).toBe(6)
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(6)
      expect(ledger.every((e) => e.probe_id === 'p13' && e.estimated_tokens === 2000)).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('anthropic 形态：第二发 cache_read_input_tokens>0 → healthy', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ upa: { protocol: 'anthropic' } })
      await runProbeSuite(rt, { probeIds: ['p13'], targets: [{ providerId: 'upa', model: 'm', keyFp: 'fpa' }], transport: anthropicCacheTransport(), runner: runP13, confirmed: true })
      const v = getProbeVerdict(rt, 'upa', 'fpa', 'm')
      expect(v?.state).toBe('healthy')
      expect(v?.advisory?.supported).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('两次均 0：判不支持——degraded（不判死）+ advisory.supported=false，err 指向 P13', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      await runP13Suite(rt, openaiCacheTransport(0).transport)
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('degraded')
      expect(v?.state).not.toBe('auth-dead')
      expect(v?.state).not.toBe('unreachable')
      expect(v?.advisory?.supported).toBe(false)
      expect(v?.advisory?.secondCacheRead).toBe(0)
      expect(v?.evidence.err).toContain('P13')
    } finally {
      h.restore()
    }
  })

  it('第一发 401 → auth-dead（jittery 3 样本各归档一次，共识后定论）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      let n1 = 0
      const t1: ProbeTransport = async () => {
        n1++
        return { status: 401, ms: 5, bodyText: JSON.stringify({ error: { message: 'bad key' } }) }
      }
      await runP13Suite(rt, t1)
      expect(n1).toBe(3) // jittery 3 样本各在第一发即归档 auth-dead（共识后 verdict 落 auth-dead）
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('auth-dead')
    } finally {
      h.restore()
    }
  })

  it('第二发 402 额度特征 → quota（两发都入账，3 样本 6 条账本）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      let n2 = 0
      const t2: ProbeTransport = async () => {
        n2++
        if (n2 % 2 === 1) return { status: 200, ms: 5, bodyText: JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1200 } }) }
        return { status: 402, ms: 5, bodyText: 'insufficient quota' }
      }
      await runP13Suite(rt, t2)
      expect(n2).toBe(6)
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('quota')
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(6)
    } finally {
      h.restore()
    }
  })

  it('第一发 429：走引擎退避重跑 + provider 探针冷却（10 分钟负缓存生效）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      let okCalls = 0
      let saw429 = false
      const transport: ProbeTransport = async () => {
        if (!saw429) {
          saw429 = true
          return { status: 429, ms: 5, bodyText: 'rate limited' }
        }
        okCalls++
        const first = okCalls % 2 === 1
        const respBody = JSON.stringify(
          first
            ? { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 0 } } }
            : { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 1000 } } }
        )
        return { status: 200, ms: 10, bodyText: respBody, usage: { prompt_tokens: 1200, completion_tokens: 1 } as Record<string, number> }
      }
      await runP13Suite(rt, transport)
      expect(providerProbeInCooldown(rt, TARGET.providerId)).toBe(true)
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p13 · p13CacheReadOf 纯函数', () => {
  it('anthropic 顶层字段 / openai 嵌套字段 / 缺席与非 JSON 均按口径', () => {
    expect(p13CacheReadOf(JSON.stringify({ usage: { cache_read_input_tokens: 5 } }))).toBe(5)
    expect(p13CacheReadOf(JSON.stringify({ usage: { prompt_tokens_details: { cached_tokens: 7 } } }))).toBe(7)
    expect(p13CacheReadOf(JSON.stringify({ usage: { cache_read_input_tokens: 0, prompt_tokens_details: { cached_tokens: 3 } } }))).toBe(0) // 0 也是合法读数（anthropic 优先）
    expect(p13CacheReadOf(JSON.stringify({ usage: {} }))).toBeUndefined()
    expect(p13CacheReadOf(JSON.stringify({}))).toBeUndefined()
    expect(p13CacheReadOf('not json')).toBeUndefined()
    expect(p13CacheReadOf(undefined)).toBeUndefined()
  })
})

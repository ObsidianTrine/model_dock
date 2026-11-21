import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { providerProbeInCooldown, runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport } from '../src/gateway/probe/engine.js'
import { P11_CONFIDENCE, P11_LEVELS, P11_PROMPT, runP11, shellTruncated, usageHitCap } from '../src/gateway/probe/runners/p11.js'
import { getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// P11 输出上限（provider-probe-suite 任务 12）：max_tokens 512/1024/2048/4096 递增探测，首个
// 触顶级别即实测截断点（±512 置信度）。mock 上游按 usage.completion_tokens 模拟触顶：cap 之
// 下的级别自然收尾（completion < 级别、finish stop），达到 cap 的级别 completion 填满并回
// 截断信号。canary 单次判定；触顶即 early-stop（实际请求数 ≤ 目录基数 4）。全走可注入
// transport（零网络、零端口），fakeHome 隔离账本与 verdict 落盘。

function mkRt(providers: Record<string, { protocol: string }> = {}): GatewayRuntime {
  return buildRuntime({ providers, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const TARGET = { providerId: 'acme', model: 'glm-4.6', keyFp: 'fp1' }

interface CapMockOpts {
  /** 上游真实输出上限（token）；缺省 = 无上限（各级自然收尾） */
  cap?: number
  proto?: 'openai' | 'anthropic' | 'responses'
  /** 剥掉壳字段（finish_reason/stop_reason/status），只留 usage——中转拍壳形态 */
  omitShell?: boolean
  /** 恒定失败状态码（鉴权/限流场景） */
  status?: number
  body?: string
}

function capMock(opts: CapMockOpts = {}): { transport: ProbeTransport; requested: number[] } {
  const requested: number[] = []
  const proto = opts.proto ?? 'openai'
  const transport: ProbeTransport = async (req) => {
    const bodyJson = JSON.parse((req.body ?? Buffer.alloc(0)).toString('utf8')) as Record<string, unknown>
    const level = Number(bodyJson.max_tokens ?? bodyJson.max_output_tokens)
    requested.push(level)
    if (opts.status) return { status: opts.status, ms: 3, bodyText: opts.body ?? '{"error":{"message":"upstream rejected"}}' }
    const truncated = opts.cap != null && level >= opts.cap
    const completion = truncated ? level : level - 128
    const usage =
      proto === 'openai'
        ? { completion_tokens: completion, prompt_tokens: 10 }
        : { output_tokens: completion, input_tokens: 10 }
    let bodyText: string
    if (opts.omitShell) {
      bodyText = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x' } }], usage })
    } else if (proto === 'anthropic') {
      bodyText = JSON.stringify({ stop_reason: truncated ? 'max_tokens' : 'end_turn', content: [{ type: 'text', text: 'x' }], usage })
    } else if (proto === 'responses') {
      bodyText = JSON.stringify({ status: truncated ? 'incomplete' : 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }], usage })
    } else {
      bodyText = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: truncated ? 'length' : 'stop' }], usage })
    }
    return { status: 200, ms: 8, bodyText, usage }
  }
  return { transport, requested }
}

const runP11Suite = (rt: GatewayRuntime, transport: ProbeTransport) =>
  runProbeSuite(rt, { probeIds: ['p11'], targets: [TARGET], transport, runner: runP11, confirmed: true })

describe('probe-p11 · 截断点实测', () => {
  it('上限 2048：512/1024 自然收尾、2048 触顶截断——报告 2048±512，early-stop 共 3 请求', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport, requested } = capMock({ cap: 2048 })
      const r = await runP11Suite(rt, transport)
      expect(r.ok).toBe(true)
      expect(r.upstreamRequests).toBe(3)
      expect(requested).toEqual([512, 1024, 2048]) // 命中触顶即停，4096 不发
      expect(requested.every((n) => P11_LEVELS.includes(n))).toBe(true)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('healthy') // canary：测量成功记 healthy
      const a = v?.advisory as { measured_tokens: number | null; confidence: number; label?: string; levels: Array<{ max_tokens: number; truncated: boolean; completion_tokens?: number }>; note?: string }
      expect(a.measured_tokens).toBe(2048)
      expect(a.confidence).toBe(P11_CONFIDENCE)
      expect(a.label).toBe('2048±512')
      expect(a.levels).toHaveLength(3)
      expect(a.levels.map((l) => l.truncated)).toEqual([false, false, true])
      expect(a.levels[2].completion_tokens).toBe(2048)
      expect(String(a.note)).toContain('2048')
      // 账本按实际逐请求落条目，L 档预估 10000
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(3)
      expect(ledger.every((e) => e.probe_id === 'p11' && e.estimated_tokens === 10000)).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('壳字段被拍掉：usage.completion_tokens 触顶（completion ≥ max_tokens）同样判截断', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport, requested } = capMock({ cap: 2048, omitShell: true })
      await runP11Suite(rt, transport)
      expect(requested).toEqual([512, 1024, 2048])
      const a = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')?.advisory as { measured_tokens: number | null }
      expect(a.measured_tokens).toBe(2048)
    } finally {
      h.restore()
    }
  })

  it('各级均自然收尾未触顶：4 请求探到顶棚，measured=null、note 说明高于顶棚', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport, requested } = capMock()
      const r = await runP11Suite(rt, transport)
      expect(r.upstreamRequests).toBe(4)
      expect(requested).toEqual([512, 1024, 2048, 4096])
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('healthy')
      const a = v?.advisory as { measured_tokens: number | null; confidence: number; label?: string; levels: unknown[]; note?: string }
      expect(a.measured_tokens).toBeNull()
      expect(a.confidence).toBe(512)
      expect(a.label).toBeUndefined()
      expect(a.levels).toHaveLength(4)
      expect(String(a.note)).toContain('4096')
    } finally {
      h.restore()
    }
  })

  it('anthropic 协议：/v1/messages + max_tokens 阶梯，stop_reason=max_tokens 判截断', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ acme: { protocol: 'anthropic' } })
      const { transport, requested } = capMock({ cap: 2048, proto: 'anthropic' })
      await runP11Suite(rt, transport)
      expect(requested).toEqual([512, 1024, 2048])
      const a = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')?.advisory as { measured_tokens: number | null }
      expect(a.measured_tokens).toBe(2048)
    } finally {
      h.restore()
    }
  })

  it('responses 协议：max_output_tokens 阶梯 + status=incomplete 判截断', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ acme: { protocol: 'responses' } })
      const { transport, requested } = capMock({ cap: 2048, proto: 'responses' })
      await runP11Suite(rt, transport)
      expect(requested).toEqual([512, 1024, 2048])
      const a = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')?.advisory as { measured_tokens: number | null }
      expect(a.measured_tokens).toBe(2048)
    } finally {
      h.restore()
    }
  })
})

describe('probe-p11 · 失败归档', () => {
  it('401 → auth-dead（canary 单判定直接主张）；网络异常 → unreachable', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport, requested } = capMock({ status: 401, body: '{"error":{"message":"invalid api key"}}' })
      await runP11Suite(rt, transport)
      expect(requested).toEqual([512])
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('auth-dead')
      expect(v?.evidence.err).toBe('invalid api key')
      expect(v?.advisory?.measured_tokens).toBeNull()

      const rt2 = mkRt()
      const failing: ProbeTransport = async () => {
        throw new Error('ECONNREFUSED')
      }
      await runP11Suite(rt2, failing)
      expect(getProbeVerdict(rt2, 'acme', 'fp1', 'glm-4.6')?.state).toBe('unreachable')
    } finally {
      h.restore()
    }
  })

  it('429 → degraded + 退避重试，重试仍 429 进 provider 冷却', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport, requested } = capMock({ status: 429, body: '{"error":{"message":"rate limited"}}' })
      const r = await runP11Suite(rt, transport)
      expect(r.upstreamRequests).toBe(2)
      expect(requested).toEqual([512, 512]) // 重试整样本从 512 重新起步
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('degraded')
      expect(providerProbeInCooldown(rt, 'acme')).toBe(true)
    } finally {
      h.restore()
    }
  })
})

describe('probe-p11 · 截断信号纯函数', () => {
  it('shellTruncated：openai finish_reason=length / anthropic stop_reason / responses status；非截断形态 false', () => {
    expect(shellTruncated(JSON.stringify({ choices: [{ finish_reason: 'length' }] }))).toBe(true)
    expect(shellTruncated(JSON.stringify({ choices: [{ finish_reason: 'stop' }] }))).toBe(false)
    expect(shellTruncated(JSON.stringify({ stop_reason: 'max_tokens' }))).toBe(true)
    expect(shellTruncated(JSON.stringify({ stop_reason: 'end_turn' }))).toBe(false)
    expect(shellTruncated(JSON.stringify({ status: 'incomplete' }))).toBe(true)
    expect(shellTruncated(JSON.stringify({ status: 'completed' }))).toBe(false)
    expect(shellTruncated('not json')).toBe(false)
    expect(shellTruncated(undefined)).toBe(false)
  })

  it('usageHitCap：completion_tokens / output_tokens ≥ 级别判触顶，缺席不判', () => {
    expect(usageHitCap({ completion_tokens: 2048 }, 2048)).toBe(true)
    expect(usageHitCap({ output_tokens: 2048 }, 2048)).toBe(true)
    expect(usageHitCap({ completion_tokens: 384 }, 512)).toBe(false)
    expect(usageHitCap({}, 512)).toBe(false)
    expect(usageHitCap(undefined, 512)).toBe(false)
    expect(P11_PROMPT).toContain('as long as you can')
  })
})

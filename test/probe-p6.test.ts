import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport, ProbeUpstreamResponse } from '../src/gateway/probe/engine.js'
import { P6_PROMPT, runP6 } from '../src/gateway/probe/runners/p6.js'
import { parseCanaryJson } from '../src/gateway/probe/runners/shared.js'
import { getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// P6 结构化输出 runner（provider-probe-suite 任务 7）：response_format=json_object（openai
// 形态）+ canary 指令约定 {"ok":true} + 约定字段 presence 校验；非法 JSON / 缺约定字段从严
// 判不通过。全走可注入 transport（零真实网络、零端口监听），fakeHome 隔离落盘。

function mkRt(providers: Record<string, { protocol: string }> = {}): GatewayRuntime {
  return buildRuntime({ providers, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const TARGET = { providerId: 'acme', model: 'glm-4.6', keyFp: 'fp1' }

/** 捕获请求 + 固定回复体的 mock：同时断言请求拼装与判定结论 */
function replyTransport(replyBodyText: string, opts: { status?: number; usage?: Record<string, number> } = {}): {
  transport: ProbeTransport
  requests: Array<{ path?: string; bodyJson?: Record<string, unknown> }>
} {
  const requests: Array<{ path?: string; bodyJson?: Record<string, unknown> }> = []
  const transport: ProbeTransport = async (req) => {
    requests.push({
      path: req.path,
      bodyJson: req.body ? (JSON.parse(req.body.toString('utf8')) as Record<string, unknown>) : undefined,
    })
    const resp: ProbeUpstreamResponse = {
      status: opts.status ?? 200,
      ms: 80,
      bodyText: replyBodyText,
      usage: opts.usage ?? { completion_tokens: 5 },
    }
    return resp
  }
  return { transport, requests }
}

const openaiReply = (content: string): string => JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] })

describe('probe-p6 · 请求拼装（response_format 与钳制）', () => {
  it('openai 协议：response_format=json_object + max_tokens≤200 + stream=false', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport, requests } = replyTransport(openaiReply('{"ok":true}'))
      await runProbeSuite(rt, { probeIds: ['p6'], targets: [TARGET], transport, runner: runP6, confirmed: true })
      expect(requests[0].path).toBe('/v1/chat/completions')
      expect(requests[0].bodyJson?.response_format).toEqual({ type: 'json_object' })
      expect(requests[0].bodyJson?.max_tokens).toBe(200)
      expect(requests[0].bodyJson?.stream).toBe(false)
      expect((requests[0].bodyJson?.messages as Array<{ content: string }>)[0]?.content).toBe(P6_PROMPT)
    } finally {
      h.restore()
    }
  })

  it('anthropic / responses 协议无 json_object 槽位：body 不带 response_format，路径按协议', async () => {
    const h = fakeHome()
    try {
      const rtA = mkRt({ acme: { protocol: 'anthropic' } })
      const { transport: tA, requests: rA } = replyTransport(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }] }))
      await runProbeSuite(rtA, { probeIds: ['p6'], targets: [TARGET], transport: tA, runner: runP6, confirmed: true })
      expect(rA[0].path).toBe('/v1/messages')
      expect(rA[0].bodyJson?.response_format).toBeUndefined()
      expect(getProbeVerdict(rtA, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('healthy')

      const rtR = mkRt({ up2: { protocol: 'responses' } })
      const { transport: tR, requests: rR } = replyTransport(JSON.stringify({ output_text: '{"ok":true}' }))
      await runProbeSuite(rtR, {
        probeIds: ['p6'],
        targets: [{ providerId: 'up2', model: 'm', keyFp: 'fp2' }],
        transport: tR,
        runner: runP6,
        confirmed: true,
      })
      expect(rR[0].path).toBe('/v1/responses')
      expect(rR[0].bodyJson?.response_format).toBeUndefined()
      expect(rR[0].bodyJson?.max_output_tokens).toBe(200)
    } finally {
      h.restore()
    }
  })
})

describe('probe-p6 · 约定字段校验', () => {
  it('回复恰为 {"ok":true}：healthy', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = replyTransport(openaiReply('{"ok":true}'))
      await runProbeSuite(rt, { probeIds: ['p6'], targets: [TARGET], transport, runner: runP6, confirmed: true })
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('healthy')
      expect(v?.evidence.status).toBe(200)
    } finally {
      h.restore()
    }
  })

  it('非法 JSON 判不通过（degraded）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = replyTransport(openaiReply('not json at all'))
      await runProbeSuite(rt, { probeIds: ['p6'], targets: [TARGET], transport, runner: runP6, confirmed: true })
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.err).toContain('P6')
    } finally {
      h.restore()
    }
  })

  it('JSON 合法但缺约定字段 ok：不通过；ok=false 仅证明形态能力（presence 语义）判通过', async () => {
    const h = fakeHome()
    try {
      const rt1 = mkRt()
      const { transport: t1 } = replyTransport(openaiReply('{"status":"fine"}'))
      await runProbeSuite(rt1, { probeIds: ['p6'], targets: [TARGET], transport: t1, runner: runP6, confirmed: true })
      expect(getProbeVerdict(rt1, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('degraded')

      const rt2 = mkRt()
      const { transport: t2 } = replyTransport(openaiReply('{"ok":false}'))
      await runProbeSuite(rt2, { probeIds: ['p6'], targets: [TARGET], transport: t2, runner: runP6, confirmed: true })
      expect(getProbeVerdict(rt2, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })

  it('code fence 包裹的 JSON：一次剥围栏兜底后通过', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = replyTransport(openaiReply('```json\n{"ok":true}\n```'))
      await runProbeSuite(rt, { probeIds: ['p6'], targets: [TARGET], transport, runner: runP6, confirmed: true })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })

  it('402 额度特征 → quota（失败归档优先于能力判定）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = replyTransport('insufficient quota', { status: 402 })
      await runProbeSuite(rt, { probeIds: ['p6'], targets: [TARGET], transport, runner: runP6, confirmed: true })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('quota')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p6 · parseCanaryJson 纯函数', () => {
  it('对象通过；数组/标量/空/undefined 拒绝', () => {
    expect(parseCanaryJson('{"ok":true}')).toEqual({ ok: true })
    expect(parseCanaryJson('  {"ok":1}  ')).toEqual({ ok: 1 })
    expect(parseCanaryJson('```json\n{"ok":true}\n```')).toEqual({ ok: true })
    expect(parseCanaryJson('[1,2]')).toBeUndefined()
    expect(parseCanaryJson('123')).toBeUndefined()
    expect(parseCanaryJson('null')).toBeUndefined()
    expect(parseCanaryJson('')).toBeUndefined()
    expect(parseCanaryJson(undefined)).toBeUndefined()
  })
})

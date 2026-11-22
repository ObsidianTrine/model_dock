import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport, ProbeUpstreamResponse } from '../src/gateway/probe/engine.js'
import { P4_PROMPT, runP4 } from '../src/gateway/probe/runners/p4.js'
import { P4_RED_PNG_BASE64 } from '../src/gateway/probe/assets.js'
import { getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// P4 视觉实证 runner（provider-probe-suite 任务 8）：内置纯红 2×2 PNG + 问色 canary，回复含
// 独立词 red（大小写不敏感）判通过——图没送到时模型只能答看不到图或瞎猜，防收图不看图中转。
// 全走可注入 transport（零真实网络、零端口监听），fakeHome 隔离账本与 verdict 落盘。

function mkRt(providers: Record<string, { protocol: string }> = {}): GatewayRuntime {
  return buildRuntime({ providers, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const TARGET = { providerId: 'acme', model: 'glm-4.6', keyFp: 'fp1' }
const DATA_URL = `data:image/png;base64,${P4_RED_PNG_BASE64}`

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
const anthropicReply = (text: string): string => JSON.stringify({ content: [{ type: 'text', text }] })

describe('probe-p4 · 请求拼装（图像形态与钳制）', () => {
  it('openai 协议：image_url data URL（内置 PNG 常量）+ max_tokens≤200 + stream=false', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport, requests } = replyTransport(openaiReply('It is red!'))
      await runProbeSuite(rt, { probeIds: ['p4'], targets: [TARGET], transport, runner: runP4, confirmed: true })
      expect(requests[0].path).toBe('/v1/chat/completions')
      expect(requests[0].bodyJson?.max_tokens).toBe(200)
      expect(requests[0].bodyJson?.stream).toBe(false)
      const content = (requests[0].bodyJson?.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]?.content
      expect(Array.isArray(content)).toBe(true)
      expect(content?.[0]).toEqual({ type: 'text', text: P4_PROMPT })
      expect(content?.[1]).toEqual({ type: 'image_url', image_url: { url: DATA_URL } })
    } finally {
      h.restore()
    }
  })

  it('anthropic 协议：内联 base64 source（media_type=image/png）+ 路径 /v1/messages', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ acme: { protocol: 'anthropic' } })
      const { transport, requests } = replyTransport(anthropicReply('red'))
      await runProbeSuite(rt, { probeIds: ['p4'], targets: [TARGET], transport, runner: runP4, confirmed: true })
      expect(requests[0].path).toBe('/v1/messages')
      expect(requests[0].bodyJson?.max_tokens).toBe(200)
      const content = (requests[0].bodyJson?.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]?.content
      expect(content?.[0]).toEqual({ type: 'text', text: P4_PROMPT })
      expect(content?.[1]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: P4_RED_PNG_BASE64 },
      })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })

  it('responses 协议：input_image + max_output_tokens≤200 + 路径 /v1/responses', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ up2: { protocol: 'responses' } })
      const { transport, requests } = replyTransport(JSON.stringify({ output_text: 'It is red!' }))
      await runProbeSuite(rt, {
        probeIds: ['p4'],
        targets: [{ providerId: 'up2', model: 'm', keyFp: 'fp2' }],
        transport,
        runner: runP4,
        confirmed: true,
      })
      expect(requests[0].path).toBe('/v1/responses')
      expect(requests[0].bodyJson?.max_output_tokens).toBe(200)
      const content = (requests[0].bodyJson?.input as Array<{ content: Array<Record<string, unknown>> }>)[0]?.content
      expect(content?.[0]).toEqual({ type: 'input_text', text: P4_PROMPT })
      expect(content?.[1]).toEqual({ type: 'input_image', image_url: DATA_URL })
      expect(getProbeVerdict(rt, 'up2', 'fp2', 'm')?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p4 · 判定（回复含独立词 red）', () => {
  it.each([
    ['It is red!', true],
    ['It is RED.', true],
    ['"red"', true],
    ['It is blue.', false],
    ['我看不到图', false],
    ['The image is colored.', false],
    ['', false],
  ])('回复「%s」→ 通过=%s', async (reply, pass) => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = replyTransport(openaiReply(reply))
      await runProbeSuite(rt, { probeIds: ['p4'], targets: [TARGET], transport, runner: runP4, confirmed: true })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe(pass ? 'healthy' : 'degraded')
    } finally {
      h.restore()
    }
  })

  it('无回复（文本抽取为空）判不通过，错误体含实际回复供人工复核', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = replyTransport(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null } }] }))
      await runProbeSuite(rt, { probeIds: ['p4'], targets: [TARGET], transport, runner: runP4, confirmed: true })
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.err).toContain('P4')
    } finally {
      h.restore()
    }
  })

  it('anthropic 回复壳抽取（content[].text）后同口径判定', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ acme: { protocol: 'anthropic' } })
      const { transport } = replyTransport(anthropicReply('It is red!'))
      await runProbeSuite(rt, { probeIds: ['p4'], targets: [TARGET], transport, runner: runP4, confirmed: true })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p4 · 失败归档（classifyUpstreamFailure 单一口径）', () => {
  it('402 额度特征 → quota（优先于能力判定）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = replyTransport('insufficient quota', { status: 402 })
      await runProbeSuite(rt, { probeIds: ['p4'], targets: [TARGET], transport, runner: runP4, confirmed: true })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('quota')
    } finally {
      h.restore()
    }
  })

  it('401 → auth-dead', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = replyTransport('invalid api key', { status: 401 })
      await runProbeSuite(rt, { probeIds: ['p4'], targets: [TARGET], transport, runner: runP4, confirmed: true })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('auth-dead')
    } finally {
      h.restore()
    }
  })

  it('transport 抛网络错误 → unreachable', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => {
        throw new Error('connect ECONNREFUSED')
      }
      await runProbeSuite(rt, { probeIds: ['p4'], targets: [TARGET], transport, runner: runP4, confirmed: true })
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('unreachable')
      expect(v?.evidence.err).toContain('ECONNREFUSED')
    } finally {
      h.restore()
    }
  })
})

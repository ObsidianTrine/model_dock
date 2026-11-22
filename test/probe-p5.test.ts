import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport, ProbeUpstreamResponse } from '../src/gateway/probe/engine.js'
import { P5_PROMPT, P5_TOOL_NAME, runP5 } from '../src/gateway/probe/runners/p5.js'
import { extractToolUses } from '../src/gateway/probe/wire.js'
import { getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// P5 工具实证 runner（provider-probe-suite 任务 8）：假工具 get_weather(city) + tool_choice
// 强制，校验被调工具名精确匹配且 args JSON 合法（对象形态）——未调工具 / 名不匹配 / 缺 args /
// args 非法一律从严判不通过。全走可注入 transport（零真实网络、零端口监听），fakeHome 隔离。

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

const openaiToolReply = (toolCalls: unknown[], content: string | null = null): string =>
  JSON.stringify({ choices: [{ message: { role: 'assistant', content, tool_calls: toolCalls } }] })
const openaiCall = (name: string, args?: string): Record<string, unknown> => ({
  type: 'function',
  function: args === undefined ? { name } : { name, arguments: args },
})

describe('probe-p5 · 请求拼装（tools 与 tool_choice 强制）', () => {
  it('openai 协议：tools 挂 function 定义 + tool_choice=required + max_tokens≤200', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport, requests } = replyTransport(openaiToolReply([openaiCall(P5_TOOL_NAME, '{"city":"Paris"}')]))
      await runProbeSuite(rt, { probeIds: ['p5'], targets: [TARGET], transport, runner: runP5, confirmed: true })
      expect(requests[0].path).toBe('/v1/chat/completions')
      expect(requests[0].bodyJson?.max_tokens).toBe(200)
      expect(requests[0].bodyJson?.stream).toBe(false)
      expect((requests[0].bodyJson?.messages as Array<{ content: string }>)[0]?.content).toBe(P5_PROMPT)
      const tools = requests[0].bodyJson?.tools as Array<Record<string, unknown>>
      expect(tools).toHaveLength(1)
      expect(tools[0]?.type).toBe('function')
      const fn = tools[0]?.function as Record<string, unknown>
      expect(fn?.name).toBe(P5_TOOL_NAME)
      expect(fn?.parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] })
      expect(requests[0].bodyJson?.tool_choice).toBe('required')
    } finally {
      h.restore()
    }
  })

  it('anthropic 协议：input_schema 工具 + tool_choice={type:tool,name} + 路径 /v1/messages', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ acme: { protocol: 'anthropic' } })
      const { transport, requests } = replyTransport(JSON.stringify({ content: [{ type: 'tool_use', name: P5_TOOL_NAME, input: { city: 'Paris' } }] }))
      await runProbeSuite(rt, { probeIds: ['p5'], targets: [TARGET], transport, runner: runP5, confirmed: true })
      expect(requests[0].path).toBe('/v1/messages')
      const tools = requests[0].bodyJson?.tools as Array<Record<string, unknown>>
      expect(tools[0]?.name).toBe(P5_TOOL_NAME)
      expect(tools[0]?.input_schema).toEqual({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] })
      expect(requests[0].bodyJson?.tool_choice).toEqual({ type: 'tool', name: P5_TOOL_NAME })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })

  it('responses 协议：tools 一等形态（无 function 包装）+ max_output_tokens≤200', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ up2: { protocol: 'responses' } })
      const { transport, requests } = replyTransport(JSON.stringify({ output: [{ type: 'function_call', name: P5_TOOL_NAME, arguments: '{"city":"Paris"}' }] }))
      await runProbeSuite(rt, {
        probeIds: ['p5'],
        targets: [{ providerId: 'up2', model: 'm', keyFp: 'fp2' }],
        transport,
        runner: runP5,
        confirmed: true,
      })
      expect(requests[0].path).toBe('/v1/responses')
      expect(requests[0].bodyJson?.max_output_tokens).toBe(200)
      expect(requests[0].bodyJson?.input).toBe(P5_PROMPT)
      const tools = requests[0].bodyJson?.tools as Array<Record<string, unknown>>
      expect(tools[0]?.type).toBe('function')
      expect(tools[0]?.name).toBe(P5_TOOL_NAME)
      expect(tools[0]?.parameters).toBeDefined()
      expect(requests[0].bodyJson?.tool_choice).toBe('required')
      expect(getProbeVerdict(rt, 'up2', 'fp2', 'm')?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p5 · 判定（tool name 精确匹配 + args 合法）', () => {
  it('get_weather + args 合法 JSON 对象：healthy', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = replyTransport(openaiToolReply([openaiCall(P5_TOOL_NAME, '{"city":"Paris"}')]))
      await runProbeSuite(rt, { probeIds: ['p5'], targets: [TARGET], transport, runner: runP5, confirmed: true })
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('healthy')
      expect(v?.evidence.status).toBe(200)
    } finally {
      h.restore()
    }
  })

  it.each([
    ['调错工具', openaiToolReply([openaiCall('get_time', '{"city":"Paris"}')])],
    ['缺 args（arguments 字段缺席）', openaiToolReply([openaiCall(P5_TOOL_NAME)])],
    ['args 非法 JSON', openaiToolReply([openaiCall(P5_TOOL_NAME, 'not-json{{')])],
    ['args JSON 合法但非对象（标量）', openaiToolReply([openaiCall(P5_TOOL_NAME, '"Paris"')])],
    ['未调工具只回文本', JSON.stringify({ choices: [{ message: { role: 'assistant', content: "It's sunny in Paris, around 18°C." } }] })],
    ['无工具调用', JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] })],
  ])('%s：不通过（degraded）', async (_label, body) => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = replyTransport(body)
      await runProbeSuite(rt, { probeIds: ['p5'], targets: [TARGET], transport, runner: runP5, confirmed: true })
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.err).toContain('P5')
    } finally {
      h.restore()
    }
  })

  it('多次工具调用其中一次合规即通过', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = replyTransport(
        openaiToolReply([openaiCall('get_time', '{"tz":"UTC"}'), openaiCall(P5_TOOL_NAME, '{"city":"Paris"}')])
      )
      await runProbeSuite(rt, { probeIds: ['p5'], targets: [TARGET], transport, runner: runP5, confirmed: true })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })

  it('anthropic tool_use：input 对象合规通过；input 缺席/名不匹配不通过', async () => {
    const h = fakeHome()
    try {
      const rt1 = mkRt()
      const { transport: t1 } = replyTransport(JSON.stringify({ content: [{ type: 'tool_use', name: P5_TOOL_NAME, input: { city: 'Paris' } }] }))
      await runProbeSuite(rt1, { probeIds: ['p5'], targets: [TARGET], transport: t1, runner: runP5, confirmed: true })
      expect(getProbeVerdict(rt1, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('healthy')

      const rt2 = mkRt()
      const { transport: t2 } = replyTransport(JSON.stringify({ content: [{ type: 'tool_use', name: P5_TOOL_NAME }] }))
      await runProbeSuite(rt2, { probeIds: ['p5'], targets: [TARGET], transport: t2, runner: runP5, confirmed: true })
      expect(getProbeVerdict(rt2, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('degraded')

      const rt3 = mkRt()
      const { transport: t3 } = replyTransport(JSON.stringify({ content: [{ type: 'tool_use', name: 'get_time', input: { city: 'Paris' } }] }))
      await runProbeSuite(rt3, { probeIds: ['p5'], targets: [TARGET], transport: t3, runner: runP5, confirmed: true })
      expect(getProbeVerdict(rt3, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('degraded')
    } finally {
      h.restore()
    }
  })

  it('anthropic 混合 content（text + tool_use）同口径判定', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = replyTransport(
        JSON.stringify({ content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', name: P5_TOOL_NAME, input: {} }] })
      )
      await runProbeSuite(rt, { probeIds: ['p5'], targets: [TARGET], transport, runner: runP5, confirmed: true })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p5 · 失败归档（classifyUpstreamFailure 单一口径）', () => {
  it('402 额度特征 → quota（优先于能力判定）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = replyTransport('insufficient quota', { status: 402 })
      await runProbeSuite(rt, { probeIds: ['p5'], targets: [TARGET], transport, runner: runP5, confirmed: true })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('quota')
    } finally {
      h.restore()
    }
  })

  it('transport 抛网络错误 → unreachable', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => {
        throw new Error('connect ETIMEDOUT')
      }
      await runProbeSuite(rt, { probeIds: ['p5'], targets: [TARGET], transport, runner: runP5, confirmed: true })
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('unreachable')
      expect(v?.evidence.err).toContain('ETIMEDOUT')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p5 · extractToolUses 三形态抽取（wire 容错）', () => {
  it('openai tool_calls / anthropic tool_use / responses function_call 全形态命中', () => {
    expect(extractToolUses(openaiToolReply([openaiCall(P5_TOOL_NAME, '{"city":"Paris"}')]))).toEqual([
      { name: P5_TOOL_NAME, argsText: '{"city":"Paris"}' },
    ])
    expect(
      extractToolUses(JSON.stringify({ content: [{ type: 'tool_use', name: P5_TOOL_NAME, input: { city: 'Paris' } }] }))
    ).toEqual([{ name: P5_TOOL_NAME, input: { city: 'Paris' } }])
    expect(
      extractToolUses(JSON.stringify({ output: [{ type: 'function_call', name: P5_TOOL_NAME, arguments: '{"city":"Paris"}' }] }))
    ).toEqual([{ name: P5_TOOL_NAME, argsText: '{"city":"Paris"}' }])
  })

  it('无工具调用 / 非 JSON / 空体返回空数组', () => {
    expect(extractToolUses(openaiToolReply([]))).toEqual([])
    expect(extractToolUses('plain text, not json')).toEqual([])
    expect(extractToolUses(undefined)).toEqual([])
  })

  it('openai 省略 type 字段、arguments 非字符串的宽容形态', () => {
    expect(
      extractToolUses(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: P5_TOOL_NAME, arguments: 42 } }] } }] }))
    ).toEqual([{ name: P5_TOOL_NAME }])
  })
})

import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport, ProbeUpstreamResponse } from '../src/gateway/probe/engine.js'
import { hasReasoningChannel, runP7 } from '../src/gateway/probe/runners/p7.js'
import { getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// P7 推理识别 runner（provider-probe-suite 任务 7）：两种形态任一检出即判支持——OpenAI 系
// message.reasoning_content（GLM/DeepSeek R1 系）与 Anthropic thinking 块（content[].type=
// 'thinking'）；正文里写 step-by-step 不算通道，空 reasoning_content 也不算。全走可注入
// transport（零真实网络、零端口监听），fakeHome 隔离落盘。

function mkRt(providers: Record<string, { protocol: string }> = {}): GatewayRuntime {
  return buildRuntime({ providers, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const TARGET = { providerId: 'acme', model: 'glm-4.6', keyFp: 'fp1' }

function bodyTransport(bodyText: string, opts: { status?: number } = {}): {
  transport: ProbeTransport
  requests: Array<{ path?: string; bodyJson?: Record<string, unknown> }>
} {
  const requests: Array<{ path?: string; bodyJson?: Record<string, unknown> }> = []
  const transport: ProbeTransport = async (req) => {
    requests.push({
      path: req.path,
      bodyJson: req.body ? (JSON.parse(req.body.toString('utf8')) as Record<string, unknown>) : undefined,
    })
    const resp: ProbeUpstreamResponse = { status: opts.status ?? 200, ms: 120, bodyText, usage: { completion_tokens: 30 } }
    return resp
  }
  return { transport, requests }
}

describe('probe-p7 · 两种形态检出', () => {
  it('OpenAI 系 reasoning_content（非空）：healthy；请求按 max_tokens≤200 钳制且非流式', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '391', reasoning_content: '17*23=391 because 17*20=340 + 17*3=51' } }] })
      const { transport, requests } = bodyTransport(body)
      await runProbeSuite(rt, { probeIds: ['p7'], targets: [TARGET], transport, runner: runP7, confirmed: true })
      expect(requests[0].path).toBe('/v1/chat/completions')
      expect(requests[0].bodyJson?.max_tokens).toBe(200)
      expect(requests[0].bodyJson?.stream).toBe(false)
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('healthy')
      expect(v?.evidence.status).toBe(200)
    } finally {
      h.restore()
    }
  })

  it('Anthropic thinking 块（content[].type=thinking）：healthy', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ acme: { protocol: 'anthropic' } })
      const body = JSON.stringify({
        content: [
          { type: 'thinking', thinking: '17*23: 340+51=391', signature: 'sig' },
          { type: 'text', text: '391' },
        ],
      })
      const { transport, requests } = bodyTransport(body)
      await runProbeSuite(rt, { probeIds: ['p7'], targets: [TARGET], transport, runner: runP7, confirmed: true })
      expect(requests[0].path).toBe('/v1/messages')
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })

  it('两种形态均缺席（过程写在正文）：degraded', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Step 1: 17*20=340. Step 2: 17*3=51. Answer: 391' } }] })
      const { transport } = bodyTransport(body)
      await runProbeSuite(rt, { probeIds: ['p7'], targets: [TARGET], transport, runner: runP7, confirmed: true })
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.err).toContain('P7')
    } finally {
      h.restore()
    }
  })

  it('reasoning_content 空串：不算通道（未实际产出）→ degraded', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '391', reasoning_content: '' } }] })
      const { transport } = bodyTransport(body)
      await runProbeSuite(rt, { probeIds: ['p7'], targets: [TARGET], transport, runner: runP7, confirmed: true })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('degraded')
    } finally {
      h.restore()
    }
  })

  it('401 → auth-dead（失败归档优先）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = bodyTransport('{"error":{"message":"invalid key"}}', { status: 401 })
      await runProbeSuite(rt, { probeIds: ['p7'], targets: [TARGET], transport, runner: runP7, confirmed: true })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('auth-dead')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p7 · hasReasoningChannel 纯函数', () => {
  it('非 JSON / 无 message / 空 reasoning_content / 非数组 content / undefined 均为 false；delta 形态不算（P7 非流式）', () => {
    expect(hasReasoningChannel('not json')).toBe(false)
    expect(hasReasoningChannel(JSON.stringify({ content: 'plain text' }))).toBe(false)
    expect(hasReasoningChannel(JSON.stringify({ choices: [{ message: { reasoning_content: '  ' } }] }))).toBe(false)
    expect(hasReasoningChannel(JSON.stringify({ choices: [{ delta: { reasoning_content: 'x' } }] }))).toBe(false)
    expect(hasReasoningChannel(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }))).toBe(false)
    expect(hasReasoningChannel(undefined)).toBe(false)
    expect(hasReasoningChannel(JSON.stringify({ choices: [{ message: { reasoning_content: 'x' } }] }))).toBe(true)
    expect(hasReasoningChannel(JSON.stringify({ content: [{ type: 'thinking', thinking: 'x' }] }))).toBe(true)
  })
})

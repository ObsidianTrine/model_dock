import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport, ProbeUnitContext, ProbeUpstreamResponse } from '../src/gateway/probe/engine.js'
import { P3_TTFB_MAX_MS, countSseChunks, runP3 } from '../src/gateway/probe/runners/p3.js'
import { classifyUpstreamFailure } from '../src/gateway/probe/runners/shared.js'
import { getProbeDef } from '../src/gateway/probe/registry.js'
import { getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// P3 流式链路 runner（provider-probe-suite 任务 7）：mock transport 分别驱动流式（多分片带
// 逐片到达时刻）/ 非流式（普通 JSON 体）/ 伪流式（单 chunk）三形态，断言判定结论符合 design
// 判定规则 5——TTFB≤30s 记入证据、0 分片判不支持、≥1 分片即流式通道实证。全走可注入
// transport（零真实网络、零端口监听），fakeHome 隔离账本与 verdict 落盘。

function mkRt(providers: Record<string, { protocol: string }> = {}): GatewayRuntime {
  return buildRuntime({ providers, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const TARGET = { providerId: 'acme', model: 'glm-4.6', keyFp: 'fp1' }

/** 捕获请求的透传 mock：断言 runner 确实按 stream=true + max_tokens 钳制拼装请求 */
function capturingTransport(resp: ProbeUpstreamResponse): {
  transport: ProbeTransport
  requests: Array<{ path?: string; bodyJson?: Record<string, unknown> }>
} {
  const requests: Array<{ path?: string; bodyJson?: Record<string, unknown> }> = []
  const transport: ProbeTransport = async (req) => {
    requests.push({
      path: req.path,
      bodyJson: req.body ? (JSON.parse(req.body.toString('utf8')) as Record<string, unknown>) : undefined,
    })
    return resp
  }
  return { transport, requests }
}

describe('probe-p3 · 三形态判定', () => {
  it('流式（多分片带到达时刻）：healthy，证据耗时 = 首片 TTFB，账本按 usage 记账', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const sse = 'data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: [DONE]\n'
      const { transport, requests } = capturingTransport({
        status: 200,
        ms: 240,
        bodyText: sse,
        chunks: [120, 180, 240],
        usage: { completion_tokens: 42, prompt_tokens: 8 },
      })
      const r = await runProbeSuite(rt, { probeIds: ['p3'], targets: [TARGET], transport, runner: runP3, confirmed: true })
      expect(r.ok).toBe(true)
      expect(r.upstreamRequests).toBe(1)
      // 请求确为流式且输出钳制 200（openai 形态）
      expect(requests).toHaveLength(1)
      expect(requests[0].path).toBe('/v1/chat/completions')
      expect(requests[0].bodyJson?.stream).toBe(true)
      expect(requests[0].bodyJson?.max_tokens).toBe(200)
      // 结论：healthy；TTFB（首片 120ms）记入证据耗时槽
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('healthy')
      expect(v?.evidence.ms).toBe(120)
      expect(v?.evidence.status).toBe(200)
      // 账本：usage 正数字段合计（42+8）入账，预估按 M 档
      const entries = await readProbeLedger()
      expect(entries).toHaveLength(1)
      expect(entries[0].probe_id).toBe('p3')
      expect(entries[0].tokens).toBe(50)
      expect(entries[0].estimated_tokens).toBe(getProbeDef('p3')?.unitTokens)
      expect(r.estimate).toBe(getProbeDef('p3')?.unitTokens)
    } finally {
      h.restore()
    }
  })

  it('非流式（普通 JSON 体、0 分片）：degraded——0 分片判不支持', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = capturingTransport({
        status: 200,
        ms: 150,
        bodyText: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }),
        usage: { completion_tokens: 4 },
      })
      const r = await runProbeSuite(rt, { probeIds: ['p3'], targets: [TARGET], transport, runner: runP3, confirmed: true })
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.err).toContain('P3')
      expect(v?.evidence.status).toBe(200)
      expect(r.upstreamRequests).toBe(1)
    } finally {
      h.restore()
    }
  })

  it('伪流式（单 chunk）：healthy——design 的不支持判据只有 0 分片，≥1 分片即流式通道实证', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = capturingTransport({
        status: 200,
        ms: 95,
        bodyText: 'data: {"choices":[{"delta":{"content":"whole answer"}}]}\n\ndata: [DONE]\n',
        chunks: [90],
        usage: { completion_tokens: 6 },
      })
      await runProbeSuite(rt, { probeIds: ['p3'], targets: [TARGET], transport, runner: runP3, confirmed: true })
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('healthy')
      expect(v?.evidence.ms).toBe(90)
    } finally {
      h.restore()
    }
  })

  it('transport 未逐片计时但 body 为 SSE：按 data 行计数兜底判 healthy，耗时槽退回调用总耗时', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = capturingTransport({
        status: 200,
        ms: 210,
        bodyText: 'data: a\n\ndata: b\n\ndata: c\n\ndata: [DONE]\n',
        usage: { completion_tokens: 3 },
      })
      await runProbeSuite(rt, { probeIds: ['p3'], targets: [TARGET], transport, runner: runP3, confirmed: true })
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('healthy')
      expect(v?.evidence.ms).toBe(210)
    } finally {
      h.restore()
    }
  })

  it('首片超 30s：degraded（TTFB≤30s 记录的越界侧）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = capturingTransport({
        status: 200,
        ms: 35_500,
        bodyText: 'data: {"choices":[{"delta":{"content":"late"}}]}\n\n',
        chunks: [P3_TTFB_MAX_MS + 500],
        usage: {},
      })
      await runProbeSuite(rt, { probeIds: ['p3'], targets: [TARGET], transport, runner: runP3, confirmed: true })
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.ms).toBe(P3_TTFB_MAX_MS + 500)
    } finally {
      h.restore()
    }
  })

  it('anthropic 协议分支：/v1/messages + max_tokens 钳制照常生效', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ acme: { protocol: 'anthropic' } })
      const { transport, requests } = capturingTransport({
        status: 200,
        ms: 120,
        bodyText: 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
        usage: { completion_tokens: 2 },
      })
      await runProbeSuite(rt, { probeIds: ['p3'], targets: [TARGET], transport, runner: runP3, confirmed: true })
      expect(requests[0].path).toBe('/v1/messages')
      expect(requests[0].bodyJson?.stream).toBe(true)
      expect(requests[0].bodyJson?.max_tokens).toBe(200)
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('healthy') // 1 条 data 行（event: 行不计数）
    } finally {
      h.restore()
    }
  })
})

describe('probe-p3 · 失败归档与共享分类', () => {
  it('401 → auth-dead；网络异常 → unreachable', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = capturingTransport({ status: 401, ms: 20, bodyText: '{"error":{"message":"bad key"}}' })
      await runProbeSuite(rt, { probeIds: ['p3'], targets: [TARGET], transport, runner: runP3, confirmed: true })
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('auth-dead')

      const rt2 = mkRt()
      const ctx: ProbeUnitContext = { rt: rt2, def: getProbeDef('p3')!, target: TARGET, transport: async () => { throw new Error('ECONNREFUSED') }, signal: undefined }
      const o = await runP3(ctx)
      expect(o.state).toBe('unreachable')
      expect(o.err).toBe('ECONNREFUSED')
      expect(o.calls).toHaveLength(0)
    } finally {
      h.restore()
    }
  })

  it('classifyUpstreamFailure：401/403、quota 特征、普通 429（rateLimited）、其余 4xx/5xx、成功 undefined', () => {
    expect(classifyUpstreamFailure(401, '', undefined)?.state).toBe('auth-dead')
    expect(classifyUpstreamFailure(403, '', undefined)?.state).toBe('auth-dead')
    expect(classifyUpstreamFailure(402, '', undefined)?.state).toBe('quota')
    expect(classifyUpstreamFailure(429, 'insufficient quota', undefined)?.state).toBe('quota')
    const rl = classifyUpstreamFailure(429, 'rate limited', '2')
    expect(rl?.state).toBe('degraded')
    expect(rl?.rateLimited).toBe(true)
    expect(rl?.retryAfter).toBe('2')
    expect(classifyUpstreamFailure(500, 'boom', undefined)?.state).toBe('degraded')
    expect(classifyUpstreamFailure(200, 'ok', undefined)).toBeUndefined()
  })
})

describe('probe-p3 · SSE 计数纯函数', () => {
  it('data 行计数：[DONE] 剔除、空载/注释行不计、非 SSE 为 0', () => {
    expect(countSseChunks('data: a\n\ndata: [DONE]\n')).toBe(1)
    expect(countSseChunks('data: a\n\ndata: b\n\ndata: c\n')).toBe(3)
    expect(countSseChunks(': keepalive\n\ndata:\n\ndata:   \n')).toBe(0)
    expect(countSseChunks(JSON.stringify({ choices: [] }))).toBe(0)
    expect(countSseChunks(undefined)).toBe(0)
  })
})

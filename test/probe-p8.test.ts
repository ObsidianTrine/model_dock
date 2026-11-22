import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport, ProbeUpstreamResponse } from '../src/gateway/probe/engine.js'
import { P8_ASSIST_FILLER, P8_PLANT_PROMPT, P8_RECALL_PROMPT, runP8 } from '../src/gateway/probe/runners/p8.js'
import { getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// P8 上下文保持 runner（provider-probe-suite 任务 9）：两轮小明埋取。两请求经同一可注入
// transport（零真实网络、零端口监听），历史由请求体自带——mock 全部无状态，按请求体内容
// 决定回答，忠实/丢历史两种中转行为各一。fakeHome 隔离落盘。

function mkRt(providers: Record<string, { protocol: string }> = {}): GatewayRuntime {
  return buildRuntime({ providers, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const TARGET = { providerId: 'acme', model: 'glm-4.6', keyFp: 'fp1' }

interface CapturedBody {
  messages?: Array<{ role: string; content: string }>
  input?: unknown
  max_tokens?: number
  max_output_tokens?: number
  stream?: boolean
}

/** 无状态忠实上游：请求体同时含埋名与问名（历史自带）才答得出小明——transport 无状态，
 *  正是「历史由请求体自带」的可测形态 */
function faithfulTransport(opts: { usage?: Record<string, number> } = {}): {
  transport: ProbeTransport
  bodies: CapturedBody[]
} {
  const bodies: CapturedBody[] = []
  const transport: ProbeTransport = async (req) => {
    const bodyJson: CapturedBody = req.body ? (JSON.parse(req.body.toString('utf8')) as CapturedBody) : {}
    bodies.push(bodyJson)
    const text = JSON.stringify(bodyJson)
    const answer =
      text.includes(P8_RECALL_PROMPT) && text.includes(P8_PLANT_PROMPT)
        ? '你叫小明。'
        : text.includes(P8_PLANT_PROMPT)
          ? P8_ASSIST_FILLER
          : '我不知道你的名字。'
    const usage: Record<string, number> = opts.usage ?? { prompt_tokens: 10, completion_tokens: 2 }
    const resp: ProbeUpstreamResponse = {
      status: 200,
      ms: 10,
      bodyText: JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }),
      usage,
    }
    return resp
  }
  return { transport, bodies }
}

/** 丢历史中转：只把最后一条消息转给模型（历史被剥掉）——轮 2 模型只看到问名，答不出小明 */
function droppingTransport(): ProbeTransport {
  return async (req) => {
    const bodyJson: CapturedBody = req.body ? (JSON.parse(req.body.toString('utf8')) as CapturedBody) : {}
    const msgs = Array.isArray(bodyJson.messages) ? bodyJson.messages : Array.isArray(bodyJson.input) ? (bodyJson.input as Array<{ role: string; content: string }>) : []
    const last = msgs.length ? [msgs[msgs.length - 1]] : []
    const seen = JSON.stringify(last)
    const answer = seen.includes(P8_RECALL_PROMPT) ? '抱歉，你还没告诉我你的名字。' : '好的，小明。'
    return { status: 200, ms: 10, bodyText: JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }) }
  }
}

const runP8Suite = (rt: GatewayRuntime, transport: ProbeTransport) =>
  runProbeSuite(rt, { probeIds: ['p8'], targets: [TARGET], transport, runner: runP8, confirmed: true })

describe('probe-p8 · 请求拼装（两轮历史自带）', () => {
  it('openai 协议：轮 1 单条埋名、轮 2 三条全量历史（assistant 占位「好的」），max_tokens≤200', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport, bodies } = faithfulTransport()
      await runP8Suite(rt, transport)
      expect(bodies).toHaveLength(2)
      expect(bodies[0].messages).toEqual([{ role: 'user', content: P8_PLANT_PROMPT }])
      expect(bodies[1].messages).toEqual([
        { role: 'user', content: P8_PLANT_PROMPT },
        { role: 'assistant', content: P8_ASSIST_FILLER },
        { role: 'user', content: P8_RECALL_PROMPT },
      ])
      expect(bodies[0].max_tokens).toBe(200)
      expect(bodies[0].stream).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('responses 协议：历史走 input 数组（与 messages 同构），max_output_tokens≤200；anthropic 走 /v1/messages', async () => {
    const h = fakeHome()
    try {
      const rtR = mkRt({ upr: { protocol: 'responses' } })
      const targetR = { providerId: 'upr', model: 'm', keyFp: 'fpr' }
      const { transport: tR, bodies: bR } = faithfulTransport()
      await runProbeSuite(rtR, { probeIds: ['p8'], targets: [targetR], transport: tR, runner: runP8, confirmed: true })
      expect(Array.isArray(bR[0].input)).toBe(true)
      expect(bR[1].input).toEqual([
        { role: 'user', content: P8_PLANT_PROMPT },
        { role: 'assistant', content: P8_ASSIST_FILLER },
        { role: 'user', content: P8_RECALL_PROMPT },
      ])
      expect(bR[0].max_output_tokens).toBe(200)
      expect(bR[0].max_tokens).toBeUndefined()

      const rtA = mkRt({ upa: { protocol: 'anthropic' } })
      const targetA = { providerId: 'upa', model: 'm', keyFp: 'fpa' }
      const anthropicReply: ProbeUpstreamResponse = {
        status: 200,
        ms: 10,
        bodyText: JSON.stringify({ content: [{ type: 'text', text: '你叫小明。' }] }),
      }
      const paths: string[] = []
      const tA: ProbeTransport = async (req) => {
        paths.push(req.path ?? '')
        return anthropicReply
      }
      await runProbeSuite(rtA, { probeIds: ['p8'], targets: [targetA], transport: tA, runner: runP8, confirmed: true })
      expect(paths).toEqual(['/v1/messages', '/v1/messages'])
      expect(getProbeVerdict(rtA, 'upa', 'fpa', 'm')?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p8 · 判定（含小明通过 / 不含不通过）', () => {
  it('轮 2 回答含「小明」：healthy，两请求两记账', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = faithfulTransport()
      const r = await runP8Suite(rt, transport)
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('healthy')
      expect(v?.evidence.status).toBe(200)
      expect(r.upstreamRequests).toBe(2)
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(2)
      expect(ledger.every((e) => e.probe_id === 'p8' && e.tokens === 12 && e.estimated_tokens === 200)).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('丢历史中转（轮 2 只剩问名）：模型答不出小明 → degraded，err 指向 P8', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      await runP8Suite(rt, droppingTransport())
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.err).toContain('P8')
    } finally {
      h.restore()
    }
  })

  it('轮 2 回答不含小明（改写痕迹）：degraded，实际回复入 err', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => ({
        status: 200,
        ms: 10,
        bodyText: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '抱歉，我没有听清你的名字。' } }] }),
      })
      await runP8Suite(rt, transport)
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.err).toContain('小明')
    } finally {
      h.restore()
    }
  })

  it('轮 1 401 → auth-dead 且不再发轮 2（1 次上游请求）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      let calls = 0
      const transport: ProbeTransport = async () => {
        calls++
        return { status: 401, ms: 5, bodyText: JSON.stringify({ error: { message: 'invalid api key' } }) }
      }
      await runP8Suite(rt, transport)
      expect(calls).toBe(1)
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('auth-dead')
    } finally {
      h.restore()
    }
  })

  it('轮 2 402 额度特征 → quota（两轮都入账）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      let calls = 0
      const transport: ProbeTransport = async () => {
        calls++
        if (calls === 1) return { status: 200, ms: 5, bodyText: JSON.stringify({ choices: [{ message: { content: '好的' } }] }) }
        return { status: 402, ms: 5, bodyText: 'insufficient quota' }
      }
      await runP8Suite(rt, transport)
      expect(calls).toBe(2)
      expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('quota')
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(2)
    } finally {
      h.restore()
    }
  })
})

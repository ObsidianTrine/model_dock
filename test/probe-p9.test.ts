import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport, ProbeUpstreamResponse } from '../src/gateway/probe/engine.js'
import { P9_CANARY, P9_SYSTEM_PROMPT, P9_USER_PROMPT, runP9 } from '../src/gateway/probe/runners/p9.js'
import { canaryExactReply } from '../src/gateway/probe/runners/shared.js'
import { getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// P9 system 尊重 runner（provider-probe-suite 任务 9）：system canary Banana，trim 精确匹配
// + 一次剥引号兜底。mock 是「system 感知」的无状态上游：读到含 Banana 的 system 就答 Banana、
// 含 Apple 就答 Apple——中转注入/改写 system 后忠实模型的回答随之变，判定只认回复文本。
// fakeHome 隔离落盘；P9 为 canary 类单次判定（1 请求/样本）。

function mkRt(providers: Record<string, { protocol: string }> = {}): GatewayRuntime {
  return buildRuntime({ providers, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const TARGET = { providerId: 'acme', model: 'glm-4.6', keyFp: 'fp1' }

const APPLE_SYSTEM = 'Your codename is Apple. Reply with exactly Apple and nothing else.'

interface CapturedBody {
  messages?: Array<{ role: string; content: string }>
  system?: unknown
  instructions?: unknown
  max_tokens?: number
  max_output_tokens?: number
  stream?: boolean
}

/** system 感知上游：回复由它看到的 system 决定（Banana→Banana、Apple→Apple、无 system→无名义回答） */
function systemAwareTransport(replyOverride?: (sys: string) => string): {
  transport: ProbeTransport
  seenSystems: string[]
  bodies: CapturedBody[]
} {
  const seenSystems: string[] = []
  const bodies: CapturedBody[] = []
  const transport: ProbeTransport = async (req) => {
    const b: CapturedBody = req.body ? (JSON.parse(req.body.toString('utf8')) as CapturedBody) : {}
    bodies.push(b)
    const sys = typeof b.system === 'string' ? b.system : typeof b.instructions === 'string' ? b.instructions : (b.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
    seenSystems.push(sys)
    const answer = replyOverride ? replyOverride(sys) : sys.includes(P9_CANARY) ? P9_CANARY : sys.includes('Apple') ? 'Apple' : 'I have no name.'
    const resp: ProbeUpstreamResponse = {
      status: 200,
      ms: 10,
      bodyText: JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }),
      usage: { prompt_tokens: 15, completion_tokens: 2 },
    }
    return resp
  }
  return { transport, seenSystems, bodies }
}

/** 中转注入模拟：把请求里的 system（三种协议槽位）整体替换为 Apple canary 再转给上游 */
function injectingTransport(inner: ProbeTransport): ProbeTransport {
  return async (req) => {
    const b: CapturedBody = req.body ? (JSON.parse(req.body.toString('utf8')) as CapturedBody) : {}
    if (Array.isArray(b.messages) && b.messages[0]?.role === 'system') b.messages[0] = { role: 'system', content: APPLE_SYSTEM }
    if (typeof b.system === 'string') b.system = APPLE_SYSTEM
    if (typeof b.instructions === 'string') b.instructions = APPLE_SYSTEM
    return inner({ ...req, ...(req.body != null ? { body: Buffer.from(JSON.stringify(b)) } : {}) })
  }
}

const runP9Suite = (rt: GatewayRuntime, transport: ProbeTransport) =>
  runProbeSuite(rt, { probeIds: ['p9'], targets: [TARGET], transport, runner: runP9, confirmed: true })

describe('probe-p9 · 请求拼装（system 三协议槽位）', () => {
  it('openai：messages[0]={role:system}；anthropic：顶层 system；responses：instructions——max_tokens≤200', async () => {
    const h = fakeHome()
    try {
      const { transport: tO, bodies: bO, seenSystems: sO } = systemAwareTransport()
      await runP9Suite(mkRt(), tO)
      expect(bO[0].messages?.[0]).toEqual({ role: 'system', content: P9_SYSTEM_PROMPT })
      expect(bO[0].messages?.[1]?.content).toBe(P9_USER_PROMPT)
      expect(bO[0].max_tokens).toBe(200)
      expect(bO[0].stream).toBe(false)
      expect(sO[0]).toBe(P9_SYSTEM_PROMPT)

      const rtA = mkRt({ upa: { protocol: 'anthropic' } })
      const { transport: tA, seenSystems: sA } = systemAwareTransport()
      await runProbeSuite(rtA, { probeIds: ['p9'], targets: [{ providerId: 'upa', model: 'm', keyFp: 'fpa' }], transport: tA, runner: runP9, confirmed: true })
      expect(sA[0]).toBe(P9_SYSTEM_PROMPT)
      expect(getProbeVerdict(rtA, 'upa', 'fpa', 'm')?.state).toBe('healthy')

      const rtR = mkRt({ upr: { protocol: 'responses' } })
      const { transport: tR, bodies: bR, seenSystems: sR } = systemAwareTransport()
      await runProbeSuite(rtR, { probeIds: ['p9'], targets: [{ providerId: 'upr', model: 'm', keyFp: 'fpr' }], transport: tR, runner: runP9, confirmed: true })
      expect(bR[0].instructions).toBe(P9_SYSTEM_PROMPT)
      expect(bR[0].max_output_tokens).toBe(200)
      expect(sR[0]).toBe(P9_SYSTEM_PROMPT)
      expect(getProbeVerdict(rtR, 'upr', 'fpr', 'm')?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p9 · 判定（Banana 精确匹配 + 一次剥引号兜底）', () => {
  it('回复恰为 Banana：healthy', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = systemAwareTransport()
      await runP9Suite(rt, transport)
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('healthy')
      expect(v?.evidence.status).toBe(200)
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(1)
      expect(ledger[0]?.probe_id).toBe('p9')
      expect(ledger[0]?.tokens).toBe(17)
      expect(ledger[0]?.estimated_tokens).toBe(200)
    } finally {
      h.restore()
    }
  })

  it('引号包裹的忠实转述（"Banana" / “Banana” / \'Banana\'）：一次剥引号后通过', async () => {
    const h = fakeHome()
    try {
      for (const quoted of ['"Banana"', '“Banana”', "'Banana'"]) {
        const rt = mkRt()
        const transport: ProbeTransport = async () => ({
          status: 200,
          ms: 10,
          bodyText: JSON.stringify({ choices: [{ message: { role: 'assistant', content: quoted } }] }),
        })
        await runP9Suite(rt, transport)
        expect(getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('healthy')
      }
    } finally {
      h.restore()
    }
  })

  it('I am Banana-2（近似改写）：不通过', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => ({
        status: 200,
        ms: 10,
        bodyText: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'I am Banana-2' } }] }),
      })
      await runP9Suite(rt, transport)
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.err).toContain('P9')
    } finally {
      h.restore()
    }
  })

  it('system 被中转改写为其他水果：模型答 Apple → 不通过', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport: inner, seenSystems } = systemAwareTransport()
      await runP9Suite(rt, injectingTransport(inner))
      expect(seenSystems[0]).toBe(APPLE_SYSTEM) // 改写确实抵达上游
      const v = getProbeVerdict(rt, TARGET.providerId, TARGET.keyFp, TARGET.model)
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.err).toContain('Apple')
    } finally {
      h.restore()
    }
  })

  it('空回复从严不通过；401 → auth-dead（失败归档优先）', async () => {
    const h = fakeHome()
    try {
      const rt1 = mkRt()
      const t1: ProbeTransport = async () => ({ status: 200, ms: 5, bodyText: JSON.stringify({ choices: [{ message: { content: '' } }] }) })
      await runP9Suite(rt1, t1)
      expect(getProbeVerdict(rt1, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('degraded')

      const rt2 = mkRt()
      const t2: ProbeTransport = async () => ({ status: 401, ms: 5, bodyText: JSON.stringify({ error: { message: 'bad key' } }) })
      await runP9Suite(rt2, t2)
      expect(getProbeVerdict(rt2, TARGET.providerId, TARGET.keyFp, TARGET.model)?.state).toBe('auth-dead')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p9 · canaryExactReply 纯函数', () => {
  it('trim 全等 + 一次剥引号；改写/嵌套引号/空值不匹配', () => {
    expect(canaryExactReply('Banana', 'Banana')).toBe(true)
    expect(canaryExactReply('  Banana  ', 'Banana')).toBe(true)
    expect(canaryExactReply('"Banana"', 'Banana')).toBe(true)
    expect(canaryExactReply('“Banana”', 'Banana')).toBe(true)
    expect(canaryExactReply("'Banana'", 'Banana')).toBe(true)
    expect(canaryExactReply('“ Banana ”', 'Banana')).toBe(true)
    expect(canaryExactReply('I am Banana-2', 'Banana')).toBe(false)
    expect(canaryExactReply('banana', 'Banana')).toBe(false)
    expect(canaryExactReply('"\"Banana\""', 'Banana')).toBe(false) // 两层引号只剥一层（宁严勿松）
    expect(canaryExactReply('"Banana', 'Banana')).toBe(false)
    expect(canaryExactReply('', 'Banana')).toBe(false)
    expect(canaryExactReply(undefined, 'Banana')).toBe(false)
  })
})

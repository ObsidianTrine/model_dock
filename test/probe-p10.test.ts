import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { providerProbeInCooldown, runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport } from '../src/gateway/probe/engine.js'
import { P10_MAX_TOKENS, P10_QUESTIONS, buildP10Prompt, extractLastNumber, runP10 } from '../src/gateway/probe/runners/p10.js'
import { applyVerdictEvidence, getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// P10 算术金丝（provider-probe-suite 任务 12）：定点题库 20 题逐题发问、回复取数比对正确率。
// 恒 advisory——20 题全对 verdict 不变、19 对仅 advisory 字段出现（正确率<100% 不翻状态）。
// jittery 类 3 采样由引擎调度（单样本 = 整套题库），全走可注入 transport（零网络、零端口），
// fakeHome 隔离账本与 verdict 落盘。

function mkRt(): GatewayRuntime {
  return buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const TARGET = { providerId: 'acme', model: 'glm-4.6', keyFp: 'fp1' }

interface QuizMockOpts {
  /** 指定题目的错误回复（模拟模型算错/答非所问） */
  wrongFor?: string
  wrongReply?: string
  /** 恒定硬失败/限流状态（按调用返回；用于第 1 题即失败的样本级语义） */
  failStatus?: number
  failBody?: string
  /** 指定题面算式抛网络异常（按题触发保证 3 个采样行为一致——采样按题目序重跑整套题库） */
  netFailOnExpr?: string
}

/** 按题面算式查表作答的 mock 上游：从请求体解析「Compute exactly: <expr>.」取答案 */
function quizMock(opts: QuizMockOpts = {}): { transport: ProbeTransport; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = []
  const transport: ProbeTransport = async (req) => {
    const bodyJson = JSON.parse((req.body ?? Buffer.alloc(0)).toString('utf8')) as { messages?: Array<{ content?: string }> }
    const content = bodyJson.messages?.[0]?.content ?? ''
    const expr = /^Compute exactly: (.+?)\./.exec(content)?.[1] ?? ''
    if (opts.netFailOnExpr != null && opts.netFailOnExpr === expr) throw new Error('boom')
    bodies.push(bodyJson)
    const q = P10_QUESTIONS.find((x) => x.expr === expr)
    if (!q) throw new Error(`quiz mock: unknown expr "${expr}"`)
    if (opts.failStatus) return { status: opts.failStatus, ms: 3, bodyText: opts.failBody ?? '{"error":{"message":"upstream rejected"}}' }
    const answer = opts.wrongFor === expr ? (opts.wrongReply ?? String(q.answer)) : String(q.answer)
    return {
      status: 200,
      ms: 4,
      bodyText: JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }),
      usage: { completion_tokens: 4, prompt_tokens: 9 },
    }
  }
  return { transport, bodies }
}

const runP10Suite = (rt: GatewayRuntime, transport: ProbeTransport) =>
  runProbeSuite(rt, { probeIds: ['p10'], targets: [TARGET], transport, runner: runP10, confirmed: true })

/** 极简四则求值器（题库答案自检用）：+ - * / 与两级优先级，操作数全为正整数 */
function evalExpr(expr: string): number {
  const tokens = expr.match(/\d+|[+\-*/]/g) ?? []
  const vals: number[] = [Number(tokens[0])]
  const ops: string[] = []
  let i = 1
  while (i < tokens.length) {
    const op = tokens[i++]
    const n = Number(tokens[i++])
    if (op === '*') vals[vals.length - 1] = vals[vals.length - 1] * n
    else if (op === '/') vals[vals.length - 1] = vals[vals.length - 1] / n
    else {
      ops.push(op)
      vals.push(n)
    }
  }
  let result = vals[0]
  for (let k = 0; k < ops.length; k++) result = ops[k] === '+' ? result + vals[k + 1] : result - vals[k + 1]
  return result
}

describe('probe-p10 · 定点题库自检', () => {
  it('题库 20 题、答案唯一确定为正整数、含 7×13=91 形态，声明答案与算式实算一致', () => {
    expect(P10_QUESTIONS).toHaveLength(20)
    expect(P10_QUESTIONS.some((q) => q.expr === '7 * 13' && q.answer === 91)).toBe(true)
    for (const q of P10_QUESTIONS) {
      expect(Number.isInteger(q.answer)).toBe(true)
      expect(q.answer).toBeGreaterThan(0)
      expect(evalExpr(q.expr)).toBe(q.answer) // 题库「定点」的前提：声明答案必须自洽
    }
  })

  it('回复取数：纯数字/句点/复述题面/千分位/无数字', () => {
    expect(extractLastNumber('91')).toBe(91)
    expect(extractLastNumber('The answer is 91.')).toBe(91)
    expect(extractLastNumber('7 * 13 = 91')).toBe(91) // 复述题面形态：末位数字才是答案
    expect(extractLastNumber('答案是 91')).toBe(91)
    expect(extractLastNumber('1,234')).toBe(1234)
    expect(extractLastNumber('no digits here')).toBeNull()
    expect(extractLastNumber(undefined)).toBeNull()
  })
})

describe('probe-p10 · advisory 判定', () => {
  it('20 题全对：verdict 不变（既有 healthy 纹丝不动）、advisory 正确率 100% 无 note、jittery 3 采样 60 请求', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'glm-4.6', source: 'probe:p1', kind: 'canary', state: 'healthy', evidence: { at: Date.now(), status: 200 } })
      const { transport, bodies } = quizMock()
      const r = await runP10Suite(rt, transport)
      expect(r.ok).toBe(true)
      // jittery 3 采样 × 20 题
      expect(r.upstreamRequests).toBe(60)
      expect(r.dispatched).toBe(1)
      // 预估按 run-total：20 请求 × S 档 200
      expect(r.estimate).toBe(20 * 200)
      // 单题钳制 ≤64、提示词带算式；首个采样覆盖全部 20 个不同算式
      expect(bodies).toHaveLength(60)
      for (const b of bodies) expect(b.max_tokens).toBe(P10_MAX_TOKENS)
      expect(P10_MAX_TOKENS).toBeLessThanOrEqual(64)
      const firstSample = bodies.slice(0, 20).map((b) => (b.messages as Array<{ content: string }>)[0].content)
      expect(new Set(firstSample).size).toBe(20)
      expect(firstSample.every((c) => c.includes('Reply with the number only'))).toBe(true)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('healthy') // verdict 不变
      expect(v?.advisory?.asked).toBe(20)
      expect(v?.advisory?.answered).toBe(20)
      expect(v?.advisory?.correct).toBe(20)
      expect(v?.advisory?.accuracy).toBe(100)
      expect(v?.advisory?.note).toBeUndefined()
      expect(v?.advisory?.wrong).toBeUndefined()
      // 账本：60 条逐请求条目，S 档预估 200；实际 tokens = 每请求 13 × 60
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(60)
      expect(ledger.every((e) => e.probe_id === 'p10' && e.estimated_tokens === 200 && e.tokens === 13)).toBe(true)
      expect(r.tokens).toBe(60 * 13)
    } finally {
      h.restore()
    }
  })

  it('19 对 1 错：verdict 状态仍不变、仅 advisory 字段出现（错题清单 + note）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'glm-4.6', source: 'probe:p1', kind: 'canary', state: 'healthy', evidence: { at: Date.now(), status: 200 } })
      const { transport } = quizMock({ wrongFor: '7 * 13', wrongReply: 'The answer is 90.' })
      const r = await runP10Suite(rt, transport)
      expect(r.upstreamRequests).toBe(60)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('healthy') // 正确率 <100% 也不翻状态
      expect(v?.advisory?.correct).toBe(19)
      expect(v?.advisory?.accuracy).toBe(95)
      const wrong = v?.advisory?.wrong as Array<{ i: number; expr: string; expected: number; got: number | null; reply?: string }>
      expect(wrong).toHaveLength(1)
      expect(wrong[0].i).toBe(0)
      expect(wrong[0].expr).toBe('7 * 13')
      expect(wrong[0].expected).toBe(91)
      expect(wrong[0].got).toBe(90)
      expect(wrong[0].reply).toBe('The answer is 90.')
      expect(String(v?.advisory?.note)).toContain('19/20')
    } finally {
      h.restore()
    }
  })

  it('全新三元组：状态停在 unverified（P10 恒 advisory 不立状态），观测照常落旁注', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const { transport } = quizMock()
      await runP10Suite(rt, transport)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('unverified')
      expect(v?.advisory?.correct).toBe(20)
    } finally {
      h.restore()
    }
  })

  it('上游失败中断题库：err 入证据、不主张状态（鉴权/额度定罪归 P1）、advisory 记中断面', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'glm-4.6', source: 'probe:p1', kind: 'canary', state: 'healthy', evidence: { at: Date.now(), status: 200 } })
      // 第 4 题（6 * 9，index 3）网络失败：每个采样都在同题中断，前 3 题已判
      const { transport } = quizMock({ netFailOnExpr: '6 * 9' })
      await runP10Suite(rt, transport)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('healthy')
      expect(v?.evidence.err).toBe('boom')
      expect(v?.advisory?.answered).toBe(3)
      expect(v?.advisory?.asked).toBe(20)
    } finally {
      h.restore()
    }
  })

  it('429 中断：整样本标 rateLimited 交引擎退避重试，重试仍 429 触发 provider 冷却，状态不变', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'glm-4.6', source: 'probe:p1', kind: 'canary', state: 'healthy', evidence: { at: Date.now(), status: 200 } })
      const { transport } = quizMock({ failStatus: 429, failBody: '{"error":{"message":"rate limited"}}' })
      const r = await runP10Suite(rt, transport)
      // 样本 1 第 1 题即 429 → 引擎退避重试整样本 → 仍 429 → 冷却并放弃后续采样
      expect(r.upstreamRequests).toBe(2)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'glm-4.6')
      expect(v?.state).toBe('healthy') // P10 恒 advisory：429 也不由它定罪
      expect(v?.evidence.status).toBe(429)
      expect(providerProbeInCooldown(rt, 'acme')).toBe(true)
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(2) // 两次 429 调用也入账留痕（0 token）
      expect(ledger.every((e) => e.tokens === 0)).toBe(true)
    } finally {
      h.restore()
    }
  })
})

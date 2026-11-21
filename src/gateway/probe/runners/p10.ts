// p10.ts — P10 算术金丝（provider-probe-suite 任务 12）。
// 定点题库 20 题四则混合（答案唯一确定，含 7×13=91 形态），逐题发问统计正确率。恒 advisory：
// outcome 不主张任何状态（design 判定规则 5「P10 定点题库 20 题、advisory」+ 误判边界
// 「P12/P10 恒 advisory 永不翻 verdict」）——算术正确率是模型质量观测（中转偷换小模型的主
// 信号），不是健康判定，鉴权/额度归 P1 定罪。jittery 类：单样本 = 整套题库一次遍历，3 采样
// 共识由引擎调度（engine sampleCount=3），advisory 逐样本覆盖（与 P12 同口径）。

import { t } from '../../../util/i18n.js'
import { probeWire, extractReplyText, upstreamErrorLine } from '../wire.js'
import { sendProbe, sumUsageTokens } from './shared.js'
import type { ProbeUnitContext, ProbeUnitOutcome } from '../engine.js'

/** 单题输出钳制（card 硬约束 max_tokens≤64——只容一个数字的回复，钳死成本） */
export const P10_MAX_TOKENS = 64

export interface P10Question {
  /** 题面算式（ASCII 运算符——对三协议 tokenizer 与中转改写都最稳） */
  expr: string
  answer: number
}

/** 定点题库（20 题）：加减乘除混合 + 两道两步运算，全部整除/整数答案、答案唯一确定。
 *  第 1 题即 card 要求的 7×13=91 形态。题库是「定点」的：题目恒定不变，跨服务/跨时间的
 *  正确率才可比。 */
export const P10_QUESTIONS: readonly P10Question[] = [
  { expr: '7 * 13', answer: 91 },
  { expr: '12 + 30', answer: 42 },
  { expr: '85 - 37', answer: 48 },
  { expr: '6 * 9', answer: 54 },
  { expr: '144 / 12', answer: 12 },
  { expr: '23 + 58', answer: 81 },
  { expr: '91 - 45', answer: 46 },
  { expr: '8 * 7', answer: 56 },
  { expr: '96 / 8', answer: 12 },
  { expr: '47 + 38', answer: 85 },
  { expr: '3 * 17 + 5', answer: 56 },
  { expr: '100 - 63', answer: 37 },
  { expr: '9 * 12', answer: 108 },
  { expr: '75 / 5', answer: 15 },
  { expr: '64 + 28', answer: 92 },
  { expr: '7 * 8 - 6', answer: 50 },
  { expr: '132 / 11', answer: 12 },
  { expr: '56 - 29', answer: 27 },
  { expr: '15 * 4', answer: 60 },
  { expr: '36 + 65', answer: 101 },
]

export function buildP10Prompt(expr: string): string {
  return `Compute exactly: ${expr}. Reply with the number only.`
}

/** 回复取数：取末位数字——模型可能复述题面（「7 * 13 = 91」），取首个会采到题面操作数；
 *  末位在「只回数字」与「复述后给答案」两种形态下都落在答案上。逗号千分位剥除，小数/缺失
 *  按 null（无数字可判 = 答错，不猜）。 */
export function extractLastNumber(reply: string | undefined): number | null {
  if (!reply) return null
  const matches = reply.match(/-?\d[\d,]*/g)
  if (!matches || matches.length === 0) return null
  const n = Number.parseInt(matches[matches.length - 1].replace(/,/g, ''), 10)
  return Number.isFinite(n) ? n : null
}

/** 正确率观测旁注（挂 verdict.advisory；correct < answered 时挂 note 与错题清单） */
export interface P10Advisory extends Record<string, unknown> {
  asked: number
  /** 实际拿到可判定回复的题数（上游失败中断时 < asked——中断样本的正确率口径） */
  answered: number
  correct: number
  /** 百分数 0–100，按 answered 计 */
  accuracy: number
  wrong?: Array<{ i: number; expr: string; expected: number; got: number | null; reply?: string }>
  note?: string
}

export async function runP10(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const t0 = Date.now()
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const proto = provider?.protocol ?? 'openai'
  const calls: NonNullable<ProbeUnitOutcome['calls']> = []
  const wrong: NonNullable<P10Advisory['wrong']> = []
  let correct = 0
  let judged = 0
  /** 中断面：首个人为可归档失败（网络/HTTP）——P10 不主张状态，err 只入证据供溯源 */
  let interrupted: { err?: string; status?: number; rateLimited?: boolean; retryAfter?: string | string[] } | undefined

  const advisoryOf = (): P10Advisory => {
    const a: P10Advisory = {
      asked: P10_QUESTIONS.length,
      answered: judged,
      correct,
      accuracy: judged > 0 ? Math.round((correct / judged) * 10000) / 100 : 0,
    }
    if (wrong.length > 0) a.wrong = wrong
    if (judged > 0 && correct < judged) {
      a.note = t(
        '探针 P10 算术正确率 {correct}/{answered}：低于 100%（advisory 不改判状态，人工复核该模型质量）',
        'Probe p10 arithmetic accuracy {correct}/{answered}: below 100% (advisory only; verdict unchanged; review this model quality manually)',
        { correct, answered: judged }
      )
    }
    return a
  }

  for (const [i, q] of P10_QUESTIONS.entries()) {
    // 逐题检查取消：整套题库 20 请求 ×3 采样，abort 后继续发题白烧 token
    if (ctx.signal?.aborted) {
      interrupted = { err: t('探针 P10 批量任务已取消，题库未答完', 'Probe p10 batch cancelled before the quiz finished') }
      break
    }
    const wire = probeWire(proto, ctx.target.model, { prompt: buildP10Prompt(q.expr), maxTokens: P10_MAX_TOKENS })
    const sent = await sendProbe(ctx, wire.path, wire.body)
    if (!sent.ok) {
      interrupted = { err: sent.netErr }
      break
    }
    const resp = sent.resp
    calls.push({ tokens: sumUsageTokens(resp.usage), ms: sent.ms, status: resp.status })
    if (resp.status >= 400) {
      // 上游失败中断题库：err 入证据、不主张状态（鉴权/额度定罪归 P1）；429 交引擎整样本退避重试
      const failed = resp.status === 429
        ? { rateLimited: true, ...(resp.headers?.['retry-after'] != null ? { retryAfter: resp.headers['retry-after'] } : {}) }
        : {}
      interrupted = { status: resp.status, ...(upstreamErrorLine(resp.bodyText) ? { err: upstreamErrorLine(resp.bodyText) } : {}), ...failed }
      break
    }
    const reply = extractReplyText(resp.bodyText)
    const got = extractLastNumber(reply)
    judged++
    if (got === q.answer) {
      correct++
    } else {
      wrong.push({
        i,
        expr: q.expr,
        expected: q.answer,
        got,
        ...(reply ? { reply: reply.trim().slice(0, 60) } : {}),
      })
    }
  }

  const outcome: ProbeUnitOutcome = { ms: Date.now() - t0, calls, advisory: advisoryOf() }
  if (interrupted?.status != null) outcome.status = interrupted.status
  if (interrupted?.err != null) outcome.err = interrupted.err
  if (interrupted?.rateLimited) {
    outcome.rateLimited = true
    if (interrupted.retryAfter != null) outcome.retryAfter = interrupted.retryAfter
  }
  return outcome
}

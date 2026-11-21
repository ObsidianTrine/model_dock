// p11.ts — P11 输出上限（provider-probe-suite 任务 12）。
// 递增 max_tokens（512/1024/2048/4096 四级，registry 定档 requests=4）发「尽可能长文本」类
// 指令，首个触顶级别即实测截断点，±512 置信度（相邻两级间距 512 的倍增阶梯——测得值落在
// 该级 ±512 区间内）。canary 类单次判定：测量成功（各级请求打通）记 healthy——输出上限本身
// 不是健康信号，实测值只挂 advisory 供人对照宣传参数；触顶也不是失败（截断恰是测量目标）。
// 命中触顶即停（early-stop）：答案已得，继续加码只白烧 token——实际请求数 ≤ 目录基数 4，
// 账本按实际逐请求落条目、差值由对账面暴露。

import { t } from '../../../util/i18n.js'
import { probeWire, upstreamErrorLine } from '../wire.js'
import { classifyUpstreamFailure, sendProbe, sumUsageTokens } from './shared.js'
import type { ProbeUnitContext, ProbeUnitOutcome } from '../engine.js'

/** 递增阶梯（registry P11 定档 4 请求）：512 起、逐级翻倍（间距 512 的倍数）、上限 4096 */
export const P11_LEVELS: readonly number[] = [512, 1024, 2048, 4096]

/** 置信度半宽（design：输出上限是近似值 ±512） */
export const P11_CONFIDENCE = 512

export const P11_PROMPT =
  'Write a very long text about the history of computing. Keep writing for as long as you can; do not stop early.'

/** 截断信号（三协议壳形态并检，不按请求协议限定——中转改写响应壳是常态，探测只认结构）：
 *  openai finish_reason=length / anthropic stop_reason=max_tokens / responses status=incomplete。 */
export function shellTruncated(bodyText: string | undefined): boolean {
  if (!bodyText) return false
  let j: unknown
  try {
    j = JSON.parse(bodyText)
  } catch {
    return false
  }
  const o = j as Record<string, unknown>
  if (o?.status === 'incomplete') return true
  if (o?.stop_reason === 'max_tokens') return true
  const fr = (o?.choices as Array<Record<string, unknown>> | undefined)?.[0]?.finish_reason
  return fr === 'length'
}

/** usage 兜底判据：completion_tokens（openai）/output_tokens（anthropic/responses）≥ 本次
 *  max_tokens 即触顶——壳字段被中转拍掉时截断信号只剩 usage；按 usage.completion_tokens
 *  模拟触顶的 mock 上游同命中此径。 */
export function usageHitCap(usage: Record<string, number> | undefined, level: number): boolean {
  const c = usage?.completion_tokens ?? usage?.output_tokens
  return typeof c === 'number' && c >= level
}

/** 实测截断点旁注（挂 verdict.advisory；measured_tokens=null = 探到顶棚仍未触顶） */
export interface P11Advisory extends Record<string, unknown> {
  measured_tokens: number | null
  /** 置信度半宽（恒 512）：实测值是「首个触顶级别」，真实上限落在 measured±512 区间 */
  confidence: number
  /** 「{measured}±512」人类可读标签（measured=null 缺席，由 note 说明未触顶） */
  label?: string
  levels: Array<{ max_tokens: number; truncated: boolean; completion_tokens: number | null }>
  note?: string
}

export async function runP11(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const t0 = Date.now()
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const proto = provider?.protocol ?? 'openai'
  const calls: NonNullable<ProbeUnitOutcome['calls']> = []
  const levels: NonNullable<P11Advisory['levels']> = []
  let measured: number | null = null
  let hardFail: Pick<ProbeUnitOutcome, 'state' | 'rateLimited' | 'retryAfter'> | undefined
  let failStatus: number | undefined
  let failErr: string | undefined

  for (const level of P11_LEVELS) {
    const wire = probeWire(proto, ctx.target.model, { prompt: P11_PROMPT, maxTokens: level })
    const sent = await sendProbe(ctx, wire.path, wire.body)
    if (!sent.ok) {
      // 网络层失败：无响应状态可归档，unreachable（canary 单判定直接主张）
      return { state: 'unreachable', err: sent.netErr, ms: Date.now() - t0, calls, advisory: advisoryOf(measured, levels) }
    }
    const resp = sent.resp
    calls.push({ tokens: sumUsageTokens(resp.usage), ms: sent.ms, status: resp.status })
    if (resp.status >= 400) {
      // 上游失败交共享分类单一口径（401/403→auth-dead、quota 特征→quota、429→退避重试）
      const failed = classifyUpstreamFailure(resp.status, resp.bodyText, resp.headers?.['retry-after'])
      hardFail = failed ?? { state: 'degraded' }
      failStatus = resp.status
      failErr = upstreamErrorLine(resp.bodyText)
      break
    }
    const completion = resp.usage?.completion_tokens ?? resp.usage?.output_tokens
    const truncated = shellTruncated(resp.bodyText) || usageHitCap(resp.usage, level)
    levels.push({ max_tokens: level, truncated, completion_tokens: typeof completion === 'number' ? completion : null })
    if (truncated) {
      measured = level // 首个触顶级别即实测截断点，early-stop 停止加码
      break
    }
  }

  const advisory = advisoryOf(measured, levels)
  if (hardFail) {
    return {
      ...hardFail,
      ...(failStatus != null ? { status: failStatus } : {}),
      ...(failErr ? { err: failErr } : {}),
      ms: Date.now() - t0,
      calls,
      advisory,
    }
  }
  // 测量完成（触顶或探到顶棚）：通道四/三级请求全通记 healthy；截断点观测入 advisory
  return { state: 'healthy', ms: Date.now() - t0, calls, advisory }

  function advisoryOf(m: number | null, ls: NonNullable<P11Advisory['levels']>): P11Advisory {
    const a: P11Advisory = { measured_tokens: m, confidence: P11_CONFIDENCE, levels: ls }
    if (m != null) {
      a.label = `${m}±${P11_CONFIDENCE}`
      a.note = t(
        '探针 P11 实测输出截断点 {measured} tokens（置信度 ±{conf}）：真实可用输出上限落在该区间内',
        'Probe p11 measured output truncation at {measured} tokens (confidence ±{conf}): the usable output limit falls within this range',
        { measured: m, conf: P11_CONFIDENCE }
      )
    } else if (ls.length >= P11_LEVELS.length) {
      a.note = t(
        '探针 P11 各级（至 {ceiling} tokens）均自然收尾未触顶：输出上限高于本次探测顶棚',
        'Probe p11 every level (up to {ceiling} tokens) finished naturally: output limit is above this probe ceiling',
        { ceiling: P11_LEVELS[P11_LEVELS.length - 1] }
      )
    }
    return a
  }
}

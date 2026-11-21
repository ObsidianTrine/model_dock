// p14.ts — P14 性能画像（provider-probe-suite 任务 12）。
// N=5 轮流式小请求，逐轮测 TTFT 与 tokens-per-sec，输出 p50/p95 分位数（design 判定规则 5）。
// jittery 类：单样本 = 完整 5 轮测量，3 采样共识由引擎调度；时延抖动由分位数自然吸收，单轮
// 失败不武断翻脸——多数派（≥3/5 成功）才记 healthy，其余按共享失败分类归档。TTFT 只有传输
// 层能测（chunks 逐片到达时刻，P3 同款接缝）；无逐片观测时退回总耗时（整包响应的首字节≈
// 末字节，与 P3 兜底口径一致）。tokens-per-sec = completion_tokens ÷ 生成窗口（总耗时−TTFT，
// vLLM benchmark 同型口径）；usage 缺席的轮次不进 tps 分位数（ttft 仍有效）。

import { probeWire, upstreamErrorLine } from '../wire.js'
import { PROBE_CANARY_MAX_TOKENS, classifyUpstreamFailure, sendProbe, sumUsageTokens } from './shared.js'
import type { ProbeUnitContext, ProbeUnitOutcome, ProbeUpstreamResponse } from '../engine.js'

/** 采样轮数（registry P14 定档 requests=5） */
export const P14_ROUNDS = 5

/** healthy 多数派门槛：5 轮中 ≥3 轮成功——性能画像关注可用通道的时延分布，单轮抖动由
 *  p50/p95 吸收，过半失败才翻 degraded */
export const P14_MAJORITY = 3

/** 最近秩法百分位（nearest-rank）：升序第 ceil(p/100×n) 个。5 样本固定口径下 p50 = 排序后
 *  取 [2]、p95 = 取 [4]（card 指定并在测试中锚定）。空集返回 undefined。 */
export function nearestRankPercentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1]
}

/** 单轮成功样本（tps 缺席 = 该轮 usage 无 completion tokens，不进 tps 分位数） */
export interface P14Sample {
  ms: number
  ttft: number
  tps?: number
}

/** 性能画像旁注（挂 verdict.advisory）：分位数对 5 样本最近秩法，samples 留原始值供溯源 */
export interface P14Advisory extends Record<string, unknown> {
  rounds: number
  ok: number
  samples: P14Sample[]
  ttft_p50: number | null
  ttft_p95: number | null
  tps_p50: number | null
  tps_p95: number | null
}

function advisoryOf(samples: P14Sample[]): P14Advisory {
  const ttfts = samples.map((s) => s.ttft)
  const tpss = samples.map((s) => s.tps).filter((v): v is number => v != null)
  const pct = (xs: number[]): number | null => nearestRankPercentile(xs, 50) ?? null
  const pct95 = (xs: number[]): number | null => nearestRankPercentile(xs, 95) ?? null
  return {
    rounds: P14_ROUNDS,
    ok: samples.length,
    samples,
    ttft_p50: pct(ttfts),
    ttft_p95: pct95(ttfts),
    tps_p50: pct(tpss),
    tps_p95: pct95(tpss),
  }
}

function roundSample(resp: ProbeUpstreamResponse, ms: number): P14Sample {
  // TTFT：传输层首片到达时刻（chunks[0]）；无逐片观测退回总耗时（P3 同款兜底口径）
  const ttft = resp.chunks?.[0] ?? ms
  const c = resp.usage?.completion_tokens ?? resp.usage?.output_tokens
  if (typeof c !== 'number' || c <= 0) return { ms, ttft }
  // 生成窗口 = 总耗时 − TTFT；窗口 ≤0（异常计时）退回总耗时口径
  const genMs = ms - ttft > 0 ? ms - ttft : ms
  const tps = Math.round((c / (genMs / 1000)) * 100) / 100
  return { ms, ttft, tps }
}

export async function runP14(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const t0 = Date.now()
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const proto = provider?.protocol ?? 'openai'
  const wire = probeWire(proto, ctx.target.model, { maxTokens: PROBE_CANARY_MAX_TOKENS, stream: true })
  const calls: NonNullable<ProbeUnitOutcome['calls']> = []
  const samples: P14Sample[] = []
  /** 逐轮失败面（网络/HTTP 分类前的原始归档；聚合判定在轮次跑完后统一做） */
  const failures: Array<{ state?: ProbeUnitOutcome['state']; rateLimited?: boolean; retryAfter?: string | string[]; status?: number; err?: string }> = []

  for (let i = 0; i < P14_ROUNDS; i++) {
    const sent = await sendProbe(ctx, wire.path, wire.body)
    if (!sent.ok) {
      failures.push({ err: sent.netErr })
      continue
    }
    const resp = sent.resp
    calls.push({ tokens: sumUsageTokens(resp.usage), ms: sent.ms, status: resp.status })
    const failed = classifyUpstreamFailure(resp.status, resp.bodyText, resp.headers?.['retry-after'])
    if (failed) {
      failures.push({
        ...failed,
        status: resp.status,
        ...(upstreamErrorLine(resp.bodyText) ? { err: upstreamErrorLine(resp.bodyText) } : {}),
      })
      continue
    }
    samples.push(roundSample(resp, sent.ms))
  }

  const advisory = advisoryOf(samples)
  const ms = samples.length > 0 ? (nearestRankPercentile(samples.map((s) => s.ms), 50) ?? Date.now() - t0) : Date.now() - t0
  // 聚合判定（优先级递减）：硬失败（auth-dead/quota）一票定音 → 纯限流交引擎退避重试 →
  // 多数派成功记 healthy → 其余（过半失败含网络错误）degraded / 全网络失败 unreachable
  const hard = failures.find((f) => f.state === 'auth-dead' || f.state === 'quota')
  if (hard) {
    return {
      state: hard.state,
      ...(hard.status != null ? { status: hard.status } : {}),
      ...(hard.err ? { err: hard.err } : {}),
      ms,
      calls,
      advisory,
    }
  }
  const limited = failures.find((f) => f.rateLimited)
  if (limited) {
    return {
      state: 'degraded',
      rateLimited: true,
      ...(limited.retryAfter != null ? { retryAfter: limited.retryAfter } : {}),
      ...(failures[0]?.err ? { err: failures[0].err } : {}),
      ms,
      calls,
      advisory,
    }
  }
  if (samples.length >= P14_MAJORITY) {
    return { state: 'healthy', ms, calls, advisory }
  }
  if (samples.length === 0 && failures.every((f) => f.status == null)) {
    // 5 轮全为网络层失败：无响应状态可归档 unreachable
    return { state: 'unreachable', ...(failures[0]?.err ? { err: failures[0].err } : {}), ms, calls, advisory }
  }
  return {
    state: 'degraded',
    ...(failures[0]?.status != null ? { status: failures[0].status } : {}),
    ...(failures[0]?.err ? { err: failures[0].err } : {}),
    ms,
    calls,
    advisory,
  }
}

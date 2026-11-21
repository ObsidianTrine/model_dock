// p3.ts — P3 流式链路（provider-probe-suite 任务 7）。
// stream=true 测 TTFB 与分片到达（design 判定规则 5）：分片计数优先取 transport 观测的逐片
// 到达时刻（engine.ts ProbeUpstreamResponse.chunks——TTFB 只有传输层能测），缺席时退回按 SSE
// data: 行计数（探针只数片不解析业务内容）。判定口径：TTFB≤30s 记入证据耗时槽（超 30s 判
// degraded——通道活着但首片迟缓不可用）；0 分片判不支持（上游对 stream=true 未回 SSE，整包
// 缓冲或不支持）；≥1 分片即流式通道实证记 healthy——伪流式（整包单分片）的增量性缺失属观测
// 细节，design 的不支持判据只有 0 分片，不翻状态。

import { t } from '../../../util/i18n.js'
import { probeWire, upstreamErrorLine } from '../wire.js'
import { PROBE_CANARY_MAX_TOKENS, classifyUpstreamFailure, sendProbe, sumUsageTokens } from './shared.js'
import type { ProbeUnitContext, ProbeUnitOutcome } from '../engine.js'

/** 流式首片判定上限（design 判定规则 5：TTFB≤30s 记录——超限不作为合格实测记 healthy） */
export const P3_TTFB_MAX_MS = 30_000

/** SSE 文本分片计数：数 data: 行（剔除 [DONE] 与空载；':' 开头的注释/keepalive 行天然不计）。
 *  anthropic 的 event+data 成对、openai 的 data 增量、responses 的事件流同按 data 行口径计数。 */
export function countSseChunks(bodyText: string | undefined): number {
  if (!bodyText) return 0
  let n = 0
  for (const line of bodyText.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('data:')) continue
    const payload = s.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    n++
  }
  return n
}

export async function runP3(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const wire = probeWire(provider?.protocol ?? 'openai', ctx.target.model, {
    maxTokens: PROBE_CANARY_MAX_TOKENS,
    stream: true,
  })
  const sent = await sendProbe(ctx, wire.path, wire.body)
  if (!sent.ok) return { state: 'unreachable', err: sent.netErr, ms: sent.ms, calls: [] }
  const resp = sent.resp
  const ms = sent.ms
  const call = { tokens: sumUsageTokens(resp.usage), ms, status: resp.status }
  const errLine = upstreamErrorLine(resp.bodyText)
  const errField = errLine ? { err: errLine } : {}
  const failed = classifyUpstreamFailure(resp.status, resp.bodyText, resp.headers?.['retry-after'])
  if (failed) return { ...failed, status: resp.status, ms, ...errField, calls: [call] }
  const observed = resp.chunks
  const chunkCount = observed ? observed.length : countSseChunks(resp.bodyText)
  if (chunkCount === 0) {
    return {
      state: 'degraded',
      status: resp.status,
      ms,
      err: t(
        '探针 P3 未观测到流式分片：上游对 stream=true 未回 SSE 分片（可能整包缓冲或不支持流式），请人工复核该服务的流式能力',
        'Probe p3 observed no streaming chunks: upstream returned no SSE chunks for stream=true (whole-body buffered or streaming unsupported); review this service streaming capability manually'
      ),
      calls: [call],
    }
  }
  const ttfb = observed?.[0]
  if (ttfb != null && ttfb > P3_TTFB_MAX_MS) {
    return {
      state: 'degraded',
      status: resp.status,
      ms: ttfb,
      err: t(
        '探针 P3 流式首片耗时 {ms}ms 超过 {max}ms 上限：流式通道可用但首片迟缓，人工评估是否可用',
        'Probe p3 streaming TTFB {ms}ms exceeds the {max}ms limit: channel works but first chunk is slow; assess usability manually',
        { ms: ttfb, max: P3_TTFB_MAX_MS }
      ),
      calls: [call],
    }
  }
  // healthy：TTFB（首片实测）入证据耗时槽；transport 未逐片计时时退回调用总耗时（计数已有
  // SSE 行兜底，缺的只是到达时刻——耗时槽记总耗时仍优于空缺）
  return { state: 'healthy', status: resp.status, ms: ttfb ?? ms, calls: [call] }
}

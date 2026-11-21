// p13.ts — P13 缓存探测（provider-probe-suite 任务 9）。
// 同请求两发（design 判定规则 5）：同一 payload 原样连发两次，第二次响应的缓存读数
// （anthropic usage.cache_read_input_tokens / openai·responses usage.prompt_tokens_details
// .cached_tokens）>0 判支持；两次均 0 判不支持——不支持是能力结论而非故障（探针本身跑通了），
// 归 degraded + advisory.supported=false 供人复核，不判死（≠auth-dead/unreachable，与 P3
// 「0 分片判不支持」同口径）。jittery 类：runner 只做单次两发判定，3 取中位共识在 verdict 层。
// max_tokens 自有钳制 ≤32（card 明文，区别于 PROBE_CANARY_MAX_TOKENS=200）。缓存读数从
// bodyText 原文取：engine transport 的 usage 投影只保留顶层数字字段，嵌套的
// prompt_tokens_details 会被丢，resp.usage 只配账本记账不配判定。

import { t } from '../../../util/i18n.js'
import type { Protocol } from '../../../config/types.js'
import { probeWirePath, upstreamErrorLine } from '../wire.js'
import { classifyUpstreamFailure, sendProbe, sumUsageTokens } from './shared.js'
import type { ProbeUnitContext, ProbeUnitOutcome } from '../engine.js'

/** P13 自有输出钳制（card 明文：双发只为比对 usage，不需要任何有效补全长度） */
export const P13_MAX_TOKENS = 32

export const P13_USER_PROMPT = 'Reply with exactly OK and nothing else.'

/** 垫料：提示词缓存普遍有最小可缓存长度（openai/anthropic 均为千 token 量级），太短的 prompt
 *  永远不会命中缓存——垫到千 token 量级给缓存成立的机会，仍压在 M 档单请求 2000 上限内。 */
const P13_PADDING_LINE = 'ModelDock prompt-cache probe padding line for upstream KV reuse. '
export const P13_PADDING = P13_PADDING_LINE.repeat(90)

/** 判定用缓存读数（card 口径两字段任一 >0 即命中）。无该字段/非 JSON 返回 undefined（从严按
 *  0 处理，调用方 (v ?? 0) > 0 判定）。 */
export function p13CacheReadOf(bodyText: string | undefined): number | undefined {
  if (!bodyText) return undefined
  let j: unknown
  try {
    j = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  const usage = (j as { usage?: unknown })?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  if (typeof u.cache_read_input_tokens === 'number') return u.cache_read_input_tokens
  const details = u.prompt_tokens_details
  if (details && typeof details === 'object') {
    const cached = (details as Record<string, unknown>).cached_tokens
    if (typeof cached === 'number') return cached
  }
  return undefined
}

/** P13 advisory（挂 verdict 旁注：supported 之外的原始读数供复核——首次就命中 / 两发全零 /
 *  字段缺席是三种不同事实） */
export interface P13Advisory extends Record<string, unknown> {
  supported: boolean
  firstCacheRead: number | null
  secondCacheRead: number | null
}

/** P13 请求体拼装：垫料进 system 槽（anthropic 顶层 system 块数组 + cache_control ephemeral
 *  显式断点——anthropic 不打断点不缓存；openai/responses 自动缓存无需开关）。路径走
 *  probeWirePath 单一事实源；键序对齐 probeWire（responses 一等协议）。 */
function p13Wire(proto: Protocol, model: string): { path: string; body: Buffer } {
  const path = probeWirePath(proto)
  const body =
    proto === 'anthropic'
      ? {
          model,
          max_tokens: P13_MAX_TOKENS,
          stream: false,
          system: [{ type: 'text', text: P13_PADDING, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: P13_USER_PROMPT }],
        }
      : proto === 'responses'
        ? { model, max_output_tokens: P13_MAX_TOKENS, stream: false, instructions: P13_PADDING, input: P13_USER_PROMPT }
        : {
            model,
            max_tokens: P13_MAX_TOKENS,
            stream: false,
            messages: [
              { role: 'system', content: P13_PADDING },
              { role: 'user', content: P13_USER_PROMPT },
            ],
          }
  return { path, body: Buffer.from(JSON.stringify(body)) }
}

export async function runP13(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const proto = provider?.protocol ?? 'openai'
  const wire = p13Wire(proto, ctx.target.model)
  // 第一发：建立缓存。同一 Buffer 复用 = 字节级同 payload（「同请求」的硬前提）
  const s1 = await sendProbe(ctx, wire.path, wire.body)
  if (!s1.ok) return { state: 'unreachable', err: s1.netErr, ms: s1.ms, calls: [] }
  const r1 = s1.resp
  const c1 = { tokens: sumUsageTokens(r1.usage), ms: s1.ms, status: r1.status }
  const errLine1 = upstreamErrorLine(r1.bodyText)
  const errField1 = errLine1 ? { err: errLine1 } : {}
  const failed1 = classifyUpstreamFailure(r1.status, r1.bodyText, r1.headers?.['retry-after'])
  if (failed1) return { ...failed1, status: r1.status, ms: s1.ms, ...errField1, calls: [c1] }
  // 第二发：判据所在（同 payload 的缓存命中读数）
  const s2 = await sendProbe(ctx, wire.path, wire.body)
  if (!s2.ok) return { state: 'unreachable', err: s2.netErr, ms: s1.ms + s2.ms, calls: [c1] }
  const r2 = s2.resp
  const ms = s1.ms + s2.ms
  const c2 = { tokens: sumUsageTokens(r2.usage), ms: s2.ms, status: r2.status }
  const errLine2 = upstreamErrorLine(r2.bodyText)
  const errField2 = errLine2 ? { err: errLine2 } : {}
  const failed2 = classifyUpstreamFailure(r2.status, r2.bodyText, r2.headers?.['retry-after'])
  if (failed2) return { ...failed2, status: r2.status, ms, ...errField2, calls: [c1, c2] }
  const first = p13CacheReadOf(r1.bodyText)
  const second = p13CacheReadOf(r2.bodyText)
  const advisory: P13Advisory = { supported: (second ?? 0) > 0, firstCacheRead: first ?? null, secondCacheRead: second ?? null }
  if ((second ?? 0) > 0) return { state: 'healthy', status: r2.status, ms, calls: [c1, c2], advisory }
  return {
    state: 'degraded',
    status: r2.status,
    ms,
    err: t(
      '探针 P13 两次同请求均无缓存命中：提示词缓存不支持或未生效（cache_read/cached_tokens 均为 0），服务本身可达，人工评估缓存能力',
      'Probe p13 no cache hit on either of two identical requests: prompt cache unsupported or ineffective (cache_read/cached_tokens both 0); service itself reachable, assess caching capability manually'
    ),
    calls: [c1, c2],
    advisory,
  }
}

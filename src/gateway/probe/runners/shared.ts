// shared.ts — P3/P6/P7 runner 共享件（provider-probe-suite 任务 7；任务 8 起含 P4/P5 共用件）。
// 失败归档与 usage 记账与 runners/p1.ts（任务 3）同口径：探针家族对同一上游失败必须得出同一
// verdict 分类（口径漂移正是本 spec 要消灭的东西）；任务 3 合并后两处实现收敛为单一函数。

import { isQuotaError } from '../../relay.js'
import type { ProbeUnitContext, ProbeUnitOutcome, ProbeUpstreamResponse } from '../engine.js'

/** canary 探针的单请求输出钳制（card 硬约束 max_tokens≤200；registry unitTokens 是成本预估
 *  口径，与实际请求钳制分属两事——预估按档位、请求按钳制） */
export const PROBE_CANARY_MAX_TOKENS = 200

/** usage 正数字段合计 → 账本 tokens（与 p1.ts sumUsageTokens 同口径：缓存读/建计入 input） */
export function sumUsageTokens(usage: Record<string, number> | undefined): number {
  let sum = 0
  for (const v of Object.values(usage ?? {})) if (typeof v === 'number' && v > 0) sum += v
  return sum
}

/** 模型吐出的 JSON 字符串 → 对象：trim + 一次剥 code fence 兜底（模型常包 ```json 围栏，与
 *  P4/P9 的「一次剥引号」同思路——剥一层后仍非 JSON 即放弃，不递归不猜测）；对象形态才合格
 *  （数组/标量按无约定字段处理）。任务 8 自 p6.ts 迁入：P6 约定字段与 P5 工具 args 的「JSON
 *  合法」判定共用同一 parse 口径（object 非数组非 null），防两处实现漂移。 */
export function parseCanaryJson(reply: string | undefined): Record<string, unknown> | undefined {
  if (!reply) return undefined
  let s = reply.trim()
  const fence = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/)
  if (fence) s = fence[1].trim()
  try {
    const j: unknown = JSON.parse(s)
    if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>
  } catch {
    /* 非 JSON：交调用方从严判定 */
  }
  return undefined
}

/** 上游失败归档（仅 ≥400 有结论）：401/403 → auth-dead；402 或 429+额度特征 → quota（relay
 *  isQuotaError 单一口径）；普通 429 → degraded + rateLimited（引擎退避重试 + provider 探针
 *  冷却）；其余 4xx/5xx → degraded。成功（<400）返回 undefined，能力判定交 runner 主逻辑。 */
export function classifyUpstreamFailure(
  status: number,
  bodyText: string | undefined,
  retryAfter: string | string[] | undefined
): Pick<ProbeUnitOutcome, 'state' | 'rateLimited' | 'retryAfter'> | undefined {
  if (status === 401 || status === 403) return { state: 'auth-dead' }
  if (isQuotaError(status, bodyText ?? '')) return { state: 'quota' }
  if (status === 429) {
    return { state: 'degraded', rateLimited: true, ...(retryAfter != null ? { retryAfter } : {}) }
  }
  if (status >= 400) return { state: 'degraded' }
  return undefined
}

/** 发一次探针请求（runner 经 engine transport 发请求，不自行 fetch）+ 网络层失败统一按
 *  unreachable 归档的兜底：连接拒绝/超时/DNS 无响应状态可归档，错误消息入证据。 */
export type ProbeSend =
  | { ok: true; resp: ProbeUpstreamResponse; ms: number }
  | { ok: false; netErr: string; ms: number }

export async function sendProbe(ctx: ProbeUnitContext, path: string, body: Buffer): Promise<ProbeSend> {
  const t0 = Date.now()
  const req = {
    providerId: ctx.target.providerId,
    model: ctx.target.model,
    path,
    body,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  }
  try {
    const resp = await ctx.transport(req)
    return { ok: true, resp, ms: resp.ms ?? Date.now() - t0 }
  } catch (e) {
    return { ok: false, netErr: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 }
  }
}

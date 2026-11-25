// p1.ts — P1 鉴权回声（provider-probe-suite 任务 3）。
// 回显判定（p1-echo-tolerance 放宽，经船东确认）：canary 以独立词出现即判 healthy——P1 的使命
// 是「鉴权 + 推理链路活着」，不是指令遵循度评分；原「trim 全等 · 宁严勿松」把不遵循「只回一词」
// 的健康模型误标 degraded（glm-5-3-flash 等对话/代理风格模型实测必现），与 P8 的包含式口径
// 同族对齐。匹配前剥离推理块（<think>…</think>——推理常复述指令里的 canary，剥离后才算真实
// 回答）与代码围栏标记；中转整体替换内容会丢掉 canary 仍被抓住，包一层客套话/引号/标点不再
// 误报。五态归档口径（design 判定规则 5）：401/403 → auth-dead；402 或 429+额度特征 → quota
// （复用 relay 的 isQuotaError 单一口径，勿复制正则）；网络失败 → unreachable；其余 4xx/5xx
// 与回显不匹配 → degraded（实际回复入证据，人工复核）；匹配 → healthy。普通 429（无额度特征）
// 标 rateLimited 交引擎退避重试 + provider 探针冷却。

import { isQuotaError } from '../../relay.js'
import { t } from '../../../util/i18n.js'
import { probeWire, extractReplyText, upstreamErrorLine } from '../wire.js'
import type { ProbeUnitContext, ProbeUnitOutcome, ProbeUpstreamRequest, ProbeUpstreamResponse } from '../engine.js'

export const P1_CANARY = 'MODELDOCK-OK'
export const P1_PROMPT = `Reply with exactly ${P1_CANARY} and nothing else.`

/** 回显判定（p1-echo-tolerance）：剥推理块与代码围栏标记后，canary 以独立词出现即过。词边界
 *  排除字母数字与连字符——XMODELDOCK-OK / MODELDOCK-OKX 这类拼接词不算；case-sensitive（canary
 *  是专用造词，无需放宽大小写）。导出供单测直测边界。 */
export function p1EchoMatch(reply: string | undefined): boolean {
  if (!reply) return false
  const stripped = reply.replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/```[a-zA-Z]*/g, ' ')
  return new RegExp('(^|[^A-Za-z0-9-])' + P1_CANARY + '([^A-Za-z0-9-]|$)').test(stripped)
}

/** usage 数字字段合计 → 账本 tokens（与请求日志 dayTokens 口径一致：缓存读/建计入 input） */
export function sumUsageTokens(usage: Record<string, number> | undefined): number {
  let sum = 0
  for (const v of Object.values(usage ?? {})) if (typeof v === 'number' && v > 0) sum += v
  return sum
}

/** 发一次 P1 回文请求（runner 经 engine transport 发请求，不自行 fetch）。runner 共享给 P2
 *  逐 key 审计（任务 4）：每把 key 各跑一次本函数。 */
export async function runP1(ctx: ProbeUnitContext): Promise<ProbeUnitOutcome> {
  const t0 = Date.now()
  const provider = ctx.rt.config.providers[ctx.target.providerId]
  const wire = probeWire(provider?.protocol ?? 'openai', ctx.target.model, { prompt: P1_PROMPT })
  const req: ProbeUpstreamRequest = {
    providerId: ctx.target.providerId,
    model: ctx.target.model,
    // P2 逐把审计：单元目标带 keyIndex 时透传给 transport（生产实现转 forwardToUpstream
    // forceKeyIndex 直发该把）；缺省 undefined = 轮转主选路径，P1 单 key 探针行为不变
    ...(ctx.target.keyIndex != null ? { keyIndex: ctx.target.keyIndex } : {}),
    path: wire.path,
    body: wire.body,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  }
  let resp: ProbeUpstreamResponse
  try {
    resp = await ctx.transport(req)
  } catch (e) {
    // 网络层失败（连接拒绝/超时/DNS）：无响应状态可归档，unreachable + 错误消息入证据
    return { state: 'unreachable', err: e instanceof Error ? e.message : String(e), ms: Date.now() - t0, calls: [] }
  }
  const ms = resp.ms ?? Date.now() - t0
  const status = resp.status
  const bodyText = resp.bodyText
  const call = { tokens: sumUsageTokens(resp.usage), ms, status }
  const errLine = upstreamErrorLine(bodyText)
  const errField = errLine ? { err: errLine } : {}
  if (status === 401 || status === 403) return { state: 'auth-dead', status, ms, ...errField, calls: [call] }
  if (isQuotaError(status, bodyText ?? '')) return { state: 'quota', status, ms, ...errField, calls: [call] }
  if (status === 429) {
    // 普通限流：degraded + 引擎退避重试与 provider 冷却（额度特征已在上一分支截流为 quota）
    return {
      state: 'degraded',
      status,
      ms,
      ...errField,
      calls: [call],
      rateLimited: true,
      ...(resp.headers?.['retry-after'] != null ? { retryAfter: resp.headers['retry-after'] } : {}),
    }
  }
  if (status >= 400) return { state: 'degraded', status, ms, ...errField, calls: [call] }
  const reply = extractReplyText(bodyText)
  if (p1EchoMatch(reply)) return { state: 'healthy', status, ms, calls: [call] }
  const actual = (reply ?? '').trim()
  return {
    state: 'degraded',
    status,
    ms,
    // 可诊断性：有回复带回复原文（截断）；解析不出回复（协议形态不支持/回复为空——推理模型
    // 可能只回 reasoning_content）带响应体片段，别只给一个「-」让人无从查起
    err: actual
      ? t('探针 P1 回显不匹配：期望「{expected}」，实际「{actual}」（服务可达但 canary 未以独立词出现，人工复核）', 'Probe p1 echo mismatch: expected "{expected}", got "{actual}" (service reachable but canary missing as a standalone word; review manually)', {
          expected: P1_CANARY,
          actual: actual.slice(0, 120),
        })
      : t('探针 P1 未解析出回复文本（响应体片段「{body}」——协议形态不支持或回复为空，人工复核）', 'Probe p1 parsed no reply text (body excerpt "{body}" — protocol shape unsupported or empty reply; review manually)', {
          body: (bodyText ?? '').replace(/\s+/g, ' ').slice(0, 120) || '-',
        }),
    calls: [call],
  }
}

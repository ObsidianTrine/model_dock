// tokenlimits.ts — 数据面 per-harness 限额（水密舱熔断丝）。
// 定位：runaway 客户端（编排 worker 失控循环等）的独立刹车层——编排侧熔断靠杀进程树，
// 进程逃逸就兜不住；网关按 token 计数是不依赖客户端自觉的最后一道。不是计费账本：
// 计数器在内存（重启清零、热加载不动），计费事实在 usage 日志与 /_modeldock/usage。
// 口径：input 含缓存读/建 + output（与 reconcile 对账口径一致）。

import { localIsoTs } from '../../util/time.js'
import type { GatewayRuntime } from './types.js'

export type TokenLimitTrip = 'rpm' | 'daily_tokens'

/** 转发前检查（rpm 计数在此进行：请求即计数，含 in-flight 与失败）。返回 null = 放行；
 *  未配置 limits 的 harness（含 admin-test 伪 harness）恒放行且不建状态——ephemeral 例外：
 *  provision 签发的临时 worker 无条件建账计量（gatewayProvision 场景只传 taskId 不配 limits，
 *  沿用旧口径会让编排器预算实测账 day_billable_tokens 恒 0、预算熔断静默失效），无 limits 时
 *  阈值判定全部不命中、恒放行，只恢复 day_tokens/day_billable_tokens 计数。 */
export function checkTokenLimits(rt: GatewayRuntime, harnessId: string, now = Date.now()): TokenLimitTrip | null {
  const limits = rt.config.harness[harnessId]?.limits
  if (!rt.ephemeral.has(harnessId) && (!limits || (limits.rpm == null && limits.daily_tokens == null))) return null
  let st = rt.tokenUsage.get(harnessId)
  if (!st) {
    st = { rpmStart: now, rpmCount: 0, dayKey: dayKeyOf(now), dayTokens: 0, dayBillableTokens: 0 }
    rt.tokenUsage.set(harnessId, st)
  }
  if (now - st.rpmStart > 60_000) {
    st.rpmStart = now
    st.rpmCount = 0
  }
  if (limits?.rpm != null && st.rpmCount >= limits.rpm) return 'rpm'
  st.rpmCount += 1
  if (st.dayKey !== dayKeyOf(now)) {
    st.dayKey = dayKeyOf(now)
    st.dayTokens = 0
  }
  if (limits?.daily_tokens != null && st.dayTokens >= limits.daily_tokens) return 'daily_tokens'
  return null
}

/** 响应后累计当日 token（usage 缺省/解析失败记 0——尽力而为，与 usage tap 同语义）。
 *  无状态条目时不建状态、静默跳过——ephemeral 例外（兜底建账：记账路径可能未经
 *  checkTokenLimits，如测试直灌；见 checkTokenLimits 注）。
 *  双口径：dayTokens = 总口径（缓存读计入，daily_tokens 限额判定沿用）；dayBillableTokens =
 *  可计费口径（usage.billable_tokens，usage tap 按协议算好）——供 /_modeldock/harness-usage
 *  消费方（编排器预算实测账）做剔除缓存读的判定。旧 usage 无 billable_tokens 字段（旧网关
 *  内存态/直灌调用）按 0 累加，计数自然从 0 起步（内存态重启清零，无跨版本迁移问题）。 */
export function recordTokenUsage(
  rt: GatewayRuntime,
  harnessId: string,
  usage: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_creation_tokens?: number; billable_tokens?: number } | undefined,
  now = Date.now()
): void {
  if (!usage) return
  let st = rt.tokenUsage.get(harnessId)
  if (!st) {
    if (!rt.ephemeral.has(harnessId)) return
    st = { rpmStart: now, rpmCount: 0, dayKey: dayKeyOf(now), dayTokens: 0, dayBillableTokens: 0 }
    rt.tokenUsage.set(harnessId, st)
  }
  if (st.dayKey !== dayKeyOf(now)) {
    st.dayKey = dayKeyOf(now)
    st.dayTokens = 0
    st.dayBillableTokens = 0
  }
  st.dayTokens += (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0) + (usage.cache_creation_tokens ?? 0) + (usage.output_tokens ?? 0)
  st.dayBillableTokens += Math.max(0, usage.billable_tokens ?? 0)
}

function dayKeyOf(now: number): string {
  return localIsoTs(new Date(now)).slice(0, 10)
}

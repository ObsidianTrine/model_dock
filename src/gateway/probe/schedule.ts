// schedule.ts — 探针周期调度（provider-probe-suite 任务 13）。
// 定时器生命周期对齐 modelprobe.ts startModelProbeLoop：启动延迟错峰 + 固定间隔 tick、
// server close 清理、unref、initialDelayMs/intervalMs 可注入（测试传短间隔，不真等 1h）。
// 触发口径（requirements「成本知情」EARS + design 方案 4，船东硬约束「周期调度缺省零 token」）：
// - P15 被动聚合每个 tick 恒跑：零 token、零上游请求，不受 schedule_hours / cost_ack / 预算闸
//   约束——预算闸拦的是「主动探针」（requirements 预算条目原文），被动观测断了会架空
//   「7 天无证据转 stale」，与「自动化边界止于零 token 被动信号」的定位一致
// - 含 token 周期探针走双重授权门：当前本地小时 ∈ [probe] schedule_hours（schedule_hours 空 =
//   永不触发）且 [probe] cost_ack = true（持久授权）。实现取「每小时 tick 检查 + 小时命中才跑」
//   而非「到点唤醒」：单一 setInterval 同时承载 P15 恒跑与小时门两个语义，间隔才可注入测试；
//   interval = 1h 时相邻 tick 恒跨小时，每个计划小时至多跑一次主动面
// - 周期主动面取保守最小集 = P1（鉴权回声，成本 S、单请求 ≤200 tokens）：周期自动化只保底
//   「服务活着吗」，重探针留给手动触发的预估 + 逐次确认两道闸；扩大周期面留 config 演进
// - 预算闸不在此重复实现：runProbeSuite 引擎内硬校验（月度 spent ≥ budget → 单元标
//   budget-exhausted、零上游请求），schedule 只组织触发面，口径单一事实源在引擎

import type { Server } from 'node:http'
import { buildProbePlan, makeRelayProbeTransport, probeConfigView, resolveProbeModel, runProbeSuite } from './engine.js'
import type { ProbeRunResult, ProbeTarget, ProbeTransport } from './engine.js'
import { getProbeRunner } from './runners/index.js'
import type { GatewayRuntime } from '../state/types.js'

/** 调度节奏（modelprobe.ts 同款错峰写法）：启动 90s 错峰首 tick（与节假日/目录拉取/模型探测
 *  同期错峰，不挤启动窗口）、之后每 1h 一 tick（小时门粒度）。 */
export const PROBE_SCHEDULE_INITIAL_DELAY_MS = 90_000
export const PROBE_SCHEDULE_TICK_INTERVAL_MS = 3_600_000

/** 周期被动面：P15 被动聚合（零 token，每个 tick 恒跑） */
export const PROBE_SCHEDULE_PASSIVE_IDS: readonly string[] = ['p15']
/** 周期主动面（保守最小集，见文件头）：P1 鉴权回声。disabled_ids 可逐项排除。 */
export const PROBE_SCHEDULE_ACTIVE_IDS: readonly string[] = ['p1']

export interface ProbeScheduleTickResult {
  /** 当前本地小时命中 schedule_hours（主动面的时间门；cost_ack 是另一道门） */
  hourHit: boolean
  /** P15 被动聚合结果（enabled=false 或被 disabled_ids 排除时缺席） */
  passive?: ProbeRunResult
  /** 周期主动探针结果（小时未命中 / cost_ack=false / disabled_ids 排除后无 id 时缺席；
 *  预算耗尽照常返回，ok=false reason=budget-exhausted、零上游请求） */
  active?: ProbeRunResult
}

/** 一轮调度 tick：P15 恒跑 + 小时门/cost_ack 门内的周期主动面。
 *  transport 与 now 可注入（测试 mock 上游、钉死本地小时；生产缺省走 forwardToUpstream 适配器
 *  与真实时钟）。[probe].enabled=false 时整轮零动作（引擎同样会拒派发，这里提前返回省一次
 *  账本读与 targets 展开）。 */
export async function runProbeScheduleTick(
  rt: GatewayRuntime,
  opts: { now?: Date; transport?: ProbeTransport } = {}
): Promise<ProbeScheduleTickResult> {
  const pcfg = probeConfigView(rt)
  const out: ProbeScheduleTickResult = { hourHit: false }
  if (!pcfg.enabled) return out
  const transport = opts.transport ?? makeRelayProbeTransport(rt)
  const scheduled = (ids: readonly string[]): string[] => ids.filter((id) => !pcfg.disabled_ids.includes(id))
  const enabledProviderIds = Object.entries(rt.config.providers)
    .filter(([, p]) => p.enabled !== false)
    .map(([id]) => id)

  // 被动面：targets = 全部 enabled 服务（聚合不依赖 key，verdict 键 keyFp 按 '-' 占位——
  // 引擎口径）；模型走 resolveProbeModel（probe_model 指定 > 服务默认模型 > 目录首项，
  // 与主动面同口径）；服务零配置时不空跑（targets 为空的套件没有可观测产出）
  const passiveIds = scheduled(PROBE_SCHEDULE_PASSIVE_IDS)
  if (passiveIds.length > 0 && enabledProviderIds.length > 0) {
    const targets = enabledProviderIds.map((id) => ({
      providerId: id,
      model: resolveProbeModel(rt.config, id),
    }))
    out.passive = await runProbeSuite(rt, { probeIds: passiveIds, targets, transport, runnerFor: getProbeRunner })
  }

  // 主动面时间门：当前本地小时 ∈ schedule_hours 才继续（缺省空数组 = 永不触发）
  const now = opts.now ?? new Date()
  if (!pcfg.schedule_hours.includes(now.getHours())) return out
  out.hourHit = true
  if (pcfg.cost_ack !== true) return out // 持久授权门：cost_ack=false 恒只跑被动面

  const activeIds = scheduled(PROBE_SCHEDULE_ACTIVE_IDS)
  if (activeIds.length === 0) return out
  // targets 逐 enabled 服务展开主 key 目标（buildProbePlan 同口径；无 key 服务自然缺席——
  // 引擎对主动探针缺指纹一律拒发，提前收敛只少一次空跑）；secrets 仅传引擎做错误体脱敏
  const targets: ProbeTarget[] = []
  const secrets: string[] = []
  for (const id of enabledProviderIds) {
    const plan = await buildProbePlan(rt, id, activeIds)
    for (const u of plan.units) targets.push(u.target)
    secrets.push(...plan.secrets)
  }
  if (targets.length === 0) return out
  // cost_ack=true 即用户预先持久授权的周期自动化；预算闸由引擎硬校验（耗尽 → 单元标
  // budget-exhausted、零上游请求，tick 对主动面即 no-op）
  out.active = await runProbeSuite(rt, {
    probeIds: activeIds,
    targets,
    transport,
    runnerFor: getProbeRunner,
    confirmed: true,
    secrets,
  })
  return out
}

/** 启动探针周期调度：initialDelayMs 后首 tick、之后每 intervalMs 一 tick；server close 时清理
 *  定时器（与 startModelProbeLoop 同款生命周期）。延迟/间隔/transport 可注入（测试传短间隔 +
 *  mock 上游，不真等 1h、不出站）；生产缺省用 PROBE_SCHEDULE_* 常量与 forwardToUpstream 适配器。
 *  返回定时器仅供需要自管的嵌入方使用，常规路径忽略。 */
export function startProbeSchedule(
  rt: GatewayRuntime,
  server: Server,
  opts?: { initialDelayMs?: number; intervalMs?: number; transport?: ProbeTransport }
): NodeJS.Timeout[] {
  const initialDelayMs = opts?.initialDelayMs ?? PROBE_SCHEDULE_INITIAL_DELAY_MS
  const intervalMs = opts?.intervalMs ?? PROBE_SCHEDULE_TICK_INTERVAL_MS
  const tick = (): void => {
    void runProbeScheduleTick(rt, { ...(opts?.transport ? { transport: opts.transport } : {}) }).catch(() => {})
  }
  const first = setTimeout(tick, initialDelayMs)
  const loop = setInterval(tick, intervalMs)
  first.unref?.()
  loop.unref?.()
  const timers: NodeJS.Timeout[] = [first, loop]
  server.on('close', () => {
    clearTimeout(first)
    clearInterval(loop)
  })
  return timers
}

// modelprobe.ts — 上游模型可用性周期探测（v1 纯观测）。
// 动机：模型目录此前只有静态快照 + 手动刷新，编排器（Dockmaster）选模型前无法问网关
// 「这个模型此刻在上游可用吗」。本模块对 enabled 且有 key 的服务周期探测上游 /models
// （复用 providers/fetch.ts 的 fetchModelIds，超时沿用其内部上限：单端点 15s / 整体 60s，
// 此处不再叠加超时），结果连同失败原因（负缓存）只存内存（rt.modelProbe，重启清零）。
// v1 边界：不告警、不熔断、不影响转发路由、不加 config 字段——代码内默认开启，探测失败
// 静默落内存（logEvent 也不发，避免风暴期刷事件）；调度常量集中在此便于调整。

import type { Server } from 'node:http'
import { getSecret } from '../config/secrets.js'
import { fetchModelIds } from '../providers/fetch.js'
import type { GatewayRuntime, ModelProbeState } from './state/types.js'

/** 探测节奏（参照 models.dev 目录刷新的调度写法，server.ts 同款「启动延迟 + 24h」）：
 *  启动 90s 错峰首查（与节假日/目录拉取同期错峰，不挤启动窗口）、之后每 24h 一轮。
 *  失败原因负缓存进内存、端点只读缓存不触发补打——失败上游最多每 24h 被打一次，无重试风暴。 */
export const MODEL_PROBE_INITIAL_DELAY_MS = 90_000
export const MODEL_PROBE_INTERVAL_MS = 24 * 3600_000

/** 惰性取探测运行态（buildRuntime 已初始化；兜底测试/嵌入式直建 rt 未带字段的场景） */
function probeState(rt: GatewayRuntime): ModelProbeState {
  if (!rt.modelProbe) rt.modelProbe = { results: new Map(), inflight: new Set() }
  return rt.modelProbe
}

/** 探测单个 provider，结果（成功模型列表 / 失败原因）写进内存缓存。已在探测中则跳过：调度
 *  tick 与上一轮在飞请求重叠时不重复打上游。无 key / 已禁用的服务不探测也不留条目——
 *  端点缺席语义 = 「从未探测」，不等于「不可用」。 */
export async function probeProviderModels(rt: GatewayRuntime, providerId: string): Promise<void> {
  const st = probeState(rt)
  if (st.inflight.has(providerId)) return
  const p = rt.config.providers[providerId]
  if (!p || p.enabled === false) return
  st.inflight.add(providerId)
  try {
    // 先验 key 再探测：无 key 的服务（fetchModelIds 会抛「key 未设置」）静默跳过，
    // 不在观测面留下误导性的失败条目
    const key = await getSecret(p.key_ref)
    if (!key) return
    try {
      const f = await fetchModelIds(p)
      st.results.set(providerId, { ok: true, fetched_at: new Date().toISOString(), model_ids: f.ids })
    } catch (e) {
      st.results.set(providerId, {
        ok: false,
        fetched_at: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      })
    }
  } finally {
    st.inflight.delete(providerId)
  }
}

/** 全量探测一轮：enabled 服务并行探测（各自带 fetchModelIds 内部超时，慢上游不拖累别家）。 */
export async function probeAllProviders(rt: GatewayRuntime): Promise<void> {
  const ids = Object.entries(rt.config.providers)
    .filter(([, p]) => p.enabled !== false)
    .map(([id]) => id)
  await Promise.allSettled(ids.map((id) => probeProviderModels(rt, id)))
}

/** 启动周期探测调度：initialDelayMs 后首查、之后每 intervalMs 一轮；server close 时清理定时器
 *  （与节假日/目录刷新定时器同款生命周期）。延迟与间隔可注入（测试传短间隔，不真等 24h）；
 *  生产缺省用 MODEL_PROBE_* 常量。返回定时器仅供需要自管的嵌入方使用，常规路径忽略。 */
export function startModelProbeLoop(
  rt: GatewayRuntime,
  server: Server,
  opts?: { initialDelayMs?: number; intervalMs?: number }
): NodeJS.Timeout[] {
  const initialDelayMs = opts?.initialDelayMs ?? MODEL_PROBE_INITIAL_DELAY_MS
  const intervalMs = opts?.intervalMs ?? MODEL_PROBE_INTERVAL_MS
  const tick = (): void => { void probeAllProviders(rt).catch(() => {}) }
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

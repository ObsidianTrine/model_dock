// modelprobe.ts — 上游模型可用性周期探测（v1 纯观测）。
// 动机：模型目录此前只有静态快照 + 手动刷新，编排器（Dockmaster）选模型前无法问网关
// 「这个模型此刻在上游可用吗」。本模块对 enabled 且有 key 的服务周期探测上游 /models
// （复用 providers/fetch.ts 的 fetchModelIds，超时沿用其内部上限：单端点 15s / 整体 60s，
// 此处不再叠加超时），结果连同失败原因（负缓存）只存内存（rt.modelProbe，重启清零）。
// v1 边界：不告警、不熔断、不影响转发路由、不加 config 字段——代码内默认开启，探测失败
// 静默落内存（logEvent 也不发，避免风暴期刷事件）；调度常量集中在此便于调整。

import type { Server } from 'node:http'
import { getSecret, providerKeyRefs } from '../config/secrets.js'
import { fetchModelIds } from '../providers/fetch.js'
import { t } from '../util/i18n.js'
import type { ProviderConfig } from '../config/types.js'
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

/** 探测 key 引用解析结果（池全量口径）：
 *  - { ref }：第一把可读引用（返回 ref 而非明文——fetchModelIds 内部自己按 provider.key_ref 取
 *    key，池-only provider（手编 keys 数组、无 key_ref）此前被探测面判成「无 key」永不探测
 *    （P1-3），把首个可读池 ref 折回浅拷贝的 key_ref 即复用既有拉取链路，不动 providers/fetch.ts）
 *  - { err }：引用全不可读且至少一把是读取抛错（钥匙环锁定等密钥后端异常，区别于条目缺失的
 *    返回空）——落负缓存可观测，不再经 allSettled 静默吞（P1-3）
 *  - null：无 key（未配引用 / 引用条目缺失，getSecret 返回空）——维持既有「从未探测」缺席语义 */
type ProbeKey = { ref: string } | { err: string } | null

async function resolveProbeKey(p: ProviderConfig): Promise<ProbeKey> {
  let firstErr: string | undefined
  let sawRef = false
  for (const ref of providerKeyRefs(p)) {
    if (ref === '') continue // key_ref 缺失的空 plain 哨兵：等同未配 key，不去碰密钥后端
    sawRef = true
    let v: string | null
    try {
      v = await getSecret(ref)
    } catch (e) {
      // 单把读不到（后端异常/坏引用）先记账再尝试下一把——与 getFirstProviderSecret 同口径：
      // 池内还有可读 key 就照常探测，全部不可读且有后端异常才判「探失败」
      firstErr ??= e instanceof Error ? e.message : String(e)
      continue
    }
    if (v) return { ref }
  }
  if (sawRef && firstErr) return { err: firstErr }
  return null
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
    // 先验 key 再探测（池全量口径）：未配 key / 引用条目缺失的服务静默跳过（缺席语义不变）；
    // 密钥后端读抛错（钥匙环锁定等）则落负缓存——观测面能区分「没探」与「探失败」（P1-3）
    const key = await resolveProbeKey(p)
    if (key === null) return
    if ('err' in key) {
      st.results.set(providerId, {
        ok: false,
        fetched_at: new Date().toISOString(),
        error: t('读取 key 失败：{msg}', 'Failed to read the key: {msg}', { msg: key.err }),
      })
      return
    }
    try {
      const f = await fetchModelIds({ ...p, key_ref: key.ref })
      st.results.set(providerId, { ok: true, fetched_at: new Date().toISOString(), model_ids: f.ids })
    } catch (e) {
      st.results.set(providerId, {
        ok: false,
        fetched_at: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      })
    }
  } catch (e) {
    // 兜底 catch（P1-3）：探测自身异常不再经 allSettled 静默吞——同样落负缓存可观测
    st.results.set(providerId, {
      ok: false,
      fetched_at: new Date().toISOString(),
      error: e instanceof Error ? e.message : String(e),
    })
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

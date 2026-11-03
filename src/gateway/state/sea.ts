// sea.ts — 海况观测：per-provider 滑动窗口错误分桶 + 聚合「海况」信号 sea_state。
// 定位：Dockmaster 编排侧风暴闸的外部数据源扩展（/_modeldock/metrics 的 providers[].errors
// 与 sea_state 字段），纯观测——不告警、不熔断、不影响转发路由。
// 与熔断判定（routing.ts recordOutcome）同源不同构：分桶只随同一事件流记账、独立存储。
// 本模块的常量与结构随便调都不会影响选路行为；反过来熔断阈值（recordOutcome 内）也不影响这里。
// 时间注入：recordSeaOutcome / seaWindowView / seaStateSnapshot 都接受 now 参数，测试不必真等窗口滑动。

import type { GatewayRuntime, SeaProviderErrors, SeaMinuteBucket, SeaWindowView, SeaState } from './types.js'

/** 分钟桶槽数：60 槽环形覆盖 60min 窗口（5min 视图 = 同一份槽的子集聚合），内存有界
 *  （60 桶 × 6 个数 × 服务数，与 metricsLatency 的 500 条采样同一量级思路） */
const SEA_BUCKET_SLOTS = 60
const MINUTE_MS = 60_000

/** metrics errors 视图的两个窗口宽度：last_5m / last_60m（storm 的 429 率判定用 last_60m 同一窗口） */
export const SEA_WINDOW_5M_MS = 5 * MINUTE_MS
export const SEA_WINDOW_60M_MS = 60 * MINUTE_MS

// —— 风暴判定常量（调参集中在此；判定结果只进 metrics 的 sea_state 展示，绝不参与路由）——
/** enabled 服务熔断占比「严格大于」该阈值即风暴。0.5 = 过半；单服务部署该服务熔断即 1/1 必风暴
 *  （唯一上游挂了就是风暴，不需要「过半」的会计学） */
export const SEA_STORM_MELTDOWN_RATIO = 0.5
/** enabled 服务 60min 窗口合计 429 率（429 数 / 全部请求数）「≥」该阈值即风暴。0.3：上游普遍
 *  开始限流的量级。quota（额度耗尽，relay 分类与 429 互斥）不计入——口径与 429 字段名严格一致 */
export const SEA_STORM_429_RATE = 0.3
/** 429 率判定的最小样本量：窗口合计 total 低于此值不判（低流量下 1/2=50% 是噪声不是风暴） */
export const SEA_STORM_429_MIN_TOTAL = 20

/** 风暴原因短码（程序字段用英文、编排侧按值分支；不经 t()——非用户可见文案） */
export const SEA_STORM_REASON_MELTDOWN_MAJORITY = 'meltdown_majority'
export const SEA_STORM_REASON_429_RATE = 'rate_429_60m'

/** 惰性取分桶表（buildRuntime 已初始化；兜底测试/嵌入式直建 rt 未带字段的场景） */
function seaStore(rt: GatewayRuntime): Map<string, SeaProviderErrors> {
  let m = rt.seaErrors
  if (!m) {
    m = new Map()
    rt.seaErrors = m
  }
  return m
}

function emptyBucket(minute: number): SeaMinuteBucket {
  return { minute, total: 0, connect: 0, '429': 0, '5xx': 0, quota: 0 }
}

/** 记一条转发结果进分桶（recordOutcome 每次调用顺带；now 由调用方传入保持同一时间基点）。
 *  total 含成功与中性 4xx（作错误率分母）；错误按类计数，cls 缺席（中性 4xx）只进 total。 */
export function recordSeaOutcome(
  rt: GatewayRuntime,
  providerId: string,
  r: { ok: boolean; cls?: 'connect' | '429' | '5xx' | 'quota' },
  now = Date.now()
): void {
  const store = seaStore(rt)
  let sp = store.get(providerId)
  if (!sp) {
    sp = { slots: new Array(SEA_BUCKET_SLOTS).fill(undefined) }
    store.set(providerId, sp)
  }
  const minute = Math.floor(now / MINUTE_MS)
  const idx = minute % SEA_BUCKET_SLOTS
  let b = sp.slots[idx]
  if (!b || b.minute !== minute) {
    // 槽位被更早的分钟占用（≥60min 前的数据）：原地清零重用，天然完成窗口裁剪
    b = emptyBucket(minute)
    sp.slots[idx] = b
  }
  b.total += 1
  if (!r.ok && r.cls) {
    b[r.cls] += 1
    sp.lastErrorAt = now
    sp.lastErrorCls = r.cls
  }
}

/** 聚合一个滑窗视图（5min/60min）。分桶表里该 provider 尚无任何数据时由调用方判空跳过。
 *  桶的新鲜度按「桶覆盖的分钟段与窗口有交集」判定；墙钟回拨产生的「未来」桶不计。
 *  error_rate = 四类错误合计 / total（中性 4xx 只摊分母），四位小数。 */
export function seaWindowView(sp: SeaProviderErrors, windowMs: number, now = Date.now()): SeaWindowView {
  const view: SeaWindowView = { total: 0, connect: 0, '429': 0, '5xx': 0, quota: 0, error_rate: 0 }
  const cutoff = now - windowMs
  const curMinute = Math.floor(now / MINUTE_MS)
  for (const b of sp.slots) {
    if (!b) continue
    if ((b.minute + 1) * MINUTE_MS <= cutoff) continue // 整桶已滑出窗口
    if (b.minute > curMinute) continue // 未来桶（墙钟回拨残留）不计
    view.total += b.total
    view.connect += b.connect
    view['429'] += b['429']
    view['5xx'] += b['5xx']
    view.quota += b.quota
  }
  const errs = view.connect + view['429'] + view['5xx'] + view.quota
  view.error_rate = view.total > 0 ? Math.round((errs / view.total) * 10_000) / 10_000 : 0
  return view
}

/** 聚合「海况」信号（metrics 的 sea_state 字段；每次请求现算，零维护状态）。
 *  storm 判定两条规则（常量见文件顶部，命中即短码进 reasons）：
 *  1. meltdown_majority：enabled 服务熔断占比 > SEA_STORM_MELTDOWN_RATIO（只数 enabled，
 *     已下线服务不进分母也不进分子——下线服务不在海里）；
 *  2. rate_429_60m：enabled 服务 60min 合计 429 率 ≥ SEA_STORM_429_RATE 且合计样本
 *     ≥ SEA_STORM_429_MIN_TOTAL（合计口径：上游普遍限流；单服务级细节看 providers[].errors）。 */
export function seaStateSnapshot(rt: GatewayRuntime, now = Date.now()): SeaState {
  const reasons: string[] = []
  let meltdownCount = 0
  let enabled = 0
  let total = 0
  let e429 = 0
  for (const [id, p] of Object.entries(rt.config.providers)) {
    if (p.enabled === false) continue
    enabled += 1
    const h = rt.health.get(id)
    if (h?.meltdown_until != null && h.meltdown_until > now) meltdownCount += 1
    const sp = rt.seaErrors?.get(id)
    if (sp) {
      const w = seaWindowView(sp, SEA_WINDOW_60M_MS, now)
      total += w.total
      e429 += w['429']
    }
  }
  if (enabled > 0 && meltdownCount > enabled * SEA_STORM_MELTDOWN_RATIO) {
    reasons.push(SEA_STORM_REASON_MELTDOWN_MAJORITY)
  }
  if (total >= SEA_STORM_429_MIN_TOTAL && e429 / total >= SEA_STORM_429_RATE) {
    reasons.push(SEA_STORM_REASON_429_RATE)
  }
  return {
    storm: reasons.length > 0,
    reasons,
    meltdown_count: meltdownCount,
    updated_at: new Date(now).toISOString(),
  }
}

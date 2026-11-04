/** Provider 多 key 池运行态（P0①+P1⑥）：per provider+key索引 维护「healthy | cooldown(until)」
 *  与 round-robin 轮转游标。纯内存态、rt 级（重启清零；配置热加载全清——key 可能已被替换，
 *  按索引记的冷却对换上的新 key 不成立，见 reloadRuntime）。
 *
 *  失效标记只由上游 401/403 触发（relay 转发路径调用 markKeyCooldown）：
 *  401/403 = 上游在鉴权层明确拒绝该 key，请求未进入业务处理；getSecret 解析失败≠key 无效
 *  （可能只是钥匙环锁定/env 未设），解析失败走「跳过该 key」而不是打冷却。
 *  冷却 15 分钟：key 失效（被删/被吊销/额度封禁）不会分钟级自愈，短冷却只会让后续请求反复
 *  撞 401 白付整条请求时延；15 分钟后自动解封重试一次（key 被人工修复/上游侧恢复时无须重启网关）。
 */
import type { GatewayRuntime } from './types.js'

/** 上游 401/403 后该 key 的冷却时长（ms）。 */
export const KEY_COOLDOWN_MS = 15 * 60_000

/** 标记某 provider 的第 index 把 key 失效，冷却至 now + KEY_COOLDOWN_MS（重复标记顺延，不叠加）。 */
export function markKeyCooldown(rt: GatewayRuntime, providerId: string, index: number, now = Date.now()): void {
  let m = rt.keyPool.cooldown.get(providerId)
  if (!m) {
    m = new Map()
    rt.keyPool.cooldown.set(providerId, m)
  }
  m.set(index, now + KEY_COOLDOWN_MS)
}

/** 查询某 key 是否处于冷却期（过期条目顺手删除：Map 不随时间无限增长）。 */
export function keyInCooldown(rt: GatewayRuntime, providerId: string, index: number, now = Date.now()): boolean {
  const until = rt.keyPool.cooldown.get(providerId)?.get(index)
  if (until == null) return false
  if (until <= now) {
    rt.keyPool.cooldown.get(providerId)!.delete(index)
    return false
  }
  return true
}

/** round-robin 从候选里选下一个：游标自增对候选数取模——并发 worker 的请求被均摊到各候选
 *  （单 key 池恒返回唯一元素，行为与既有单 key 完全一致）。泛型于条目类型：调用方传什么
 *  数组就拿回同数组元素（避免「返回的池索引」被误当「过滤后数组下标」用——两套下标空间错位）。
 *  游标是内存态，重启归零无害。空数组返回 undefined（调用方已先行过滤非空）。 */
export function nextRotation<T>(rt: GatewayRuntime, providerId: string, items: T[]): T | undefined {
  if (items.length === 0) return undefined
  const cur = rt.keyPool.rr.get(providerId) ?? 0
  rt.keyPool.rr.set(providerId, cur + 1)
  return items[cur % items.length]
}

/** 观测面投影（/_modeldock/metrics keypool 字段）：配置的 key 总数 + 冷却中的索引与剩余 ms。
 *  只含数量/索引/时间，绝不含 key 明文或引用原文（refs 可能内嵌明文 key，一律不出域）。 */
export function keyPoolHealthView(
  rt: GatewayRuntime,
  providerId: string,
  total: number,
  now = Date.now()
): { healthy: number; cooldown: Array<{ index: number; remaining_ms: number }> } {
  const cooldown: Array<{ index: number; remaining_ms: number }> = []
  const m = rt.keyPool.cooldown.get(providerId)
  if (m) {
    for (const [index, until] of m) {
      if (until <= now) continue // 过期条目等 keyInCooldown 惰性清，这里只投影仍在冷却的
      cooldown.push({ index, remaining_ms: until - now })
    }
  }
  cooldown.sort((a, b) => a.index - b.index)
  return { healthy: Math.max(0, total - cooldown.length), cooldown }
}

/** 清空指定 provider（或全部）的 key 池运行态：reloadRuntime 热加载后调用——keys 配置可能已变，
 *  按索引记账的冷却/游标全部失效；人工换 key / 调整池后立即恢复轮转，无须等满冷却。 */
export function resetKeyPool(rt: GatewayRuntime, providerId?: string): void {
  if (providerId) {
    rt.keyPool.cooldown.delete(providerId)
    rt.keyPool.rr.delete(providerId)
    return
  }
  rt.keyPool.cooldown.clear()
  rt.keyPool.rr.clear()
}

/** 模型别名匹配：* 通配；精确键优先于 glob。
 *  matchAlias 在转发热路径上每请求执行，glob pattern 来自用户配置（有限集合），编译结果按
 *  pattern 缓存避免每请求 new RegExp。返回的 RegExp 无 g 标志，test() 无状态，可安全复用。 */
const globCache = new Map<string, RegExp>()

export function globToRegExp(g: string): RegExp {
  let re = globCache.get(g)
  if (!re) {
    const esc = g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    re = new RegExp(`^${esc}$`)
    globCache.set(g, re)
  }
  return re
}

export function matchAlias(aliases: Record<string, string> | undefined, model: string): string | undefined {
  if (!aliases || !model) return undefined
  if (Object.prototype.hasOwnProperty.call(aliases, model)) return aliases[model]
  for (const [k, v] of Object.entries(aliases)) {
    if (k.includes('*') && globToRegExp(k).test(model)) return v
  }
  return undefined
}

/** 模型计费纯计算叶子（零依赖）：ModelCost 形状、边界校验与成本算式。
 *  独立成叶是 CLI 启动闭包瘦身（perf-p2-polish）：state/logs 记账只依赖纯算式，不再为此拖入
 *  pricing → catalog → catalog-snapshot（1.18MB 字符串常量）；IO 与目录兜底留在 gateway/pricing.ts。
 *  计费口径（与编排侧 .agents/scripts/orchestrator/cost.mjs 逐字段一致，两边测试对拍）：
 *   cost = (input×input价 + output×output价 + cache_read×cacheRead价 + cache_creation×cacheWrite价) / 1e6
 *   其中 cacheRead价 = price.cache_read ?? price.input（缺省回落输入价——宁可高估不低估），
 *   cacheWrite价 = price.cache_write ?? price.input。 */

/** 单价表（USD / 百万 token）。 */
export interface ModelCost {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}

/** 价格解析器：网关侧统一注入 usage 聚合与今日仪表（provider/model → 价或 null）。 */
export type PriceResolver = (provider: string | undefined, model: string | undefined) => ModelCost | null

/** 单条覆盖 / 目录价的边界校验（与 catalog.ts saneCost 同规则；非法返回 undefined 由调用方处置）。 */
export function saneModelCost(raw: unknown): ModelCost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
  const input = num(r.input)
  const output = num(r.output)
  if (input === undefined || output === undefined) return undefined
  const cost: ModelCost = { input, output }
  const cacheRead = num(r.cache_read)
  if (cacheRead !== undefined) cost.cache_read = cacheRead
  const cacheWrite = num(r.cache_write)
  if (cacheWrite !== undefined) cost.cache_write = cacheWrite
  return cost
}

/** 两模型价差比例（模型级容灾的价格闸门算式）：input 与 output 各算一档，分母取源模型价。
 *  cache_read/cache_write 不参与（计费时缺省回落输入价，闸门只看牌价两主桶）。
 *  源价为 0：目标同桶也为 0 → 0（相等免费），目标 >0 → Infinity（拒绝）。 */
export function priceDiffRatios(from: ModelCost, to: ModelCost): { input: number; output: number } {
  const ratio = (a: number, b: number): number => {
    if (a === 0) return b === 0 ? 0 : Number.POSITIVE_INFINITY
    return Math.abs(a - b) / a
  }
  return { input: ratio(from.input, to.input), output: ratio(from.output, to.output) }
}

/** 价格闸门：input 与 output 价差均 ≤ tolerance（缺省 0.05 = 5%）才放行。
 *  双向分别卡闸隐含任意加权融合价差 ≤ tolerance，可解释性最好。
 *  epsilon（1e-9）：二进制浮点对十进制语义做减除会有噪声——十进制上恰好 5% 的对价
 *  （如 2 与 2.1）算出 0.05000000000000004 被判越界，报错还显示「差 5.0%」自相矛盾；
 *  容差比较统一放宽 1e-9（远小于任何真实档位差，不会放进真超限的价）。 */
export function priceWithinTolerance(from: ModelCost, to: ModelCost, tolerance = 0.05): boolean {
  const r = priceDiffRatios(from, to)
  const eps = 1e-9
  return r.input <= tolerance + eps && r.output <= tolerance + eps
}

/** 单请求成本（USD）。usage 为网关日志口径的四桶 token 原始计数。 */
export function costOfUsage(
  usage: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_creation_tokens?: number },
  price: ModelCost
): number {
  const cacheRead = price.cache_read ?? price.input
  const cacheWrite = price.cache_write ?? price.input
  return (
    ((usage.input_tokens ?? 0) * price.input +
      (usage.output_tokens ?? 0) * price.output +
      (usage.cache_read_tokens ?? 0) * cacheRead +
      (usage.cache_creation_tokens ?? 0) * cacheWrite) /
    1e6
  )
}

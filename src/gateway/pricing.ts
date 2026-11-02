import fs from 'node:fs'
import { catalogFlatTable, type ModelCost } from '../providers/catalog.js'
import { t } from '../util/i18n.js'
import { pricingJsonPath } from '../util/paths.js'

// 模型单价（USD / 百万 token）解析中心：
//   1. 用户覆盖 ~/.modeldock/pricing.json（键 = "<model>" 或 "<providerId>/<model>"）——
//      models.dev 是官方牌价，走折扣套餐 / 包月计划的实际单价在此覆盖；
//   2. 目录兜底（models.dev cost 字段，catalog-snapshot 捆绑 + 运行时刷新缓存）。
// 查不到价不猜：调用方把模型记入 unpriced 清单按 $0 计并提醒补价。
// 计费口径（与编排侧 .agents/scripts/orchestrator/cost.mjs 逐字段一致，两边测试对拍）：
//   cost = (input×input价 + output×output价 + cache_read×cacheRead价 + cache_creation×cacheWrite价) / 1e6
//   其中 cacheRead价 = price.cache_read ?? price.input（缺省回落输入价——宁可高估不低估），
//   cacheWrite价 = price.cache_write ?? price.input。

export type { ModelCost }

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

let overridesMemo: { path: string; mtimeMs: number; data: Record<string, ModelCost>; skipped: number; error?: string } | undefined

/**
 * 读 pricing.json 用户覆盖（mtime memo：热路径 logRequest 每请求查价，不能每次重读盘）。
 * 缺失 = 无覆盖（常态）；顶层非法 = 整文件忽略 + error；单条非法 = 跳过计数（一条写错
 * 不该废掉其余覆盖）。返回 memo 共享对象，调用方不得修改。
 */
export function loadPricingOverrides(): { data: Record<string, ModelCost>; skipped: number; error?: string } {
  const p = pricingJsonPath()
  let st: fs.Stats
  try {
    st = fs.statSync(p)
  } catch {
    return { data: {}, skipped: 0 }
  }
  if (overridesMemo && overridesMemo.path === p && overridesMemo.mtimeMs === st.mtimeMs) return overridesMemo
  const data: Record<string, ModelCost> = {}
  let skipped = 0
  let error: string | undefined
  try {
    const j: unknown = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (typeof j !== 'object' || j === null || Array.isArray(j)) {
      error = t('pricing.json 顶层须为对象：{"模型名": {"input": 美元每百万输入token, "output": ...}}', 'pricing.json must be an object at top level: {"model": {"input": usd per M input tokens, "output": ...}}')
    } else {
      for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
        const c = saneModelCost(v)
        if (c) data[k] = c
        else skipped++
      }
      if (skipped > 0) {
        error = t('pricing.json 有 {n} 条非法条目已跳过（每条须为含 input/output 数值的对象）', '{n} invalid entries in pricing.json were skipped (each entry must be an object with numeric input/output)', { n: skipped })
      }
    }
  } catch (e) {
    error = t('pricing.json 解析失败，已忽略：', 'Failed to parse pricing.json (ignored): ') + String((e as Error)?.message ?? e)
  }
  overridesMemo = { path: p, mtimeMs: st.mtimeMs, data, skipped, error }
  return overridesMemo
}

/** 清价目 memo（测试隔离用）。 */
export function clearPricingMemo(): void {
  overridesMemo = undefined
}

/**
 * 查价：provider/model 覆盖 > 模型名覆盖 > 目录。查不到返回 null（不猜）。
 * 单价表都是 USD / 百万 token；网关请求日志的 model 字段即转发上游的模型名，直接对表。
 */
export function lookupPrice(provider: string | undefined, model: string | undefined): ModelCost | null {
  const m = String(model ?? '').trim()
  if (!m) return null
  const { data } = loadPricingOverrides()
  if (provider) {
    const scoped = data[`${provider}/${m}`]
    if (scoped) return scoped
  }
  const bare = data[m]
  if (bare) return bare
  return catalogFlatTable()[m]?.cost ?? null
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

/** 价格解析器：网关侧统一注入 usage 聚合与今日仪表（provider/model → 价或 null）。 */
export type PriceResolver = (provider: string | undefined, model: string | undefined) => ModelCost | null

export function gatewayPriceResolver(provider: string | undefined, model: string | undefined): ModelCost | null {
  return lookupPrice(provider, model)
}

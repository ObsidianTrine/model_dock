import fs from 'node:fs'
import { catalogFlatTable } from '../providers/catalog.js'
import { costOfUsage, saneModelCost, type ModelCost, type PriceResolver } from '../providers/pricing-core.js'
import { t } from '../util/i18n.js'
import { pricingJsonPath } from '../util/paths.js'

// 模型单价（USD / 百万 token）解析中心：
//   1. 用户覆盖 ~/.modeldock/pricing.json（键 = "<model>" 或 "<providerId>/<model>"）——
//      models.dev 是官方牌价，走折扣套餐 / 包月计划的实际单价在此覆盖；
//   2. 目录兜底（models.dev cost 字段，catalog-snapshot 捆绑 + 运行时刷新缓存）。
// 查不到价不猜：调用方把模型记入 unpriced 清单按 $0 计并提醒补价。
// 纯算式（ModelCost/saneModelCost/costOfUsage/PriceResolver）在零依赖叶子
// ../providers/pricing-core.ts：state/logs 记账只引叶子，CLI 启动闭包不拖 catalog-snapshot
// （perf-p2-polish）；本文件持 IO 与目录兜底，下方原样转发保持既有导入面。

export type { ModelCost, PriceResolver }
export { costOfUsage, saneModelCost }

/** 回验窗（perf-p2-polish）：热路径 logRequest 每成功请求查价，旧实现 memo 命中也要先 statSync
 *  一次（Windows NTFS + Defender 下贵一个量级）。照 secrets fileCache 同款节奏：窗内纯内存命中
 *  零 I/O，窗外至多一次 stat 回验（指纹未变续窗）；外部改 pricing.json 最迟一个窗口生效。 */
const PRICING_RECHECK_MS = 5_000

let overridesMemo: { path: string; mtimeMs: number; size: number; data: Record<string, ModelCost>; skipped: number; error?: string; checkedAt: number; missing?: boolean } | undefined

/**
 * 读 pricing.json 用户覆盖（指纹回验窗 memo）。缺失 = 无覆盖（常态，同样入 memo 免每请求 stat）；
 * 顶层非法 = 整文件忽略 + error；单条非法 = 跳过计数（一条写错不该废掉其余覆盖）。
 * 公开返回只含 data/skipped/error（指纹字段是 memo 内部态）；data 引用 memo 共享，调用方不得修改。
 */
export function loadPricingOverrides(): { data: Record<string, ModelCost>; skipped: number; error?: string } {
  const m = loadPricingOverridesMemo()
  return m.error === undefined ? { data: m.data, skipped: m.skipped } : { data: m.data, skipped: m.skipped, error: m.error }
}

function loadPricingOverridesMemo(): NonNullable<typeof overridesMemo> {
  const p = pricingJsonPath()
  const now = Date.now()
  if (overridesMemo && overridesMemo.path === p && now - overridesMemo.checkedAt < PRICING_RECHECK_MS) return overridesMemo
  let st: fs.Stats | null = null
  try {
    st = fs.statSync(p)
  } catch {
    /* 文件不存在 = 无覆盖（常态） */
  }
  if (!st) {
    if (overridesMemo?.missing) {
      overridesMemo.checkedAt = now
      return overridesMemo
    }
    overridesMemo = { path: p, mtimeMs: -1, size: 0, data: {}, skipped: 0, checkedAt: now, missing: true }
    return overridesMemo
  }
  if (overridesMemo && !overridesMemo.missing && overridesMemo.path === p && overridesMemo.mtimeMs === st.mtimeMs && overridesMemo.size === st.size) {
    overridesMemo.checkedAt = now
    return overridesMemo
  }
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
  overridesMemo = { path: p, mtimeMs: st.mtimeMs, size: st.size, data, skipped, error, checkedAt: now }
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

/** 价格解析器：网关侧统一注入 usage 聚合与今日仪表（provider/model → 价或 null）。 */
export function gatewayPriceResolver(provider: string | undefined, model: string | undefined): ModelCost | null {
  return lookupPrice(provider, model)
}

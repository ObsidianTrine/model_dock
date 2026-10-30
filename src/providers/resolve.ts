import type { ModelMeta } from '../config/types.js'
import { knownModelMeta, type KnownMeta } from './known.js'
import { catalogFlatTable, catalogModelMeta } from './catalog.js'
import { knownMetaTable } from './known.js'

export interface ResolveOpts {
  /** 上游 /models 响应自带的元数据（fetchModelIds 解析所得），优先级仅次于配置里已有的值 */
  upstream?: { context_window?: number; max_output?: number }
  /** 服务 base_url：目录按厂商 host 精确匹配用 */
  baseUrl?: string
}

/**
 * 模型元数据分层解析（只补空、不覆盖），优先级从高到低：
 * 配置已有值 > 上游 /models 返回值 > 内置表（预设+EXTRA）> models.dev 目录（缓存/快照）。
 * 按字段独立下探（如 Kimi 只报上下文，最大输出落到更低层）；四层皆无返回 undefined。
 * config 传该模型在 config.toml 里的现有条目（可为 null）。
 */
export function resolveModelMeta(
  id: string,
  config?: Partial<ModelMeta> | null,
  opts?: ResolveOpts
): KnownMeta | undefined {
  const known = knownModelMeta(id)
  const cat = catalogModelMeta(id, opts?.baseUrl)
  const pick = (...vals: Array<number | undefined>): number | undefined => {
    for (const v of vals) {
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v
    }
    return undefined
  }
  const ctx = pick(config?.context_window, opts?.upstream?.context_window, known?.context_window, cat?.context_window)
  const out = pick(config?.max_output, opts?.upstream?.max_output, known?.max_output, cat?.max_output)
  // 能力（如 vision）不看上游 /models（不报此项）：配置显式值优先，其次内置表；目录快照无此字段
  const caps = config?.capabilities ?? known?.capabilities
  if (ctx === undefined && out === undefined && !caps?.length) return undefined
  const res: KnownMeta = {}
  if (ctx !== undefined) res.context_window = ctx
  if (out !== undefined) res.max_output = out
  if (caps?.length) res.capabilities = [...caps]
  return res
}

/** 配置条目为主、解析链补空的合并视图；目录 / 内置表都救不动的条目原样返回（zcode 适配器写模型规则用） */
export function resolvedModelView(id: string, meta: ModelMeta | undefined, baseUrl?: string): ModelMeta | undefined {
  if (!meta) return undefined
  const r = resolveModelMeta(id, meta, { baseUrl })
  if (!r) return meta
  return {
    ...meta,
    context_window: meta.context_window ?? r.context_window,
    max_output: meta.max_output ?? r.max_output,
    capabilities: meta.capabilities ?? r.capabilities,
  }
}

/** 内置表 ∪ 目录（内置优先）。overview.knownModels 用：前端「填模型名→自动补上下文/输出」覆盖到长尾模型。
 *  引用稳定化 memo：按两路来源的引用判缓存（catalogFlatTable 在 mtime 变化/clearCatalogMemo 时
 *  重建引用、knownMetaTable 在 clearKnownTable 时重建）——此前每次调用 spread 新对象，server 的
 *  目录视图缓存按表对象引用判键恒 miss（每请求全量 stringify 8000+ 条）。返回共享只读对象，调用方不得修改。 */
let fullKnownMemo: { flat: object; known: object; table: Record<string, KnownMeta> } | undefined
export function fullKnownTable(): Record<string, KnownMeta> {
  const flat = catalogFlatTable()
  const known = knownMetaTable()
  if (fullKnownMemo && fullKnownMemo.flat === flat && fullKnownMemo.known === known) return fullKnownMemo.table
  const table = { ...flat, ...known }
  fullKnownMemo = { flat, known, table }
  return table
}

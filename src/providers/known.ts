import { PRESETS, ensurePresetsLoaded } from '../presets/data.js'

export interface KnownMeta {
  context_window?: number
  max_output?: number
  /** 可选能力标记（当前用 'vision'）：接入客户端据此声明输入模态（如 dsh 的 input），控制台据此预勾选 */
  capabilities?: string[]
}

/** 元数据数值边界（tokens）：过滤脏值（0、-1、'unlimited' 占位、浮点、天文数字） */
export const META_LIMITS = { ctxMin: 1024, outMin: 256, max: 16_777_216 }

export function saneContextWindow(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= META_LIMITS.ctxMin && v <= META_LIMITS.max ? v : undefined
}

export function saneMaxOutput(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= META_LIMITS.outMin && v <= META_LIMITS.max ? v : undefined
}

/** 能力标记清洗：去空/去重/转小写/限长。undefined=调用方未表态（保留既有值），[]=显式清空 */
export function saneCapabilities(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const s = x.trim().toLowerCase()
    if (!s || s.length > 24 || out.includes(s)) continue
    out.push(s)
  }
  return out
}

/**
 * 全局常见模型的保守默认元数据（上下文 / 最大输出，单位 tokens）。
 * 用于在导入、展示、编辑时自动填充 model 目录，避免长留"未知"。
 * 优先级：预设库已有模型 > 此处补充的全局常见模型。
 */
/** 全局常见模型的保守默认元数据（上下文 / 最大输出，单位 tokens）。
 *  用于在导入、展示、编辑时自动填充 model 目录，避免长留"未知"。
 *  优先级：预设库已有模型（见 knownByIdTable()）> 此处补充的全局常见模型。
 *  DUP-10：EXTRA 与预设库 BY_ID 无交集——凡预设库已收录的 id 一律不在此重复（合并表 { ...EXTRA, ...BY_ID } 会恒被 BY_ID 覆盖），
 *  只保留真正非预设的变体，杜绝人肉双份维护。 */
export const EXTRA: Record<string, KnownMeta> = {
  // OpenAI（用户常以自定义 provider 导入；gpt-6-astra/sol、gpt-5.5 已由 openai 预设收录，见 BY_ID）
  'gpt-4o': { context_window: 128000, max_output: 16384 },
  'gpt-4o-mini': { context_window: 128000, max_output: 16384 },
  'gpt-4-turbo': { context_window: 128000, max_output: 4096 },
  'gpt-4.1': { context_window: 1047576, max_output: 32768 },
  'gpt-4.1-mini': { context_window: 1047576, max_output: 32768 },
  'gpt-3.5-turbo': { context_window: 16385, max_output: 4096 },
  'o1': { context_window: 200000, max_output: 100000 },
  'o1-mini': { context_window: 128000, max_output: 65536 },
  'o3': { context_window: 200000, max_output: 100000 },
  'o3-mini': { context_window: 200000, max_output: 100000 },
  'o4-mini': { context_window: 200000, max_output: 100000 },
  // Anthropic（5.5 系 / Fable 由预设库提供权威值，此处补日期后缀等变体；claude-sonnet-5-5/opus-5-5 等见 BY_ID）
  'claude-fable-5': { context_window: 1048576, max_output: 128000 },
  'claude-sonnet-4-20250514': { context_window: 200000, max_output: 64000 },
  'claude-haiku-4-5-20251001': { context_window: 200000, max_output: 64000 },
  'claude-3-7-sonnet-20250219': { context_window: 200000, max_output: 64000 },
  'claude-3-5-sonnet-20241022': { context_window: 200000, max_output: 8192 },
  'claude-3-5-haiku-20241022': { context_window: 200000, max_output: 8192 },
  'claude-3-opus-20240229': { context_window: 200000, max_output: 4096 },
  'claude-3-haiku-20240307': { context_window: 200000, max_output: 4096 },
  // DeepSeek（deepseek-flash / deepseek-v4-pro 由预设库提供，见 BY_ID）
  'deepseek-coder': { context_window: 128000, max_output: 8192 },
  // DeepSeek V4（1M 上下文；-ga/-vision 为推理平台/视觉等变体）
  'deepseek-v4.1-flash': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4-flash': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4-flash-max': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4-pro-max': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4-flash-vision-exp': { context_window: 1048576, max_output: 393216 },
  // DeepSeek V4.1（1M / 384K）。官方 id 用点号 v4.1，这里补连字符 v4-1 等非预设变体；-260910 已由预设收录
  'deepseek-v4-1-flash': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4-1-pro': { context_window: 1048576, max_output: 393216 },
  // 智谱 GLM-5.3（glm-5.3 / glm-5.3-flash / glm-5.3-flashx / glm-5-3-flash-260828 已由预设收录，见 BY_ID）
  'glm-5.3-flash-260828': { context_window: 1048576, max_output: 131072 },
  // 智谱 GLM-4.5-Air（轻量版：128K 上下文 / 16K 输出）
  'glm-4.5-air': { context_window: 131072, max_output: 16384 },
  // 通义 Qwen3-32B（阿里云/AWS 权威：原生 32K 上下文 / 8K 输出；-20250429 为日期后缀）
  'qwen3-32b': { context_window: 32768, max_output: 8192 },
  'qwen3-32b-20250429': { context_window: 32768, max_output: 8192 },
  // 小米 MiMo V2.5（2026：1M 上下文 / 128K 输出；v2.6 系已由预设收录）
  'mimo-v2.5': { context_window: 1048576, max_output: 131072 },
  'mimo-v2.5-pro': { context_window: 1048576, max_output: 131072 },
  'mimo-v2.6': { context_window: 1048576, max_output: 131072 },
  // 火山方舟 Coding/Agent Plan（2026-10 官方套餐概览，output_name 经用户 team 账号实测核对）。
  // 带日期后缀的 output_name 由预设收录；这里只收非预设的旧/新 id 形态（共存配置展示兜底）。
  // auto（智能调度）无固定限额、doubao-seed-2-0-lite 官方未公布长度，均不收录
  'doubao-seed-evolving-latest-version': { context_window: 1048576, max_output: 262144 },
  'doubao-seed-2-1-pro': { context_window: 1048576, max_output: 262144 },
  'doubao-seed-2.1-pro': { context_window: 1048576, max_output: 262144 },
  'doubao-seed-2-1-lite': { context_window: 1048576, max_output: 262144 },
  'doubao-seed-2.1-lite': { context_window: 1048576, max_output: 262144 },
  'doubao-seed-2-1-turbo': { context_window: 262144, max_output: 65536 },
  'doubao-seed-2-0-mini': { context_window: 262144, max_output: 131072 },
  'doubao-seed-2.0-mini': { context_window: 262144, max_output: 131072 },
  'minimax-m3-modelhub': { context_window: 1048576, max_output: 131072 },
  'kimi-k2-7-code-260601': { context_window: 262144, max_output: 32768 },
  'kimi-k2.8-preview': { context_window: 1048576, max_output: 1048576 },
  'kimi-k2-8-260901': { context_window: 1048576, max_output: 1048576 },
  // 火山方舟 ark-code-latest（官方 256K / 32K；代码 Agent 套餐默认）
  'ark-code-latest': { context_window: 256000, max_output: 32768 },
}

let byIdTable: Record<string, KnownMeta> | undefined
/** 清掉已构建的预设模型索引（reloadPresets 后调用）：同步下来的自定义预设改变模型元数据，
 *  长驻网关进程内不失效的话 resolveModelMeta/knownMetaTable 一直用旧值直到重启 */
export function clearKnownTable(): void {
  byIdTable = undefined
  knownMetaMemo = undefined
}
/** 预设库模型索引（预设已内置各厂商权威值，按 id 建表）。懒构建：首次查询时确保预设已加载（BUG-12）再建表，与 EXTRA 一起合并成完整已知表 */
export function knownByIdTable(): Record<string, KnownMeta> {
  ensurePresetsLoaded()
  if (byIdTable) return byIdTable
  const out: Record<string, KnownMeta> = {}
  for (const p of PRESETS) {
    for (const pm of p.models ?? []) {
      if (!pm.context_window) continue
      out[pm.id] = {
        context_window: pm.context_window,
        max_output: pm.max_output,
        ...(pm.capabilities ? { capabilities: [...pm.capabilities] } : {}),
      }
    }
  }
  byIdTable = out
  return out
}

/** 视觉模型（id 前缀或基名匹配；日期后缀等变体经 baseModelIds 逐级命中）。可选能力，只在此显式声明 */
const VISION_PREFIXES = [
  'claude-3', 'claude-4', 'claude-5', // Anthropic 3 起全系支持图片
  'gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'gpt-5', 'gpt-6', 'o1', 'o3', 'o4',
  'gemini',
  'minimax-m3',
  'kimi-k3', 'kimi-k2.7-code', 'kimi-k2-7-code', 'kimi-k2.6', 'kimi-k2-6', // K2.7/K2.6 系原生视觉（2026-10 官方核对）
  'mimo-v2.5', 'mimo-v2.6', // 小米 MiMo v2.5/v2.6 全系全模态
  'doubao-seed-2-1-turbo', 'doubao-seed-2.1-turbo',
  'doubao-seed-evolving',
  'deepseek-v4-flash-vision',
]
/** id 自带视觉语义（vision/vl）：表未收录的新变体也能识别。
 *  只匹配词边界整段（-vision / _vision / .vision / 开头 vision），避免裸 /vision/i 把 envisign/revision 等误判为视觉模型 */
const VISION_ID_RE = /(?:^|[-_.])vision(?![a-z0-9])|(?:^|[-_.])vl(?![a-z0-9])/i

/** 归一化阶梯：deepseek-v4-flash-ga-260731 → ['deepseek-v4-flash-ga-260731','deepseek-v4-flash-260731','deepseek-v4-flash']
 *  平台日期后缀（-260731 / -20250429）与版本标签（-ga/-preview/-exp…）逐级剥离，供聚变体查表兜底 */
export function baseModelIds(id: string): string[] {
  const out = [id]
  let s = id.trim()
  for (;;) {
    const next = s
      .replace(/[-_](?:ga|preview|exp|instruct|thinking|reasoning|latest[-_]version|latest)(?![a-z0-9])/i, '')
      .replace(/[-_]?\d{6}(?:\d{2})?$/, '')
      .replace(/[-_]+$/, '')
    if (next === s || !next) break
    s = next
    out.push(s)
  }
  return out
}

/** 按模型 id 查已知默认元数据；未收录返回 undefined。
 *  精确未命中时按 baseModelIds 逐级兜底（同一模型换代只改日期后缀时仍能补全）；仍无但 id 自带视觉语义则只给能力标记 */
export function knownModelMeta(id: string): KnownMeta | undefined {
  for (const cand of baseModelIds(id)) {
    const hit = knownByIdTable()[cand] ?? EXTRA[cand]
    if (!hit) continue
    return VISION_PREFIXES.some((pre) => cand.startsWith(pre)) && !hit.capabilities ? { ...hit, capabilities: ['vision'] } : hit
  }
  if (VISION_ID_RE.test(id)) return { capabilities: ['vision'] }
  return undefined
}

/** 合并后的完整已知表（预设库 id 优先，与 knownModelMeta 同一优先级）。用于前端"填模型名→自动补上下文/输出"。
 *  懒构建 memo：EXTRA 与 byIdTable 都是进程内稳定对象，本函数此前每次调用 spread 新对象——
 *  server 的目录视图缓存按「表对象引用」判缓存键，引用不稳导致每请求都 miss。失效点在
 *  clearKnownTable（reloadPresets 后调用），与 byIdTable 同步清。返回共享只读对象，调用方不得修改。 */
let knownMetaMemo: Record<string, KnownMeta> | undefined
export function knownMetaTable(): Record<string, KnownMeta> {
  if (knownMetaMemo) return knownMetaMemo
  const out: Record<string, KnownMeta> = { ...EXTRA, ...knownByIdTable() }
  for (const [id, m] of Object.entries(out)) {
    if (VISION_PREFIXES.some((pre) => id.startsWith(pre)) && !m.capabilities) out[id] = { ...m, capabilities: ['vision'] }
  }
  knownMetaMemo = out
  return out
}
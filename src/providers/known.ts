import { PRESETS } from '../presets/data.js'

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
const EXTRA: Record<string, KnownMeta> = {
  // OpenAI（用户常以自定义 provider 导入）
  'gpt-6-astra': { context_window: 1050000, max_output: 128000 },
  'gpt-6-sol': { context_window: 1050000, max_output: 128000 },
  'gpt-5.5': { context_window: 1000000, max_output: 128000 },
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
  // Anthropic（5.5 系 / Fable 由预设库提供权威值，此处补日期后缀等变体）
  'claude-fable-5': { context_window: 1048576, max_output: 128000 },
  'claude-sonnet-4-20250514': { context_window: 200000, max_output: 64000 },
  'claude-haiku-4-5-20251001': { context_window: 200000, max_output: 64000 },
  'claude-3-7-sonnet-20250219': { context_window: 200000, max_output: 64000 },
  'claude-3-5-sonnet-20241022': { context_window: 200000, max_output: 8192 },
  'claude-3-5-haiku-20241022': { context_window: 200000, max_output: 8192 },
  'claude-3-opus-20240229': { context_window: 200000, max_output: 4096 },
  'claude-3-haiku-20240307': { context_window: 200000, max_output: 4096 },
  // DeepSeek（deepseek-chat / deepseek-reasoner 由预设库提供，见 BY_ID）
  'deepseek-coder': { context_window: 128000, max_output: 8192 },
  // DeepSeek V4（1M 上下文；-ga/-vision 为推理平台/视觉等变体）
  'deepseek-flash': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4.1-flash': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4-flash': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4-pro': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4-flash-max': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4-pro-max': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4-flash-ga-260731': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4-flash-vision-exp': { context_window: 1048576, max_output: 393216 },
  // DeepSeek V4.1（1M / 384K）。官方 id 用点号 v4.1，这里补连字符 v4-1 及平台日期后缀变体
  'deepseek-v4-1-flash': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4-1-pro': { context_window: 1048576, max_output: 393216 },
  'deepseek-v4-1-flash-260910': { context_window: 1048576, max_output: 393216 },
  // 智谱 GLM-5.3（2026-09：1M 上下文 / 128K 输出）
  'glm-5.3': { context_window: 1048576, max_output: 131072 },
  // 智谱 GLM-5.3-Flash（2026-08：1M 上下文 / 128K 输出；-260828 为方舟日期后缀）
  'glm-5.3-flash': { context_window: 1048576, max_output: 131072 },
  'glm-5.3-flashx': { context_window: 1048576, max_output: 131072 },
  'glm-5.3-flash-260828': { context_window: 1048576, max_output: 131072 },
  'glm-5-3-flash-260828': { context_window: 1048576, max_output: 131072 },
  // 智谱 GLM-4.5-Air（轻量版：128K 上下文 / 16K 输出）
  'glm-4.5-air': { context_window: 131072, max_output: 16384 },
  // 通义 Qwen3-32B（阿里云/AWS 权威：原生 32K 上下文 / 8K 输出；-20250429 为日期后缀）
  'qwen3-32b': { context_window: 32768, max_output: 8192 },
  'qwen3-32b-20250429': { context_window: 32768, max_output: 8192 },
  // Kimi K3（Moonshot 2026-07：1M / 1M）
  'kimi-k3': { context_window: 1048576, max_output: 1048576 },
  // 小米 MiMo V2.5 / V2.6（2026：1M 上下文 / 128K 输出）
  'mimo-v2.5': { context_window: 1048576, max_output: 131072 },
  'mimo-v2.5-pro': { context_window: 1048576, max_output: 131072 },
  'mimo-v2.6': { context_window: 1048576, max_output: 131072 },
  'mimo-v2.6-pro': { context_window: 1048576, max_output: 131072 },
  'mimo-v2.6-flash': { context_window: 1048576, max_output: 131072 },
  // 火山方舟 Coding/Agent Plan（2026-10 官方套餐概览，output_name 经用户 team 账号实测核对）。
  // output_name 随版本换代（日期后缀变化），同一模型的新旧 id 形态同值收录，存量配置展示兜底即刻生效；
  // auto（智能调度）无固定限额、doubao-seed-2-0-lite 官方未公布长度，均不收录
  'doubao-seed-evolving': { context_window: 1048576, max_output: 262144 },
  'doubao-seed-evolving-latest-version': { context_window: 1048576, max_output: 262144 },
  'doubao-seed-2-1-pro-260915': { context_window: 1048576, max_output: 262144 },
  'doubao-seed-2-1-pro': { context_window: 1048576, max_output: 262144 },
  'doubao-seed-2.1-pro': { context_window: 1048576, max_output: 262144 },
  'doubao-seed-2-1-lite-260915': { context_window: 1048576, max_output: 262144 },
  'doubao-seed-2-1-lite': { context_window: 1048576, max_output: 262144 },
  'doubao-seed-2.1-lite': { context_window: 1048576, max_output: 262144 },
  'doubao-seed-2-1-turbo-260628': { context_window: 262144, max_output: 65536 },
  'doubao-seed-2-1-turbo': { context_window: 262144, max_output: 65536 },
  'doubao-seed-2-0-mini-260428': { context_window: 262144, max_output: 131072 },
  'doubao-seed-2-0-mini': { context_window: 262144, max_output: 131072 },
  'doubao-seed-2.0-mini': { context_window: 262144, max_output: 131072 },
  'minimax-m3': { context_window: 1048576, max_output: 131072 },
  'minimax-m3-modelhub': { context_window: 1048576, max_output: 131072 },
  'kimi-k2.7-code': { context_window: 262144, max_output: 32768 },
  'kimi-k2-7-code-260601': { context_window: 262144, max_output: 32768 },
  'kimi-k2-8-preview': { context_window: 1048576, max_output: 1048576 },
  'kimi-k2.8-preview': { context_window: 1048576, max_output: 1048576 },
  'kimi-k2-8-260901': { context_window: 1048576, max_output: 1048576 },
  'deepseek-v4-pro-ga-260813': { context_window: 1048576, max_output: 393216 },
  // 火山方舟 ark-code-latest（官方 256K / 32K；代码 Agent 套餐默认）
  'ark-code-latest': { context_window: 256000, max_output: 32768 },
}

/** 预设库（各厂商已内置其模型的权威值）并按 id 建索引 */
const BY_ID: Record<string, KnownMeta> = {}
for (const p of PRESETS) {
  for (const pm of p.models ?? []) {
    if (!pm.context_window) continue
    BY_ID[pm.id] = {
      context_window: pm.context_window,
      max_output: pm.max_output,
      ...(pm.capabilities ? { capabilities: [...pm.capabilities] } : {}),
    }
  }
}

/** 视觉模型（id 前缀或基名匹配；日期后缀等变体经 baseModelIds 逐级命中）。可选能力，只在此显式声明 */
const VISION_PREFIXES = [
  'claude-3', 'claude-4', 'claude-5', // Anthropic 3 起全系支持图片
  'gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'gpt-5', 'gpt-6', 'o1', 'o3', 'o4',
  'gemini',
  'minimax-m3',
  'kimi-k3', 'kimi-k2.7-code', 'kimi-k2-7-code',
  'doubao-seed-2-1-turbo', 'doubao-seed-2.1-turbo',
  'doubao-seed-evolving',
  'deepseek-v4-flash-vision',
]
/** id 自带视觉语义（vision/vl）：表未收录的新变体也能识别 */
const VISION_ID_RE = /(?:^|[-_.])(?:vision|vl)(?![a-z0-9])|vision/i

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
    const hit = BY_ID[cand] ?? EXTRA[cand]
    if (!hit) continue
    return VISION_PREFIXES.some((pre) => cand.startsWith(pre)) && !hit.capabilities ? { ...hit, capabilities: ['vision'] } : hit
  }
  if (VISION_ID_RE.test(id)) return { capabilities: ['vision'] }
  return undefined
}

/** 合并后的完整已知表（预设库 id 优先，与 knownModelMeta 同一优先级）。用于前端"填模型名→自动补上下文/输出"。 */
export function knownMetaTable(): Record<string, KnownMeta> {
  const out: Record<string, KnownMeta> = { ...EXTRA, ...BY_ID }
  for (const [id, m] of Object.entries(out)) {
    if (VISION_PREFIXES.some((pre) => id.startsWith(pre)) && !m.capabilities) out[id] = { ...m, capabilities: ['vision'] }
  }
  return out
}
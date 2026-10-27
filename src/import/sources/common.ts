/** 导入源共享帮手：类型、URL 归一化、候选去重、占位与跨源小工具（各源文件与 registry 共用） */
import { isFile } from '../../util/index.js'
import { stripContextSuffix } from '../../adapters/shared.js'
import type { AuthStyle, Protocol } from '../../config/types.js'

export type ImportSource =
  | 'cc-switch'
  | 'claude'
  | 'dsh'
  | 'zcode'
  /** Codex CLI（~/.codex/config.toml + auth.json） */
  | 'codex'
  /** OpenCode（opencode.json + auth.json） */
  | 'opencode'
  /** MiMo Code CLI / MiMo 桌面端（共用 mimocode.jsonc） */
  | 'mimocode'
  /** WorkBuddy（models.json） */
  | 'workbuddy'
  /** claude-code-router（~/.claude-code-router/config.json） */
  | 'ccr'
  /** Crush（~/.config/crush/crush.json） */
  | 'crush'
  /** Gemini CLI 第三方中转（~/.gemini/.env 的 GOOGLE_GEMINI_BASE_URL） */
  | 'gemini'
  /** one-api / new-api 渠道（管理 API 拉取，需要站点地址 + 系统访问令牌） */
  | 'oneapi'

export interface ImportCandidate {
  source: ImportSource
  suggest_id: string
  name: string
  base_url: string
  protocol: Protocol
  auth_style: AuthStyle
  key: string | null
  key_note?: string
  models?: string[]
  is_current?: boolean
  skip_reason?: string
}

/** 服务地址归一化：小写主机、去默认端口与结尾斜杠——去重一律用它比较 */
export function normalizeBaseUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.port ? ':' + u.port : ''}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return url.trim().replace(/\/+$/, '')
  }
}

/** 本机代理地址判断：按 hostname 精确匹配（回环段），不误伤恰含 "127.0.0.1" 子串的公网域名 */
export function isLocalBaseUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return (
      h === 'localhost' ||
      h.endsWith('.localhost') ||
      h === '::1' ||
      h === '0.0.0.0' ||
      /^127\.\d+\.\d+\.\d+$/.test(h)
    )
  } catch {
    return url.includes('127.0.0.1') || url.includes('localhost')
  }
}

/** 客户端配置里常见「完整请求端点」（…/chat/completions、…/v1/messages 等）转 ModelDock
 *  base_url：剥掉最后一层端点路径。ModelDock 转发时会按协议自行拼端点路径
 *  （见 gateway/relay.ts joinUpstreamUrl），整段存反而会双拼。openai 系只剥端点叶子
 *  （…/v1/chat/completions → …/v1，版本段是 base_url 的一部分）；anthropic 的
 *  /v1/messages 整段剥（anthropic base_url 惯例不带 /v1）。非端点形态原样返回。 */
export function stripApiEndpoint(url: string): string {
  return url
    .replace(/\/+(?:v1\/)?messages(?:\/count_tokens)?$/i, '')
    .replace(/\/+(?:chat\/completions|completions|responses|embeddings)$/i, '')
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** 迁移导入按「地址」去重：同一地址（尾斜杠/大小写归一化）视为同一个服务，保留优先级「使用中 > 有 Key > 先出现」。
 *  注意：这里刻意忽略 Key 的具体值——迁移时同地址往往是一份配置的多个历史/备份 key，只导一条即可，避免重复服务；
 *  真正的多账号请在导入后通过「添加服务」分别登记。
 *  带 skip_reason 的占位项（base_url 为空的诊断信息，如"无 sqlite3"）不去重、不丢弃。 */
export function dedupeCandidates(cands: ImportCandidate[]): ImportCandidate[] {
  const by = new Map<string, ImportCandidate>()
  const diagnostics: ImportCandidate[] = []
  const better = (c: ImportCandidate, prev: ImportCandidate): boolean => {
    if (!prev.is_current && c.is_current) return true
    if (!prev.key && c.key) return true
    return false
  }
  for (const c of cands) {
    if (!c.base_url) {
      if (c.skip_reason) diagnostics.push(c)
      continue
    }
    const key = normalizeBaseUrl(c.base_url)
    const prev = by.get(key)
    if (!prev || better(c, prev)) by.set(key, c)
  }
  return [...by.values(), ...diagnostics]
}

export interface RawRow {
  [k: string]: unknown
}

export async function firstExisting(files: string[]): Promise<string | null> {
  for (const p of files) {
    if (await isFile(p)) return p
  }
  return null
}

export function placeholder(source: ImportSource, note: string): ImportCandidate {
  return {
    source,
    suggest_id: source,
    name: source,
    base_url: '',
    protocol: 'anthropic',
    auth_style: 'bearer',
    key: null,
    skip_reason: note,
  }
}

export function collectModelEnvs(env: Record<string, unknown>): string[] {
  const out = new Set<string>()
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v !== 'string' || v === '') continue
    if (k === 'ANTHROPIC_MODEL' || k.startsWith('ANTHROPIC_DEFAULT_')) {
      // 去掉 [1M] 等上下文变体后缀：那是请求参数标记，不是独立模型 id（stripContextSuffix 与 claude-code.ts 共用）
      const base = stripContextSuffix(v).trim()
      if (base) out.add(base)
    }
  }
  return [...out]
}

/** gemini 中转 base_url：settings 与 cc-switch gemini 行共用 */
export function envBaseUrl(env: Record<string, unknown>): string {
  const v = env.GOOGLE_GEMINI_BASE_URL ?? env.GEMINI_BASE_URL
  return typeof v === 'string' ? v.trim() : ''
}

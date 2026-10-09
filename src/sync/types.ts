import type { ProfileConfig, Protocol, ProviderConfig, ScheduleWindow } from '../config/types.js'
import { t } from '../util/i18n.js'

/**
 * syncdoc v1 —— 可同步态的传输/存储逻辑格式（加密前的明文形态），详见 docs/design-cloud-sync.md §4.2。
 * providers/profiles 用 Record<id, entry>（与 config store 等价，数组会丢 id）。
 * 机器态（harness 接入/gateway.json/当前激活路由/自启/日志统计）不进 syncdoc。
 */
export const SYNCDOC_FMT = 'modeldock-syncdoc'
export const ENVELOPE_FMT = 'modeldock-syncenv'
export const SCHEMA_VERSION = 1

/** syncdoc 内的 provider 条目：key 明文化后不再携带 key_ref（env: 引用与解析失败的除外，原样保留） */
export type SyncProviderEntry = Omit<ProviderConfig, 'key_ref'> & {
  key_ref?: string
  /** 上游 key 明文（导出时从 key_ref 解析；env: 引用不解析） */
  key?: string
}

export interface SyncdocData {
  providers: Record<string, SyncProviderEntry>
  profiles: Record<string, ProfileConfig>
  /** presets.json 的原始 JSON（数组或 {presets:[...]}），保真不归一化 */
  userPresets: unknown[] | { presets: unknown[] }
  /** 定时切换规则（config.toml gateway.schedule.windows）；每机「启用」开关属机器态不随包 */
  scheduleRules: ScheduleWindow[]
}

export interface Syncdoc {
  fmt: typeof SYNCDOC_FMT
  v: number
  ts: string
  data: SyncdocData
}

/** 加密信封（envelope v1）——出机器的唯一形态。hkdfSalt/verifier 为详设 §4.3 的自包含补全：
 *  HKDF 盐不随包则独立文件解不开；verifier 让「口令错误」与「包被篡改」报错可区分。 */
export interface SyncEnvelope {
  fmt: typeof ENVELOPE_FMT
  v: number
  kdf: { alg: 'PBKDF2-HMAC-SHA256'; iter: number; salt: string; hkdfSalt: string }
  iv: string
  ct: string
  /** HMAC-SHA256(macKey, ts || '||' || ct)，防存储端回滚/篡改的兜底层 */
  hmac: string
  /** HMAC-SHA256(macKey, 'modeldock/syncenv/verifier/v1')，解密前校验口令是否一致 */
  verifier: string
  created_by: string
  created_at: string
}

const PROTOCOLS: Protocol[] = ['anthropic', 'openai', 'responses']
const AUTH_STYLES = ['bearer', 'x-api-key']
const DAY_FILTERS = ['workday', 'weekend', 'holiday']
const HHMM = /^\d{2}:\d{2}$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function fail(msg: string): never {
  throw new Error(msg)
}

/** schema 校验（手写，零依赖）。通过返回强类型 doc；任何不符抛可操作报错，调用方拒绝应用 */
export function validateSyncdoc(input: unknown): Syncdoc {
  if (!isPlainObject(input)) fail(t('同步包内容不是合法的 JSON 对象', 'The sync package content is not a valid JSON object'))
  const doc = input as Record<string, unknown>
  if (doc.fmt !== SYNCDOC_FMT) fail(t('不是 ModelDock 配置同步包（fmt={f}）', 'Not a ModelDock sync package (fmt={f})', { f: String(doc.fmt ?? '') }))
  if (typeof doc.v !== 'number' || !Number.isInteger(doc.v) || doc.v < 1) fail(t('同步包缺少有效的格式版本号', 'The sync package has no valid format version'))
  if (doc.v > SCHEMA_VERSION)
    fail(
      t(
        '同步包格式版本 v={v} 高于当前客户端支持的 {max}，请先升级 modeldock 再导入',
        'Package format version v={v} is newer than the supported {max}; upgrade modeldock first, then import',
        { v: doc.v, max: SCHEMA_VERSION }
      )
    )
  if (typeof doc.ts !== 'string' || !doc.ts) fail(t('同步包缺少导出时间戳', 'The sync package is missing its export timestamp'))
  if (!isPlainObject(doc.data)) fail(t('同步包缺少 data 段', 'The sync package is missing the data section'))
  const data = doc.data as Record<string, unknown>

  // providers：Record<id, entry>，条目必须带 base_url/protocol/auth_style 与 key(key_ref)
  if (!isPlainObject(data.providers)) fail(t('同步包 providers 段格式错误（应为对象）', 'Invalid providers section (must be an object)'))
  for (const [id, raw] of Object.entries(data.providers)) {
    if (!isPlainObject(raw)) fail(t('服务「{id}」条目格式错误', 'Invalid entry for provider "{id}"', { id }))
    const p = raw as Record<string, unknown>
    if (typeof p.base_url !== 'string' || !p.base_url) fail(t('服务「{id}」缺少 base_url', 'Provider "{id}" is missing base_url', { id }))
    if (!(PROTOCOLS as string[]).includes(String(p.protocol))) fail(t('服务「{id}」的 protocol={v} 不受支持', 'Provider "{id}" has unsupported protocol={v}', { id, v: String(p.protocol) }))
    if (!(AUTH_STYLES as string[]).includes(String(p.auth_style))) fail(t('服务「{id}」的 auth_style={v} 不受支持', 'Provider "{id}" has unsupported auth_style={v}', { id, v: String(p.auth_style) }))
    const hasKey = typeof p.key === 'string' && p.key !== ''
    const hasRef = typeof p.key_ref === 'string' && p.key_ref !== ''
    if (!hasKey && !hasRef) fail(t('服务「{id}」既无 key 也无 key_ref', 'Provider "{id}" has neither key nor key_ref', { id }))
    if (p.endpoints !== undefined && !isPlainObject(p.endpoints)) fail(t('服务「{id}」endpoints 格式错误', 'Provider "{id}" has invalid endpoints', { id }))
    if (p.models !== undefined && !isPlainObject(p.models)) fail(t('服务「{id}」models 目录格式错误', 'Provider "{id}" has an invalid models catalog', { id }))
  }

  // profiles：Record<id, entry>，条目必须带 provider
  if (!isPlainObject(data.profiles)) fail(t('同步包 profiles 段格式错误（应为对象）', 'Invalid profiles section (must be an object)'))
  for (const [id, raw] of Object.entries(data.profiles)) {
    if (!isPlainObject(raw)) fail(t('路由「{id}」条目格式错误', 'Invalid entry for profile "{id}"', { id }))
    const pr = raw as Record<string, unknown>
    if (typeof pr.provider !== 'string' || !pr.provider) fail(t('路由「{id}」缺少 provider', 'Profile "{id}" is missing provider', { id }))
    if (pr.fallback !== undefined && !Array.isArray(pr.fallback)) fail(t('路由「{id}」fallback 格式错误', 'Profile "{id}" has an invalid fallback list', { id }))
  }

  // userPresets：数组或 {presets:[...]}；缺省视为无自定义
  if (data.userPresets !== undefined && data.userPresets !== null) {
    const up = data.userPresets
    const arr = Array.isArray(up) ? up : isPlainObject(up) && Array.isArray((up as Record<string, unknown>).presets) ? (up as Record<string, unknown>).presets : null
    if (arr === null) fail(t('同步包自定义预设格式错误（应为数组或 { "presets": [...] }）', 'Invalid custom presets section (must be an array or { "presets": [...] })'))
  }

  // scheduleRules：数组，条目必须带 start/end/target
  if (data.scheduleRules !== undefined && data.scheduleRules !== null) {
    if (!Array.isArray(data.scheduleRules)) fail(t('同步包定时规则格式错误（应为数组）', 'Invalid schedule rules section (must be an array)'))
    for (const [i, raw] of (data.scheduleRules as unknown[]).entries()) {
      if (!isPlainObject(raw)) fail(t('定时规则第 {n} 条格式错误', 'Schedule rule #{n} is malformed', { n: i + 1 }))
      const w = raw as Record<string, unknown>
      if (typeof w.start !== 'string' || !HHMM.test(w.start) || typeof w.end !== 'string' || !HHMM.test(w.end))
        fail(t('定时规则第 {n} 条 start/end 应为 HH:mm', 'Schedule rule #{n}: start/end must be HH:mm', { n: i + 1 }))
      if (typeof w.target !== 'string' || !w.target) fail(t('定时规则第 {n} 条缺少 target', 'Schedule rule #{n} is missing target', { n: i + 1 }))
      if (w.dayFilter !== undefined && !(DAY_FILTERS as string[]).includes(String(w.dayFilter)))
        fail(t('定时规则第 {n} 条 dayFilter={v} 不受支持', 'Schedule rule #{n} has unsupported dayFilter={v}', { n: i + 1, v: String(w.dayFilter) }))
    }
  }
  return input as unknown as Syncdoc
}

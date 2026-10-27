/** OpenCode 导入源（opencode.json + auth.json）；provider.<id> 同构 JSON/JSONC 扫描器被 mimocode 复用 */
import path from 'node:path'
import { homeDir, readTextIfExists, slugify } from '../../util/index.js'
import { t } from '../../util/i18n.js'
import { parseJsonTolerant } from '../../adapters/format.js'
import { firstExisting, isLocalBaseUrl, placeholder, stripApiEndpoint, type ImportCandidate, type ImportSource } from './common.js'
import type { Protocol } from '../../config/types.js'

/* ── OpenCode / MiMo Code（provider.<id>.options.baseURL/apiKey 同构 JSON/JSONC）──────
 *  npm 包名决定协议：@ai-sdk/anthropic → anthropic，其余（@ai-sdk/openai、
 *  @ai-sdk/openai-compatible、缺省）→ openai。apiKey 支持字面量与 {env:VAR}/{file:path} 引用。 */

interface ProviderJsonEntry {
  name?: unknown
  options?: Record<string, unknown>
  baseURL?: unknown
  apiKey?: unknown
  npm?: unknown
  models?: unknown
  [k: string]: unknown
}

interface ProviderJsonRoot {
  provider?: Record<string, ProviderJsonEntry>
  model?: unknown
  [k: string]: unknown
}

function providerJsonProtocol(e: ProviderJsonEntry): { protocol: Protocol; skip?: string } {
  const npm = typeof e.npm === 'string' ? e.npm : ''
  if (!npm || npm.includes('@ai-sdk/openai')) return { protocol: 'openai' }
  if (npm.includes('@ai-sdk/anthropic')) return { protocol: 'anthropic' }
  return { protocol: 'openai', skip: t('上游 SDK「{npm}」不是 OpenAI/Anthropic 兼容协议，暂不支持直连导入', 'Upstream SDK "{npm}" is not an OpenAI/Anthropic-compatible protocol; direct import is not supported yet', { npm }) }
}

/** opencode 系 apiKey 值解析：字面量直接用；{env:VAR} 查当前进程；{file:…} 不代读 */
function resolveProviderJsonValue(v: string): { key: string | null; note?: string } {
  const envRef = v.match(/^\{env:(.+)\}$/)
  if (envRef) {
    const name = envRef[1].trim()
    const val = process.env[name] ?? ''
    return val
      ? { key: val, note: t('来自环境变量 {env}', 'From environment variable {env}', { env: name }) }
      : { key: null, note: t('引用环境变量 {env}，当前进程未设置；导入后可再补 Key', 'References environment variable {env}, which is not set in this process; add the key after importing', { env: name }) }
  }
  const fileRef = v.match(/^\{file:(.+)\}$/)
  if (fileRef) {
    return { key: null, note: t('引用文件 {file}，ModelDock 不代读；导入后请补 Key', 'References file {file}, which ModelDock does not read; add the key after importing', { file: fileRef[1].trim() }) }
  }
  return { key: v }
}

export async function scanProviderJson(source: 'opencode' | 'mimocode', files: string[], label: string, authReader?: () => Promise<Record<string, string>>): Promise<ImportCandidate[]> {
  const p = await firstExisting(files)
  if (p === null) return []
  const text = await readTextIfExists(p)
  const parsed = parseJsonTolerant(text ?? '')
  if (!parsed) {
    return [placeholder(source, t('{label} 配置存在但解析失败（JSON/JSONC 语法错误），无法读取', '{label} config exists but failed to parse (JSON/JSONC syntax error); cannot read it', { label }))]
  }
  const root = parsed.value as ProviderJsonRoot
  const auth = authReader ? await authReader() : {}
  const out: ImportCandidate[] = []
  const activeId = typeof root.model === 'string' ? root.model.split('/')[0] : ''
  for (const [id, e] of Object.entries(root.provider ?? {})) {
    const options = (typeof e?.options === 'object' && e.options !== null ? e.options : {}) as Record<string, unknown>
    const base = typeof options.baseURL === 'string' && options.baseURL ? options.baseURL : typeof e?.baseURL === 'string' ? e.baseURL : ''
    if (typeof base !== 'string' || base === '' || isLocalBaseUrl(base)) continue
    const proto = providerJsonProtocol(e)
    let key: string | null = null
    let keyNote: string | undefined
    const rawKey = typeof options.apiKey === 'string' && options.apiKey ? options.apiKey : typeof e?.apiKey === 'string' ? e.apiKey : ''
    if (rawKey) {
      const r = resolveProviderJsonValue(rawKey)
      key = r.key
      keyNote = r.note
    } else if (auth[id]) {
      key = auth[id]
      keyNote = t('来自 auth.json（客户端 auth login 保存）', 'From auth.json (saved by the client auth login)')
    }
    const models: string[] = []
    if (e?.models && typeof e.models === 'object') {
      for (const mid of Object.keys(e.models as Record<string, unknown>)) {
        if (mid) models.push(mid)
      }
    }
    out.push({
      source,
      suggest_id: `${source === 'mimocode' ? 'mimo' : source}-${slugify(id)}`,
      name: `${label} · ${typeof e?.name === 'string' && e.name ? e.name : id}`,
      base_url: stripApiEndpoint(base),
      protocol: proto.protocol,
      auth_style: 'bearer',
      key,
      key_note: keyNote,
      models: models.length > 0 ? models : undefined,
      is_current: activeId === id || undefined,
      skip_reason: proto.skip,
    })
  }
  return out
}

async function readOpencodeAuth(): Promise<Record<string, string>> {
  const candidates = [path.join(homeDir(), '.local', 'share', 'opencode', 'auth.json')]
  // 沙箱守卫：APPDATA 不随 MODELRDOCK_FAKE_HOME 重定向，沙箱里跳过，避免读到真机的 opencode 密钥
  if (process.platform === 'win32' && process.env.APPDATA && !process.env.MODELRDOCK_FAKE_HOME) {
    candidates.push(path.join(process.env.APPDATA, 'opencode', 'auth.json'))
  }
  for (const p of candidates) {
    const text = await readTextIfExists(p)
    if (text === null) continue
    try {
      const root = JSON.parse(text) as Record<string, { type?: unknown; key?: unknown }>
      const out: Record<string, string> = {}
      for (const [id, e] of Object.entries(root ?? {})) {
        if (e && typeof e.key === 'string' && e.key) out[id] = e.key
      }
      return out
    } catch {
      /* auth.json 损坏：跳过该候选路径 */
    }
  }
  return {}
}

export async function scanOpenCode(): Promise<ImportCandidate[]> {
  return scanProviderJson('opencode', [path.join(homeDir(), '.config', 'opencode', 'opencode.json')], 'OpenCode', readOpencodeAuth)
}

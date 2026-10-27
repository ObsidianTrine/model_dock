/** Codex CLI 导入源（~/.codex/config.toml + auth.json），doc 级解析被 cc-switch codex 行复用 */
import path from 'node:path'
import { homeDir, readTextIfExists, slugify } from '../../util/index.js'
import { t } from '../../util/i18n.js'
import { parse as tomlParse } from 'smol-toml'
import { isLocalBaseUrl, placeholder, stripApiEndpoint, type ImportCandidate, type ImportSource, type RawRow } from './common.js'

/* ── Codex CLI（~/.codex/config.toml + auth.json）─────────────────────────────
 *  model_providers.<id> 的 base_url 是上游根地址；env_key 指向存 Key 的环境变量
 *  （Codex 进程环境，ModelDock 进程未必继承——取不到就记 null + 说明）。wire_api
 *  区分 chat（openai）/ responses 协议。auth.json 的 OPENAI_API_KEY 是内置 OpenAI
 *  通道的登录凭据，仅在用户没有自定义 openai provider 行时才给候选。 */

interface CodexTomlDoc {
  model_providers?: Record<string, RawRow>
  model_provider?: unknown
  [k: string]: unknown
}

export function parseCodexTomlDoc(text: unknown): CodexTomlDoc | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    return tomlParse(text) as CodexTomlDoc
  } catch {
    return null
  }
}

interface CodexCandidateOpts {
  source: ImportSource
  idPrefix: string
  displayName: (id: string) => string
  isCurrent?: boolean
}

/** config.toml 的 model_providers → 候选（scanCodex 与 cc-switch codex 行共用） */
export function codexDocCandidates(doc: CodexTomlDoc, builtinKey: string, opts: CodexCandidateOpts): ImportCandidate[] {
  const out: ImportCandidate[] = []
  const activeId = typeof doc.model_provider === 'string' ? doc.model_provider : ''
  for (const [id, raw] of Object.entries(doc.model_providers ?? {})) {
    const base = typeof raw?.base_url === 'string' ? raw.base_url.trim() : ''
    if (!base || isLocalBaseUrl(base)) continue
    const envName = typeof raw?.env_key === 'string' && raw.env_key ? raw.env_key : undefined
    const isRowCurrent = opts.isCurrent === true && (!activeId || activeId === id)
    let key: string | null = null
    let keyNote: string | undefined
    if (activeId === id && builtinKey) {
      key = builtinKey
    } else if (envName) {
      const val = process.env[envName] ?? ''
      key = val || null
      keyNote = t('Key 由环境变量 {env} 提供，当前进程未读到时导入后需补', 'The key comes from environment variable {env}; if not visible to this process, add it after importing', { env: envName })
    }
    out.push({
      source: opts.source,
      suggest_id: `${opts.idPrefix}-${slugify(id)}`,
      name: opts.displayName(id),
      base_url: stripApiEndpoint(base),
      protocol: raw?.wire_api === 'responses' ? 'responses' : 'openai',
      auth_style: 'bearer',
      key,
      key_note: keyNote,
      is_current: isRowCurrent || undefined,
    })
  }
  return out
}

export async function scanCodex(): Promise<ImportCandidate[]> {
  const out: ImportCandidate[] = []
  const cfgText = await readTextIfExists(path.join(homeDir(), '.codex', 'config.toml'))
  let doc: CodexTomlDoc | null = null
  if (cfgText !== null) {
    doc = parseCodexTomlDoc(cfgText)
    if (!doc) {
      return [placeholder('codex', t('config.toml 存在但解析失败（TOML 语法错误），无法读取', 'config.toml exists but failed to parse (TOML syntax error); cannot read it'))]
    }
    out.push(
      ...codexDocCandidates(doc, '', {
        source: 'codex',
        idPrefix: 'codex',
        displayName: (id) => `Codex · ${id}`,
        isCurrent: true,
      })
    )
  }
  // auth.json：内置 OpenAI 通道（无自定义 openai 行、且确实存了 key 才给候选）
  const authText = await readTextIfExists(path.join(homeDir(), '.codex', 'auth.json'))
  if (authText !== null && doc?.model_providers?.['openai'] === undefined) {
    try {
      const auth = JSON.parse(authText) as RawRow
      const key = typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY.trim() : ''
      if (key) {
        out.push({
          source: 'codex',
          suggest_id: 'codex-openai',
          name: t('Codex · OpenAI 官方通道', 'Codex · OpenAI official'),
          base_url: 'https://api.openai.com/v1',
          protocol: 'openai',
          auth_style: 'bearer',
          key,
          is_current: !doc?.model_provider || doc.model_provider === 'openai' || undefined,
        })
      }
    } catch {
      /* auth.json 损坏：静默忽略（官方通道凭据拿不到不算故障） */
    }
  }
  return out
}

/** cc-switch 导入源（~/.cc-switch/cc-switch.db，sqlite providers 表；claude/codex/gemini 三类行） */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { homeDir, isFile, slugify } from '../../util/index.js'
import { t } from '../../util/i18n.js'
import { collectModelEnvs, envBaseUrl, hostOf, isLocalBaseUrl, placeholder, type ImportCandidate, type RawRow } from './common.js'
import { codexDocCandidates, parseCodexTomlDoc } from './codex.js'

const exec = promisify(execFile)

/**
 * 读取 cc-switch 的 providers 表。
 * 优先用 Node 内置 node:sqlite（跨平台、Windows 无需外部 sqlite3 可执行文件）；
 * 不可用时（老版本 Node 需 --experimental-sqlite）回退到外部 sqlite3 CLI。
 * 返回 null 表示 node:sqlite 不可用，由调用方走外部 sqlite3 分支。
 */
async function readCcSwitchProviders(dbPath: string): Promise<RawRow[] | null> {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db.prepare('SELECT * FROM providers').all() as Array<Record<string, unknown>>
      return rows.map((r) => ({ ...r }))
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** cc-switch：providers 表里每个 provider 的 settings_config 是一份 Claude env 配置。
 *  v3 起同表多 app（app_type 列）：codex 行的 settings_config 是 {config: config.toml 全文, auth: {OPENAI_API_KEY}}，
 *  gemini 行是 {env: {...}, config: settings.json 对象}（cc-switch 仓库 codex_editor.rs / gemini_editor.rs 实析）。
 *  旧版无 app 列的行按 claude 处理（保持既有行为）。 */
export async function scanCcSwitch(): Promise<ImportCandidate[]> {
  const dbPath = path.join(homeDir(), '.cc-switch', 'cc-switch.db')
  if (!(await isFile(dbPath))) return []
  let rows: RawRow[]
  const nativeRows = await readCcSwitchProviders(dbPath)
  if (nativeRows !== null) {
    rows = nativeRows
  } else {
    try {
      const { stdout } = await exec('sqlite3', ['-json', dbPath, 'SELECT * FROM providers'], { maxBuffer: 16 * 1024 * 1024 })
      rows = JSON.parse(stdout)
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('ENOENT')) {
        return [{ ...placeholder('cc-switch', t('cc-switch.db 存在但系统无 sqlite3 命令，无法读取', 'cc-switch.db exists but the sqlite3 command is not installed; cannot read it')), skip_reason: t('无 sqlite3', 'sqlite3 missing') }]
      }
      return [{ ...placeholder('cc-switch', t('读取 cc-switch.db 失败：{msg}', 'Failed to read cc-switch.db: {msg}', { msg })), skip_reason: t('读取失败', 'read error') }]
    }
  }
  const out: ImportCandidate[] = []
  for (const row of rows) {
    const appType = String(row.app ?? row.app_type ?? '').toLowerCase()
    if (appType === 'codex') {
      out.push(...ccSwitchCodexRow(row))
      continue
    }
    if (appType === 'gemini') {
      const cand = ccSwitchGeminiRow(row)
      if (cand) out.push(cand)
      continue
    }
    if (appType && appType !== 'claude') continue // OpenClaw / Grok Build 等其他 app 不收编
    out.push(...ccSwitchClaudeRow(row))
  }
  return out
}

function ccSwitchRowName(row: RawRow, fallback: string): string {
  const name = row.name
  return typeof name === 'string' && name.trim() ? name.trim() : fallback
}

function ccSwitchClaudeRow(row: RawRow): ImportCandidate[] {
  const cfgText = row.settings_config ?? row.config ?? row.value
  if (typeof cfgText !== 'string') return []
  let cfg: any
  try {
    cfg = JSON.parse(cfgText)
  } catch {
    return []
  }
  const env = cfg?.env ?? cfg
  const base = env?.ANTHROPIC_BASE_URL
  if (typeof base !== 'string' || base === '') return []
  if (isLocalBaseUrl(base)) return [] // 代理占位，真实上游在其他 provider 行里
  const key =
    typeof env?.ANTHROPIC_AUTH_TOKEN === 'string'
      ? env.ANTHROPIC_AUTH_TOKEN
      : typeof env?.ANTHROPIC_API_KEY === 'string'
        ? env.ANTHROPIC_API_KEY
        : null
  const models = collectModelEnvs(env)
  const rowName = ccSwitchRowName(row, base)
  return [
    {
      source: 'cc-switch',
      suggest_id: slugify(rowName),
      name: rowName,
      base_url: base,
      protocol: 'anthropic',
      auth_style: 'bearer',
      key,
      models,
      is_current: row.is_current === 1 || row.is_current === true,
    },
  ]
}

/** cc-switch codex 行：settings_config.config 是「切到该供应商后 config.toml 的样子」（TOML 全文），
 *  auth.OPENAI_API_KEY 是该行供应商的 Key。config 里可能带多份 model_providers，逐条展开。
 *  导出供单测（node:sqlite 在部分 Node 上需要 flag，DB 整表扫描不好在 CI 直测）。 */
export function ccSwitchCodexRow(row: RawRow): ImportCandidate[] {
  const cfgText = row.settings_config ?? row.config ?? row.value
  if (typeof cfgText !== 'string') return []
  let cfg: any
  try {
    cfg = JSON.parse(cfgText)
  } catch {
    return []
  }
  const rowName = ccSwitchRowName(row, 'cc-switch codex')
  const doc = parseCodexTomlDoc(cfg?.config)
  if (!doc) {
    return [
      {
        ...placeholder('cc-switch', t('cc-switch 的 Codex 供应商「{name}」config 不是合法 TOML，无法读取', 'The cc-switch Codex provider "{name}" has an invalid TOML config; cannot read it', { name: rowName })),
        skip_reason: t('TOML 解析失败', 'TOML parse error'),
      },
    ]
  }
  const authKey = typeof cfg?.auth?.OPENAI_API_KEY === 'string' ? cfg.auth.OPENAI_API_KEY : ''
  return codexDocCandidates(doc, authKey, {
    source: 'cc-switch',
    idPrefix: `cc-switch-${slugify(rowName)}-codex`,
    displayName: (id) => `cc-switch · ${rowName} · ${id}`,
    isCurrent: row.is_current === 1 || row.is_current === true,
  })
}

/** cc-switch gemini 行：settings_config.env 存 GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL 等变量。导出供单测 */
export function ccSwitchGeminiRow(row: RawRow): ImportCandidate | null {
  const cfgText = row.settings_config ?? row.config ?? row.value
  if (typeof cfgText !== 'string') return null
  let cfg: any
  try {
    cfg = JSON.parse(cfgText)
  } catch {
    return null
  }
  const env = typeof cfg?.env === 'object' && cfg.env !== null ? cfg.env : {}
  const base = envBaseUrl(env)
  if (!base || isLocalBaseUrl(base)) return null
  const rowName = ccSwitchRowName(row, hostOf(base))
  return {
    source: 'cc-switch',
    suggest_id: `cc-switch-${slugify(rowName)}-gemini`,
    name: `cc-switch · ${rowName}（Gemini）`,
    base_url: base,
    protocol: 'openai',
    auth_style: 'bearer',
    key: typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY ? env.GEMINI_API_KEY : typeof env.GOOGLE_GEMINI_API_KEY === 'string' ? env.GOOGLE_GEMINI_API_KEY : null,
    is_current: row.is_current === 1 || row.is_current === true,
  }
}

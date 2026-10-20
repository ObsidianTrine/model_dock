import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { homeDir, isFile, readTextIfExists, slugify } from '../util/index.js'
import { credFile, dshLayout, providersOf } from '../adapters/dsh.js'
import { stripContextSuffix } from '../adapters/shared.js'
import { parseJsonTolerant } from '../adapters/format.js'
import { configCandidates as mimocodeConfigCandidates } from '../adapters/mimo-code.js'
import { modelsFileCandidates as workbuddyModelsFileCandidates } from '../adapters/workbuddy.js'
import { parse as tomlParse } from 'smol-toml'
import { parseDocument } from 'yaml'
import type { AuthStyle, Config, ModelMeta, Protocol } from '../config/types.js'
import { defaultStore, getSecret, setSecretsBatch } from '../config/secrets.js'
import { resolveModelMeta } from '../providers/resolve.js'
import { t } from '../util/i18n.js'

const exec = promisify(execFile)

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

function hostOf(url: string): string {
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

export interface ImportScanOptions {
  /** one-api / new-api 站点凭据：--from oneapi 时必填（渠道数据存在服务端，本机扫描拿不到） */
  oneapi?: { url: string; token: string }
}

export async function scanSources(source: ImportSource | 'all', opts: ImportScanOptions = {}): Promise<ImportCandidate[]> {
  const wanted = (s: ImportSource) => source === 'all' || source === s
  const out: ImportCandidate[] = []
  if (wanted('cc-switch')) out.push(...(await scanCcSwitch()))
  if (wanted('claude')) out.push(...(await scanClaude()))
  if (wanted('dsh')) out.push(...(await scanDsh()))
  if (wanted('zcode')) out.push(...(await scanZcode()))
  if (wanted('codex')) out.push(...(await scanCodex()))
  if (wanted('opencode')) out.push(...(await scanOpenCode()))
  if (wanted('mimocode')) out.push(...(await scanMimocode()))
  if (wanted('workbuddy')) out.push(...(await scanWorkbuddy()))
  if (wanted('ccr')) out.push(...(await scanCcr()))
  if (wanted('crush')) out.push(...(await scanCrush()))
  if (wanted('gemini')) out.push(...(await scanGemini()))
  if (source === 'oneapi') {
    // oneapi 需要站点凭据，不进 'all'（自动扫描拿不到），只走显式 --from oneapi
    if (!opts.oneapi) {
      throw new Error(
        t('one-api 渠道导入需要站点地址与管理令牌（--url / --token，令牌见 one-api「个人设置 → 系统访问令牌」）', 'one-api channel import needs the site URL and an admin token (--url / --token; token is under one-api "Personal settings → System access token")')
      )
    }
    out.push(...(await scanOneApi(opts.oneapi)))
  }
  return dedupeCandidates(out)
}

interface RawRow {
  [k: string]: unknown
}

async function firstExisting(files: string[]): Promise<string | null> {
  for (const p of files) {
    if (await isFile(p)) return p
  }
  return null
}

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
async function scanCcSwitch(): Promise<ImportCandidate[]> {
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

function collectModelEnvs(env: Record<string, unknown>): string[] {
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

async function scanClaude(): Promise<ImportCandidate[]> {
  const p = path.join(homeDir(), '.claude', 'settings.json')
  const text = await readTextIfExists(p)
  if (text === null) return []
  let env: Record<string, string> = {}
  try {
    env = (JSON.parse(text) as { env?: Record<string, string> }).env ?? {}
  } catch {
    return [placeholder('claude', t('settings.json 存在但解析失败（JSON 语法错误），无法读取', 'settings.json exists but failed to parse (JSON syntax error); cannot read it'))]
  }
  const base = env.ANTHROPIC_BASE_URL
  if (!base) return []
  if (isLocalBaseUrl(base)) {
    return [
      {
        source: 'claude',
        suggest_id: 'claude-current',
        name: t('Claude Code 当前指向（本地代理）', 'Claude Code current target (local proxy)'),
        base_url: base,
        protocol: 'anthropic',
        auth_style: 'bearer',
        key: null,
        skip_reason: t('指向本地代理，真实上游请从 cc-switch 导入', 'Points to a local proxy; import the real upstream from cc-switch'),
      },
    ]
  }
  return [
    {
      source: 'claude',
      suggest_id: 'claude-direct',
      name: t('Claude Code 当前直连上游', 'Claude Code current direct upstream'),
      base_url: base,
      protocol: 'anthropic',
      auth_style: 'bearer',
      key: env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? null,
      models: collectModelEnvs(env),
      is_current: true,
    },
  ]
}

async function scanDsh(): Promise<ImportCandidate[]> {
  // 两种布局：旧 ~/.dsh/settings.yaml，新版 profiles/<名称>/cordis.patch.yml（settings.yaml 被 dsh 迁移改名后即为后者）
  const layout = await dshLayout()
  const files: { file: string; kind: 'legacy' | 'patch' }[] = []
  if (layout.legacyExists) files.push({ file: layout.legacyFile, kind: 'legacy' })
  for (const f of layout.patchFiles) files.push({ file: f, kind: 'patch' })
  if (files.length === 0) return []

  const credsText = await readTextIfExists(credFile())
  let refs: Record<string, string> = {}
  if (credsText) {
    try {
      refs = (parseDocument(credsText).toJS() as any)?.refs ?? {}
    } catch {
      /* refs 读不到就只导入 url */
    }
  }
  const out: ImportCandidate[] = []
  const seen = new Set<string>()
  for (const { file, kind } of files) {
    let js: any
    try {
      js = parseDocument((await readTextIfExists(file)) ?? '').toJS()
    } catch {
      out.push(placeholder('dsh', t('{file} 存在但解析失败（YAML 语法错误），无法读取', '{file} exists but failed to parse (YAML syntax error); cannot read it', { file: path.basename(file) })))
      continue
    }
    const providers = providersOf(js, kind) ?? {}
    for (const [id, raw] of Object.entries<any>(providers)) {
      if (seen.has(id)) continue
      seen.add(id)
      const base = raw?.baseURL
      if (typeof base !== 'string' || base === '') continue
      if (isLocalBaseUrl(base)) continue // 已指向本地网关（如 modeldock attach 过），无需导入
      const protocol: Protocol = raw?.api === 'openai-completions' ? 'openai' : 'anthropic'
      const envName = typeof raw?.apiKeyEnv === 'string' ? raw.apiKeyEnv : undefined
      const key = envName ? (refs[envName] ?? null) : null
      out.push({
        source: 'dsh',
        suggest_id: `dsh-${slugify(id)}`,
        name: `dsh · ${id}`,
        base_url: base,
        protocol,
        auth_style: 'bearer',
        key,
        key_note: envName ? t('来自 .credentials.yaml refs.{env}', 'From .credentials.yaml refs.{env}', { env: envName }) : undefined,
        // 旧布局 models 为字符串数组；新布局为 {id, name, ...} 对象数组
        models: Array.isArray(raw?.models)
          ? raw.models
              .map((m: any) => (typeof m === 'string' ? m : typeof m?.id === 'string' ? m.id : null))
              .filter((x: any): x is string => typeof x === 'string')
          : undefined,
      })
    }
  }
  return out
}

async function scanZcode(): Promise<ImportCandidate[]> {
  const p = path.join(homeDir(), '.zcode', 'v2', 'config.json')
  const text = await readTextIfExists(p)
  if (text === null) return []
  let root: any
  try {
    root = JSON.parse(text)
  } catch {
    return [placeholder('zcode', t('config.json 存在但解析失败（JSON 语法错误），无法读取', 'config.json exists but failed to parse (JSON syntax error); cannot read it'))]
  }
  const out: ImportCandidate[] = []
  for (const [key, raw] of Object.entries<any>(root?.provider ?? {})) {
    const base = raw?.options?.baseURL ?? raw?.baseURL
    const apiKey = raw?.options?.apiKey ?? raw?.apiKey
    if (typeof base !== 'string' || base === '') continue
    if (isLocalBaseUrl(base)) continue
    if (typeof apiKey !== 'string' || apiKey === '') {
      out.push({
        source: 'zcode',
        suggest_id: `zcode-${slugify(key.replace(/^builtin:/, '').replace(/^preset:/, ''))}`,
        name: `ZCode · ${key}`,
        base_url: base,
        protocol: 'anthropic',
        auth_style: 'bearer',
        key: null,
        skip_reason: t('该 provider 没有 apiKey（可能是 oauth 登录态），ModelDock 无法收编', 'This provider has no apiKey (likely an OAuth login); ModelDock cannot import it'),
      })
      continue
    }
    out.push({
      source: 'zcode',
      suggest_id: `zcode-${slugify(key.replace(/^builtin:/, '').replace(/^preset:/, ''))}`,
      name: `ZCode · ${raw?.name ?? key}`,
      base_url: base,
      protocol: 'anthropic',
      auth_style: 'bearer',
      key: apiKey,
    })
  }
  return out
}

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

function parseCodexTomlDoc(text: unknown): CodexTomlDoc | null {
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
function codexDocCandidates(doc: CodexTomlDoc, builtinKey: string, opts: CodexCandidateOpts): ImportCandidate[] {
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

async function scanCodex(): Promise<ImportCandidate[]> {
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

async function scanProviderJson(source: 'opencode' | 'mimocode', files: string[], label: string, authReader?: () => Promise<Record<string, string>>): Promise<ImportCandidate[]> {
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

async function scanOpenCode(): Promise<ImportCandidate[]> {
  return scanProviderJson('opencode', [path.join(homeDir(), '.config', 'opencode', 'opencode.json')], 'OpenCode', readOpencodeAuth)
}

async function scanMimocode(): Promise<ImportCandidate[]> {
  return scanProviderJson('mimocode', mimocodeConfigCandidates(), 'MiMo Code')
}

/* ── WorkBuddy（models.json）─────────────────────────────────────────────────
 *  条目 url 是完整请求端点（如 https://api.deepseek.com/chat/completions），剥掉端点
 *  层转 base_url；同一上游多个模型条目合并成一个候选（models 聚合）。 */

async function scanWorkbuddy(): Promise<ImportCandidate[]> {
  const p = await firstExisting(workbuddyModelsFileCandidates())
  if (p === null) return []
  const text = await readTextIfExists(p)
  const parsed = parseJsonTolerant(text ?? '')
  if (!parsed) {
    return [placeholder('workbuddy', t('models.json 存在但解析失败（JSON 语法错误），无法读取', 'models.json exists but failed to parse (JSON syntax error); cannot read it'))]
  }
  const root = parsed.value as unknown
  const entries: RawRow[] = Array.isArray(root) ? root : Array.isArray((root as RawRow)?.models) ? ((root as RawRow).models as RawRow[]) : []
  const byUrl = new Map<string, ImportCandidate>()
  for (const e of entries) {
    const url = typeof e?.url === 'string' ? e.url.trim() : ''
    if (!url || isLocalBaseUrl(url)) continue // 指向本地网关（attach 过）的条目不收编
    const base = stripApiEndpoint(url)
    const norm = normalizeBaseUrl(base)
    const mid = typeof e?.id === 'string' && e.id ? e.id : ''
    const prev = byUrl.get(norm)
    if (prev) {
      if (mid && !prev.models?.includes(mid)) prev.models = [...(prev.models ?? []), mid]
      continue
    }
    byUrl.set(norm, {
      source: 'workbuddy',
      suggest_id: `workbuddy-${slugify(mid || hostOf(base))}`,
      name: `WorkBuddy · ${hostOf(base)}`,
      base_url: base,
      protocol: 'openai',
      auth_style: 'bearer',
      key: typeof e?.apiKey === 'string' && e.apiKey ? e.apiKey : null,
      models: mid ? [mid] : undefined,
    })
  }
  return [...byUrl.values()]
}

/* ── claude-code-router（~/.claude-code-router/config.json）─────────────────── */

async function scanCcr(): Promise<ImportCandidate[]> {
  const p = path.join(homeDir(), '.claude-code-router', 'config.json')
  const text = await readTextIfExists(p)
  if (text === null) return []
  const parsed = parseJsonTolerant(text)
  if (!parsed) {
    return [placeholder('ccr', t('config.json 存在但解析失败（JSON/JSONC 语法错误），无法读取', 'config.json exists but failed to parse (JSON/JSONC syntax error); cannot read it'))]
  }
  const root = parsed.value as { Providers?: RawRow[]; providers?: RawRow[]; Router?: Record<string, unknown> }
  const list = Array.isArray(root.Providers) ? root.Providers : Array.isArray(root.providers) ? root.providers : []
  const activeName = typeof root.Router?.default === 'string' ? root.Router.default.split(',')[0] : ''
  const out: ImportCandidate[] = []
  for (const prov of list) {
    const name = typeof prov.name === 'string' ? prov.name.trim() : ''
    const base = typeof prov.api_base_url === 'string' ? prov.api_base_url.trim() : ''
    if (!base || isLocalBaseUrl(base)) continue
    // 上游协议：URL 是 /v1/messages 或 transformer 声明 anthropic 才算 anthropic，其余按 openai chat 兼容
    const transformer = JSON.stringify(prov.transformer ?? '')
    const protocol: Protocol = /\/v1\/messages/i.test(base) || transformer.includes('anthropic') ? 'anthropic' : 'openai'
    out.push({
      source: 'ccr',
      suggest_id: `ccr-${slugify(name || hostOf(base))}`,
      name: `Claude Code Router · ${name || hostOf(base)}`,
      base_url: stripApiEndpoint(base),
      protocol,
      auth_style: 'bearer',
      key: typeof prov.api_key === 'string' && prov.api_key ? prov.api_key : null,
      models: Array.isArray(prov.models) ? prov.models.filter((m): m is string => typeof m === 'string') : undefined,
      is_current: !!name && activeName === name || undefined,
    })
  }
  return out
}

/* ── Crush（~/.config/crush/crush.json）───────────────────────────────────────
 *  providers 是对象 map，条目 {id,name,base_url,type,api_key,models:[{id}]}；type 决定
 *  上游协议（"openai"/"anthropic" 可直连，gemini/bedrock/vertex 等原生协议暂不支持）。
 *  Catwalk 内置渠道通常不写 base_url，直接跳过。 */

async function scanCrush(): Promise<ImportCandidate[]> {
  const p = path.join(homeDir(), '.config', 'crush', 'crush.json')
  const text = await readTextIfExists(p)
  if (text === null) return []
  const parsed = parseJsonTolerant(text)
  if (!parsed) {
    return [placeholder('crush', t('crush.json 存在但解析失败（JSON/JSONC 语法错误），无法读取', 'crush.json exists but failed to parse (JSON/JSONC syntax error); cannot read it'))]
  }
  const providers = (parsed.value as { providers?: Record<string, RawRow> }).providers
  const out: ImportCandidate[] = []
  for (const [id, prov] of Object.entries(providers ?? {})) {
    const base = typeof prov?.base_url === 'string' ? prov.base_url.trim() : ''
    if (!base || isLocalBaseUrl(base)) continue
    const type = typeof prov.type === 'string' ? prov.type : 'openai'
    const protocol: Protocol | null = type === 'openai' ? 'openai' : type === 'anthropic' ? 'anthropic' : null
    if (!protocol) {
      out.push({
        ...placeholder('crush', t('Crush 渠道「{id}」的上游类型 {type} 走非 OpenAI/Anthropic 兼容协议，暂不支持导入', 'The Crush provider "{id}" uses upstream type {type}, which is not OpenAI/Anthropic-compatible; import is not supported yet', { id, type })),
        suggest_id: `crush-${slugify(id)}`,
        name: `Crush · ${typeof prov.name === 'string' && prov.name ? prov.name : id}`,
        skip_reason: t('协议不支持', 'unsupported protocol'),
      })
      continue
    }
    const models = Array.isArray(prov.models)
      ? prov.models.map((m: unknown) => (typeof m === 'object' && m !== null && typeof (m as RawRow).id === 'string' ? (m as RawRow).id as string : typeof m === 'string' ? m : '')).filter(Boolean)
      : []
    out.push({
      source: 'crush',
      suggest_id: `crush-${slugify(id)}`,
      name: `Crush · ${typeof prov.name === 'string' && prov.name ? prov.name : id}`,
      base_url: stripApiEndpoint(base),
      protocol,
      auth_style: 'bearer',
      key: typeof prov.api_key === 'string' && prov.api_key ? prov.api_key : null,
      models: models.length > 0 ? models : undefined,
    })
  }
  return out
}

/* ── Gemini CLI 第三方中转（~/.gemini/.env）───────────────────────────────────
 *  官方 Google 登录不写中转变量、没有可收编的候选；配了 GOOGLE_GEMINI_BASE_URL 的
 *  一定是第三方中转站，这类站点几乎都同时提供 OpenAI 兼容端点，故按 openai 协议导入
 *  （Gemini 原生协议 ModelDock 不支持）。仅 shell 环境变量的场景也兜底读取。 */

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const m = s.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

/** gemini 中转 base_url：settings 与 cc-switch gemini 行共用 */
function envBaseUrl(env: Record<string, unknown>): string {
  const v = env.GOOGLE_GEMINI_BASE_URL ?? env.GEMINI_BASE_URL
  return typeof v === 'string' ? v.trim() : ''
}

function envApiKey(env: Record<string, unknown>): string | null {
  const v = env.GEMINI_API_KEY ?? env.GOOGLE_GEMINI_API_KEY
  return typeof v === 'string' && v ? v : null
}

async function scanGemini(): Promise<ImportCandidate[]> {
  const envText = await readTextIfExists(path.join(homeDir(), '.gemini', '.env'))
  const env = { ...parseDotEnv(envText ?? ''), ...(process.env as Record<string, string>) }
  const base = envBaseUrl(env)
  if (!base || isLocalBaseUrl(base)) return []
  const host = hostOf(base)
  return [
    {
      source: 'gemini',
      suggest_id: `gemini-${slugify(host)}`,
      name: `Gemini CLI · ${host}`,
      base_url: stripApiEndpoint(base),
      protocol: 'openai',
      auth_style: 'bearer',
      key: envApiKey(env),
      key_note: t('来自 ~/.gemini/.env（Gemini CLI 中转配置）', 'From ~/.gemini/.env (Gemini CLI relay config)'),
      is_current: true,
    },
  ]
}

/* ── one-api / new-api 渠道（管理 API 拉取）───────────────────────────────────
 *  渠道数据在服务端数据库，本机自动检测拿不到；走管理 API：GET /api/channel/?p=N，
 *  鉴权为「个人设置 → 系统访问令牌」（Authorization 原样携带，one-api auth.go 实析）。
 *  只导入 OpenAI 兼容 / Anthropic 类型；Azure、Gemini 原生、Bedrock 等协议 ModelDock
 *  无法直连，跳过并注明。base_url 为空（官方直连渠道）时按类型映射官方端点，无映射跳过。 */

export interface OneApiImportSource {
  url: string
  token: string
}

/** one-api 渠道 type → ModelDock 协议。14=Anthropic；其余为 OpenAI 兼容生态（one-api
 *  relay/channeltype/define.go iota 序号，原生 Gemini/Azure/Bedrock 等不在列）。 */
const ONEAPI_TYPE_ANTHROPIC = new Set([14])
const ONEAPI_TYPE_OPENAI = new Set([1, 2, 4, 5, 6, 7, 8, 9, 10, 12, 13, 16, 17, 19, 20, 21, 22, 25, 26, 27, 28, 29, 30, 31, 32, 36, 37, 39, 40, 41, 44, 45, 50, 51])

/** 常见类型未填 base_url 时的官方端点（openai 形态 base，可带 /v1 也可以不带） */
const ONEAPI_TYPE_OFFICIAL_BASE: Record<number, string> = {
  1: 'https://api.openai.com/v1',
  14: 'https://api.anthropic.com',
  16: 'https://open.bigmodel.cn/api/paas/v4',
  17: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  20: 'https://openrouter.ai/api/v1',
  25: 'https://api.moonshot.cn/v1',
  28: 'https://api.mistral.ai/v1',
  29: 'https://api.groq.com/openai/v1',
  36: 'https://api.deepseek.com/v1',
  39: 'https://api.together.xyz/v1',
  40: 'https://ark.cn-beijing.volces.com/api/v3',
  41: 'https://api.novita.ai/v3/openai',
  44: 'https://api.siliconflow.cn/v1',
  45: 'https://api.x.ai/v1',
}

/** one-api 渠道行 → 导入候选；不支持的类型/缺信息返回带 skip_reason 的占位（供用户看原因） */
export function oneApiChannelToCandidate(ch: RawRow): ImportCandidate {
  const type = Number(ch.type ?? 0)
  const name = typeof ch.name === 'string' && ch.name.trim() ? ch.name.trim() : `channel-${ch.id ?? '?'}`
  const base = (typeof ch.base_url === 'string' && ch.base_url.trim()) || ONEAPI_TYPE_OFFICIAL_BASE[type] || ''
  const key = typeof ch.key === 'string' ? ch.key.trim() : ''
  const source: ImportSource = 'oneapi'
  const disabled = Number(ch.status ?? 1) !== 1
  if (disabled) {
    return { ...emptyOneApiCandidate(name), skip_reason: t('渠道已停用', 'Channel is disabled') }
  }
  const protocol: Protocol | null = ONEAPI_TYPE_ANTHROPIC.has(type) ? 'anthropic' : ONEAPI_TYPE_OPENAI.has(type) ? 'openai' : null
  if (!protocol) {
    return { ...emptyOneApiCandidate(name), skip_reason: t('渠道类型 {type} 走非 OpenAI/Anthropic 兼容上游，暂不支持导入', 'Channel type {type} uses a non-OpenAI/Anthropic-compatible upstream; import is not supported yet', { type }) }
  }
  if (!base) {
    return { ...emptyOneApiCandidate(name), skip_reason: t('渠道未填 base_url 且类型 {type} 无官方端点映射，请手动添加', 'The channel has no base_url and type {type} has no official endpoint mapping; add it manually', { type }) }
  }
  if (!key) {
    return { ...emptyOneApiCandidate(name), skip_reason: t('渠道未填 Key', 'The channel has no key') }
  }
  const models = String(ch.models ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
  return {
    source,
    suggest_id: `oneapi-${slugify(name)}`,
    name: `one-api · ${name}`,
    base_url: stripApiEndpoint(base),
    protocol,
    auth_style: 'bearer',
    key,
    models: models.length > 0 ? models : undefined,
    is_current: false,
  }
}

function emptyOneApiCandidate(name: string): ImportCandidate {
  return {
    source: 'oneapi',
    suggest_id: `oneapi-${slugify(name)}`,
    name: `one-api · ${name}`,
    base_url: '',
    protocol: 'openai',
    auth_style: 'bearer',
    key: null,
  }
}

export async function scanOneApi(src: OneApiImportSource): Promise<ImportCandidate[]> {
  const root = src.url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(root)) {
    throw new Error(t('one-api 地址必须以 http:// 或 https:// 开头', 'The one-api URL must start with http:// or https://'))
  }
  const token = src.token.trim().replace(/^Bearer\s+/i, '')
  if (!token) {
    throw new Error(t('管理令牌不能为空（one-api「个人设置 → 系统访问令牌」）', 'The admin token cannot be empty (one-api "Personal settings → System access token")'))
  }
  // one-api 原版按固定页大小分页（忽略 page_size），循环翻到空页为止；new-api 沿用同路由。
  // 60s 整体 deadline：50 页×15s 串行最坏 ~12min，deadline 到点抛可操作报错而不是无限拖
  const deadline = Date.now() + 60_000
  const rows: RawRow[] = []
  for (let page = 0; page < 50; page++) {
    const remaining = deadline - Date.now()
    if (remaining < 1_000) {
      throw new Error(t('one-api 拉取超时（整体超过 60 秒，站点过慢或渠道过多）', 'one-api pagination timed out (over 60s total; site too slow or too many channels)'))
    }
    let res: Response
    try {
      res = await fetch(`${root}/api/channel/?p=${page}&page_size=100`, {
        headers: { Authorization: token },
        signal: AbortSignal.timeout(Math.min(15_000, remaining)),
      })
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? t('请求超时', 'request timed out') : (e as Error).message
      throw new Error(t('无法访问 one-api 站点（{url}）：{msg}。请确认地址可达、站点为 one-api / new-api', 'Cannot reach the one-api site ({url}): {msg}. Check that the URL is reachable and the site is one-api / new-api', { url: root, msg }))
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(t('令牌无效或无管理员权限（HTTP {status}）。请在 one-api「个人设置」生成系统访问令牌后重试', 'The token is invalid or lacks admin rights (HTTP {status}). Generate a system access token under one-api "Personal settings" and retry', { status: res.status }))
    }
    if (!res.ok) {
      throw new Error(t('拉取渠道失败：HTTP {status}。请确认这是 one-api / new-api 站点', 'Failed to fetch channels: HTTP {status}. Confirm this is a one-api / new-api site', { status: res.status }))
    }
    let body: { success?: unknown; message?: unknown; data?: unknown }
    try {
      body = (await res.json()) as typeof body
    } catch {
      throw new Error(t('返回内容不是 JSON——该地址可能不是 one-api / new-api 站点', 'The response is not JSON — the URL may not be a one-api / new-api site'))
    }
    if (body.success === false) {
      throw new Error(t('one-api 返回错误：{msg}', 'one-api returned an error: {msg}', { msg: String(body.message ?? '') }))
    }
    const data = Array.isArray(body.data) ? (body.data as RawRow[]) : []
    if (data.length === 0) break
    rows.push(...data)
  }
  return rows.map(oneApiChannelToCandidate)
}

function placeholder(source: ImportSource, note: string): ImportCandidate {
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

export interface ImportReport {
  providers: string[]
  profiles: string[]
  skipped: { id: string; reason: string }[]
}

/** 导入候选 → providers（key 存入 secret store）+ 可选 profiles；只读不写原文件。
 *  兜底去重：地址已存在（或本批已导入过）的候选一律跳过并注明原因。 */
export async function applyImport(
  cfg: Config,
  cands: ImportCandidate[],
  opts: { withProfiles: boolean }
): Promise<ImportReport> {
  const report: ImportReport = { providers: [], profiles: [], skipped: [] }
  // 现有服务按归一化地址索引（key 仅在 URL 命中时才解析，避免大表全量 getSecret）
  const existingByUrl = new Map<string, { pid: string; key?: string }[]>()
  for (const [pid, p] of Object.entries(cfg.providers)) {
    const norm = normalizeBaseUrl(p.base_url)
    const arr = existingByUrl.get(norm) ?? []
    arr.push({ pid })
    existingByUrl.set(norm, arr)
  }
  const backend = cfg.security?.store ?? (await defaultStore())
  /** 现有同 URL 服务里是否有同一 key？有则返回其 pid（视为重复）。 */
  const findByKey = async (list: { pid: string; key?: string }[], key: string): Promise<string | null> => {
    for (const e of list) {
      if (e.key === undefined) {
        const ref = cfg.providers[e.pid]?.key_ref
        e.key = ref ? (await getSecret(ref)) ?? '' : ''
      }
      if (e.key === key) return e.pid
    }
    return null
  }

  // ① 先算好每个候选的 id 与是否要写 key（不立即写盘）
  //    检测层已按「归一化地址」去重（保留使用中）；这里再按地址+key 精确判断与已有服务的重复并跳过
  const addedByPair = new Map<string, string>()
  const meta: { id: string; cand: ImportCandidate }[] = []
  const keyBatch: Record<string, string> = {}
  for (const cand of cands) {
    if (cand.skip_reason || !cand.base_url) {
      report.skipped.push({ id: cand.suggest_id, reason: cand.skip_reason ?? t('无 base_url', 'no base_url') })
      continue
    }
    const norm = normalizeBaseUrl(cand.base_url)
    const candKey = cand.key ?? ''
    const pair = `${norm}\u0000${candKey}`
    const existing = existingByUrl.get(norm)
    const dupOf = existing ? await findByKey(existing, candKey) : null
    if (dupOf) {
      report.skipped.push({ id: cand.suggest_id, reason: t('与已有服务「{name}」地址相同且 Key 相同，已跳过', 'Same base URL and key as existing service "{name}"; skipped', { name: dupOf }) })
      continue
    }
    const addedDup = addedByPair.get(pair)
    if (addedDup) {
      report.skipped.push({ id: cand.suggest_id, reason: t('本批已导入「{name}」（同地址同 Key），已跳过', 'Already imported in this batch as "{name}" (same base URL and key); skipped', { name: addedDup }) })
      continue
    }
    let id = cand.suggest_id || slugify(cand.name || cand.base_url)
    let n = 2
    while (cfg.providers[id]) id = `${cand.suggest_id}-${n++}`
    addedByPair.set(pair, id)
    meta.push({ id, cand })
    if (cand.key) keyBatch[id] = cand.key
  }

  // ② 批量写入全部 key（file/dpapi 一次整表写盘，避免逐 key 重写）
  const refs = Object.keys(keyBatch).length > 0 ? await setSecretsBatch(keyBatch, backend) : {}

  // ③ 落 provider / profile
  for (const { id, cand } of meta) {
    const keyRef = refs[id] ?? `env:${envHint(cand)}` // 无 key 时沿用 env 引用占位
    cfg.providers[id] = {
      name: cand.name,
      base_url: normalizeBaseUrl(cand.base_url),
      protocol: cand.protocol,
      auth_style: cand.auth_style,
      key_ref: keyRef,
      models: toMeta(cand.models),
    }
    report.providers.push(id)
    if (opts.withProfiles && !cfg.profiles[id]) {
      cfg.profiles[id] = { name: cand.name, provider: id, default_model: cand.models?.[0] }
      report.profiles.push(id)
    }
    if (cand.is_current && !cfg.active_profile) cfg.active_profile = id
  }
  return report
}

function envHint(cand: ImportCandidate): string {
  return `${cand.suggest_id.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

function toMeta(models: string[] | undefined): Record<string, ModelMeta> | undefined {
  if (!models?.length) return undefined
  const out: Record<string, ModelMeta> = {}
  for (const id of models) {
    const known = resolveModelMeta(id)
    out[id] = known
      ? { source: 'manual', context_window: known.context_window, max_output: known.max_output }
      : { source: 'manual' }
  }
  return out
}

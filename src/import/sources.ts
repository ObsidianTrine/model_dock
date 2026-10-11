import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { homeDir, readTextIfExists, slugify } from '../util/index.js'
import { dshLayout } from '../adapters/dsh.js'
import { parseDocument } from 'yaml'
import type { AuthStyle, Config, ModelMeta, Protocol } from '../config/types.js'
import { defaultStore, getSecret, setSecretsBatch } from '../config/secrets.js'
import { resolveModelMeta } from '../providers/resolve.js'
import { t } from '../util/i18n.js'

const exec = promisify(execFile)

export type ImportSource = 'cc-switch' | 'claude' | 'dsh' | 'zcode'

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

/** 迁移导入按「地址」去重：同一地址（尾斜杠/大小写归一化）视为同一个服务，优先保留「使用中」的那个。
 *  注意：这里刻意忽略 Key——迁移时同地址往往是一份配置的多个历史/备份 key，只导入使用中的即可，避免重复服务；
 *  真正的多账号请在导入后通过「添加服务」分别登记。
 *  带 skip_reason 的占位项（base_url 为空的诊断信息，如"无 sqlite3"）不去重、不丢弃。 */
export function dedupeCandidates(cands: ImportCandidate[]): ImportCandidate[] {
  const by = new Map<string, ImportCandidate>()
  const diagnostics: ImportCandidate[] = []
  for (const c of cands) {
    if (!c.base_url) {
      if (c.skip_reason) diagnostics.push(c)
      continue
    }
    const key = normalizeBaseUrl(c.base_url)
    const prev = by.get(key)
    if (!prev || (!prev.is_current && c.is_current)) by.set(key, c)
  }
  return [...by.values(), ...diagnostics]
}

export async function scanSources(source: ImportSource | 'all'): Promise<ImportCandidate[]> {
  const wanted = (s: ImportSource) => source === 'all' || source === s
  const out: ImportCandidate[] = []
  if (wanted('cc-switch')) out.push(...(await scanCcSwitch()))
  if (wanted('claude')) out.push(...(await scanClaude()))
  if (wanted('dsh')) out.push(...(await scanDsh()))
  if (wanted('zcode')) out.push(...(await scanZcode()))
  return dedupeCandidates(out)
}

interface RawRow {
  [k: string]: unknown
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

/** cc-switch：providers 表里每个 provider 的 settings_config 是一份 Claude env 配置 */
async function scanCcSwitch(): Promise<ImportCandidate[]> {
  const dbPath = path.join(homeDir(), '.cc-switch', 'cc-switch.db')
  if (!(await fileExists(dbPath))) return []
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
    const app = String(row.app ?? row.app_type ?? row.category ?? '')
    const cfgText = row.settings_config ?? row.config ?? row.value
    if (typeof cfgText !== 'string') continue
    let cfg: any
    try {
      cfg = JSON.parse(cfgText)
    } catch {
      continue
    }
    const env = cfg?.env ?? cfg
    const base = env?.ANTHROPIC_BASE_URL
    if (typeof base !== 'string' || base === '') continue
    if (isLocalBaseUrl(base)) continue // 代理占位，真实上游在其他 provider 行里
    const key =
      typeof env?.ANTHROPIC_AUTH_TOKEN === 'string'
        ? env.ANTHROPIC_AUTH_TOKEN
        : typeof env?.ANTHROPIC_API_KEY === 'string'
          ? env.ANTHROPIC_API_KEY
          : null
    const models = collectModelEnvs(env)
    out.push({
      source: 'cc-switch',
      suggest_id: slugify(String(row.name ?? base)),
      name: String(row.name ?? 'cc-switch provider'),
      base_url: base,
      protocol: 'anthropic',
      auth_style: 'bearer',
      key,
      models,
      is_current: row.is_current === 1 || row.is_current === true,
    })
  }
  return out
}

function collectModelEnvs(env: Record<string, unknown>): string[] {
  const out = new Set<string>()
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v !== 'string' || v === '') continue
    if (k === 'ANTHROPIC_MODEL' || k.startsWith('ANTHROPIC_DEFAULT_')) {
      // 去掉 [1M] 等上下文变体后缀：那是请求参数标记，不是独立模型 id
      const base = v.replace(/\[\d+[MmKk]\]$/, '').trim()
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

  const credsText = await readTextIfExists(path.join(layout.home, '.credentials.yaml'))
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
    const providers =
      (kind === 'legacy'
        ? js?.['llm-pi-ai']?.providers
        : Array.isArray(js)
          ? (js as any[]).find((e) => e?.id === 'llm-pi-ai')?.config?.providers
          : undefined) ?? {}
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

async function fileExists(p: string): Promise<boolean> {
  try {
    await (await import('node:fs/promises')).access(p)
    return true
  } catch {
    return false
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

/** 清洗模型 id：去掉 [1M] 等上下文变体后缀并去重（存量数据修复用） */
export function normalizeModelIds(models: Record<string, ModelMeta>): Record<string, ModelMeta> {
  const out: Record<string, ModelMeta> = {}
  for (const [mid, meta] of Object.entries(models)) {
    const base = mid.replace(/\[\d+[MmKk]\]$/, '').trim()
    if (!base) continue
    const prev = out[base]
    // 变体与基名合并时，保留元数据更全的那份
    if (!prev || (prev.context_window === undefined && meta.context_window !== undefined)) {
      out[base] = prev ? { ...meta, display_name: meta.display_name ?? prev.display_name } : meta
    }
  }
  return out
}

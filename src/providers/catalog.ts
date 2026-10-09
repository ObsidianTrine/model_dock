import fs from 'node:fs'
import { atomicWrite } from '../util/fsx.js'
import { t } from '../util/i18n.js'
import { modelCatalogCachePath } from '../util/paths.js'
import { saneContextWindow, saneMaxOutput } from './known.js'
import { CATALOG_SNAPSHOT, CATALOG_SNAPSHOT_FETCHED_AT } from './catalog-snapshot.generated.js'

/**
 * 模型元数据远程目录（数据源 models.dev 社区数据库，226 家厂商 / 八千余模型，含 context/output 上限）。
 *
 * 三层来源，新的盖旧的：构建期捆绑快照（离线开箱可用）≤ 本地缓存（refreshCatalog 拉取结果，TTL 7 天）。
 * 目录只做「填空」的最低优先级来源（用户手填 > 上游返回 > 内置表 > 本目录，见 resolve.ts），
 * 拉取失败静默保留旧缓存，绝不影响网关服务——与节假日日历（holidays.ts）同一套约束。
 */

export interface CatalogEntry {
  context_window?: number
  max_output?: number
}

export interface CatalogData {
  fetchedAt: string
  /** 键 = models.dev provider id；api = 该厂商 API 根地址（按 host 精确匹配用，可能缺省） */
  providers: Record<string, { api?: string | null; models: Record<string, CatalogEntry> }>
}

export interface CatalogRefreshResult {
  ok: boolean
  providers: number
  models: number
  fetchedAt: string
  /** 未拉取原因：disabled=环境开关停用；fresh=缓存仍在新鲜期内 */
  skipped?: 'disabled' | 'fresh'
  error?: string
}

const DEFAULT_CATALOG_URL = 'https://models.dev/api.json'
const FETCH_TIMEOUT_MS = 20_000
const MAX_BODY_BYTES = 30 * 1024 * 1024
/** 缓存新鲜期：期内自动刷新直接跳过（手动刷新不受限） */
const FRESH_TTL_MS = 7 * 24 * 3600_000

/** 目录数据源；可用环境变量换镜像 */
export function catalogUrl(): string {
  return (process.env.MODELRDOCK_CATALOG_URL ?? '').trim() || DEFAULT_CATALOG_URL
}

/** models.dev api.json → 归一化目录：只留通过边界校验的 limit.context / limit.output，空厂商丢弃 */
export function normalizeApiCatalog(raw: unknown, fetchedAt: string): CatalogData {
  const out: CatalogData = { fetchedAt, providers: {} }
  if (typeof raw !== 'object' || raw === null) return out
  for (const [pk, pv] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof pv !== 'object' || pv === null) continue
    const pvRec = pv as Record<string, unknown>
    const modelsRaw = pvRec.models
    if (typeof modelsRaw !== 'object' || modelsRaw === null) continue
    const models: Record<string, CatalogEntry> = {}
    for (const [id, mv] of Object.entries(modelsRaw as Record<string, unknown>)) {
      if (typeof mv !== 'object' || mv === null) continue
      const limit = (mv as Record<string, unknown>).limit
      if (typeof limit !== 'object' || limit === null) continue
      const lim = limit as Record<string, unknown>
      const ctx = saneContextWindow(lim.context)
      const mo = saneMaxOutput(lim.output)
      if (ctx === undefined && mo === undefined) continue
      const entry: CatalogEntry = {}
      if (ctx !== undefined) entry.context_window = ctx
      if (mo !== undefined) entry.max_output = mo
      models[id] = entry
    }
    if (Object.keys(models).length === 0) continue
    out.providers[pk] = { api: typeof pvRec.api === 'string' && pvRec.api ? pvRec.api : null, models }
  }
  return out
}

// 缓存读取按 mtime 做进程内 memo：解析一次 400KB+ 的目录 JSON 不便宜，
// 而 resolveModelMeta 在展示 / 编辑 / 适配器写配置的多条路径上被高频调用
let cacheMemo: { path: string; mtimeMs: number; data: CatalogData | undefined } | undefined

/** 读取本地目录缓存（损坏 / 缺失视为无缓存）；供测试与刷新后失效 memo */
export function readCatalogCache(): CatalogData | undefined {
  const p = modelCatalogCachePath()
  let st: fs.Stats
  try {
    st = fs.statSync(p)
  } catch {
    cacheMemo = undefined
    return undefined
  }
  if (cacheMemo && cacheMemo.path === p && cacheMemo.mtimeMs === st.mtimeMs) return cacheMemo.data
  let data: CatalogData | undefined
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    if (j && typeof j === 'object' && j.providers && typeof j.providers === 'object') {
      data = { fetchedAt: typeof j.fetchedAt === 'string' ? j.fetchedAt : '', providers: j.providers as CatalogData['providers'] }
    }
  } catch {
    data = undefined
  }
  cacheMemo = { path: p, mtimeMs: st.mtimeMs, data }
  return data
}

export function clearCatalogMemo(): void {
  cacheMemo = undefined
}

function catalogBase(): CatalogData {
  const cache = readCatalogCache()
  if (!cache || Object.keys(cache.providers).length === 0) return CATALOG_SNAPSHOT
  return { fetchedAt: cache.fetchedAt || CATALOG_SNAPSHOT_FETCHED_AT, providers: { ...CATALOG_SNAPSHOT.providers, ...cache.providers } }
}

function hostOf(u: string | null | undefined): string {
  if (!u) return ''
  try {
    return new URL(u).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 在目录里查模型元数据：优先 api 字段 host 与 baseUrl 匹配的厂商（同 id 不同厂商限额可能不同）；
 * 无 baseUrl / 无命中时按 provider 键字母序取首个命中——确定性优先，测试可断言。
 */
export function catalogModelMeta(id: string, baseUrl?: string): CatalogEntry | undefined {
  if (!id) return undefined
  const cat = catalogBase()
  const host = hostOf(baseUrl)
  if (host) {
    for (const p of Object.values(cat.providers)) {
      if (hostOf(p.api) === host) {
        const e = p.models[id]
        if (e) return e
      }
    }
  }
  for (const k of Object.keys(cat.providers).sort()) {
    const e = cat.providers[k].models[id]
    if (e) return e
  }
  return undefined
}

/** 目录的扁平 id 索引（字母序遍历、首见优先），供 knownModels 合并表 / 前端自动补值 */
export function catalogFlatTable(): Record<string, CatalogEntry> {
  const cat = catalogBase()
  const out: Record<string, CatalogEntry> = {}
  for (const k of Object.keys(cat.providers).sort()) {
    for (const [id, e] of Object.entries(cat.providers[k].models)) {
      if (!out[id]) out[id] = e
    }
  }
  return out
}

export function catalogCacheFresh(): boolean {
  const c = readCatalogCache()
  if (!c?.fetchedAt) return false
  const ts = Date.parse(c.fetchedAt)
  return Number.isFinite(ts) && Date.now() - ts < FRESH_TTL_MS
}

/**
 * 拉取 models.dev 目录并写缓存（写盘即生效）。manual=false 的自动刷新在缓存新鲜期内跳过；
 * MODELRDOCK_DISABLE_CATALOG_FETCH=1 停用（测试 / 离线环境）。失败返回 error，不抛出——
 * 调用方（网关启动定时器）fire-and-forget，绝不能让目录问题影响网关。
 */
export async function refreshCatalog(opts?: { manual?: boolean }): Promise<CatalogRefreshResult> {
  const empty = { providers: 0, models: 0, fetchedAt: readCatalogCache()?.fetchedAt ?? '' }
  if (process.env.MODELRDOCK_DISABLE_CATALOG_FETCH === '1') {
    return { ...empty, ok: false, skipped: 'disabled' }
  }
  if (opts?.manual !== true && catalogCacheFresh()) {
    return { ...empty, ok: false, skipped: 'fresh' }
  }
  try {
    const res = await fetch(catalogUrl(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const len = Number(res.headers.get('content-length') ?? 0)
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      throw new Error(t('响应体异常偏大（{len} 字节）', 'Response body abnormally large ({len} bytes)', { len }))
    }
    const data = normalizeApiCatalog(JSON.parse(await res.text()), new Date().toISOString())
    const providers = Object.keys(data.providers).length
    if (providers === 0) throw new Error(t('目录内容为空', 'Catalog is empty'))
    const models = Object.values(data.providers).reduce((s, p) => s + Object.keys(p.models).length, 0)
    await atomicWrite(modelCatalogCachePath(), JSON.stringify(data), 0o600)
    clearCatalogMemo()
    return { ok: true, providers, models, fetchedAt: data.fetchedAt }
  } catch (e) {
    return { ...empty, ok: false, error: (e as Error).message }
  }
}

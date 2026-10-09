import { expandHome, homeDir } from '../util/index.js'

export interface CatalogModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

/** route（provider）→ 模型 id → 权威元数据 */
export type DshCatalog = Map<string, Map<string, CatalogModel>>

export interface DshCatalogResult {
  catalog: DshCatalog
  source: string
}

let cache: DshCatalogResult | null | undefined

/**
 * 从本机 dsh 安装（@earendil-works/pi-ai 的 models.generated.js）读取内置模型 catalog。
 * 找不到 dsh 安装时返回 null——调用方只用 ModelDock 自身元数据。
 */
export async function loadDshCatalog(): Promise<DshCatalogResult | null> {
  if (cache !== undefined) return cache
  cache = await probe()
  return cache
}

export function clearDshCatalogCache(): void {
  cache = undefined
}

async function probe(): Promise<DshCatalogResult | null> {
  const candidates: string[] = []
  if (process.env.MODELRDOCK_DSH_CATALOG) candidates.push(expandHome(process.env.MODELRDOCK_DSH_CATALOG))
  // npx 缓存里的 @earendil-works/pi-ai（dsh 经 npx 运行时的依赖）
  try {
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    // 经 homeDir()：MODELRDOCK_FAKE_HOME 下随之隔离，不读宿主机真实 npx 缓存
    const npxDir = path.join(homeDir(), '.npm', '_npx')
    const entries = await fsp.readdir(npxDir).catch(() => [] as string[])
    for (const e of entries) {
      candidates.push(
        path.join(npxDir, e, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'models.generated.js')
      )
    }
  } catch {
    /* npx 目录不可读就跳过 */
  }
  for (const file of candidates) {
    const parsed = await tryLoad(file)
    if (parsed) return parsed
  }
  return null
}

async function tryLoad(file: string): Promise<DshCatalogResult | null> {
  try {
    const { pathToFileURL } = await import('node:url')
    const mod: any = await import(pathToFileURL(file).href)
    const MODELS = mod.MODELS
    if (!MODELS || typeof MODELS !== 'object') return null
    const catalog: DshCatalog = new Map()
    for (const [route, models] of Object.entries<any>(MODELS)) {
      const byId = new Map<string, CatalogModel>()
      for (const [mid, m] of Object.entries<any>(models ?? {})) {
        if (!m || typeof m !== 'object') continue
        byId.set(mid, {
          id: mid,
          name: typeof m.name === 'string' ? m.name : undefined,
          contextWindow: Number.isInteger(m.contextWindow) ? m.contextWindow : undefined,
          maxTokens: Number.isInteger(m.maxTokens) ? m.maxTokens : undefined,
        })
      }
      if (byId.size > 0) catalog.set(route, byId)
    }
    if (catalog.size === 0) return null
    return { catalog, source: file }
  } catch {
    return null
  }
}

/** 按 route 查模型；route 未命中时返回空 map */
export function catalogForRoute(catalog: DshCatalog, route: string): Map<string, CatalogModel> {
  return catalog.get(route) ?? new Map()
}

/** 跨全部 route 按模型 id 查找（同名 id 以先出现者为准） */
export function catalogLookupById(catalog: DshCatalog, modelId: string): CatalogModel | null {
  for (const byId of catalog.values()) {
    const hit = byId.get(modelId)
    if (hit) return hit
  }
  return null
}

#!/usr/bin/env node
// 生成 src/providers/catalog-snapshot.generated.ts：models.dev 社区模型目录的捆绑快照
// （SEA 离线开箱可用的目录兜底层，运行时刷新的本地缓存盖过它）。
// 用法：node scripts/gen-catalog-snapshot.mjs [本地 api.json 路径]
//   缺省在线拉取 https://models.dev/api.json（可设 MODELRDOCK_CATALOG_URL 换源）。
// 生成后提交入库；过滤逻辑与 src/providers/catalog.ts 的 normalizeApiCatalog 保持一致。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, 'src', 'providers', 'catalog-snapshot.generated.ts')
const url = (process.env.MODELRDOCK_CATALOG_URL || 'https://models.dev/api.json').trim()
const src = process.argv[2]

const raw = src
  ? fs.readFileSync(src, 'utf8')
  : await (await fetch(url, { signal: AbortSignal.timeout(60_000) })).text()
const data = JSON.parse(raw)

const ctxOk = (v) => Number.isInteger(v) && v >= 1024 && v <= 16_777_216
const outOk = (v) => Number.isInteger(v) && v >= 256 && v <= 16_777_216

const providers = {}
for (const [pk, pv] of Object.entries(data)) {
  if (typeof pv !== 'object' || pv === null) continue
  const models = {}
  for (const [id, mv] of Object.entries(pv.models ?? {})) {
    if (typeof mv !== 'object' || mv === null) continue
    const limit = mv.limit ?? {}
    const c = ctxOk(limit.context) ? limit.context : undefined
    const o = outOk(limit.output) ? limit.output : undefined
    if (c === undefined && o === undefined) continue
    models[id] = { ...(c !== undefined ? { context_window: c } : {}), ...(o !== undefined ? { max_output: o } : {}) }
  }
  if (Object.keys(models).length === 0) continue
  providers[pk] = { api: typeof pv.api === 'string' && pv.api ? pv.api : null, models }
}
const modelCount = Object.values(providers).reduce((s, p) => s + Object.keys(p.models).length, 0)
if (modelCount === 0) {
  console.error('目录为空（数据源不可达或格式变化），未写出快照')
  process.exit(1)
}
const fetchedAt = new Date().toISOString()
const body = JSON.stringify({ fetchedAt, providers }, null, 1)
const ts = `// 由 scripts/gen-catalog-snapshot.mjs 生成（数据源 models.dev api.json，${fetchedAt}）；勿手改，
// 刷新：node scripts/gen-catalog-snapshot.mjs。运行时以 ~/.modeldock/model-catalog.json 缓存（若存在）为准。
import type { CatalogData } from './catalog.js'

export const CATALOG_SNAPSHOT_FETCHED_AT = '${fetchedAt}'
export const CATALOG_SNAPSHOT: CatalogData = ${body}
`
fs.writeFileSync(out, ts)
console.log(`快照已生成：${Object.keys(providers).length} 厂商 / ${modelCount} 模型 → ${path.relative(root, out)}（${fs.statSync(out).size} 字节）`)

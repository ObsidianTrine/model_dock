import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { fullKnownTable } from '../providers/resolve.js'
import { displayPath, gatewayStatePath, logsDir } from '../util/paths.js'
import { UI_HTML } from './ui.js'

/** 锁屏提示展示的 gateway.json 路径：随实例实际 home 走（沙箱/自定义 home 时不是 ~/.modeldock），
 *  缩写规则统一走 paths.displayPath（只对真实系统 home 缩写为 ~） */
// 控制台 HTML 体与 home 路径在单进程内固定（displayPath(gatewayStatePath()) 只随环境变量走），
// 惰性渲染一次后缓存最终 HTML 与其内容 ETag，避免每请求整包 replaceAll + 算 hash。
// 缓存以 home 路径为键：生产单进程恒定只算一次；单进程共享单测（fakeHome 每用例换 home）
// 在 home 变化时自动重渲，不服务到旧路径。
// lang 不含进缓存键：UI_HTML 文案经 data-i18n 浏览器端切换，静态体与请求语言无关。
let renderedUICache: { home: string; html: string; etag: string; gzip: Buffer; gzipEtag: string } | null = null
export function getRenderedUI(): { html: string; etag: string; gzip: Buffer; gzipEtag: string } {
  const home = gatewayStatePath()
  if (renderedUICache && renderedUICache.home === home) return renderedUICache
  const html = UI_HTML
    .replaceAll('__MD_GATEWAY_STATE__', displayPath(home))
    .replaceAll('__MD_LOGS_DIR__', displayPath(logsDir()))
  const etag = '"' + createHash('sha256').update(html).digest('base64url').slice(0, 22) + '"'
  // gzip 形态一次性预压缩（PERF-25）：页体 ~308KB 走回环也要整包传输，gzip 后 ~1/5；静态体压缩
  // 一次终身使用。gzip 形态用独立 ETag（表示形态不同）——304 比较按请求的 Accept-Encoding 选形态
  const gzip = gzipSync(Buffer.from(html, 'utf8'), { level: 9 })
  const gzipEtag = '"' + createHash('sha256').update(gzip).digest('base64url').slice(0, 22) + '"'
  renderedUICache = { home, html, etag, gzip, gzipEtag }
  return renderedUICache
}


/** 模型目录端点视图缓存（backlog C3）：fullKnownTable() 的 8000+ 条序列化一次几百 KB，此前每次
 *  请求都全量 stringify。缓存键 = 表对象引用——引用稳定化在 providers 侧：resolve.ts 的
 *  fullKnownTable 按两路来源（catalogFlatTable 的 baseMemo 引用、knownMetaTable 的 memo 引用）
 *  复用同一表对象，目录刷新（mtime 变化/clearCatalogMemo）与预设热加载（clearKnownTable）时
 *  引用变化自然失效，无需额外接线。ETag 供 If-None-Match 命中 304，连 stringify 都省掉。 */
let catalogViewCache: { table: object; data: string; etag: string } | null = null
export function catalogView(): { data: string; etag: string } {
  const table = fullKnownTable()
  if (catalogViewCache && catalogViewCache.table === table) return catalogViewCache
  const data = JSON.stringify({ ok: true, models: table })
  const etag = '"' + createHash('sha256').update(data).digest('base64url').slice(0, 22) + '"'
  catalogViewCache = { table, data, etag }
  return catalogViewCache
}

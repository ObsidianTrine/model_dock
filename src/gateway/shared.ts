import type http from 'node:http'
import type { ModelMeta } from '../config/types.js'
import { t } from '../util/i18n.js'
import { resolveModelMeta } from '../providers/resolve.js'

/**
 * 模型元数据投影：桌面 buildConfigView / buildOverview 与手机 buildState 的模型列表共用同一条
 * 填充链（配置显式值 > 内置表 / models.dev 目录推断）。三处字段差异用参数表达——填充链成因
 * （context_window / max_output / capabilities 的推测来源）只在此维护一次，改一处不再漏别处。
 */
export interface ModelProjectionOptions {
  /** 手机视图字段名 `name` 且 display_name 缺省回落模型 id（桌面视图 display_name 缺省为 null） */
  nameKey?: boolean
  /** 携带 capabilities（桌面视图；手机页不展示） */
  includeCapabilities?: boolean
  /** 携带内部 source 字段（仅 buildConfigView 需要；overview 与手机视图不外露该内部字段） */
  includeSource?: boolean
}
export function projectModel(mid: string, meta: ModelMeta, opts: ModelProjectionOptions = {}): Record<string, unknown> {
  const r = resolveModelMeta(mid, meta)
  const out: Record<string, unknown> = {
    id: mid,
    [opts.nameKey ? 'name' : 'display_name']: opts.nameKey ? meta.display_name || mid : (meta.display_name ?? null),
    context_window: r?.context_window ?? null,
    max_output: r?.max_output ?? null,
  }
  if (opts.includeCapabilities) out.capabilities = meta.capabilities ?? r?.capabilities ?? []
  if (opts.includeSource) out.source = meta.source
  return out
}

/** listen + EADDRINUSE 顺延重试（≤10 次）：主网关 start（main.ts）与手机控制台第二监听器
 *  （lan.ts）共用同一套 listen/重试。返回实际监听的端口（listen(0) 等由内核分配时取其为准）。 */
export async function listenWithRetry(server: http.Server, port: number, host: string): Promise<number> {
  let current = port
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (e: Error): void => {
          server.off('listening', onListening)
          reject(e)
        }
        const onListening = (): void => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(current, host)
      })
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        if (attempt < 10) {
          console.error(t('端口 {port} 被占用，尝试 {next}', 'Port {port} in use, trying {next}', { port: current, next: current + 1 }))
          current++
          continue
        }
        // 顺延穷尽：裸 EADDRINUSE 无上下文（error-hints-audit ①）——报清尝试范围与排查口径
        throw new Error(
          t(
            '端口 {from}–{to} 全部被占用（起始为配置端口）：确认是否已有 modeldock 实例在跑（modeldock status），或查占用后改 config.toml [gateway] 的 port',
            'Ports {from}-{to} are all taken (starting from the configured port): check whether a modeldock instance is already running (modeldock status), find the occupier, or change the port key of [gateway] in config.toml',
            { from: String(port), to: String(port + 10) }
          )
        )
      }
      throw e
    }
  }
  const addr = server.address()
  return typeof addr === 'object' && addr ? addr.port : current
}

/** 按分享链接拉取配置包信封原文（桌面 /sync/import 与手机 /m/api/sync/import 共用）：
 *  fragment（#p=…）是口令，只在本机拆用、不发往网络；响应体 10MB 封顶。 */
export async function fetchEnvelopeFromUrl(rawUrl: string): Promise<string> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    throw new Error(t('链接格式不正确', 'Invalid link format'))
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(t('仅支持 http/https 链接', 'Only http/https links are supported'))
  u.hash = '' // fragment 是口令，只在本机拆用，不发往网络
  let res: Response
  try {
    res = await fetch(u.toString(), { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  } catch (e) {
    if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') {
      throw new Error(t('拉取超时：确认两机在同一局域网、来源电脑已开启手机远程且链接未过期', 'Fetch timed out: check both machines are on the same LAN, mobile console is on at the source, and the link has not expired'))
    }
    throw new Error(t('拉取失败：{msg}', 'Fetch failed: {msg}', { msg: (e as Error).message }))
  }
  if (!res.ok) throw new Error(t('拉取失败：HTTP {status}', 'Fetch failed: HTTP {status}', { status: res.status }))
  const reader = res.body?.getReader()
  if (!reader) throw new Error(t('来源返回了空响应', 'The source returned an empty response'))
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > 10 * 1024 * 1024) {
      await reader.cancel().catch(() => {})
      throw new Error(t('响应体超过 10MB 上限，疑似异常来源', 'Response exceeds the 10MB cap; the source looks abnormal'))
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
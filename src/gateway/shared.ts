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
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE' && attempt < 10) {
        console.error(t('端口 {port} 被占用，尝试 {next}', 'Port {port} in use, trying {next}', { port: current, next: current + 1 }))
        current++
        continue
      }
      throw e
    }
  }
  const addr = server.address()
  return typeof addr === 'object' && addr ? addr.port : current
}
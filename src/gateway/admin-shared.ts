/** admin 门共享底座：请求上下文类型与跨域小帮手（由 server.ts 拆出，T05，纯搬移零改写）。块序 = 原文件相对次序，未重排未删改。 */
import http from 'node:http'
import { ConfigError, mutateConfig } from '../config/store.js'
import { DEFAULT_GATEWAY_PORT, type Config } from '../config/types.js'
import { reloadRuntime, type GatewayRuntime } from './state.js'
import { UpstreamError } from './relay.js'
import { t, type Bilingual } from '../util/i18n.js'

/** 请求体缓冲上限（默认 16MB，可经 gateway.max_body_mb 调整）。模型名改写需要完整请求体，
 *  全量缓冲是设计前提；16MB 覆盖 1M token 文本 + 多图 base64 的常规包体，真需要更大的
 *  （大 PDF/多附件）在 config.toml [gateway] max_body_mb 抬上限，超限更早 413 也让异常大包
 *  不再各占两份内存（chunks 数组 + concat 副本）。导出供单测断言换算与回落规则。 */
export const DEFAULT_MAX_BODY_MB = 16
export function maxBodyBytes(cfg?: Config): number {
  const mb = Number(cfg?.gateway?.max_body_mb)
  return Number.isFinite(mb) && mb >= 1 ? Math.floor(mb) * 1024 * 1024 : DEFAULT_MAX_BODY_MB * 1024 * 1024
}

export async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        req.removeListener('data', onData)
        req.resume()
        reject(new UpstreamError(
          413,
          t('请求体超过 {max} 字节上限', 'Request body exceeds the {max}-byte limit', { max }),
          t('模型改写需完整缓冲请求体；确需更大包体，在 config.toml 的 [gateway] 下设置 max_body_mb 后重启网关', 'Model rewriting buffers the full body; to allow larger bodies set max_body_mb under [gateway] in config.toml and restart the gateway')
        ))
        // 不在 data 回调里 destroy：先毁 socket 客户端只收到 ECONNRESET（SDK 还会自动重试，
        // 形成超大包重传循环），413 与修复提示永远到不了。摘掉监听 + resume 排空剩余数据，
        // 让 413 响应正常发出（sendError 对 413 补 Connection: close）。
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
export function sendError(res: http.ServerResponse, status: number, message: string, hint?: string): void {
  if (status === 413) res.setHeader('connection', 'close') // 请求体未读完即响应，连接不可复用
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(hint ? { error: { message }, modeldock: { hint } } : { error: { message } }))
}

/** 顶层兜底的错误→响应映射。此前 jsonRequestBody 的 400（非法 JSON）、readBody 的 413（超限）、
 *  写配置锁超时的 ConfigError、节假日拉取附带的 hint，一旦漏出端点局部 try/catch 都会被
 *  顶层吞成 500「网关内部错误」；这里统一还原为正确状态码与可操作提示。 */
export function errorReply(e: unknown): { status: number; message: string; hint?: string } {
  if (e instanceof UpstreamError) return { status: e.status, message: e.message, hint: e.hint }
  if (e instanceof ConfigError) return { status: 400, message: e.message }
  const err = e as Error & { status?: unknown; hint?: unknown }
  const msg = err && typeof err.message === 'string' ? err.message : String(e)
  const hint = err && typeof err.hint === 'string' ? err.hint : undefined
  // 显式带数值 status 的业务错误（如 413 上限）按原状态透出
  if (typeof err?.status === 'number' && err.status >= 400 && err.status <= 599) {
    return { status: err.status, message: msg, hint }
  }
  // 带 hint 但无状态码（如节假日拉取失败）：按上游失败处理
  if (hint) return { status: 502, message: msg, hint }
  return { status: 500, message: t('网关内部错误：{msg}', 'Gateway internal error: {msg}', { msg }) }
}

/**
 * 管理面统一鉴权：admin token（CLI 兼容）或控制台 cookie（?token= 登种，HttpOnly + SameSite=Lax）。
 * 跨站 drive-by 靠 SameSite=Lax 挡住；DNS rebinding 靠 hostAllowed 挡住；本机程序一律需要 token。
 */
export async function jsonRequestBody(req: http.IncomingMessage): Promise<any> {
  const raw = await readBody(req, maxBodyBytes())
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new UpstreamError(400, t('请求体必须是 JSON', 'Request body must be JSON'))
  }
}

/** 网关侧配置变更：读盘改盘（与 CLI 共用带锁的 mutateConfig），再热加载内存态 */
export async function persistConfig(rt: GatewayRuntime, fn: (cfg: Config) => void): Promise<void> {
  await mutateConfig(fn)
  await reloadRuntime(rt)
}

/** 服务 → profile 解析（UI 按「服务」操作、底层路由单元是 profile）：
 *  优先 active_profile（若指向该服务），其次已引用该服务的第一个 profile；一个都没有则建隐藏 profile（__pin_<id>）。
 *  可能写 cfg（新建隐藏 profile），必须在 persistConfig 的回调里调用。 */
export function profileForProvider(c: Config, providerId: string): string {
  if (c.active_profile && c.profiles[c.active_profile]?.provider === providerId) return c.active_profile
  const existing = Object.keys(c.profiles).find((n) => c.profiles[n].provider === providerId)
  if (existing) return existing
  const name = `__pin_${providerId}`
  c.profiles[name] = { name, provider: providerId, default_model: Object.keys(c.providers[providerId]?.models ?? {})[0] }
  return name
}

/** 引用该 provider 的 profile 名（active_profile 优先），无则 undefined。buildOverview 的「默认模型/备用链
 *  读哪个 profile」与 service/update 的「写哪个 profile」是同一选择逻辑，抽共享避免口径漂移。只读，不建隐藏 profile。 */
export function profileRefForProvider(c: Config, providerId: string): string | undefined {
  const refs = Object.keys(c.profiles).filter((n) => c.profiles[n].provider === providerId)
  return refs.length
    ? (c.active_profile && c.profiles[c.active_profile]?.provider === providerId ? c.active_profile : refs[0])
    : undefined
}

// 同网直拉迁移（sync-lan-pull，B 机 import 侧）

/** admin 门之后各端点处理器的请求上下文：handleAdmin 每请求构造一次 */
export interface AdminCtx {
  rt: GatewayRuntime
  req: http.IncomingMessage
  res: http.ServerResponse
  /** 请求级审计闭包（handleAdmin 每请求构造，见原 audit 函数） */
  audit: (op: Bilingual, target: string | Bilingual, detail?: Bilingual, err?: Bilingual | string) => void
  o: { idle: number; retries: number }
}

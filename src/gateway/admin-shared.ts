/** admin 门共享底座：请求上下文类型与跨域小帮手（由 server.ts 拆出，T05，纯搬移零改写）。块序 = 原文件相对次序，未重排未删改。 */
import http from 'node:http'
import { ConfigError, configStatKey, mutateConfig } from '../config/store.js'
import { SecretsError, makeKeyRef, type SecretBackend } from '../config/secrets.js'
import { AdapterError } from '../adapters/types.js'
import { UpdateError } from '../update/check.js'
import { type Config, type ProviderConfig } from '../config/types.js'
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
    let over = false
    let settled = false
    let guard: NodeJS.Timeout | undefined
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      if (guard) clearTimeout(guard)
      fn()
    }
    const overflow = () =>
      new UpstreamError(
        413,
        t('请求体超过 {max} 字节上限', 'Request body exceeds the {max}-byte limit', { max }),
        t('模型改写需完整缓冲请求体；确需更大包体，在 config.toml 的 [gateway] 下设置 max_body_mb 后重启网关', 'Model rewriting buffers the full body; to allow larger bodies set max_body_mb under [gateway] in config.toml and restart the gateway')
      )
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        over = true
        req.removeListener('data', onData)
        // 不在 data 回调里 destroy；也不能立即 413 + close——客户端大概率仍在写入，
        // 提前关闭会让其下一段写入撞 ECONNRESET（SDK 还会自动重试，形成超大包重传循环），
        // 413 与修复提示永远到不了，负载越重越必现（实测 CI 门禁间歇红）。先排空到 end
        // （客户端写完）再应答，413 必达；异常客户端迟迟不结束则限时毁连接兜底。
        guard = setTimeout(() => {
          req.destroy()
          settle(() => reject(overflow()))
        }, 10_000)
        req.resume()
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    // 单一 end 处理器按超限标志分流——若在这里再挂第二个 end 监听，先挂的 resolve 会
    // 抢先 settle，超限请求被当正常处理返回 200（实测踩中）
    req.on('end', () =>
      settle(() => (over ? reject(overflow()) : resolve(Buffer.concat(chunks))))
    )
    req.on('error', (e) => settle(() => reject(e)))
  })
}
/** 请求是否预期携带 body（content-length > 0 或 chunked）：sendError 的断连判据前置——
 *  无 body 的 GET 在 handler 入口 readableEnded 恒为 false（complete 要等响应周期结束才翻转），
 *  只看 readableEnded 会把所有 GET 错误应答的 keep-alive 无谓掐断（夜间复审③）。 */
function expectsBody(req: http.IncomingMessage): boolean {
  if (Number(req.headers['content-length'] ?? 0) > 0) return true
  return String(req.headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')
}

export function sendError(res: http.ServerResponse, status: number, message: string, hint?: string): void {
  // 请求体未读完即应答 → 连接不可复用（Node 会销毁 socket，客户端每次断一次 keep-alive）。
  // 此前只特判 413；429 限额、401/403 鉴权失败与 admin 早退校验同样在 readBody 之前应答，
  // 按「预期有 body 且未读到 end」判定（2026-11-02 复查 P3-6；夜间复审③收窄：无 body 的
  // GET 错误不再断连）。res.req 是 Node 挂的请求回引；错误响应本就低频，不影响正常路径的连接复用
  if (status === 413 || (res.req && expectsBody(res.req) && !res.req.readableEnded)) res.setHeader('connection', 'close')
  // 请求关联 ID 回填错误体（handleRequest 入口已 set 到响应头，这里读回即可覆盖全部 sendError 调用点，
  // 包括 handleAdmin 内的管理面错误）：modeldock.requestId 与响应头 x-modeldock-request-id 同值
  const rid = res.getHeader('x-modeldock-request-id')
  const modeldock: Record<string, string> = {}
  if (hint) modeldock.hint = hint
  if (typeof rid === 'string' && rid) modeldock.requestId = rid
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message }, ...(Object.keys(modeldock).length ? { modeldock } : {}) }))
}

/** 顶层兜底的错误→响应映射。此前 jsonRequestBody 的 400（非法 JSON）、readBody 的 413（超限）、
 *  写配置/密钥锁超时的 ConfigError/SecretsError、adapter 的 AdapterError 一旦漏出端点局部
 *  try/catch 都会被顶层吞成 500「网关内部错误」；这里统一还原为正确状态码与可操作提示。
 *  （err-taxonomy：五类业务错误的 hint 收口为类型字段，duck 读 hint 的逃逸口一并移除。） */
export function errorReply(e: unknown): { status: number; message: string; hint?: string } {
  if (e instanceof UpstreamError) return { status: e.status, message: e.message, hint: e.hint }
  if (e instanceof ConfigError) return { status: 400, message: e.message, hint: e.hint }
  if (e instanceof SecretsError) return { status: 400, message: e.message, hint: e.hint }
  if (e instanceof AdapterError) return { status: 400, message: e.message, hint: e.hint }
  if (e instanceof UpdateError) return { status: 500, message: e.message, hint: e.hint }
  const err = e as Error & { status?: unknown }
  const msg = err && typeof err.message === 'string' ? err.message : String(e)
  // 显式带数值 status 的业务错误（如 413 上限）按原状态透出（不带 hint：全仓无非 UpstreamError 的 status+hint 组合）
  if (typeof err?.status === 'number' && err.status >= 400 && err.status <= 599) {
    return { status: err.status, message: msg }
  }
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

/** 网关侧配置变更：读盘改盘（与 CLI 共用带锁的 mutateConfig），再热加载内存态。fn 同值跳写
 *  （盘上指纹不变）时跳过热加载，免白付整包 reload（连接池销毁重建 / key 池轮转态清零 / reloads 虚增）。
 *  secrets 缓存与 reload 完全解耦：失效收口在 watcher 的 invalidateSecretsCacheIfExternal，config 写不清密钥缓存。 */
export async function persistConfig(rt: GatewayRuntime, fn: (cfg: Config) => void): Promise<void> {
  const before = await configStatKey()
  await mutateConfig(fn)
  if ((await configStatKey()) === before) return
  await reloadRuntime(rt) // reloadRuntime 内统一触发保存后 overview 预热（perf-p2-polish）
}

/** 密钥写入计划（writeKeySlotLocked 产出、rollbackKeyWrite 消费）。 */
export interface KeyWritePlan {
  pool: boolean
  /** secrets.json / 钥匙环条目 id（setSecret 第一参） */
  secretId: string
  /** 写入 config 的 key_ref */
  ref: string
  backend: SecretBackend
  /** 建池（落盘时池空）为 true：回滚整体摘除 keys 还原单 key 态；既有池追加为 false：按 ref 精确摘除 */
  createdPool: boolean
  /** 单 key 覆盖前的旧 key_ref（'' = 原本无 key）；池路径不使用 */
  prevKeyRef: string
}

/** 池追加 / 单 key 覆盖的槽位推导 + config 写入。**必须在 mutateConfig / persistConfig 的写锁内
 *  调用**（审计 F3）：锁外按内存态预生成槽位时，钥匙环读取等 await 可达百 ms，期间另一并发写者
 *  可先提交一个同槽 key，本写者沿用旧推导会把两个 key 挤进同一槽（后写 setSecret 覆盖先写，先写
 *  方丢 key）。mutateConfig 锁内重读盘，这里拿到的 t 是盘上最新态，锁内推导天然互斥。
 *  planPoolKeys：调用方计划期（内存态）池引用快照，兜「运行态/盘上分歧」窗口——盘上池被清时仍按
 *  计划期池长续号（web-key-pool 建池迁移钉子：盘上 keys 空且 key_ref 在池外，追加建池迁 key_ref
 *  入池首、新引用 = 计划期池长+1）；盘上池非空一律走追加（盘上为准——计划期未见池但盘上已建池时
 *  也追加，不再单 key 覆盖静默退出轮转）。taken 并收计划期与盘上两份引用，两个真相来源都不撞。 */
export function writeKeySlotLocked(t: ProviderConfig, id: string, backend: SecretBackend, planPoolKeys: string[]): KeyWritePlan {
  const poolKeys = Array.isArray(t.keys) ? t.keys.filter((k): k is string => typeof k === 'string') : []
  const hadPoolEntries = poolKeys.length > 0
  if (!hadPoolEntries && planPoolKeys.length === 0) {
    const prevKeyRef = typeof t.key_ref === 'string' ? t.key_ref : ''
    const ref = makeKeyRef(backend, id)
    t.key_ref = ref
    return { pool: false, secretId: id, ref, backend, createdPool: false, prevKeyRef }
  }
  const createdPool = !hadPoolEntries
  const taken = new Set<string | undefined>([...planPoolKeys, ...poolKeys, t.key_ref])
  let slot = planPoolKeys.length + 1
  let ref = makeKeyRef(backend, `${id}-k${slot}`)
  while (taken.has(ref)) {
    slot++
    ref = makeKeyRef(backend, `${id}-k${slot}`)
  }
  const pool = (t.keys ??= [])
  // 建池先把 key_ref 迁入池首——providerKeyRefs 池非空时只认 keys，不迁移原 key 静默退出轮转
  //（2026-11-12 审查 P1-2，与 CLI set-key --add 同口径）
  if (pool.length === 0 && typeof t.key_ref === 'string' && t.key_ref) pool.unshift(t.key_ref)
  pool.push(ref)
  return { pool: true, secretId: `${id}-k${slot}`, ref, backend, createdPool, prevKeyRef: '' }
}

/** 审计 F5 回滚：persistConfig 已把新 ref 落盘、锁外 setSecret 失败（密钥没写上）——配置不得留
 *  「指向无值 ref」的残面（池：轮转常撞空槽空转；单 key：转发无 key 可用）。经 persistConfig 走：
 *  有改动才触发热加载，转发即刻回到回滚后的引用集。 */
export async function rollbackKeyWrite(rt: GatewayRuntime, id: string, plan: KeyWritePlan): Promise<void> {
  await persistConfig(rt, (c) => {
    const t = c.providers[id]
    if (!t) return
    if (plan.pool) {
      if (plan.createdPool) {
        delete t.keys
      } else {
        const pool = t.keys
        if (!pool) return
        const i = pool.indexOf(plan.ref)
        if (i >= 0) pool.splice(i, 1)
      }
    } else {
      t.key_ref = plan.prevKeyRef
    }
  })
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


/** admin 门之后各端点处理器的请求上下文：handleAdmin 每请求构造一次 */
export interface AdminCtx {
  rt: GatewayRuntime
  req: http.IncomingMessage
  res: http.ServerResponse
  /** 请求级审计闭包（每请求构造一次，见 server.ts handleAdmin 的 audit 闭包） */
  audit: (op: Bilingual, target: string | Bilingual, detail?: Bilingual, err?: Bilingual | string) => void
  o: { idle: number; retries: number }
}

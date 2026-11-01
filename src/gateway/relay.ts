import { request } from 'undici'
import zlib from 'node:zlib'
import { getSecret } from '../config/secrets.js'
import { matchAlias } from '../util/glob.js'
import { t } from '../util/i18n.js'
import type { Protocol, ProviderConfig } from '../config/types.js'
import { recordOutcome, pickTarget, type GatewayRuntime, type ResolvedTarget } from './state.js'
import { dispatcherFor } from './proxy.js'

/** 需要模型名改写的业务端点（其余路径纯透传） */
const ROUTED_PATH_RE = /\/v1\/(messages|messages\/count_tokens|chat\/completions|completions|responses|embeddings)$/

/** Claude Code 内置模型 ID（未配置任何模型 env 时客户端就发这些名字，含新旧分层命名）。
 *  网关模式客户端配置不带模型映射、profile.aliases 又未覆盖时（常见：profile 只有
 *  default_model），原样透传上游必不认。rewriteModel 对命中此正则且未命中别名的请求名
 *  兜底改写为 profile.default_model——服务切换 / 定时切换 / 故障切换都即时跟随新目标，
 *  客户端零改动、长会话不用重启；显式别名仍然优先。仅在目标 profile 配了 default_model
 *  时才可能触发（那是「用这个服务的模型」的显式意图），无 default_model 的 profile 保持透传。 */
const CLAUDE_BUILTIN_RE = /^claude-/

/** 从客户端入站 path 推断其协议（出站据此选 Provider 对应协议端点，同协议直连）。
 *  embeddings 归 openai（OpenAI SDK 生态）；/v1/messages 与 count_tokens 是 anthropic 签名
 *  路径，显式归 anthropic——多协议 provider（protocol=openai + endpoints.anthropic）由此才可达；
 *  曾因回退 provider 自身协议，openai provider 配了 anthropic 端点也永远走不到（2026-11-01 实测）。
 *  未知路径（/v1/models、/v1/files 等非对话端点）回退 provider 自身协议原样转发，而不是硬编码
 *  anthropic 造成误导性的协议不匹配报错。 */
export function clientProtocolFromPath(path: string, fallback: Protocol = 'anthropic'): Protocol {
  const p = path.split('?')[0]
  if (/\/chat\/completions$/.test(p) || /\/completions$/.test(p) || /\/embeddings$/.test(p)) return 'openai'
  if (/\/responses$/.test(p)) return 'responses'
  if (/\/messages(\/count_tokens)?$/.test(p)) return 'anthropic'
  return fallback
}

/** 按协议取 Provider 的出站端点；默认协议(base_url 本来就是该协议)可回退，其余协议缺失则报可操作错误 */
export function upstreamEndpoint(provider: ProviderConfig, proto: Protocol): string {
  const ep = provider.endpoints?.[proto] ?? (provider.protocol === proto ? provider.base_url : undefined)
  if (!ep) {
    const e = new UpstreamError(
      400,
      t('服务商「{name}」未配置 {proto} 协议端点（客户端走的是 {proto} 协议）', 'Provider "{name}" has no {proto} endpoint configured (the client speaks the {proto} protocol)', { name: provider.name ?? '', proto }),
      t('在「编辑服务」里填入该协议的接口地址，或改用该服务商支持的协议', 'Fill in the endpoint URL for this protocol in "Edit Service", or use a protocol the provider supports')
    )
    e.candidateSkip = true // 该候选不支持客户端协议
    throw e
  }
  return ep
}

/** 出站 URL 拼接：默认把客户端路径（/v1/...）整段接到端点后。
 *  openai/responses 协议下，若端点路径以版本段（/v1、/v3、/v4…）结尾——厂商文档的
 *  base_url 常带版本，如方舟 /api/coding/v3、智谱 /api/paas/v4、Kimi /v1——则客户端
 *  路径的 /v1 前缀并入端点版本（拼 /responses 而非 /v1/responses），避免 /v1/v1 双版本。
 *  anthropic 各厂商路径约定不统一（.../anthropic + /v1/messages 是真实路由），维持整段拼接。 */
export function joinUpstreamUrl(endpoint: string, clientPath: string, proto: Protocol): string {
  const base = endpoint.replace(/\/+$/, '')
  if (proto !== 'anthropic') {
    try {
      if (/\/v\d+$/.test(new URL(base).pathname)) {
        return base + clientPath.replace(/^\/v1(?=\/|$)/, '')
      }
    } catch {
      // 端点不是合法 URL：按原样拼接，让后续请求自然报错
    }
  }
  return base + clientPath
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true
  const m = host.match(/^(\d+)\.\d+\.\d+\.\d+$/)
  return !!m && +m[1] === 127
}

function isPrivateHost(host: string): boolean {
  const m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (m) {
    const a = +m[1]
    const b = +m[2]
    if (a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return true
  }
  return host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.corp')
}

/** 上游端点风险提示：公网明文 http（key 会裸奔）、本机/内网地址（确认是否有意）。
 *  只提示不拦截——内网穿透、自建网关、本机推理（ollama 等）都是合法场景，但配错地址会把真实 API key 发给错误的主机。 */
export function endpointRisks(endpoint: string): string[] {
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    return [] // 非法 URL 由格式校验兜底（CLI requireValidBaseUrl / Web 端点 400）
  }
  const host = u.hostname.toLowerCase()
  const risks: string[] = []
  if (u.protocol === 'http:' && !isLoopbackHost(host)) {
    risks.push(t('使用明文 http：API key 会在网络上明文传输，确认该地址可信（建议 https）', 'Plaintext http: the API key is transmitted unencrypted over the network; confirm this address is trusted (https recommended)'))
  }
  if (isLoopbackHost(host) || isPrivateHost(host)) {
    risks.push(t('指向本机/内网地址：确认这是有意的（自建网关/本地推理），填错会把 API key 发给非预期主机', 'Points to a localhost/intranet address: confirm this is intended (self-hosted gateway/local inference); a wrong address would send the API key to an unexpected host'))
  }
  return risks
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export class UpstreamError extends Error {
  status: number
  hint?: string
  /** true = 传输层失败（请求未送达上游，可安全改发重试）；false/undefined = 已送达的应用层错误（禁止重放）。
   *  边界：ECONNRESET 若发生在响应读取阶段，上游可能已处理（甚至已计费）该请求——此处不据此判定重放安全性。 */
  transport?: boolean
  /** true = 候选本身不可用（key 缺失 / 协议端点缺失等配置级问题，请求未发出）：跳到下一候选而不是中止整条链 */
  candidateSkip?: boolean
  /** 自动路由结果标记（down_all / failover / skip_all 等），用于日志 reason */
  routeReason?: string
  constructor(status: number, message: string, hint?: string) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.hint = hint
  }
}

export interface ForwardOptions {
  method: string
  path: string
  headers: Record<string, string>
  body: Buffer
  idleTimeoutMs: number
  retries: number
  /** 客户端断开信号：中止在途上游请求与 failover 候选迭代，不再为已离开的客户端白烧上游 token */
  signal?: AbortSignal
}

export interface UpstreamBody {
  text(): Promise<string>
}

export interface UpstreamResult {
  status: number
  /** undici 原样透传：重复头（典型 set-cookie）的值是 string[]。折叠成 'a,b' 会破坏
   *  Set-Cookie（RFC 6265：Expires 含逗号，禁止折叠），客户端解析必错——保数组语义，
   *  由 node writeHead/setHeader 逐条写出。单值头仍是 string。 */
  headers: Record<string, string | string[]>
  body: UpstreamBody
  modelAfter?: string
  ms: number
}

function isConnectError(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } }
  const code = err?.code ?? err?.cause?.code
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  )
}

/** 超时类连接失败（连接挂死/被黑洞）：到达这一步前已等满整个超时窗口，原样重试只会把
 *  最坏等待翻倍才轮到 failover 下一候选（backlog B2）。拒绝类（ECONNREFUSED 等）失败是
 *  毫秒级，保留立即重试一次应对瞬时抖动。导出供单测断言分类口径。
 *  注意 ETIMEDOUT 也可能是「请求已送达、等响应超时」——但 undici 的 bodyTimeout/headersTimeout
 *  走的是另外的错误形态（UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT），不在此列，
 *  那类错误本就不重试（isConnectError 不含它们）。 */
export function isConnectTimeoutError(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } }
  const code = err?.code ?? err?.cause?.code
  return code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
}

/** 组装上游请求头：剥离 hop-by-hop 与客户端凭据，按 provider 协议注入真实 key。
 *  cookie 与 x-modeldock-* 一并剥离：admin token / 会话 cookie 绝不能转发给第三方上游。 */
async function buildUpstreamHeaders(
  target: ResolvedTarget,
  incoming: Record<string, string>,
  key: string,
  proto: Protocol
): Promise<Record<string, string>> {
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(incoming)) {
    const lk = k.toLowerCase()
    if (
      HOP_BY_HOP.has(lk) ||
      lk === 'host' ||
      lk === 'content-length' ||
      lk === 'authorization' ||
      lk === 'x-api-key' ||
      lk === 'cookie' ||
      lk.startsWith('x-modeldock-')
    ) {
      continue
    }
    h[k] = v
  }
  const { provider } = target
  if (proto === 'anthropic') {
    if (provider.auth_style === 'x-api-key') h['x-api-key'] = key
    else h.authorization = `Bearer ${key}`
    h['anthropic-version'] ??= '2023-06-01'
  } else {
    h.authorization = `Bearer ${key}`
  }
  return h
}

/** 从 JSON 请求体顶层对象浅扫描 "model" 字段值（不解码整个文档、零大对象分配）。
 *  仅用于纯透传场景读取日志用的 modelAfter，不参与改写决策。返回值：
 *  - string / undefined：顶层 model 的字符串值（与 JSON.parse 语义一致，重复键取最后一个）
 *  - null：无法安全判定（非顶层对象 / 扫描器遇到不支持的结构），调用方退回完整 JSON.parse
 *  安全性：UTF-8 多字节序列不会与 ASCII 结构字节混淆（自身同步编码），按键名逐一比较，
 *  任何含转义的键直接放弃（退回完整解析），值经 JSON.parse 单独解码保证与全量解析等价。 */
export function topLevelModel(body: Buffer): string | undefined | null {
  const n = body.length
  let i = 0
  const isWs = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d
  while (i < n && isWs(body[i])) i++
  if (body[i] !== 0x7b /* { */) return null
  i++
  let last: string | undefined
  let sawModel = false
  for (;;) {
    while (i < n && isWs(body[i])) i++
    if (i >= n) return null
    if (body[i] === 0x7d /* } */) return sawModel ? last : undefined
    if (body[i] !== 0x22 /* " */) return null
    // 读键名：含转义一律放弃（解码键名对比不值得为它保留扫描器复杂度）
    const keyStart = ++i
    while (i < n && body[i] !== 0x22) {
      if (body[i] === 0x5c /* \ */) return null
      i++
    }
    if (i >= n) return null
    const isModelKey = i - keyStart === 5 && body.toString('latin1', keyStart, i) === 'model'
    i++ // 跳过键名闭引号
    while (i < n && isWs(body[i])) i++
    if (body[i] !== 0x3a /* : */) return null
    i++
    while (i < n && isWs(body[i])) i++
    if (i >= n) return null
    const c = body[i]
    if (c === 0x22 /* 值是字符串 */) {
      const vStart = ++i
      while (i < n && body[i] !== 0x22) {
        if (body[i] === 0x5c) { i += 2; continue } // 转义对跳过
        i++
      }
      if (i >= n) return null
      if (isModelKey) {
        sawModel = true
        try {
          last = JSON.parse(body.toString('utf8', vStart - 1, i + 1)) as string // 含引号整体解码
        } catch {
          return null
        }
      }
      i++ // 跳过值闭引号
    } else {
      // 非字符串值（数字/字面量/嵌套结构）：按深度与字符串感知跳过；顶层 model 为非字符串
      // 时与 JSON.parse 后 typeof 检查同义 → requested = undefined
      if (isModelKey) {
        sawModel = true
        last = undefined
      }
      if (c === 0x7b || c === 0x5b /* { [ */) {
        let depth = 0
        while (i < n) {
          const b = body[i]
          if (b === 0x22) {
            i++
            while (i < n && body[i] !== 0x22) {
              if (body[i] === 0x5c) i++
              i++
            }
            if (i >= n) return null
          } else if (b === 0x7b || b === 0x5b) depth++
          else if (b === 0x7d || b === 0x5d) {
            depth--
            if (depth === 0) { i++; break }
          }
          i++
        }
        if (depth !== 0) return null
      } else {
        while (i < n && !isWs(body[i]) && body[i] !== 0x2c && body[i] !== 0x7d) i++ // , }
      }
    }
    while (i < n && isWs(body[i])) i++
    if (body[i] === 0x2c /* , */) { i++; continue }
    if (body[i] === 0x7d /* } */) return sawModel ? last : undefined
    return null
  }
}

/** 纯模型名改写判定：仅输入字符串，输出最终改写目标。供「浅扫描快路径」（pre 非 null）与
 *  「全量解析路径」（pre === null）共用，避免两套判定逻辑漂移。语义与既有实现逐字段等价。 */
function resolveModelFinal(target: ResolvedTarget, wire: string | undefined): string | undefined {
  let requested = wire
  // discovery 别名剥壳：anthropic.<id> 仅当真实 ID 在服务目录里时还原——上游真有 anthropic. 开头
  // 的模型 ID 时保持原样，不误剥。wire 保留请求体原值，改写判定始终与它比较
  if (requested && /^anthropic\./i.test(requested)) {
    const stripped = requested.slice('anthropic.'.length)
    if (stripped && target.provider.models?.[stripped]) requested = stripped
  }
  const alias = requested ? matchAlias(target.profile.aliases, requested) : undefined
  // claude 内置模型名兜底（CLAUDE_BUILTIN_RE 注释）：别名未命中且服务目录里没有该 ID 时才改写为
  // 默认模型——上游真提供 claude-* 模型（中转服务）时客户端显式点名保持透传（与上方 anthropic.
  // 剥壳同规，只信服务目录）；目录未管理（缺省）时不拦，维持原兜底
  const tierFallback = alias === undefined && requested !== undefined && CLAUDE_BUILTIN_RE.test(requested) && target.provider.models?.[requested] === undefined
    ? target.profile.default_model
    : undefined
  // 候选级映射（"<provider>:<model>" 条目）优先于别名：它是为跨服务商切换显式配置的意图
  return target.modelOverride ?? alias ?? tierFallback ?? requested ?? target.profile.default_model
}

/** 确需改写时的模型注入 + 重序列化。解析失败 / 顶层非对象（含数组——typeof [] === 'object'
 *  拦不住，expando 写入会被 stringify 丢弃而 modelAfter 谎报已改写，CORRECT-09 ①）时返回 null，
 *  调用方原样透传（不进解析时已判模型，此处仅做改写所需的完整 parse，失败只能透传）。 */
function injectModel(body: Buffer, final: string): { body: Buffer; modelAfter: string } | null {
  let json: any
  try {
    json = JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  json.model = final
  return { body: Buffer.from(JSON.stringify(json), 'utf8'), modelAfter: final }
}

/** 请求体中的模型重写：aliases 精确/通配 → default_model 兜底；未命中透传。
 *  懒解析快路径：改写判定的全部输入就是模型名字符串，无需完整文档。pre 非 null 时先用顶层浅扫描
 *  拿到模型字符串独立完成判定（default_model / aliases / tierFallback / anthropic. 剥壳全在此步），
 *  仅当确需改写（final !== wire）才 parse+重序列化——大上下文请求体（数百 KB ~ MB 级）下，JSON.parse
 *  阻塞事件循环并串行化同实例并发流，这是热路径最大的一块纯 CPU 开销。final === wire 时不 parse、
 *  不重序列化，直接返回入参的同一个 Buffer 引用（body === body）。扫描器拿不准（pre === null：
 *  含转义键 / 非顶层对象 / 非 JSON）时退回完整解析路径，行为与原实现逐字节等价。 */
export function rewriteModel(
  target: ResolvedTarget,
  body: Buffer,
  path: string
): { body: Buffer; modelAfter?: string } {
  if (body.length === 0 || !ROUTED_PATH_RE.test(path.split('?')[0])) return { body }
  const pre = topLevelModel(body)
  if (pre !== null) {
    // 快路径：全部改写判定只用 pre 字符串完成，不再全量 parse
    const final = resolveModelFinal(target, pre)
    let modelAfter = pre
    if (final !== undefined && final !== pre) return injectModel(body, final) ?? { body }
    if (final !== undefined) modelAfter = final
    return { body, modelAfter }
  }
  // pre === null：退回全量解析路径（行为与原实现逐字节等价）
  let json: any
  try {
    json = JSON.parse(body.toString('utf8'))
  } catch {
    return { body }
  }
  if (!json || typeof json !== 'object') return { body }
  const wire = typeof json.model === 'string' ? json.model : undefined
  const final = resolveModelFinal(target, wire)
  let modelAfter = wire
  if (final !== undefined && final !== wire) return injectModel(body, final) ?? { body }
  if (final !== undefined) modelAfter = final
  return { body, modelAfter }
}

export async function forwardToUpstream(
  rt: GatewayRuntime,
  target: ResolvedTarget,
  opts: ForwardOptions
): Promise<UpstreamResult> {
  const { provider } = target
  let key: string | null
  try {
    key = await getSecret(provider.key_ref)
  } catch (e) {
    // 钥匙环锁定/瞬时故障与「key 缺失」同规：跳下一候选而非打断整条 failover 链；
    // 包成 503+hint——非 UpstreamError 会被 errorReply 落成 500「内部错误」
    const e2 = new UpstreamError(
      503,
      t('provider「{profile}→{name}」的 key 读取失败：{msg}', 'Failed to read the API key for provider "{profile}→{name}": {msg}', { profile: target.profileName, name: provider.name ?? target.profile.provider, msg: (e as Error).message }),
      (e as { hint?: string }).hint ?? t('检查系统钥匙环是否已解锁，解锁后重试', 'Check that the system keyring is unlocked and retry')
    )
    e2.candidateSkip = true
    throw e2
  }
  if (!key) {
    const e = new UpstreamError(
      503,
      t('provider「{profile}→{name}」的 key 不可用（key_ref={ref}）', 'API key unavailable for provider "{profile}→{name}" (key_ref={ref})', { profile: target.profileName, name: provider.name ?? target.profile.provider, ref: provider.key_ref }),
      t('modeldock provider set-key {id} 更新 key', 'Run modeldock provider set-key {id} to update the key', { id: target.profile.provider })
    )
    e.candidateSkip = true // 把机会让给链上其余候选（自动备用链的健壮性前提）
    throw e
  }

  const rewritten = rewriteModel(target, opts.body, opts.path)
  const proto = clientProtocolFromPath(opts.path, provider.protocol)
  const headers = await buildUpstreamHeaders(target, opts.headers, key, proto)
  const url = joinUpstreamUrl(upstreamEndpoint(provider, proto), opts.path, proto)
  const dispatcher = dispatcherFor(rt, provider)

  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now()
    try {
      const up = await request(url, {
        method: opts.method as any,
        headers,
        body: rewritten.body.length > 0 ? rewritten.body : undefined,
        dispatcher,
        signal: opts.signal,
        // 响应头到达时限：非流式长推理的上游可能数分钟才回头，可用 gateway.headers_timeout_ms 放宽
        headersTimeout: rt.config.gateway?.headers_timeout_ms ?? 60_000,
        bodyTimeout: opts.idleTimeoutMs,
      })
      return {
        status: up.statusCode,
        // 保数组语义原样透传（折叠为 'a,b' 对 set-cookie 是有损转换，见 UpstreamResult 注释）
        headers: up.headers as Record<string, string | string[]>,
        body: up.body as unknown as UpstreamBody,
        modelAfter: rewritten.modelAfter,
        ms: Date.now() - t0,
      }
    } catch (e) {
      // 客户端已断开：中止错误原样上抛（不包 502、不重试——上游连接由 undici 对 signal 的响应就地释放）
      if (opts.signal?.aborted) throw e
      // B2：拒绝类连接错误快速失败，保留立即重试；超时类（已等满超时窗口）不再重试，
      // 直接抛出走 failover 下一候选——挂死上游的最坏等待从 2×连接超时降到 1×
      if (attempt < opts.retries && isConnectError(e) && !isConnectTimeoutError(e)) continue
      // 超时类已等满整个窗口才到这一步（error-hints-audit ③）：文案与排查口径与拒绝类分开——
      // 「连不上」查网络/代理，「连上但等不到响应」查上游是否过慢/挂死
      const timeoutLike = isConnectTimeoutError(e)
      const errNew = new UpstreamError(
        502,
        timeoutLike
          ? t('上游连接超时：{url}（已等满超时窗口仍无响应）', 'Upstream connection timed out: {url} (no response after the full timeout window)', { url })
          : t('上游连接失败：{msg}（{url}）', 'Upstream connection failed: {msg} ({url})', { msg: (e as Error).message, url }),
        timeoutLike
          ? t('上游过慢或代理黑洞：modeldock test 验证；慢上游可在 modeldock config edit 调大 [gateway] 超时与 retries', 'The upstream is slow or the proxy swallows traffic: verify with modeldock test; for slow upstreams raise the [gateway] timeouts and retries in modeldock config edit')
          : t('检查网络/代理（modeldock config edit 里 provider.proxy），或 modeldock test 直接验证', 'Check network/proxy (provider.proxy in modeldock config edit), or verify directly with modeldock test')
      )
      errNew.transport = true
      throw errNew
    }
  }
}

/** 模型不匹配类错误特征：上游 400 体里点名模型不存在 / 不支持 / 无效（正反两种语序都算：
 *  「model ... not supported」与「invalid model name」）。中文原文错误同样覆盖。
 *  （真实案例 2026-10：claude-direct 只认 Claude 系模型，glm-5.3-flash 被 400 拒绝，客户端只看到原始英文报错） */
const MODEL_MISSING_RE =
  /model.*(?:does not exist|is not supported|not available|not found|invalid)|(?:invalid|unsupported|unknown|no such)\s+model|模型.*(?:不存在|不支持|无效|不可用)/i

/** 上游 4xx/5xx → 附带可执行修复建议 */
export function translateUpstreamError(
  status: number,
  bodyText: string,
  ctx: { providerId: string; model?: string }
): string {
  let parsed: any = null
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    /* 非 JSON 错误体 */
  }
  let hint: string
  if (status === 401 || status === 403) {
    hint = t('上游认证失败（HTTP {status}）：key 可能失效或无权限。执行 modeldock provider set-key {id} 更新', 'Upstream authentication failed (HTTP {status}): the key may be invalid or lack permission. Run modeldock provider set-key {id} to update it', { status, id: ctx.providerId })
  } else if (status === 404 && /model/i.test(bodyText)) {
    hint = t('模型不存在：{model}。执行 modeldock model refresh {id} 拉取可用模型，或 modeldock profile use 切换 profile', 'Model not found: {model}. Run modeldock model refresh {id} to fetch available models, or switch profile with modeldock profile use', { model: ctx.model ?? '?', id: ctx.providerId })
  } else if (status === 400 && /(context|max.?imum|too long|length limit)/i.test(bodyText)) {
    hint = t('疑似超出模型上下文限制（model={model}）。查看限额：modeldock model list {id}', 'Likely over the model context limit (model={model}). Check limits: modeldock model list {id}', { model: ctx.model ?? '?', id: ctx.providerId })
  } else if (status === 402) {
    hint = t('上游额度不足（HTTP 402）：余额/套餐额度已耗尽。等待额度重置、更换 key，或在服务上手动挂起；有备用服务时网关会自动切换', 'Upstream out of quota (HTTP 402): balance/plan quota exhausted. Wait for reset, replace the key, or suspend the service; the gateway fails over automatically when a fallback exists')
  } else if (status === 429) {
    hint = t('上游限流或额度不足：稍后重试，或切换 profile（modeldock profile use）', 'Upstream rate-limited or out of quota: retry later, or switch profile (modeldock profile use)')
  } else if (status === 400 && MODEL_MISSING_RE.test(bodyText)) {
    hint = t('模型不匹配或不存在：{model}。检查模型名称拼写，或执行 modeldock model refresh {id} 拉取可用模型', 'Model mismatch or not found: {model}. Check the model name spelling, or run modeldock model refresh {id} to fetch available models', { model: ctx.model ?? '?', id: ctx.providerId })
  } else {
    hint = t('上游返回 HTTP {status}；网络/凭据问题可执行 modeldock test 排查', 'Upstream returned HTTP {status}; for network/credential issues run modeldock test to diagnose', { status })
  }
  const modeldock = { hint, provider: ctx.providerId, model: ctx.model }
  if (parsed && typeof parsed === 'object') {
    return JSON.stringify({ ...parsed, modeldock })
  }
  return JSON.stringify({
    error: { type: 'upstream_error', message: bodyText.slice(0, 500) },
    modeldock,
  })
}

/** 响应头过滤：hop-by-hop 与 content-length 交给 node 重新计算（值原样透传，数组语义保留） */
export function filterResponseHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === 'content-length') continue
    out[k] = v
  }
  return out
}

/** zstd 解压器（zlib.zstdDecompressSync，Node ≥22.15 提供）。运行时探测而非比对版本号：
 *  22.15+ / 23.x / 24.x 都应有该 API，按版本字符串判断会在 22.16 或 24 上误关。
 *  缺失（旧运行时）时保持 null，错误体回落按 utf8 直读，不抛错、不影响 gzip/deflate/br。 */
type ZstdDecoder = (buf: Buffer) => Buffer
const zstdDecoder: ZstdDecoder | null =
  typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null

/** 读上游错误体为文本：按 content-encoding 解压后再解码。
 *  undici request 不自动解压，压缩错误体（如火山方舟的 gzip 400 体）直读是一段乱码，
 *  客户端只会看到不可诊断的 upstream_error，错误分类（额度特征识别）也随之失效。
 *  解压失败 / 无压缩头回落原始字节按 utf8 解码，不向上抛。
 *  zstd（上游新出现的压缩算法）同样按此规则处理。 */
export async function readUpstreamErrorText(
  headers: Record<string, string | string[]>,
  body: UpstreamBody & { arrayBuffer?(): Promise<ArrayBuffer> }
): Promise<string> {
  let buf: Buffer
  try {
    buf = typeof body.arrayBuffer === 'function'
      ? Buffer.from(await body.arrayBuffer())
      : Buffer.from(await body.text(), 'utf8')
  } catch {
    return ''
  }
  const rawEnc = headers['content-encoding'] ?? headers['Content-Encoding'] ?? ''
  const enc = (Array.isArray(rawEnc) ? rawEnc.join(',') : String(rawEnc)).toLowerCase().trim()
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf).toString('utf8')
    if (enc === 'deflate') {
      // deflate 有 zlib 包头与裸流两种形态，上层无法区分，逐个尝试
      try { return zlib.inflateSync(buf).toString('utf8') } catch { return zlib.inflateRawSync(buf).toString('utf8') }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buf).toString('utf8')
    if (enc === 'zstd' && zstdDecoder) return zstdDecoder(buf).toString('utf8')
  } catch {
    /* 回落原文 */
  }
  return buf.toString('utf8')
}

export interface FailoverResult extends UpstreamResult {
  usedProviderId: string
  /** 改发/重放事件标记（failover_to:<id>、replayed_from:<id>）；主选直连成功不设——日志过滤与 Web 展示依赖「非空即事件」约定 */
  reason?: string
}

function isTransportFailure(e: unknown): boolean {
  return e instanceof UpstreamError && e.transport === true
}

/** 额度耗尽类错误：HTTP 402，或 429 且错误体带 quota/insufficient 特征
 *  （火山 AccountQuotaExceeded、DeepSeek Insufficient Balance、OpenAI insufficient_quota）。
 *  中文特征（额度/配额/余额/欠费）必须保留：国内上游 429 额度体常为中文，只认英文会漏判、
 *  致使该切换的不切（2026-11-01 T28 存疑项坐实转正）。此类请求上游未产出内容，恒可安全切换
 *  （不依赖 failover_status_codes 白名单）；熔断归 'quota' 类，冷却比普通限流久。 */
const QUOTA_BODY_RE = /quota|insufficient|额度|配额|余额|欠费/i
function isQuotaError(status: number, bodyText: string): boolean {
  return status === 402 || (status === 429 && QUOTA_BODY_RE.test(bodyText))
}

/** 摘掉 content-encoding 头（大小写不敏感）：体被解压/重包为明文后不得再声明压缩 */
function withoutContentEncoding(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-encoding') continue
    out[k] = v
  }
  return out
}

/**
 * 请求级故障切换：按 pickTarget 排出的候选依次转发（手动链优先，自动备用链补尾）。
 * 安全边界：仅「传输层失败」（transport=true，请求未送达）与「额度耗尽类错误」（未产出内容）才改发下一个候选；
 * 任何其他已送达的真实 status（含 5xx）就地返回、不重放，避免重复计费。
 * 例外：gateway.failover_status_codes 显式列出的状态码（如 429/503，上游未产出内容）在还有剩余候选时切换，切换前排空响应体释放连接。
 * 候选本身不可用（key 缺失 / 协议端点缺失，candidateSkip=true）时跳到下一候选，不中止整条链。
 */
export async function forwardWithFailover(
  rt: GatewayRuntime,
  target: ResolvedTarget,
  opts: ForwardOptions & { fallbackIds?: string[] }
): Promise<FailoverResult> {
  const picked = pickTarget(rt, target, opts.fallbackIds)
  if (!picked.ok) {
    const e = new UpstreamError(503, t('自动路由：候选服务全部不可达（已熔断或下线）', 'Auto route: every candidate service is unreachable (in meltdown or down)'), t('检查各服务 enabled/priority，或 modeldock provider list 查看健康', 'Check enabled/priority of each service, or run modeldock provider list for health'))
    e.routeReason = 'down_all'
    throw e
  }
  const codes = rt.config.gateway?.failover_status_codes
  const switchable = Array.isArray(codes) && codes.length ? new Set(codes) : null
  let lastErr: unknown
  // 记录因重放而跳过的候选（传输层失败/限流切换/候选不可用），便于日志对账——
  // 数组累积去重：A→B→C 连续重放时单变量会反复覆盖，最终 reason 只剩最后一跳（CORRECT-09 ③）
  const replayedFrom: string[] = []
  const markReplay = (id: string) => {
    if (!replayedFrom.includes(id)) replayedFrom.push(id)
  }
  for (let i = 0; i < picked.ordered.length; i++) {
    const c = picked.ordered[i]
    const t0 = Date.now()
    try {
      const up = await forwardToUpstream(rt, c.target, opts)
      const ms = Date.now() - t0
      // 429/402 排空读体判别额度类（切换前本就要排空释放连接）；额度类恒可切换（未产出内容，无重复计费风险）
      let bodyText: string | undefined
      if (up.status === 429 || up.status === 402) bodyText = await readUpstreamErrorText(up.headers, up.body)
      const quota = bodyText !== undefined && isQuotaError(up.status, bodyText)
      if (up.status >= 500) recordOutcome(rt, c.providerId, { ok: false, cls: '5xx', ms })
      else if (quota) recordOutcome(rt, c.providerId, { ok: false, cls: 'quota', ms })
      else if (up.status === 429) recordOutcome(rt, c.providerId, { ok: false, cls: '429', ms })
      else if (up.status >= 400) recordOutcome(rt, c.providerId, { ok: false, ms }) // 4xx 中性：不计熔断
      else recordOutcome(rt, c.providerId, { ok: true, ms })
      const canSwitch = (switchable?.has(up.status) ?? false) || quota
      if (canSwitch && i < picked.ordered.length - 1) {
        if (bodyText === undefined) await readUpstreamErrorText(up.headers, up.body) // 排空响应释放连接后再改发
        markReplay(c.providerId)
        continue
      }
      const marks: string[] = []
      if (!c.isPrimary) marks.push(`failover_to:${c.providerId}`)
      if (replayedFrom.length) marks.push(`replayed_from:${replayedFrom.join(',')}`)
      // 已排空的错误体（429/402 但未切换）重新包一层交还客户端，错误原样保留；
      // 体已解压为明文，content-encoding 头一并摘掉，客户端不能再按压缩体解包
      const drained = bodyText
      const out: UpstreamResult = drained !== undefined
        ? { ...up, headers: withoutContentEncoding(up.headers), body: { text: async () => drained } }
        : up
      return { ...out, usedProviderId: c.providerId, reason: marks.length ? marks.join(',') : undefined }
    } catch (e) {
      // 客户端已断开：中止错误不记熔断、不迭代下一候选，直接终止整条链
      if (opts.signal?.aborted) throw e
      lastErr = e
      const ms = Date.now() - t0
      const skip = e instanceof UpstreamError && (e.transport === true || e.candidateSkip === true)
      recordOutcome(rt, c.providerId, { ok: false, cls: isTransportFailure(e) ? 'connect' : undefined, ms })
      if (skip) markReplay(c.providerId)
      else throw e // 非传输层错误：不重放，原样上抛
    }
  }
  // 链尾出口（CORRECT-09 ②）：候选全部 candidateSkip 耗尽时从未发生真实连接——透传最后一个
  // skip 错误的 status 与 hint（如钥匙环锁定的 503 + 解锁指引），routeReason 用 skip_all
  // （不能谎报 down_all）；transport 类耗尽保持既有 502 包装 + down_all 语义不变。
  if (lastErr instanceof UpstreamError && lastErr.candidateSkip === true) {
    lastErr.routeReason = 'skip_all'
    throw lastErr
  }
  const e = new UpstreamError(
    502,
    t('自动路由：所有候选服务连接失败（{msg}）', 'Auto route: all candidate services failed to connect ({msg})', { msg: (lastErr as Error)?.message }),
    t('modeldock test 逐个验证候选服务；常见根因：key 失效（modeldock provider set-key）、网络/代理不通、上游宕机', 'Verify each candidate with modeldock test; common causes: a stale key (modeldock provider set-key), network/proxy down, or the upstream being down')
  )
  e.routeReason = 'down_all'
  throw e
}

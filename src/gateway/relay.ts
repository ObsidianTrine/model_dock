import { request } from 'undici'
import zlib from 'node:zlib'
import { providerKeyRefs, resolveProviderKeys } from '../config/secrets.js'
import { matchAlias } from '../util/glob.js'
import { t } from '../util/i18n.js'
import type { Protocol, ProviderConfig } from '../config/types.js'
import { recordOutcome, pickTarget, keyInCooldown, markKeyCooldown, nextRotation, type GatewayRuntime, type OrderedCandidate, type ResolvedTarget } from './state.js'
import { isModelMeltdown, recordModelOutcome } from './state/routing.js'
import type { LogAttempt } from './state/types.js'
import { debugLog, debugOn } from './state/debuglog.js'
import { dispatcherFor } from './proxy.js'
import { acquireProviderSlot, ProviderQueueTimeoutError, providerConcurrencyLimit, queueWaitMs, type ProviderSlot } from './concurrency.js'

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
    e.cause = 'proto_endpoint_missing'
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
  /** 传输层失败分类：true = 连接层失败（请求未送达上游，可安全改发重试）；'timeout' = 请求已送达
   *  上游但等响应头超时（非流式长推理 > headers_timeout_ms 即触发）——上游可能已处理（甚至已计费）
   *  该请求，禁止自动改发重放（重复计费面），也不计入 connect 熔断（上游没挂，只是慢）；是否切换
   *  候选由 failover_status_codes 白名单显式授权。false/undefined = 已送达的应用层错误（禁止重放）。
   *  边界：ECONNRESET 若发生在响应读取阶段，上游可能已处理（甚至已计费）该请求——此处不据此判定重放安全性。 */
  transport?: boolean | 'timeout'
  /** true = 候选本身不可用（key 缺失 / 协议端点缺失等配置级问题，请求未发出）：跳到下一候选而不是中止整条链 */
  candidateSkip?: boolean
  /** 自动路由结果标记（down_all / failover / skip_all 等），用于日志 reason */
  routeReason?: string
  /** 网关侧错误归类短码（与 LogEntry.cause 同一枚举）：各抛出点就地打标，日志/前端据此显示可读原因，不再靠解析错误文本 */
  cause?: string
  /** failover 链已发生的逐候选记录（链中途抛出时经错误对象带出到日志，见 forwardWithFailover） */
  attempts?: LogAttempt[]
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
 *  那类错误本就不重试（isConnectError 不含它们）；headers 超时另有单独分类（isHeadersTimeoutError）。 */
export function isConnectTimeoutError(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } }
  const code = err?.code ?? err?.cause?.code
  return code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
}

/** 响应头超时分类（undici UND_ERR_HEADERS_TIMEOUT）：请求已送达、可能已计费——禁自动重放、
 *  不计 connect 熔断（三态语义见 UpstreamError.transport 注）。bodyTimeout 不归此分类
 *  （体超时在调用方读流阶段才浮出）；导出供单测断言分类口径。 */
export function isHeadersTimeoutError(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } }
  const code = err?.code ?? err?.cause?.code
  return code === 'UND_ERR_HEADERS_TIMEOUT'
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

/** 顶层浅扫描的单次结果。value：顶层 model 字段值（JSON 解码语义，重复键取最后一个；
 *  无 model 键或末次出现为非字符串值时 undefined）。qStart/qEnd：value 为字符串时该值的
 *  字节区间（含两侧引号，qEnd 独占），供改写热路径做字节级原位替换；否则恒为 -1。 */
interface TopModelScan {
  value: string | undefined
  qStart: number
  qEnd: number
}

/** 从 JSON 请求体顶层对象浅扫描 "model" 字段（不解码整个文档、零大对象分配）。
 *  懒解析快路径的改写判定与日志 modelAfter 的数据源。返回值：
 *  - null：无法安全判定（非顶层对象 / 扫描器遇到不支持的结构），调用方退回完整 JSON.parse
 *  - TopModelScan：value 与模型值的字节区间（含引号），见接口注释
 *  安全性：UTF-8 多字节序列不会与 ASCII 结构字节混淆（自身同步编码），按键名逐一比较，
 *  任何含转义的键直接放弃（退回完整解析），值经 JSON.parse 单独解码保证与全量解析等价。
 *  区间追踪：qStart/qEnd 随最后一次命中的 model 字符串值更新——重复键取最后一个的语义
 *  在区间上同样成立；末次出现为非字符串值时区间作废（-1），改写回落全量路径。 */
function scanTopLevelModel(body: Buffer): TopModelScan | null {
  const n = body.length
  let i = 0
  const isWs = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d
  while (i < n && isWs(body[i])) i++
  if (body[i] !== 0x7b /* { */) return null
  i++
  let last: string | undefined
  let sawModel = false
  let qStart = -1 // 最后命中的 model 字符串值字节区间（含引号）；无字符串值时保持 -1
  let qEnd = -1
  for (;;) {
    while (i < n && isWs(body[i])) i++
    if (i >= n) return null
    if (body[i] === 0x7d /* } */) return sawModel ? { value: last, qStart, qEnd } : { value: undefined, qStart: -1, qEnd: -1 }
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
        qStart = vStart - 1 // 值字节区间含两侧引号，原位替换时整段换掉
        qEnd = i + 1
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
        qStart = -1 // 末次 model 值不是字符串：无可原位替换的引号区间，改写走全量路径
        qEnd = -1
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
    if (body[i] === 0x7d /* } */) return sawModel ? { value: last, qStart, qEnd } : { value: undefined, qStart: -1, qEnd: -1 }
    return null
  }
}

/** 只取值的浅扫描包装（原导出，语义不变）：不需要字节区间的调用方用这个。 */
export function topLevelModel(body: Buffer): string | undefined | null {
  const scan = scanTopLevelModel(body)
  return scan === null ? null : scan.value
}

/** 纯模型名改写判定：仅输入字符串，输出最终改写目标。供「浅扫描快路径」（scan 非 null）与
 *  「全量解析路径」（scan === null）共用，避免两套判定逻辑漂移。语义与既有实现逐字段等价。 */
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

/** JSON 字符串安全字符白名单（模型 ID 常见字符集）：全部 ASCII 且不含 JSON 特殊字符
 *  （引号 / 反斜杠 / 控制字符），字节拼接注入无需任何转义，与 stringify 的结果语义一致。
 *  刻意收窄为白名单而非「排除法」：`/` 与 `:` 覆盖 glm-4.6:deepseek 式复合命名与路径风格
 *  ID；白名单外的名字（unicode / 引号 / 空格等）一律回落全量 parse/stringify——结果正确
 *  只是慢，宁慢勿错。 */
const SAFE_MODEL_NAME_RE = /^[A-Za-z0-9._:@\/+-]+$/

/** 字节级原位替换顶层 model 值：[qStart, qEnd) 是浅扫描产出的旧值字节区间（含两侧引号），
 *  三段拼接「前缀原样 + 带引号新值 + 后缀原样」。除 model 值外其余字节原样保留（空白 /
 *  键序 / 重复键 / 转义序列都不动），不做全量 parse/stringify——大上下文体（数百 KB ~ MB 级）
 *  下那是 5~15ms 的纯 CPU 同步开销，Node 单线程下会串行化同实例所有并发 SSE 流。
 *  三段拼接天然处理新旧值不等长（新体长度即三段之和）；下游 content-length 无需关心：客户端
 *  头在 buildUpstreamHeaders 已剥离，undici 按新 Buffer 长度自动补。
 *  调用方保证：qStart ≥ 0（旧值是字符串）且 final 通过 SAFE_MODEL_NAME_RE（无需转义）。 */
function spliceModelValue(body: Buffer, qStart: number, qEnd: number, final: string): Buffer {
  return Buffer.concat([
    body.subarray(0, qStart),
    Buffer.from('"' + final + '"', 'utf8'),
    body.subarray(qEnd),
  ])
}

/** 请求体中的模型重写：aliases 精确/通配 → default_model 兜底；未命中透传。
 *  mfGate（可选，模型级容灾 M1）：resolveModelFinal 算出 final 后、注入判定前咨询——返回备用
 *  模型名则替换 final 再改写（熔断感知预改写，闸门见 forwardToUpstream）；返回 undefined 保持
 *  final。仅 ROUTED_PATH_RE 改写路径会被咨询（非对话端点在函数头已原样返回）。
 *  三层路径（改写判定的全部输入就是模型名字符串，无需完整文档）：
 *  ① 不需改写（final === wire）：返回入参同一个 Buffer 引用（body === body），零解析零分配。
 *  ② 确需改写且浅扫描已锁定顶层 model 字符串值的字节区间（qStart ≥ 0）、新名仅含 JSON 安全
 *     字符（SAFE_MODEL_NAME_RE，无需转义）：字节级三段拼接原位替换（spliceModelValue），
 *     其余字节原样保留——大上下文体下免掉全量 JSON.parse + stringify 的纯 CPU 同步开销
 *     （数百 KB ~ MB 级 5~15ms），不再阻塞事件循环串行化同实例并发 SSE 流。
 *  ③ 其余回落全量解析路径（injectModel），行为与原实现逐字节等价：扫描器拿不准（含转义键 /
 *     非顶层对象 / 非 JSON）、顶层 model 值非字符串（需整字段替换或新增注入）、新名需转义。 */
export function rewriteModel(
  target: ResolvedTarget,
  body: Buffer,
  path: string,
  mfGate?: (final: string) => string | undefined
): { body: Buffer; modelAfter?: string } {
  if (body.length === 0 || !ROUTED_PATH_RE.test(path.split('?')[0])) return { body }
  const gated = (final: string | undefined): string | undefined =>
    final !== undefined && mfGate ? (mfGate(final) ?? final) : final
  const scan = scanTopLevelModel(body)
  if (scan !== null) {
    // 快路径：全部改写判定只用顶层 model 值字符串完成，不再全量 parse
    const final = gated(resolveModelFinal(target, scan.value))
    let modelAfter = scan.value
    if (final !== undefined && final !== scan.value) {
      if (scan.qStart >= 0 && SAFE_MODEL_NAME_RE.test(final)) {
        return { body: spliceModelValue(body, scan.qStart, scan.qEnd, final), modelAfter: final }
      }
      return injectModel(body, final) ?? { body }
    }
    if (final !== undefined) modelAfter = final
    return { body, modelAfter }
  }
  // scan === null：退回全量解析路径（行为与原实现逐字节等价）
  let json: any
  try {
    json = JSON.parse(body.toString('utf8'))
  } catch {
    return { body }
  }
  if (!json || typeof json !== 'object') return { body }
  const wire = typeof json.model === 'string' ? json.model : undefined
  const final = gated(resolveModelFinal(target, wire))
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
  const providerId = target.profile.provider
  // ---- key 池解析（P0① 多 key 池）：keys 缺省回落 [key_ref]（向后兼容，单 key 行为不变）。
  // 逐 ref 复用既有 scheme 解析（file/keychain/env/plain）；单个 ref 解析失败/缺失只跳过该 key、
  // 不致命，也**不标记失效**（读不到 ≠ 无效——失效冷却只由上游 401/403 触发，见 state/keypool.ts）
  const pool = await resolveProviderKeys(providerKeyRefs(provider))
  if (pool.length === 0) {
    // 池内 0 把可用 key（全部读取失败或未配置）：与单 key 时代「key 读取失败/不可用」同规——
    // 包成 503+hint 的 candidateSkip（非 UpstreamError 会被 errorReply 落成 500「内部错误」），
    // 把机会让给链上其余候选，不中止整条 failover 链
    const e = new UpstreamError(
      503,
      t('provider「{profile}→{name}」没有可用的 key（key 池 {n} 个引用全部不可读或未配置）', 'Provider "{profile}→{name}" has no usable key (all {n} references in the key pool are unreadable or unset)', { profile: target.profileName, name: provider.name ?? providerId, n: String(providerKeyRefs(provider).length) }),
      t('检查系统钥匙环是否已解锁（解锁后重试）；或 modeldock provider set-key {id} 重新设置 key', 'Check that the system keyring is unlocked and retry; or run modeldock provider set-key {id} to set the key again', { id: providerId })
    )
    e.candidateSkip = true
    e.cause = 'key_pool_empty'
    throw e
  }
  // key 级健康过滤（P1⑥）：处于失效冷却期（上游 401/403 标记）的 key 直接跳过；全部在冷却
  // → 本候选本轮不可用，candidateSkip 换 provider 候选。冷却 15min 后自动解封重试（key 被
  // 人工修复/上游侧恢复时无须重启网关）；配置热加载会清零冷却，换 key 立即恢复
  const now = Date.now()
  const healthy = pool.filter((k) => !keyInCooldown(rt, providerId, k.index, now))
  if (healthy.length === 0) {
    const e = new UpstreamError(
      503,
      t('provider「{profile}→{name}」的全部 key（{n} 把）都因上游 401/403 失效，冷却中', 'All {n} keys of provider "{profile}→{name}" were rejected by the upstream (HTTP 401/403) and are cooling down', { profile: target.profileName, name: provider.name ?? providerId, n: String(pool.length) }),
      t('冷却 15 分钟后自动重试；已换新 key 可在 config.toml 保存 keys（热加载立即恢复），或 modeldock provider set-key {id} 更新', 'Cooldown ends in 15 minutes and retries automatically; after replacing a key, save the keys array in config.toml (hot-reload restores it immediately) or run modeldock provider set-key {id}', { id: providerId })
    )
    e.candidateSkip = true
    e.cause = 'key_cooldown'
    throw e
  }

  // 模型级容灾（M1）熔断感知预改写：主模型已熔断（60s 窗 3 次 quota → 熔断 15min）时直接换
  // model_fallback 备用模型发送，跳过注定 402 的上游往返（LiteLLM cooldown 语义）；15min TTL
  // 过期后 isModelMeltdown 自然转 false，流量试回主模型。备用模型自身也在熔断期则不动——
  // 让它照常撞一次上游并按既有语义切换/回传，不静默吞掉。仅 provider 配了 model_fallback 才
  // 构造闸门（未配置零开销）；非对话端点 rewriteModel 函数头原样返回，闸门自然不被咨询。
  const mfMap = provider.model_fallback
  const mfGate = mfMap && Object.keys(mfMap).length > 0
    ? (final: string): string | undefined => {
        const fb = mfMap[final]
        if (!fb || fb === final) return undefined // 无映射 / 自映射：不动
        if (!isModelMeltdown(rt, providerId, final)) return undefined // 主模型未熔断：不动
        if (isModelMeltdown(rt, providerId, fb)) return undefined // 备用也在熔断：不去撞
        return fb
      }
    : undefined
  const rewritten = rewriteModel(target, opts.body, opts.path, mfGate)
  const proto = clientProtocolFromPath(opts.path, provider.protocol)
  const url = joinUpstreamUrl(upstreamEndpoint(provider, proto), opts.path, proto)
  const dispatcher = dispatcherFor(rt, provider)

  // 用指定 key 发一轮：headers 含 key，换 key 必须重建。连接错误的立即重试循环原样保留
  //（transport 失败与 key 无关，不在 key 间轮转），只按 key 维度包了一层
  const sendWithKey = async (key: string): Promise<UpstreamResult> => {
    const headers = await buildUpstreamHeaders(target, opts.headers, key, proto)
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
        // B2：拒绝类连接错误保留立即重试；超时类（已等满超时窗口）不再重试，直接抛出走 failover（最坏等待 2×→1×）
        if (attempt < opts.retries && isConnectError(e) && !isConnectTimeoutError(e)) continue
        // 响应头超时单独分类（transport='timeout'）：请求已送达、可能已计费——禁重放、不计 connect 熔断（三态见 UpstreamError.transport 注）
        const headersTimeout = isHeadersTimeoutError(e)
        // 连接超时类已等满整个窗口（error-hints-audit ③）：排查口径与拒绝类分开——「连不上」查网络，「连上无响应」查上游过慢/挂死
        const timeoutLike = isConnectTimeoutError(e)
        const errNew = new UpstreamError(
          502,
          headersTimeout
            ? t('上游响应头超时：{url}（请求已送达上游，等待响应头超时——非流式长推理常见）', 'Upstream response headers timed out: {url} (the request was delivered; waiting for response headers timed out — common with non-streaming long inference)', { url })
            : timeoutLike
              ? t('上游连接超时：{url}（已等满超时窗口仍无响应）', 'Upstream connection timed out: {url} (no response after the full timeout window)', { url })
              : t('上游连接失败：{msg}（{url}）', 'Upstream connection failed: {msg} ({url})', { msg: (e as Error).message, url }),
          headersTimeout
            ? t('上游还在处理但响应慢：非流式长推理可调大 [gateway] headers_timeout_ms（modeldock config edit）；已送达的请求网关不自动重放，避免重复计费', 'The upstream is still processing but slow: raise [gateway] headers_timeout_ms for non-streaming long inference (modeldock config edit); delivered requests are never auto-replayed to avoid double billing')
            : timeoutLike
              ? t('上游过慢或代理黑洞：modeldock test 验证；慢上游可在 modeldock config edit 调大 [gateway] 超时与 retries', 'The upstream is slow or the proxy swallows traffic: verify with modeldock test; for slow upstreams raise the [gateway] timeouts and retries in modeldock config edit')
              : t('检查网络/代理（modeldock config edit 里 provider.proxy），或 modeldock test 直接验证', 'Check network/proxy (provider.proxy in modeldock config edit), or verify directly with modeldock test')
        )
        errNew.transport = headersTimeout ? 'timeout' : true
        throw errNew
      }
    }
  }

  // round-robin 起始 key：并发 worker 的请求被均摊到池内各把（单 key 池恒取唯一一把，
  // 行为与既有单 key 完全一致），不再全体挤同一把 key 撞 429。healthy 非空已在上游保证
  //（length===0 已 candidateSkip 短路），轮转必有所得
  const first = nextRotation(rt, providerId, healthy)!
  let up = await sendWithKey(first.key)
  // 401/403 的 key 级失效处理只认模型 API 端点（ROUTED_PATH_RE，与模型改写同口径）：非对话
  // 端点的 401 可能是路径级权限/资源问题（不代表 key 失效），据此把 key 冷却 15 分钟会误伤——
  // 那类响应维持既有透传行为（客户端看得到上游错误体），不标记、不重试
  const routedApi = ROUTED_PATH_RE.test(opts.path.split('?')[0])
  if (routedApi && (up.status === 401 || up.status === 403)) {
    // 上游 401/403 = 鉴权层明确拒绝该 key，请求未进入业务处理（未产出内容、未计费）——
    // 该 key 打入冷却；换池内下一把 healthy key 重试一次是安全的，与「transport 未送达才重放」
    // 边界一致且更早：鉴权拒绝发生在请求体被消费之前，不存在重复处理/重复计费
    markKeyCooldown(rt, providerId, first.index)
    const rest = healthy.filter((k) => k.index !== first.index)
    if (rest.length > 0) {
      // 排空首个 401 响应体释放连接再改发（与 failover 切换前排空同语义）
      try { await up.body.text() } catch { /* 排空失败不影响换 key 重试 */ }
      const second = nextRotation(rt, providerId, rest)!
      up = await sendWithKey(second.key)
      if (up.status === 401 || up.status === 403) {
        // 换 key 仍被拒：本轮可用 key 全部失效（已逐把标记冷却）——candidateSkip 进入 failover
        // 链换下一个 provider 候选。仅多 key 池（≥2 把可用）会走到这里；单 key 池没有「换 key
        // 重试」，401 保持既有透传行为（客户端看得到上游错误体），失效跳过从下一次请求生效
        //（本次已标记冷却 → 下次 healthy 为空 → candidateSkip）
        markKeyCooldown(rt, providerId, second.index)
        try { await up.body.text() } catch { /* 排空释放连接；失败不影响抛错换候选 */ }
        const e = new UpstreamError(
          503,
          t('provider「{profile}→{name}」的 key 池被上游整体拒绝（HTTP 401/403，换 key 重试后仍失败，共 {n} 把）', 'The key pool of provider "{profile}→{name}" was rejected by the upstream (HTTP 401/403; still rejected after retrying with another key, {n} keys in total)', { profile: target.profileName, name: provider.name ?? providerId, n: String(pool.length) }),
          t('key 已自动冷却并切换备用服务；更换 key 后热加载立即恢复：modeldock provider set-key {id}', 'Keys were cooled down automatically and traffic moved to the fallback; replacing a key restores it immediately via hot-reload: modeldock provider set-key {id}', { id: providerId })
        )
        e.candidateSkip = true
        e.cause = 'key_pool_rejected'
        throw e
      }
    }
  }
  return up
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
  /** 最终候选的错误归类短码（仅失败时非空：quota / upstream_4xx / upstream_5xx 等），供日志 cause 列 */
  cause?: string
  /** failover 链逐候选记录：链长>1 或最终失败才有（直连成功不写，日志保持精简） */
  attempts?: LogAttempt[]
  /** 并发闸槽位释放句柄（该候选配了 max_concurrency 时非空）：响应结束（错误回包发出 / 流式读完）后必须调用，
   *  流式响应要等客户端收完才释放。转发失败路径由 forwardWithFailover 内部就地释放，不经此字段 */
  release?: () => void
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

/** 模型级容灾（model_fallback 域）单请求可合成的模型跳数安全帽：映射链在配置期已拒环，
 *  但为防超长映射链把一次请求放大成上游打爆，每请求最多合成 4 跳（同 provider 内换模型），
 *  达帽后维持原样回传（后续请求因模型熔断预改写会直接跳过已熔断段，实际链长自然收敛）。 */
const MAX_MODEL_FALLBACK_HOPS = 4

/** 上游 429 Retry-After 退避重试的等待上限：交互请求不宜长等——上游要 5s 以上才让重试时，
 *  原地干等不如维持既有 failover 语义换候选（或把 429 交还客户端自行退避） */
const RETRY_AFTER_MAX_WAIT_MS = 5_000

/** 解析 Retry-After 头（RFC 7231：delta-seconds 或 HTTP-date 两种格式）→ 距今应等待的 ms。
 *  无头 / 无法解析返回 null（不重试，维持既有语义）；HTTP-date 已过期（负差值）钳为 0（立即重试）。 */
export function parseRetryAfterMs(v: string | string[] | undefined, now = Date.now()): number | null {
  if (v == null) return null
  const raw = (Array.isArray(v) ? v[0] : String(v)).trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return Number(raw) * 1000
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}

/** 可中断 sleep：signal 触发（客户端断开）时立刻 reject，不为已离开的客户端占着并发槽等退避 */
function sleepInterruptible(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 并发闸排队超时 → 429 + 可操作 hint：点名哪个服务满了、建议调大 max_concurrency 或降低客户端并发 */
function queueTimeoutError(e: ProviderQueueTimeoutError, p: ProviderConfig | undefined): UpstreamError {
  const err = new UpstreamError(
    429,
    t('服务「{name}」并发已达上限 {n}，排队等待 {ms}ms 仍无空闲槽位', 'Provider "{name}" is at its concurrency limit of {n}; no free slot after queuing for {ms}ms', { name: p?.name ?? e.providerId, n: e.limit, ms: e.waitMs }),
    t('调大 config.toml 中该服务的 max_concurrency（Web 控制台「编辑服务」可改），或降低客户端并发数', 'Raise max_concurrency for this provider in config.toml (editable under "Edit Service" in the web console), or reduce client concurrency')
  )
  err.routeReason = 'queue_full'
  err.cause = 'queue_full'
  return err
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

/** 自动候选（自动补尾 / 避开补链，OrderedCandidate.auto）的模型相容过滤：按「别名/兜底改写后实际
 *  会发给候选的模型名」对照候选服务目录（provider.models），目录已管理（非空）且不含该模型的候选
 *  直接剔除——重放过去必然 400 Unsupported model（2026-11-08 实证：bigmodel-2 限流 429 → 自动补尾
 *  把 glm-4.7 原样发往不支持它的服务，整链失败，错误日志被「模型不存在」噪音淹没、真因 429 反被掩盖）。
 *  显式配置不受限：主候选 / 手动 fallback（含 <provider>:<model> 映射）/「下一个切换」/ 窗口目标照旧。
 *  目录未管理（models 缺省或空）不拦——没有证据不判死刑，维持「模型归客户端管」的透传语义。
 *  wire（请求体顶层 model）拿不准（扫描 null）或非 routed path 时整体不过滤；undefined（无 model 键）
 *  时仍按 resolveModelFinal 判定——改写层会给无 model 请求注入 default_model，对账口径必须一致。
 *  被剔候选留痕：attempts 记 note=model_mismatch（与 queue_full 同风格），modelSkip 供 reason 标记。 */
function filterModelCompatible(
  ordered: OrderedCandidate[],
  wire: string | undefined | null,
  routedPath: boolean,
  attempts: LogAttempt[],
  modelSkip: string[]
): OrderedCandidate[] {
  if (!routedPath || wire === null) return ordered
  const kept: OrderedCandidate[] = []
  for (const c of ordered) {
    if (!c.auto || c.isPrimary) {
      kept.push(c)
      continue
    }
    const final = resolveModelFinal(c.target, wire)
    const catalog = c.target.provider.models
    const managed = !!catalog && Object.keys(catalog).length > 0
    if (!final || !managed || catalog[final] !== undefined) {
      kept.push(c)
      continue
    }
    if (!modelSkip.includes(c.providerId)) modelSkip.push(c.providerId)
    attempts.push({ provider: c.providerId, note: 'model_mismatch' })
  }
  return kept.length === ordered.length ? ordered : kept
}

/**
 * 请求级故障切换：按 pickTarget 排出的候选依次转发（手动链优先，自动备用链补尾）。
 * 安全边界：仅 transport=true（未送达）与额度耗尽类（未产出内容）才改发下一候选；已送达的真实
 * status（含 5xx）就地返回、不重放；headers 超时（transport='timeout'，已送达可能已计费）默认不切换、
 * 不计 connect 熔断，仅 failover_status_codes 白名单显式含其包装 status 且有剩余候选才切（三态见 UpstreamError.transport 注）。
 * 例外：failover_status_codes 列出的状态码（如 429/503，未产出内容）有剩余候选时切换，切换前排空响应体释放连接。
 * 候选本身不可用（key 缺失 / 协议端点缺失，candidateSkip=true）时跳到下一候选，不中止整条链。
 * 并发闸（P0②）：每个候选转发前先取 per-provider 并发槽（max_concurrency，0/缺省不限），
 * 满载排队 ≤ gateway.queue_wait_ms；超时候选被跳过（queue_full 标记），链尾回 429+hint。
 * 429 退避（P0③）：上游 429 带 Retry-After 且 ≤ 5s 时同候选原地等待重试一次（额度体除外），留痕 retried_429:。
 * 模型相容：自动补尾/避开补链候选按请求模型（别名改写后）对照服务目录，目录已管理且不含该模型的
 * 不重放（model_mismatch 留痕，见 filterModelCompatible）；显式配置（手动链/钉定/窗口）不受限。
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
  // 并发闸排队等待上限（每次请求读实时配置：热加载 queue_wait_ms 即时生效）
  const waitMs = queueWaitMs(rt.config.gateway)
  let lastErr: unknown
  // 记录因重放而跳过的候选（传输层失败/限流切换/候选不可用），便于日志对账——
  // 数组累积去重：A→B→C 连续重放时单变量会反复覆盖，最终 reason 只剩最后一跳（CORRECT-09 ③）
  const replayedFrom: string[] = []
  const markReplay = (id: string) => {
    if (!replayedFrom.includes(id)) replayedFrom.push(id)
  }
  // 并发闸排队超时被跳过的候选与做了 429 退避重试的候选（reason 留痕，同 replayed_from 风格）
  const queueFull: string[] = []
  const retried429: string[] = []
  // 模型级容灾（M1）：本请求内已合成的备用模型序列（reason marks 的 fallback_to:）与跳数
  // （安全帽 MAX_MODEL_FALLBACK_HOPS，见常量注）
  const fallbackTo: string[] = []
  let mfHops = 0
  // 因模型目录不含请求模型被剔除的自动候选（reason 留痕，同 replayed_from 风格）
  const modelMismatch: string[] = []
  // 逐候选 attempt 记录（日志 attempts 列）：真实转发记 status+ms，被跳过记 note 短码——
  // 排障时能看出「哪个候选因什么被跳过」，不再只有 replayed_from:<id> 一个 id 痕迹
  const attempts: LogAttempt[] = []
  /** 候选失败/跳过的原因短码：抛出点已打标（UpstreamError.cause）的优先；传输层失败按 transport 分类 */
  const classifyAttemptError = (e: unknown): string | undefined => {
    if (!(e instanceof UpstreamError)) return 'connect_failed'
    return e.cause ?? (e.transport === 'timeout' ? 'headers_timeout' : e.transport === true ? 'connect_failed' : undefined)
  }
  // 自动候选模型相容过滤（见 filterModelCompatible）：目录不含请求模型的服务不重放，剔除留痕 attempts/reason
  const cands = filterModelCompatible(
    picked.ordered,
    topLevelModel(opts.body),
    ROUTED_PATH_RE.test(opts.path.split('?')[0]),
    attempts,
    modelMismatch,
  )
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]
    const t0 = Date.now()
    // 并发闸（P0②）：转发前对实际选中候选的 provider 取槽；满载排队 ≤ queue_wait_ms。
    // 槽位生命周期到响应结束（成功路径挂在返回值上由 server.ts 释放）；失败路径就地释放
    let slot: ProviderSlot | undefined
    const limit = providerConcurrencyLimit(c.target.provider)
    if (limit > 0) {
      try {
        slot = await acquireProviderSlot(rt, c.providerId, limit, waitMs, opts.signal)
      } catch (e) {
        // 排队超时 ≠ 上游故障（不记熔断）：链中还有候选就跳过去换一家，链尾才回 429+hint
        if (e instanceof ProviderQueueTimeoutError) {
          if (i < cands.length - 1) {
            if (!queueFull.includes(c.providerId)) queueFull.push(c.providerId)
            attempts.push({ provider: c.providerId, note: 'queue_full' })
            markReplay(c.providerId)
            continue
          }
          const qe = queueTimeoutError(e, rt.config.providers[c.providerId])
          qe.attempts = attempts
          throw qe
        }
        throw e // 客户端断开（aborted）：原样上抛，handleRequest 落 499
      }
    }
    try {
      let up = await forwardToUpstream(rt, c.target, opts)
      // 429 退避（P0③）：带 Retry-After 且 ≤ 5s 时原地等待后同候选重试一次（429 = 请求未被上游处理，
      // 重放无重复计费风险）；无头 / 超过 5s / 额度耗尽体维持既有 failover 语义。留痕 retried_429:<id>。
      let drained: string | undefined
      if (up.status === 429) {
        const raMs = parseRetryAfterMs(up.headers['retry-after'])
        if (raMs !== null && raMs <= RETRY_AFTER_MAX_WAIT_MS) {
          drained = await readUpstreamErrorText(up.headers, up.body) // 排空释放连接后再等待/重试
          if (!isQuotaError(up.status, drained)) {
            if (raMs > 0) await sleepInterruptible(raMs, opts.signal)
            if (!retried429.includes(c.providerId)) retried429.push(c.providerId)
            up = await forwardToUpstream(rt, c.target, opts)
            drained = undefined // 重试产生的是新响应，体未读
          }
        }
      }
      const ms = Date.now() - t0
      attempts.push({ provider: c.providerId, status: up.status, ms })
      // 429/402 排空读体判别额度类（切换前本就要排空释放连接）；额度类恒可切换（未产出内容，无重复计费风险）
      let bodyText: string | undefined
      if (up.status === 429 || up.status === 402) bodyText = drained ?? (await readUpstreamErrorText(up.headers, up.body))
      const quota = bodyText !== undefined && isQuotaError(up.status, bodyText)
      // 本次 attempt 实际发送的模型（rewriteModel 产物；非对话端点 / 体无 model 时 undefined）：
      // 模型级熔断记账与链尾映射查找的 key
      const sentModel = up.modelAfter
      const mfMap = rt.config.providers[c.providerId]?.model_fallback
      if (up.status >= 500) recordOutcome(rt, c.providerId, { ok: false, cls: '5xx', ms })
      else if (quota && mfMap && Object.keys(mfMap).length > 0 && sentModel !== undefined) {
        // 模型级容灾记账分流（M1）：quota 事件在 (provider, model) 粒度记账（recordModelOutcome），
        // provider 级熔断窗口不累计（modelScoped）——否则 provider 熔丝会把同服务备用模型一起封死
        // （功能自我否定）；海况是 provider 级上游健康视图，经 recordOutcome 内部 recordSeaOutcome
        // 照旧记账，402 风暴对风暴闸保持可见。connect/429/5xx 与未配映射路径行为不变。
        recordOutcome(rt, c.providerId, { ok: false, cls: 'quota', ms, modelScoped: true })
        recordModelOutcome(rt, c.providerId, sentModel, { ok: false, cls: 'quota', ms })
      }
      else if (quota) recordOutcome(rt, c.providerId, { ok: false, cls: 'quota', ms })
      else if (up.status === 429) recordOutcome(rt, c.providerId, { ok: false, cls: '429', ms })
      else if (up.status >= 400) recordOutcome(rt, c.providerId, { ok: false, ms }) // 4xx 中性不计熔断（口径见 state/routing.ts recordOutcome 注）
      else recordOutcome(rt, c.providerId, { ok: true, ms })
      const canSwitch = (switchable?.has(up.status) ?? false) || quota
      if (canSwitch && i < cands.length - 1) {
        if (bodyText === undefined) await readUpstreamErrorText(up.headers, up.body) // 排空响应释放连接后再改发
        slot?.release() // failover 切换候选：先释放旧候选槽再取新候选槽（下一轮自行取）
        slot = undefined
        markReplay(c.providerId)
        if (debugOn()) debugLog('relay', 'skip', { provider: c.providerId, code: quota ? 'quota' : `http_${up.status}`, ms })
        continue
      }
      // 模型级容灾（M1 链尾合成）：到这里还带 quota 的必是链尾候选（链中段已在上方分支切走）——
      // 同 provider 内按 model_fallback 映射换备用模型再试一跳。合成候选 push 进 cands（本次迭代的
      // 候选数组：无剔除时即 picked.ordered 同一引用，有剔除时为过滤副本，push picked.ordered 进不了循环）；
      // 备用模型再 402 时按其键继续查映射（配置期已拒环）。
      // 备用模型已熔断 / 达跳数安全帽 / 该模型无映射 → 不合成，402 维持原样回传（现状行为）。
      if (quota && sentModel !== undefined && mfMap) {
        const fbModel = mfMap[sentModel]
        if (fbModel && mfHops < MAX_MODEL_FALLBACK_HOPS && !isModelMeltdown(rt, c.providerId, fbModel)) {
          cands.push({
            target: { ...c.target, modelOverride: fbModel }, // 全新对象：绝不改共享候选引用
            providerId: c.providerId,
            isPrimary: false,
            modelOverride: fbModel,
            modelFallback: true,
          })
          mfHops++
          if (!fallbackTo.includes(fbModel)) fallbackTo.push(fbModel)
          slot?.release() // 同 provider 下一轮取新槽：先释放旧槽（与切 provider 候选同规，防槽位泄漏）
          slot = undefined
          if (debugOn()) debugLog('relay', 'skip', { provider: c.providerId, code: 'model_fallback', model: fbModel, ms })
          continue
        }
      }
      const marks: string[] = []
      if (!c.isPrimary && !c.modelFallback) marks.push(`failover_to:${c.providerId}`) // modelFallback 候选 provider 没换，不打 failover_to
      if (fallbackTo.length) marks.push(`fallback_to:${fallbackTo.join(',')}`)
      if (queueFull.length) marks.push(`queue_full:${queueFull.join(',')}`)
      if (retried429.length) marks.push(`retried_429:${retried429.join(',')}`)
      if (modelMismatch.length) marks.push(`model_mismatch:${modelMismatch.join(',')}`)
      if (replayedFrom.length) marks.push(`replayed_from:${replayedFrom.join(',')}`)
      // 已排空的错误体（429/402 但未切换）重新包一层交还客户端，错误原样保留；
      // 体已解压为明文，content-encoding 头一并摘掉，客户端不能再按压缩体解包
      const outDrained = bodyText
      const out: UpstreamResult = outDrained !== undefined
        ? { ...up, headers: withoutContentEncoding(up.headers), body: { text: async () => outDrained } }
        : up
      // 成功路径不在此释放：流式响应要等客户端收完才释放槽（server.ts 于响应结束后调用 release）
      const held = slot
      // attempts 只在「发生过改发」或「最终失败」时随行（直连成功不写，日志保持精简）
      const finalBad = out.status >= 400 || !!quota
      return {
        ...out,
        usedProviderId: c.providerId,
        reason: marks.length ? marks.join(',') : undefined,
        ...(finalBad ? { cause: quota ? 'quota' : out.status >= 500 ? 'upstream_5xx' : 'upstream_4xx' } : {}),
        ...(attempts.length > 1 || finalBad ? { attempts } : {}),
        ...(held ? { release: () => held.release() } : {}),
      }
    } catch (e) {
      slot?.release() // 异常路径必须释放槽，否则该 provider 永久少一个并发额度
      slot = undefined
      // 客户端已断开：中止错误不记熔断、不迭代下一候选，直接终止整条链
      if (opts.signal?.aborted) throw e
      lastErr = e
      const ms = Date.now() - t0
      // 响应头超时（transport='timeout'）：请求已送达、可能已计费——禁按「未送达」自动改发、不计 connect 熔断；
      // 是否切换由 failover_status_codes 白名单显式授权（包装 status=502，还有剩余候选才切；三态见 UpstreamError.transport 注）
      const timeoutTransport = e instanceof UpstreamError && e.transport === 'timeout'
      const whitelistSwitch =
        timeoutTransport && i < cands.length - 1 && (switchable?.has((e as UpstreamError).status) ?? false)
      const skip = e instanceof UpstreamError && (e.transport === true || e.candidateSkip === true)
      recordOutcome(rt, c.providerId, { ok: false, cls: isTransportFailure(e) ? 'connect' : undefined, ms })
      const note = classifyAttemptError(e)
      attempts.push(note ? { provider: c.providerId, note, ms } : { provider: c.providerId, ms })
      if (skip || whitelistSwitch) {
        markReplay(c.providerId)
        if (debugOn()) debugLog('relay', 'skip', { provider: c.providerId, code: note, ms })
      } else {
        // 非传输层错误：不重放，原样上抛——链上已发生的 attempts 经错误对象带出（供日志 cause/attempts 列）
        if (e instanceof UpstreamError) e.attempts = attempts
        throw e
      }
    }
  }
  // 链尾出口（CORRECT-09 ②）：候选全部 candidateSkip 耗尽时从未发生真实连接——透传最后一个
  // skip 错误的 status 与 hint（如钥匙环锁定的 503 + 解锁指引），routeReason 用 skip_all
  // （不能谎报 down_all）；transport 类耗尽（含白名单授权切换后的 headers 超时耗尽）保持
  // 既有 502 包装 + down_all 语义不变。
  if (lastErr instanceof UpstreamError && lastErr.candidateSkip === true) {
    lastErr.routeReason = 'skip_all'
    lastErr.attempts = attempts
    throw lastErr
  }
  const e = new UpstreamError(
    502,
    t('自动路由：所有候选服务连接失败（{msg}）', 'Auto route: all candidate services failed to connect ({msg})', { msg: (lastErr as Error)?.message }),
    t('modeldock test 逐个验证候选服务；常见根因：key 失效（modeldock provider set-key）、网络/代理不通、上游宕机', 'Verify each candidate with modeldock test; common causes: a stale key (modeldock provider set-key), network/proxy down, or the upstream being down')
  )
  e.routeReason = 'down_all'
  e.cause = 'connect_failed'
  e.attempts = attempts
  throw e
}

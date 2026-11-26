import type http from 'node:http'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import { safeEqual } from '../util/safe-equal.js'
import { localIsoTs } from '../util/time.js'
import type { Config, ModelMeta } from '../config/types.js'
import { checkTokenLimits, logRequest, pickTarget, recordTokenUsage, resolveByProfile, resolveTarget, type GatewayRuntime, type LogEntry, type LogAttempt, type ResolvedTarget } from './state.js'
import { createUsageTap } from './usage.js'
import { filterResponseHeaders, forwardWithFailover, parseRatelimitHeaders, readUpstreamErrorText, translateUpstreamError, UpstreamError, type UpstreamResult } from './relay.js'
import { maxBodyBytes, readBody, sendError } from './admin-shared.js'
import { healthView } from './routes/system.js'
import { handleAdmin } from './admin.js'
import { t } from '../util/i18n.js'

/** Claude Code gateway discovery 的硬过滤：模型 ID 不含 claude/anthropic 字样的条目全部丢弃
 *  （2.1.296 二进制实测：filter(te=>/(claude|anthropic)/i.test(te.id))，全滤光时
 *  「0 usable models after filter」，/model 选择器只剩内置档位）。 */
const DISCOVERY_ID_RE = /(claude|anthropic)/i

/** discovery 场景服务的模型 ID：非 Claude 系 ID 加 `anthropic.` 前缀别名（Bedrock 同款惯例）
 *  以通过上述过滤；转发时 rewriteModel 按服务目录还原真实 ID，picker 标签仍显示 display_name。 */
function discoveryModelId(id: string): string {
  return DISCOVERY_ID_RE.test(id) ? id : `anthropic.${id}`
}

/** 单条目录条目的响应形状：Anthropic 形状为主（type/display_name），兼容 OpenAI 字段
 *  （object/created/owned_by）——两类 SDK 各取所需，多余字段互不解析。列表与单模型查询
 *  共用此映射，保证两端口径永远一致；discoveryAliases=true（请求带 anthropic-version 头，
 *  即 Claude Code discovery）时对非 Claude 系 ID 加 anthropic. 前缀别名，否则原样。 */
function modelEntryPayload(rawId: string, m: ModelMeta, providerId: string, discoveryAliases: boolean) {
  const id = discoveryAliases ? discoveryModelId(rawId) : rawId
  return {
    id,
    type: 'model',
    display_name: m.display_name || rawId,
    object: 'model',
    created: 0,
    owned_by: providerId,
  }
}

/** 本地合成 /v1/models 响应：Anthropic 形状为主（type/display_name + 分页字段），兼容 OpenAI 字段。
 *  目录按写入顺序排列；有 display_name 的显示名称、没有的回落 ID；目录为空返回空列表
 *  （picker 无自定义项，档位请求仍走内置名兜底改写，不劣化）。 */
function modelsListPayload(cfg: Config, providerId: string, discoveryAliases: boolean) {
  const provider = cfg.providers[providerId]
  const data = Object.entries(provider?.models ?? {}).map(([rawId, m]) => modelEntryPayload(rawId, m, providerId, discoveryAliases))
  return {
    data,
    first_id: data[0]?.id,
    has_more: false,
    last_id: data[data.length - 1]?.id,
  }
}

/** /v1/models 目录服务解析（列表与单模型查询共用）：?provider= 显式点名服务（未知服务报错）；
 *  未点名复用 pickTarget 首候选（含钉定/定时窗口），把目录切到真正在用的服务，保证目录与
 *  实际请求同源。失败返回可操作的错误描述，由调用方经 sendError 应答。 */
function resolveCatalogProvider(
  rt: GatewayRuntime,
  target: ResolvedTarget,
  wanted: string
): { ok: true; providerId: string } | { ok: false; status: 404; message: string; hint: string } {
  if (wanted && !rt.config.providers[wanted]) {
    return {
      ok: false,
      status: 404,
      message: t('服务「{id}」不存在', 'Service "{id}" not found', { id: wanted }),
      hint: t('modeldock provider list 查看服务列表，或在 Web 控制台「服务」页确认 ID', 'Run modeldock provider list to view services, or check the ID on the Services page of the web console'),
    }
  }
  if (wanted) return { ok: true, providerId: wanted }
  const picked = pickTarget(rt, target, target.profile.fallback)
  return { ok: true, providerId: (picked.ok ? picked.ordered[0].target : target).profile.provider }
}

function extractToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  const xk = req.headers['x-api-key']
  if (typeof xk === 'string') return xk.trim()
  return null
}


export async function handleRequest(
  rt: GatewayRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  o: { idle: number; retries: number }
): Promise<void> {
  const started = Date.now()
  const url = req.url ?? '/'
  const method = (req.method ?? 'GET').toUpperCase()

  // 请求关联 ID（8 字节 hex）：响应头 x-modeldock-request-id + 本请求全部日志条目 requestId +
  // 错误响应体 modeldock.requestId（sendError 自动读响应头）三处一致，一次失败请求可凭 id 全链路检索。
  const requestId = randomBytes(8).toString('hex')
  res.setHeader('x-modeldock-request-id', requestId)

  const log = (entry: Omit<LogEntry, 'ts'>) => {
    logRequest(rt, { ...entry, ts: localIsoTs(), requestId })
  }

  if (url.startsWith('/_modeldock/')) {
    return handleAdmin(rt, req, res, o, started)
  }

  // 网站图标：直接回 204、不走鉴权，避免浏览器 favicon 请求打出一条 401 噪音
  if (url === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }

  // 根路径引导：无认证头的 GET / 不可能是有效代理调用，302 到 Web 控制台；
  // 带 token 的请求、POST、其余路径不受影响，仍走下方认证 → 代理
  if (method === 'GET' && url.split('?')[0] === '/' && !extractToken(req) && req.headers['x-modeldock-admin'] === undefined) {
    res.writeHead(302, { location: '/_modeldock/ui' })
    res.end()
    return
  }

  // 数据面健康探针 GET /v1/health：与管理面 /_modeldock/health 同一 healthView、同样免鉴权——
  // 探活不该需要凭据。必须在下方鉴权解析之前分支（否则未带 token 先落 401）；紧邻 /v1/models
  // 同区便于对照。全量自检字段缺失时降级返回部分（亚健康也要能答）。
  if (method === 'GET' && url.split('?')[0] === '/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(await healthView(rt)))
    return
  }

  const adminHeader = req.headers['x-modeldock-admin']
  const adminOk = typeof adminHeader === 'string' && safeEqual(adminHeader, rt.adminToken)
  const token = extractToken(req)
  const resolved = adminOk
    ? resolveByProfile(rt, req.headers['x-modeldock-profile'] as string | undefined)
    : token
      ? resolveTarget(rt, token)
      : { ok: false as const, status: 401, message: t('缺少认证 token（Authorization: Bearer 或 x-api-key）', 'Missing auth token (Authorization: Bearer or x-api-key)'), hint: t('各 harness 的 token 见 modeldock status', 'Tokens for each harness are listed by modeldock status') }

  if (!resolved.ok) {
    // 401 归因：无效 token 只取前 8 字符记入 tokenHint（绝不写完整 token），并按前缀反查已知
    // harness——命中时 err 文案直接点名是哪个客户端拿错了/过期 token，排查不用逐个对表
    let tokenHint: string | undefined
    let err = resolved.message
    if (!adminOk && token && resolved.status === 401) {
      const hint8 = token.slice(0, 8)
      tokenHint = hint8
      const known = [...rt.tokens].find(([k]) => k.startsWith(hint8))?.[1]
      if (known) {
        err += t('（token 前缀 {hint}… 属于 harness「{h}」）', ' (token prefix {hint}… belongs to harness "{h}")', { hint: hint8, h: known })
      }
    }
    log({ harness: '-', profile: '-', provider: '-', path: url, status: resolved.status, err, ms: Date.now() - started, cause: 'unauthorized', ...(tokenHint ? { tokenHint } : {}) })
    return sendError(res, resolved.status, resolved.message, resolved.hint)
  }
  const { target } = resolved

  // 本地合成 GET /v1/models：默认返回当前选路目标服务的模型目录（用户拉取/筛选过的），不透传上游——
  // 上游目录 ≠ 用户目录，且上游未必实现该端点。Claude Code 开 CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
  // 后据此填充 /model 选择器；选路复用 pickTarget 首候选（含钉定/定时窗口），保证列表与实际请求同源。
  // ?provider=<服务ID> 显式点名服务：返回该服务目录、不影响路由（调用方按任务挑服务选型用）。
  // 带 anthropic-version 头 = Claude Code discovery：对非 Claude 系 ID 加 anthropic. 前缀别名
  // 以通过其 ID 过滤（DISCOVERY_ID_RE），转发侧按目录还原。
  if (method === 'GET' && url.split('?')[0] === '/v1/models') {
    const wanted = (new URL(req.url ?? '/', 'http://x').searchParams.get('provider') ?? '').trim()
    const cat = resolveCatalogProvider(rt, target, wanted)
    if (!cat.ok) return sendError(res, cat.status, cat.message, cat.hint)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(modelsListPayload(rt.config, cat.providerId, req.headers['anthropic-version'] !== undefined)))
    return
  }

  // GET /v1/models/{id}：单模型查询（OpenAI 兼容面）。本地按目录直查，不进 relay——未知路径
  // 透传上游会让别名 ID（下游用别名/anthropic. 前缀，上游只认真实 ID）撞上游自己的目录或
  // 上游 404，与「目录不透传」口径分裂。与列表同理不耗上游，放在限额检查之前。
  // ID 双命名空间：真实目录 ID 直查优先；anthropic. 前缀（discovery picker 用的 ID）剥离后兜底。
  if (method === 'GET' && url.split('?')[0].startsWith('/v1/models/')) {
    let rawId = url.split('?')[0].slice('/v1/models/'.length)
    try {
      rawId = decodeURIComponent(rawId)
    } catch {
      // 非法转义序列保留原样参与匹配，未命中即 404
    }
    const wanted = (new URL(req.url ?? '/', 'http://x').searchParams.get('provider') ?? '').trim()
    const cat = resolveCatalogProvider(rt, target, wanted)
    if (!cat.ok) return sendError(res, cat.status, cat.message, cat.hint)
    const models = rt.config.providers[cat.providerId]?.models ?? {}
    const stripped = rawId.startsWith('anthropic.') ? rawId.slice('anthropic.'.length) : ''
    const catalogId = models[rawId] ? rawId : stripped && models[stripped] ? stripped : undefined
    if (!catalogId) {
      return sendError(
        res,
        404,
        t('模型「{id}」不在服务「{p}」的模型目录', 'Model "{id}" is not in the model catalog of service "{p}"', { id: rawId, p: cat.providerId }),
        t('GET /v1/models 查看该服务的模型目录', 'GET /v1/models lists the model catalog of the service')
      )
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(modelEntryPayload(catalogId, models[catalogId], cat.providerId, req.headers['anthropic-version'] !== undefined)))
    return
  }

  // 数据面限额（水密舱熔断丝）：检查放在 /v1/models 本地合成目录之后——它不耗上游，不该被限，
  // 只守真正的转发路径。超限 429 不打上游；计数器在 rt 内存（重启清零），见 state/tokenlimits.ts。
  const limitTrip = checkTokenLimits(rt, target.harness)
  if (limitTrip) {
    const limits = rt.config.harness[target.harness]?.limits
    const msg =
      limitTrip === 'rpm'
        ? t('客户端「{h}」已触发限流：每分钟请求数超过上限 {n}', 'Client "{h}" hit the rate limit: more than {n} requests per minute', { h: target.harness, n: limits?.rpm ?? 0 })
        : t('客户端「{h}」已触发日限额：今日 token 用量达到上限 {n}', 'Client "{h}" hit the daily token cap: today\'s usage reached the limit of {n}', { h: target.harness, n: limits?.daily_tokens ?? 0 })
    const hint = t('限额配置在 config.toml [harness.{h}] 的 limits 键（rpm / daily_tokens，删除即不限），改后热加载生效', 'Limits live under the limits key of [harness.{h}] in config.toml (rpm / daily_tokens; remove to disable) and hot-reload', { h: target.harness })
    log({ harness: target.harness, profile: target.profileName, provider: '-', path: url, status: 429, ms: Date.now() - started, err: msg, cause: 'local_limit' })
    return sendError(res, 429, msg, hint)
  }

  const body = await readBody(req, maxBodyBytes(rt.config))
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v
    else if (Array.isArray(v)) headers[k] = v[0]
  }

  // 客户端断开即中止转发：非流式长推理动辄分钟级，客户端早走人了，继续等只是白烧上游 token。
  // res 'close' 在正常完成时也会触发，用 writableEnded 区分真断开；响应头已到后的管道阶段由
  // pipeline 的流销毁语义兜底，这里只管最贵的「等上游响应」阶段
  const fwdAbort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) fwdAbort.abort()
  })
  let result: UpstreamResult & { usedProviderId?: string; reason?: string; cause?: string; attempts?: LogAttempt[]; release?: () => void }
  try {
    // 故障切换常开：主候选不可达时按 pickTarget 候选链自动改发（备用链/「下一个切换」钉定），不与「程序自动选主」开关绑定；
    // pickTarget 内部再按 auto_failover 决定定时窗口是否参与选主。候选链只有主服务时行为与直连等价（循环一次）。
    result = await forwardWithFailover(rt, target, {
      method,
      path: url,
      headers,
      body,
      idleTimeoutMs: o.idle,
      retries: o.retries,
      fallbackIds: target.profile.fallback,
      signal: fwdAbort.signal,
    })
  } catch (e) {
    if (fwdAbort.signal.aborted) {
      // 客户端已离开：无处应答，也不进 500 噪音；499（约定俗成的 client closed request）进请求日志
      log({ harness: target.harness, profile: target.profileName, provider: target.profile.provider, path: url, status: 499, ms: Date.now() - started, err: t('客户端已断开，转发中止', 'Client disconnected; forwarding aborted'), cause: 'client_abort' })
      return
    }
    if (e instanceof UpstreamError) {
      log({
        harness: target.harness,
        profile: target.profileName,
        provider: target.profile.provider,
        model: target.profile.default_model,
        path: url,
        status: e.status ?? 502,
        ms: Date.now() - started,
        err: e.message,
        reason: e.routeReason ?? undefined,
        cause: e.cause ?? e.routeReason,
        ...(e.hint ? { hint: e.hint } : {}),
        ...(e.attempts?.length ? { attempts: e.attempts } : {}),
      })
      return sendError(res, e.status, e.message, e.hint)
    }
    throw e
  }
  // 自动路由后以最终生效的 provider 记日志
  const providerId = result.usedProviderId ?? target.profile.provider
  const reason = result.reason
  const model = result.modelAfter ?? target.profile.default_model
  // 上游限流信号留痕（编排器 429 风暴前降并发的数据源）：带限流头才记，全缺返回 undefined
  // → 日志条目零新增字段（只增不改，既有消费方零感知）。成功/错误/流中断三处落账共用同一份解析。
  const ratelimit = parseRatelimitHeaders(result.headers)

  const resHeaders = filterResponseHeaders(result.headers)
  if (result.status >= 400) {
    // 错误体重新序列化后回发：先按 content-encoding 解码（上游 gzip 错误体直读是乱码），
    // 回发头摘掉 content-encoding —— 明文 JSON 再声明 gzip 会让客户端解包失败报 "terminated"
    const text = await readUpstreamErrorText(result.headers, result.body)
    const wrapped = translateUpstreamError(result.status, text, {
      providerId,
      model,
    })
    const errHeaders: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(resHeaders)) {
      if (k.toLowerCase() === 'content-encoding') continue
      errHeaders[k] = v
    }
    res.writeHead(result.status, { ...errHeaders, 'content-type': 'application/json' })
    res.end(wrapped)
    // hint 从 modeldock 信封拆出单独成列（err 列 200 字符截断不再吞掉可操作建议）；
    // cause/attempts 来自 failover 链（attempts 缺省=直连失败）
    let hint: string | undefined
    try {
      hint = (JSON.parse(wrapped) as { modeldock?: { hint?: string } })?.modeldock?.hint
    } catch {
      /* wrapped 恒为 translateUpstreamError 产出的 JSON，防御性兜底 */
    }
    log({
      harness: target.harness,
      profile: target.profileName,
      provider: providerId,
      model,
      path: url,
      status: result.status,
      ms: Date.now() - started,
      err: wrapped.slice(0, 200),
      reason,
      cause: result.cause ?? (result.status >= 500 ? 'upstream_5xx' : 'upstream_4xx'),
      ...(hint ? { hint } : {}),
      ...(result.attempts?.length ? { attempts: result.attempts } : {}),
      ...(ratelimit ? { ratelimit } : {}),
    })
    result.release?.() // 错误回包已发出，释放该候选的并发槽
    return
  }

  res.writeHead(result.status, resHeaders)
  res.flushHeaders()
  // usage 旁路解析：tap 字节原样透传（转发行为零改变），SSE/JSON 尽力而为提取 token 用量
  // content-type 单值头，防御性取首值（上游异常重复时不致类型崩）
  const resCt = result.headers['content-type']
  const usageTap = createUsageTap(Array.isArray(resCt) ? resCt[0] : resCt)
  const usage = usageTap.getUsage()
  try {
    await pipeline(result.body as any, usageTap, res)
    log({ harness: target.harness, profile: target.profileName, provider: providerId, model, path: url, status: result.status, ms: Date.now() - started, reason, usage, ...(ratelimit ? { ratelimit } : {}) })
  } catch (e) {
    log({ harness: target.harness, profile: target.profileName, provider: providerId, model, path: url, status: result.status, ms: Date.now() - started, err: t('流中断：{msg}', 'Stream interrupted: {msg}', { msg: (e as Error).message }), reason, usage, ...(ratelimit ? { ratelimit } : {}), cause: 'stream_interrupt' })
  } finally {
    // 流式响应等响应结束（读完/中断）才释放并发槽——响应头到了就放会让 max_concurrency 少算在途流量
    result.release?.()
  }
  // 当日花费累计（水密舱熔断丝的用量侧）：成功与流中断都算已消耗；无 limits 配置时静默跳过
  recordTokenUsage(rt, target.harness, usage)
}

import http from 'node:http'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import { safeEqual } from '../util/safe-equal.js'
import { CONSOLE_CSP } from './console-shared.js'
import { randomToken } from '../util/fsx.js'
import { localIsoTs } from '../util/time.js'
import { VERSION } from '../version.js'
import { DEFAULT_GATEWAY_PORT, DEFAULT_LOG_RETENTION_DAYS, type Config, type ModelMeta } from '../config/types.js'
import { syncBakedClientsForDisplayRoute } from '../ops.js'
import { refreshCatalog } from '../providers/catalog.js'
import { checkTokenLimits, logAudit, logEvent, logRequest, pickTarget, pruneExpiredLogs, readGatewayState, recordTokenUsage, resolveByProfile, resolveTarget, sweepEphemeralHarnesses, EPHEMERAL_SWEEP_INTERVAL_MS, type GatewayRuntime, type LogEntry, type LogAttempt, type ResolvedTarget } from './state.js'
import { startModelProbeLoop } from './modelprobe.js'
import { debugLog, debugOn } from './state/debuglog.js'
import { markUiSeen } from './presence.js'
import { adminCookieName, deviceCookieName } from './cookies.js'
import { createUsageTap } from './usage.js'
import { refreshCalendar } from './holidays.js'
import { filterResponseHeaders, forwardWithFailover, parseRatelimitHeaders, readUpstreamErrorText, translateUpstreamError, UpstreamError, type UpstreamResult } from './relay.js'
import type { ProbeTransport } from './probe/engine.js'
import { startProbeSchedule } from './probe/schedule.js'
import { t, bi, runWithLang, normalizeLang, getLang, type Bilingual } from '../util/i18n.js'
import { getRenderedUI } from './ui-cache.js'
import { adminAuthorized, cookieValueRe, hostAllowed, safeCookieDecode } from './routes/admin-auth.js'
import { pickerSyncStates } from './picker-state.js'
import { hAttachApply, hAttachPlan, hDetach, hHarnessEnv, hHarnessMode, hHarnessRoute, hHarnessUsage, hProvisionHarness, hRenewHarness, hRevokeHarness } from './routes/harness.js'
import { hModelAvailability, hProbeLedger, hProbeRun, hProbeTrend, hProbeVerdicts } from './routes/probe.js'
import { hLogs, hLogsQuery, hPricingLookup, hUsage } from './routes/usage.js'
import { hAutostart, hConfig, hLanGet, hLanPost, hModelCatalog, hMetrics, hReload, hReset, hRotate, hStatus, hTest, hTierValidate, healthView } from './routes/system.js'
import { probe, probePing } from './probe/direct.js'
import { hAutoRoute, hFetchModels, hHolidaysCn, hImportApply, hImportDetect, hImportDismiss, hKey, hProfile, hRevealKey, hSchedule, hServiceAdd, hServiceDelete, hServiceModelFallback, hServiceUpdate, hSwitch, hUse } from './routes/services.js'

// T05 拆分后保持原导入面：测试与潜在外部引用仍按 server.js 路径取这些符号
export { OVERVIEW_TTL_MS, overviewCacheHit, overviewServeDecision, warmupOverview } from './overview-view.js'
export { runClientInstall, runClientUninstall } from './install.js'
export { errorReply, maxBodyBytes } from './admin-shared.js'
export { probe, probePing }
export type { PingResult, ProbeResult } from './probe/direct.js'
import { hInstall, hUninstall } from './install.js'
import { AdminCtx, errorReply, maxBodyBytes, readBody, sendError } from './admin-shared.js'
import { hSyncRemoteStatus, hSyncRequestRemote, registerWebDevice, sweepRemoteRequests, sweepSyncTickets } from './remote-device.js'
import { hOverview, hPresetsCatalog, hTrayLite, hTrayState, hUiPresence, hUsageLive, invalidateOverviewCache } from './overview-view.js'
import { hUpdateApply, hUpdateCheck, hUpdateStatus } from './update-panel.js'
import { hConfigExport, hSyncDiscover, hSyncImport, hSyncOffer, hSyncOfferApprove } from './configpack.js'
import { hMergeApply, hMergePreview } from './mergepack.js'


export interface GatewayStartOptions {
  port: number
  idleTimeoutMs?: number
  retries?: number
  /** 法定节假日每年自动获取（holiday-cn 数据）；默认开启，测试传 false 避免 90s 首查触发出站请求 */
  autoHolidayRefresh?: boolean
  /** 模型元数据目录（models.dev）自动刷新；默认开启，测试传 false 避免出站请求 */
  autoCatalogRefresh?: boolean
  /** 上游模型可用性周期探测（modelprobe.ts，v1 纯观测）；默认开启，测试传 false 避免出站请求
   *  （或用 modelProbeIntervals 注入短首查 + mock 上游） */
  autoModelProbe?: boolean
  /** 注入探测调度节奏（测试用）：不传用 modelprobe.ts 的 MODEL_PROBE_* 默认（启动 90s / 每 24h） */
  modelProbeIntervals?: { initialDelayMs?: number; intervalMs?: number }
  /** 探针周期调度（probe/schedule.ts：P15 被动聚合恒跑 + cost_ack 授权的周期主动面）；默认开启，
   *  测试传 false 避免 tick 触发探针（或用 probeScheduleIntervals 注入短间隔 + mock 上游） */
  autoProbeSchedule?: boolean
  /** 注入探针调度节奏（测试用）：不传用 schedule.ts 的 PROBE_SCHEDULE_* 默认（启动 90s / 每 1h） */
  probeScheduleIntervals?: { initialDelayMs?: number; intervalMs?: number; transport?: ProbeTransport }
  /** 临时 harness TTL 清扫间隔（C14，测试注入用）：不传用 EPHEMERAL_SWEEP_INTERVAL_MS（60s） */
  ephemeralSweepIntervalMs?: number
}

// UI 渲染缓存与模型目录视图缓存见 ui-cache.ts（S-01 拆分，纯搬移）







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


export function createGatewayServer(rt: GatewayRuntime, opts: GatewayStartOptions): http.Server {
  const idle = opts.idleTimeoutMs ?? 10 * 60_000
  const retries = opts.retries ?? 1
  const server = http.createServer((req, res) => {
    // 请求级语言：浏览器会话经 x-modeldock-lang 头声明（控制台 fetch 统一携带），
    // 本请求生成的全部服务端文案（错误提示/客户端卡片描述/审计条目）随之；无头回落网关默认语言。
    // AsyncLocalStorage 随异步链传播，并发请求互不串扰。
    const reqLang = normalizeLang(req.headers['x-modeldock-lang'] as string | undefined) ?? getLang()
    void runWithLang(reqLang, async () => {
      try {
        await handleRequest(rt, req, res, { idle, retries })
      } catch (e) {
        // 顶层兜底：漏出的已知错误（UpstreamError / ConfigError / 带 hint 的业务错误）映射为
        // 正确状态码并保留 message + hint——控制台的失败提示依赖它们，不再一律 500「网关内部错误」
        if (res.headersSent) {
          res.destroy()
          return
        }
        const r = errorReply(e)
        if (r.status >= 500) console.error("[gateway] %s %s %s", req.method, req.url ?? "", t('网关内部错误:', 'Gateway internal error:'), e)
        sendError(res, r.status, r.message, r.hint)
      }
    })
  })
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 75_000
  server.timeout = idle
  server.on('connection', (s) => s.setNoDelay(true))
  // 实际端口自动回写 rt.port：登录 cookie 名内嵌端口号做同机双实例隔离（cookies.ts），
  // 端口必须以真实监听地址为准（EADDRINUSE 顺延、listen(0) 随机端口都覆盖），不能靠调用方手动赋值
  server.on('listening', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') rt.port = addr.port
  })

  // 健康清扫：周期性探活处于熔断冷却期的服务，连通即恢复（故障切换常开后熔断态任何模式下都可能命中，清扫不再看开关）
  const sweeper = setInterval(() => {
    // 顺带清扫直拉票据：孤儿条目（preview 后无人确认 / 附近直拉无人跟进）此前只在同类入口懒清扫，
    // 无人认领就常驻到进程结束（含解密 Syncdoc 与 report）
    sweepSyncTickets()
    sweepRemoteRequests()
    const now = Date.now()
    for (const [id, h] of rt.health) {
      if (h.meltdown_until == null || h.meltdown_until > now) continue
      const p = rt.config.providers[id]
      if (!p || p.enabled === false) continue
      void probePing(rt, p)
        .then((r) => {
          if (r.ok) {
            const hh = rt.health.get(id)
            if (hh) {
              hh.meltdown_until = undefined
              hh.meltdown_cls = undefined
              hh.errWindow = { t0: Date.now(), count: 0 }
              hh.lastMs = r.ms
            }
          }
        })
        .catch(() => {})
    }
  }, 60_000)
  sweeper.unref?.()
  server.on('close', () => clearInterval(sweeper))

  // 临时 harness TTL 清扫（C14，「用完即焚」语义见 state/types.ts EphemeralHarnessState 注）；
  // 测试经 opts.ephemeralSweepIntervalMs 注入短间隔
  const ephSweeper = setInterval(() => {
    sweepEphemeralHarnesses(rt)
  }, opts.ephemeralSweepIntervalMs ?? EPHEMERAL_SWEEP_INTERVAL_MS)
  ephSweeper.unref?.()
  server.on('close', () => clearInterval(ephSweeper))

  // 定时 prefer 窗口接管主候选的展示路由跟随：窗口边界没有事件（请求级时间函数），周期对比
  // 「展示路由」（人工当前 > prefer 窗口 > active_profile，不含熔断等瞬态），变化才把烤模型
  // 客户端（/model 策划表、模型列表）按窗口目标重写一次——手动切换 / 钉定仍走各自的即时同步。
  // 基线初始为 undefined：首检按变化处理一次（refresh 有内容一致守卫，已同步则零写盘），
  // 自愈「网关停摆期间窗口已变」「接入发生在窗口接管期间」两类陈旧；模型生效本身不受此影响
  // （转发按请求即时翻译）。接入/断开后由 handler 将基线置失效，下一检强制校准。
  const pickerSync = pickerSyncStates.get(rt) ?? pickerSyncStates.set(rt, { route: undefined }).get(rt)!
  const pickerSyncTick = () => {
    void syncBakedClientsForDisplayRoute(rt, pickerSync, { port: rt.port })
      .then((r) => {
        if (r.changed) {
          // detail 双语经 bi() 成对构造（两个语言参数同写，未来改文案不漏语言），按审计条目的 zh/en 字段落
          const detail: Bilingual | undefined = r.refreshed.length
            ? bi(`已同步重写 ${r.refreshed.join('、')} 的客户端配置（重开会话生效）`, `rewrote client configs for ${r.refreshed.join(', ')} (restart sessions to apply)`)
            : undefined
          const takeoverOp = bi('定时窗口接管路由', 'Schedule window takeover')
          logAudit(rt, {
            ts: localIsoTs(),
            kind: 'audit',
            op: takeoverOp.zh,
            op_en: takeoverOp.en,
            target: r.route ?? '-',
            detail: detail?.zh,
            detail_en: detail?.en,
            ok: true,
            source: 'token',
          })
        }
      })
      .catch((e: unknown) => {
        // 定时窗口接管重写客户端失败不再无声吞掉：事件落 ring/当日事件日文件（eventsLogName）可排查
        logEvent(rt, { level: 'warn', op: 'display_route_sync', err: e instanceof Error ? e.message : String(e) })
      })
  }
  // 周期 15s：定时窗口的判定粒度是分钟（HH:mm），更密的 tick 只产生注定 changed:false 的空转
  // （路由未变时是纯内存短路）。首检延后 30s 错峰：基线初始 undefined，首检必做一次全量烤模型
  // 客户端校准（读客户端文件 + 解析 + 比对，有内容一致守卫不写盘），不必叠在启动窗口——
  // 同期还有 sync 引擎首 tick 与 90s 后的节假日/模型目录拉取
  const pickerSyncFirst = setTimeout(pickerSyncTick, 30_000)
  const pickerSyncTimer = setInterval(pickerSyncTick, 15_000)
  pickerSyncFirst.unref?.()
  pickerSyncTimer.unref?.()
  server.on('close', () => {
    clearTimeout(pickerSyncFirst)
    clearInterval(pickerSyncTimer)
  })

  // 节假日日历每年自动获取（数据源 holiday-cn，国务院公告人工校对）：启动 90s 后首查、之后每 24h；
  // POST /schedule/holidays-cn 可即时触发（CLI/运维用）。失败静默，不影响网关服务
  const holidayTimers: NodeJS.Timeout[] = []
  if (opts.autoHolidayRefresh !== false) {
    const auto = () => void refreshCalendar(rt, { manual: false }).catch((e: unknown) => {
      logEvent(rt, { level: 'warn', op: 'calendar_refresh', err: e instanceof Error ? e.message : String(e) })
    })
    const first = setTimeout(auto, 90_000)
    const loop = setInterval(auto, 24 * 3600_000)
    first.unref?.()
    loop.unref?.()
    holidayTimers.push(first, loop)
  }
  server.on('close', () => holidayTimers.forEach((t) => { clearTimeout(t); clearInterval(t) }))

  // 模型元数据目录（models.dev）自动刷新：启动 90s 后首查、之后每 24h 检查（缓存 7 天内新鲜则跳过）。
  // 失败静默保留旧缓存，不影响网关服务；MODELRDOCK_DISABLE_CATALOG_FETCH=1 停用
  const catalogTimers: NodeJS.Timeout[] = []
  if (opts.autoCatalogRefresh !== false) {
    const autoCatalog = () => void refreshCatalog({ manual: false }).catch(() => {})
    const catFirst = setTimeout(autoCatalog, 90_000)
    const catLoop = setInterval(autoCatalog, 24 * 3600_000)
    catFirst.unref?.()
    catLoop.unref?.()
    catalogTimers.push(catFirst, catLoop)
  }
  server.on('close', () => catalogTimers.forEach((t2) => { clearTimeout(t2); clearInterval(t2) }))

  // 上游模型可用性周期探测（v1 纯观测，modelprobe.ts）：启动 90s 错峰首查、之后每 24h 一轮；
  // 结果（含失败负缓存）只存内存，GET /_modeldock/model-availability 消费。不影响转发路由；
  // 测试传 autoModelProbe:false 停用，或 modelProbeIntervals 注入短首查（配 mock 上游）
  if (opts.autoModelProbe !== false) {
    startModelProbeLoop(rt, server, opts.modelProbeIntervals)
  }

  // 探针周期调度（provider-probe-suite 任务 13，probe/schedule.ts）：每小时 tick——P15 被动聚合
  // 恒跑（零 token）；含 token 主动面（P1）仅在当前本地小时命中 [probe] schedule_hours 且
  // cost_ack=true 时执行，同受 budget_tokens 月度硬闸（闸在引擎内）。不影响转发路由；测试传
  // autoProbeSchedule:false 停用，或 probeScheduleIntervals 注入短间隔（配 mock 上游）
  if (opts.autoProbeSchedule !== false) {
    startProbeSchedule(rt, server, opts.probeScheduleIntervals)
  }

  // JSONL 日志保留期清理：启动即清一次、之后每 24h；保留天数读 rt.config（随 reloadRuntime
  // 跟随配置变化），log_retention_days=0 禁用。删除为尽力而为，失败静默不影响网关服务
  const pruneLogs = async () => {
    try {
      const days = rt.config.gateway?.log_retention_days ?? DEFAULT_LOG_RETENTION_DAYS
      const pruned = await pruneExpiredLogs(days)
      if (pruned > 0) {
        console.log(
          t('✓ 已清理 {count} 个过期日志文件（保留 {days} 天）', '✓ Pruned {count} expired log files (kept {days} days)', { count: pruned, days })
        )
      }
    } catch {
      /* 清理失败不影响网关服务 */
    }
  }
  const pruneLoop = setInterval(() => void pruneLogs(), 24 * 3600_000)
  pruneLoop.unref?.()
  server.on('close', () => clearInterval(pruneLoop))
  void pruneLogs()

  return server
}


function extractToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  const xk = req.headers['x-api-key']
  if (typeof xk === 'string') return xk.trim()
  return null
}


async function handleRequest(
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































type AdminHandler = (c: AdminCtx) => Promise<void>


// 轮换管理令牌（需当前已鉴权，故位于 admin 门之后）：旧 token/cookie 立即失效。






// 面向任务的服务端点（Web 控制台 v2，全部用户语言，无内部概念）






























/** 轻量性能观测（WIP obs-health 意图补完）：per-provider 耗时分位 + 事件循环延迟 + 熔断状态。
 *  admin 门内只读端点，无副作用；samples 环形窗口见 ProviderLatencyRing。熔断数组是编排侧
 *  （Dockmaster 风暴闸）与排查的外部海况数据源：class = 触发熔断的错误类；model_meltdown 为
 *  模型级容灾（model_fallback 域）的同形投影，供编排侧按 (provider, model) 粒度避让；
 *  model_fallback 为该域的改发计数投影（fallback_count/absorbed_count，见 ModelFallbackCounter）。
 *  海况扩展（只增不改，state/sea.ts）：providers[].errors 滑窗错误分桶（last_5m/last_60m 的
 *  分错误类计数与错误率）+ sea_state 聚合海况信号——同为编排侧风暴闸数据源。 */













/** POST /_modeldock/tier-validate：token → harness → profile 权威事实回报（编排侧 tier 校验用，
 *  admin 门内；2026-11-02 船东授权 .agents 使用 admin 面）。请求体 { token?, tier? }——tier 仅
 *  回传对照，判定语义（别名归一等）在编排侧。响应：ok:false（token 未命中/无法解析，reason）
 *  或 ok:true + harness/profile/provider/tier（profile.tier 标签，可 null）+ models（该 profile
 *  当前 provider 的目录 id）+ tier_profiles（全库 tier 标签 → profile id 清单，供「tier 已打标
 *  但 token 指向别档」判定）。token 不回显（口径见 hProvisionHarness 注）。 */

/** admin 门之后的端点路由表：键 = "METHOD /path"（url 已在 handleAdmin 顶部剥过查询串）；Map 存查表用 .get()，键含请求输入不走对象动态索引 */
const ADMIN_ROUTES: Map<string, AdminHandler> = new Map(Object.entries({
  'POST /_modeldock/admin/rotate': hRotate,
  'GET /_modeldock/metrics': hMetrics,
  'GET /_modeldock/harness-usage': hHarnessUsage,
  'GET /_modeldock/model-availability': hModelAvailability,
  'GET /_modeldock/usage': hUsage,
  'GET /_modeldock/status': hStatus,
  'GET /_modeldock/admin/update/status': hUpdateStatus,
  'POST /_modeldock/admin/update/check': hUpdateCheck,
  'POST /_modeldock/admin/update/apply': hUpdateApply,
  'GET /_modeldock/logs': hLogs,
  'GET /_modeldock/logs/query': hLogsQuery,
  'GET /_modeldock/config': hConfig,
  'GET /_modeldock/model-catalog': hModelCatalog,
  'GET /_modeldock/presets': hPresetsCatalog,
  'GET /_modeldock/overview': hOverview,
  'GET /_modeldock/usage-live': hUsageLive,
  'GET /_modeldock/tray-state': hTrayState,
  'POST /_modeldock/tray-lite': hTrayLite,
  'POST /_modeldock/ui-presence': hUiPresence,
  'POST /_modeldock/service/fetch-models': hFetchModels,
  'POST /_modeldock/service': hServiceAdd,
  'POST /_modeldock/switch': hSwitch,
  'POST /_modeldock/auto-route': hAutoRoute,
  'POST /_modeldock/auto-route/schedule': hSchedule,
  'POST /_modeldock/schedule/holidays-cn': hHolidaysCn,
  'GET /_modeldock/lan': hLanGet,
  'POST /_modeldock/lan': hLanPost,
  'POST /_modeldock/sync/offer': hSyncOffer,
  'POST /_modeldock/sync/import': hSyncImport,
  'POST /_modeldock/config/export': hConfigExport,
  'POST /_modeldock/merge/preview': hMergePreview,
  'POST /_modeldock/merge/apply': hMergeApply,
  'POST /_modeldock/sync/discover': hSyncDiscover,
  'POST /_modeldock/sync/request-remote': hSyncRequestRemote,
  'GET /_modeldock/sync/remote-status': hSyncRemoteStatus,
  'POST /_modeldock/sync/offer-approve': hSyncOfferApprove,
  'POST /_modeldock/autostart': hAutostart,
  'GET /_modeldock/import/detect': hImportDetect,
  'POST /_modeldock/import/apply': hImportApply,
  'POST /_modeldock/import/dismiss': hImportDismiss,
  'POST /_modeldock/service/update': hServiceUpdate,
  'POST /_modeldock/service/model-fallback': hServiceModelFallback,
  'POST /_modeldock/service/reveal-key': hRevealKey,
  'POST /_modeldock/harness/env': hHarnessEnv,
  'POST /_modeldock/service/delete': hServiceDelete,
  'POST /_modeldock/install': hInstall,
  'POST /_modeldock/uninstall': hUninstall,
  'POST /_modeldock/attach/plan': hAttachPlan,
  'POST /_modeldock/attach/apply': hAttachApply,
  'POST /_modeldock/detach': hDetach,
  'POST /_modeldock/harness/route': hHarnessRoute,
  'POST /_modeldock/harness/mode': hHarnessMode,
  'POST /_modeldock/harness/provision': hProvisionHarness,
  'POST /_modeldock/harness/revoke': hRevokeHarness,
  'POST /_modeldock/harness/renew': hRenewHarness,
  'POST /_modeldock/use': hUse,
  'POST /_modeldock/profile': hProfile,
  'POST /_modeldock/key': hKey,
  'POST /_modeldock/reload': hReload,
  'POST /_modeldock/test': hTest,
  'POST /_modeldock/probe/run': hProbeRun,
  'GET /_modeldock/probe/verdicts': hProbeVerdicts,
  'GET /_modeldock/probe/ledger': hProbeLedger,
  'GET /_modeldock/probe/trend': hProbeTrend,
  'POST /_modeldock/tier-validate': hTierValidate,
  'POST /_modeldock/pricing-lookup': hPricingLookup,
  'POST /_modeldock/reset': hReset,
}))

/** 管理面入口：Host 白名单 → tier-1 豁免端点（health/ui/relogin）→ admin 鉴权 → 路由表分发。 */
async function handleAdmin(
  rt: GatewayRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  o: { idle: number; retries: number },
  started: number
): Promise<void> {
  const url = (req.url ?? '').split('?')[0]
  const method = req.method ?? '-'
  // 管理面访问日志（debug 级，2026-11-07 事故补课：此前管理面零访问日志，attach/plan 请求
  // 到没到、成没成全无线索）。res finish 时记 {method, path, status, ms}；非 2xx 另无条件记
  // 当日事件日文件 warn（eventsLogName；排障不依赖 debug 开关）。
  if (debugOn()) {
    res.on('finish', () => {
      debugLog('admin', 'http', { method, path: url, status: res.statusCode, ms: Date.now() - started })
    })
  }
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      try {
        logEvent(rt, { level: 'warn', op: 'admin_http_error', err: `${method} ${url} → ${res.statusCode}（${Date.now() - started}ms）` })
      } catch {
        /* 观测失败不影响响应 */
      }
    }
  })

  if (!hostAllowed(req)) {
    return sendError(res, 403, t('管理接口仅限本机访问（Host 必须是 127.0.0.1/localhost）', 'Admin API is local-only (Host must be 127.0.0.1/localhost)'))
  }
  // 管理面响应一律禁止缓存（overview 等含敏感元数据）
  res.setHeader('cache-control', 'no-store')

  // 操作审计：修改类操作的成功/失败都记一条（环形缓冲 + audit-日期.jsonl，不含密钥明文）
  // 能走到端点的请求都过了 adminAuthorized：托盘（x-modeldock-source: tray）归 tray，
  // 其余带 token 头的记为 token（CLI），cookie 登录的浏览器记为 web
  // op/target/detail 双语存储（bi 渲染与当前请求语言无关）：控制台日志表按界面语言取字段，历史条目缺英文时回退主字段
  const srcHeader = typeof req.headers['x-modeldock-source'] === 'string' ? String(req.headers['x-modeldock-source']) : ''
  const src = srcHeader === 'tray'
    ? 'tray' as const
    : typeof req.headers['x-modeldock-admin'] === 'string' ? 'token' as const : 'web' as const
  const audit = (op: Bilingual, target: string | Bilingual, detail?: Bilingual, err?: Bilingual | string) => {
    const errZh = err === undefined || typeof err === 'string' ? err : err.zh
    const errEn = err === undefined || typeof err === 'string' ? undefined : err.en
    logAudit(rt, {
      ts: localIsoTs(),
      kind: 'audit',
      op: op.zh,
      op_en: op.en,
      target: typeof target === 'string' ? target : target.zh,
      target_en: typeof target === 'string' ? undefined : target.en,
      detail: detail?.zh,
      detail_en: detail?.en,
      ok: !errZh,
      err: errZh,
      err_en: errEn,
      source: src,
    })
  }

  if (url === '/_modeldock/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        // 网关版本：无鉴权端点但仅监听 127.0.0.1/LAN 控制台自用；dsh 插件的 modeldock_health 消费（design-dsh-plugin.md 5.A4）
        version: VERSION,
        started_at: localIsoTs(new Date(rt.startedAt)),
        uptime_ms: Date.now() - rt.startedAt,
        reloads: rt.reloads,
        active_profile: rt.config.active_profile ?? null,
      })
    )
    return
  }

  // Web 控制台页面：?token= 校验通过则种 HttpOnly cookie 后重定向到干净 URL。
  // 同时种 1 年期「设备记忆」cookie（值登记进 gateway.json 的 devices）：
  // 之后令牌轮换/7 天过期，锁屏「重新登录」按钮凭它一键恢复，无需终端。
  if (url === '/_modeldock/ui' && req.method === 'GET') {
    const q = new URL(req.url ?? '', 'http://x').searchParams
    const token = q.get('token')
    if (token && safeEqual(token, rt.adminToken)) {
      const device = randomToken('mdkdev')
      await registerWebDevice(rt, device)
      const port = rt.port ?? DEFAULT_GATEWAY_PORT
      res.writeHead(302, {
        'set-cookie': [
          `${adminCookieName(port)}=${encodeURIComponent(rt.adminToken)}; Path=/_modeldock; HttpOnly; SameSite=Lax; Max-Age=604800`,
          `${deviceCookieName(port)}=${encodeURIComponent(device)}; Path=/_modeldock; HttpOnly; SameSite=Lax; Max-Age=31536000`,
        ],
        location: '/_modeldock/ui',
      })
      res.end()
      return
    }
    const { html, etag, gzip, gzipEtag } = getRenderedUI()
    // gzip 协商（PERF-25）：Accept-Encoding 带 gzip 就发预压缩形态（独立 ETag 标识表示形态；
    // Vary: Accept-Encoding 让缓存/代理按该头区分两形态）。304 比较用同一形态的 ETag，
    // 浏览器对同一形态的重验证恒命中。
    const wantGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''))
    const serveEtag = wantGzip ? gzipEtag : etag
    // 页面加载（含 304 重验证）= UI 打开：续在场并撤销在途轻量模式广播——任何方式打开控制台自动退出轻量模式。
    // 必须同步失效 overview 缓存：刚加载的页面首拉 overview 若命中携带旧广播时间戳的缓存串会误自关。
    // 收窄到带有效凭据的请求：本机程序对 /ui 的无凭据探测/预取不该抑制轻量模式、打穿 overview 缓存
    // （真登录路径 302 后浏览器带 cookie 重取，必再走到这里）
    if (adminAuthorized(rt, req)) {
      markUiSeen(Date.now())
      invalidateOverviewCache()
    }
    // 带匹配 ETag 的重复请求直接 304（空 body，保留既有头）：省掉每请求原样重发 ~224KB 页体（UI_HTML 实测 229139 字节；Phase 2 最小化后 @2026-10-28）。
    // no-store 由管理面统一策略设置，此处叠 ETag 只做条件请求，不放开 JSON 的缓存策略。
    if (req.headers['if-none-match'] === serveEtag) {
      res.writeHead(304, { 'content-type': 'text/html; charset=utf-8', etag: serveEtag, 'content-security-policy': CONSOLE_CSP, vary: 'Accept-Encoding' })
      res.end()
      return
    }
    // 仅 HTML 页覆盖管理面统一 no-store：no-cache = 可存储但每次必须条件重验证，
    // 浏览器才会存下 ~224KB 页体并在下一次发 If-None-Match → ETag 304 生效。
    // 页面是静态壳 + 状态路径，无敏感数据；JSON API 的 no-store 策略不动。
    if (wantGzip) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: serveEtag, 'cache-control': 'no-cache', 'content-security-policy': CONSOLE_CSP, vary: 'Accept-Encoding', 'content-encoding': 'gzip' })
      res.end(gzip)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: serveEtag, 'cache-control': 'no-cache', 'content-security-policy': CONSOLE_CSP, vary: 'Accept-Encoding' })
    res.end(html)
    return
  }

  // 锁屏「重新登录」：凭设备记忆 cookie 重发 7 天期 admin cookie。
  // 位于 admin 门之前——这正是它的用途（用户已被登出）；没有设备凭据的新浏览器/本机
  // 程序一律 403，走粘贴令牌流程，2026-09 审查闭合的「免凭据放行」口子不会重开。
  if (url === '/_modeldock/auth/relogin' && req.method === 'POST') {
    const port = rt.port ?? DEFAULT_GATEWAY_PORT
    const cookie = req.headers.cookie
    const m = cookie ? cookieValueRe(deviceCookieName(port)).exec(cookie) : null
    const device = m ? safeCookieDecode(m[1]) : ''
    const state = await readGatewayState()
    const known = typeof device === 'string' && device.startsWith('mdkdev_') && (state?.devices ?? []).some((d) => safeEqual(d, device))
    if (!known) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: t('本浏览器没有有效的设备记忆，请粘贴网关令牌登录', 'This browser has no valid device memory; paste the gateway token to sign in') }))
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `${adminCookieName(port)}=${encodeURIComponent(rt.adminToken)}; Path=/_modeldock; HttpOnly; SameSite=Lax; Max-Age=604800`,
    })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // 管理面鉴权（/health 探活与 /ui 页面已在前面分支豁免）：读写一律要求 admin 凭据
  // （x-modeldock-admin 头，或 ?token= 登录种的 admin cookie，7 天有效）。
  // 旧版「同源即放行」已移除——本机程序伪造 Origin/Sec-Fetch-Site 即可读写配置，令牌形同虚设
  if (!adminAuthorized(rt, req)) {
    return sendError(res, 401, t('需要登录', 'Sign-in required'), t('控制台请用 modeldock ui 打开（自动携带令牌）；脚本请求请带 x-modeldock-admin 头', 'Open the console with modeldock ui (token carried automatically); scripts must send the x-modeldock-admin header'))
  }

  const handler = ADMIN_ROUTES.get(`${req.method ?? 'GET'} ${url}`)
  if (handler) return handler({ rt, req, res, audit, o })
  sendError(res, 404, t('未知管理端点 {url}', 'Unknown admin endpoint {url}', { url }))
}

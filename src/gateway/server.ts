import http from 'node:http'
import fsp from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import { safeEqual } from '../util/safe-equal.js'
import { CONSOLE_CSP } from './console-shared.js'
import { randomToken, withFileLock } from '../util/fsx.js'
import { localIsoTs } from '../util/time.js'
import { VERSION } from '../version.js'
import { ConfigError, configLockPath, mutateConfig } from '../config/store.js'
import { snapshot } from '../backup/snapshot.js'
import { DEFAULT_GATEWAY_PORT, DEFAULT_LAN_PORT, DEFAULT_LOG_RETENTION_DAYS, type Config, type ModelMeta } from '../config/types.js'
import { deleteSecret, invalidateSecretsCacheIfExternal, providerAllKeyRefs, providerKeyRefs, verifySecretsStore } from '../config/secrets.js'
import { detachHarness, syncBakedClientsForDisplayRoute } from '../ops.js'
import { installAutostart, uninstallAutostart } from '../autostart.js'
import { refreshCatalog } from '../providers/catalog.js'
import { checkTokenLimits, eventLoopLagMs, keyPoolHealthView, latencyQuantiles, logAudit, logEvent, logRequest, mutateGatewayState, pickTarget, pruneExpiredLogs, readGatewayState, recordTokenUsage, reloadRuntime, resolveByProfile, resolveTarget, seaStateSnapshot, seaWindowView, streamRequestLogDays, summarizeUsageDays, summarizeUsageDaysWithHours, sweepEphemeralHarnesses, unregisterEphemeralHarness, EPHEMERAL_SWEEP_INTERVAL_MS, SEA_WINDOW_5M_MS, SEA_WINDOW_60M_MS, type GatewayRuntime, type LogEntry, type LogAttempt, type ResolvedTarget, type RingEntry, type UsageHourBucket } from './state.js'
import { startModelProbeLoop } from './modelprobe.js'
import { debugLog, debugOn } from './state/debuglog.js'
import { readSyncState } from '../sync/state.js'
import { appendLineErrorCount } from '../util/fsx.js'
import { providerConcurrencyIds, providerConcurrencyLimit, providerConcurrencyStats } from './concurrency.js'
import { buildLanStatus, refreshPreferredAddress, resolveLanToken, startLanServer, stopLan } from './lan.js'
import { markUiSeen } from './presence.js'
import { adminCookieName, deviceCookieName } from './cookies.js'
import { createUsageTap } from './usage.js'
import { gatewayPriceResolver, loadPricingOverrides, lookupPrice } from './pricing.js'
import { refreshCalendar } from './holidays.js'
import { filterResponseHeaders, forwardWithFailover, parseRatelimitHeaders, readUpstreamErrorText, translateUpstreamError, UpstreamError, type UpstreamResult } from './relay.js'
import type { ProbeTransport } from './probe/engine.js'
import { startProbeSchedule } from './probe/schedule.js'
import { t, bi, biJoin, runWithLang, normalizeLang, getLang, type Bilingual } from '../util/i18n.js'
import { modeldockDir, secretsPath } from '../util/paths.js'
import { catalogView, getRenderedUI } from './ui-cache.js'
import { adminAuthorized, cookieValueRe, hostAllowed, safeCookieDecode } from './routes/admin-auth.js'
import { pickerSyncStates } from './picker-state.js'
import { hAttachApply, hAttachPlan, hDetach, hHarnessEnv, hHarnessMode, hHarnessRoute, hHarnessUsage, hProvisionHarness, hRenewHarness, hRevokeHarness } from './routes/harness.js'
import { hModelAvailability, hProbeLedger, hProbeRun, hProbeTrend, hProbeVerdicts } from './routes/probe.js'
import { probe, probePing } from './probe/direct.js'
import { hAutoRoute, hFetchModels, hHolidaysCn, hImportApply, hImportDetect, hImportDismiss, hKey, hProfile, hRevealKey, hSchedule, hServiceAdd, hServiceDelete, hServiceModelFallback, hServiceUpdate, hSwitch, hUse } from './routes/services.js'

// T05 拆分后保持原导入面：测试与潜在外部引用仍按 server.js 路径取这些符号
export { OVERVIEW_TTL_MS, overviewCacheHit, overviewServeDecision, warmupOverview } from './overview-view.js'
export { runClientInstall, runClientUninstall } from './install.js'
export { errorReply, maxBodyBytes } from './admin-shared.js'
export { probe, probePing }
export type { PingResult, ProbeResult } from './probe/direct.js'
import { hInstall, hUninstall } from './install.js'
import { AdminCtx, errorReply, jsonRequestBody, maxBodyBytes, readBody, sendError } from './admin-shared.js'
import { hSyncRemoteStatus, hSyncRequestRemote, registerWebDevice, sweepRemoteRequests, sweepSyncTickets } from './remote-device.js'
import { buildConfigView, hOverview, hPresetsCatalog, hTrayLite, hTrayState, hUiPresence, hUsageLive, invalidateOverviewCache } from './overview-view.js'
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
async function hRotate(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  try {
    rt.adminToken = randomToken('mdkadm')
    // 只更新状态文件里的 token（串行队列防并发丢字段）；无状态文件（测试/嵌入式启动）则只换内存态
    await mutateGatewayState((state) => (state ? { ...state, admin_token: rt.adminToken } : null))
    const host = req.headers.host ?? `127.0.0.1:${rt.port ?? ''}`
    const consoleUrl = `http://${host}/_modeldock/ui?token=${rt.adminToken}`
    audit(bi('轮换管理令牌', 'Rotate admin token'), '-', bi('旧令牌已失效', 'Old token revoked'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, admin_token: rt.adminToken, console_url: consoleUrl }))
  } catch (e) {
    sendError(res, 400, (e as Error).message)
  }
  return
}

async function hStatus(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      ok: true,
      active_profile: rt.config.active_profile ?? null,
      providers: Object.keys(rt.config.providers),
      profiles: Object.keys(rt.config.profiles),
      harness: Object.keys(rt.config.harness),
      reloads: rt.reloads,
      uptime_ms: Date.now() - rt.startedAt,
    })
  )
  return
}



async function hLogs(c: AdminCtx): Promise<void> {
  const { rt, req, res } = c
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const n = Math.min(500, Math.max(1, Number(q.get('n') ?? 50) || 50))
  // 筛选视图：默认=环形缓冲原样（错误请求+控制台操作+后台事件，写入侧已分流）；
  // src=ok 取成功请求小缓冲；kind=err/audit 在 ring 上做服务端过滤——分页计数按过滤后口径，
  // 避免前端拿到稀页（客户端过滤会让「每页 N 条」名不副实）
  const src = q.get('src')
  const kind = q.get('kind')
  const base: RingEntry[] = src === 'ok' ? (rt.okRing ?? []) : rt.ring
  const filtered =
    !src && kind === 'audit'
      ? base.filter((l) => l.kind === 'audit')
      : !src && kind === 'err'
        ? base.filter((l) => l.kind !== 'audit')
        : base
  const total = filtered.length
  // page 从 1 数起，第 1 页是最新 n 条（ring 按 时间正序 追加）；越界页返回空数组
  const page = Math.max(1, Number(q.get('page') ?? 1) || 1)
  const pages = Math.max(1, Math.ceil(total / n))
  const end = Math.max(0, total - (page - 1) * n)
  const start = Math.max(0, end - n)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ logs: filtered.slice(start, end), total, page, pages }))
  return
}

async function hConfig(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  const view = await buildConfigView(rt)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(view))
  return
}

// 面向任务的服务端点（Web 控制台 v2，全部用户语言，无内部概念）
async function hModelCatalog(c: AdminCtx): Promise<void> {
  const { req, res } = c
  // 模型元数据兜底总表（内置表 ∪ models.dev 目录，8000+ 条）：量大，单端点懒加载一次，
  // 不进 overview（每 5s 轮询，塞进去每秒多出百 KB 流量）。序列化结果缓存 + ETag：
  // 控制台每次刷新重拉时命中 304，不再重复 stringify/传输几百 KB（cache-control 覆盖
  // 管理面统一 no-store 为 no-cache：可存储但必须条件重验证，与 /ui 页同款策略）
  const { data, etag } = catalogView()
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json', etag, 'cache-control': 'no-cache' })
  res.end(data)
  return
}




async function hLanGet(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  // 手机简版控制台状态（二维码只对已过 admin 鉴权的本机控制台返回）
  // 顺带重算默认出口地址：换 Wi-Fi / 起停 VPN 后该用哪块网卡会变，面板一刷新即纠正二维码
  await refreshPreferredAddress()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, ...buildLanStatus(rt) }))
  return
}

async function hLanPost(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 开关手机简版控制台：config.lan.enabled 落盘并即时启停第二监听器；
  // LAN 凭据复用 gateway.json 旧值（手机 cookie 跨重启不掉），没有才新生成
  const b = await jsonRequestBody(req)
  try {
    if (b.enabled === true) {
      const state = await readGatewayState()
      const lanToken = resolveLanToken(state?.lan_token ?? null)
      await startLanServer(rt, { port: rt.config.lan?.port ?? DEFAULT_LAN_PORT, token: lanToken })
      await mutateConfig((c) => {
        c.lan = { ...(c.lan ?? {}), enabled: true }
      })
      await reloadRuntime(rt)
      await mutateGatewayState((refreshed) =>
        refreshed ? { ...refreshed, lan_token: lanToken, lan_port: rt.lan?.port } : null
      )
      audit(bi('手机远程', 'Mobile console'), bi('开启', 'on'), bi('端口 {port}', 'port {port}', { port: rt.lan?.port ?? 0 }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...buildLanStatus(rt) }))
    } else {
      stopLan(rt)
      await mutateConfig((c) => {
        c.lan = { ...(c.lan ?? {}), enabled: false }
      })
      await reloadRuntime(rt)
      await mutateGatewayState((refreshed) => (refreshed ? { ...refreshed, lan_port: undefined } : null))
      audit(bi('手机远程', 'Mobile console'), bi('关闭', 'off'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...buildLanStatus(rt) }))
    }
  } catch (e) {
    audit(bi('手机远程', 'Mobile console'), '-', undefined, (e as Error).message)
    // 失败走 sendError（经 errorReply 还原业务错误状态码与 hint），不再 200+{ok:false}：
    // 控制台 api() 封装按 !res.ok 抛错并取 error.message，200 包体会被当成功静默吞掉
    // （2026-11-04 审查 P2）。前端两处调用（pillSwitch 开关 / configpack 导出面板）均有 catch 展示
    const r = errorReply(e)
    sendError(res, r.status, r.message, r.hint)
  }
  return
}







async function hAutostart(c: AdminCtx): Promise<void> {
  const { req, res, audit } = c
  // 开机自启开关。网关必然处于运行中，install 只登记服务文件、不 bootstrap——
  // 否则第二个实例被单实例保护拒掉，launchd KeepAlive 会陷入重启循环。
  const b = await jsonRequestBody(req)
  try {
    if (b.enabled === true) {
      const r = await installAutostart()
      audit(bi('开机自启', 'Start at login'), bi('开启', 'on'), bi('服务文件 {file}', 'Service file {file}', { file: r.file }))
      // 不走 persistConfig（reloads 不变），不清缓存则紧随的 overview GET 会命中 6s TTL 旧值，UI 回灌旧状态
      invalidateOverviewCache()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, installed: true, note: r.note ?? t('下次登录自动启动', 'Starts automatically at next login') }))
    } else {
      const r = await uninstallAutostart()
      audit(bi('开机自启', 'Start at login'), bi('关闭', 'off'), r.wasInstalled ? bi('已移除 {path}', 'Removed {path}', { path: r.removed }) : bi('本就未安装', 'Was not installed'))
      invalidateOverviewCache()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, installed: false }))
    }
  } catch (e) {
    audit(bi('开机自启', 'Start at login'), '-', undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}












async function hReload(c: AdminCtx): Promise<void> {
  const { rt, res, audit } = c
  try {
    await reloadRuntime(rt)
    // 手动兜底语义补全：watcher 失效（health 提示走这里）时外部改的 key 也一并即刻生效——
    // invalidateSecretsCacheIfExternal 按盘上指纹区分自家/外部写，自家刚写的不误失效
    await invalidateSecretsCacheIfExternal()
    audit(bi('重载配置', 'Reload config'), '-', bi('第 {n} 次热重载', 'Hot reload #{n}', { n: rt.reloads }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, reloads: rt.reloads }))
  } catch (e) {
    audit(bi('重载配置', 'Reload config'), '-', undefined, (e as Error).message)
    sendError(res, 500, t('配置重载失败：{msg}', 'Failed to reload config: {msg}', { msg: (e as Error).message }))
  }
  return
}

async function hTest(c: AdminCtx): Promise<void> {
  const { rt, req, res, o } = c
  const url = '/_modeldock/test'
  const body = await readBody(req, maxBodyBytes(rt.config))
  let p: { profile?: string; provider?: string; model?: string; stream?: boolean; mode?: string } = {}
  try {
    p = body.length ? JSON.parse(body.toString('utf8')) : {}
  } catch {
    return sendError(res, 400, t('test 请求体必须是 JSON', 'The test request body must be JSON'))
  }
  let resolved: { ok: boolean; target?: ResolvedTarget; status?: number; message?: string; hint?: string }
  if (p.provider) {
    // 按服务直接探测（不必先建路由）
    const provider = rt.config.providers[p.provider]
    if (!provider) return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id: p.provider }))
    const models = Object.keys(provider.models ?? {})
    const fakeProfile = {
      name: `probe-${p.provider}`,
      provider: p.provider,
      default_model: p.model ?? models[0],
    }
    resolved = { ok: true, target: { harness: 'admin-test', profileName: fakeProfile.name, profile: fakeProfile, provider } }
  } else {
    resolved = resolveByProfile(rt, p.profile)
  }
  if (!resolved.ok) return sendError(res, resolved.status ?? 400, resolved.message ?? t('无法解析路由', 'Cannot resolve a route'), resolved.hint)
  // mode='ping' → 纯网络延迟（不推理）；否则保持原有的完整模型请求测速
  const out = p.mode === 'ping'
    ? await probePing(rt, resolved.target!.provider)
    : await probe(rt, resolved.target!, p.model, p.stream === true, o)
  // 连接测试也记入请求日志（客户端记为 admin-test），便于追溯测试失败原因
  logRequest(rt, {
    ts: localIsoTs(),
    harness: 'admin-test',
    profile: resolved.target?.profileName ?? '-',
    provider: p.provider ?? resolved.target?.profile.provider ?? '-',
    model: (out as { model?: string }).model ?? p.model,
    path: p.mode === 'ping' ? 'ping' : url,
    status: out.ok ? 200 : 502,
    ms: out.ms,
    err: out.err,
  })
  res.writeHead(out.ok ? 200 : 502, { 'content-type': 'application/json' })
  res.end(JSON.stringify(out))
  return
}

async function hReset(c: AdminCtx): Promise<void> {
  const { rt, res, audit } = c
  const { configPath, secretsPath } = await import('../util/paths.js')
  const fs = await import('node:fs')
  // 与 CLI cmdReset（cli/basic.ts）同语义的三步序：先把已接管客户端逐个 detach 还原快照，
  // 再清钥匙环、删 config/secrets。旧实现直接 unlink 的后果：客户端文件仍指向本网关但
  // rt.tokens 已随空配置清空（全部客户端 401），且 config.harness 被删、attach 快照的
  // 自动还原路径失效——只能人工翻 backups/。
  // 1) 删前快照当前 config/secrets（unlink 绕过 atomicWrite 不触发自动快照，不补拍就没有「重置前」还原点）
  let snapshotId: string | undefined
  try {
    snapshotId = (await snapshot('config', 'pre-reset', [configPath(), secretsPath()])).id
  } catch { /* 快照失败不阻断重置（backups/ 通常已有历史快照） */ }
  // 2) 逐个 detach 还原客户端文件（单个失败不中断，对齐 CLI：逐条记失败继续）
  // 临时 harness（runtime-only 合成条目，不在盘上 config、无客户端文件可还原）不进 detach：
  // detachHarness 先查盘上 config.harness 必抛「尚未接入」，逐条污染 restoreFailed 假失败——
  // 用完即焚语义走 unregister 即收尾（重置后也不应幸存，reloadRuntime 的 reapply 会重注入幸存者）
  const restored: string[] = []
  const restoreFailed: string[] = []
  for (const id of Object.keys(rt.config.harness)) {
    if (rt.ephemeral.has(id)) {
      unregisterEphemeralHarness(rt, id)
      continue
    }
    try {
      await detachHarness(id)
      restored.push(id)
    } catch (e) {
      restoreFailed.push(`${id}: ${(e as Error).message}`)
    }
  }
  // 3) 清 OS 钥匙环里的 Key（keychain/secret-service 条目不在 secrets.json 里，删文件清不掉；
  // providerAllKeyRefs 全量口径盖住 keys[] 池，与 CLI reset 同口径）
  let secretsCleared = 0
  for (const [, p] of Object.entries(rt.config.providers)) {
    for (const ref of providerAllKeyRefs(p)) {
      try {
        await deleteSecret(ref)
        secretsCleared++
      } catch { /* 单项失败不影响其余 */ }
    }
  }
  // 删文件前包同一把 config 写锁（CORRECT-06 同法）：Web reset 与 CLI / 另一实例的 mutateConfig
  // 是独立写者，裸 unlink 会在他人「读文件→改→写回」的窗口里删掉目标、随后被整包写回归活——
  // reset 表面成功配置却还在。锁内删除让并发写者要么先完成再被删、要么等删除后才拿到锁
  // （读到空配置），不再复活（2026-11-04 审查 P2）
  const files = [configPath(), secretsPath()]
  const deleted: string[] = []
  const deleteFailed: Array<{ file: string; msg: string }> = []
  await withFileLock(configLockPath(), {
    // 超时报错与 mutateConfig 同口径（ConfigError → 400 + 可操作 hint），裸锁错误会落 500
    timeoutError: (lp) =>
      new ConfigError(
        t('重置失败：{lp} 被其他进程长期占用（可能是异常退出的残留锁）', 'Reset failed: {lp} has been held by another process for too long (possibly a stale lock from a crashed process)', { lp }),
        t('确认没有其他 modeldock 进程在写配置后，可删除该 .lock 文件重试', 'After confirming no other modeldock process is writing the config, delete the .lock file and retry')
      ),
  }, async () => {
    for (const f of files) {
      try {
        if (fs.existsSync(f)) { fs.unlinkSync(f); deleted.push(f) }
      } catch (e) {
        deleteFailed.push({ file: f, msg: (e as Error).message })
      }
    }
  })
  // fail-loud（审计 F4）：破坏性操作删文件失败必须如实报错——旧实现吞错后无条件 ok:true，
  // 用户以为配置已清空、实际原样存活。失败即中止（不 reloadRuntime 把幸存配置刷进运行态），
  // ConfigError 经顶层 errorReply 还原 400+hint，与上方锁超时同信封
  if (deleteFailed.length > 0) {
    const failedFiles = deleteFailed.map((d) => d.file)
    audit(
      bi('重置配置', 'Reset config'),
      '-',
      undefined,
      bi('删除 {files} 失败，重置中止：{msg}', 'Failed to delete {files}; reset aborted: {msg}', {
        files: biJoin('、', ', ', failedFiles),
        msg: deleteFailed.map((d) => d.msg).join('；'),
      })
    )
    throw new ConfigError(
      t('重置失败：{files} 删除未成功（配置未被清除，重置未完成）', 'Reset failed: {files} could not be deleted (config not cleared, reset incomplete)', { files: biJoin('、', ', ', failedFiles) }),
      t('文件可能被其他程序占用（编辑器/杀毒/云同步等）——关闭占用程序后重试重置', 'The file may be held open by another program (editor/antivirus/cloud sync) — close it and retry the reset')
    )
  }
  await reloadRuntime(rt)
  audit(
    bi('重置配置', 'Reset config'),
    '-',
    bi('还原 {h} 个客户端接管，删除 {files}，清除 {n} 个密钥', 'Restored {h} client attaches; deleted {files}; cleared {n} keys', { h: restored.length, files: deleted.length ? biJoin('、', ', ', deleted) : bi('无文件', 'no files'), n: secretsCleared }),
    restoreFailed.length ? bi('部分客户端还原失败：' + restoreFailed.join('；'), 'Some client restores failed: ' + restoreFailed.join('; ')) : undefined
  )
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, deleted, restored, restoreFailed, snapshotId, hint: t('配置已清空（含钥匙环密钥）；快照和日志保留。运行 modeldock init 重新配置', 'Config cleared (including keychain keys); snapshots and logs are kept. Run modeldock init to set up again') }))
  return
}

// ===== 健康自检（/_modeldock/health 与数据面 /v1/health 共用）=====

/** secrets 自检缓存：verifySecretsStore 读盘+解密，health 高频被探（gatewayLive / 托盘 / 监控），
 *  结果按 secrets.json mtime 缓存 60s——mtime 未变且 60s 内直接复用，mtime 变化立即重验。 */
let secretsHealthCache: { at: number; mtimeMs: number; ok: boolean } | null = null

async function secretsOkCached(): Promise<boolean> {
  const now = Date.now()
  let mtimeMs = 0
  try {
    mtimeMs = (await fsp.stat(secretsPath())).mtimeMs
  } catch {
    /* 文件不存在（未设过任何 key）：mtime 记 0，verify 给出确定结论 */
  }
  const c = secretsHealthCache
  if (c && c.mtimeMs === mtimeMs && now - c.at < 60_000) return c.ok
  const r = await verifySecretsStore()
  secretsHealthCache = { at: now, mtimeMs, ok: r.ok }
  return r.ok
}

/** /health 只读自检视图。全量子检（secrets/watcher/磁盘/同步）各自独立 try/catch：
 *  任一项失败置 null / 降级返回部分，亚健康也要能答（探活不能因自检项异常而 5xx）。 */
async function healthView(rt: GatewayRuntime): Promise<Record<string, unknown>> {
  const now = Date.now()
  // secrets_ok：密钥表可读可解密（mtime 缓存 60s）
  let secretsOk: boolean
  try {
    secretsOk = await secretsOkCached()
  } catch {
    secretsOk = false // verifySecretsStore 自身不抛，此处兜底异常路径
  }
  // disk_free_mb：modeldockDir 所在盘剩余空间（fs.statfs，Node≥18 三平台可用；失败置 null）
  let diskFreeMb: number | null = null
  try {
    const st = await fsp.statfs(modeldockDir())
    const bytes = Number(st.bsize) * Number(st.bavail)
    if (Number.isFinite(bytes) && bytes >= 0) diskFreeMb = Math.floor(bytes / (1024 * 1024))
  } catch {
    diskFreeMb = null
  }
  // sync：多机同步状态（sync.json 损坏/缺失降级为 null 字段，不影响其余自检）
  let syncMode: string | null = null
  let syncLastErrorTs: string | null = null
  try {
    const st = await readSyncState()
    if (st) {
      syncMode = st.mode
      syncLastErrorTs = st.lastErrorTs
    }
  } catch {
    /* sync.json 非法：同步域自检降级，健康端点照常应答 */
  }
  return {
    ok: true,
    started_at: localIsoTs(new Date(rt.startedAt)),
    uptime_ms: now - rt.startedAt,
    reloads: rt.reloads,
    active_profile: rt.config.active_profile ?? null,
    secrets_ok: secretsOk,
    watcher_alive: rt.watcherAlive === true ? true : rt.watcherAlive === false ? false : null,
    log_write_errors: appendLineErrorCount(),
    disk_free_mb: diskFreeMb,
    sync: { mode: syncMode, lastErrorTs: syncLastErrorTs },
  }
}

/** 轻量性能观测（WIP obs-health 意图补完）：per-provider 耗时分位 + 事件循环延迟 + 熔断状态。
 *  admin 门内只读端点，无副作用；samples 环形窗口见 ProviderLatencyRing。熔断数组是编排侧
 *  （Dockmaster 风暴闸）与排查的外部海况数据源：class = 触发熔断的错误类；model_meltdown 为
 *  模型级容灾（model_fallback 域）的同形投影，供编排侧按 (provider, model) 粒度避让；
 *  model_fallback 为该域的改发计数投影（fallback_count/absorbed_count，见 ModelFallbackCounter）。
 *  海况扩展（只增不改，state/sea.ts）：providers[].errors 滑窗错误分桶（last_5m/last_60m 的
 *  分错误类计数与错误率）+ sea_state 聚合海况信号——同为编排侧风暴闸数据源。 */
async function hMetrics(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  const providers: Record<string, unknown> = {}
  // 键并集：只有耗时采样（logRequest）或只有海况分桶（recordOutcome）之一的 provider 都要露出。
  // 正常转发两者同来；测试直灌 recordOutcome 时只有 errors 侧（count 等耗时字段缺席）
  const ids = new Set<string>(rt.metricsLatency.keys())
  for (const id of rt.seaErrors?.keys() ?? []) ids.add(id)
  for (const id of ids) {
    const m = rt.metricsLatency.get(id)
    const sp = rt.seaErrors?.get(id)
    providers[id] = {
      ...(m ? { count: m.count, last_ms: m.lastMs ?? null, ...latencyQuantiles(m.samples) } : {}),
      ...(sp
        ? {
            errors: {
              last_5m: seaWindowView(sp, SEA_WINDOW_5M_MS),
              last_60m: seaWindowView(sp, SEA_WINDOW_60M_MS),
            },
          }
        : {}),
    }
  }
  // per-provider 并发水位（实时）：in_flight/queued 来自进程内信号量（concurrency.ts，重启清零），
  // limit 取当前配置 max_concurrency（0 = 不限）。键口径 = providers 段的同款并集（有完成流量才
  // 露出）∪ 当前持有信号量的 provider——首个请求还在途、尚未进耗时采样时也要露出，否则实时
  // 水位恰好漏掉正在满载的时刻。无流量且无在途的 provider 不出现：缺席 = 空闲（0/0），编排侧
  // 勿把缺席当故障（与 model-availability 的缺席语义一致）。
  const concurrency: Record<string, { in_flight: number; queued: number; limit: number }> = {}
  const concurrencyIds = new Set<string>(ids)
  for (const id of providerConcurrencyIds(rt)) concurrencyIds.add(id)
  for (const id of concurrencyIds) {
    const s = providerConcurrencyStats(rt, id)
    concurrency[id] = { in_flight: s.inFlight, queued: s.queued, limit: providerConcurrencyLimit(rt.config.providers[id]) }
  }
  const now = Date.now()
  const meltdown: Array<{ provider: string; class: string; until: string; remaining_ms: number }> = []
  for (const [id, h] of rt.health) {
    if (h.meltdown_until == null || h.meltdown_until <= now) continue
    meltdown.push({
      provider: id,
      class: h.meltdown_cls ?? 'unknown',
      until: new Date(h.meltdown_until).toISOString(),
      remaining_ms: h.meltdown_until - now,
    })
  }
  // 模型级熔断投影（model_fallback 域，ModelHealthState）：与 provider 级 meltdown 段同形，
  // 多 model 维度。键 = `${providerId}\u0000${model}`（state/routing.ts recordModelOutcome 记账），
  // 纯内存读；只露熔断中的条目（TTL 过期/已解除不出现，缺席 = 该模型无在熔断）。
  const model_meltdown: Array<{ provider: string; model: string; class: string; until: string; remaining_ms: number }> = []
  for (const [key, h] of rt.modelHealth ?? []) {
    if (h.meltdown_until == null || h.meltdown_until <= now) continue
    const sep = key.indexOf('\u0000')
    model_meltdown.push({
      provider: sep === -1 ? key : key.slice(0, sep),
      model: sep === -1 ? '' : key.slice(sep + 1),
      class: h.meltdown_cls ?? 'unknown',
      until: new Date(h.meltdown_until).toISOString(),
      remaining_ms: h.meltdown_until - now,
    })
  }
  // 模型级容灾改发计数投影（model_fallback 域，ModelFallbackCounter）：与 model_meltdown 同形
  // 位置、同键口径（key = `${providerId}\u0000${model}`，model = 被改发的原请求模型），纯内存读。
  // fallback_count = 改发累计（闸门预改写 + 链尾合成两路）；absorbed_count = 其中闸门吸收
  // （请求未触达原模型上游）的次数。单调累计（进程生命周期），熔断解除不清零——改发已发生
  // 是历史事实；只露有改发的条目（缺席 = 该键从未改发，与 model_meltdown 的缺席语义一致）。
  const model_fallback: Array<{ provider: string; model: string; fallback_count: number; absorbed_count: number }> = []
  for (const [key, s] of rt.modelFallbackCounts ?? []) {
    const sep = key.indexOf('\u0000')
    model_fallback.push({
      provider: sep === -1 ? key : key.slice(0, sep),
      model: sep === -1 ? '' : key.slice(sep + 1),
      fallback_count: s.fallbackCount,
      absorbed_count: s.absorbedCount,
    })
  }
  // key 池健康（P1⑥ 观测面）：per-provider 配置的 key 数量与失效冷却中的索引（含剩余 ms）。
  // 只有数量/索引/时间，绝无 key 明文或引用原文（ref 可能内嵌明文 key，一律不出域）。
  // 不实际读 key（无 IO，metrics 是轻量端点）：total=配置引用数；healthy=total-冷却数——
  // 个别引用读取失败时会高估 healthy（读取失败不进冷却，见 state/keypool.ts）
  const keypool: Record<string, { total: number; healthy: number; cooldown: Array<{ index: number; remaining_ms: number }> }> = {}
  for (const [id, p] of Object.entries(rt.config.providers)) {
    const total = providerKeyRefs(p).length
    keypool[id] = { total, ...keyPoolHealthView(rt, id, total, now) }
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ event_loop_lag_ms: eventLoopLagMs(), providers, meltdown, model_meltdown, model_fallback, sea_state: seaStateSnapshot(rt, now), keypool, concurrency }))
}



// ===== 服务探针端点（provider-probe-suite 任务 6；与 hTest 的差异：走探针引擎、不调 logRequest——
// 请求日志 / usageToday / key 冷却 / 熔断计数零副作用，花费只进探针独立账本）=====






/** /_modeldock/usage 查询参数 → 本地日期列表 + 毫秒窗口。date=单日（缺省今天）；from/to
 *  各自接受 YYYY-MM-DD 或 ISO 时间戳（日期形态按本地日界取起止）；跨天封顶 31 个日文件。
 *  非法返回 err 文案（双语）。 */
const USAGE_MAX_DAYS = 31
function usageQuery(q: URLSearchParams): { days: string[]; fromMs?: number; toMs?: number; err?: string } {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/
  const from = q.get('from')
  const to = q.get('to')
  if (!from && !to) {
    const date = q.get('date') ?? localIsoTs().slice(0, 10)
    if (!dateRe.test(date)) return { days: [], err: t('usage 参数 date 非法：需为 YYYY-MM-DD（本地日期）', 'Invalid usage date parameter: must be YYYY-MM-DD (local date)') }
    return { days: [date] }
  }
  const parseBound = (v: string, endOfDay: boolean): number | undefined => {
    if (dateRe.test(v)) {
      const [y, m, d] = v.split('-').map(Number)
      return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime()
    }
    const ts = new Date(v).getTime()
    return Number.isFinite(ts) ? ts : undefined
  }
  const fromMs = from ? parseBound(from, false) : undefined
  const toMs = to ? parseBound(to, true) : undefined
  if ((from && fromMs == null) || (to && toMs == null)) {
    return { days: [], err: t('usage 参数 from/to 非法：需为 YYYY-MM-DD 或 ISO 时间戳', 'Invalid usage from/to parameters: must be YYYY-MM-DD or an ISO timestamp') }
  }
  if (fromMs != null && toMs != null && toMs < fromMs) {
    return { days: [], err: t('usage 参数非法：to 早于 from', 'Invalid usage parameters: to is earlier than from') }
  }
  const lo = fromMs ?? toMs!
  const hi = toMs ?? fromMs!
  const dayStart = (ts: number) => new Date(new Date(ts).getFullYear(), new Date(ts).getMonth(), new Date(ts).getDate()).getTime()
  const startDay = dayStart(lo)
  const endDay = dayStart(hi)
  if ((endDay - startDay) / 86_400_000 + 1 > USAGE_MAX_DAYS) {
    return { days: [], err: t('usage 窗口过大：最多查询 {n} 天', 'Usage window too large: query at most {n} days', { n: USAGE_MAX_DAYS }) }
  }
  const days: string[] = []
  const cur = new Date(startDay)
  while (cur.getTime() <= endDay) {
    days.push(localIsoTs(cur).slice(0, 10))
    cur.setDate(cur.getDate() + 1)
  }
  return { days, fromMs, toMs }
}

/** /_modeldock/usage：请求日志聚合（admin 只读）。编排侧（Dockmaster 燃油实测/风暴闸）与
 *  排查的数据面：date/from/to 选日（见 usageQuery），harness/profile/provider 精确过滤；
 *  聚合口径见 summarizeUsage。bucket=hour 附加 hours[] 小时桶（精简版形状见 UsageHourBucket，
 *  稀疏输出：无流量的小时不出桶）——编排侧长跑分时段观测（油量曲线/高峰定位），总账照常返回。
 *  可计费口径字段（2026-11 billable 聚合）：usage.billable_tokens = 窗口内成功且有 usage
 *  条目的可计费 token 求和（与 tokens 同口径；公式分协议形态、条目落盘前已算好，聚合只
 *  求和不重算）；usage.billable_partial = 窗口内存在「有 usage 但缺 billable_tokens 数字」
 *  的条目（旧版网关日志混入）时为 true，此时求和只是可得部分——消费方（编排侧 reconcile）
 *  据此整体回落文件直读。窗口内无任何 usage 条目：billable_tokens=0、partial=false。 */
/** 小时桶窗口封顶：与 USAGE_MAX_DAYS 联动（31 天 × 24 = 744）。usageQuery 已按日把窗口封到
 *  31 天、今日桶数恒不超限，此检查守的是未来日上限调大后 hours[] 无感膨胀——桶数超限直接
 *  400，不做静默截断（编排侧对账宁可显式失败不可缺桶）。 */
const USAGE_MAX_HOURS = 744
async function hUsage(c: AdminCtx): Promise<void> {
  const { req, res } = c
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const parsed = usageQuery(q)
  if (parsed.err) {
    sendError(res, 400, parsed.err, t('示例：/_modeldock/usage?date=2026-11-01&harness=zcode', 'Example: /_modeldock/usage?date=2026-11-01&harness=zcode'))
    return
  }
  const bucket = q.get('bucket')
  if (bucket != null && bucket !== 'hour') {
    return sendError(res, 400, t('usage 参数 bucket 非法：仅支持 hour', 'Invalid usage bucket parameter: only hour is supported'), t('示例：/_modeldock/usage?date=2026-11-01&bucket=hour', 'Example: /_modeldock/usage?date=2026-11-01&bucket=hour'))
  }
  const withHours = bucket === 'hour'
  if (withHours && parsed.days.length * 24 > USAGE_MAX_HOURS) {
    return sendError(res, 400, t('usage 小时桶窗口过大：最多查询 {n} 桶（31 天）', 'Usage hour-bucket window too large: query at most {n} buckets (31 days)', { n: USAGE_MAX_HOURS }), t('收窄 from/to 窗口后重试', 'Narrow the from/to window and retry'))
  }
  // 流式聚合：逐行读、边过滤边累加，不落全量数组——31 天查询曾把事件循环卡数秒、
  // 在途 SSE 全冻结（本端点是编排侧的轮询数据源，见 summarizeUsageDays 注释）
  const harness = q.get('harness') ?? undefined
  const profile = q.get('profile') ?? undefined
  const provider = q.get('provider') ?? undefined
  const withCost = q.get('cost') !== '0' // 缺省带成本；cost=0 只算 token（编排侧风暴闸等免查价路径）
  const filterOpt = { harness, profile, provider, fromMs: parsed.fromMs, toMs: parsed.toMs }
  const priceOf = withCost ? gatewayPriceResolver : undefined
  // 单趟双账：bucket=hour 经 summarizeUsageDaysWithHours 同管道同时出总账与小时桶，不二次扫文件
  const { usage, hours } = withHours
    ? await summarizeUsageDaysWithHours(parsed.days, filterOpt, priceOf)
    : { usage: await summarizeUsageDays(parsed.days, filterOpt, priceOf), hours: null as UsageHourBucket[] | null }
  const filter: Record<string, string> = {}
  if (harness) filter.harness = harness
  if (profile) filter.profile = profile
  if (provider) filter.provider = provider
  res.writeHead(200, { 'content-type': 'application/json' })
  const pricingError = withCost ? loadPricingOverrides().error ?? null : null
  res.end(JSON.stringify({ ok: true, days: parsed.days, filter: Object.keys(filter).length ? filter : null, pricing_error: pricingError, usage, ...(hours ? { hours } : {}) }))
  return
}

/** GET /_modeldock/logs/query：请求日志明细查询（admin 门内只读，编排器/Dockmaster 排障用）。
 *  /usage 只有聚合、/logs 只有内存环形缓冲（200 条），排障要窗口内明细条目（含 cause/attempts/
 *  hint/tokenHint，定义见 state/types.ts LogEntry）。from/to/date 口径与 /usage 完全一致
 *  （usageQuery，31 天封顶）；harness/provider/cause/status_class 精确过滤（status_class 取
 *  2xx…5xx）；limit 缺省 100、上限 500（非法值按 hLogs 先例夹紧不报错）；按时间倒序（最新在前）。
 *  条目原样返回落盘的 LogEntry——脱敏在落盘侧已完成（tokenHint 仅前 8 字符、无任何 key 材料），
 *  本端点绝不新增明文密钥字段。取数复用 /usage 的流式读（streamRequestLogDays），凑满 limit
 *  即停不再读更旧的日子。只读端点无状态变更，不记审计（跟随 /usage 先例）。 */
async function hLogsQuery(c: AdminCtx): Promise<void> {
  const { req, res } = c
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const parsed = usageQuery(q)
  if (parsed.err) {
    sendError(res, 400, parsed.err, t('示例：/_modeldock/logs/query?from=2026-11-01&harness=zcode&cause=upstream_4xx', 'Example: /_modeldock/logs/query?from=2026-11-01&harness=zcode&cause=upstream_4xx'))
    return
  }
  const statusClass = q.get('status_class') ?? undefined
  if (statusClass && !/^[1-5]xx$/.test(statusClass)) {
    return sendError(res, 400, t('logs/query 参数 status_class 非法：需为 2xx/3xx/4xx/5xx', 'Invalid logs/query status_class parameter: must be 2xx/3xx/4xx/5xx'))
  }
  const filter = {
    harness: q.get('harness') ?? undefined,
    provider: q.get('provider') ?? undefined,
    cause: q.get('cause') ?? undefined,
    statusClass,
    fromMs: parsed.fromMs,
    toMs: parsed.toMs,
  }
  const limit = Math.min(500, Math.max(1, Number(q.get('limit') ?? 100) || 100))
  // 倒序取数：日文件按时间正序追加，从最新日往回读；单日把命中条目滚动截到最新 limit 条
  // （内存有界），凑满 limit 即停、不再读更旧的日子。条目无跨日乱序可能（日文件按天归属）。
  const out: LogEntry[] = []
  for (let i = parsed.days.length - 1; i >= 0 && out.length < limit; i--) {
    const dayBuf: LogEntry[] = []
    for await (const e of streamRequestLogDays([parsed.days[i]], filter)) {
      dayBuf.push(e)
      if (dayBuf.length >= limit * 2) dayBuf.splice(0, dayBuf.length - limit) // 滚动裁头：只保最新的 limit 条
    }
    if (dayBuf.length > limit) dayBuf.splice(0, dayBuf.length - limit)
    dayBuf.reverse()
    out.push(...dayBuf)
    if (out.length > limit) out.splice(limit, out.length - limit)
  }
  const filterEcho: Record<string, string> = {}
  if (filter.harness) filterEcho.harness = filter.harness
  if (filter.provider) filterEcho.provider = filter.provider
  if (filter.cause) filterEcho.cause = filter.cause
  if (filter.statusClass) filterEcho.status_class = filter.statusClass
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, days: parsed.days, filter: Object.keys(filterEcho).length ? filterEcho : null, limit, entries: out }))
  return
}

/** POST /_modeldock/pricing-lookup：批量查价（编排侧燃油账用，admin 门内）。
 *  请求体 { models: Array<string | { provider?: string; model: string }> }（≤500 条）；
 *  响应 { ok, currency:'usd', unit:'per_million_tokens', prices, missing, overrides_error }——
 *  prices 键与请求条目一一对应（带 provider 的键为 "provider/model"），查不到的进 missing（不猜价）。 */
async function hPricingLookup(c: AdminCtx): Promise<void> {
  const { req, res } = c
  const b = await jsonRequestBody(req)
  const raw = Array.isArray(b.models) ? b.models : []
  const entries = raw
    .map((m: unknown) => {
      if (typeof m === 'string') return { provider: undefined, model: m.trim(), key: m.trim() }
      if (typeof m === 'object' && m !== null) {
        const o = m as Record<string, unknown>
        const model = typeof o.model === 'string' ? o.model.trim() : ''
        const provider = typeof o.provider === 'string' && o.provider.trim() ? o.provider.trim() : undefined
        if (model) return { provider, model, key: provider ? `${provider}/${model}` : model }
      }
      return null
    })
    .filter((x: unknown): x is { provider: string | undefined; model: string; key: string } => x !== null)
    .slice(0, 500)
  if (!entries.length) {
    return sendError(res, 400, t('缺少 models（模型名字符串或 {provider, model} 对象数组）', 'Missing models (array of model name strings or {provider, model} objects)'))
  }
  const { error } = loadPricingOverrides()
  const prices: Record<string, unknown> = {}
  const missing: string[] = []
  for (const e of entries) {
    const price = lookupPrice(e.provider, e.model)
    if (price) prices[e.key] = { ...price, source: 'priced' }
    else missing.push(e.key)
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, currency: 'usd', unit: 'per_million_tokens', prices, missing, overrides_error: error ?? null }))
  return
}

/** POST /_modeldock/tier-validate：token → harness → profile 权威事实回报（编排侧 tier 校验用，
 *  admin 门内；2026-11-02 船东授权 .agents 使用 admin 面）。请求体 { token?, tier? }——tier 仅
 *  回传对照，判定语义（别名归一等）在编排侧。响应：ok:false（token 未命中/无法解析，reason）
 *  或 ok:true + harness/profile/provider/tier（profile.tier 标签，可 null）+ models（该 profile
 *  当前 provider 的目录 id）+ tier_profiles（全库 tier 标签 → profile id 清单，供「tier 已打标
 *  但 token 指向别档」判定）。token 不回显（口径见 hProvisionHarness 注）。 */
async function hTierValidate(c: AdminCtx): Promise<void> {
  const { rt, req, res } = c
  const b = await jsonRequestBody(req)
  const token = typeof b.token === 'string' ? b.token : ''
  const wantedTier = typeof b.tier === 'string' ? b.tier.trim() : ''
  if (!token) return sendError(res, 400, t('缺少 token', 'Missing token'))
  const resolved = resolveTarget(rt, token)
  if (!resolved.ok) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, reason: resolved.status === 401 ? 'unknown_token' : `resolve_${resolved.status}` }))
    return
  }
  const { target } = resolved
  const providerId = target.profile.provider
  const tierProfiles: Record<string, string[]> = {}
  for (const [id, p] of Object.entries(rt.config.profiles)) {
    const tag = typeof p.tier === 'string' && p.tier.trim() ? p.tier.trim() : null
    if (tag) (tierProfiles[tag] ??= []).push(id)
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      ok: true,
      harness: target.harness,
      profile: target.profileName,
      provider: providerId,
      tier: rt.config.profiles[target.profileName]?.tier ?? null,
      ...(wantedTier ? { requested_tier: wantedTier } : {}),
      models: Object.keys(rt.config.providers[providerId]?.models ?? {}),
      tier_profiles: tierProfiles,
    })
  )
  return
}

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

import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { createHash, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { safeEqual } from '../util/safe-equal.js'
import { fetchEnvelopeFromUrl, projectModel } from './shared.js'
import { CONSOLE_CSP } from './console-shared.js'
import { clearCommandMemo, commandOnPath, commandOnPathSandbox, randomToken, readTextIfExists } from '../util/fsx.js'
import { localIsoTs } from '../util/time.js'
import { ConfigError, loadConfig, mutateConfig } from '../config/store.js'
import { DEFAULT_GATEWAY_PORT, DEFAULT_LAN_PORT, DEFAULT_LOG_RETENTION_DAYS, type Config, type ProviderConfig } from '../config/types.js'
import { defaultStore, deleteSecret, getSecret, setSecret, verifySecretsStore } from '../config/secrets.js'
import { allAdapters, requireAdapter } from '../adapters/registry.js'
import { isNpmGlobalInstall, resolveInstallCommand, type ClientInstall, type HarnessAdapter } from '../adapters/types.js'
import { engineWarningHint, ensureNodeRuntime, installChildEnv } from '../install/noderuntime.js'
import { applyChanges } from '../adapters/engine.js'
import { PRESETS, ensurePresetsLoaded, knownModelsForBaseUrl, presetModels } from '../presets/data.js'
import { addService, applyAttach, detachHarness, planAttach, refreshBakedModelClients, removeProviderCascade, resyncHarnessToRoute, setAutoRoute, setRouteNext, switchHarnessMode, switchToServiceWithRoute, syncBakedClientsForDisplayRoute } from '../ops.js'
import { autostartOverview, installAutostart, uninstallAutostart, updateDaemonArgs } from '../autostart.js'
import { applyImport, normalizeBaseUrl, scanSources } from '../import/sources.js'
import { resolveModelMeta, fullKnownTable } from '../providers/resolve.js'
import { knownMetaTable, saneCapabilities } from '../providers/known.js'
import { refreshCatalog } from '../providers/catalog.js'
import { fetchModelIds } from '../providers/fetch.js'
import { autoRouteInfo, checkTokenLimits, eventLoopLagMs, isMeltdown, latencyQuantiles, logAudit, logEvent, logRequest, mutateGatewayState, parseFallbackEntry, pickTarget, pruneExpiredLogs, readGatewayState, recordTokenUsage, reloadRuntime, resolveByProfile, resolveTarget, summarizeUsageDays, type GatewayRuntime, type LogEntry, type ResolvedTarget } from './state.js'
import { readSyncState } from '../sync/state.js'
import { appendLineErrorCount } from '../util/fsx.js'
import { dispatcherFor } from './proxy.js'
import { buildLanStatus, clearSyncRequest, createSyncOffer, peekSyncRequest, putSyncGrant, refreshPreferredAddress, resolveLanToken, startLanServer, stopLan } from './lan.js'
import { discoverPeers } from './discover.js'
import { markUiLeaving, markUiPing, markUiSeen, pendingTrayLiteRequest, requestTrayLite, trayLiteActive } from './presence.js'
import { adminCookieName, deviceCookieName } from './cookies.js'
import { createUsageTap } from './usage.js'
import { refreshCalendar } from './holidays.js'
import { syncStatus } from '../sync/engine.js'
import { openEnvelope, sealEnvelope } from '../sync/crypto.js'
import { applyImportedDoc, assertExportable, exportFileName, reportOfDoc } from '../sync/exportImport.js'
import { collectSyncdoc } from '../sync/collect.js'
import { validateSyncdoc, type Syncdoc } from '../sync/types.js'
import { applyUpdate, getUpdateStatus, kickUpdateCheck } from '../update/webupdate.js'
import { filterResponseHeaders, forwardToUpstream, forwardWithFailover, readUpstreamErrorText, translateUpstreamError, UpstreamError, type UpstreamResult } from './relay.js'
import { request as undiciRequest } from 'undici'
import { t, bi, biCat, biJoin, runWithLang, normalizeLang, getLang, type Bilingual } from '../util/i18n.js'
import { displayPath, gatewayStatePath, logsDir, modeldockDir, sandboxNpmPrefix, secretsPath } from '../util/paths.js'
import { UI_HTML } from './ui.js'

// T05 拆分后保持原导入面：测试与潜在外部引用仍按 server.js 路径取这些符号
export { OVERVIEW_TTL_MS, overviewCacheHit, overviewServeDecision, warmupOverview } from './overview-view.js'
export { runClientInstall, runClientUninstall } from './install.js'
export { errorReply, maxBodyBytes } from './admin-shared.js'
import { INSTALL_OUTPUT_MAX, hInstall, hUninstall, runClientInstall, runClientUninstall, runInstallCommand, runShell, sandboxInstallCapability, tailText } from './install.js'
import { AdminCtx, errorReply, jsonRequestBody, maxBodyBytes, persistConfig, profileForProvider, profileRefForProvider, readBody, sendError } from './admin-shared.js'
import { FETCH_MODEL_FAIL_TTL_MS, REMOTE_REQUEST_TTL_MS, SYNC_TICKET_TTL_MS, fetchModelFailMemo, hSyncRemoteStatus, hSyncRequestRemote, putSyncTicket, registerWebDevice, rememberFetchModelFail, remoteRequests, runRemoteRequest, sleep, sweepRemoteRequests, sweepSyncTickets, syncTickets, takeSyncTicket } from './remote-device.js'
import { OVERVIEW_TTL_MS, buildConfigView, buildOverview, hOverview, hTrayLite, hTrayState, hUiPresence, invalidateOverviewCache, overviewRebuilding, overviewServeDecision, overviewViewData, rebuildOverview } from './overview-view.js'
import { hUpdateApply, hUpdateCheck, hUpdateStatus } from './update-panel.js'
import { hConfigExport, hSyncDiscover, hSyncImport, hSyncOffer, hSyncOfferApprove } from './configpack.js'

export interface GatewayStartOptions {
  port: number
  idleTimeoutMs?: number
  retries?: number
  /** 法定节假日每年自动获取（holiday-cn 数据）；默认开启，测试传 false 避免 90s 首查触发出站请求 */
  autoHolidayRefresh?: boolean
  /** 模型元数据目录（models.dev）自动刷新；默认开启，测试传 false 避免出站请求 */
  autoCatalogRefresh?: boolean
}

/** 锁屏提示展示的 gateway.json 路径：随实例实际 home 走（沙箱/自定义 home 时不是 ~/.modeldock），
 *  缩写规则统一走 paths.displayPath（只对真实系统 home 缩写为 ~） */
// 控制台 HTML 体与 home 路径在单进程内固定（displayPath(gatewayStatePath()) 只随环境变量走），
// 惰性渲染一次后缓存最终 HTML 与其内容 ETag，避免每请求整包 replaceAll + 算 hash。
// 缓存以 home 路径为键：生产单进程恒定只算一次；单进程共享单测（fakeHome 每用例换 home）
// 在 home 变化时自动重渲，不服务到旧路径。
// lang 不含进缓存键：UI_HTML 文案经 data-i18n 浏览器端切换，静态体与请求语言无关。
let renderedUICache: { home: string; html: string; etag: string; gzip: Buffer; gzipEtag: string } | null = null
function getRenderedUI(): { html: string; etag: string; gzip: Buffer; gzipEtag: string } {
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
function catalogView(): { data: string; etag: string } {
  const table = fullKnownTable()
  if (catalogViewCache && catalogViewCache.table === table) return catalogViewCache
  const data = JSON.stringify({ ok: true, models: table })
  const etag = '"' + createHash('sha256').update(data).digest('base64url').slice(0, 22) + '"'
  catalogViewCache = { table, data, etag }
  return catalogViewCache
}







/** Claude Code gateway discovery 的硬过滤：模型 ID 不含 claude/anthropic 字样的条目全部丢弃
 *  （2.1.296 二进制实测：filter(te=>/(claude|anthropic)/i.test(te.id))，全滤光时
 *  「0 usable models after filter」，/model 选择器只剩内置档位）。 */
const DISCOVERY_ID_RE = /(claude|anthropic)/i

/** discovery 场景服务的模型 ID：非 Claude 系 ID 加 `anthropic.` 前缀别名（Bedrock 同款惯例）
 *  以通过上述过滤；转发时 rewriteModel 按服务目录还原真实 ID，picker 标签仍显示 display_name。 */
function discoveryModelId(id: string): string {
  return DISCOVERY_ID_RE.test(id) ? id : `anthropic.${id}`
}

/** 本地合成 /v1/models 响应：Anthropic 形状为主（type/display_name + 分页字段），兼容 OpenAI 字段
 *  （object/created/owned_by）——两类 SDK 各取所需，多余字段互不解析。目录按写入顺序排列；
 *  有 display_name 的显示名称、没有的回落 ID；目录为空返回空列表（picker 无自定义项，
 *  档位请求仍走内置名兜底改写，不劣化）。discoveryAliases=true（请求带 anthropic-version 头，
 *  即 Claude Code discovery）时对非 Claude 系 ID 加 anthropic. 前缀别名，否则原样。 */
function modelsListPayload(cfg: Config, providerId: string, discoveryAliases: boolean) {
  const provider = cfg.providers[providerId]
  const data = Object.entries(provider?.models ?? {}).map(([rawId, m]) => {
    const id = discoveryAliases ? discoveryModelId(rawId) : rawId
    return {
      id,
      type: 'model',
      display_name: m.display_name || rawId,
      object: 'model',
      created: 0,
      owned_by: providerId,
    }
  })
  return {
    data,
    first_id: data[0]?.id,
    has_more: false,
    last_id: data[data.length - 1]?.id,
  }
}

/** 各网关实例的 picker 展示路由基线（route=上次已同步的展示服务）。模块级 WeakMap：周期检测
 *  在 createGatewayServer 闭包里跑，而 attach/apply handler 在 handleRequest 里——接入后把
 *  基线置 undefined（强制下一周期校准 picker）需要两处共享。按 rt 弱引用，实例关闭自动可回收。 */
const pickerSyncStates = new WeakMap<GatewayRuntime, { route?: string }>()

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
        if (r.status >= 500) console.error("[gateway] " + req.method + " " + (req.url ?? "") + " " + t('网关内部错误:', 'Gateway internal error:'), e)
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
        // 定时窗口接管重写客户端失败不再无声吞掉：事件落 ring/events.jsonl 可排查
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

  // 管理面
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
    log({ harness: '-', profile: '-', provider: '-', path: url, status: resolved.status, err, ms: Date.now() - started, ...(tokenHint ? { tokenHint } : {}) })
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
    if (wanted && !rt.config.providers[wanted]) {
      return sendError(
        res,
        404,
        t('服务「{id}」不存在', 'Service "{id}" not found', { id: wanted }),
        t('modeldock provider list 查看服务列表，或在 Web 控制台「服务」页确认 ID', 'Run modeldock provider list to view services, or check the ID on the Services page of the web console')
      )
    }
    let listProviderId = wanted
    if (!listProviderId) {
      // target 由 resolveTarget 解析（active_profile 或 harness 钉定），不含定时窗口；
      // 用同一 pickTarget 首候选把目录切到真正在用的服务，避免窗口期列表与转发各说各话
      const picked = pickTarget(rt, target, target.profile.fallback)
      listProviderId = (picked.ok ? picked.ordered[0].target : target).profile.provider
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(modelsListPayload(rt.config, listProviderId, req.headers['anthropic-version'] !== undefined)))
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
    log({ harness: target.harness, profile: target.profileName, provider: '-', path: url, status: 429, ms: Date.now() - started, err: msg })
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
  let result: UpstreamResult & { usedProviderId?: string; reason?: string }
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
      log({ harness: target.harness, profile: target.profileName, provider: target.profile.provider, path: url, status: 499, ms: Date.now() - started, err: t('客户端已断开，转发中止', 'Client disconnected; forwarding aborted') })
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
      })
      return sendError(res, e.status, e.message, e.hint)
    }
    throw e
  }
  // 自动路由后以最终生效的 provider 记日志
  const providerId = result.usedProviderId ?? target.profile.provider
  const reason = result.reason
  const model = result.modelAfter ?? target.profile.default_model

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
    log({ harness: target.harness, profile: target.profileName, provider: providerId, model, path: url, status: result.status, ms: Date.now() - started, err: wrapped.slice(0, 200), reason })
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
    log({ harness: target.harness, profile: target.profileName, provider: providerId, model, path: url, status: result.status, ms: Date.now() - started, reason, usage })
  } catch (e) {
    log({ harness: target.harness, profile: target.profileName, provider: providerId, model, path: url, status: result.status, ms: Date.now() - started, err: t('流中断：{msg}', 'Stream interrupted: {msg}', { msg: (e as Error).message }), reason, usage })
  }
  // 当日花费累计（水密舱熔断丝的用量侧）：成功与流中断都算已消耗；无 limits 配置时静默跳过
  recordTokenUsage(rt, target.harness, usage)
}

// 管理面

/** 管理面所有端点（含 GET）的 Host 白名单：DNS rebinding 的 Host 不是本机，读取类端点同样拒绝。
 *  参照 Vite allowedHosts（CVE-2025-31125 同类问题的标准修法）。 */
function hostAllowed(req: http.IncomingMessage): boolean {
  const host = String(req.headers.host ?? '')
  return /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i.test(host)
}

// cookie 名 → 提取正则缓存：admin/device cookie 名在进程内只有个位数个（随端口），避免每请求重新编译
const cookieValueReCache = new Map<string, RegExp>()
function cookieValueRe(name: string): RegExp {
  let re = cookieValueReCache.get(name)
  if (!re) {
    re = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)
    cookieValueReCache.set(name, re)
  }
  return re
}

/** cookie 值解码：畸形值（如裸 `%`）会让 decodeURIComponent 抛 URIError 穿到顶层变 500，
 *  这里按解码失败=值不匹配处理，让鉴权路径落到正常的 401/403。 */
function safeCookieDecode(v: string): string {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

function adminAuthorized(rt: GatewayRuntime, req: http.IncomingMessage): boolean {
  const h = req.headers['x-modeldock-admin']
  if (typeof h === 'string' && safeEqual(h, rt.adminToken)) return true
  // Web 控制台的 cookie 登录（HttpOnly + SameSite=Lax，跨站 POST 不携带）
  const cookie = req.headers.cookie
  if (typeof cookie === 'string') {
    const m = cookieValueRe(adminCookieName(rt.port ?? DEFAULT_GATEWAY_PORT)).exec(cookie)
    if (m && safeEqual(safeCookieDecode(m[1]), rt.adminToken)) return true
  }
  return false
}





























type AdminHandler = (c: AdminCtx) => Promise<void>

// attach 请求体里的 client_profiles：["desktop"] 或 "desktop,web"（后者兼容表单直传）；非法输入一律忽略为全部
const parseClientProfiles = (v: unknown): string[] | undefined => {
  const list = Array.isArray(v)
    ? v.map((x) => String(x).trim()).filter(Boolean)
    : typeof v === 'string'
      ? v.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  return list.length > 0 ? list : undefined
}

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
  const total = rt.ring.length
  // page 从 1 数起，第 1 页是最新 n 条（ring 按 时间正序 追加）；越界页返回空数组
  const page = Math.max(1, Number(q.get('page') ?? 1) || 1)
  const pages = Math.max(1, Math.ceil(total / n))
  const end = Math.max(0, total - (page - 1) * n)
  const start = Math.max(0, end - n)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ logs: rt.ring.slice(start, end), total, page, pages }))
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




async function hFetchModels(c: AdminCtx): Promise<void> {
  const { rt, req, res } = c
  // 添加服务时预览拉取：按临时地址+Key 拉取模型，不落盘。
  // 编辑弹窗场景传 id 而不传 key（Key 输入框留空=不修改）：用该服务已保存的 Key 拉取
  const b = await jsonRequestBody(req)
  const baseUrl = typeof b.base_url === 'string' ? b.base_url.trim() : ''
  let key = typeof b.key === 'string' ? b.key.trim() : ''
  const refId = typeof b.id === 'string' ? b.id.trim() : ''
  if (!key && refId) {
    const ref = rt.config.providers[refId]
    if (!ref) return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id: refId }))
    key = (await getSecret(ref.key_ref)) ?? ''
    if (!key) return sendError(res, 400, t('已保存的 Key 不可读（未设置或系统安全后端拒绝访问），请手动粘贴 Key 后拉取', 'Saved key unreadable (not set or the OS keychain refused access); paste the key manually and fetch again'))
  }
  const proto = (b.protocol === 'openai' || b.protocol === 'responses') ? b.protocol : 'anthropic'
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return sendError(res, 400, t('请先填写协议接口地址（http/https）', 'Fill in the endpoint URL first (http/https)'))
  if (!key) return sendError(res, 400, t('key 不能为空：请先粘贴 Key 再拉取', 'Key is empty: paste the key before fetching'))
  const provider: import('../config/types.js').ProviderConfig = {
    base_url: baseUrl,
    protocol: proto,
    auth_style: 'bearer',
    key_ref: key,
    proxy: 'direct',
  }
  /** 拉取失败/无结果时按厂商 host 回退到 ModelDock 已知模型（预设自带上下文/输出）。声明放在首个调用点之前。 */
  function knownFallback() {
    const fb = knownModelsForBaseUrl(baseUrl)
    return Object.entries(fb).map(([id, m]) => ({ id, display: m.display_name ?? id, context_window: m.context_window ?? null, max_output: m.max_output ?? null, capabilities: m.capabilities ?? [] }))
  }
  // 失败负缓存见 fetchModelFailMemo：改过 Key / 地址就是新的 memo 键，不受缓存影响
  const failKey = `${proto}|${baseUrl}|${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
  let cachedFail = false
  try {
    const recentFail = fetchModelFailMemo.get(failKey)
    if (recentFail && Date.now() - recentFail.at < FETCH_MODEL_FAIL_TTL_MS) {
      cachedFail = true
      throw new Error(recentFail.msg)
    }
    const f = await fetchModelIds(provider)
    let arr: { id: string; display: string; context_window: number | null; max_output: number | null; capabilities: string[] }[] = f.ids.map((id: string) => {
      // 填充链：上游响应自带值 > 内置表 > models.dev 目录（按 base_url host 精确匹配优先）；能力只看内置表（上游不报此项）
      const km = resolveModelMeta(id, null, { upstream: f.meta?.[id], baseUrl })
      return { id, display: f.display[id] ?? id, context_window: km?.context_window ?? null, max_output: km?.max_output ?? null, capabilities: km?.capabilities ?? [] }
    })
    let from = 'fetched'
    if (arr.length === 0) { arr = knownFallback(); from = 'known' }
    if (arr.length === 0) return sendError(res, 400, t('未拉取到模型，且本地没有该厂商的已知模型', 'No models fetched and no known models for this vendor locally'), t('可在「编辑服务」里手动登记模型', 'You can register models manually in "Edit Service"'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, protocol: proto, from, models: arr }))
  } catch (e) {
    if (!cachedFail) rememberFetchModelFail(failKey, (e as Error).message)
    // 拉取失败 → 按厂商 host 回退到 ModelDock 已知模型（预设自带上下文/输出）
    const arr = knownFallback()
    if (!arr.length) return sendError(res, 400, t('拉取模型失败：{msg}', 'Failed to fetch models: {msg}', { msg: (e as Error).message }), t('检查接口地址 / Key / 网络（境外上游需代理）', 'Check the endpoint URL / key / network (overseas upstreams need a proxy)'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, protocol: proto, from: 'known', models: arr }))
  }
  return
}

async function hServiceAdd(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  try {
    const r = await addService(String(b.presetId ?? ''), String(b.key ?? ''), {
      setActiveIfEmpty: b.setActiveIfEmpty !== false,
      fetch: b.fetch !== false,
      name: typeof b.name === 'string' ? b.name : undefined,
      base_url: typeof b.base_url === 'string' ? b.base_url : undefined,
      protocol: (b.protocol === 'anthropic' || b.protocol === 'openai' || b.protocol === 'responses') ? b.protocol : undefined,
      endpoints: b.endpoints && typeof b.endpoints === 'object' && !Array.isArray(b.endpoints) ? b.endpoints : undefined,
      models: b.models && typeof b.models === 'object' && !Array.isArray(b.models) ? b.models : undefined,
      defaultModel: typeof b.default_model === 'string' && b.default_model.trim() ? b.default_model.trim() : undefined,
      fallback: Array.isArray(b.fallback) ? b.fallback.map((x: unknown) => String(x)) : undefined,
    })
    await reloadRuntime(rt)
    audit(
      bi('添加服务', 'Add service'),
      r.providerId,
      biCat(
        bi('预设 {preset}，路由 {route}，模型 {n} 个', 'Preset {preset}, route {route}, {n} models', { preset: String(b.presetId ?? '-'), route: r.profileName, n: r.fetched }),
        r.fetchError ? bi('（拉取失败已兜底：{msg}）', ' (fetch failed, fell back: {msg})', { msg: r.fetchError }) : ''
      )
    )
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...r }))
  } catch (e) {
    audit(bi('添加服务', 'Add service'), String(b.presetId ?? '-'), undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

async function hSwitch(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  try {
    // 一次整包落盘完成 active_profile + 人工钉定主服务（人为修改优先于定时窗口与自动选路），默认路由同步跟随
    // 最后一次人工选择；钉定持续到「当前」选回「自动 · X」（清除 auto_route_provider），期间定时窗口让位
    const profileName = await switchToServiceWithRoute(String(b.service ?? ''), rt.config.gateway?.auto_failover === true)
    await reloadRuntime(rt)
    // dsh/workbuddy/zcode 的模型列表烙在客户端配置文件里，切全局后需按新路由重写才跟随
    const baked = await refreshBakedModelClients({ port: rt.port })
    const detail = biCat(
      bi('当前路由 → {route}', 'Current route → {route}', { route: profileName }),
      baked.refreshed.length ? bi('；已同步重写 {list} 的客户端配置', '; rewrote client configs for {list}', { list: biJoin('、', ', ', baked.refreshed) }) : '',
      baked.warnings.length ? bi('；{list}', '; {list}', { list: biJoin('；', '; ', baked.warnings) }) : ''
    )
    audit(bi('切换服务', 'Switch service'), String(b.service ?? '-'), detail)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: b.service, profile: profileName, ...baked }))
  } catch (e) {
    audit(bi('切换服务', 'Switch service'), String(b.service ?? '-'), undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

async function hAutoRoute(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  try {
    // 部分更新语义：未传的字段保持现状（开关 / 主服务钉定 / 下一个切换钉定 / 限流切换 / 自动备用链在 UI 各自独立调用）
    const enabled = b.enabled === undefined
      ? rt.config.gateway?.auto_failover === true
      : b.enabled === true || b.enabled === 'true'
    const provider = 'provider' in b
      ? (typeof b.provider === 'string' && b.provider.trim() ? b.provider.trim() : null)
      : undefined
    const failoverOn429 = b.failoverOn429 === undefined ? undefined : b.failoverOn429 === true
    const autoFallback = b.autoFallback === undefined ? undefined : b.autoFallback === true
    const next = 'next' in b
      ? (typeof b.next === 'string' && b.next.trim() ? b.next.trim() : null)
      : undefined
    const r = await setAutoRoute(enabled, provider, failoverOn429, autoFallback)
    const n = next === undefined ? undefined : await setRouteNext(next)
    await reloadRuntime(rt)
    audit(
      bi('自动路由', 'Auto route'),
      enabled ? bi('开启', 'on') : bi('关闭', 'off'),
      biCat(
        `auto_failover=${r.enabled} primary=`,
        r.provider ?? bi('自动', 'auto'),
        n === undefined ? '' : biCat(' next=', n ?? bi('自动', 'auto')),
        failoverOn429 === undefined ? '' : bi(' 限流切换={v}', ' failover-on-429={v}', { v: failoverOn429 ? bi('开', 'on') : bi('关', 'off') }),
        autoFallback === undefined ? '' : bi(' 自动备用链={v}', ' auto-fallback={v}', { v: autoFallback ? bi('开', 'on') : bi('关', 'off') })
      )
    )
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...r, next: n ?? rt.config.gateway?.route_next ?? null }))
  } catch (e) {
    audit(bi('自动路由', 'Auto route'), '-', undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

async function hSchedule(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 定时切换：整体替换 {enabled, windows}。窗口按配置顺序取首个命中；空 windows = 清除
  const b = await jsonRequestBody(req)
  const enabled = b.enabled !== false
  if (b.windows !== undefined && !Array.isArray(b.windows)) {
    return sendError(res, 400, t('windows 应为数组', 'windows must be an array'))
  }
  const windows: import('../config/types.js').ScheduleWindow[] = []
  for (const w of b.windows ?? []) {
    const start = String(w?.start ?? '').trim()
    const end = String(w?.end ?? '').trim()
    const target = String(w?.target ?? '').trim()
    const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/
    if (!hhmm.test(start) || !hhmm.test(end)) {
      return sendError(res, 400, t('时段「{from}-{to}」无效，时间应为 HH:mm', 'Window "{from}-{to}" is invalid; times must be HH:mm', { from: start || '?', to: end || '?' }))
    }
    if (start === end) return sendError(res, 400, t('时段「{from}-{to}」起止相同，不会生效', 'Window "{from}-{to}" has identical start and end; it would never apply', { from: start, to: end }))
    const parsed = parseFallbackEntry(target)
    if (!parsed) return sendError(res, 400, t('时段目标「{target}」无效，应为 服务ID 或 服务ID:模型ID', 'Window target "{target}" is invalid; expected ServiceID or ServiceID:ModelID', { target }))
    if (!rt.config.providers[parsed.providerId]) {
      return sendError(res, 400, t('时段目标服务「{id}」不存在', 'Window target service "{id}" not found', { id: parsed.providerId }), t('在「我的服务」查看服务 ID，或刷新页面同步最新列表', 'Check service IDs in "My Services", or refresh the page for the latest list'))
    }
    // 窗口模式：avoid（避开该服务）或缺省 prefer（优先走该服务/模型）；avoid 仅到服务粒度，模型部分剥掉按整个服务避开
    const mode = w.mode === undefined || w.mode === null || w.mode === '' ? undefined : String(w.mode).trim()
    if (mode !== undefined && mode !== 'prefer' && mode !== 'avoid') {
      return sendError(res, 400, t('时段模式「{mode}」无效，应为 prefer（优先走）或 avoid（避开）', 'Window mode "{mode}" is invalid; expected prefer or avoid', { mode }))
    }
    const avoid = mode === 'avoid'
    // 生效日类型：缺省/any=每天；workday=周一至五与调休补班日（不含法定节假日）；weekend；holiday
    const dayFilterRaw = w.dayFilter === undefined || w.dayFilter === null || w.dayFilter === '' ? undefined : String(w.dayFilter).trim()
    if (dayFilterRaw !== undefined && dayFilterRaw !== 'any' && dayFilterRaw !== 'workday' && dayFilterRaw !== 'weekend' && dayFilterRaw !== 'holiday') {
      return sendError(res, 400, t('生效日类型「{v}」无效，应为 any / workday / weekend / holiday', 'Day filter "{v}" is invalid; expected any / workday / weekend / holiday', { v: dayFilterRaw }))
    }
    const dayFilter = !dayFilterRaw || dayFilterRaw === 'any' ? undefined : (dayFilterRaw as 'workday' | 'weekend' | 'holiday')
    let days: number[] | undefined
    if (Array.isArray(w.days)) {
      const set = new Set<number>()
      for (const d of w.days as unknown[]) {
        const n = Number(d)
        if (Number.isInteger(n) && n >= 1 && n <= 7) set.add(n)
      }
      days = [...set]
      if (days.length === 0) days = undefined
    }
    windows.push({
      start,
      end,
      target: !avoid && parsed.model ? `${parsed.providerId}:${parsed.model}` : parsed.providerId,
      ...(avoid ? { mode: 'avoid' as const } : {}),
      ...(days ? { days } : {}),
      ...(dayFilter ? { dayFilter } : {}),
    })
  }
  await persistConfig(rt, (c) => {
    const g: import('../config/types.js').GatewayConfig = { ...(c.gateway ?? {}) }
    if (!windows.length) delete g.schedule
    else g.schedule = { enabled, windows }
    c.gateway = g
  })
  audit(bi('定时切换', 'Schedule'), enabled ? bi('启用', 'enabled') : bi('停用', 'disabled'), bi('{n} 个时段', '{n} windows', { n: windows.length }))
  // 用户开始使用定时切换后立即后台拉取一次法定节假日（数据源 holiday-cn，失败静默）
  void refreshCalendar(rt, { manual: false }).catch(() => {})
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, windows: windows.length }))
  return
}

async function hHolidaysCn(c: AdminCtx): Promise<void> {
  const { rt, res, audit } = c
  // 手动触发节假日日历更新（控制台已删手动按钮，日历每日自动更新；端点留给 CLI/运维）：拉取今年/明年数据写缓存，日类型判定随之生效
  const r = await refreshCalendar(rt, { manual: true }).catch((e) => {
    throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { hint: t('请检查网络后重试；数据源为 holiday-cn（依据国务院办公厅公告校对）', 'Check the network and retry; data source is holiday-cn (verified against State Council announcements)') })
  })
  audit(
    bi('节假日日历', 'Holiday calendar'),
    bi('获取', 'Fetch'),
    r.years.length
      ? bi('更新 {years}，共 {n} 条', 'Updated {years}, {n} entries', { years: biJoin('、', ', ', r.years), n: r.updatedDays })
      : bi('数据源无变化', 'No changes from data sources')
  )
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, ...r }))
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
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (e as Error).message }))
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

async function hImportDetect(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  // 扫描本机各客户端/工具的现有配置（cc-switch / Claude Code / Codex / dsh / ZCode / OpenCode /
  // MiMo / WorkBuddy / CCR / Crush / Gemini CLI）；绝不回传 Key 明文
  const cands = await scanSources('all')
  const existingNorms = new Set(
    Object.values(rt.config.providers).map((p) => normalizeBaseUrl(p.base_url))
  )
  const dismissed = new Set((rt.config.import?.dismissed ?? []).map((u) => normalizeBaseUrl(u)))
  // 同站点提示索引：同主机不同端点（双协议各登记一份等）不算重复，但标注出来供用户判断
  const hostNames = new Map<string, string[]>()
  for (const [pid, p] of Object.entries(rt.config.providers)) {
    try {
      const h = new URL(p.base_url).hostname.toLowerCase()
      const nm = p.name?.trim() || pid
      const arr = hostNames.get(h) ?? []
      if (!arr.includes(nm)) arr.push(nm)
      hostNames.set(h, arr)
    } catch {
      /* 非法地址不参与提示 */
    }
  }
  const candidates = cands.map((c) => {
    const norm = normalizeBaseUrl(c.base_url)
    const dup = existingNorms.has(norm)
    let sameSite: string | undefined
    if (!dup && c.base_url) {
      try {
        const names = hostNames.get(new URL(c.base_url).hostname.toLowerCase())
        if (names?.length) {
          sameSite = t('与已有服务「{name}」同一站点', 'Same site as existing service "{name}"', { name: names.join('、') })
        }
      } catch {
        /* 非法地址不参与提示 */
      }
    }
    return {
      id: c.suggest_id,
      source: c.source,
      name: c.name,
      base_url: c.base_url,
      hasKey: !!c.key,
      isCurrent: !!c.is_current,
      dismissed: dismissed.has(norm) || undefined,
      sameSite,
      skipReason: c.skip_reason ?? (dup ? t('已在 ModelDock 中', 'Already in ModelDock') : undefined),
    }
  })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, candidates }))
  return
}

async function hImportApply(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  const wantedIds: string[] | null = Array.isArray(b.ids) ? b.ids.map(String) : null
  const cands = await scanSources('all')
  // 地址重复的兜底在 applyImport 内（含批内去重），这里只按用户勾选与可导入性过滤
  const chosen = cands.filter(
    (c) => !c.skip_reason && c.base_url && (wantedIds === null || wantedIds.includes(c.suggest_id))
  )
  if (chosen.length === 0) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, imported: [], profiles: [], skipped: [] }))
    return
  }
  const report = await mutateConfig((c) => applyImport(c, chosen, { withProfiles: true }))
  await reloadRuntime(rt)
  audit(bi('导入配置', 'Import configs'), report.providers.join(',') || '-', bi('导入 {p} 个服务 / {r} 条路由', 'Imported {p} services / {r} routes', { p: report.providers.length, r: report.profiles.length }))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, imported: report.providers, profiles: report.profiles, skipped: report.skipped }))
  return
}

async function hImportDismiss(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 忽略候选（按归一化地址持久化，跨浏览器生效）：自动弹卡不再提示；勾选导入手动入口不受影响，随时可搬回
  const b = await jsonRequestBody(req)
  // b 是不可信 JSON（any）：显式按 unknown[] 收口——元素 String() 归一化后归一化地址、过滤空值
  const urls: string[] = Array.isArray(b.urls)
    ? [...new Set((b.urls as unknown[]).map((u) => normalizeBaseUrl(String(u))).filter((u): u is string => !!u))]
    : []
  if (urls.length === 0) {
    return sendError(res, 400, t('缺少 urls：要忽略的候选地址数组', 'Missing urls: the array of candidate base URLs to dismiss'))
  }
  await mutateConfig((c) => {
    const set = new Set(c.import?.dismissed ?? [])
    for (const u of urls) set.add(u)
    c.import = { ...c.import, dismissed: [...set] }
  })
  await reloadRuntime(rt)
  audit(bi('忽略导入候选', 'Dismiss import candidates'), String(urls.length))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, dismissed: urls.length }))
  return
}

async function hServiceUpdate(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 编辑模型服务：显示名称 / 接口地址 / Key / 模型目录（任选）
  const b = await jsonRequestBody(req)
  const id = typeof b.provider === 'string' ? b.provider : ''
  const p = rt.config.providers[id]
  if (!p) return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id }))
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  const baseUrl = typeof b.base_url === 'string' ? b.base_url.trim() : ''
  // 默认协议随编辑可变（三协议端点直排后由填写的行推导，缺省保持现状）
  const newProtocol = b.protocol === 'anthropic' || b.protocol === 'openai' || b.protocol === 'responses' ? b.protocol : undefined
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    return sendError(res, 400, t('接口地址必须以 http:// 或 https:// 开头', 'Base URL must start with http:// or https://'))
  }
  // 去重口径与 addService 一致：同地址且同 Key 才算重复；
  // 同地址不同 Key 是「同一厂商多个账号分别登记」的合法场景，允许共存。
  // 仅当本次提交真正改动了地址或 Key 时才校验，避免历史同对数据在改名等无关编辑时被误拦。
  const hasNewKey = typeof b.key === 'string' && !!b.key
  const oldKey = p.key_ref ? (await getSecret(p.key_ref)) ?? '' : ''
  const effectiveKey = hasNewKey ? (b.key as string) : oldKey
  const urlChanged = !!baseUrl && normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(p.base_url)
  const keyChanged = hasNewKey && (b.key as string) !== oldKey
  if (urlChanged || keyChanged) {
    const norm = normalizeBaseUrl(baseUrl || p.base_url)
    for (const [pid, other] of Object.entries(rt.config.providers)) {
      if (pid === id) continue
      if (normalizeBaseUrl(other.base_url) !== norm) continue
      const otherKey = other.key_ref ? (await getSecret(other.key_ref)) ?? '' : ''
      if (otherKey === effectiveKey) {
        return sendError(res, 400, t('该地址与已有服务「{id}」重复（同地址同 Key）；同地址不同 API Key 可分别保存', 'This URL duplicates existing service "{id}" (same URL and key); the same URL with different API keys can coexist', { id: pid }))
      }
    }
  }
  let newEndpoints: Partial<Record<import('../config/types.js').Protocol, string>> | undefined
  if (b.endpoints && typeof b.endpoints === 'object' && !Array.isArray(b.endpoints)) {
    const e: Partial<Record<import('../config/types.js').Protocol, string>> = {}
    for (const [k, v] of Object.entries(b.endpoints)) {
      if (!(k === 'anthropic' || k === 'openai' || k === 'responses')) continue
      if (typeof v !== 'string') continue
      const val = v.trim()
      if (!val) { e[k as import('../config/types.js').Protocol] = ''; continue }
      if (!/^https?:\/\//i.test(val)) return sendError(res, 400, t('{proto} 协议地址必须以 http:// 或 https:// 开头', 'The {proto} endpoint URL must start with http:// or https://', { proto: k }))
      e[k as import('../config/types.js').Protocol] = val
    }
    if (Object.keys(e).length) newEndpoints = e
  }
  let newKeyRef: string | undefined
  if (typeof b.key === 'string' && b.key) {
    newKeyRef = await setSecret(id, b.key, rt.config.security?.store ?? (await defaultStore()))
  }
  // 模型目录：完整列表替换语义（UI 传全量）。校验：id 非空去重、ctx/out 为正整数；
  // 显示名随模型提交（编辑浮层在 ID 下以副行回显，仅回显与 ID 不同者）
  let newModels: Record<string, import('../config/types.js').ModelMeta> | undefined
  if (b.models && typeof b.models === 'object' && !Array.isArray(b.models)) {
    newModels = {}
    for (const [rawId, rawMeta] of Object.entries(b.models as Record<string, unknown>)) {
      const mid = rawId.trim()
      if (!mid) continue
      const meta = rawMeta as { display_name?: unknown; context_window?: unknown; max_output?: unknown; capabilities?: unknown }
      const rec: import('../config/types.js').ModelMeta = { source: 'manual' }
      const prev = p.models?.[mid]
      // 显示名：提交非空且 ≠ ID 才采用；留空/同名保留既有（预设/CLI 写入的权威名不丢）
      const dn = typeof meta?.display_name === 'string' ? meta.display_name.trim() : ''
      if (dn && dn.toLowerCase() !== mid.toLowerCase()) rec.display_name = dn
      else if (prev?.display_name) rec.display_name = prev.display_name
      const ctx = Number(meta?.context_window)
      const out = Number(meta?.max_output)
      if (Number.isFinite(ctx) && ctx > 0 && Number.isInteger(ctx)) rec.context_window = ctx
      if (Number.isFinite(out) && out > 0 && Number.isInteger(out)) rec.max_output = out
      // 用户留空时，用填充链补齐（内置表 → models.dev 目录；拉取时已收的上游值不会走到这里）
      const k = resolveModelMeta(mid)
      if (rec.context_window == null && k?.context_window != null) rec.context_window = k.context_window
      if (rec.max_output == null && k?.max_output != null) rec.max_output = k.max_output
      // 能力：显式提交 > 保留既有 > 内置表推断（如 kimi-k3 自动带 vision）；空数组=清空
      const caps = saneCapabilities(meta?.capabilities)
      const nextCaps = caps ?? prev?.capabilities ?? saneCapabilities(k?.capabilities)
      if (nextCaps?.length) rec.capabilities = nextCaps
      newModels[mid] = rec
    }
  }
  // 故障切换候选链：写入引用该 provider 的 profile（与 default_model 同一选择逻辑）。
  // 条目 "<providerId>"（透传原模型）或 "<providerId>:<modelId>"（改写模型）；空数组=清空；缺省=不动
  let newFallback: string[] | undefined
  if (Array.isArray(b.fallback)) {
    newFallback = []
    const seenIds = new Set<string>()
    for (const raw of b.fallback) {
      const parsed = parseFallbackEntry(String(raw ?? ''))
      if (!parsed) {
        return sendError(res, 400, t('备用服务条目「{entry}」无效，应为 服务ID 或 服务ID:模型ID', 'Fallback entry "{entry}" is invalid; expected ServiceID or ServiceID:ModelID', { entry: String(raw ?? '') }))
      }
      if (!rt.config.providers[parsed.providerId]) {
        return sendError(res, 400, t('备用服务「{id}」不存在', 'Fallback service "{id}" not found', { id: parsed.providerId }), t('在「我的服务」查看服务 ID，或刷新页面同步最新列表', 'Check service IDs in "My Services", or refresh the page for the latest list'))
      }
      if (parsed.providerId === id || seenIds.has(parsed.providerId)) continue
      seenIds.add(parsed.providerId)
      newFallback.push(parsed.model ? `${parsed.providerId}:${parsed.model}` : parsed.providerId)
    }
  }
  // 默认模型基线（persist 前取）：persist 后比对，真变了才触发烤模型客户端同步
  const prevProfName = profileRefForProvider(rt.config, id)
  const prevDefaultModel = prevProfName ? rt.config.profiles[prevProfName]?.default_model : undefined
  await persistConfig(rt, (c) => {
    const t = c.providers[id]
    if (!t) return
    if (name) t.name = name
    if (baseUrl) t.base_url = baseUrl
    if (newProtocol) t.protocol = newProtocol
    if (newKeyRef) t.key_ref = newKeyRef
    if (newModels) t.models = newModels
    // 协议端点：替换/清空
    if (newEndpoints) {
      const e = { ...(t.endpoints ?? {}) }
      for (const [k, v] of Object.entries(newEndpoints)) { const kp = k as import('../config/types.js').Protocol; if (v) e[kp] = v; else delete e[kp] }
      t.endpoints = Object.keys(e).length ? e : undefined
    }
    // 设置默认模型：写入引用该 provider 的 profile（优先 active_profile）
    if (typeof b.default_model === 'string') {
      const profName = profileRefForProvider(c, id)
      if (profName) {
        if (b.default_model) c.profiles[profName].default_model = b.default_model
        else delete c.profiles[profName].default_model
      }
    }
    if (Array.isArray(newFallback)) {
      const profName = profileRefForProvider(c, id)
      if (profName) {
        if (newFallback.length) c.profiles[profName].fallback = newFallback
        else delete c.profiles[profName].fallback
      }
    }
  })
  // 默认模型真变了才同步烤模型客户端（dsh/workbuddy/zcode 模型列表烙在客户端文件里，
  // 与全局切换 hSwitch 同口径）；钉定路由的客户端不在其职责内，不受影响
  const bakedParts: Array<Bilingual | ''> = []
  if (typeof b.default_model === 'string' && b.default_model !== (prevDefaultModel ?? '')) {
    const baked = await refreshBakedModelClients({ port: rt.port })
    if (baked.refreshed.length) {
      bakedParts.push(bi('；已同步重写 {list} 的模型列表（重启该客户端生效）', '; rewrote model lists for {list} (restart the clients to apply)', { list: biJoin('、', ', ', baked.refreshed) }))
    }
    if (baked.warnings.length) {
      bakedParts.push(bi('；{list}', '; {list}', { list: biJoin('；', '; ', baked.warnings) }))
    }
  }
  // 审计摘要：列出本次实际变更的字段（不落密钥明文）
  const changes = [
    name ? bi('名称 → {name}', 'Name → {name}', { name }) : '',
    baseUrl ? bi('地址 → {url}', 'URL → {url}', { url: baseUrl }) : '',
    newKeyRef ? bi('Key 已更新', 'Key updated') : '',
    newModels ? bi('模型目录 {n} 个', '{n} models', { n: Object.keys(newModels).length }) : '',
    newEndpoints ? bi('端点 {list} 已更新', 'Endpoints {list} updated', { list: Object.keys(newEndpoints).join('/') }) : '',
    typeof b.default_model === 'string' ? bi('默认模型 → {model}', 'Default model → {model}', { model: b.default_model || bi('(清除)', '(cleared)') }) : '',
    Array.isArray(newFallback) ? bi('备用服务 {n} 个', '{n} fallback services', { n: newFallback.length }) : '',
    ...bakedParts,
  ].filter(Boolean) as Array<Bilingual | ''>
  audit(bi('编辑服务', 'Edit service'), id, changes.length ? biJoin('，', ', ', changes) : bi('无字段变更', 'No fields changed'))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, ...(bakedParts.length ? { resynced: true } : {}) }))
  return
}

async function hRevealKey(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 按需查看单个服务的已保存 Key（编辑弹窗点 👁 时调用）。Key 不随 overview 批量下发，
  // 只有显式动作才取一份明文：列表/截屏/日志场景不泄漏，Host 白名单 + 同源校验在此入口统一生效
  const b = await jsonRequestBody(req)
  const id = typeof b.id === 'string' ? b.id : ''
  const p = rt.config.providers[id]
  if (!p) return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id }))
  const key = await getSecret(p.key_ref)
  audit(bi('查看 Key', 'View key'), id, key ? bi('读取成功', 'Read ok') : bi('Key 不可读（未设置或安全后端拒绝）', 'Key unreadable (not set or the OS keychain refused)'))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, key: key ?? null }))
  return
}

async function hHarnessEnv(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 按需取某客户端经网关接入用的环境变量（generic-env 的「复制环境变量」按钮调用）。
  // token 属敏感值，与 reveal-key 同策略：不随 overview 批量下发，显式动作才返回一份
  const b = await jsonRequestBody(req)
  const hid = String(b.harness ?? '')
  const he = rt.config.harness[hid]
  if (!he) return sendError(res, 400, t('客户端「{id}」尚未接入，先接入再获取环境变量', 'Client "{id}" is not attached yet; attach it first to get env vars', { id: hid }))
  const token = he.token ?? ''
  if (!token) return sendError(res, 400, t('客户端「{id}」没有网关令牌（该客户端不经本网关转发）', 'Client "{id}" has no gateway token (it does not route through this gateway)', { id: hid }))
  const port = rt.port ?? rt.config.gateway?.port ?? DEFAULT_GATEWAY_PORT
  const base = `http://127.0.0.1:${port}`
  audit(bi('查看环境变量', 'View env vars'), hid)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      ok: true,
      harness: hid,
      base_url: base,
      token,
      lines: [
        `export ANTHROPIC_BASE_URL=${base}`,
        `export ANTHROPIC_AUTH_TOKEN=${token}`,
        `export OPENAI_BASE_URL=${base}/v1`,
        `export OPENAI_API_KEY=${token}`,
      ],
    })
  )
  return
}

async function hServiceDelete(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  const id = typeof b.provider === 'string' ? b.provider : ''
  const p = rt.config.providers[id]
  if (!p) return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id }))
  // 与 CLI cmdProviderRm 共用 ops.removeProviderCascade：除路由外还清理 auto_route_provider、
  // 各 profile 的 fallback 候选链与定时切换窗口里的悬空条目
  const usedBy = Object.entries(rt.config.profiles).filter(([, pr]) => pr.provider === id).map(([k]) => k)
  // 有客户端钉定/直连在将被删除的路由上：直接拒绝（网关钉定删了留下悬空 route → 请求 503；
  // 独立直连已把该服务 URL+Key 写进客户端文件，删了直连目标失效）。file 模式客户端自管路由、
  // 不沿网关转发，删除服务不影响它，不拦截（其 route 仅登记痕迹，随删除清掉，见 ops.removeProviderCascade）
  const pinned = Object.entries(rt.config.harness).filter(
    ([, he]) => he.route && he.mode !== 'file' && usedBy.includes(he.route)
  )
  if (pinned.length > 0) {
    const pinnedGateway = pinned.filter(([, he]) => he.mode !== 'direct').map(([h]) => h).join(t('、', ', '))
    const pinnedDirect = pinned.filter(([, he]) => he.mode === 'direct').map(([h]) => h).join(t('、', ', '))
    return sendError(
      res,
      400,
      [
        pinnedGateway
          ? t('有客户端钉定在该服务的路由上（{list}），先在客户端卡片把路由改回「跟随全局」再删除', 'A client is pinned to a route of this service ({list}); switch the route back to "follow global" on the client card before deleting', { list: pinnedGateway })
          : '',
        pinnedDirect
          ? t('有客户端独立直连到该服务（{list}），请先断开该客户端的接入，或把它切回网关模式再删除', 'A client connects directly to this service ({list}); detach it or switch it back to gateway mode before deleting', { list: pinnedDirect })
          : '',
      ]
        .filter(Boolean)
        .join(t('；', '; '))
    )
  }
  // 先落配置再删密钥：persistConfig 失败（写锁超时等）时服务仍在配置里但 key 已不可读，
  // 后续转发 503；先写成功、后删密钥，失败至多留一个无引用的孤儿密钥条目（无副作用）
  let removedProfiles: string[] = []
  await persistConfig(rt, (c) => {
    removedProfiles = removeProviderCascade(c, id)
  })
  try { await deleteSecret(p.key_ref) } catch { /* Key 已不存在则忽略 */ }
  audit(bi('删除服务', 'Delete service'), id, removedProfiles.length ? bi('同时删除路由 {list}', 'Also removed routes {list}', { list: biJoin('、', ', ', removedProfiles) }) : undefined)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, removed: id, profiles: removedProfiles }))
  return
}


async function hAttachPlan(c: AdminCtx): Promise<void> {
  const { rt, req, res } = c
  const b = await jsonRequestBody(req)
  try {
    const plan = await planAttach(String(b.harness ?? ''), {
      profile: typeof b.profile === 'string' && b.profile ? b.profile : undefined,
      clientProfiles: parseClientProfiles(b.client_profiles),
      setDefault: b.setDefault === true,
      takeoverModels: b.takeoverModels === true,
      gatewayPort: rt.port, // 本实例自己的端口；状态文件在多实例下可能记录的是别的实例
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...plan }))
  } catch (e) {
    sendError(res, 400, (e as Error).message)
  }
  return
}

async function hAttachApply(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  try {
    const r = await applyAttach(String(b.harness ?? ''), {
      profile: typeof b.profile === 'string' && b.profile ? b.profile : undefined,
      clientProfiles: parseClientProfiles(b.client_profiles),
      setDefault: b.setDefault === true,
      takeoverModels: b.takeoverModels === true,
      gatewayPort: rt.port, // 本实例自己的端口；状态文件在多实例下可能记录的是别的实例
    })
    await reloadRuntime(rt) // 立即刷新内存态，overview 才能即时反映接入结果
    // attach 写入的 picker 目录取自 active_profile；若此刻正处于 prefer 窗口接管（展示路由 ≠
    // active_profile），基线置失效让周期检测在 5s 内按窗口目标校准一次
    pickerSyncStates.get(rt)!.route = undefined
    audit(bi('接入客户端', 'Attach client'), r.harness, bi('端口 {port}，写入 {n} 个文件', 'Port {port}, wrote {n} files', { port: r.port, n: r.files.length }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...r, hint: t('重启 {id} 后生效；原文件已自动快照，可随时断开还原', 'Takes effect after restarting {id}; the original files were auto-snapshotted and can be restored anytime by detaching', { id: r.harness }) }))
  } catch (e) {
    audit(bi('接入客户端', 'Attach client'), String(b.harness ?? '-'), undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

async function hDetach(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  try {
    const r = await detachHarness(String(b.harness ?? ''))
    await reloadRuntime(rt)
    audit(bi('断开客户端', 'Detach client'), String(b.harness ?? '-'), r.restored ? bi('已还原到本次接入前（快照 {id}）', 'Restored to the state before this attach (snapshot {id})', { id: r.snapshotId ?? '-' }) : bi('已反向清理网关配置', 'Gateway-side config cleaned up in reverse'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...r }))
  } catch (e) {
    audit(bi('断开客户端', 'Detach client'), String(b.harness ?? '-'), undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

async function hHarnessRoute(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 客户端钉路由：UI 按「服务」（provider）操作，API 也可直接指定 profile 名；default = 恢复跟随全局。
  // 路由本身只改 config 的 harness.route（服务端内存，热加载后下一请求生效）；烤模型客户端
  // （dsh/workbuddy/zcode，adapter.bakesModels）的模型列表烙在客户端文件里，钉定后需按新 profile 重写
  const b = await jsonRequestBody(req)
  const hid = String(b.harness ?? '')
  try {
    if (!rt.config.harness[hid]) return sendError(res, 400, t('客户端「{id}」未接入，先接入再设置路由', 'Client "{id}" is not attached; attach it first to set a route', { id: hid }))
    if (rt.config.harness[hid].mode === 'direct') {
      return sendError(res, 400, t('客户端「{id}」是独立直连模式：更换直连目标请用 /harness/mode（需要重写客户端配置文件）', 'Client "{id}" is in standalone direct mode: use /harness/mode to change the direct target (client config files get rewritten)', { id: hid }))
    }
    if (rt.config.harness[hid].mode === 'file') {
      return sendError(res, 400, t('客户端「{id}」是 file 模式（客户端自管路由），不支持钉定', 'Client "{id}" is in file mode (it manages its own routing) and cannot be pinned', { id: hid }))
    }
    const toDefault = b.default === true
    const profileName = typeof b.profile === 'string' && b.profile ? b.profile : ''
    const providerId = typeof b.provider === 'string' && b.provider ? b.provider : ''
    if (!toDefault && !profileName && !providerId) {
      return sendError(res, 400, t('缺少路由目标：provider / profile / default 三选一', 'Missing route target: provide one of provider / profile / default'))
    }
    if (profileName && !rt.config.profiles[profileName]) {
      return sendError(res, 400, t('profile「{name}」不存在', 'Profile "{name}" not found', { name: profileName }))
    }
    if (providerId && !rt.config.providers[providerId]) {
      return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id: providerId }))
    }
    let finalRoute = toDefault ? 'default' : profileName
    await persistConfig(rt, (c) => {
      // 只以写锁内的最新配置为源：并发 detach（CLI/Web 同时操作）时 rt.config 还是进 handler
      // 前的旧引用，拿它兜底会把 {route} 幽灵条目写回已断开的客户端（指向无 token 的死路由）
      const he = c.harness[hid]
      if (!he) {
        throw new UpstreamError(400, t('客户端「{id}」刚刚断开，路由未设置；请刷新后重试', 'Client "{id}" was just detached; route not set — refresh and retry', { id: hid }))
      }
      if (!toDefault && !profileName && providerId) {
        finalRoute = profileForProvider(c, providerId)
      }
      c.harness[hid] = { ...he, route: finalRoute }
    })
    // 烤模型客户端按目标 profile 重写模型列表（恢复跟随 = 按 active_profile 重写；透明客户端为空操作）
    const syncProfile = toDefault ? rt.config.active_profile ?? undefined : finalRoute
    const synced = syncProfile
      ? await resyncHarnessToRoute(hid, syncProfile, { port: rt.port })
      : { refreshed: [], warnings: [] }
    const detail = biCat(
      finalRoute === 'default' ? bi('恢复跟随全局', 'Back to follow global') : bi('钉到 {route}', 'Pinned to {route}', { route: finalRoute }),
      synced.refreshed.length ? bi('；已同步重写 {id} 的模型列表（重启该客户端生效）', '; rewrote the model list of {id} (restart the client to apply)', { id: hid }) : '',
      synced.warnings.length ? bi('；{list}', '; {list}', { list: biJoin('；', '; ', synced.warnings) }) : ''
    )
    audit(bi('客户端钉路由', 'Pin client route'), hid, detail)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, route: finalRoute, ...synced, hint: synced.refreshed.length ? t('已同步重写该客户端的模型列表，重启该客户端后生效', 'Rewrote the model list of this client; restart the client to apply') : undefined }))
  } catch (e) {
    audit(bi('客户端钉路由', 'Pin client route'), hid, undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

async function hHarnessMode(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 接入模式切换：direct（独立直连，写上游 url+真实 Key，重写客户端文件）⇄ gateway（切回网关）。
  // 复用 ops.switchHarnessMode（快照/原子写/登记），直连后客户端不经过网关，网关挂掉仍可用作救援通道
  const b = await jsonRequestBody(req)
  const hid = String(b.harness ?? '')
  const mode = b.mode === 'direct' ? 'direct' : b.mode === 'gateway' ? 'gateway' : ''
  if (!mode) return sendError(res, 400, t('mode 必须是 gateway 或 direct', 'mode must be gateway or direct'))
  const he = rt.config.harness[hid]
  if (!he) return sendError(res, 400, t('客户端「{id}」未接入，先接入再切换模式', 'Client "{id}" is not attached; attach it first to switch modes', { id: hid }))
  if (he.mode === 'file') return sendError(res, 400, t('file 模式的客户端暂不支持切换直连', 'Clients in file mode do not support switching to direct yet'))
  if (mode === 'gateway' && he.mode !== 'direct') {
    return sendError(res, 400, t('客户端「{id}」已是网关接入模式', 'Client "{id}" is already in gateway mode', { id: hid }))
  }
  if (mode === 'direct' && he.mode === 'direct' && !b.profile && !b.provider) {
    return sendError(res, 400, t('客户端「{id}」已是独立直连模式；更换直连目标请带 profile 或 provider', 'Client "{id}" is already in standalone direct mode; pass profile or provider to change the direct target', { id: hid }))
  }
  const profileOverride = typeof b.profile === 'string' && b.profile ? b.profile : ''
  const providerOverride = typeof b.provider === 'string' && b.provider ? b.provider : ''
  if (profileOverride && !rt.config.profiles[profileOverride]) {
    return sendError(res, 400, t('profile「{name}」不存在', 'Profile "{name}" not found', { name: profileOverride }))
  }
  if (providerOverride && !rt.config.providers[providerOverride]) {
    return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id: providerOverride }))
  }
  try {
    let profile = profileOverride || undefined
    if (mode === 'direct' && !profile && providerOverride) {
      await persistConfig(rt, (c) => {
        profile = profileForProvider(c, providerOverride)
      })
    }
    const r = await switchHarnessMode(hid, mode, { profile, yes: true, port: rt.port })
    await reloadRuntime(rt)
    audit(mode === 'direct' ? bi('客户端切直连', 'Client switched to direct') : bi('客户端切回网关', 'Client switched back to gateway'), hid, bi('目标 {target}，写入 {n} 个文件', 'Target {target}, wrote {n} files', { target: r.profile, n: r.files.length }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...r, hint: t('重启 {id} 后生效', 'Takes effect after restarting {id}', { id: hid }) }))
  } catch (e) {
    audit(mode === 'direct' ? bi('客户端切直连', 'Client switched to direct') : bi('客户端切回网关', 'Client switched back to gateway'), hid, undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

async function hUse(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  const name = typeof b.profile === 'string' ? b.profile : ''
  if (!name || !rt.config.profiles[name]) {
    return sendError(res, 400, t('profile「{name}」不存在', 'Profile "{name}" not found', { name }), t('modeldock profile list 查看', 'Run modeldock profile list to view profiles'))
  }
  await persistConfig(rt, (c) => {
    c.active_profile = name
  })
  audit(bi('切换路由', 'Switch route'), name)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, active_profile: name }))
  return
}

async function hProfile(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  const name = typeof b.name === 'string' ? b.name : ''
  const provider = typeof b.provider === 'string' ? b.provider : ''
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) {
    return sendError(res, 400, t('profile 名称只能是字母/数字/-/_，长度 ≤40', 'Profile name allows only letters/digits/-/_ and must be ≤40 chars'))
  }
  if (!provider || !rt.config.providers[provider]) {
    return sendError(res, 400, t('provider「{id}」不存在', 'Provider "{id}" not found', { id: provider }))
  }
  if (rt.config.profiles[name]) {
    return sendError(res, 400, t('profile「{name}」已存在', 'Profile "{name}" already exists', { name }))
  }
  const models = rt.config.providers[provider].models ?? {}
  const defaultModel = typeof b.default_model === 'string' && b.default_model ? b.default_model : undefined
  if (defaultModel && Object.keys(models).length > 0 && !models[defaultModel]) {
    return sendError(res, 400, t('模型「{model}」不在 {id} 的目录里', 'Model "{model}" is not in the catalog of {id}', { model: defaultModel, id: provider }), 'modeldock model list ' + provider)
  }
  const aliases =
    b.aliases && typeof b.aliases === 'object' && !Array.isArray(b.aliases)
      ? Object.fromEntries(
          Object.entries(b.aliases as Record<string, unknown>)
            .filter(([k, v]) => typeof k === 'string' && k && typeof v === 'string')
            .map(([k, v]) => [k, String(v)])
        )
      : undefined
  await persistConfig(rt, (c) => {
    c.profiles[name] = { name, provider, default_model: defaultModel, aliases }
    if (!c.active_profile) c.active_profile = name
  })
  audit(bi('新建路由', 'Create route'), name, biCat(`provider=${provider}`, defaultModel ? bi('，默认模型 {model}', ', default model {model}', { model: defaultModel }) : ''))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, profile: name }))
  return
}

async function hKey(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  const provider = typeof b.provider === 'string' ? b.provider : ''
  const key = typeof b.key === 'string' ? b.key : ''
  if (!provider || !rt.config.providers[provider]) {
    return sendError(res, 400, t('provider「{id}」不存在', 'Provider "{id}" not found', { id: provider }))
  }
  if (!key) {
    return sendError(res, 400, t('key 不能为空', 'Key must not be empty'))
  }
  const backend = rt.config.security?.store ?? (await defaultStore())
  const keyRef = await setSecret(provider, key, backend)
  await persistConfig(rt, (c) => {
    if (c.providers[provider]) c.providers[provider].key_ref = keyRef
  })
  audit(bi('更新密钥', 'Update key'), provider, bi('存入 {backend}', 'Stored in {backend}', { backend }))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  return
}

async function hReload(c: AdminCtx): Promise<void> {
  const { rt, res, audit } = c
  try {
    await reloadRuntime(rt)
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
  // 先清 OS 钥匙环里的 Key（keychain/secret-service 条目不在 secrets.json 里，删文件清不掉）
  let secretsCleared = 0
  for (const [id, p] of Object.entries(rt.config.providers)) {
    try {
      await deleteSecret(p.key_ref)
      secretsCleared++
    } catch { /* 单项失败不影响其余 */ }
  }
  const files = [configPath(), secretsPath()]
  const deleted: string[] = []
  for (const f of files) {
    try {
      if (fs.existsSync(f)) { fs.unlinkSync(f); deleted.push(f) }
    } catch { /* 忽略 */ }
  }
  // 重载为空配置
  await reloadRuntime(rt)
  audit(bi('重置配置', 'Reset config'), '-', bi('删除 {files}，清除 {n} 个密钥', 'Deleted {files}; cleared {n} keys', { files: deleted.length ? biJoin('、', ', ', deleted) : bi('无文件', 'no files'), n: secretsCleared }))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, deleted, hint: t('配置已清空（含钥匙环密钥）；快照和日志保留。运行 modeldock init 重新配置', 'Config cleared (including keychain keys); snapshots and logs are kept. Run modeldock init to set up again') }))
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
 *  （Dockmaster 风暴闸）与排查的外部海况数据源：class = 触发熔断的错误类。 */
async function hMetrics(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  const providers: Record<string, unknown> = {}
  for (const [id, m] of rt.metricsLatency) {
    providers[id] = { count: m.count, last_ms: m.lastMs ?? null, ...latencyQuantiles(m.samples) }
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
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ event_loop_lag_ms: eventLoopLagMs(), providers, meltdown }))
}

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
 *  聚合口径见 summarizeUsage。 */
async function hUsage(c: AdminCtx): Promise<void> {
  const { req, res } = c
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const parsed = usageQuery(q)
  if (parsed.err) {
    sendError(res, 400, parsed.err, t('示例：/_modeldock/usage?date=2026-11-01&harness=zcode', 'Example: /_modeldock/usage?date=2026-11-01&harness=zcode'))
    return
  }
  // 流式聚合：逐行读、边过滤边累加，不落全量数组——31 天查询曾把事件循环卡数秒、
  // 在途 SSE 全冻结（本端点是编排侧的轮询数据源，见 summarizeUsageDays 注释）
  const harness = q.get('harness') ?? undefined
  const profile = q.get('profile') ?? undefined
  const provider = q.get('provider') ?? undefined
  const usage = await summarizeUsageDays(parsed.days, { harness, profile, provider, fromMs: parsed.fromMs, toMs: parsed.toMs })
  const filter: Record<string, string> = {}
  if (harness) filter.harness = harness
  if (profile) filter.profile = profile
  if (provider) filter.provider = provider
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, days: parsed.days, filter: Object.keys(filter).length ? filter : null, usage }))
  return
}

/** admin 门之后的端点路由表：键 = "METHOD /path"（url 已在 handleAdmin 顶部剥过查询串） */
const ADMIN_ROUTES: Record<string, AdminHandler> = {
  'POST /_modeldock/admin/rotate': hRotate,
  'GET /_modeldock/metrics': hMetrics,
  'GET /_modeldock/usage': hUsage,
  'GET /_modeldock/status': hStatus,
  'GET /_modeldock/admin/update/status': hUpdateStatus,
  'POST /_modeldock/admin/update/check': hUpdateCheck,
  'POST /_modeldock/admin/update/apply': hUpdateApply,
  'GET /_modeldock/logs': hLogs,
  'GET /_modeldock/config': hConfig,
  'GET /_modeldock/model-catalog': hModelCatalog,
  'GET /_modeldock/overview': hOverview,
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
  'POST /_modeldock/sync/discover': hSyncDiscover,
  'POST /_modeldock/sync/request-remote': hSyncRequestRemote,
  'GET /_modeldock/sync/remote-status': hSyncRemoteStatus,
  'POST /_modeldock/sync/offer-approve': hSyncOfferApprove,
  'POST /_modeldock/autostart': hAutostart,
  'GET /_modeldock/import/detect': hImportDetect,
  'POST /_modeldock/import/apply': hImportApply,
  'POST /_modeldock/import/dismiss': hImportDismiss,
  'POST /_modeldock/service/update': hServiceUpdate,
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
  'POST /_modeldock/use': hUse,
  'POST /_modeldock/profile': hProfile,
  'POST /_modeldock/key': hKey,
  'POST /_modeldock/reload': hReload,
  'POST /_modeldock/test': hTest,
  'POST /_modeldock/reset': hReset,
}

/** 管理面入口：Host 白名单 → tier-1 豁免端点（health/ui/relogin）→ admin 鉴权 → 路由表分发。 */
async function handleAdmin(
  rt: GatewayRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  o: { idle: number; retries: number },
  started: number
): Promise<void> {
  const url = (req.url ?? '').split('?')[0]

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
  // cookie 名内嵌端口：RFC 6265 cookie 不按端口隔离，同机双实例（生产+dev）固定名会互顶登录态
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

  const handler = ADMIN_ROUTES[`${req.method ?? 'GET'} ${url}`]
  if (handler) return handler({ rt, req, res, audit, o })
  sendError(res, 404, t('未知管理端点 {url}', 'Unknown admin endpoint {url}', { url }))
}

export interface ProbeResult {
  ok: boolean
  status: number
  ms: number
  ttfb_ms?: number
  model?: string
  usage?: Record<string, number>
  err?: string
  hint?: string
}

/** 端到端探测：按 profile 发一次最小请求（modeldock test 的后端） */
export async function probe(
  rt: GatewayRuntime,
  target: import('./state.js').ResolvedTarget,
  modelOverride: string | undefined,
  stream: boolean,
  o: { idle: number; retries: number }
): Promise<ProbeResult> {
  const t0 = Date.now()
  const model = modelOverride ?? target.profile.default_model
  if (!model) {
    return { ok: false, status: 0, ms: 0, err: t('该 profile 未设置 default_model，请用 -m 指定或 modeldock profile 修改', 'This profile has no default_model; pass -m or change it with modeldock profile') }
  }
  // 按服务协议拼探针路径与 body：responses 是一等协议（hServiceAdd/hFetchModels 均接受），
  // 此前二分法只认 anthropic/其他——responses 服务被拼成 /v1/chat/completions，经
  // clientProtocolFromPath 判成 openai，upstreamEndpoint 对未配 openai 端点的服务抛 400，
  // 报错还把责任推给「客户端走 openai 协议」（实际探针拼错了协议）
  const proto = target.provider.protocol
  const isAnthropic = proto === 'anthropic'
  const isResponses = proto === 'responses'
  const path = isAnthropic ? '/v1/messages' : isResponses ? '/v1/responses' : '/v1/chat/completions'
  const body = Buffer.from(
    JSON.stringify(
      isResponses
        ? { model, max_output_tokens: 16, stream, input: 'ping' }
        : { model, max_tokens: 16, stream, messages: [{ role: 'user', content: 'ping' }] }
    )
  )
  try {
    const up = await forwardToUpstream(rt, target, {
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
      body,
      idleTimeoutMs: o.idle,
      retries: o.retries,
    })
    if (up.status >= 400) {
      const text = await up.body.text()
      // 转成可读的一行：上游 message + 修复提示，而非整段 JSON
      let msg = text.slice(0, 400)
      try {
        const j = JSON.parse(text)
        msg = [j?.error?.message, j?.modeldock?.hint].filter(Boolean).join(' → ')
      } catch {
        /* 非 JSON 保持原文 */
      }
      return {
        ok: false,
        status: up.status,
        ms: Date.now() - t0,
        model,
        err: msg,
      }
    }
    const text = await up.body.text()
    let usage: Record<string, number> | undefined
    if (!stream) {
      try {
        const j = JSON.parse(text)
        const u = j?.usage
        if (u && typeof u === 'object') {
          usage = {}
          for (const [k, v] of Object.entries(u)) {
            if (typeof v === 'number') usage[k] = v
          }
        }
      } catch {
        /* SSE 或非 JSON */
      }
    }
    return { ok: true, status: up.status, ms: Date.now() - t0, model: up.modelAfter ?? model, usage }
  } catch (e) {
    const ue = e as UpstreamError
    return { ok: false, status: ue.status ?? 502, ms: Date.now() - t0, model, err: ue.message, hint: ue.hint }
  }
}

export interface PingResult {
  ok: boolean
  ms: number
  err?: string
  hint?: string
}

/** 纯网络延迟探测：向 provider 的 origin 发一次最小请求，测「首字节到达」耗时（不做模型推理） */
export async function probePing(
  rt: GatewayRuntime,
  provider: ProviderConfig
): Promise<PingResult> {
  const base = (provider.base_url ?? '').trim()
  if (!base) {
    return { ok: false, ms: 0, err: t('provider 未配置 base_url', 'Provider has no base_url configured') }
  }
  let origin: string
  try {
    origin = new URL(base).origin
  } catch {
    return { ok: false, ms: 0, err: t('base_url 无效：{url}', 'Invalid base_url: {url}', { url: base }) }
  }
  const t0 = Date.now()
  try {
    // 请求到 origin 根路径即可；不鉴权、不推理，只测网络往返
    const res = await undiciRequest(origin + '/', {
      method: 'GET',
      dispatcher: dispatcherFor(rt, provider),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    })
    const ms = Date.now() - t0
    // 释放连接（抑制 aborted 错误事件）
    if (typeof (res.body as unknown as { on?: Function }).on === 'function') {
      ;(res.body as unknown as NodeJS.EventEmitter).on('error', () => {})
    }
    ;(res.body as unknown as { destroy?: () => void })?.destroy?.()
    return { ok: true, ms }
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      err: t('网络不可达：{msg}', 'Network unreachable: {msg}', { msg: (e as Error).message }),
      hint: t('检查网络/代理（provider.proxy），或本地是否放行了该域名', 'Check network/proxy (provider.proxy), or whether this domain is blocked locally'),
    }
  }
}

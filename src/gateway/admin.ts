import type http from 'node:http'
import { DEFAULT_GATEWAY_PORT } from '../config/types.js'
import { safeEqual } from '../util/safe-equal.js'
import { randomToken } from '../util/fsx.js'
import { localIsoTs } from '../util/time.js'
import { VERSION } from '../version.js'
import { AdminCtx, sendError } from './admin-shared.js'
import { adminCookieName, deviceCookieName } from './cookies.js'
import { CONSOLE_CSP } from './console-shared.js'
import { logAudit, logEvent, readGatewayState } from './state.js'
import { debugLog, debugOn } from './state/debuglog.js'
import { hInstall, hUninstall } from './install.js'
import { hConfigExport, hSyncDiscover, hSyncImport, hSyncOffer, hSyncOfferApprove } from './configpack.js'
import { hMergeApply, hMergePreview } from './mergepack.js'
import { hOverview, hPresetsCatalog, hTrayLite, hTrayState, hUiPresence, hUsageLive, invalidateOverviewCache } from './overview-view.js'
import { markUiSeen } from './presence.js'
import { hSyncRemoteStatus, hSyncRequestRemote, registerWebDevice } from './remote-device.js'
import { hUpdateApply, hUpdateCheck, hUpdateStatus } from './update-panel.js'
import { adminAuthorized, cookieValueRe, hostAllowed, safeCookieDecode } from './routes/admin-auth.js'
import { hAttachApply, hAttachPlan, hDetach, hHarnessEnv, hHarnessMode, hHarnessRoute, hHarnessUsage, hProvisionHarness, hRenewHarness, hRevokeHarness } from './routes/harness.js'
import { hModelAvailability, hProbeLedger, hProbeRun, hProbeTimeline, hProbeTrend, hProbeVerdicts } from './routes/probe.js'
import { hAutoRoute, hFetchModels, hHolidaysCn, hImportApply, hImportDetect, hImportDismiss, hKey, hProfile, hRevealKey, hSchedule, hServiceAdd, hServiceDelete, hServiceModelFallback, hServiceUpdate, hSwitch, hUse } from './routes/services.js'
import { hAutostart, hConfig, hLanGet, hLanPost, hModelCatalog, hMetrics, hReload, hReset, hRotate, hStatus, hTest, hTierValidate } from './routes/system.js'
import { hLogs, hLogsQuery, hPricingLookup, hUsage } from './routes/usage.js'
import { getRenderedUI } from './ui-cache.js'
import { t, type Bilingual } from '../util/i18n.js'
import type { GatewayRuntime } from './state.js'

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
  'GET /_modeldock/probe/timeline': hProbeTimeline,
  'POST /_modeldock/tier-validate': hTierValidate,
  'POST /_modeldock/pricing-lookup': hPricingLookup,
  'POST /_modeldock/reset': hReset,
}))

/** 管理面入口：Host 白名单 → tier-1 豁免端点（health/ui/relogin）→ admin 鉴权 → 路由表分发。 */
export async function handleAdmin(
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

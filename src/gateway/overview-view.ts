/** 总览/视图域：buildConfigView、overview 缓存簇（TTL/单飞/SWR 决策）与 buildOverview、overview/tray/presence 端点（由 server.ts 拆出，T05，纯搬移零改写）。块序 = 原文件相对次序，未重排未删改。 */
import { AdminCtx, persistConfig, jsonRequestBody, profileRefForProvider, sendError } from './admin-shared.js'
import { allAdapters } from '../adapters/registry.js'
import { getSecret } from '../config/secrets.js'
import { DEFAULT_GATEWAY_PORT, type Config } from '../config/types.js'
import { knownMetaTable } from '../providers/known.js'
import { fetchEnvelopeFromUrl, projectModel } from './shared.js'
import { resolveInstallCommand } from '../adapters/types.js'
import { sandboxNpmPrefix } from '../util/paths.js'
import { autostartOverview } from '../autostart.js'
import { sandboxInstallCapability } from './install.js'
import { PRESETS } from '../presets/data.js'
import { autoRouteInfo, isMeltdown, parseFallbackEntry, type GatewayRuntime } from './state.js'
import { ensurePresetsLoaded, knownModelsForBaseUrl, presetModels } from '../presets/data.js'
import { markUiLeaving, markUiPing, pendingTrayLiteRequest, requestTrayLite, trayLiteActive } from './presence.js'
import { peekSyncRequest } from './lan.js'
import { syncStatus } from '../sync/engine.js'
import { bi, getLang, t } from '../util/i18n.js'
import { localIsoTs } from '../util/time.js'
export async function buildConfigView(rt: GatewayRuntime): Promise<Record<string, unknown>> {
  const cfg = rt.config
  const port = rt.port ?? cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT
  // 各适配器 status 相互独立、只读，并发执行；Promise.all 保序，row 顺序与 allAdapters 一致
  const adapters = allAdapters(cfg)
  const statuses = await Promise.all(adapters.map((a) => a.status(cfg, port)))
  const harnessRows = adapters.map((a, i) => {
    const st = statuses[i]
    return {
      id: a.id,
      label: a.label,
      attached: !!cfg.harness[a.id],
      mode: cfg.harness[a.id]?.mode ?? null,
      route: cfg.harness[a.id]?.route ?? null,
      pointing: st.pointing ?? 'unknown',
      detail: st.detail ?? '',
    }
  })
  return {
    active_profile: cfg.active_profile ?? null,
    gateway: { port },
    providers: Object.entries(cfg.providers).map(([id, p]) => ({
      id,
      name: p.name ?? id,
      base_url: p.base_url,
      protocol: p.protocol,
      auth_style: p.auth_style,
      key_ref: p.key_ref,
      proxy: p.proxy ?? 'direct',
      models: Object.entries(p.models ?? {}).map(([mid, meta]) => projectModel(mid, meta, { includeCapabilities: true, includeSource: true })),
    })),
    profiles: Object.entries(cfg.profiles).map(([name, p]) => ({
      name,
      provider: p.provider,
      default_model: p.default_model ?? null,
      aliases: p.aliases ?? {},
    })),
    harness: harnessRows,
    uptime_ms: Date.now() - rt.startedAt,
    reloads: rt.reloads,
  }
}

/** overview 短 TTL 缓存（UI 每 5s 轮询，避免每次全量 adapter IO；绑定 runtime 实例 + 配置重载代数，任一变化即失效）。
 *  data 存序列化后的字符串：TTL 内命中直接 end 缓存串，不再对几十-几百 KB 的 view 逐次重复 stringify。
 *  TTL 必须**大于** UI 轮询间隔（5000ms）才会在两次轮询之间有命中——曾为 2000ms，下次 5s 轮询前必过期，
 *  稳态每次轮询全量重跑 buildOverview（每 provider 一次 keychain getSecret + 适配器 status 探测），缓存形同虚设。 */
export const OVERVIEW_TTL_MS = 6_000
export let overviewCache: { at: number; rt: GatewayRuntime; reloads: number; lang: string; data: string } | null = null

/** 立即失效 overview 缓存（轻量模式广播 / 页面加载用）：与 reloads++ 同效，但不虚增「重载次数」展示口径 */
export function invalidateOverviewCache(): void {
  overviewCache = null
}

/** overview 缓存命中判定（`now` 可注入便于单测给定 TTL 窗口）：
 *  命中须同 runtime 实例 + 同配置重载代数 + 同语言（overview 文案随请求语言生成，语言不同不能互借）+ 未过 TTL。 */
export function overviewCacheHit(
  cached: NonNullable<typeof overviewCache>,
  rt: GatewayRuntime,
  reloads: number,
  lang: string,
  now: number
): boolean {
  return overviewServeDecision(cached, rt, reloads, lang, now) === 'hit'
}

/** overview 响应决策（`now` 可注入便于单测）：
 *  - hit：键匹配且 TTL 内——直发缓存串；
 *  - stale：键匹配但过 TTL——先回旧快照（零等待），后台单飞重建，UI 下一轮轮询（≤5s）拿到新数据。
 *    Windows 冷探测（桌面客户端 reg query 全树、DPAPI 解密 spawn PowerShell、PATH 同步全扫）只发生在
 *    后台，不再挡在用户打开页面的关键路径上；
 *  - miss：键不匹配（配置写经 reloads 递增、语言切换、冷启动）——同步重建，保证写后立即可见新配置。 */
export function overviewServeDecision(
  cached: NonNullable<typeof overviewCache>,
  rt: GatewayRuntime,
  reloads: number,
  lang: string,
  now: number
): 'hit' | 'stale' | 'miss' {
  if (cached.rt !== rt || cached.reloads !== reloads || cached.lang !== lang) return 'miss'
  return now - cached.at < OVERVIEW_TTL_MS ? 'hit' : 'stale'
}

export let overviewRebuilding: Promise<unknown> | null = null

export async function rebuildOverview(rt: GatewayRuntime): Promise<string> {
  const view = await buildOverview(rt)
  const data = JSON.stringify(view)
  overviewCache = { at: Date.now(), rt, reloads: rt.reloads, lang: getLang(), data }
  return data
}

/** overview 视图串（hOverview 与 hTrayState 共用）：TTL 内命中缓存串；键匹配但过期走 SWR
 * （旧串先行 + 后台单飞重建）；键不匹配同步重建。缓存键含请求语言：view 里的客户端卡片描述等
 * 文案随请求语言生成，语言不同不能互借缓存。 */
export async function overviewViewData(rt: GatewayRuntime): Promise<string> {
  const cached = overviewCache
  if (!cached) return rebuildOverview(rt)
  const decision = overviewServeDecision(cached, rt, rt.reloads, getLang(), Date.now())
  if (decision === 'hit') return cached.data
  if (decision === 'stale') {
    if (!overviewRebuilding) {
      overviewRebuilding = rebuildOverview(rt).catch(() => {}).finally(() => { overviewRebuilding = null })
    }
    return cached.data
  }
  return rebuildOverview(rt)
}

/** 启动预热：后台构建一次 overview（顺带焐热适配器探测 memo、secrets 解密缓存与缓存串本身）。
 *  daemon 起来 2s 后用户大概率还没打开控制台——把 Windows 冷探测的数秒成本在无人等待时提前付掉，
 *  用户随后打开页面首屏直接命中或走 SWR 秒回。失败静默（下次请求/轮询照常重建）。 */
export function warmupOverview(rt: GatewayRuntime, delayMs = 2_000): void {
  const timer = setTimeout(() => {
    overviewViewData(rt).catch(() => {})
  }, delayMs)
  timer.unref?.()
}

/** 控制台 v2 总览：全部用用户语言（服务/客户端），不含 provider/profile 等内部概念 */
export async function buildOverview(rt: GatewayRuntime): Promise<Record<string, unknown>> {
  const cfg = rt.config
  // 唯一「正在使用」口径：钉定 > 可用窗口 > 默认（含 enabled/熔断过滤，与转发同源）。
  // 服务卡、客户端行、手机页、/v1/models 全部消费它，不再各自用 active_profile 推算。
  const route = autoRouteInfo(rt)
  // harness → 当前路由到的 provider（钉死的 route 优先，否则跟随全局生效路由）
  const hidSvc: Record<string, string> = {}
  const hidFollows: Record<string, boolean> = {}
  for (const [hid, he] of Object.entries(cfg.harness ?? {})) {
    const pinned = !!(he.route && he.route !== 'default')
    const routeName = pinned ? he.route : cfg.active_profile
    const prof = routeName ? cfg.profiles[routeName] : undefined
    if (prof) hidSvc[hid] = prof.provider
    hidFollows[hid] = !pinned
  }
  const services = []
  // key 是否已配置并行预取：串行 await 在 keychain 后端下是逐 provider spawn 外部进程（overview
  // 稳态约每几秒重建一次，串行 N 次造成周期性延迟尖峰），结果与逐个 await 完全一致
  const providerEntries = Object.entries(cfg.providers)
  const keyPresence = new Map(await Promise.all(providerEntries.map(async ([id, p]) => [id, !!(await getSecret(p.key_ref))] as const)))
  for (const [id, p] of providerEntries) {
    // 引用该 provider 的 profile：active_profile 优先（与 /service/update 写 default_model/候选链的选择逻辑一致）
    const profileRef = profileRefForProvider(cfg, id)
    const profileEntry = profileRef ? cfg.profiles[profileRef] : undefined
    const models = Object.keys(p.models ?? {})
    const hasKey = keyPresence.get(id) ?? false
    const h = rt.health.get(id)
    const melted = isMeltdown(rt, id)
    services.push({
      id,
      label: p.name ?? id,
      base_url: p.base_url,
      protocol: p.protocol,
      endpoints: p.endpoints ?? undefined,
      hasKey,
      modelsCount: models.length,
      defaultModel: profileEntry?.default_model ?? models[0] ?? null,
      fallback: (profileEntry?.fallback ?? [])
        .map((e) => parseFallbackEntry(e))
        .filter((x): x is { providerId: string; model?: string } => x !== null)
        .map((x) => ({ provider: x.providerId, model: x.model ?? null })),
      // 「正在使用」= 全局生效主服务（钉定/定时窗口/默认，含可用性过滤），不是 active_profile
      inUse: id === route.provider,
      enabled: p.enabled !== false,
      priority: p.priority ?? 0,
      down: melted,
      meltdown_until: melted ? (h?.meltdown_until ?? null) : null,
      lastMs: h?.lastMs ?? null,
      models: Object.entries(p.models ?? {}).map(([mid, meta]) => projectModel(mid, meta, { includeCapabilities: true })),
    })
  }
  // 兼容旧字段名：isCurrent 与 inUse 同值（移动端/PWA 旧页面可能仍读它）
  services.forEach((s: { isCurrent?: boolean; inUse: boolean }) => { s.isCurrent = s.inUse })
  const current = route.provider
    ? { id: route.provider, label: route.providerLabel ?? route.provider, model: route.model }
    : null
  // 默认路由（active_profile）：配置态语义（接入跟随/直连目标），与「正在使用」分开
  const defaultRoute = route.defaultProvider
    ? { id: route.defaultProvider, label: route.defaultProviderLabel ?? route.defaultProvider, model: route.defaultModel }
    : null
  const port = rt.port ?? cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT
  const usedByMap: Record<string, string[]> = {}
  // 各适配器 status 相互独立、只读，并发执行；Promise.all 保序，按 adapter 取回，顺序不受并发影响。
  // clientProfileOptions 与 status 一并并发：曾放在下方 clients 组装循环里逐个 await（当前仅 dsh
  // 实现，读 YAML 目录），是 overview 重建路径上唯一的串行点，并行后与 status 同窗口完成
  const adapters = allAdapters(cfg)
  const [statuses, profileOptsList] = await Promise.all([
    Promise.all(adapters.map(async (a) => [a, await a.status(cfg, port)] as const)),
    Promise.all(adapters.map((a) => (a.clientProfileOptions ? a.clientProfileOptions() : Promise.resolve(null)))),
  ])
  const statusByAdapter = new Map(statuses)
  const clients = []
  for (const [i, a] of adapters.entries()) {
    const st = statusByAdapter.get(a)!
    const he = cfg.harness[a.id]
    const baseProviderId = he && hidSvc[a.id] ? hidSvc[a.id] : undefined
    // 跟随全局的客户端：服务随「正在使用」走（含定时窗口）；钉定路由的仍写自己的服务
    const providerId = he && hidFollows[a.id] ? (route.provider ?? baseProviderId) : baseProviderId
    // 钉定信息：route 存钉住的 profile 名（null = 跟随全局），pinnedProvider 是该 profile 指向的服务 id（UI 下拉回显用）
    const pinnedRoute = he?.route && he.route !== 'default' ? he.route : null
    clients.push({
      id: a.id,
      label: a.label,
      installed: st.installed,
      attached: st.attached,
      pointing: st.pointing ?? 'unknown',
      detail: st.detail ?? '',
      service: providerId ? (cfg.providers[providerId]?.name ?? providerId) : null,
      followsActive: !!(he && hidFollows[a.id]),
      mode: he?.mode ?? null,
      directSupported: a.directMode === true,
      route: pinnedRoute,
      pinnedProvider: pinnedRoute ? (cfg.profiles[pinnedRoute]?.provider ?? null) : null,
      // 客户端自身 profile（dsh 的 desktop/web 等）：未接入时 UI 据此渲染接入范围选择；attached 后回显已选范围
      clientProfiles: profileOptsList[i],
      clientScope: he?.client_profiles ?? null,
      // 沙箱安装能力（枚举语义见 sandboxInstallCapability）：'unsupported' 时 UI 降级为只展示安装指引
      install: a.install ? {
        auto: !!a.install.command,
        command: resolveInstallCommand(a.install.command),
        guide: a.install.guide,
        homepage: a.install.homepage ?? null,
        sandboxInstall: sandboxInstallCapability(a),
        // 自动卸载能力：null=未声明（UI 不出卸载按钮）；sandbox=卸载是否只落沙箱（FAKE_HOME 下
        // npm 全局卸载经 prefix 重定向，只卸装进沙箱的副本）
        uninstall: resolveInstallCommand(a.install.uninstall)
          ? { command: resolveInstallCommand(a.install.uninstall)!, sandbox: sandboxNpmPrefix() !== null }
          : null,
      } : null,
    })
    if (he && providerId) (usedByMap[providerId] ||= []).push(a.label)
  }
  // 每个服务被哪些客户端使用
  services.forEach((s: any) => { s.usedBy = usedByMap[s.id] ?? [] })
  ensurePresetsLoaded() // 懒加载预设（BUG-12）：presets.json 格式错误在此抛可操作报错，而不是把网关启动都卡死
  return {
    ok: true,
    gateway: {
      port,
      running: true,
      // dev 沙箱实例（run_dev 设置）：配置/日志/客户端写入全部隔离在沙箱 home，UI 据此显示徽标与写操作警示
      sandbox: process.env.MODELRDOCK_DEV_SANDBOX === '1',
      home: (await import('../util/paths.js')).modeldockDir(),
      autoRoute: {
        ...autoRouteInfo(rt),
        failoverOn429: (rt.config.gateway?.failover_status_codes ?? []).includes(429),
        autoFallback: rt.config.gateway?.auto_fallback !== false,
      },
      autostart: autostartOverview(),
      // 轻量模式（派生态，不落盘）：无任何 Web UI 打开时为 true；trayLiteRequest 供已开页面
      // 轮询感知「进入轻量模式」的关闭广播（时间戳，页面侧按新于上次所见去重）
      trayLite: trayLiteActive(Date.now()),
      trayLiteRequest: pendingTrayLiteRequest(),
    },
    current: current ? { id: current.id, label: current.label, model: current.model } : null,
    // 默认路由（active_profile）：与 current（正在使用）区分，供电台「跟随全局」/直连目标等配置态使用
    defaultRoute,
    services,
    clients,
    // 预设附带模型目录（添加页首屏直显预设模型；只带用户可见的三个字段，source 等内部字段不出域）
    presets: PRESETS.map((p) => {
      const pm = presetModels(p)
      return {
        id: p.id, label: p.label, vendor: p.vendor, base_url: p.base_url, protocol: p.protocol,
        endpoints: p.endpoints ?? undefined, docs_url: p.docs_url ?? null,
        models: pm ? Object.fromEntries(Object.entries(pm).map(([mid, m]) => [mid, { display_name: m.display_name, context_window: m.context_window, max_output: m.max_output, capabilities: m.capabilities ?? [] }])) : undefined,
      }
    }),
    knownModels: knownMetaTable(),
    // 多机同步状态行（M2）：只读展示，控制台不做同步配置（去电脑端命令行）
    sync: await syncStatus(),
    // 附近电脑的待确认拉取请求（sync-nearby，单槽 120s）：确认卡据此显示
    syncRequest: peekSyncRequest(),
  }
}

export async function hOverview(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  markUiPing(Date.now()) // 控制台页面的 5s overview 轮询即在场心跳（免新端点高频调用）
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(await overviewViewData(rt)) // 命中直接写缓存串，不再重复 stringify（view 几十-几百 KB）
  return
}

/** 托盘状态数据源：overview 的瘦身投影（托盘菜单需要的字段，几 KB）。
 *  复用 overview 的 6s TTL 缓存——托盘 5s 轮询与控制台轮询共享同一份重建，不抬高 buildOverview 频率；
 *  两平台托盘共用本端点（C# 侧无 Decodable，正则解析吃不动嵌套数组，载荷必须小） */
export async function hTrayState(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  const view = JSON.parse(await overviewViewData(rt)) as {
    gateway?: { autoRoute?: { forced?: string | null; schedule?: { applied?: boolean } } }
    current?: { id: string; label: string; model?: string | null } | null
    services?: Array<{ id: string; label: string; inUse?: boolean; enabled?: boolean; down?: boolean; defaultModel?: string | null; models?: Array<{ id: string; display_name?: string | null }> }>
    clients?: Array<{ id: string; label: string; installed?: boolean; attached?: boolean; mode?: string | null; route?: string | null; pinnedProvider?: string | null; followsActive?: boolean; service?: string | null }>
  }
  const payload = {
    ok: true,
    // 轻量模式为派生态，live 求值而非读 6s 缓存的 overview 串：托盘勾选态少一档陈旧
    trayLite: trayLiteActive(Date.now()),
    current: view.current ?? null,
    autoPin: view.gateway?.autoRoute?.forced ?? null,
    scheduleApplied: view.gateway?.autoRoute?.schedule?.applied === true,
    services: (view.services ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      inUse: s.inUse === true,
      enabled: s.enabled !== false,
      down: s.down === true,
      defaultModel: s.defaultModel ?? null,
      models: (s.models ?? []).map((m) => ({ id: m.id, display: m.display_name ?? null })),
    })),
    clients: (view.clients ?? [])
      .filter((cl) => cl.installed === true)
      .map((cl) => ({
        id: cl.id,
        label: cl.label,
        attached: cl.attached === true,
        mode: cl.mode ?? null,
        route: cl.route ?? null,
        pinnedProvider: cl.pinnedProvider ?? null,
        followsActive: cl.followsActive === true,
        service: cl.service ?? null,
      })),
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
  return
}

/** 轻量模式入口（托盘菜单点击）：向已开页面广播关闭请求（overview 的 trayLiteRequest 字段，
 *  页面感知后 window.close()，被浏览器拦截时页面显示手动关闭提示）。请求体不解析
 *  （托盘双端发 {} / {"enabled":true}，仅读取以复用连接） */
export async function hTrayLite(c: AdminCtx): Promise<void> {
  const { req, res, audit } = c
  await jsonRequestBody(req)
  requestTrayLite(Date.now())
  invalidateOverviewCache() // 广播时间戳即刻可见：页面最迟下一个 5s 轮询拿到
  audit(bi('进入轻量模式', 'Enter lightweight mode'), '-')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, trayLite: trayLiteActive(Date.now()) }))
  return
}

/** 页面在场心跳（页面 15s 一次，不受 document.hidden 门控——后台标签页也算「打开的 UI」）；
 *  pagehide 的 sendBeacon 带 {"leaving":true} 即刻离场，不等 TTL */
export async function hUiPresence(c: AdminCtx): Promise<void> {
  const { req, res } = c
  const b = await jsonRequestBody(req)
  if (b.leaving === true) markUiLeaving(Date.now())
  else markUiPing(Date.now())
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  return
}


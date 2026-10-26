import path from 'node:path'
import fs from 'node:fs'
import type { Dispatcher } from 'undici'
import type { Config, ProfileConfig, ProviderConfig, ScheduleWindow } from '../config/types.js'
import { logsDir, gatewayStatePath } from '../util/paths.js'
import { appendLine, atomicWrite, closeAppendStream } from '../util/fsx.js'
import { t } from '../util/i18n.js'
import { buildDispatcher } from './proxy.js'
import { dayTypeFor, loadCalendarFull, upcomingHolidays, type DayType, type HolidayCalendar, type HolidayDayNamed, type HolidayRange } from './daytype.js'

export interface LogEntry {
  ts: string
  /** 默认 'request'（转发请求）；管理面连接测试也记为 request，便于排查 */
  kind?: 'request'
  harness: string
  profile: string
  provider: string
  model?: string
  path: string
  status?: number
  ms?: number
  err?: string
  /** 路由事件标记：仅在偏离主选直连成功时设置（failover_to:<id>、replayed_from:<id>、down_all）；缺席=普通成功，日志过滤依赖「非空即事件」 */
  reason?: string
  /** 上游响应观测到的 token 用量（狗粮对账口径：缓存读计入输入成本）。
   *  从响应流旁路解析（SSE 逐行 / 小体积 JSON），尽力而为——旧日志与解析失败时缺省。 */
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
  }
}

/** 操作审计：Web 控制台修改类配置操作（添加/编辑/删除服务、切换、接入等） */
export interface AuditEntry {
  ts: string
  kind: 'audit'
  /** 操作名（中文渲染，如「添加服务」）；双语条目另有 op_en */
  op: string
  /** 操作名英文渲染；缺省 = 旧条目只有主字段语言，展示端按需回退 */
  op_en?: string
  /** 操作目标，如服务 id、客户端 id、路由名（原文照存，枚举型值另有 target_en） */
  target: string
  /** 操作目标英文渲染（仅 target 为枚举型文案时存在，如 开启/关闭） */
  target_en?: string
  /** 变更摘要（不含任何密钥明文；中文渲染） */
  detail?: string
  /** 变更摘要英文渲染；缺省 = 旧条目 */
  detail_en?: string
  ok: boolean
  err?: string
  /** err 的英文渲染（err 为动态文本时无对译则缺省） */
  err_en?: string
  /** 来源：web（本机控制台同源）、token（携带 admin token，CLI 兼容调用）、lan（手机简版控制台）、tray（系统托盘，x-modeldock-source 头标记） */
  source: 'web' | 'token' | 'lan' | 'tray'
}

export type RingEntry = LogEntry | AuditEntry

export interface ResolvedTarget {
  harness: string
  profileName: string
  profile: ProfileConfig
  provider: ProviderConfig
  /** 故障切换候选的模型映射（"<providerId>:<modelId>" 条目）；设置时请求体模型强制改写为该值 */
  modelOverride?: string
  /** 该 target 由客户端钉住路由（harness.route）解析而来：pickTarget 以钉住服务为最高优先主候选，
   *  不随全局「正在使用」（当前槽/定时窗口）走——与展示层口径一致（overview 客户端卡、烤模型重写均豁免钉住） */
  viaHarnessPin?: boolean
}

export type ResolveResult =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; status: number; message: string; hint?: string }

export interface GatewayRuntime {
  config: Config
  /** token → harness id */
  tokens: Map<string, string>
  ring: RingEntry[]
  startedAt: number
  adminToken: string
  reloads: number
  /** proxy 配置值 → dispatcher（undefined = 直连） */
  dispatchers: Map<string, Dispatcher | undefined>
  /** providerId → 自动路由健康/熔断状态（仅 auto_failover 开启时使用） */
  health: Map<string, HealthState>
  /** 实际监听端口（可能因占用与配置不同） */
  port?: number
  /** 手机简版控制台（LAN）第二监听器运行态；随网关生命周期启停。host=实际绑定地址（对外 URL 只列真正可达的地址） */
  lan?: { server: import('node:http').Server; port: number; token: string; host: string }
  /** 节假日日历的 rt 级缓存（30s TTL 懒加载，见 calendarCache；日历缓存文件更新最迟 30s 生效）：
   *  定时窗口 dayFilter 判定与 overview 日类型/假期展示共用 */
  calendar?: HolidayCalendar
  calendarDays?: HolidayDayNamed[]
  calendarAt?: number
}

/** 健康状态：滑动窗口错误计数 + 熔断截止时间。窗口内错误数达阈值即熔断，冷却后探活恢复。 */
export interface HealthState {
  /** 60s 滑动错误窗口（t0 起算点，count 错误次数） */
  errWindow: { t0: number; count: number }
  /** 熔断截止时间戳；未熔断则为 undefined */
  meltdown_until?: number
  /** 连续成功次数（≥3 清零熔断） */
  okStreak: number
  /** 最近一次成功请求/探活的耗时 ms（供 overview 展示与备用链同优先级决胜；失败不写，见 recordOutcome） */
  lastMs?: number
}

export function buildTokenIndex(config: Config): Map<string, string> {
  const map = new Map<string, string>()
  for (const [id, he] of Object.entries(config.harness ?? {})) {
    if (he.token) map.set(he.token, id)
  }
  return map
}

export function buildRuntime(config: Config, adminToken: string): GatewayRuntime {
  return {
    config,
    tokens: buildTokenIndex(config),
    ring: [],
    startedAt: Date.now(),
    adminToken,
    reloads: 0,
    dispatchers: new Map(),
    health: new Map(),
  }
}

export async function reloadRuntime(rt: GatewayRuntime): Promise<void> {
  const { loadConfig } = await import('../config/store.js')
  const { invalidateSecretsCache } = await import('../config/secrets.js')
  // 文件 watcher 触发的 reload 会经过这里：清 file/外部后端密钥缓存，另一进程改的 key 即刻（再读盘）生效
  invalidateSecretsCache()
  rt.config = await loadConfig()
  rt.tokens = buildTokenIndex(rt.config)
  rt.reloads++
  // 释放旧的代理 dispatcher（ProxyAgent 连接）；direct 共享 Agent 是模块级单例、跨重载复用，不关
  const keep = rt.dispatchers.get('direct')
  for (const d of rt.dispatchers.values()) {
    if (d && d !== keep && typeof d.close === 'function') {
      Promise.resolve(d.close()).catch(() => {})
    }
  }
  rt.dispatchers.clear()
  // 已删除的 provider 健康条目一并清掉：长生命周期进程反复增删服务不残留（recordOutcome 只增不删）
  for (const id of rt.health.keys()) {
    if (!rt.config.providers[id]) rt.health.delete(id)
  }
}

/** per-provider 代理：direct 直连；env 读环境变量；字符串视为代理 URL（兼容 clash） */
export function dispatcherFor(rt: GatewayRuntime, provider: ProviderConfig): Dispatcher | undefined {
  const mode = provider.proxy ?? 'direct'
  if (rt.dispatchers.has(mode)) return rt.dispatchers.get(mode)
  const created = buildDispatcher(provider.proxy)
  rt.dispatchers.set(mode, created)
  return created
}

export function resolveTarget(rt: GatewayRuntime, token: string, profileOverride?: string): ResolveResult {
  const harness = rt.tokens.get(token)
  if (!harness) {
    return {
      ok: false,
      status: 401,
      message: t('无效的 harness token', 'Invalid harness token'),
      hint: t('token 见 modeldock status；token 丢失可重新 attach（会生成新 token）', 'Tokens are listed by modeldock status; if a token is lost, re-attach to generate a new one'),
    }
  }
  return resolveByProfile(rt, profileOverride, harness)
}

/** admin 探测/test 用：按 profile 名解析（harness 记为 admin-test） */
export function resolveByProfile(
  rt: GatewayRuntime,
  profileOverride?: string,
  harnessId = 'admin-test'
): ResolveResult {
  const he = harnessId === 'admin-test' ? undefined : rt.config.harness[harnessId]
  const routeName =
    profileOverride ??
    (he?.route && he.route !== 'default' ? he.route : undefined) ??
    rt.config.active_profile
  if (!routeName) {
    return {
      ok: false,
      status: 503,
      message: t('未设置 active_profile，该 harness 也未固定 route', 'No active_profile is set and this harness has no pinned route'),
      hint: t('modeldock profile use <name> 设置默认路由', 'Run modeldock profile use <name> to set the default route'),
    }
  }
  const profile = rt.config.profiles[routeName]
  if (!profile) {
    return { ok: false, status: 503, message: t('profile「{name}」不存在', 'Profile "{name}" not found', { name: routeName }), hint: t('modeldock profile list 查看', 'Run modeldock profile list to view profiles') }
  }
  const provider = rt.config.providers[profile.provider]
  if (!provider) {
    return {
      ok: false,
      status: 503,
      message: t('profile「{profile}」引用的 provider「{provider}」不存在', 'Provider "{provider}" referenced by profile "{profile}" not found', { profile: routeName, provider: profile.provider }),
      hint: t('modeldock provider list 查看', 'Run modeldock provider list to view providers'),
    }
  }
  // 客户端钉住路由生效（he.route 且未被 profileOverride 覆盖）：给 target 打标，pickTarget 据此把钉住服务列为主候选最高级
  const viaHarnessPin = !profileOverride && !!he?.route && he.route !== 'default'
  return { ok: true, target: { harness: harnessId, profileName: routeName, profile, provider, ...(viaHarnessPin ? { viaHarnessPin: true } : {}) } }
}

// 自动路由：健康/熔断状态与候选选路

/** 滑动窗口 + 熔断更新。cls 仅记录需要熔断的错误类；ok 或 null(4xx 中性)不累计。
 *  quota=额度耗尽（402 / 429+quota 体）：3 次即熔断且冷却 15 分钟——额度不会分钟级恢复，别反复撞耗尽的服务。 */
export function recordOutcome(
  rt: GatewayRuntime,
  providerId: string,
  r: { ok: boolean; cls?: 'connect' | '429' | '5xx' | 'quota'; ms?: number }
): void {
  const now = Date.now()
  let h = rt.health.get(providerId)
  if (!h) {
    h = { errWindow: { t0: now, count: 0 }, okStreak: 0 }
    rt.health.set(providerId, h)
  }
  // lastMs 只记成功耗时：备用链同优先级按它决胜，失败请求（尤其几毫秒的 connect 快速失败）
  // 若也写入，会让正在出错的服务伪装成「最快」被排到候选链前排、还被展示成「下一个切换」
  if (r.ms != null && r.ok) h.lastMs = r.ms
  if (r.ok) {
    h.okStreak += 1
    h.errWindow = { t0: now, count: 0 }
    if (h.okStreak >= 3) h.meltdown_until = undefined
    return
  }
  h.okStreak = 0
  if (!r.cls) return // 4xx 中性：失败但不计熔断（模型/key 配置问题换服务大概率同样失败）
  const w = h.errWindow
  if (now - w.t0 > 60_000) {
    w.t0 = now
    w.count = 0
  }
  w.count += 1
  const [thr, cool] =
    r.cls === 'connect' ? [3, 60_000] : r.cls === '429' ? [5, 120_000] : r.cls === 'quota' ? [3, 900_000] : [10, 60_000]
  if (w.count >= thr) h.meltdown_until = now + cool
}

/** 是否处于熔断期（不可选作路由目标） */
export function isMeltdown(rt: GatewayRuntime, providerId: string, now = Date.now()): boolean {
  const h = rt.health.get(providerId)
  return !!h && h.meltdown_until != null && h.meltdown_until > now
}

// 定时切换：时段求值（纯函数，每次选路实时计算，无定时器/无运行态）

function parseHHmm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

function dowOf(d: Date): number {
  return d.getDay() === 0 ? 7 : d.getDay()
}

/** 日历 rt 缓存 TTL：TTL 内 dayFilter 判定与 overview 日类型/假期展示零文件 IO */
const CALENDAR_TTL_MS = 30_000

/** rt 级日历缓存（30s TTL，known-issues PERF-02 的治理口径）：hitScheduleWindows 的 dayFilter
 *  判定与 autoRouteInfo 的「今天日类型 / 近 3 个假期」展示共用同一份，不再各自 statSync。
 *  loadCalendarFull 一次 stat 同取 years/days（daytype 内部另有 mtime memo，日历落盘最迟 30s 生效）。 */
function calendarCache(rt: GatewayRuntime): { years: HolidayCalendar; days: HolidayDayNamed[] } {
  if (!rt.calendar || Date.now() - (rt.calendarAt ?? 0) > CALENDAR_TTL_MS) {
    const full = loadCalendarFull()
    rt.calendar = full.years
    rt.calendarDays = full.days
    rt.calendarAt = Date.now()
  }
  return { years: rt.calendar, days: rt.calendarDays! }
}

/** 窗口在归属日期 ref 是否生效：days（星期几）与 dayFilter（日类型）同时配置时取交集。
 *  calendar 传 getter 惰性取：days-only 窗口短路在前，无 dayFilter 的部署零文件 IO；
 *  日历经 rt 缓存（30s TTL），转发热路径不做每请求 statSync。 */
function windowDayMatches(w: ScheduleWindow, ref: Date, calendar: () => HolidayCalendar): boolean {
  if (w.days?.length && !w.days.includes(dowOf(ref))) return false
  const f = w.dayFilter
  if (!f || (f as string) === 'any') return true // 'any' 仅为手改配置的容错，正常写入不会产生
  const dt = dayTypeFor(ref, calendar())
  if (f === 'holiday') return dt === 'holiday'
  if (f === 'weekend') return dt === 'weekend'
  return dt === 'workday' || dt === 'makeup' // workday：周一至五与调休补班日，法定节假日不算
}

/** 求值当前命中的全部窗口（已停用 → 空数组）。
 *  start 含、end 不含；唯一例外 e === 1439（23:59）按「当天结束」惯例含入最后一分钟——
 *  「全天」窗口惯用 00:00–23:59 表达，若按 end 不含会让 23:59:00–23:59:59 静默回落默认路由。
 *  end < start 视为跨午夜窗口，后半夜（t<end）归属窗口起始日（昨天）——
 *  星期几与日类型都按起始日判定，否则「周五 22:00-06:00」会在周六凌晨因 dow 不符而漏判。 */
function hitScheduleWindows(rt: GatewayRuntime, now: Date): ScheduleWindow[] {
  const sch = rt.config.gateway?.schedule
  if (!sch || sch.enabled === false) return []
  const t = now.getHours() * 60 + now.getMinutes()
  // 日历经 rt 缓存 + 30s TTL（calendarCache）：此前每请求都走 loadCalendar 的 statSync（旧写法
  // 把日历做成了函数局部变量且作为实参总是求值，随 QPS 放大；known-issues PERF-02）。
  // 惰性 getter：days-only 窗口短路在前，无 dayFilter 的部署零文件 IO
  const cal = () => calendarCache(rt).years
  const hit: ScheduleWindow[] = []
  for (const w of sch.windows ?? []) {
    const s = parseHHmm(w.start)
    const e = parseHHmm(w.end)
    if (s == null || e == null || s === e) continue
    let ref: Date
    if (s < e) {
      if (t < s || (t >= e && e !== 1439)) continue
      ref = now
    } else if (t >= s) {
      ref = now // 当晚半场
    } else if (t < e) {
      ref = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1) // 后半夜：归属昨天的窗口
    } else {
      continue
    }
    if (windowDayMatches(w, ref, cal)) hit.push(w)
  }
  return hit
}

/** 当前命中的「优先走」窗口（windows 按配置顺序取首个非避开命中）。已停用 / 不在生效日 / 不在任何时段 → null。 */
export function activeScheduleWindow(rt: GatewayRuntime, now = new Date()): ScheduleWindow | null {
  return hitScheduleWindows(rt, now).find((w) => w.mode !== 'avoid') ?? null
}

/** 当前命中的全部「避开」窗口目标服务 id（去重）。命中期间选路时从候选链剔除这些服务。 */
export function activeAvoidTargets(rt: GatewayRuntime, now = new Date()): string[] {
  const ids: string[] = []
  for (const w of hitScheduleWindows(rt, now)) {
    if (w.mode !== 'avoid') continue
    // avoid 仅到服务粒度：target 带模型部分时剥掉，按整个服务避开
    const p = parseFallbackEntry(w.target)
    if (p && !ids.includes(p.providerId)) ids.push(p.providerId)
  }
  return ids
}

/** 只读解析 provider 对应的 profile（active_profile 优先，其次首个引用该 provider 的 profile）。
 *  窗口/钉定把主候选切到别的服务时，用它把「目标服务的默认模型/别名」一起带过去；否则 base
 *  profile 的 default_model 会被写进另一个上游（模型名可能根本不存在）。 */
function profileForProviderReadonly(cfg: Config, providerId: string): { name: string; profile: ProfileConfig } | undefined {
  if (cfg.active_profile && cfg.profiles[cfg.active_profile]?.provider === providerId) {
    return { name: cfg.active_profile, profile: cfg.profiles[cfg.active_profile] }
  }
  for (const [name, profile] of Object.entries(cfg.profiles)) {
    if (profile.provider === providerId) return { name, profile }
  }
  return undefined
}

/** 静态首选路由（展示层/烤模型客户端用）：人工钉定 > prefer 窗口 > active_profile。
 *  与 pickTarget 同序，但只看 enabled（已下线即跳过）、刻意忽略熔断等瞬态——瞬态接管是请求级
 *  failover，模型翻译在转发时即时完成，选择器不应跟着抖。窗口边界没有事件（请求级时间函数），
 *  调用方需周期比对此值的变化来触发客户端重写。 */
function preferredRoute(
  rt: GatewayRuntime,
  now: Date
): { providerId: string | null; source: 'pinned' | 'schedule' | 'default' } {
  const forced = rt.config.gateway?.auto_route_provider
  if (forced) {
    const p = rt.config.providers[forced]
    if (p && p.enabled !== false) return { providerId: forced, source: 'pinned' }
  }
  const on = rt.config.gateway?.auto_failover === true
  const win = on ? activeScheduleWindow(rt, now) : null
  if (win) {
    const parsed = parseFallbackEntry(win.target)
    const p = parsed ? rt.config.providers[parsed.providerId] : undefined
    if (parsed && p && p.enabled !== false) return { providerId: parsed.providerId, source: 'schedule' }
  }
  const profName = rt.config.active_profile
  return { providerId: profName ? (rt.config.profiles[profName]?.provider ?? null) : null, source: 'default' }
}

/** 「展示路由」：烤模型客户端（/model 选择器等静态策划面）此刻应当展示的服务。 */
export function displayRouteProvider(rt: GatewayRuntime, now = new Date()): string | undefined {
  return preferredRoute(rt, now).providerId ?? undefined
}

export interface OrderedCandidate {
  target: ResolvedTarget
  providerId: string
  isPrimary: boolean
  /** 候选条目 "<providerId>:<modelId>" 携带的模型映射；纯 "<providerId>" 条目为 undefined（透传） */
  modelOverride?: string
}

/** 解析 fallback 条目："<providerId>"（透传原模型名）或 "<providerId>:<modelId>"（改写模型）。
 *  providerId 不含冒号（slugify 产出），model 取首个冒号后的全部（模型 id 可含冒号）。空/无 providerId 返回 null。 */
export function parseFallbackEntry(entry: string): { providerId: string; model?: string } | null {
  const raw = String(entry ?? '').trim()
  if (!raw) return null
  const i = raw.indexOf(':')
  const providerId = (i === -1 ? raw : raw.slice(0, i)).trim()
  if (!providerId) return null
  if (i === -1) return { providerId }
  const model = raw.slice(i + 1).trim()
  return model ? { providerId, model } : { providerId }
}

/** 主候选来源：人工钉定 / 定时窗口 / 默认路由 / 首选不可用后的故障降级 */
export type RouteSource = 'pinned' | 'schedule' | 'default' | 'failover'

export type PickResult =
  | {
      ok: true
      ordered: OrderedCandidate[]
      /** 首候选的选路来源：pinned/schedule/default 为首选三级；首候选不是首选目标时= failover */
      primary: { source: RouteSource; providerId: string; degradedFrom?: 'pinned' | 'schedule' }
    }
  | { ok: false; reason: 'down_all' }

/** 自动备用链最多补进的候选数（手动 fallback 不计入）；防极端服务数下串联一长串上游 */
const AUTO_FALLBACK_MAX = 3

/** 在 resolveByProfile 的静态基准之上做运行时选路：客户端钉住 > 人工钉定（当前槽）> 定时窗口 > 默认路由，备用链按 priority 排序；过滤 enabled/熔断态。全灭返回 down_all。
 *  客户端钉住（harness.route → viaHarnessPin）不受全局「正在使用」控制：当前槽与 prefer 窗口都不接管它，avoid 窗口也不剔除它（钉住服务可用时）；
 *  钉住服务不可用（下线/熔断）才顺延到下一级，不打死在坏服务上——与展示层口径一致（烤模型重写、overview 客户端卡均豁免钉住）。
 *  手动 fallback 之后自动补尾（auto_fallback 开启时，见 AUTO_FALLBACK_MAX），保证「没配备用链也能自动切」。
 *  ignoreManual：忽略两处全局人工钉定（主服务钉定与「下一个切换」钉定），供「当前 · 自动」标签计算程序自动会选谁；不影响客户端钉住（那是请求基准，不是全局槽位）。
 *  ignoreRouteNext：只忽略「下一个切换」钉定、保留主服务钉定与窗口，供「下一个切换 · 自动」标签计算自动态真会切到谁。 */
export function pickTarget(
  rt: GatewayRuntime,
  base: ResolvedTarget,
  fallbackIds: string[] | undefined,
  opts?: { ignoreManual?: boolean; ignoreRouteNext?: boolean; now?: number }
): PickResult {
  const now = opts?.now ?? Date.now()
  const eligible = (id: string): boolean => {
    const p = rt.config.providers[id]
    if (!p) return false
    if (p.enabled === false) return false
    if (isMeltdown(rt, id, now)) return false
    return true
  }
  // pairProfile：主候选来自钉定/窗口（可能不是默认路由的服务）时，把目标服务自己的 profile
  // （默认模型 + 别名）一起带过去，保证「换服务就换模型口径」；备用链候选保持 base profile，
  // 不影响既有故障切换语义。
  const makeTarget = (id: string, modelOverride?: string, pairProfile = false): ResolvedTarget => {
    const pair = pairProfile && id !== base.profile.provider ? profileForProviderReadonly(rt.config, id) : undefined
    const profile = pair
      ? { ...pair.profile, provider: id, default_model: pair.profile.default_model ?? Object.keys(rt.config.providers[id]?.models ?? {})[0] }
      : { ...base.profile, provider: id }
    return {
      harness: base.harness,
      profileName: pair?.name ?? base.profileName,
      profile,
      provider: rt.config.providers[id],
      ...(modelOverride ? { modelOverride } : {}),
    }
  }
  // 主候选四级优先：客户端钉住（harness.route，钉住客户端不随全局「正在使用」走——当前槽与 prefer 窗口都压不过它，
  // 否则钉住会在窗口时段被静默甩到别家，2026-10-21 mimo-desktop 报障即此）> 人工钉定（当前槽，人为修改优先于程序自动——
  // 程序出错时人工修改就是想要的）> 定时窗口（仅「程序自动选主」开启时参与）> 默认路由。
  // 钉住/钉定/窗口目标不可用（下线/熔断）时顺延到下一级，不打死在坏服务上；接管主候选时默认服务排链尾兜底。
  // 定时窗口一次求值，主候选 / 自动链权重 / 避开三处共用（原先各调一次 hitScheduleWindows，
  // 时间基点同为 now 结果必然一致；无 schedule 时早退空数组，零开销）
  const hitWins = hitScheduleWindows(rt, new Date(now))
  const on = rt.config.gateway?.auto_failover === true
  const win = on ? (hitWins.find((w) => w.mode !== 'avoid') ?? null) : null
  const winParsed = win ? parseFallbackEntry(win.target) : null
  const forcedId = opts?.ignoreManual ? undefined : rt.config.gateway?.auto_route_provider
  const pinEligible = base.viaHarnessPin === true && eligible(base.profile.provider)
  const forcedEligible = !pinEligible && !!forcedId && eligible(forcedId)
  const winEligible = !forcedEligible && !!(winParsed && rt.config.providers[winParsed.providerId] && eligible(winParsed.providerId))
  const primaryId = pinEligible ? base.profile.provider : forcedEligible ? forcedId! : winEligible ? winParsed!.providerId : base.profile.provider
  // 钉住即该服务自己的口径：窗口条目携带的模型改写不参与（与全局钉定同规，见「钉定为服务级」用例）
  const primaryOverride = !pinEligible && winEligible ? winParsed!.model : undefined
  const preferredKind: 'pinned' | 'schedule' | 'default' = pinEligible || forcedEligible ? 'pinned' : winEligible ? 'schedule' : 'default'
  // 包一层统一出口：首候选被避开/首选不可用时如实标记来源与降级来源，供「正在使用」显示
  const choose = (list: OrderedCandidate[]): PickResult => {
    const first = list[0]
    const source: RouteSource = first.providerId === primaryId ? preferredKind : 'failover'
    const degradedFrom = source === 'failover' ? (forcedId ? 'pinned' : win && on ? 'schedule' : undefined) : undefined
    return {
      ok: true,
      ordered: list,
      primary: { source, providerId: first.providerId, ...(degradedFrom ? { degradedFrom } : {}) },
    }
  }
  const ordered: OrderedCandidate[] = []
  const seen = new Set<string>()
  if (eligible(primaryId)) {
    ordered.push({ target: makeTarget(primaryId, primaryOverride, true), providerId: primaryId, isPrimary: true, modelOverride: primaryOverride })
    seen.add(primaryId)
  }
  // 「下一个切换」人工钉定：插到备用链首位（与主候选同服务则不重复插，seen 去重兜底；它也不可用时由 eligible 剔除、自然顺延到自动排序的备用）
  const nextRaw = opts?.ignoreManual || opts?.ignoreRouteNext ? undefined : rt.config.gateway?.route_next
  const fbSource = nextRaw && nextRaw !== primaryId ? [nextRaw, ...(fallbackIds ?? [])] : (fallbackIds ?? [])
  // fallback：去重、仅取存在的服务；按 priority 降序，同 priority 按最近耗时升序（稳定排序，均无数据保配置顺序）
  const fb = fbSource
    .map((raw): { id: string; model?: string; priority: number; lastMs?: number } | null => {
      const parsed = parseFallbackEntry(raw)
      if (!parsed) return null
      const p = rt.config.providers[parsed.providerId]
      if (!p) return null
      return {
        id: parsed.providerId,
        model: parsed.model,
        priority: p.priority ?? 0,
        lastMs: rt.health.get(parsed.providerId)?.lastMs,
      }
    })
    .filter((x): x is { id: string; model?: string; priority: number; lastMs?: number } => x !== null)
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority
      const am = a.lastMs ?? Number.POSITIVE_INFINITY
      const bm = b.lastMs ?? Number.POSITIVE_INFINITY
      if (am !== bm) return am - bm
      return 0 // 均无耗时数据：保持配置顺序（稳定排序）
    })
  for (const f of fb) {
    if (seen.has(f.id)) continue
    seen.add(f.id)
    if (eligible(f.id)) {
      ordered.push({ target: makeTarget(f.id, f.model), providerId: f.id, isPrimary: false, modelOverride: f.model })
    }
  }
  // 自动备用链：手动链之外自动补尾（auto_fallback 缺省开，显式 false 关闭）。从已启用、未熔断的服务里选，
  // 排序：当前「优先走」窗口命中的目标 > priority 降序 > 实测耗时升序 > 配置顺序；上限 3 个；
  // 模型名原样透传（makeTarget 不带 override → 模型归客户端管，网关不改写）。
  if (rt.config.gateway?.auto_fallback !== false) {
    const winHit = new Set<string>()
    for (const w of hitWins) {
      if (w.mode === 'avoid') continue
      const p = parseFallbackEntry(w.target)
      if (p) winHit.add(p.providerId)
    }
    const auto = Object.entries(rt.config.providers)
      .filter(([id, p]) => !seen.has(id) && p.enabled !== false && !isMeltdown(rt, id, now))
      .sort((a, b) => {
        const aw = winHit.has(a[0]) ? 1 : 0
        const bw = winHit.has(b[0]) ? 1 : 0
        if (aw !== bw) return bw - aw
        const ap = a[1].priority ?? 0
        const bp = b[1].priority ?? 0
        if (ap !== bp) return bp - ap
        const am = rt.health.get(a[0])?.lastMs ?? Number.POSITIVE_INFINITY
        const bm = rt.health.get(b[0])?.lastMs ?? Number.POSITIVE_INFINITY
        if (am !== bm) return am - bm
        return 0 // 均无耗时数据：保持配置顺序（稳定排序）
      })
    let autoCount = 0
    for (const [id] of auto) {
      if (autoCount >= AUTO_FALLBACK_MAX) break
      seen.add(id)
      ordered.push({ target: makeTarget(id), providerId: id, isPrimary: false })
      autoCount++
    }
  }
  // 兜底：钉定/窗口接管了主候选时，路由主服务排在整个候选链末尾作最后保底
  // （尊重用户显式配置的 fallback 顺序，排其后；保证高峰目标挂掉时回落到默认服务而不是直接报错）
  if ((winEligible || forcedEligible) && !seen.has(base.profile.provider) && eligible(base.profile.provider)) {
    ordered.push({ target: makeTarget(base.profile.provider), providerId: base.profile.provider, isPrimary: false })
    seen.add(base.profile.provider)
  }
  // 避开窗口：命中期间从候选链剔除目标服务（避开优先窗口/强制/主服务，正窗目标恰被避开时顺延到后续候选）
  if (!ordered.length) return { ok: false, reason: 'down_all' }
  const avoid: string[] = []
  for (const w of hitWins) {
    if (w.mode !== 'avoid') continue
    // avoid 仅到服务粒度：target 带模型部分时剥掉，按整个服务避开
    const p = parseFallbackEntry(w.target)
    if (p && !avoid.includes(p.providerId)) avoid.push(p.providerId)
  }
  // 避开窗口：命中期间从候选链剔除目标服务（避开优先窗口/强制/主服务，正窗目标恰被避开时顺延到后续候选）
  // 客户端钉住的服务豁免 avoid（服务可用时）：钉住不随全局时段走，避免时段规则把钉住客户端甩到别家；
  // 其余候选仍按 avoid 剔除。钉住服务已熔断/下线时本就不在链里，过滤对它无操作
  if (!avoid.length) return choose(ordered)
  const kept = base.viaHarnessPin === true
    ? ordered.filter((c) => c.providerId === base.profile.provider || !avoid.includes(c.providerId))
    : ordered.filter((c) => !avoid.includes(c.providerId))
  if (kept.length) return choose(kept)
  // 候选链全被避开（典型：主服务被避开且未配故障切换）——「避开 X，其他服务都行」：链外其余可用服务按 priority 降序补入候选
  const extras = Object.entries(rt.config.providers)
    .filter(([id, p]) => !seen.has(id) && p.enabled !== false && !avoid.includes(id) && !isMeltdown(rt, id, now))
    .sort((a, b) => (b[1].priority ?? 0) - (a[1].priority ?? 0))
    .map(([id]) => ({ target: makeTarget(id), providerId: id, isPrimary: false }))
  if (extras.length) return choose(extras)
  // 全部服务都被避开或不可用：回退原链（软约束——宁可用被避开的服务也不能无服务可用）
  return choose(ordered)
}

/** 命中的定时窗口（展示/诊断用，不含 mode——prefer 与 avoid 分开存放） */
export interface ScheduleHit {
  start: string
  end: string
  target: string
}

/** 统一路由状态：服务端唯一计算入口，所有「正在使用」展示（桌面/手机/客户端行/模型列表）都消费它。
 *  effective 与请求转发同源（pickTarget 首候选，含 enabled/熔断过滤）；default 是 active_profile、
 *  只用于接入/直连等配置态；display 是烤模型客户端的静态展示路由（忽略熔断，避免抖动）。 */
export interface RouteState {
  effective: {
    providerId: string | null
    /** 请求默认模型：窗口/候选的模型映射 > 目标 profile 的 default_model（与 relay 改写同源） */
    model: string | null
    profileName: string | null
    source: RouteSource
    /** 首选三级目标不可用、降级到后续候选时的来源 */
    degradedFrom?: 'pinned' | 'schedule'
  }
  /** 默认路由（active_profile）：配置态，不代表「正在使用」 */
  default: { providerId: string | null; model: string | null; profileName: string | null }
  schedule: {
    /** 命中的首个「优先走」窗口（时间函数；命中 ≠ 接管） */
    hit: ScheduleHit | null
    /** 命中的全部「避开」窗口 */
    avoidHits: ScheduleHit[]
    /** 窗口是否真的接管了主候选 */
    applied: boolean
    /** 命中但未接管的原因：被人工钉定压过 / 目标不可用 / 自动选主关闭 */
    suppressedBy: 'pin' | 'unavailable' | 'off' | null
  }
  next: string | null
  autoPrimary: string | null
  autoNext: string | null
}

/** 计算当前路由状态（纯读，无副作用）。`now` 可注入便于测试窗口边界。 */
export function routeState(rt: GatewayRuntime, opts?: { now?: Date }): RouteState {
  const at = opts?.now ?? new Date()
  const now = at.getTime()
  const on = rt.config.gateway?.auto_failover === true
  const forced = rt.config.gateway?.auto_route_provider ?? null
  const base = resolveByProfile(rt, rt.config.active_profile)
  const hitWins = hitScheduleWindows(rt, at)
  const hitWin = hitWins.find((w) => w.mode !== 'avoid') ?? null
  const avoidHits = hitWins.filter((w) => w.mode === 'avoid')
  const def = base.ok
    ? {
        providerId: base.target.profile.provider,
        model: base.target.profile.default_model ?? null,
        profileName: base.target.profileName,
      }
    : { providerId: null, model: null, profileName: null }
  let effective: RouteState['effective'] = { providerId: null, model: null, profileName: null, source: 'default' }
  let next: string | null = null
  let autoPrimary: string | null = null
  let autoNext: string | null = null
  if (base.ok) {
    const fallback = base.target.profile.fallback
    const picked = pickTarget(rt, base.target, fallback, { now })
    if (picked.ok) {
      const first = picked.ordered[0]
      effective = {
        providerId: first.providerId,
        model: first.modelOverride ?? first.target.profile.default_model ?? null,
        profileName: first.target.profileName,
        source: picked.primary.source,
        ...(picked.primary.degradedFrom ? { degradedFrom: picked.primary.degradedFrom } : {}),
      }
      next = picked.ordered[1]?.providerId ?? null
    }
    // 「当前 · 自动」= 清两处钉定后程序会选谁；「下一个切换 · 自动」= 只清本槽钉定
    const autoPicked = pickTarget(rt, base.target, fallback, { ignoreManual: true, now })
    if (autoPicked.ok) autoPrimary = autoPicked.ordered[0]?.providerId ?? null
    const nextAutoPicked = pickTarget(rt, base.target, fallback, { ignoreRouteNext: true, now })
    if (nextAutoPicked.ok) autoNext = nextAutoPicked.ordered[1]?.providerId ?? null
  } else if (forced && rt.config.providers[forced]) {
    const pair = profileForProviderReadonly(rt.config, forced)
    effective = {
      providerId: forced,
      model: pair?.profile.default_model ?? Object.keys(rt.config.providers[forced].models ?? {})[0] ?? null,
      profileName: pair?.name ?? null,
      source: 'pinned',
    }
  }
  const suppressedBy: RouteState['schedule']['suppressedBy'] = !hitWin
    ? null
    : effective.source === 'schedule'
      ? null
      : effective.source === 'pinned'
        ? 'pin'
        : !on
          ? 'off'
          : 'unavailable'
  return {
    effective,
    default: def,
    schedule: {
      hit: hitWin ? { start: hitWin.start, end: hitWin.end, target: hitWin.target } : null,
      avoidHits: avoidHits.map((w) => ({ start: w.start, end: w.end, target: w.target })),
      applied: effective.source === 'schedule',
      suppressedBy,
    },
    next,
    autoPrimary,
    autoNext,
  }
}

export interface AutoRouteInfo {
  on: boolean
  /** 实际生效主服务（含人工钉定，pickTarget 首候选） */
  provider: string | null
  providerLabel: string | null
  /** 统一的服务默认模型：窗口/候选映射 > 目标 profile 的 default_model */
  model: string | null
  /** 生效来源：人工钉定 / 定时窗口 / 默认路由 / 首选不可用后的故障降级 */
  source: RouteSource
  /** 首选三级目标（钉定/窗口）不可用而降级时的来源，供 UI 解释「为什么不是它」 */
  degradedFrom?: 'pinned' | 'schedule'
  /** 「当前」槽人工钉定（null=自动态） */
  forced: string | null
  /** 自动态（无钉定）程序会选的主服务（「自动 · X」的 X） */
  autoPrimary: string | null
  autoPrimaryLabel: string | null
  /** 「下一个切换」实际生效（人工钉定 ?? 自动排序首个；主服务不可达时将切到它） */
  next: string | null
  nextLabel: string | null
  /** 「下一个切换」槽人工钉定（null=自动态） */
  routeNext: string | null
  /** 钉定服务自己的名字（下拉钉定项兜底显示用；≠ nextLabel——钉定未生效时 next 是实际切向的别家服务） */
  routeNextLabel: string | null
  /** 自动态的下一个切换（「自动 · B」的 B）= 不含「下一个切换」钉定、但保留「当前」钉定/窗口/链尾兜底的下一跳 */
  autoNext: string | null
  autoNextLabel: string | null
  /** 「下一个切换」钉定未生效：钉定目标不可用或与主候选相同，实际下一跳（next）≠ 钉定项，供下拉如实标注 */
  nextPinnedSkipped: boolean
  /** 默认路由（active_profile）——配置态，接入/直连等场景用它，不代表「正在使用」 */
  defaultProvider: string | null
  defaultProviderLabel: string | null
  defaultModel: string | null
  schedule: {
    enabled: boolean
    /** 完整窗口列表（供控制台编辑回显） */
    windows: ScheduleWindow[]
    /** 当前命中的「优先走」时段；不在任何时段为 null */
    active: { start: string; end: string; target: string } | null
    /** 当前命中的全部「避开」时段（供控制台状态显示） */
    activeAvoids: { start: string; end: string; target: string }[]
    /** 窗口是否真的接管了主候选（命中 ≠ 接管：人工钉定/目标不可用/未开启时为 false） */
    applied: boolean
    /** 命中但未接管的原因 */
    suppressedBy: 'pin' | 'unavailable' | 'off' | null
    /** 今天日类型（供控制台解释各时段今天是否生效） */
    today: DayType
    /** 今天（含）起最近 3 个法定假期（供控制台面板底部被动展示；日历缓存缺失时为空） */
    upcomingHolidays: HolidayRange[]
  }
}

/** 自动路由显示信息：routeState 的纯映射（唯一计算入口见 routeState）。 */
export function autoRouteInfo(rt: GatewayRuntime): AutoRouteInfo {
  const rs = routeState(rt)
  const on = rt.config.gateway?.auto_failover === true
  const forced = rt.config.gateway?.auto_route_provider ?? null
  const routeNext = rt.config.gateway?.route_next ?? null
  const nameOf = (id: string | null): string | null => (id ? rt.config.providers[id]?.name ?? id : null)
  const sch = rt.config.gateway?.schedule
  // 展示字段也走 rt 日历缓存（calendarCache）：此前这两处直调 dayTypeFor/upcomingHolidays，
  // 每次 overview 重建（约每 5-10s）都各付一次 statSync，与 PERF-02 的口径不一致
  const cal = calendarCache(rt)
  return {
    on,
    provider: rs.effective.providerId,
    providerLabel: nameOf(rs.effective.providerId),
    model: rs.effective.model,
    source: rs.effective.source,
    ...(rs.effective.degradedFrom ? { degradedFrom: rs.effective.degradedFrom } : {}),
    forced,
    autoPrimary: rs.autoPrimary,
    autoPrimaryLabel: nameOf(rs.autoPrimary),
    routeNext,
    routeNextLabel: nameOf(routeNext),
    next: rs.next,
    nextLabel: nameOf(rs.next),
    nextPinnedSkipped: routeNext != null && rs.next !== routeNext,
    autoNext: rs.autoNext,
    autoNextLabel: nameOf(rs.autoNext),
    defaultProvider: rs.default.providerId,
    defaultProviderLabel: nameOf(rs.default.providerId),
    defaultModel: rs.default.model,
    schedule: {
      enabled: sch ? sch.enabled !== false : true,
      windows: sch?.windows ?? [],
      active: rs.schedule.hit,
      activeAvoids: rs.schedule.avoidHits,
      applied: rs.schedule.applied,
      suppressedBy: rs.schedule.suppressedBy,
      today: dayTypeFor(new Date(), cal.years),
      upcomingHolidays: upcomingHolidays(new Date(), 3, cal.days),
    },
  }
}

const RING_MAX = 500

/** 日志目录只建一次（按路径记忆）：转发热路径上每次写日志都 mkdirSync 是无谓的同步 syscall；
 *  fake home 等目录切换时路径不同会自动重建。 */
let ensuredLogDir = ''
function ensureLogDir(dir: string): void {
  if (ensuredLogDir === dir) return
  fs.mkdirSync(dir, { recursive: true })
  ensuredLogDir = dir
}

/** 高频 JSONL 落盘走 fsx 的常驻追加流池（appendFile 每条 open+write+close 走线程池，热路径
 *  上与转发争 IO）；目录仍在此按路径记忆只建一次，fake home 等目录切换时路径不同会自动重建。 */
function appendLog(file: string, line: string): void {
  const dir = logsDir()
  ensureLogDir(dir)
  appendLine(path.join(dir, file), line)
}

/** 请求日志：全量按天 JSONL 落盘（不含任何请求体）；仅错误请求（4xx/5xx/异常/自动改发）进内存环形缓冲供 Web 端展示 */
export function logRequest(rt: GatewayRuntime, entry: LogEntry): void {
  // 避免被高频正常请求刷屏
  if (entry.status === undefined || entry.status >= 400 || entry.err || entry.reason) {
    rt.ring.push(entry)
    if (rt.ring.length > RING_MAX) rt.ring.splice(0, rt.ring.length - RING_MAX)
  }
  try {
    appendLog(`gateway-${entry.ts.slice(0, 10)}.jsonl`, JSON.stringify(entry) + '\n')
  } catch {
    /* 日志失败不影响转发 */
  }
}

/** 操作审计：环形缓冲（页面日志表可见）+ 按天 JSONL 落盘 audit-日期.jsonl（不含密钥明文） */
export function logAudit(rt: GatewayRuntime, entry: AuditEntry): void {
  rt.ring.push(entry)
  if (rt.ring.length > RING_MAX) rt.ring.splice(0, rt.ring.length - RING_MAX)
  try {
    appendLog(`audit-${entry.ts.slice(0, 10)}.jsonl`, JSON.stringify(entry) + '\n')
  } catch {
    /* 审计失败不影响操作本身 */
  }
}

/** JSONL 日志保留期清理（PERF-16）：gateway-/audit- 按天日文件无界累积，超保留天数的在
 *  网关启动与每日定时删除。文件名严格锚定、日期非法的一律不碰；被常驻流池持有句柄的
 *  日文件先关流再删（Windows 文件有本进程 fd 时 unlink 报 EPERM/EBUSY），删除失败跳过、
 *  次日定时重试。返回删除数；retentionDays 非正数视为禁用。 */
const LOG_DAY_FILE_RE = /^(gateway|audit)-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

export async function pruneExpiredLogs(retentionDays: number, now = new Date()): Promise<number> {
  const days = Math.floor(Number(retentionDays))
  if (!Number.isFinite(days) || days <= 0) return 0
  const dir = logsDir()
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  let pruned = 0
  for (const name of names) {
    const m = LOG_DAY_FILE_RE.exec(name)
    if (!m) continue
    const fileDate = new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4])).getTime()
    if (!Number.isFinite(fileDate)) continue
    if (startOfToday - fileDate <= days * 86_400_000) continue
    const full = path.join(dir, name)
    await closeAppendStream(full)
    try {
      fs.unlinkSync(full)
      pruned++
    } catch {
      /* 被外部进程占用等：跳过，次日定时重试 */
    }
  }
  return pruned
}

export interface GatewayStateFile {
  pid: number
  port: number
  admin_token: string
  started_at: string
  /** 「设备记忆」凭据（锁屏一键重登用）：mdk_device cookie 的值，与令牌同文件同生命周期。
   *  上限 20 个（FIFO），多实例共享此文件故天然跨端口生效。 */
  devices?: string[]
  /** 手机简版控制台（LAN）凭据：mdklan_ 前缀，跨重启稳定（手机 cookie 不掉） */
  lan_token?: string
  /** LAN 实际监听端口（冲突顺延后回写；关闭时移除） */
  lan_port?: number
  /** 更新检查时间（24h TTL 跨网关重启有效）；version = 当时看到的最新版；failedAt = 最近一次失败检查（30min 重试退避，不占成功 TTL）。
   *  at 可选：从未成功过、只有失败记录时没有 at。 */
  update_check?: { at?: number; version?: string; failedAt?: number }
}

export async function readGatewayState(): Promise<GatewayStateFile | null> {
  try {
    const text = await fs.promises.readFile(gatewayStatePath(), 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 活着的网关状态（gateway.json 存在且 pid 存活，且健康端点验明正身）。
 *  pid 会被系统复用：仅凭 pid 存活就把复用者当网关，stop 会误杀无关进程。 */
export async function gatewayLive(): Promise<GatewayStateFile | null> {
  const state = await readGatewayState()
  if (!state || !pidAlive(state.pid)) return null
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/_modeldock/health`, {
      signal: AbortSignal.timeout(1000),
    })
    if (!res.ok) return null
    const j = (await res.json()) as { started_at?: string }
    if (j.started_at && state.started_at && j.started_at !== state.started_at) return null
  } catch {
    // 进程在但健康端点不通：多半是 pid 被复用或端口被别的服务占用，按陈旧状态处理
    return null
  }
  return state
}

export async function writeGatewayState(state: GatewayStateFile): Promise<void> {
  await atomicWrite(gatewayStatePath(), JSON.stringify(state, null, 2), 0o600)
}

export async function clearGatewayState(): Promise<void> {
  await fs.promises.rm(gatewayStatePath(), { force: true }).catch(() => {})
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

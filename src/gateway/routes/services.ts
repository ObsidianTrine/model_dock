import { mutateConfig } from '../../config/store.js'
import { defaultStore, deleteSecret, getFirstProviderSecret, providerAllKeyRefs, providerKeyRefs, resolveProviderKeys, setSecret, type SecretBackend } from '../../config/secrets.js'
import { knownModelsForBaseUrl } from '../../presets/data.js'
import { addService, refreshBakedModelClients, removeProviderCascade, setAutoRoute, setRouteNext, switchToServiceWithRoute } from '../../ops.js'
import { resolveModelFallback } from '../../ops/service.js'
import { applyImport, normalizeBaseUrl, scanSources } from '../../import/sources.js'
import { resolveModelMeta } from '../../providers/resolve.js'
import { saneCapabilities } from '../../providers/known.js'
import { fetchModelIds } from '../../providers/fetch.js'
import { parseFallbackEntry, reloadRuntime } from '../state.js'
import { refreshCalendar } from '../holidays.js'
import { lookupPrice } from '../pricing.js'
import { FETCH_MODEL_FAIL_TTL_MS, fetchModelFailMemo, rememberFetchModelFail } from '../remote-device.js'
import { AdminCtx, errorReply, jsonRequestBody, persistConfig, profileRefForProvider, rollbackKeyWrite, sendError, writeKeySlotLocked, type KeyWritePlan } from '../admin-shared.js'
import { t, bi, biCat, biJoin, type Bilingual } from '../../util/i18n.js'

export async function hFetchModels(c: AdminCtx): Promise<void> {
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
    // 多 key 池按序取第一把可读的（单 key 配置即 key_ref，行为不变）
    key = (await getFirstProviderSecret(ref)) ?? ''
    if (!key) return sendError(res, 400, t('已保存的 Key 不可读（未设置或系统安全后端拒绝访问），请手动粘贴 Key 后拉取', 'Saved key unreadable (not set or the OS keychain refused access); paste the key manually and fetch again'))
  }
  const proto = (b.protocol === 'openai' || b.protocol === 'responses') ? b.protocol : 'anthropic'
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return sendError(res, 400, t('请先填写协议接口地址（http/https）', 'Fill in the endpoint URL first (http/https)'))
  if (!key) return sendError(res, 400, t('key 不能为空：请先粘贴 Key 再拉取', 'Key is empty: paste the key before fetching'))
  const provider: import('../../config/types.js').ProviderConfig = {
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
  // 失败负缓存见 fetchModelFailMemo：改过 Key / 地址就是新的 memo 键，不受缓存影响。
  // 键含明文 Key 不做哈希/指纹：进程内存态、不落盘不进日志（remote-device.ts fetchModelFailMemo），
  // 与 config/secrets 同内存信任域——哈希 password 类值反而触发 CodeQL insufficient-password-hash
  const failKey = `${proto}|${baseUrl}|${key}`
  let cachedFail = false
  try {
    const recentFail = fetchModelFailMemo.get(failKey)
    if (recentFail && Date.now() - recentFail.at < FETCH_MODEL_FAIL_TTL_MS) {
      cachedFail = true
      throw new Error(recentFail.msg)
    }
    const f = await fetchModelIds(provider)
    let arr: { id: string; display: string; context_window: number | null; max_output: number | null; capabilities: string[] }[] = f.ids.map((id: string) => {
      // 填充链：上游响应自带值 > 内置表 > models.dev 目录（按 base_url host 精确匹配优先）；
      // 能力=上游已表态（含 []=明确无视觉）优先，未表态落内置表
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

export async function hServiceAdd(c: AdminCtx): Promise<void> {
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

export async function hSwitch(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  try {
    // 一次整包落盘完成 active_profile + 人工钉定主服务（人为修改优先于定时窗口与自动选路），默认路由同步跟随
    // 最后一次人工选择；钉定持续到「当前」选回「自动 · X」（清除 auto_route_provider），期间定时窗口让位。
    // auto_failover 不传内存值（审计 P-04）：由回调取盘上现值，rt.config 陈旧时不回写覆盖 CLI 的改动
    const profileName = await switchToServiceWithRoute(String(b.service ?? ''))
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

export async function hAutoRoute(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  try {
    // 部分更新语义：未传字段保持现状（enabled 缺省=保持盘上现值，见下方 setAutoRoute 注）；其余字段由 UI 各自独立调用
    const enabled = b.enabled === undefined
      ? undefined
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
      r.enabled ? bi('开启', 'on') : bi('关闭', 'off'),
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

export async function hSchedule(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 定时切换：整体替换 {enabled, windows}。窗口按配置顺序取首个命中；空 windows = 清除
  const b = await jsonRequestBody(req)
  const enabled = b.enabled !== false
  if (b.windows !== undefined && !Array.isArray(b.windows)) {
    return sendError(res, 400, t('windows 应为数组', 'windows must be an array'))
  }
  const windows: import('../../config/types.js').ScheduleWindow[] = []
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
    // 窗口模式：avoid（避开该服务）或缺省 prefer（优先走该服务/模型）；avoid 服务粒度语义见 config/types.ts ScheduleWindow 注
    const mode = w.mode === undefined || w.mode === null || w.mode === '' ? undefined : String(w.mode).trim()
    if (mode !== undefined && mode !== 'prefer' && mode !== 'avoid') {
      return sendError(res, 400, t('时段模式「{mode}」无效，应为 prefer（优先走）或 avoid（避开）', 'Window mode "{mode}" is invalid; expected prefer or avoid', { mode }))
    }
    const avoid = mode === 'avoid'
    // 生效日类型（workday/weekend/holiday 定义与缺省语义见 config/types.ts ScheduleWindow 注）
    const dayFilterRaw = w.dayFilter === undefined || w.dayFilter === null || w.dayFilter === '' ? undefined : String(w.dayFilter).trim()
    if (dayFilterRaw !== undefined && dayFilterRaw !== 'any' && dayFilterRaw !== 'workday' && dayFilterRaw !== 'weekend' && dayFilterRaw !== 'holiday') {
      return sendError(res, 400, t('生效日类型「{v}」无效，应为 any / workday / weekend / holiday', 'Day filter "{v}" is invalid; expected any / workday / weekend / holiday', { v: dayFilterRaw }))
    }
    const dayFilter = !dayFilterRaw || dayFilterRaw === 'any' ? undefined : (dayFilterRaw as 'workday' | 'weekend' | 'holiday')
    let days: number[] | undefined
    if (Array.isArray(w.days)) {
      const set = new Set<number>()
      for (const d of w.days as unknown[]) {
        // 仅接受 number：Number(true)===1 曾把布尔 true 静默落成「周一」（ttl_minutes 同型强转，rev-server-night）
        const n = typeof d === 'number' ? d : NaN
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
    const g: import('../../config/types.js').GatewayConfig = { ...(c.gateway ?? {}) }
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

export async function hHolidaysCn(c: AdminCtx): Promise<void> {
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

export async function hImportDetect(c: AdminCtx): Promise<void> {
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
      // protocol/models/keyNote 供导入预览（勾选后先展示将创建的服务/路由再确认）
      protocol: c.protocol,
      hasKey: !!c.key,
      keyNote: c.key_note,
      models: c.models?.length ? c.models : undefined,
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

export async function hImportApply(c: AdminCtx): Promise<void> {
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

export async function hImportDismiss(c: AdminCtx): Promise<void> {
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

export async function hServiceUpdate(c: AdminCtx): Promise<void> {
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
  // Key 比对走 providerKeyRefs 全量解析（keys 池优先、key_ref 回落，与转发取 key 同口径）：
  // 池 provider 只比 key_ref 会漏掉池内其他 key 的重复（2026-11-04 审查 P1）
  const hasNewKey = typeof b.key === 'string' && !!b.key
  // 旧 key 只在去重校验真正需要时才读（keychain 后端每次读取要 spawn security 子进程，
  // 实测 40ms+）：纯改名/改模型目录等无关编辑（地址未变且未提交新 key）不再无谓付一次
  // 钥匙环读取——每次保存都慢一截的最稳定成分。比对走 providerKeyRefs 全量解析（keys 池
  // 优先、key_ref 回落，与转发取 key 同口径），单 key 配置等价于单元素池
  const urlChanged = !!baseUrl && normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(p.base_url)
  const currentKeys = hasNewKey || urlChanged ? (await resolveProviderKeys(providerKeyRefs(p))).map((e) => e.key) : []
  const effectiveKey = hasNewKey ? (b.key as string) : (currentKeys[0] ?? '')
  const keyChanged = hasNewKey && !currentKeys.includes(b.key as string)
  if ((urlChanged || keyChanged) && effectiveKey) {
    const norm = normalizeBaseUrl(baseUrl || p.base_url)
    for (const [pid, other] of Object.entries(rt.config.providers)) {
      if (pid === id) continue
      if (normalizeBaseUrl(other.base_url) !== norm) continue
      const otherKeys = (await resolveProviderKeys(providerKeyRefs(other))).map((e) => e.key)
      if (otherKeys.includes(effectiveKey)) {
        return sendError(res, 400, t('该地址与已有服务「{id}」重复（同地址同 Key）；同地址不同 API Key 可分别保存', 'This URL duplicates existing service "{id}" (same URL and key); the same URL with different API keys can coexist', { id: pid }))
      }
    }
  }
  let newEndpoints: Partial<Record<import('../../config/types.js').Protocol, string>> | undefined
  if (b.endpoints && typeof b.endpoints === 'object' && !Array.isArray(b.endpoints)) {
    const e: Partial<Record<import('../../config/types.js').Protocol, string>> = {}
    for (const [k, v] of Object.entries(b.endpoints)) {
      if (!(k === 'anthropic' || k === 'openai' || k === 'responses')) continue
      if (typeof v !== 'string') continue
      const val = v.trim()
      if (!val) { e[k as import('../../config/types.js').Protocol] = ''; continue }
      if (!/^https?:\/\//i.test(val)) return sendError(res, 400, t('{proto} 协议地址必须以 http:// 或 https:// 开头', 'The {proto} endpoint URL must start with http:// or https://', { proto: k }))
      e[k as import('../../config/types.js').Protocol] = val
    }
    if (Object.keys(e).length) newEndpoints = e
  }
  // Key 写入计划：池 provider（keys 非空）转发恒走 keys 池（providerKeyRefs），只写 key_ref
  // 会「静默无效」——对齐 CLI provider set-key --add：新 key 追加进池（槽位 <id>-k<序号>，
  // 与既有引用去重）；提交的 key 已在池内时零改动（keyChanged=false 走不到这里，幂等）。
  // 单 key 配置保持覆盖 key_ref。仍先配置后密钥（REVIEW-10 同序：persist 失败时密钥未动、
  // 配置由 mutateConfig 原子性保持原状，无半套状态——反序会在配置写失败时留孤儿密钥条目，
  // 2026-11-04 审查 P2）。
  // 审计 F3：槽位不再锁外预生成——计划期只锁「是否写 key」（keyIntent，含计划期池引用快照
  // planPool），具体槽位在 persistConfig 写锁内按盘上最新池态推导（writeKeySlotLocked）：
  // 下方去重校验的钥匙环读取等 await 可达百 ms，锁外推导期间另一并发写者可先落同槽 key，
  // 沿用旧推导会把两个 key 挤进同一槽（后写 setSecret 覆盖先写，先写方丢 key）。
  // 审计 F5：先配置后密钥的残余面由失败回滚收口——setSecret 失败时 rollbackKeyWrite 摘除
  // 刚落的引用再上抛，配置不留「指向无值 ref」的残面（单 key 503 残留）。
  let keyIntent: { key: string; backend: SecretBackend; planPool: string[] } | undefined
  if (hasNewKey && keyChanged) {
    const backend = rt.config.security?.store ?? (await defaultStore())
    // 与 setSecret 内部同规：FAKE_HOME 沙箱下外部后端强制落 file，ref 必须按实际后端预生成
    const effBackend: SecretBackend =
      process.env.MODELRDOCK_FAKE_HOME && (backend === 'keychain' || backend === 'secret-service') ? 'file' : backend
    keyIntent = {
      key: b.key as string,
      backend: effBackend,
      planPool: Array.isArray(p.keys) ? p.keys.filter((k): k is string => typeof k === 'string') : [],
    }
  }
  // 模型目录：完整列表替换语义（UI 传全量）。校验：id 非空去重、ctx/out 为正整数；
  // 显示名随模型提交（编辑浮层在 ID 下以副行回显，仅回显与 ID 不同者）
  let newModels: Record<string, import('../../config/types.js').ModelMeta> | undefined
  if (b.models && typeof b.models === 'object' && !Array.isArray(b.models)) {
    newModels = {}
    for (const [rawId, rawMeta] of Object.entries(b.models as Record<string, unknown>)) {
      const mid = rawId.trim()
      if (!mid) continue
      const meta = rawMeta as { display_name?: unknown; context_window?: unknown; max_output?: unknown; capabilities?: unknown }
      const rec: import('../../config/types.js').ModelMeta = { source: 'manual' }
      const prev = p.models?.[mid]
      // 显示名：提交非空且 ≠ ID 才采用；留空/同名保留既有（预设/CLI 写入的权威名不丢）
      const dn = typeof meta?.display_name === 'string' ? meta.display_name.trim() : ''
      if (dn && dn.toLowerCase() !== mid.toLowerCase()) rec.display_name = dn
      else if (prev?.display_name) rec.display_name = prev.display_name
      // 仅接受 number：Number(true)===1 曾把布尔 true 静默落成 context_window=1（ttl_minutes 同型
      // 强转，rev-server-night）；非 number 视为未填，走下方填充链
      const ctx = typeof meta?.context_window === 'number' ? meta.context_window : NaN
      const out = typeof meta?.max_output === 'number' ? meta.max_output : NaN
      if (Number.isFinite(ctx) && ctx > 0 && Number.isInteger(ctx)) rec.context_window = ctx
      if (Number.isFinite(out) && out > 0 && Number.isInteger(out)) rec.max_output = out
      // 用户留空时，用填充链补齐（内置表 → models.dev 目录；拉取时已收的上游值不会走到这里）
      const k = resolveModelMeta(mid)
      if (rec.context_window == null && k?.context_window != null) rec.context_window = k.context_window
      if (rec.max_output == null && k?.max_output != null) rec.max_output = k.max_output
      // 能力：显式提交 > 保留既有 > 内置表推断（如 kimi-k3 自动带 vision）；空数组=清空。
      // 显式空数组且「挡得住东西」（既有值或内置表会给出非空能力）时落盘为 capabilities=[]——
      // 读侧（resolveModelMeta/适配器）把 [] 视为明确无视觉、短路内置表：远程或用户明确说没有，
      // 内部表不得回填（2026-11 用户定则）。挡不住东西（各来源本就为空）时不写，避免目录堆空数组噪音
      const caps = saneCapabilities(meta?.capabilities)
      const nextCaps = caps ?? prev?.capabilities ?? saneCapabilities(k?.capabilities)
      if (nextCaps?.length) rec.capabilities = nextCaps
      else if (caps !== undefined && (prev?.capabilities?.length || k?.capabilities?.length)) rec.capabilities = []
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
  // 模型级容灾映射（同服务内 model→model）：字段缺省=不动（与 fallback 链同口径——回填失败的
  // 弹层/旧客户端不带字段时不得整表清空）；显式 null/空表=删除字段；非空表整体过
  // resolveModelFallback（价格闸门双向 ≤5%、自映射/环、目录成员，与 CLI 同一校验口径），
  // ConfigError 经 errorReply 还原 400+hint 信封（fallback 校验同款）
  let mfProvided = false
  let newModelFallback: Record<string, string> | undefined
  if (b.model_fallback !== undefined) {
    mfProvided = true
    try {
      newModelFallback = resolveModelFallback(b.model_fallback, id, {
        models: p.models,
        lookupPrice: (m) => lookupPrice(id, m),
      })
    } catch (e) {
      const r = errorReply(e)
      return sendError(res, r.status, r.message, r.hint)
    }
  }
  // 探针代表模型（probe-model-select）：字段缺省=不动（弹层/旧客户端不带字段不得误清）；
  // 显式空串/null=删除字段（回随服务默认模型）；字符串=须在该服务模型表内（同请求提交了
  // 模型目录替换时按新表校验，防止指到刚被删掉的模型），否则 400 可操作报错
  let pmProvided = false
  let newProbeModel: string | undefined
  if (b.probe_model !== undefined) {
    pmProvided = true
    if (b.probe_model === null || b.probe_model === '') {
      newProbeModel = ''
    } else if (typeof b.probe_model === 'string') {
      const pm = b.probe_model.trim()
      const modelTable = Object.keys(newModels ?? p.models ?? {})
      if (!modelTable.includes(pm)) {
        return sendError(res, 400, t('探针模型「{m}」不在服务「{id}」的模型表中', 'Probe model "{m}" is not in the model list of service "{id}"', { m: pm, id }), t('填该服务模型目录里的模型 ID，或留空恢复跟随默认模型', 'Use a model ID from this service\'s model list, or leave empty to follow the default model'))
      }
      newProbeModel = pm
    } else {
      return sendError(res, 400, t('probe_model 须为模型 ID 字符串或空值', 'probe_model must be a model ID string or empty'))
    }
  }
  // 默认模型基线（persist 前取）：persist 后比对，真变了才触发烤模型客户端同步
  const prevProfName = profileRefForProvider(rt.config, id)
  const prevDefaultModel = prevProfName ? rt.config.profiles[prevProfName]?.default_model : undefined
  let keyWrite: KeyWritePlan | undefined
  await persistConfig(rt, (c) => {
    const t = c.providers[id]
    if (!t) return
    if (name) t.name = name
    if (baseUrl) t.base_url = baseUrl
    if (newProtocol) t.protocol = newProtocol
    // 槽位推导在写锁内按盘上最新态进行（审计 F3，推演见 keyIntent 注）；产出计划供锁外 setSecret 与失败回滚
    if (keyIntent) keyWrite = writeKeySlotLocked(t, id, keyIntent.backend, keyIntent.planPool)
    if (newModels) t.models = newModels
    // 模型级容灾：resolver 返回 undefined（null/空表入参）= 删除字段，非空 = 写归一化映射
    if (mfProvided) {
      if (newModelFallback) t.model_fallback = newModelFallback
      else delete t.model_fallback
    }
    // 探针代表模型（probe-model-select）：显式空 = 删除字段（回随默认模型），非空 = 写指定值；
    // 同请求只替换了模型目录而未提交 probe_model 时，存量指定若已不在新表内顺手清除（悬空
    // 指定读侧虽有回落，落盘不留死值）
    if (pmProvided) {
      if (newProbeModel) t.probe_model = newProbeModel
      else delete t.probe_model
    } else if (newModels && t.probe_model && !Object.keys(newModels).includes(t.probe_model)) {
      delete t.probe_model
    }
    if (newEndpoints) {
      const e = { ...(t.endpoints ?? {}) }
      for (const [k, v] of Object.entries(newEndpoints)) { const kp = k as import('../../config/types.js').Protocol; if (v) e[kp] = v; else delete e[kp] }
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
  // 配置已落盘，锁外补写密钥文本（先配置后密钥，见 keyIntent 注）；失败回滚刚落的引用（审计 F5）
  // 再原样上抛——顶层 errorReply 还原 SecretsError 的 400+hint，配置不留指向无值 ref 的残面
  if (keyWrite && keyIntent) {
    try {
      await setSecret(keyWrite.secretId, keyIntent.key, keyWrite.backend)
    } catch (e) {
      await rollbackKeyWrite(rt, id, keyWrite)
      throw e
    }
  }
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
    keyWrite ? (keyWrite.pool ? bi('Key 已追加进池', 'Key appended to the key pool') : bi('Key 已更新', 'Key updated')) : '',
    newModels ? bi('模型目录 {n} 个', '{n} models', { n: Object.keys(newModels).length }) : '',
    newEndpoints ? bi('端点 {list} 已更新', 'Endpoints {list} updated', { list: Object.keys(newEndpoints).join('/') }) : '',
    typeof b.default_model === 'string' ? bi('默认模型 → {model}', 'Default model → {model}', { model: b.default_model || bi('(清除)', '(cleared)') }) : '',
    Array.isArray(newFallback) ? bi('备用服务 {n} 个', '{n} fallback services', { n: newFallback.length }) : '',
    mfProvided ? bi('模型容灾 {n} 条', '{n} model-fallback entries', { n: newModelFallback ? Object.keys(newModelFallback).length : 0 }) : '',
    ...bakedParts,
  ].filter(Boolean) as Array<Bilingual | ''>
  audit(bi('编辑服务', 'Edit service'), id, changes.length ? biJoin('，', ', ', changes) : bi('无字段变更', 'No fields changed'))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, ...(bakedParts.length ? { resynced: true } : {}) }))
  return
}

export async function hRevealKey(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 按需查看单个服务的已保存 Key（编辑弹窗点 👁 时调用）。Key 不随 overview 批量下发，
  // 只有显式动作才取一份明文：列表/截屏/日志场景不泄漏，Host 白名单 + 同源校验在此入口统一生效
  const b = await jsonRequestBody(req)
  const id = typeof b.id === 'string' ? b.id : ''
  const p = rt.config.providers[id]
  if (!p) return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id }))
  // 多 key 池取第一把可读（编辑弹窗 👁 场景）；全不可读/未配返回 null 走既有「Key 不可读」口径，
  // 不因空 key_ref（池-only 手编配置）抛 SecretsError 打 500
  const key = await getFirstProviderSecret(p)
  audit(bi('查看 Key', 'View key'), id, key ? bi('读取成功', 'Read ok') : bi('Key 不可读（未设置或安全后端拒绝）', 'Key unreadable (not set or the OS keychain refused)'))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, key: key ?? null }))
  return
}

export async function hServiceModelFallback(c: AdminCtx): Promise<void> {
  const { rt, req, res } = c
  // 编辑弹层按需取单个服务的模型容灾映射（reveal-key 同款按需口径：不进 overview 每 5s
  // 轮询载荷；弹层打开时拉一次用于回填，失败时弹层不带 model_fallback 保存，服务端
  // 「字段缺省=不动」兜底，不会整表清空）
  const b = await jsonRequestBody(req)
  const id = typeof b.id === 'string' ? b.id : ''
  const p = rt.config.providers[id]
  if (!p) return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id }))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, id, model_fallback: p.model_fallback ?? null }))
  return
}

export async function hServiceDelete(c: AdminCtx): Promise<void> {
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
  // 顺序不可反，先 config 后删密钥（REVIEW-10，推演见 hServiceUpdate keyWrite 注）
  let removedProfiles: string[] = []
  await persistConfig(rt, (c) => {
    removedProfiles = removeProviderCascade(c, id)
  })
  for (const ref of providerAllKeyRefs(p)) {
    try { await deleteSecret(ref) } catch { /* Key 已不存在则忽略 */ }
  }
  audit(bi('删除服务', 'Delete service'), id, removedProfiles.length ? bi('同时删除路由 {list}', 'Also removed routes {list}', { list: biJoin('、', ', ', removedProfiles) }) : undefined)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, removed: id, profiles: removedProfiles }))
  return
}

export async function hUse(c: AdminCtx): Promise<void> {
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

export async function hProfile(c: AdminCtx): Promise<void> {
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

export async function hKey(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  const provider = typeof b.provider === 'string' ? b.provider : ''
  const key = typeof b.key === 'string' ? b.key : ''
  const p = rt.config.providers[provider]
  if (!provider || !p) {
    return sendError(res, 400, t('provider「{id}」不存在', 'Provider "{id}" not found', { id: provider }))
  }
  if (!key) {
    return sendError(res, 400, t('key 不能为空', 'Key must not be empty'))
  }
  const backend = rt.config.security?.store ?? (await defaultStore())
  // FAKE_HOME 下外部后端强制落 file、ref 按实际后端预生成（同规见 hServiceUpdate keyWrite 注）
  const effBackend: SecretBackend =
    process.env.MODELRDOCK_FAKE_HOME && (backend === 'keychain' || backend === 'secret-service') ? 'file' : backend
  // 提交的 key 已在池内时幂等早退（池写入语义见 hServiceUpdate keyWrite 注）
  const poolKeys = Array.isArray(p.keys) ? p.keys.filter((k): k is string => typeof k === 'string') : []
  const isPool = poolKeys.length > 0
  if (isPool) {
    const currentKeys = (await resolveProviderKeys(providerKeyRefs(p))).map((e) => e.key)
    if (currentKeys.includes(key)) {
      audit(bi('更新密钥', 'Update key'), provider, bi('Key 已在池中，未重复追加', 'Key already in the pool; not appended again'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, pool: true, appended: false }))
      return
    }
  }
  // 槽位推导进写锁内按盘上最新池态重推导（审计 F3，推演见 hServiceUpdate keyIntent 注）；
  // poolKeys 是计划期池引用快照（兜「计划期见池、盘上池被清」的分歧窗口）
  let keyWrite: KeyWritePlan | undefined
  await persistConfig(rt, (cfg) => {
    const t = cfg.providers[provider]
    if (!t) return
    keyWrite = writeKeySlotLocked(t, provider, effBackend, poolKeys)
  })
  if (!keyWrite) {
    // persist 回调空转 = provider 在校验后、持锁写盘前被并发删除：配置未动，不再补写密钥
    // （旧实现此时仍会 setSecret 留孤儿条目），按不存在回应
    return sendError(res, 400, t('provider「{id}」不存在', 'Provider "{id}" not found', { id: provider }))
  }
  // 顺序不可反，先 config 后 secrets（REVIEW-10，推演见 hServiceUpdate keyIntent 注）；
  // setSecret 失败回滚刚落的引用（审计 F5），配置不留指向无值 ref 的残面，原样上抛走顶层 errorReply
  try {
    await setSecret(keyWrite.secretId, key, keyWrite.backend)
  } catch (e) {
    await rollbackKeyWrite(rt, provider, keyWrite)
    throw e
  }
  audit(
    bi('更新密钥', 'Update key'),
    provider,
    keyWrite.pool
      ? bi('已追加进 key 池（存入 {backend}）', 'Appended to the key pool (stored in {backend})', { backend })
      : bi('存入 {backend}', 'Stored in {backend}', { backend })
  )
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, ...(keyWrite.pool ? { pool: true, appended: true } : {}) }))
  return
}

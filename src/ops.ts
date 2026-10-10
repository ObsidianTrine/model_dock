import { randomToken, slugify, t } from './util/index.js'
import { loadConfig, mutateConfig } from './config/store.js'
import { DEFAULT_GATEWAY_PORT, type Config } from './config/types.js'
import { defaultStore, deleteSecret, getSecret, setSecret, parseKeyRef, type SecretBackend } from './config/secrets.js'
import { findPreset, presetModels } from './presets/data.js'
import { fetchModelIds } from './providers/fetch.js'
import { resolveModelMeta } from './providers/resolve.js'
import { saneCapabilities } from './providers/known.js'
import { requireAdapter, getAdapter } from './adapters/registry.js'
import { applyChanges } from './adapters/engine.js'
import type { AttachOptions, PlanResult } from './adapters/types.js'
import { normalizeBaseUrl } from './import/sources.js'
import { gatewayLive, parseFallbackEntry } from './gateway/state.js'
import { noteLocalSwitch } from './sync/state.js'
import {
  listSnapshots,
  matchesSnapshot,
  restoreSnapshot,
  snapshot,
} from './backup/snapshot.js'

/**
 * 面向"用户任务"的操作层：添加服务 / 切换服务 / 接入客户端 / 断开客户端。
 * CLI 与 Web 控制台共用，保证行为（含快照、非侵入语义）一致。
 */

export interface AddServiceResult {
  providerId: string
  profileName: string
  /** 从上游 /v1/models 拉到的模型数（0 表示该上游不支持，已用内置目录兜底） */
  fetched: number
  fetchError?: string
}

/** 添加一个模型服务：key 入库、url/协议按预设自动填好、自动建对应路由、可选设为当前 */
export async function addService(
  presetId: string,
  key: string,
  opts: {
    setActiveIfEmpty?: boolean
    fetch?: boolean
    /** 自定义服务显示名（缺省用预设 label） */
    name?: string
    base_url?: string
    protocol?: import('./config/types.js').Protocol
    endpoints?: Partial<Record<import('./config/types.js').Protocol, string>>
    models?: Record<string, { display_name?: string; context_window?: number; max_output?: number; capabilities?: unknown }>
    /** 指定默认模型（须在最终模型目录内，否则落回第一行）；与 UI 添加表单的 ★ 同义 */
    defaultModel?: string
    /** 故障切换候选链：条目 "<providerId>" 或 "<providerId>:<modelId>"，与 /service/update 同一校验口径 */
    fallback?: string[]
  } = {}
): Promise<AddServiceResult> {
  const preset = findPreset(presetId)
  if (!preset) throw new Error(t('未知服务预设：{id}', 'Unknown service preset: {id}', { id: presetId }))
  if (!key) throw new Error(t('Key 不能为空', 'Key is required'))

  const cfg = await loadConfig()
  const finalBaseUrl = (opts.base_url ?? '').trim() || preset.base_url
  // 自定义预设没有默认地址：地址必须显式提供（与 /service/update 同一口径）
  if (!finalBaseUrl || !/^https?:\/\//i.test(finalBaseUrl)) {
    throw new Error(
      t(
        '接口地址必须以 http:// 或 https:// 开头（照抄厂商文档的 base_url）',
        'Base URL must start with http:// or https:// (copy it from the provider docs)'
      )
    )
  }
  // 重复提交兜底：同地址且同 Key 视为重复（Web 双击的最后一道闸）；
  // 同地址不同 Key 允许——那是"同一厂商多个账号分别登记"的合法场景
  const norm = normalizeBaseUrl(finalBaseUrl)
  for (const [pid, p] of Object.entries(cfg.providers)) {
    if (normalizeBaseUrl(p.base_url) !== norm) continue
    const existingKey = await getSecret(p.key_ref)
    if (existingKey === key) {
      throw new Error(
        t(
          '该服务已存在（「{name}」，同地址同 Key），无需重复添加；切换请用「应用」',
          'This service already exists ("{name}", same URL and key); no need to add it again. To switch, use Apply',
          { name: p.name ?? pid }
        )
      )
    }
  }
  let id = slugify(presetId)
  let n = 2
  while (cfg.providers[id]) id = `${slugify(presetId)}-${n++}`

  const backend: SecretBackend = cfg.security?.store ?? (await defaultStore())
  const keyRef = await setSecret(id, key, backend)
  const userModels = (m: Record<string, { display_name?: string; context_window?: number; max_output?: number; capabilities?: unknown }>) => {
    const out: Record<string, import('./config/types.js').ModelMeta> = {}
    for (const [mid, rec] of Object.entries(m)) {
      if (!mid.trim()) continue
      const caps = saneCapabilities(rec.capabilities)
      out[mid] = {
        display_name: rec.display_name ?? mid,
        context_window: rec.context_window,
        max_output: rec.max_output,
        ...(caps?.length ? { capabilities: caps } : {}),
        source: 'manual' as const,
      }
    }
    return out
  }
  // 合并保留全部：#2 修复——提交的模型只叠加/精修在预设完整目录上，不再整体替换丢模型。
  // 已有 id 保留预设的 display_name、仅覆盖 context/max；新 id 追加。能力：提交了才覆盖（含清空），未提交保留预设值。
  const mergeUserIntoPreset = (
    presetModelsArg: Record<string, import('./config/types.js').ModelMeta> | undefined,
    userM: Record<string, import('./config/types.js').ModelMeta>
  ): Record<string, import('./config/types.js').ModelMeta> => {
    const base = { ...(presetModelsArg ?? {}) }
    for (const [mid, u] of Object.entries(userM)) {
      const ex = base[mid]
      base[mid] = ex
        ? {
            ...ex,
            context_window: u.context_window,
            max_output: u.max_output,
            ...(u.capabilities === undefined ? {} : { capabilities: u.capabilities }),
            source: 'manual' as const,
          }
        : { ...u }
    }
    return base
  }
  const userM = opts.models ? userModels(opts.models) : undefined
  const provider = {
    name: (opts.name ?? '').trim() || preset.label,
    base_url: finalBaseUrl,
    protocol: opts.protocol ?? preset.protocol,
    auth_style: preset.auth_style,
    key_ref: keyRef,
    proxy: preset.needs_proxy ? ('env' as const) : ('direct' as const),
    endpoints: opts.endpoints ?? preset.endpoints ?? undefined,
    models: userM ? mergeUserIntoPreset(presetModels(preset), userM) : presetModels(preset),
  }

  let fetched = 0
  let fetchError: string | undefined
  if (opts.models === undefined && opts.fetch !== false) {
    try {
      const f = await fetchModelIds(provider)
      const models = { ...(provider.models ?? {}) }
      for (const mid of f.ids) {
        if (!models[mid]) {
          // 填充链：上游响应自带值 > 内置表 > models.dev 目录；只补空，不覆盖预设/手填值
          const r = resolveModelMeta(mid, null, { upstream: f.meta?.[mid], baseUrl: provider.base_url })
          models[mid] = {
            display_name: f.display[mid],
            source: 'fetched' as const,
            ...(r?.context_window != null ? { context_window: r.context_window } : {}),
            ...(r?.max_output != null ? { max_output: r.max_output } : {}),
          }
        }
      }
      provider.models = models
      fetched = f.ids.length
    } catch (e) {
      fetchError = (e as Error).message
    }
  }

  // 默认模型：显式指定须在最终目录内，否则落回第一行（与 UI ★ 语义一致）
  const modelIds = Object.keys(provider.models ?? {})
  const explicitDefault = opts.defaultModel && modelIds.includes(opts.defaultModel) ? opts.defaultModel : undefined
  // 故障切换候选链：条目 "<providerId>"（透传）或 "<providerId>:<modelId>"；跳过自身与重复条目
  let fallbackEntries: string[] | undefined
  if (opts.fallback !== undefined) {
    fallbackEntries = []
    const seenIds = new Set<string>()
    for (const raw of opts.fallback) {
      const parsed = parseFallbackEntry(raw)
      if (!parsed) {
        throw new Error(
          t(
            '备用服务条目「{entry}」无效，应为 服务ID 或 服务ID:模型ID',
            'Invalid fallback entry "{entry}"; expected serviceId or serviceId:modelId',
            { entry: String(raw ?? '') }
          )
        )
      }
      if (parsed.providerId === id || seenIds.has(parsed.providerId)) continue
      if (!cfg.providers[parsed.providerId]) {
        throw new Error(
          t(
            '备用服务「{id}」不存在；先添加它，或刷新页面同步最新列表',
            'Fallback service "{id}" does not exist; add it first, or refresh the page to sync the latest list',
            { id: parsed.providerId }
          )
        )
      }
      seenIds.add(parsed.providerId)
      fallbackEntries.push(parsed.model ? `${parsed.providerId}:${parsed.model}` : parsed.providerId)
    }
  }

  const profileName = await mutateConfig((c) => {
    c.providers[id] = provider
    const models = Object.keys(provider.models ?? {})
    const pname = `auto-${id}`
    // 新建路由用显式默认（无则第一行）；已存在的路由仅在显式指定时更新，不覆盖用户既有选择
    if (!c.profiles[pname]) c.profiles[pname] = { name: pname, provider: id, default_model: explicitDefault ?? models[0] }
    else if (explicitDefault) c.profiles[pname].default_model = explicitDefault
    if (fallbackEntries) c.profiles[pname].fallback = fallbackEntries
    if (opts.setActiveIfEmpty && !c.active_profile) c.active_profile = pname
    return pname
  })
  return { providerId: id, profileName, fetched, fetchError }
}

/** 开启/关闭自动路由(故障切换) + 可选的强制服务商/限流切换/自动备用链开关,均持久化到 gateway。默认关闭,用户显式应用才开启。
 *  未传的可选参数（provider/failoverOn429/autoFallback 为 undefined）保持现状不动。 */
export async function setAutoRoute(
  enabled: boolean,
  provider?: string | null,
  failoverOn429?: boolean,
  autoFallback?: boolean
): Promise<{ enabled: boolean; provider?: string }> {
  return mutateConfig((c) => {
    const g = { ...(c.gateway ?? {}), auto_failover: enabled }
    if (provider === null) delete g.auto_route_provider
    else if (provider !== undefined) g.auto_route_provider = provider
    if (failoverOn429 !== undefined) {
      if (failoverOn429) g.failover_status_codes = [429, 503]
      else delete g.failover_status_codes
    }
    if (autoFallback !== undefined) g.auto_fallback = autoFallback
    c.gateway = g
    return { enabled, provider: g.auto_route_provider }
  })
}

/** 「下一个切换」槽人工钉定：主服务不可达时优先切到它（插到备用链首位）；null=恢复按 priority/实测耗时自动排序 */
export async function setRouteNext(providerId: string | null): Promise<string | null> {
  return mutateConfig((c) => {
    const g = { ...(c.gateway ?? {}) }
    if (providerId === null) delete g.route_next
    else {
      if (!c.providers[providerId]) throw new Error(t('服务「{id}」不存在', 'Service "{id}" does not exist', { id: providerId }))
      g.route_next = providerId
    }
    c.gateway = g
    return g.route_next ?? null
  })
}

/** 切换当前使用的服务：优先复用该服务已有的路由，否则自动创建 */
export async function switchToService(providerId: string): Promise<string> {
  const name = await mutateConfig((c) => {
    if (!c.providers[providerId]) throw new Error(t('服务「{id}」不存在', 'Service "{id}" does not exist', { id: providerId }))
    const existing = Object.entries(c.profiles).find(([, p]) => p.provider === providerId)
    if (existing) {
      c.active_profile = existing[0]
      return existing[0]
    }
    const models = Object.keys(c.providers[providerId].models ?? {})
    const name = `auto-${providerId}`
    c.profiles[name] = { name, provider: providerId, default_model: models[0] }
    c.active_profile = name
    return name
  })
  // UI/CLI/云端 agent 三路切换统一在此记时间戳：云端 desired 只在 desired_ts 更新时生效，
  // 防止云端旧指令覆盖本机更新的手动切换（详设 §7.4-5）。未启用同步时静默跳过，不影响切换本职
  await noteLocalSwitch().catch(() => {})
  return name
}

export interface RefreshBakedResult {
  /** 已按新路由重写配置文件的客户端 id */
  refreshed: string[]
  /** 逐客户端的失败原因（不阻断切换本身） */
  warnings: string[]
}

/** 探测某端口是否有存活的 ModelDock 网关（health 端点 1s 内可达）。 */
async function gatewayHealthOk(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_modeldock/health`, { signal: AbortSignal.timeout(1000) })
    return res.ok
  } catch {
    return false
  }
}

/** 写客户端文件的目标网关端口解析。优先级：显式端口 > 生产默认端口的存活网关 > 状态文件里的存活网关 > 配置值 > 默认。
 *  多实例（生产 8687 + dev 8890 等）共用一份配置与单一网关状态文件，状态文件只记录"最后启动的实例"——
 *  若直接采信，dev 实例会把真实客户端文件重写到自己的端口（2026-10-01 用户实测踩中：生产控制台
 *  接入/切换服务后，客户端 detail 恒为 http://127.0.0.1:8890）。网关自身的操作必须显式传 rt.port。 */
async function resolveClientGatewayPort(explicit: number | undefined, cfgPort: number | undefined): Promise<number> {
  if (explicit) return explicit
  if (await gatewayHealthOk(DEFAULT_GATEWAY_PORT)) return DEFAULT_GATEWAY_PORT
  return (await gatewayLive())?.port ?? cfgPort ?? DEFAULT_GATEWAY_PORT
}

/** 全局路由切换后同步"模型烙进客户端文件"的已接入客户端（adapter.bakesModels：dsh / workbuddy / zcode / codex / opencode / mimo）。
 *  这类客户端 attach 时把当时路由的模型列表与默认模型写死在配置里，仅改服务端 active_profile 不会跟随；
 *  这里按新 active_profile 重写一遍（复用 planAttach 管线：快照 + 原子写 + 回读校验，非侵入、只动自己的条目）。
 *  只处理网关模式且跟随全局的客户端：钉定路由的没变、direct/file 模式的目标都是显式的，均不重写。 */
export async function refreshBakedModelClients(opts: { port?: number } = {}): Promise<RefreshBakedResult> {
  const cfg = await loadConfig()
  const port = await resolveClientGatewayPort(opts.port, cfg.gateway?.port)
  const refreshed: string[] = []
  const warnings: string[] = []
  const done = new Set<string>() // 已重写的配置文件路径：共用同一文件的 harness 身份（mimo-code / mimo-desktop 同用 mimocode.jsonc）只写一次
  for (const [id, he] of Object.entries(cfg.harness)) {
    if (he.mode !== 'gateway') continue
    if (he.route && he.route !== 'default') continue // 钉定路由不随全局切换
    const adapter = await getAdapter(id, cfg)
    if (!adapter?.bakesModels) continue
    try {
      const { plan, token } = await planAttach(id, { mode: 'gateway', setDefault: true, gatewayPort: port }, cfg)
      const target = plan.changes[0]?.path
      if (target !== undefined && done.has(target)) {
        // 同一文件刚被另一个 harness 身份刷新过，内容已是新路由，不重复写（也不重复快照/审计）
        refreshed.push(id)
        continue
      }
      const ok = await applyChanges(id, 'attach', plan.changes, { yes: true, quiet: true, redactions: [token] })
      if (!ok) throw new Error(t('写入被取消', 'Write cancelled'))
      await mutateConfig((c) => {
        const entry = c.harness[id]
        if (entry) entry.files = plan.changes.map((ch) => ch.path)
      })
      plan.changes.forEach((ch) => done.add(ch.path))
      refreshed.push(id)
    } catch (e) {
      warnings.push(
        t('{label}（{id}）刷新失败：{err}', 'Failed to refresh {label} ({id}): {err}', {
          label: adapter.label,
          id,
          err: (e as Error).message,
        })
      )
    }
  }
  return { refreshed, warnings }
}

/** 钉定路由后同步单个"烤模型"客户端：按钉定 profile 重跑接入计划（快照 + 原子写，只动自己的条目）。
 *  仅 bakesModels 客户端（dsh/workbuddy/zcode）有实际改动；透明客户端返回空。 */
export async function resyncHarnessToRoute(
  id: string,
  profileName: string,
  opts: { port?: number } = {}
): Promise<RefreshBakedResult> {
  const cfg = await loadConfig()
  const he = cfg.harness[id]
  if (!he || he.mode !== 'gateway') return { refreshed: [], warnings: [] }
  const adapter = await getAdapter(id, cfg)
  if (!adapter?.bakesModels) return { refreshed: [], warnings: [] }
  try {
    const { plan, token } = await planAttach(
      id,
      { mode: 'gateway', profile: profileName, setDefault: true, gatewayPort: await resolveClientGatewayPort(opts.port, cfg.gateway?.port) },
      cfg
    )
    const ok = await applyChanges(id, 'route', plan.changes, { yes: true, quiet: true, redactions: [token] })
    if (!ok) throw new Error(t('写入被取消', 'Write cancelled'))
    await mutateConfig((c) => {
      const entry = c.harness[id]
      if (entry) entry.files = plan.changes.map((ch) => ch.path)
    })
    return { refreshed: [id], warnings: [] }
  } catch (e) {
    return {
      refreshed: [],
      warnings: [
        t('{label}（{id}）同步失败：{err}', 'Failed to sync {label} ({id}): {err}', {
          label: adapter.label,
          id,
          err: (e as Error).message,
        }),
      ],
    }
  }
}

export interface AttachPlan {
  plan: PlanResult
  notes: string[]
  files: { path: string; note?: string }[]
  port: number
  token: string
}

/** 接入计划：只算不改（界面先展示给用户确认，再调 applyAttach）。
 *  gatewayPort：网关侧调用必须显式传 rt.port——缺省时的探测启发式（见 resolveClientGatewayPort）
 *  在多实例下可能解析到另一实例的端口，把客户端文件写到错误地址。 */
export async function planAttach(
  id: string,
  opts: {
    profile?: string
    clientProfiles?: string[]
    mode?: 'gateway' | 'file'
    setDefault?: boolean
    takeoverModels?: boolean
    gatewayPort?: number
  } = {},
  cfg?: Config
): Promise<AttachPlan> {
  cfg = cfg ?? (await loadConfig())
  const adapter = await requireAdapter(id, cfg)
  const port = await resolveClientGatewayPort(opts.gatewayPort, cfg.gateway?.port)
  const profileName = opts.profile ?? cfg.active_profile
  const token = cfg.harness[id]?.token ?? randomToken(`mdk_${id.replace(/-/g, '_')}`)
  const plan = await adapter.planAttach(
    {
      mode: opts.mode ?? 'gateway',
      profile: profileName,
      clientProfiles: opts.clientProfiles,
      gatewayPort: port,
      token,
      setDefault: opts.setDefault,
      takeoverModels: opts.takeoverModels,
    },
    cfg
  )
  return {
    plan,
    notes: plan.notes,
    files: plan.changes.map((ch) => ({ path: ch.path, note: ch.note })),
    port,
    token,
  }
}

export interface AttachOutcome {
  harness: string
  port: number
  token: string
  notes: string[]
  files: string[]
}

export interface RegisterAttachResult {
  /** 非致命提示（如目标 profile 不存在导致映射迁移跳过），CLI 展示、Web 忽略 */
  warnings: string[]
}

/** attach 的收尾登记（CLI 与 Web 共用）：profile 别名/默认模型合并、模型元数据回写、harness 登记项落盘。
 *  供 cmdAttach（确认后）与 applyAttach（静默）调用，消灭双实现。 */
export async function registerAttach(
  id: string,
  plan: PlanResult,
  port: number,
  token: string,
  opts: { profile?: string; clientProfiles?: string[]; mode?: 'gateway' | 'file' } = {}
): Promise<RegisterAttachResult> {
  const cfg0 = await loadConfig()
  const warnings: string[] = []
  await mutateConfig((c) => {
    if (plan.profileUpdates) {
      const pn = opts.profile ?? cfg0.active_profile
      if (pn && c.profiles[pn]) {
        const prof = c.profiles[pn]
        if (plan.profileUpdates.aliases) prof.aliases = { ...prof.aliases, ...plan.profileUpdates.aliases }
        prof.default_model ??= plan.profileUpdates.default_model
      } else if (pn) {
        warnings.push(
          t(
            'profile「{profile}」不存在，映射迁移跳过（先 modeldock profile add）',
            'Profile "{profile}" does not exist; alias migration skipped (run modeldock profile add first)',
            { profile: pn }
          )
        )
      }
    }
    // attach 时从外部目录（dsh 内置 catalog）补全的模型元数据回写
    if (plan.providerModelMeta && c.providers[plan.providerModelMeta.provider]) {
      const target = c.providers[plan.providerModelMeta.provider]
      const models = { ...(target.models ?? {}) }
      for (const [mid, meta] of Object.entries(plan.providerModelMeta.models)) {
        const prev = models[mid]
        models[mid] = {
          ...(prev ?? {}),
          ...meta,
          source: prev?.context_window !== undefined || prev?.max_output !== undefined ? prev.source : 'fetched',
        }
      }
      target.models = models
    }
    c.harness[id] = {
      mode: opts.mode ?? 'gateway',
      route: opts.profile ?? 'default',
      client_profiles: opts.clientProfiles?.length ? opts.clientProfiles : undefined,
      token,
      attached_at: new Date().toISOString(),
      files: plan.changes.map((ch) => ch.path),
      // 记录接入时的网关地址：detach 据此精确匹配，不误删用户其他本地代理配置
      gateway_base: `http://127.0.0.1:${port}`,
    }
  })
  return { warnings }
}

/** 执行接入（界面确认后调用）：展示过的改动落盘 + 快照 + 写 harness 登记项 */
export async function applyAttach(
  id: string,
  opts: {
    profile?: string
    clientProfiles?: string[]
    mode?: 'gateway' | 'file'
    setDefault?: boolean
    takeoverModels?: boolean
    gatewayPort?: number
  } = {}
): Promise<AttachOutcome> {
  const cfg0 = await loadConfig()
  const { plan, port, token, notes } = await planAttach(id, opts, cfg0)
  const ok = await applyChanges(id, 'attach', plan.changes, { yes: true, quiet: true, redactions: [token] })
  if (!ok) throw new Error(t('写入被取消', 'Write cancelled'))
  await registerAttach(id, plan, port, token, opts)
  return { harness: id, port, token, notes, files: plan.changes.map((ch) => ch.path) }
}

export interface DetachOutcome {
  /** true = 直接还原了 attach 前的快照；false = 走 adapter 反向清理 */
  restored: boolean
  snapshotId?: string
  consistent?: boolean
  notes: string[]
  /** 还原前做的保护性快照（撤销本次还原用：modeldock restore <id> <undoSnapshotId>） */
  undoSnapshotId?: string
}

export interface ModeSwitchOutcome {
  harness: string
  mode: 'gateway' | 'direct'
  profile: string
  notes: string[]
  files: string[]
}

/** direct 模式写入客户端文件的值包：按 profile → provider 解析上游端点与真实 Key。
 *  端点按协议选择：anthropic 用 base_url（缺省协议端点），pack 模板的 {base_url_openai} 用 openai 端点。 */
async function directAttachValues(cfg: Config, profileName: string): Promise<NonNullable<AttachOptions['direct']>> {
  const prof = cfg.profiles[profileName]
  if (!prof) throw new Error(t('profile「{profile}」不存在', 'Profile "{profile}" does not exist', { profile: profileName }))
  const providerId = prof.provider
  const provider = cfg.providers[providerId]
  if (!provider) {
    throw new Error(
      t(
        'profile「{profile}」引用的服务「{id}」不存在',
        'Service "{id}" referenced by profile "{profile}" does not exist',
        { profile: profileName, id: providerId }
      )
    )
  }
  const key = await getSecret(provider.key_ref)
  if (!key) {
    throw new Error(
      t(
        '无法直连：服务「{name}」的 Key 不可读（key_ref={keyRef}）；执行 modeldock provider set-key {id} 更新后再试',
        'Cannot switch to direct mode: the key of service "{name}" is unreadable (key_ref={keyRef}); run modeldock provider set-key {id} to update it and try again',
        { name: provider.name ?? providerId, keyRef: provider.key_ref, id: providerId }
      )
    )
  }
  return {
    base_url: provider.endpoints?.anthropic ?? provider.base_url,
    base_url_openai: provider.endpoints?.openai,
    base_url_responses: provider.endpoints?.responses,
    protocol: provider.protocol,
    key,
    auth_style: provider.auth_style,
  }
}

/** 切换客户端接入模式：gateway（经本地网关：钉定路由/别名重写/故障切换）⇄ direct（独立直连：
 *  客户端配置直接写上游 url + 真实 Key，网关挂掉后照常工作，用作救援通道）。
 *  复用 planAttach 管线（diff/快照/原子写/回读校验），只是代入的值不同；两个方向随时可互切，
 *  切回网关只改本地文件、不依赖网关存活（token 存在 config.toml 里跨重启稳定）。 */
export async function switchHarnessMode(
  id: string,
  target: 'gateway' | 'direct',
  opts: { profile?: string; yes?: boolean; port?: number } = {}
): Promise<ModeSwitchOutcome> {
  const cfg = await loadConfig()
  const he = cfg.harness[id]
  if (!he) throw new Error(t('「{id}」尚未接入 ModelDock', '"{id}" is not attached to ModelDock', { id }))
  if (he.mode === 'file') {
    throw new Error(
      t(
        '「{id}」是 file 模式（客户端自管路由），暂不支持切换直连',
        '"{id}" is in file mode (the client manages its own routing); switching to direct mode is not supported yet',
        { id }
      )
    )
  }
  const adapter = await requireAdapter(id, cfg)
  if (target === 'direct' && adapter.id === 'generic-env') {
    throw new Error(
      t(
        'generic（环境变量兜底）不写客户端文件，没有直连形态；直接在 shell 里改用上游环境变量即可',
        'generic (env fallback) does not write client files and has no direct mode; switch to upstream environment variables directly in your shell'
      )
    )
  }
  if (target === 'direct' && adapter.directMode !== true) {
    throw new Error(t('「{label}」暂不支持独立直连', '"{label}" does not support direct mode yet', { label: adapter.label }))
  }
  const profileName =
    opts.profile ?? (he.route && he.route !== 'default' ? he.route : undefined) ?? cfg.active_profile
  if (!profileName || !cfg.profiles[profileName]) {
    throw new Error(
      t(
        '无法确定目标 profile：客户端未钉定路由且未设置 active_profile',
        'Cannot determine the target profile: the client has no pinned route and no active_profile is set'
      ) +
        (opts.profile
          ? t('，或指定的 profile「{profile}」不存在', ', or the specified profile "{profile}" does not exist', {
              profile: opts.profile,
            })
          : '')
    )
  }
  // 网关侧调用时显式传实际端口（opts.port）；CLI 侧走解析启发式（生产默认端口优先，见 resolveClientGatewayPort）
  const port = await resolveClientGatewayPort(opts.port, cfg.gateway?.port)
  const attachOpts: AttachOptions = {
    mode: 'gateway',
    profile: profileName,
    // 沿用 attach 时选定的客户端 profile 范围（如 dsh 只写 desktop），避免模式切换扩写其他端
    clientProfiles: he.client_profiles,
    gatewayPort: port,
    token: he.token ?? randomToken(`mdk_${id.replace(/-/g, '_')}`),
    fromMode: he.mode,
  }
  if (target === 'direct') {
    attachOpts.direct = await directAttachValues(cfg, profileName)
  }
  const plan = await adapter.planAttach(attachOpts, cfg)
  // 快照 operation：→direct 记 'direct'；→gateway 记 'attach'（detach 的还原逻辑按 attach 找"最近一次接管前"）
  const ok = await applyChanges(id, target === 'direct' ? 'direct' : 'attach', plan.changes, {
    yes: opts.yes,
    quiet: opts.yes === true,
    redactions: target === 'direct' ? [attachOpts.direct!.key] : he.token ? [he.token] : [],
  })
  if (!ok) throw new Error(t('写入被取消', 'Write cancelled'))
  await mutateConfig((c) => {
    const entry = c.harness[id]
    if (entry) {
      entry.mode = target
      entry.route = profileName
      entry.files = plan.changes.map((ch) => ch.path)
      entry.attached_at = new Date().toISOString()
      // direct_base：实际写入客户端的直连地址（workbuddy 等按 url 匹配自己条目的客户端做幂等重接用）
      if (target === 'direct') entry.direct_base = plan.writtenBaseUrl ?? attachOpts.direct!.base_url
      else delete entry.direct_base
    }
  })
  return { harness: id, mode: target, profile: profileName, notes: plan.notes, files: plan.changes.map((ch) => ch.path) }
}

/** 断开接入：还原到**本次** attach 前的配置（= 最近一次接入前的那份快照），并清除残留条目。
 *  取「最近一次」而非「最早一次」：最早快照是首次接入前的历史态，一旦拿它还原，用户在接入
 *  期间或断开期间对同一文件做的外部改动（如在 dsh 里删掉的服务商、改过的 key）都会被一并回滚
 *  ——这正是「断开后删掉的服务商被复活」的根因。 */
export async function detachHarness(id: string): Promise<DetachOutcome> {
  const cfg = await loadConfig()
  if (!cfg.harness[id]) throw new Error(t('「{id}」尚未接入 ModelDock', '"{id}" is not attached to ModelDock', { id }))
  const snaps = await listSnapshots(id)
  const attachSnaps = snaps.filter((s) => s.operation === 'attach')
  const notes: string[] = []
  let restored = false
  let snapshotId: string | undefined
  let undoSnapshotId: string | undefined
  let consistent: boolean | undefined

  if (attachSnaps.length > 0) {
    // listSnapshots 最新在前；取最新一份 attach 快照 = 本次接入前的状态。
    // 只回滚本次接入写入的内容，不连带回滚用户在这期间对同一文件做的外部改动。
    const pre = attachSnaps[0]
    const undo = await snapshot(id, 'pre-restore', pre.files.map((f) => f.path))
    await restoreSnapshot(pre)
    consistent = await matchesSnapshot(pre)
    restored = true
    snapshotId = pre.id
    undoSnapshotId = undo.id
    if (attachSnaps.length > 1) {
      notes.push(
        t(
          '共 {count} 次接入记录，已还原到最近一次接入前的状态（快照 {snapshot}）',
          '{count} attach records in total; restored to the state before the most recent attach (snapshot {snapshot})',
          { count: attachSnaps.length, snapshot: pre.id }
        )
      )
    }
  }

  // 兜底清理：连续多次接入没断开时，本次接入前的快照里仍带着上一轮写入的 modeldock 条目
  // （或还原后文件又被外部改过），把仍指向网关的条目清掉
  const cfg2 = await loadConfig()
  const adapter = await getAdapter(id, cfg2)
  if (adapter) {
    const plan = await adapter.planDetach(cfg2)
    if (plan.changes.length > 0) {
      await applyChanges(id, 'detach', plan.changes, { yes: true, quiet: true })
      notes.push(t('已清除指向网关的残留配置', 'Removed leftover config that still pointed to the gateway'))
    }
  }

  await mutateConfig((c) => {
    delete c.harness[id]
  })
  return { restored, snapshotId, consistent, notes }
}

/**
 * 将历史明文 file: 密钥引用迁移到当前平台的安全后端（macOS→Keychain / Linux→Secret Service），
 * 并在迁移成功后从明文文件删除。win32 的 file 后端内部已是 DPAPI 加密，无需迁移；无安全后端
 * 或没有明文引用时为无操作。网关启动时调用一次，单项失败不影响其余、不影响主流程。
 */
export async function migrateSecretsToSecure(): Promise<void> {
  const target = await defaultStore()
  if (target === 'file') return
  const cfg = await loadConfig()
  const providers = cfg.providers ?? {}
  const files = Object.entries(providers).filter(([, p]) => parseKeyRef(p.key_ref ?? '').scheme === 'file')
  if (files.length === 0) return
  let migrated = 0
  for (const [id, p] of files) {
    try {
      const plain = await getSecret(p.key_ref)
      if (plain == null) continue
      const newRef = await setSecret(id, plain, target)
      await mutateConfig((c) => {
        c.providers[id].key_ref = newRef
      })
      await deleteSecret(p.key_ref)
      migrated++
    } catch {
      // 单项失败不阻断其余，留待下次启动重试
    }
  }
  if (migrated > 0) {
    console.log(
      t('✓ 已迁移 {count} 个密钥到安全后端（{backend}）', '✓ Migrated {count} keys to the secure backend ({backend})', {
        count: migrated,
        backend: target,
      })
    )
  }
}

/**
 * 删除 provider 的级联清理（CLI provider rm 与 Web /service/delete 共用，两端口径一致）：
 * 删除引用它的 profile、清 active_profile 与 auto_route_provider，剔除各 profile 的
 * fallback 候选链与定时切换窗口里的悬空条目（"<id>" 与 "<id>:<model>" 两种形态）。
 * 返回被删除的 profile 名列表供调用方提示/审计；钉定保护与密钥删除由调用方负责。
 */
export function removeProviderCascade(c: Config, id: string): string[] {
  const usedBy = Object.entries(c.profiles).filter(([, pr]) => pr.provider === id).map(([k]) => k)
  delete c.providers[id]
  for (const k of usedBy) delete c.profiles[k]
  if (c.active_profile && usedBy.includes(c.active_profile)) delete c.active_profile
  if (c.gateway?.auto_route_provider === id) delete c.gateway.auto_route_provider
  for (const prof of Object.values(c.profiles)) {
    if (prof.fallback?.some((e) => e === id || e.startsWith(`${id}:`))) {
      prof.fallback = prof.fallback.filter((e) => e !== id && !e.startsWith(`${id}:`))
      if (prof.fallback.length === 0) delete prof.fallback
    }
  }
  if (c.gateway?.schedule?.windows?.length) {
    const sched = c.gateway.schedule
    const kept = sched.windows!.filter((w) => w.target.split(':')[0] !== id)
    if (kept.length !== sched.windows!.length) {
      if (kept.length === 0) delete sched.windows
      else sched.windows = kept
    }
  }
  // file 模式客户端自管路由，不沿网关转发：其 route 仅登记痕迹，服务删除后一并清掉，
  // 避免残留指向已删 profile 的悬空引用（删除守卫对 file 模式放行，见 server/service/delete）
  for (const he of Object.values(c.harness ?? {})) {
    if (he.mode === 'file' && he.route && usedBy.includes(he.route)) he.route = 'default'
  }
  return usedBy
}

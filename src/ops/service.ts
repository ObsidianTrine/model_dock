import { slugify, t } from '../util/index.js'
import { loadConfig, mutateConfig, ConfigError } from '../config/store.js'
import type { AuthStyle, ModelMeta, Protocol } from '../config/types.js'
import { defaultStore, getSecret, setSecret, type SecretBackend } from '../config/secrets.js'
import { findPreset, presetModels } from '../presets/data.js'
import { fetchModelIds } from '../providers/fetch.js'
import { resolveModelMeta } from '../providers/resolve.js'
import { saneCapabilities } from '../providers/known.js'
import { priceDiffRatios, priceWithinTolerance } from '../providers/pricing-core.js'
import { normalizeBaseUrl } from '../import/sources.js'
import { parseFallbackEntry } from '../gateway/state.js'

export interface AddServiceResult {
  providerId: string
  profileName: string
  /** 从上游 /v1/models 拉到的模型数（0 表示该上游不支持，已用内置目录兜底） */
  fetched: number
  fetchError?: string
}

/** addService 可选的用户提交模型（Web 添加表单/CLI 底层透传）；值域与 config 的 ModelMeta 兼容 */
export interface AddServiceSubmittedModels {
  [mid: string]: { display_name?: string; context_window?: number; max_output?: number; capabilities?: unknown }
}

/** 输入校验（纯函数，无 I/O）：确定性地址与协议端点。
 *  地址缺省回落预设地址，两端都必须 http(s)；协议端点只认三协议键、非 http(s) 抛错、剔除空串。
 *  非法输入抛可操作双语错误；成功返回归一后的 finalBaseUrl 与 cleanEndpoints。 */
export function validateServiceInput(opts: {
  baseUrl?: string
  presetBaseUrl?: string
  endpoints?: Partial<Record<Protocol, string>>
}): { finalBaseUrl: string; cleanEndpoints: Partial<Record<Protocol, string>> | undefined } {
  const finalBaseUrl = (opts.baseUrl ?? '').trim() || (opts.presetBaseUrl ?? '')
  // 自定义预设没有默认地址：地址必须显式提供（与 /service/update 同一口径）
  if (!finalBaseUrl || !/^https?:\/\//i.test(finalBaseUrl)) {
    throw new Error(
      t(
        '接口地址必须以 http:// 或 https:// 开头（照抄厂商文档的 base_url）',
        'Base URL must start with http:// or https:// (copy it from the provider docs)'
      )
    )
  }
  // 协议端点与 /service/update 同口径校验：只认三协议键、URL 格式、剔除空串
  //（空串会短路 relay 的端点回落：endpoints[proto] 为 '' 时 ?? 不再退 base_url）
  let cleanEndpoints: Partial<Record<Protocol, string>> | undefined
  if (opts.endpoints && typeof opts.endpoints === 'object' && !Array.isArray(opts.endpoints)) {
    const e: Partial<Record<Protocol, string>> = {}
    for (const [k, v] of Object.entries(opts.endpoints)) {
      if (!(k === 'anthropic' || k === 'openai' || k === 'responses')) continue
      if (typeof v !== 'string') continue
      const val = v.trim()
      if (!val) continue
      if (!/^https?:\/\//i.test(val)) {
        throw new Error(t('{proto} 协议地址必须以 http:// 或 https:// 开头', 'The {proto} endpoint URL must start with http:// or https://', { proto: k }))
      }
      e[k as Protocol] = val
    }
    if (Object.keys(e).length) cleanEndpoints = e
  }
  return { finalBaseUrl, cleanEndpoints }
}

/** 数值字段守卫：undefined/null/空串视为未填（落盘时省略该字段）；其余必须是正数，违者给
 *  可操作报错。与 presets/data.ts 的 validateUserPresetEntries 同口径——此前 Web 直通 null
 *  会让 smol-toml 序列化抛原始错误、字符串落成畸形目录。 */
function saneModelNumber(v: unknown, label: string, mid: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new Error(
      t('模型「{id}」的 {label} 必须是正数（当前值：{v}）', 'Model "{id}" {label} must be a positive number (got: {v})', { id: mid, label, v: String(v) })
    )
  }
  return v
}

/** 用户提交模型归一化（纯函数，无 I/O）：空 id 剔除、能力清洗、display_name 缺省回落 id */
function normalizeUserModels(m: AddServiceSubmittedModels): Record<string, ModelMeta> {
  const out: Record<string, ModelMeta> = {}
  for (const [mid, rec] of Object.entries(m)) {
    if (!mid.trim()) continue
    const caps = saneCapabilities(rec.capabilities)
    const cw = saneModelNumber(rec.context_window, 'context_window', mid)
    const mo = saneModelNumber(rec.max_output, 'max_output', mid)
    out[mid] = {
      display_name: rec.display_name ?? mid,
      ...(cw !== undefined ? { context_window: cw } : {}),
      ...(mo !== undefined ? { max_output: mo } : {}),
      ...(caps?.length ? { capabilities: caps } : {}),
      source: 'manual' as const,
    }
  }
  return out
}

/** 模型目录解析（纯函数，无 I/O）：用户提交 = 权威全量目录——添加表单展示即所得，删掉的行不再由
 *  预设目录合并回来（旧叠加语义曾把用户删除的预设模型在保存后复活）；空对象 = 用户删光，合法。
 *  未提交才回落预设目录（服务端预设目录初始化 + 在线拉取兜底仍适用，见 addService）。 */
export function resolveServiceModels(
  userSubmitted: AddServiceSubmittedModels | undefined,
  presetModelsArg: Record<string, ModelMeta> | undefined
): Record<string, ModelMeta> | undefined {
  return userSubmitted ? normalizeUserModels(userSubmitted) : presetModelsArg
}

/** 故障切换候选链校验与归一（纯函数，无 I/O）：条目 "<providerId>" 或 "<providerId>:<modelId>"；
 *  跳过自身与重复条目；非法条目/悬空目标抛可操作双语错误。未提供返回 undefined，空数组原样透传。 */
export function resolveFallbackChain(
  fallback: string[] | undefined,
  ownId: string,
  providers: Record<string, { base_url: string }>
): string[] | undefined {
  if (fallback === undefined) return undefined
  const out: string[] = []
  const seenIds = new Set<string>()
  for (const raw of fallback) {
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
    if (parsed.providerId === ownId || seenIds.has(parsed.providerId)) continue
    if (!providers[parsed.providerId]) {
      throw new Error(
        t(
          '备用服务「{id}」不存在；先添加它，或刷新页面同步最新列表',
          'Fallback service "{id}" does not exist; add it first, or refresh the page to sync the latest list',
          { id: parsed.providerId }
        )
      )
    }
    seenIds.add(parsed.providerId)
    out.push(parsed.model ? `${parsed.providerId}:${parsed.model}` : parsed.providerId)
  }
  return out
}

/** 模型级容灾映射校验与归一（纯函数，无 I/O，查价经 ctx 注入）：
 *  形状（模型ID→模型ID 非空串）、自映射/环、目录成员（目录非空时 source/target 都须在册，防
 *  typo；目录未管理容忍字面量）、价格闸门（两模型 input/output 价差均 ≤5%，查不到价 fail-closed
 *  拒绝并提示补 pricing.json）。违者抛 ConfigError（hint 可操作）。undefined/空表返回 undefined。 */
export interface ModelFallbackCtx {
  /** 该服务的模型目录；缺省/空 = 目录未管理，容忍字面量映射 */
  models?: Record<string, ModelMeta>
  /** 查价注入（USD/百万 token）：返回 null = 查不到价（不猜）。CLI/控制台传 gateway/pricing 的 lookupPrice 绑定 providerId */
  lookupPrice: (model: string) => { input: number; output: number } | null
  /** 价格容差（缺省 0.05 = 双向 5%） */
  tolerance?: number
}

export function resolveModelFallback(
  raw: unknown,
  ownId: string,
  ctx: ModelFallbackCtx
): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(
      t('服务「{id}」的模型容灾映射必须是「模型ID → 模型ID」的表', 'Model fallback map of service "{id}" must be a table of modelId → modelId', { id: ownId }),
      t('每条形如 "glm-5.3-flash" = "glm-5.2"；或删除该字段关闭模型级容灾', 'Each entry looks like "glm-5.3-flash" = "glm-5.2"; or remove the field to disable model-level failover')
    )
  }
  const map: Record<string, string> = {}
  for (const [rawFrom, rawTo] of Object.entries(raw as Record<string, unknown>)) {
    const from = rawFrom.trim()
    const to = typeof rawTo === 'string' ? rawTo.trim() : ''
    if (!from || !to) {
      throw new ConfigError(
        t('服务「{id}」的模型容灾映射条目「{entry}」无效，两侧都必须是非空模型 ID', 'Invalid model fallback entry "{entry}" on service "{id}"; both sides must be non-empty model IDs', { id: ownId, entry: rawFrom }),
        t('每条形如 "glm-5.3-flash" = "glm-5.2"', 'Each entry looks like "glm-5.3-flash" = "glm-5.2"')
      )
    }
    if (from === to) {
      throw new ConfigError(
        t('模型容灾映射不能指向自身（{model}）', 'Model fallback mapping cannot point to itself ({model})', { model: from }),
        t('删除该条目，或改为其他模型 ID', 'Remove the entry, or map it to a different model ID')
      )
    }
    if (ctx.models && Object.keys(ctx.models).length > 0) {
      for (const [role, mid] of [['源', from], ['目标', to]] as const) {
        if (!ctx.models[mid]) {
          throw new ConfigError(
            t('模型容灾{role}模型「{model}」不在服务「{id}」的模型目录中', 'Model fallback {role} model "{model}" is not in the catalog of service "{id}"', { role, model: mid, id: ownId }),
            t('modeldock model list {id} 查看目录；目录未管理的服务可忽略此校验（留空模型目录）', 'Run modeldock model list {id} to inspect the catalog; services without a managed catalog may skip this check (leave the catalog empty)', { id: ownId })
          )
        }
      }
    }
    const fromPrice = ctx.lookupPrice(from)
    const toPrice = ctx.lookupPrice(to)
    if (!fromPrice || !toPrice) {
      const missing = !fromPrice ? from : to
      throw new ConfigError(
        t('无法校验模型容灾价格：{model} 查不到单价（input/output）', 'Cannot validate model fallback pricing: no unit price found for {model} (input/output)', { model: missing }),
        t('在 ~/.modeldock/pricing.json 补充 {model} 的 {{"input": …, "output": …}}（USD/百万 token）后重试', 'Add {{"input": …, "output": …}} (USD per M tokens) for {model} in ~/.modeldock/pricing.json and retry', { model: missing })
      )
    }
    const r = priceDiffRatios(fromPrice, toPrice)
    const tol = ctx.tolerance ?? 0.05
    if (!priceWithinTolerance(fromPrice, toPrice, tol)) {
      const pct = (x: number) => (x === Number.POSITIVE_INFINITY ? '∞' : `${(x * 100).toFixed(1)}%`)
      throw new ConfigError(
        t('模型容灾价格差超限：{from} → {to} input 差 {ri}、output 差 {ro}（上限 {tol}）', 'Model fallback price gap too wide: {from} → {to} input {ri}, output {ro} (limit {tol})', { from, to, ri: pct(r.input), ro: pct(r.output), tol: `${(tol * 100).toFixed(0)}%` }),
        t('选同价位档的模型作容灾目标；确要跨档请直接用 profile 备用链的「服务ID:模型ID」条目显式配置', 'Pick a same-tier fallback model; to cross tiers intentionally, use an explicit "serviceId:modelId" entry in the profile fallback chain instead')
      )
    }
    map[from] = to
  }
  if (!Object.keys(map).length) return undefined
  // 查环：映射图必须无环（传递链 A→B→C 合法，回边 A→B→A 拒绝）
  const visiting = new Set<string>()
  const done = new Set<string>()
  const walk = (cur: string, chain: string[]): void => {
    if (done.has(cur)) return
    if (visiting.has(cur)) {
      throw new ConfigError(
        t('模型容灾映射存在环：{chain}', 'Model fallback mapping contains a cycle: {chain}', { chain: [...chain, cur].join(' → ') }),
        t('去掉构成回边的条目，让映射链单向终止', 'Remove the entry that closes the cycle so every chain terminates')
      )
    }
    visiting.add(cur)
    const next = map[cur]
    if (next) walk(next, [...chain, cur])
    visiting.delete(cur)
    done.add(cur)
  }
  for (const k of Object.keys(map)) walk(k, [])
  return map
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
    protocol?: Protocol
    /** 自定义鉴权方式（缺省用预设 auth_style；仅 CLI 自定义流程会覆盖） */
    auth_style?: AuthStyle
    endpoints?: Partial<Record<Protocol, string>>
    models?: AddServiceSubmittedModels
    /** 指定默认模型（须在最终模型目录内，否则落回第一行）；与 UI 添加表单的 ★ 同义 */
    defaultModel?: string
    /** 故障切换候选链：条目 "<providerId>" 或 "<providerId>:<modelId>"，与 /service/update 同一校验口径 */
    fallback?: string[]
  } = {}
): Promise<AddServiceResult> {
  const preset = findPreset(presetId)
  if (!preset) throw new Error(t('未知服务预设：{id}', 'Unknown service preset: {id}', { id: presetId }))
  if (!key) throw new Error(t('Key 不能为空', 'Key is required'))

  // 输入校验（纯函数）：地址必须 http(s)，协议端点同口径
  const { finalBaseUrl, cleanEndpoints } = validateServiceInput({
    baseUrl: opts.base_url,
    presetBaseUrl: preset.base_url,
    endpoints: opts.endpoints,
  })

  const cfg = await loadConfig()
  // 重复提交兜底：同地址且同 Key 视为重复（Web 双击的最后一道闸）；
  // 同地址不同 Key 允许——那是"同一厂商多个账号分别登记"的合法场景
  const norm = normalizeBaseUrl(finalBaseUrl)
  // 同地址服务并行取 key 比对（keychain 后端每取一次 spawn 一次外部进程，串行 N 次拖慢添加）
  const sameUrl = Object.entries(cfg.providers).filter(([, p]) => normalizeBaseUrl(p.base_url) === norm)
  const sameUrlKeys = await Promise.all(sameUrl.map(([, p]) => getSecret(p.key_ref)))
  for (let i = 0; i < sameUrl.length; i++) {
    if (sameUrlKeys[i] === key) {
      const [pid, p] = sameUrl[i]
      throw new Error(
        t(
          '该服务已存在（「{name}」，同地址同 Key），无需重复添加；切换请用「应用」',
          'This service already exists ("{name}", same URL and key); no need to add it again. To switch, use Apply',
          { name: p.name ?? pid }
        )
      )
    }
  }
  // 服务 ID 取预设短名（slug）派生：历史预设 id 里带协议后缀（deepseek-anthropic），协议已不是服务的区分维度，
  // ID 不该再暴露它；slug 缺省回落原 id（slugify 结果为空时 slugify 自带 'provider' 兜底）
  const idBase = slugify(preset.slug || presetId)
  let id = idBase
  let n = 2
  while (cfg.providers[id]) id = `${idBase}-${n++}`

  const backend: SecretBackend = cfg.security?.store ?? (await defaultStore())
  const keyRef = await setSecret(id, key, backend)

  const provider = {
    name: (opts.name ?? '').trim() || preset.label,
    base_url: finalBaseUrl,
    protocol: opts.protocol ?? preset.protocol,
    auth_style: opts.auth_style ?? preset.auth_style,
    key_ref: keyRef,
    proxy: preset.needs_proxy ? ('env' as const) : ('direct' as const),
    endpoints: cleanEndpoints ?? preset.endpoints ?? undefined,
    models: resolveServiceModels(opts.models, presetModels(preset)),
  }

  let fetched = 0
  let fetchError: string | undefined
  // 只在最终目录为空时才在线补全（预设无目录且用户未提交模型，典型=自定义服务）：
  // 自带完整目录的预设（DeepSeek 等）拉不到只会往成功提示里塞失败说明，拉取入口收敛为用户点「拉取模型」
  if (opts.models === undefined && opts.fetch !== false && !presetModels(preset)) {
    try {
      const f = await fetchModelIds(provider)
      const models = { ...(provider.models ?? {}) }
      for (const mid of f.ids) {
        if (!models[mid]) {
          // 填充链：上游响应自带值 > 内置表 > models.dev 目录；只补空，不覆盖预设/手填值。
          // 上游自带能力（含 []=明确无视觉）落盘；内置表推断的不落盘，保持读时解析
          const upCaps = f.meta?.[mid]?.capabilities
          const r = resolveModelMeta(mid, null, { upstream: f.meta?.[mid], baseUrl: provider.base_url })
          models[mid] = {
            display_name: f.display[mid],
            source: 'fetched' as const,
            ...(r?.context_window != null ? { context_window: r.context_window } : {}),
            ...(r?.max_output != null ? { max_output: r.max_output } : {}),
            ...(upCaps !== undefined ? { capabilities: [...upCaps] } : {}),
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
  const fallbackEntries = resolveFallbackChain(opts.fallback, id, cfg.providers)

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

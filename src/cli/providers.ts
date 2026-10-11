import { confirm, input, password, search, select } from '@inquirer/prompts'
import { readFileSync } from 'node:fs'
import { c, maskSecret, printTable, slugify, t } from '../util/index.js'
import { mutateConfig, loadConfig } from '../config/store.js'
import { removeProviderCascade } from '../ops.js'
import { defaultStore, deleteSecret, getSecret, setSecret, type SecretBackend } from '../config/secrets.js'
import { PRESETS, findPreset, ensurePresetsLoaded, presetModels } from '../presets/data.js'
import { fetchModelIds } from '../providers/fetch.js'
import { resolveModelMeta } from '../providers/resolve.js'
import { refreshCatalog } from '../providers/catalog.js'
import { endpointRisks } from '../gateway/relay.js'
import { exitWithError } from './shared.js'
import { displayPath, modelCatalogCachePath, secretsPath } from '../util/paths.js'

function backendLabel(backend: SecretBackend): string {
  if (backend === 'keychain') return 'macOS Keychain'
  if (backend === 'secret-service') return t('Linux Secret Service 钥匙环', 'Linux Secret Service keyring')
  return process.platform === 'win32'
    ? t('本地加密文件 {f}（DPAPI）', 'Local encrypted file {f} (DPAPI)', { f: displayPath(secretsPath()) })
    : t('本地文件 {f}（0600）', 'Local file {f} (0600)', { f: displayPath(secretsPath()) })
}
import type { AuthStyle, Config, Protocol } from '../config/types.js'
import { loadCfg } from './shared.js'

async function uniqueId(base: string): Promise<string> {
  const cfg = await loadConfig()
  if (!cfg.providers[base]) return base
  let n = 2
  while (cfg.providers[`${base}-${n}`]) n++
  return `${base}-${n}`
}

async function askKey(opts: { key?: string; keyEnv?: string }): Promise<string> {
  if (opts.keyEnv) {
    const v = process.env[opts.keyEnv]
    if (!v) {
      console.error(c.red(t('✗ 环境变量 {v} 未设置', '✗ Environment variable {v} is not set', { v: opts.keyEnv })))
      process.exit(1)
    }
    return v
  }
  if (opts.key === '-') return readFileSync(0, 'utf8').trim() // 约定：--key - 从 stdin 读（避免进 shell history）
  if (opts.key) return opts.key
  return password({ message: t('粘贴 API key（输入不回显）', 'Paste the API key (input is hidden)'), mask: '*' })
}

/** 校验 base_url 是合法 http(s) URL，不合法给可操作报错 */
function requireValidBaseUrl(url: string): void {
  try {
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error('bad')
  } catch {
    exitWithError(t('接口地址不合法：{u}', 'Invalid base URL: {u}', { u: url }), t('必须是完整 URL，含协议头（如 https://api.example.com）', 'Must be a full URL including the scheme (e.g. https://api.example.com)'))
  }
}

/** 合法但有风险的地址（明文 http、本机/内网）打印警告，不阻断 */
function warnEndpointRisks(url: string): void {
  for (const r of endpointRisks(url)) console.error(c.yellow(`⚠ ${r}`))
}

/** 从上游拉取模型列表并合并进模型目录；返回新增数与补齐了元数据的既有条目数。
 *  慢网络 I/O 在 mutateConfig 锁外进行；临界区内只合并 models 字段，不覆盖并发修改的其他字段（key_ref 等）。 */
export async function refreshModelsInto(providerId: string, cfg?: Config): Promise<{ added: number; filled: number }> {
  cfg = cfg ?? (await loadConfig())
  const provider = cfg.providers[providerId]
  if (!provider) throw new Error(t('provider「{id}」不存在', 'provider "{id}" does not exist', { id: providerId }))
  const fetched = await fetchModelIds(provider)
  let added = 0
  let filled = 0
  await mutateConfig((c) => {
    const p = c.providers[providerId]
    if (!p) throw new Error(t('provider「{id}」不存在', 'provider "{id}" does not exist', { id: providerId }))
    const models = { ...(p.models ?? {}) }
    for (const id of fetched.ids) {
      const ex = models[id]
      // 填充链（只补空、不覆盖）：配置已有值 > 上游响应自带 > 内置表 > models.dev 目录
      const r = resolveModelMeta(id, ex ?? null, { upstream: fetched.meta[id], baseUrl: provider.base_url })
      if (!ex) {
        models[id] = {
          display_name: fetched.display[id],
          source: 'fetched',
          ...(r?.context_window != null ? { context_window: r.context_window } : {}),
          ...(r?.max_output != null ? { max_output: r.max_output } : {}),
        }
        added++
      } else if (r && (ex.context_window == null || ex.max_output == null)) {
        const patch: { context_window?: number; max_output?: number } = {}
        if (ex.context_window == null && r.context_window != null) patch.context_window = r.context_window
        if (ex.max_output == null && r.max_output != null) patch.max_output = r.max_output
        if (patch.context_window !== undefined || patch.max_output !== undefined) {
          models[id] = { ...ex, ...patch }
          filled++
        }
      }
    }
    p.models = models
  })
  return { added, filled }
}

export async function cmdProviderAdd(
  presetId: string | undefined,
  opts: { name?: string; baseUrl?: string; protocol?: Protocol; auth?: AuthStyle; key?: string; keyEnv?: string; noFetch?: boolean; yes?: boolean }
): Promise<void> {
  const cfg = await loadCfg()
  ensurePresetsLoaded()
  let preset = presetId ? findPreset(presetId) : undefined
  if (presetId && !preset) {
    console.error(c.red(t('✗ 未知预设「{id}」', '✗ Unknown preset: {id}', { id: presetId })))
    console.error(c.gray(t('可用预设：{list}', 'Available presets: {list}', { list: PRESETS.map((p) => p.id).join(', ') })))
    process.exit(1)
  }

  let baseUrl = opts.baseUrl
  let protocol = opts.protocol
  let authStyle = opts.auth
  let label = opts.name

  if (!preset && !baseUrl) {
    const picked = await search({
      message: t('选择 provider 预设（输入关键词过滤，url 会自动填好）', 'Pick a provider preset (type to filter; the URL is filled in for you)'),
      source: (term) => {
        const kw = (term ?? '').toLowerCase()
        const items = PRESETS.filter((p) => !kw || `${p.label} ${p.vendor} ${p.id}`.toLowerCase().includes(kw)).map(
          (p) => ({ name: `${p.label}  ${c.gray(p.base_url)}`, value: p.id })
        )
        items.push({ name: t('自定义…（手填 url / 协议）', 'Custom… (enter URL / protocol manually)'), value: '__custom__' })
        return Promise.resolve(items)
      },
    })
    if (picked === '__custom__') {
      baseUrl = await input({ message: t('base_url（如 https://api.example.com）', 'base_url (e.g. https://api.example.com)') })
      protocol = (await select({ message: t('协议', 'Protocol'), choices: [
        { name: 'anthropic（/v1/messages）', value: 'anthropic' as Protocol },
        { name: 'openai（/v1/chat/completions）', value: 'openai' as Protocol },
      ] })) as Protocol
      authStyle = (await select({ message: t('鉴权方式', 'Auth style'), choices: [
        { name: t('Bearer（Authorization 头）', 'Bearer (Authorization header)'), value: 'bearer' as AuthStyle },
        { name: 'x-api-key', value: 'x-api-key' as AuthStyle },
      ] })) as AuthStyle
      label = await input({ message: t('显示名称', 'Display name'), default: slugify(baseUrl) })
    } else {
      preset = findPreset(picked)
    }
  }
  if (!preset && !baseUrl) {
    console.error(c.red(t('✗ 未选择预设也未提供 --base-url', '✗ No preset selected and no --base-url given')))
    process.exit(1)
  }
  requireValidBaseUrl(baseUrl ?? preset!.base_url)
  warnEndpointRisks(baseUrl ?? preset!.base_url)

  const id = await uniqueId(slugify(opts.name ?? preset?.slug ?? preset?.id ?? 'custom'))
  const key = await askKey(opts)
  const backend: SecretBackend = cfg.security?.store ?? (await defaultStore())
  const keyRef = await setSecret(id, key, backend)

  try {
    await mutateConfig((c2) => {
      c2.providers[id] = {
        name: label ?? preset?.label ?? id,
        base_url: baseUrl ?? preset!.base_url,
        protocol: (protocol ?? preset?.protocol ?? 'anthropic') as Protocol,
        auth_style: (authStyle ?? preset?.auth_style ?? 'bearer') as AuthStyle,
        key_ref: keyRef,
        proxy: preset?.needs_proxy ? 'env' : 'direct',
        models: preset ? presetModels(preset) : undefined,
      }
    })
  } catch (e) {
    // 配置写入失败：回滚已写入 secret store 的 key，避免留下无引用的孤儿密钥
    await deleteSecret(keyRef).catch(() => {})
    throw e
  }
  console.log(c.green(t('✓ provider「{id}」已添加（key 存入 {b}）', '✓ provider "{id}" added (key stored in {b})', { id, b: backendLabel(backend) })))
  if (preset?.docs_url) console.log(c.gray(t('  获取 key：{u}', '  Get a key: {u}', { u: preset.docs_url })))

  if (!opts.noFetch) {
    try {
      const cfgNow = await loadConfig()
      const { added } = await refreshModelsInto(id, cfgNow)
      const total = Object.keys(cfgNow.providers[id].models ?? {}).length
      console.log(c.green(t('✓ 自动拉取模型：新增 {a} 个，共 {n} 个', '✓ Fetched models automatically: {a} new, {n} total', { a: added, n: total })))
    } catch (e) {
      console.log(c.yellow(t('提示: {m}', 'Hint: {m}', { m: (e as Error).message })))
    }
  }

  if (opts.yes) {
    await ensureProfile(id)
    return
  }
  if (await confirm({ message: t('为它创建同名 profile 并设为默认路由？', 'Create a same-named profile and set it as the default route?') })) {
    await ensureProfile(id)
  }
}

async function ensureProfile(id: string): Promise<void> {
  await mutateConfig((c) => {
    if (!c.profiles[id]) {
      const models = Object.keys(c.providers[id]?.models ?? {})
      c.profiles[id] = { name: c.providers[id]?.name, provider: id, default_model: models[0] }
    }
    c.active_profile = id
  })
  console.log(c.green(t('✓ profile「{id}」已创建并设为默认路由', '✓ profile "{id}" created and set as the default route', { id })))
}

export async function cmdProviderList(): Promise<void> {
  const cfg = await loadCfg()
  const ids = Object.keys(cfg.providers)
  if (ids.length === 0) {
    console.log(c.gray(t('暂无 provider；modeldock provider add 添加', 'No providers yet. Add one: modeldock provider add')))
    return
  }
  // active_profile 解析到其引用的 provider id，`*` 标在服务上（此前误用 profile 名直接比较）
  const activeProvider = cfg.active_profile ? cfg.profiles[cfg.active_profile]?.provider : undefined
  const rows = []
  for (const id of ids) {
    const p = cfg.providers[id]
    const key = await getSecret(p.key_ref)
    rows.push({
      id: id === activeProvider ? `${id} *` : id,
      name: p.name ?? '',
      base_url: p.base_url,
      protocol: p.protocol,
      key: maskSecret(key),
      models: String(Object.keys(p.models ?? {}).length),
    })
  }
  printTable(rows, ['id', 'name', 'base_url', 'protocol', 'key', 'models'])
  console.log(c.gray(t('* = 当前路由（active_profile）指向的服务；key 已脱敏', '* = the service the active route (active_profile) points to; keys are masked')))
}

export async function cmdProviderRm(id: string): Promise<void> {
  const cfg = await loadCfg()
  const p = cfg.providers[id]
  if (!p) {
    console.error(c.red(t('✗ provider「{id}」不存在', '✗ provider "{id}" does not exist', { id })))
    process.exit(1)
  }
  const usedBy = Object.entries(cfg.profiles).filter(([, prof]) => prof.provider === id).map(([k]) => k)
  // 钉定保护：这些 profile 被删除后，钉在上面的 harness.route 会悬空（请求 503），先解除再删。
  // file 模式客户端自管路由、不沿网关转发，删除服务不影响它，不拦截（其 route 随删除一并清掉）。
  const pinnedIds = Object.entries(cfg.harness ?? {})
    .filter(([, he]) => he.route && he.mode !== 'file' && usedBy.includes(he.route))
    .map(([hid]) => hid)
  if (pinnedIds.length > 0) {
    const pinnedProfiles = [...new Set(Object.values(cfg.harness ?? {}).filter((he) => he.mode !== 'file').map((he) => he.route).filter((r): r is string => !!r && usedBy.includes(r)))]
    console.error(c.red(t('✗ 有客户端钉定在引用该服务的路由上（{routes}）：{ids}', '✗ Clients are pinned to routes that reference this provider ({routes}): {ids}', { routes: pinnedProfiles.join('、'), ids: pinnedIds.join(', ') })))
    console.error(c.yellow(t('提示: 先解除钉定（modeldock harness route <id> default），再删除', 'Hint: unpin first (modeldock harness route <id> default), then delete')))
    process.exit(1)
  }
  if (usedBy.length > 0 && !(await confirm({ message: t('profile {list} 引用了它，仍要删除？', 'Profiles {list} reference it. Delete anyway?', { list: usedBy.join(', ') }) }))) return
  await deleteSecret(p.key_ref)
  await mutateConfig((c) => {
    // 与 Web 控制台 /service/delete 共用：连带清理自动路由强制服务、备用链与定时切换窗口
    removeProviderCascade(c, id)
  })
  console.log(c.green(t('✓ provider「{id}」及 key 已删除', '✓ provider "{id}" and its key deleted', { id })))
}

export async function cmdProviderSetKey(
  id: string,
  opts: { key?: string; keyEnv?: string }
): Promise<void> {
  const cfg = await loadCfg()
  const p = cfg.providers[id]
  if (!p) {
    console.error(c.red(t('✗ provider「{id}」不存在', '✗ provider "{id}" does not exist', { id })))
    process.exit(1)
  }
  const key = await askKey(opts)
  const backend: SecretBackend = cfg.security?.store ?? (await defaultStore())
  const keyRef = await setSecret(id, key, backend)
  await mutateConfig((c) => {
    c.providers[id].key_ref = keyRef
  })
  console.log(c.green(t('✓ key 已更新（{b}）；网关热加载后立即生效', '✓ Key updated ({b}); the gateway hot-reloads it immediately', { b: backendLabel(backend) })))
}

// 模型目录

export async function cmdModelList(providerId?: string): Promise<void> {
  const cfg = await loadCfg()
  const ids = providerId ? [providerId] : Object.keys(cfg.providers)
  const rows: Record<string, string>[] = []
  for (const pid of ids) {
    const p = cfg.providers[pid]
    if (!p) {
      console.error(c.red(t('✗ provider「{pid}」不存在', '✗ provider "{pid}" does not exist', { pid })))
      process.exit(1)
    }
    const models = Object.entries(p.models ?? {})
    if (models.length === 0) {
      rows.push({ provider: pid, model: t('(空)', '(empty)'), ctx: '-', out: '-', caps: '-', source: '-' })
      continue
    }
    for (const [mid, meta] of models) {
      rows.push({
        provider: pid,
        model: mid,
        display: meta.display_name ?? '',
        ctx: meta.context_window ? String(meta.context_window) : c.gray('?'),
        out: meta.max_output ? String(meta.max_output) : c.gray('?'),
        caps: (meta.capabilities ?? []).join(','),
        source: meta.source,
      })
    }
  }
  printTable(rows, ['provider', 'model', 'display', 'ctx', 'out', 'caps', 'source'])
  console.log(c.gray(t('ctx=输入上下文 out=最大输出（tokens）；? 未知，可 modeldock model set 修改', 'ctx=input context, out=max output (tokens); ? = unknown, edit with modeldock model set')))
}

export async function cmdModelRefresh(providerId: string): Promise<void> {
  try {
    const cfg = await loadConfig()
    const before = Object.keys(cfg.providers[providerId]?.models ?? {}).length
    const { added, filled } = await refreshModelsInto(providerId)
    const cfgAfter = await loadConfig()
    const total = Object.keys(cfgAfter.providers[providerId]?.models ?? {}).length
    const filledNote = filled > 0 ? t('，补齐上下文/输出 {m} 个', ', filled in context/output for {m}', { m: filled }) : ''
    console.log(c.green(t('✓ 拉取完成：新增 {a} 个（{b} → {n}）{filled}', '✓ Fetch complete: {a} new ({b} → {n}){filled}', { a: added, b: before, n: total, filled: filledNote })))
  } catch (e) {
    exitWithError((e as Error).message, t('modeldock provider list 确认服务 id；或 modeldock model list {id}', 'Confirm the provider id with modeldock provider list, or run modeldock model list {id}', { id: providerId }))
  }
}

export async function cmdModelCatalogRefresh(): Promise<void> {
  if (process.env.MODELRDOCK_DISABLE_CATALOG_FETCH === '1') {
    exitWithError(
      t('模型目录拉取已被环境变量 MODELRDOCK_DISABLE_CATALOG_FETCH 停用', 'Catalog fetching is disabled by the MODELRDOCK_DISABLE_CATALOG_FETCH environment variable'),
      t('去掉该环境变量后重试', 'Remove that environment variable and retry')
    )
  }
  console.log(c.gray(t('正在拉取 models.dev 模型目录…', 'Fetching the models.dev catalog…')))
  const r = await refreshCatalog({ manual: true })
  if (!r.ok) {
    exitWithError(
      t('目录拉取失败：{msg}', 'Catalog fetch failed: {msg}', { msg: r.error ?? 'unknown' }),
      t('可设 MODELRDOCK_CATALOG_URL 换数据源；旧缓存仍生效，展示与补值不受影响', 'Set MODELRDOCK_CATALOG_URL to switch sources; the existing cache still serves display and auto-fill')
    )
  }
  console.log(c.green(t('✓ 目录已更新：{p} 个厂商 / {m} 个模型（缓存 {f}）', '✓ Catalog updated: {p} providers / {m} models (cache: {f})', { p: r.providers, m: r.models, f: displayPath(modelCatalogCachePath()) })))
}

export async function cmdModelSet(
  providerId: string,
  model: string,
  opts: { ctx?: number; maxOut?: number; display?: string; cap?: string }
): Promise<void> {
  // commander 的 Number 解析器对非法输入产出 NaN 且不报错，这里显式校验
  for (const [label, v] of [['--ctx', opts.ctx], ['--max-out', opts.maxOut]] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v <= 0)) {
      exitWithError(t('{l} 必须是正整数（收到：{v}）', '{l} must be a positive integer (got: {v})', { l: label, v }), t('示例：modeldock model set {p} {m} --ctx 200000', 'Example: modeldock model set {p} {m} --ctx 200000', { p: providerId, m: model }))
    }
  }
  await mutateConfig((c) => {
    const p = c.providers[providerId]
    if (!p) throw new Error(t('provider「{id}」不存在', 'provider "{id}" does not exist', { id: providerId }))
    const models = (p.models ??= {})
    const meta = models[model] ?? { source: 'manual' as const }
    if (opts.ctx !== undefined) meta.context_window = opts.ctx
    if (opts.maxOut !== undefined) meta.max_output = opts.maxOut
    if (opts.display !== undefined) meta.display_name = opts.display
    if (opts.cap !== undefined) meta.capabilities = opts.cap.split(',').map((s) => s.trim()).filter(Boolean)
    meta.source = 'manual'
    models[model] = meta
  })
  console.log(c.green(t('✓ {p} / {m} 元数据已更新', '✓ {p} / {m} metadata updated', { p: providerId, m: model })))
}

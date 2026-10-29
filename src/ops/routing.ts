import { t } from '../util/index.js'
import { loadConfig, mutateConfig } from '../config/store.js'
import { noteLocalSwitch } from '../sync/state.js'
import { getAdapter } from '../adapters/registry.js'
import { applyChanges } from '../adapters/engine.js'
import { readTextIfExists } from '../util/fsx.js'
import { displayRouteProvider, type GatewayRuntime } from '../gateway/state.js'
import { planAttach } from './attach.js'
import { resolveClientGatewayPort } from './gateway-port.js'

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

/** 「应用」一站式切换（桌面 /switch 与手机端切换服务的热路径）：active_profile 与 auto_route 一次整包落盘。
 *  语义与 switchToService(id) → setAutoRoute(autoFailover, id) 依次调用完全一致，只是把两次整包
 *  读改写+两次快照合并为一次（known-issues PERF-14 写放大）。noteLocalSwitch 时间戳保护语义不变。 */
export async function switchToServiceWithRoute(providerId: string, autoFailover: boolean): Promise<string> {
  const name = await mutateConfig((c) => {
    if (!c.providers[providerId]) throw new Error(t('服务「{id}」不存在', 'Service "{id}" does not exist', { id: providerId }))
    const existing = Object.entries(c.profiles).find(([, p]) => p.provider === providerId)
    let name = existing?.[0]
    if (!name) {
      const models = Object.keys(c.providers[providerId].models ?? {})
      name = `auto-${providerId}`
      c.profiles[name] = { name, provider: providerId, default_model: models[0] }
    }
    c.active_profile = name
    const g = { ...(c.gateway ?? {}), auto_failover: autoFailover, auto_route_provider: providerId }
    c.gateway = g
    return name
  })
  await noteLocalSwitch().catch(() => {})
  return name
}

export interface RefreshBakedResult {
  /** 已按新路由重写配置文件的客户端 id */
  refreshed: string[]
  /** 逐客户端的失败原因（不阻断切换本身） */
  warnings: string[]
}

/** 全局路由切换后同步"模型烙进客户端文件"的已接入客户端（adapter.bakesModels：dsh / workbuddy / zcode / codex / opencode / mimo / claude-code）。
 *  这类客户端 attach 时把当时路由的模型列表与默认模型写死在配置里，仅改服务端 active_profile 不会跟随；
 *  这里按新 active_profile（或显式 profile，见定时窗口接管）重写一遍（复用 planAttach 管线：快照 + 原子写 +
 *  回读校验，非侵入、只动自己的条目）。只处理网关模式且跟随全局的客户端：钉定路由的没变、direct/file 模式的
 *  目标都是显式的，均不重写。 */
export async function refreshBakedModelClients(opts: { port?: number; profile?: string } = {}): Promise<RefreshBakedResult> {
  const cfg = await loadConfig()
  const port = await resolveClientGatewayPort(opts.port, cfg.gateway?.port)
  const refreshed: string[] = []
  const warnings: string[] = []
  const done = new Set<string>() // 已重写的配置文件路径：共用同一文件的 harness 身份（mimo-code / mimo-desktop 同用 mimocode.jsonc）只写一次
  const fileRegs: { id: string; files: string[] }[] = [] // files 登记循环内只收集，循环外一次批量落盘（known-issues PERF-14 写放大）
  for (const [id, he] of Object.entries(cfg.harness)) {
    if (he.mode !== 'gateway') continue
    if (he.route && he.route !== 'default') continue // 钉定路由不随全局切换
    const adapter = await getAdapter(id, cfg)
    if (!adapter?.bakesModels) continue
    try {
      const { plan, token } = await planAttach(id, { mode: 'gateway', setDefault: true, gatewayPort: port, profile: opts.profile }, cfg)
      const target = plan.changes[0]?.path
      if (target !== undefined && done.has(target)) {
        // 同一文件刚被另一个 harness 身份刷新过，内容已是新路由，不重复写（也不重复快照/审计）
        refreshed.push(id)
        continue
      }
      // 内容一致守卫：目标文件与计划逐字节相同（重接 / 周期自愈 / 重启场景）则不写不快照，
      // 让「基线失效 → 强制校准」类调用在稳态下零副作用
      const before = target !== undefined ? (await readTextIfExists(target)) ?? null : null
      if (target !== undefined && before !== null && plan.changes.length === 1 && plan.changes[0].before !== null && plan.changes[0].after === before) {
        refreshed.push(id)
        continue
      }
      // 计划零改动（如 dsh 等值过滤后的稳态）：无需写盘，也不得用空列表清掉登记的 files
      if (plan.changes.length === 0) {
        refreshed.push(id)
        continue
      }
      const ok = await applyChanges(id, 'attach', plan.changes, { yes: true, quiet: true, redactions: [token] })
      if (!ok) throw new Error(t('写入被取消', 'Write cancelled'))
      fileRegs.push({ id, files: plan.changes.map((ch) => ch.path) })
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
  // files 登记一次批量落盘：客户端文件本身已各自写完，这里只是 config.toml 侧的簿记
  if (fileRegs.length) {
    try {
      await mutateConfig((c) => {
        for (const r of fileRegs) {
          const entry = c.harness[r.id]
          if (entry) entry.files = r.files
        }
      })
    } catch (e) {
      warnings.push(t('客户端文件清单登记失败：{err}', 'Failed to record client file lists: {err}', { err: (e as Error).message }))
    }
  }
  return { refreshed, warnings }
}

/** 确保某服务存在可引用的 profile（定时窗口接管展示路由时重写烤模型客户端需要 profile 名）：
 *  已有指向该服务的 profile 直接复用；没有则仿 switchToService 合成 auto-<id>（默认模型取目录首个），
 *  但不改 active_profile——这是展示层的句柄，不是路由切换。 */
export async function ensureProfileForProvider(providerId: string): Promise<string> {
  return mutateConfig((c) => {
    const existing = Object.entries(c.profiles).find(([, p]) => p.provider === providerId)
    if (existing) return existing[0]
    const models = Object.keys(c.providers[providerId]?.models ?? {})
    const name = `auto-${providerId}`
    c.profiles[name] = { name, provider: providerId, default_model: models[0] }
    return name
  })
}

export interface DisplayRouteSyncResult {
  /** 展示路由是否变化（变化才会重写客户端；首次调用仅记基线不写） */
  changed: boolean
  /** 当前展示路由（服务 id；无法解析时 undefined） */
  route?: string
  refreshed: string[]
  warnings: string[]
}

/** 定时 prefer 窗口接管主候选的跟随机制：窗口边界是请求级时间函数、没有事件可挂，调用方
 *  （网关周期检测）周期性传入 rt 与上次已同步的路由（last.v 就地更新），展示路由变化时把烤模型
 *  客户端按窗口目标服务的目录重写一遍（/model 选择器等静态策划面跟随窗口）。last.route 由调用方
 *  维护——网关启动时初始化为当期路由（避免启动即写）；路由未变为无操作。 */
export async function syncBakedClientsForDisplayRoute(
  rt: GatewayRuntime,
  last: { route?: string },
  opts: { port?: number } = {}
): Promise<DisplayRouteSyncResult> {
  const route = displayRouteProvider(rt)
  if (!route || route === last.route) {
    last.route = route
    return { changed: false, route, refreshed: [], warnings: [] }
  }
  last.route = route
  const profileName = await ensureProfileForProvider(route)
  const r = await refreshBakedModelClients({ port: opts.port, profile: profileName })
  return { changed: true, route, ...r }
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

import { randomToken, t } from '../util/index.js'
import { loadConfig, mutateConfig } from '../config/store.js'
import type { Config } from '../config/types.js'
import { getSecret } from '../config/secrets.js'
import { requireAdapter, getAdapter } from '../adapters/registry.js'
import { applyChanges } from '../adapters/engine.js'
import type { AttachOptions, PlanResult } from '../adapters/types.js'
import {
  listSnapshots,
  matchesSnapshot,
  restoreSnapshot,
  snapshot,
} from '../backup/snapshot.js'
import { resolveClientGatewayPort } from './gateway-port.js'

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
      // 重复 attach 透传已登记的当前模式：direct 客户端被重接（doctor 对 pointing 异常也提示 attach）时，
      // 网关分支需清掉直连遗留的模型映射 env——否则残留钉死模型，表现为「切了路由但模型不变」
      fromMode: cfg.harness[id]?.mode,
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

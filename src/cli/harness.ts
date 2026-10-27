import { confirm } from '@inquirer/prompts'
import { c, maskSecret, t } from '../util/index.js'
import { mutateConfig } from '../config/store.js'
import { switchHarnessMode, resyncHarnessToRoute } from '../ops.js'
import { requireAdapter } from '../adapters/registry.js'
import { applyChanges } from '../adapters/engine.js'
import { detachHarness, planAttach, registerAttach } from '../ops.js'
import {
  getSnapshot,
  listSnapshots,
  matchesSnapshot,
  restoreSnapshot,
  snapshot,
  type SnapshotManifest,
} from '../backup/snapshot.js'
import { exitWithThrown, loadCfg } from './shared.js'

export interface AttachFlags {
  mode?: 'gateway' | 'file'
  profile?: string
  /** 逗号分隔的客户端自身 profile（dsh 的 desktop / web），attach 与登记共用 */
  clientProfile?: string
  setDefault?: boolean
  takeoverModels?: boolean
  yes?: boolean
  /** 显式网关端口：传给 planAttach.gatewayPort，跳过 resolveClientGatewayPort 的 8687 探测启发式
   *  （生产 + dev/沙箱多实例共存时，缺省探测会把客户端文件写到别的实例端口，见 ops.ts 注释） */
  port?: string
}

function splitClientProfiles(v?: string): string[] | undefined {
  const list = v?.split(',').map((s) => s.trim()).filter(Boolean)
  return list && list.length > 0 ? list : undefined
}

/** CLI 接入 = ops.planAttach（预览）→ applyChanges（可交互确认）→ ops.registerAttach（登记）。
 *  与 Web 端 applyAttach 共用 plan/登记逻辑，避免双实现行为分叉。 */
export async function cmdAttach(id: string, opts: AttachFlags): Promise<void> {
  const cfg = await loadCfg()
  const adapter = await requireAdapter(id, cfg)
  const det = await adapter.detect()
  if (!det.installed && id !== 'generic-env') {
    console.error(c.red(t('✗ {id} 未安装或配置文件不存在', '✗ {id} is not installed or its config file is missing', { id: adapter.label })))
    if (det.note) console.error(c.yellow(t('提示: {n}', 'Hint: {n}', { n: det.note })))
    process.exit(1)
  }
  const clientProfiles = splitClientProfiles(opts.clientProfile)
  const { plan, port, token, notes } = await planAttach(
    id,
    {
      profile: opts.profile,
      clientProfiles,
      mode: opts.mode,
      setDefault: opts.setDefault,
      takeoverModels: opts.takeoverModels,
      gatewayPort: opts.port ? Number(opts.port) : undefined,
    },
    cfg
  )
  for (const n of notes) console.log(c.yellow(`· ${n}`))

  const ok = await applyChanges(id, 'attach', plan.changes, { yes: opts.yes, redactions: [token] })
  if (!ok) return

  const { warnings } = await registerAttach(id, plan, port, token, {
    profile: opts.profile,
    clientProfiles,
    mode: opts.mode,
  })
  for (const w of warnings) console.warn(c.yellow(t('提示: {w}', 'Hint: {w}', { w })))

  console.log(c.green(t('✓ {id} 已接入网关 http://127.0.0.1:{port}（token {tok}）', '✓ {id} is now attached to the gateway http://127.0.0.1:{port} (token {tok})', { id: adapter.label, port, tok: maskSecret(token) })))
  console.log(c.gray(t('重启该 harness 后生效；此后切换 provider 无需再改它的配置。', 'Restart this harness to apply. After that, switching providers never touches its config again.')))
}

export async function cmdToken(id: string): Promise<void> {
  const cfg = await loadCfg()
  const he = cfg.harness[id]
  if (!he?.token) {
    console.error(c.red(t('✗ {id} 未被接管（无 token）', '✗ {id} is not attached (no token)', { id })))
    console.error(c.yellow(t('提示: 先 modeldock attach {id}', 'Hint: run modeldock attach {id} first', { id })))
    process.exit(1)
  }
  console.log(he.token)
}

/** 接入后改路由：钉到某 profile（或 default = 恢复跟随全局）。
 *  改 harness.route（网关侧即时生效）；烤模型客户端（dsh/workbuddy/zcode）额外按钉定 profile 重写模型列表。 */
export async function cmdHarnessRoute(id: string, profile?: string): Promise<void> {
  const cfg = await loadCfg()
  const he = cfg.harness[id]
  if (!he) {
    console.error(c.red(t('✗ {id} 未被接管', '✗ {id} is not attached', { id })))
    console.error(c.yellow(t('提示: 先 modeldock attach {id}', 'Hint: run modeldock attach {id} first', { id })))
    process.exit(1)
  }
  if (!profile) {
    // 不带参数 = 只读：显示当前路由
    const routeName = he.route && he.route !== 'default' ? he.route : undefined
    if (routeName) {
      const prof = cfg.profiles[routeName]
      console.log(t('{id} → 已钉到 profile「{p}」（{prov} / {m}）', '{id} → pinned to profile "{p}" ({prov} / {m})', { id, p: routeName, prov: prof?.provider ?? '?', m: prof?.default_model ?? '-' }))
      console.log(c.gray(t('恢复跟随全局：modeldock harness route {id} default', 'Follow the global route again: modeldock harness route {id} default', { id })))
    } else {
      console.log(t('{id} → 跟随全局（active_profile: {ap}）', '{id} → follows the global route (active_profile: {ap})', { id, ap: cfg.active_profile ?? t('未设置', 'not set') }))
      console.log(c.gray(t('钉到固定路由：modeldock harness route {id} <profile>', 'Pin to a fixed route: modeldock harness route {id} <profile>', { id })))
    }
    return
  }
  if (profile !== 'default' && !cfg.profiles[profile]) {
    console.error(c.red(t('✗ profile「{p}」不存在', '✗ profile "{p}" does not exist', { p: profile })))
    console.error(c.gray(t('现有：{list}', 'Existing: {list}', { list: Object.keys(cfg.profiles).join(', ') || t('(无)', '(none)') })))
    console.error(c.yellow(t('提示: modeldock profile add 创建，或 modeldock profile list 查看', 'Hint: create one with modeldock profile add, or list them with modeldock profile list')))
    process.exit(1)
  }
  if (he.mode === 'direct') {
    console.error(c.red(t('✗ {id} 是独立直连模式：更换直连目标请用 modeldock harness direct {id} <profile>', '✗ {id} runs in direct mode. To change its upstream: modeldock harness direct {id} <profile>', { id })))
    process.exit(1)
  }
  if (he.mode === 'file') {
    console.error(c.red(t('✗ {id} 是 file 模式（客户端自管路由），不支持钉定', '✗ {id} runs in file mode (the client manages its own routing) and cannot be pinned', { id })))
    process.exit(1)
  }
  await mutateConfig((c2) => {
    c2.harness[id] = { ...c2.harness[id]!, route: profile }
  })
  console.log(
    profile === 'default'
      ? c.green(t('✓ {id} 已恢复跟随全局（active_profile: {ap}）', '✓ {id} now follows the global route again (active_profile: {ap})', { id, ap: cfg.active_profile ?? t('未设置', 'not set') }))
      : c.green(t('✓ {id} 已钉到 profile「{p}」', '✓ {id} pinned to profile "{p}"', { id, p: profile }))
  )
  // 恢复跟随 = 按 active_profile 重写；透明客户端为空操作
  const syncProfile = profile === 'default' ? cfg.active_profile ?? undefined : profile
  const synced = syncProfile
    ? await resyncHarnessToRoute(id, syncProfile)
    : { refreshed: [], warnings: [] }
  for (const w of synced.warnings) console.warn(c.yellow(t('提示: {w}', 'Hint: {w}', { w })))
  if (synced.refreshed.length) console.log(c.gray(t('· 模型列表已按「{p}」重写，重启该客户端生效', '· Model list rewritten for "{p}". Restart the client to apply', { p: syncProfile! })))
  console.log(c.gray(t('路由在网关侧立即生效（该客户端下一个请求即走新路由）。', "Routes take effect at the gateway immediately — the client's next request already uses the new route.")))
}

/** 切换接入模式：direct（独立直连，写上游 url+真实 Key，网关挂掉不受影响）⇄ gateway（切回网关）。 */
export async function cmdHarnessMode(id: string, mode: 'direct' | 'gateway', profile?: string): Promise<void> {
  const cfg = await loadCfg()
  const he = cfg.harness[id]
  if (!he) {
    console.error(c.red(t('✗ {id} 未被接管', '✗ {id} is not attached', { id })))
    console.error(c.yellow(t('提示: 先 modeldock attach {id}', 'Hint: run modeldock attach {id} first', { id })))
    process.exit(1)
  }
  if (mode === 'direct') {
    if (he.mode === 'direct') {
      console.error(c.red(t('✗ {id} 已是独立直连模式；更换直连目标：modeldock harness direct {id} <profile>', '✗ {id} already runs in direct mode. To change its upstream: modeldock harness direct {id} <profile>', { id })))
      process.exit(1)
    }
    const target = profile ?? (he.route && he.route !== 'default' ? he.route : cfg.active_profile)
    const prof = target ? cfg.profiles[target] : undefined
    const prov = prof ? cfg.providers[prof.provider] : undefined
    console.log(c.yellow(t('即将把 {id} 切换为独立直连：{target}', 'About to switch {id} to direct mode: {target}', { id, target: prov?.name ?? prof?.provider ?? '?' })))
    console.log(c.gray(t('· 上游真实 Key 将明文写入该客户端的配置文件（改前自动快照，可切回）', "· The real upstream key will be written in plain text into this client's config file (auto-backed up before changes; you can switch back)")))
    console.log(c.gray(t('· 此后该客户端不经过网关：无请求日志/熔断切换，模型映射按路由 profile 尽量还原', '· This client will no longer go through the gateway: no request logs or failover; the model list is restored as far as possible from the route profile')))
  }
  try {
    const r = await switchHarnessMode(id, mode, { profile, yes: false })
    console.log(c.green(t('✓ {id} 已切换为{mode}（目标 profile「{p}」）', '✓ {id} switched to {mode} (target profile "{p}")', { id, mode: r.mode === 'direct' ? t('独立直连', 'direct mode') : t('网关接入', 'gateway mode'), p: r.profile })))
    console.log(c.gray(t('重启该客户端后生效。', 'Restart the client to apply.')))
  } catch (e) {
    exitWithThrown(e)
  }
}

/** CLI 断开 = ops.detachHarness（与 Web 端同一实现：还原到本次接入前 + 兜底清理 + 删登记） */
export async function cmdDetach(id: string, opts: { yes?: boolean }): Promise<void> {
  const cfg = await loadCfg()
  if (!cfg.harness[id]) {
    console.error(c.red(t('✗ {id} 未被 ModelDock 接管', '✗ {id} is not attached to ModelDock', { id })))
    process.exit(1)
  }
  const snaps = await listSnapshots(id)
  const attachCount = snaps.filter((s) => s.operation === 'attach').length
  if (!opts.yes) {
    const desc =
      attachCount > 0
        ? t('还原到本次接入前（共 {n} 次接入记录，还原前自动快照）', 'This restores files to their pre-attach state ({n} attach records; an automatic backup runs first)', { n: attachCount })
        : t('反向清理指向网关的配置（无 attach 快照）', 'This removes the gateway-pointing config (no attach backup to restore)')
    const ok = await confirm({ message: t('断开 {id}？{desc}', 'Detach {id}? {desc}', { id, desc }) })
    if (!ok) return
  }
  const r = await detachHarness(id)
  for (const n of r.notes) console.log(c.gray(`· ${n}`))
  if (r.restored) {
    console.log(
      r.consistent
        ? c.green(t('✓ 已还原到接管前状态（快照 {sid}），sha256 校验一致', '✓ Restored to the pre-attach state (backup {sid}); sha256 verified', { sid: String(r.snapshotId) }))
        : c.yellow(t('还原完成，但部分文件与快照不一致（可能在接管后被外部修改过）', 'Restore finished, but some files differ from the backup (they may have been changed externally after attach)'))
    )
    if (r.undoSnapshotId) console.log(c.gray(t('撤销本次还原：modeldock restore {id} {sid}', 'Undo this restore: modeldock restore {id} {sid}', { id, sid: r.undoSnapshotId })))
  }
  console.log(c.green(t('✓ {id} 已从 ModelDock 分离', '✓ {id} is now detached from ModelDock', { id })))
}

export async function cmdRestore(
  id: string,
  snapshotId: string | undefined,
  opts: { list?: boolean; yes?: boolean }
): Promise<void> {
  // id 进路径拼接，先按 slug 规则校验，堵住 ../ 之类的目录遍历
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    console.error(c.red(t('✗ 无效的客户端 id：{id}', '✗ Invalid client id: {id}', { id })))
    process.exit(1)
  }
  const snaps = await listSnapshots(id)
  if (opts.list || !snapshotId) {
    if (snaps.length === 0) {
      console.log(c.gray(t('{id} 暂无快照', '{id} has no backups yet', { id })))
      return
    }
    for (const s of snaps) {
      console.log(`${c.bold(s.id)}  ${c.gray(s.operation)}  ${s.timestamp}  ${t('{n} 个文件', '{n} files', { n: s.files.length })}`)
      for (const f of s.files) console.log(c.gray(`    ${f.path}${f.stored_as ? '' : t('（当时不存在）', ' (did not exist at the time)')}`))
    }
    return
  }
  const m: SnapshotManifest | null = await getSnapshot(id, snapshotId)
  if (!m) {
    console.error(c.red(t('✗ 快照不存在：{sid}', '✗ Backup not found: {sid}', { sid: snapshotId })))
    console.error(c.yellow(t('提示: modeldock restore {id} 查看全部快照', 'Hint: modeldock restore {id} lists all backups', { id })))
    process.exit(1)
  }
  if (!opts.yes) {
    const ok = await confirm({ message: t('还原快照 {sid}（{op}，{ts}）？', 'Restore backup {sid} ({op}, {ts})?', { sid: m.id, op: m.operation, ts: m.timestamp }) })
    if (!ok) return
  }
  const undo = await snapshot(id, 'pre-restore', m.files.map((f) => f.path))
  await restoreSnapshot(m)
  const consistent = await matchesSnapshot(m)
  console.log(
    consistent
      ? c.green(t('✓ 已还原快照 {sid}，sha256 校验一致', '✓ Backup {sid} restored; sha256 verified', { sid: m.id }))
      : c.yellow(t('还原完成，但部分文件与快照不一致', 'Restore finished, but some files differ from the backup'))
  )
  console.log(c.gray(t('撤销本次还原：modeldock restore {id} {sid}', 'Undo this restore: modeldock restore {id} {sid}', { id, sid: undo.id })))
}

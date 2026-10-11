import fs from 'node:fs'
import { confirm, input, password, select } from '@inquirer/prompts'
import { c, t } from '../util/index.js'
import { displayPath } from '../util/paths.js'
import { exportFileName, exportSyncdoc, previewImport, applyImportedDoc } from '../sync/exportImport.js'
import { enrollCloud, setupSyncTarget } from '../sync/setup.js'
import { syncStatus } from '../sync/engine.js'
import { readSyncState, updateSyncState, type SyncTargetConfig } from '../sync/state.js'
import type { SyncdocReport } from '../sync/collect.js'

/** --stdin-pass：口令从 stdin 整读（脚本/CI 用；不进 argv、不进 shell history） */
function readPassStdin(): string {
  const v = fs.readFileSync(0, 'utf8').trim()
  if (!v) {
    console.error(c.red(t('✗ --stdin-pass 已指定但 stdin 未提供口令', '✗ --stdin-pass was given but no passphrase arrived on stdin')))
    process.exit(1)
  }
  return v
}

/** 口令强度提示（非阻断）：加密本身可靠，但低熵口令可被离线暴力猜解——PBKDF2-600k 只是抬高成本，不改变熵 */
export function passphraseHint(pw: string): string | null {
  if (pw.length < 8 || /^\d+$/.test(pw)) {
    return t(
      '○ 口令偏弱（短于 8 位或纯数字）：建议混合字母、数字与符号；口令遗忘则包内容无法恢复',
      '○ Weak passphrase (under 8 chars or all digits): mix letters, digits and symbols; a forgotten passphrase means the package is unrecoverable'
    )
  }
  return null
}

async function askPassTwice(): Promise<string> {
  const a = await password({ message: t('设置同步口令（输入不回显；口令遗忘则包内容无法恢复）', 'Set a sync passphrase (input hidden; a forgotten passphrase means the package is unrecoverable)'), mask: '*' })
  if (!a) {
    console.error(c.red(t('✗ 口令不能为空', '✗ The passphrase must not be empty')))
    process.exit(1)
  }
  const b = await password({ message: t('再输一遍确认', 'Type it again to confirm'), mask: '*' })
  if (a !== b) {
    console.error(c.red(t('✗ 两次输入的口令不一致，未导出。请重跑命令', '✗ The two passphrases do not match; nothing was exported. Re-run the command')))
    process.exit(1)
  }
  const hint = passphraseHint(a)
  if (hint) console.log(c.yellow(hint))
  return a
}

function keyNotes(report: SyncdocReport): void {
  for (const id of report.envKeyRefs) {
    console.log(c.yellow(t('  ○ 服务「{id}」的 key 走环境变量引用，不随包迁移；新机器需自行设置同名环境变量', '  ○ Provider "{id}" references its key via an environment variable; it is not included in the package. Set the same env var on the new machine', { id })))
  }
  for (const id of report.missingKeys) {
    console.log(c.yellow(t('  ○ 服务「{id}」的 key 未随包迁移（导出机上已读取不到）；导入后运行 modeldock provider set-key {id} 补填', '  ○ Provider "{id}" key was not included (unreadable on the exporting machine); run modeldock provider set-key {id} after import', { id })))
  }
}

export async function cmdConfigExport(opts: { out?: string; stdinPass?: boolean }): Promise<void> {
  // 默认名带本地时间（到秒）：固定名会在同目录二次导出时静默覆盖上一个包（旧口令不可恢复）
  const file = opts.out ?? exportFileName()
  const passphrase = opts.stdinPass ? readPassStdin() : await askPassTwice()
  const { report } = await exportSyncdoc(file, passphrase)
  console.log(c.green(t('✓ 已导出：{f}', '✓ Exported: {f}', { f: displayPath(file) })))
  console.log(
    t(
      '  内容：服务 {p} 个、路由 {r} 个、自定义预设 {s} 条、定时规则 {w} 条（key 已明文封入，整包 AES-256-GCM 加密）',
      '  Contents: {p} providers, {r} profiles, {s} custom presets, {w} schedule rules (keys sealed in plaintext; whole package AES-256-GCM encrypted)',
      { p: report.providers.length, r: report.profiles.length, s: report.presetCount, w: report.scheduleRules }
    )
  )
  keyNotes(report)
  console.log(c.gray(t('新电脑导入：modeldock config import <该文件>；同步口令请妥善保管——遗忘则包内容无法恢复', 'To import on a new machine: modeldock config import <file>; keep the passphrase safe — a forgotten passphrase cannot be recovered')))
}

/** 模块顶层禁止求值 t()（会在 initLang 前固化语言），用函数每次现取 */
function untouchedLine(): string {
  return t(
    '  不受影响：各客户端接入状态与配置文件、网关端口与转发设置、当前激活路由、开机自启、请求日志与用量统计',
    '  Untouched: client attach states and their config files, gateway port and forwarding settings, current active route, start-at-login, request logs and usage stats'
  )
}

export async function cmdConfigImport(file: string, opts: { stdinPass?: boolean; yes?: boolean }): Promise<void> {
  const passphrase = opts.stdinPass ? readPassStdin() : await password({ message: t('输入同步口令', 'Enter the sync passphrase'), mask: '*' })
  const { doc, report, meta } = await previewImport(file, passphrase)
  // UTC ISO 截取会差一天（东八区 0-8 点），转本地日期展示
  const d = new Date(meta.createdAt)
  const localDate = Number.isNaN(d.getTime()) ? '?' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  console.log(t('包「{f}」（导出于 {ts}，来自 {by}）将替换以下内容：', 'Package "{f}" (exported {ts} from {by}) will replace:', { f: displayPath(file), ts: localDate, by: meta.createdBy }))
  console.log(t('  服务 {p} 个：{ids}', '  Providers ({p}): {ids}', { p: report.providers.length, ids: report.providers.join(', ') || t('（无）', '(none)') }))
  console.log(t('  路由 {r} 个：{ids}', '  Profiles ({r}): {ids}', { r: report.profiles.length, ids: report.profiles.join(', ') || t('（无）', '(none)') }))
  console.log(t('  自定义预设 {s} 条、定时规则 {w} 条', '  Custom presets: {s}; schedule rules: {w}', { s: report.presetCount, w: report.scheduleRules }))
  keyNotes(report)
  console.log(untouchedLine())
  if (!opts.yes) {
    const ok = await confirm({ message: t('确认导入并替换以上内容？', 'Import and replace the above?'), default: false })
    if (!ok) {
      console.log(c.gray(t('已取消，未做任何改动', 'Cancelled; nothing was changed')))
      return
    }
  }
  const applied = await applyImportedDoc(doc)
  console.log(
    c.green(
      t('✓ 已导入：服务 {p}、路由 {r}、预设 {s}、定时规则 {w}；key 按本机存储重存 {k} 条', '✓ Imported: {p} providers, {r} profiles, {s} presets, {w} schedule rules; {k} keys re-stored into local storage', {
        p: applied.providers.length,
        r: applied.profiles.length,
        s: applied.presetCount,
        w: applied.scheduleRules,
        k: applied.keysRestored ?? 0,
      })
    )
  )
  keyNotes(applied)
  console.log(c.gray(t('改动前已自动快照到 backups/config/。网关运行中则配置热加载立即生效；自定义预设需重启网关后生效', 'A pre-change snapshot was saved to backups/config/. With the gateway running, config changes hot-reload immediately; custom presets take effect after a gateway restart')))
}

// M2：多机自动同步（docs/design-cloud-sync.md §6）

async function askTargetConfig(o: { target?: string; url?: string; dir?: string; username?: string; password?: string }): Promise<SyncTargetConfig> {
  let kind = o.target
  if (kind && kind !== 'webdav' && kind !== 'localdir') {
    console.error(c.red(t('✗ --target 只支持 webdav 或 localdir，收到：{v}', '✗ --target accepts webdav or localdir only; got: {v}', { v: kind })))
    process.exit(1)
  }
  if (!kind) {
    kind = await select({
      message: t('同步目标类型', 'Sync target type'),
      choices: [
        { value: 'webdav', name: t('WebDAV 网盘（坚果云 / Nextcloud / 群晖…）', 'WebDAV drive (Jianguoyun / Nextcloud / Synology…)') },
        { value: 'localdir', name: t('本地同步盘目录（iCloud / OneDrive…）', 'Local sync-folder directory (iCloud / OneDrive…)') },
      ],
    })
  }
  if (kind === 'webdav') {
    const url = o.url ?? (await input({ message: t('WebDAV 地址（如 https://dav.jianguoyun.com/dav/）', 'WebDAV URL (e.g. https://dav.jianguoyun.com/dav/)') })).trim()
    if (!url) {
      console.error(c.red(t('✗ WebDAV 地址不能为空', '✗ The WebDAV URL must not be empty')))
      process.exit(1)
    }
    const dir = (o.dir ?? (await input({ message: t('网盘内子目录名', 'Subfolder name inside the drive'), default: 'modeldock' }))).trim()
    const username = (o.username ?? (await input({ message: t('WebDAV 用户名（坚果云用登录邮箱）', 'WebDAV username (for Jianguoyun, your login email)') }))).trim()
    const pwd = o.password ?? (await password({ message: t('WebDAV 密码 / 应用密码', 'WebDAV password / app password'), mask: '*' }))
    if (!username || !pwd) {
      console.error(c.red(t('✗ WebDAV 用户名与密码不能为空', '✗ WebDAV username and password must not be empty')))
      process.exit(1)
    }
    return { kind: 'webdav', url, dir, username, password: pwd }
  }
  const dir = (o.dir ?? (await input({ message: t('本地同步盘目录（如 ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/modeldock）', 'Local sync-folder directory (e.g. ~/Library/Mobile Documents/... for iCloud Drive)') }))).trim()
  if (!dir) {
    console.error(c.red(t('✗ 目录不能为空', '✗ The directory must not be empty')))
    process.exit(1)
  }
  return { kind: 'localdir', dir }
}

export async function cmdSyncSetup(o: { target?: string; url?: string; dir?: string; username?: string; password?: string; stdinPass?: boolean }): Promise<void> {
  const targetCfg = await askTargetConfig(o)
  const passphrase = o.stdinPass ? readPassStdin() : await askPassTwice()
  console.log(t('正在连接同步目标并初始化…', 'Connecting to the sync target and initializing…'))
  const r = await setupSyncTarget(targetCfg, passphrase)
  const label = targetCfg.kind === 'webdav' ? `${targetCfg.url}${targetCfg.dir ? '/' + targetCfg.dir : ''}` : displayPath(targetCfg.dir)
  if (r.joined) {
    console.log(c.green(t('✓ 已加入多机同步：{label}（已应用其他机器的第 {rev} 版配置）', '✓ Joined multi-machine sync: {label} (applied the other machine\'s config, rev {rev})', { label, rev: r.rev })))
  } else {
    console.log(c.green(t('✓ 多机同步已启用：{label}（本机配置已作为第 1 版推送）', '✓ Multi-machine sync enabled: {label} (this machine\'s config pushed as rev 1)', { label })))
    keyNotes(r.report!)
  }
  console.log(
    t(
      '  其他机器：安装 modeldock 后运行 modeldock sync setup，选同一目标并输入同一口令，即可自动收敛。改动自动双向同步；运行中的网关数秒内开始同步',
      '  On other machines: install modeldock, run modeldock sync setup with the same target and passphrase to converge automatically. Changes sync both ways; running gateways pick it up within seconds'
    )
  )
  console.log(c.gray(t('  同步口令请妥善保管——遗忘后已同步的密文无法恢复。暂停/恢复：modeldock sync pause | resume', '  Keep the sync passphrase safe — if forgotten, the synced ciphertext cannot be recovered. Pause/resume: modeldock sync pause | resume')))
}

export async function cmdSyncStatus(): Promise<void> {
  const s = await syncStatus()
  if (s.mode === 'off') {
    console.log(t('多机同步未启用。配置：modeldock sync setup', 'Multi-machine sync is off. Set it up: modeldock sync setup'))
    if (s.lastError) console.log(c.yellow(t('  ⚠ sync.json 异常：{err}', '  ⚠ sync.json problem: {err}', { err: s.lastError })))
    return
  }
  const stateLine = s.paused
    ? t('已暂停（modeldock sync resume 恢复）', 'Paused (modeldock sync resume to continue)')
    : s.running
      ? t('运行中', 'Running')
      : t('等待网关接管（网关运行中则数秒内自动开始）', 'Waiting for the gateway (starts within seconds once it runs)')
  console.log(t('多机同步 · {state}', 'Multi-machine sync · {state}', { state: stateLine }))
  console.log(t('  目标：{kind} · {label}', '  Target: {kind} · {label}', { kind: String(s.targetKind), label: String(s.targetLabel) }))
  console.log(t('  本机设备：{devid}', '  This device: {devid}', { devid: String(s.devid ?? '?') }))
  console.log(t('  已同步到第 {rev} 版', '  Synced to rev {rev}', { rev: s.lastAppliedRev ?? 0 }))
  if (s.lastPushTs) console.log(t('  最近推送：{ts}', '  Last push: {ts}', { ts: String(s.lastPushTs) }))
  if (s.lastPullTs) console.log(t('  最近拉取：{ts}', '  Last pull: {ts}', { ts: String(s.lastPullTs) }))
  if (s.lastConflictTs) console.log(c.yellow(t('  最近冲突：{ts}（本机当时改动已快照到 backups/ 目录）', '  Last conflict: {ts} (the local changes were snapshotted into the backups/ folder)', { ts: String(s.lastConflictTs) })))
  if (s.lastError) console.log(c.red(t('  最近错误：{err}', '  Last error: {err}', { err: String(s.lastError) })))
}

export async function cmdSyncPause(): Promise<void> {
  const st = await readSyncState()
  if (!st || st.mode !== 'target') {
    console.error(c.red(t('✗ 多机同步未启用，无需暂停。配置：modeldock sync setup', '✗ Multi-machine sync is off; nothing to pause. Set it up: modeldock sync setup')))
    process.exit(1)
  }
  if (st.paused) {
    console.log(t('多机同步本来就是暂停状态', 'Multi-machine sync is already paused'))
    return
  }
  await updateSyncState({ paused: true })
  console.log(c.green(t('✓ 已暂停多机同步（网关运行中则数秒内生效）。恢复：modeldock sync resume', '✓ Multi-machine sync paused (takes effect within seconds on a running gateway). Resume: modeldock sync resume')))
}

export async function cmdSyncResume(): Promise<void> {
  const st = await readSyncState()
  if (!st || st.mode !== 'target') {
    console.error(c.red(t('✗ 多机同步未启用。配置：modeldock sync setup', '✗ Multi-machine sync is off. Set it up: modeldock sync setup')))
    process.exit(1)
  }
  if (!st.paused) {
    console.log(t('多机同步不在暂停状态', 'Multi-machine sync is not paused'))
    return
  }
  await updateSyncState({ paused: false, lastError: null })
  console.log(c.green(t('✓ 已恢复多机同步（网关运行中则数秒内生效）', '✓ Multi-machine sync resumed (takes effect within seconds on a running gateway)')))
}

/** M3 云端入网（详设 §7.5）：一次性配对码 + 同步口令 */
export async function cmdSyncEnroll(o: { server?: string; code?: string; name?: string; stdinPass?: boolean }): Promise<void> {
  const server = (o.server ?? (await input({ message: t('云端服务器地址（如 http://203.0.113.10:18443）', 'Cloud server URL (e.g. http://203.0.113.10:18443)') }))).trim()
  if (!server) {
    console.error(c.red(t('✗ 服务器地址不能为空', '✗ The server URL must not be empty')))
    process.exit(1)
  }
  const code = (o.code ?? (await input({ message: t('配对码（在云端控制台生成，形如 XXXX-XXXX）', 'Pair code (generated in the cloud console, e.g. XXXX-XXXX)') }))).trim()
  if (!code) {
    console.error(c.red(t('✗ 配对码不能为空', '✗ The pair code must not be empty')))
    process.exit(1)
  }
  const passphrase = o.stdinPass ? readPassStdin() : await askPassTwice()
  console.log(t('正在配对并初始化…', 'Pairing and initializing…'))
  const r = await enrollCloud(server, code, passphrase, o.name ? { deviceName: o.name } : undefined)
  if (r.joined) {
    console.log(c.green(t('✓ 已入网：{server}（已应用云端第 {rev} 版配置）', '✓ Enrolled: {server} (applied the cloud config, rev {rev})', { server, rev: r.rev })))
  } else {
    console.log(c.green(t('✓ 已入网：{server}（本机配置已作为第 1 版推送）', '✓ Enrolled: {server} (this machine\'s config pushed as rev 1)', { server })))
    keyNotes(r.report!)
  }
  console.log(
    t(
      '  手机/其他浏览器打开云端控制台即可查看本机状态并远程切换服务（心跳 {n}s，切换分钟级生效）。本机手动切换始终优先于云端旧指令',
      '  Open the cloud console on your phone or any browser to see this machine and switch services remotely (heartbeat {n}s; switches take effect within minutes). Local manual switches always take precedence over stale cloud commands',
      { n: 60 }
    )
  )
  console.log(c.gray(t('  同步口令请妥善保管——遗忘后云端密文无法恢复。暂停/恢复：modeldock sync pause | resume', '  Keep the sync passphrase safe — if forgotten, the cloud ciphertext cannot be recovered. Pause/resume: modeldock sync pause | resume')))
}

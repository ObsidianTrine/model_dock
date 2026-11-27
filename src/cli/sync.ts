import fs from 'node:fs'
import path from 'node:path'
import { checkbox, confirm, input, password, select } from '@inquirer/prompts'
import { request } from 'undici'
import { c, t } from '../util/index.js'
import { displayPath, homeDir } from '../util/paths.js'
import { loadConfig, mutateConfig } from '../config/store.js'
import { exportFileName, exportSyncdoc, previewImport, applyImportedDoc } from '../sync/exportImport.js'
import { filterMergedDoc, makeVerdictFinder, mergePackages, type MergeCandidate, type MergeSuggestion } from '../sync/merge.js'
import { replayProbeVerdicts } from '../gateway/probe/verdict.js'
import type { GatewayRuntime, ProbeVerdict, ProbeVerdictState } from '../gateway/state/types.js'
import { gatewayLive } from '../gateway/state/state-file.js'
import { enrollCloud, setupSyncTarget } from '../sync/setup.js'
import { syncStatus, type SyncStatusView } from '../sync/engine.js'
import { readSyncState, updateSyncState, type SyncTargetConfig } from '../sync/state.js'
import { collectAssetFiles, normalizeAssetDir } from '../sync/assets.js'
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
  const applied = await applyImportedDoc(doc, { log: (line) => console.log(c.yellow(line)) })
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

// ── 多包合并流（provider-probe-suite 任务 11）：config merge <files...> ────────────────────────

function suggestionLabel(s: MergeSuggestion): string {
  return s === 'keep' ? t('保留候选', 'Keep candidate') : s === 'review' ? t('存疑', 'Suspect') : t('失效', 'Dead')
}

function verdictLabel(state: ProbeVerdictState | null): string {
  if (!state) return t('无探针记录', 'No probe record')
  const meta: Record<ProbeVerdictState, string> = {
    healthy: t('健康', 'Healthy'),
    degraded: t('降级', 'Degraded'),
    quota: t('额度', 'Quota'),
    'auth-dead': t('失效', 'Auth dead'),
    unreachable: t('不可达', 'Unreachable'),
    unverified: t('未验证', 'Unverified'),
    stale: t('过期', 'Stale'),
  }
  return meta[state]
}

/** 本机探针结论回放（CLI 侧无网关运行态）：probe-<date>.jsonl 是唯一事实源，重放进内存 store 后
 *  按 (key 指纹, model) 匹配——包内 provider 未进本机路由表，provider 维度匹配不了，指纹是稳定锚 */
async function localVerdictFinder() {
  const store = new Map<string, ProbeVerdict>()
  await replayProbeVerdicts({ probeVerdicts: store } as unknown as GatewayRuntime)
  return makeVerdictFinder(store)
}

function candidateLine(cand: MergeCandidate, index: number): string {
  const fp = cand.key_fp ?? t('（无明文 key）', '(no plaintext key)')
  const src = cand.sources.length > 1 ? t(' · 来自 {n} 个包', ' · from {n} packages', { n: cand.sources.length }) : ''
  const prof = cand.profiles.length > 0 ? t(' · 路由 {ids}', ' · profiles {ids}', { ids: cand.profiles.join(', ') }) : ''
  const dup = cand.duplicateCount > 0 ? t('（与另外 {n} 条同址同 key，已合并）', ' ({n} same-url same-key entries merged)', { n: cand.duplicateCount }) : ''
  return `  [${index + 1}] ${cand.id}${dup} · ${cand.base_url} · key 指纹 ${fp}${src}${prof}` +
    `\n      ${t('探针：{v} → 建议：{s}', 'Probe: {v} → suggestion: {s}', { v: verdictLabel(cand.verdict_state), s: suggestionLabel(cand.suggestion) })}`
}

export async function cmdConfigMerge(files: string[], opts: { stdinPass?: boolean; yes?: boolean; json?: boolean }): Promise<void> {
  if (files.length < 2) {
    console.error(c.red(t('✗ 合并至少需要两个配置包：modeldock config merge <包1> <包2> [...]', '✗ Merging needs at least two packages: modeldock config merge <pkg1> <pkg2> [...]')))
    console.log(c.gray(t('只导入一个包用 modeldock config import <file>', 'To import a single package, use modeldock config import <file>')))
    process.exit(1)
  }
  if (opts.json && !opts.stdinPass) {
    // --json 是脚本态：交互口令提示会污染 stdout 且无 tty 可答（冒烟实测踩中）
    console.error(c.red(t('✗ --json 需与 --stdin-pass 配对（口令经 stdin 读入）：echo <口令> | modeldock config merge <files...> --json --stdin-pass', '✗ --json requires --stdin-pass (passphrase via stdin): echo <pass> | modeldock config merge <files...> --json --stdin-pass')))
    process.exit(1)
  }
  // 逐包解包预览（零写盘）。口令策略：--stdin-pass 一份口令全包通用（脚本态）；交互态先用已输入
  // 的口令逐包试解，失败再对当个包追问（包与包口令可以不同，不为同口令的多包重复打扰）
  let pass = ''
  const inputs: { name: string; doc: Awaited<ReturnType<typeof previewImport>>['doc'] }[] = []
  for (const file of files) {
    if (opts.stdinPass) pass = pass || readPassStdin()
    let previewed: Awaited<ReturnType<typeof previewImport>> | null = null
    for (;;) {
      const pw = pass || (await password({ message: t('「{f}」的同步口令', 'Sync passphrase for "{f}"', { f: displayPath(file) }), mask: '*' }))
      try {
        previewed = await previewImport(file, pw)
        pass = pw
        break
      } catch (e) {
        if (opts.stdinPass || pass) {
          console.error(c.red(t('✗ 「{f}」解包失败：{err}', '✗ Failed to open "{f}": {err}', { f: displayPath(file), err: (e as Error).message })))
          process.exit(1)
        }
        console.error(c.red(t('  解包失败：{err}', '  Failed to open the package: {err}', { err: (e as Error).message })))
      }
    }
    inputs.push({ name: displayPath(file), doc: previewed!.doc })
  }

  const { preview, doc } = mergePackages(inputs, await localVerdictFinder())
  if (opts.json) {
    // 机器可读预览（key 只出指纹）；--json 是纯预览态，不进入勾选与应用
    console.log(JSON.stringify({ ok: true, preview, applied: false }))
    return
  }
  console.log(t('合并 {n} 个配置包：{p} 个服务、{r} 条路由（去重合并 {d} 条）', 'Merging {n} packages: {p} providers, {r} profiles ({d} duplicates merged)', { n: inputs.length, p: preview.candidates.length, r: preview.profileTotal, d: preview.duplicatesMerged }))
  for (const i of inputs) console.log(c.gray(t('  · {name}（服务 {p}、路由 {r}）', '  · {name} ({p} providers, {r} profiles)', { name: i.name, p: preview.packages.find((x) => x.name === i.name)?.providers ?? 0, r: preview.packages.find((x) => x.name === i.name)?.profiles ?? 0 })))
  console.log(t('逐服务健康结论与三档建议（探针结论继承自本机探针记录，key 只显示指纹）：', 'Per-service probe verdicts and three-tier suggestions (verdicts come from local probe records; keys shown as fingerprints only):'))
  for (const [i, cand] of preview.candidates.entries()) console.log(candidateLine(cand, i))

  const choices = preview.candidates.map((cand, i) => ({
    value: cand.id,
    name: `[${suggestionLabel(cand.suggestion)}] ${cand.id} · ${cand.base_url} · ${t('指纹', 'fp')} ${cand.key_fp ?? '-'}`,
    checked: cand.suggestion === 'keep',
    description: candidateLine(cand, i),
  }))
  let keepIds: string[] = []
  if (!opts.yes) {
    keepIds = await checkbox({
      message: t('勾选要保留的服务（保留候选默认勾选；存疑/失效默认不勾，自行判断后可改）', 'Select services to keep (keep-candidates are pre-checked; suspect/dead are not — adjust as you see fit)'),
      choices,
      required: false,
    })
  } else {
    // 非交互缺省：只保留「保留候选」档（探针无负证据的服务）
    keepIds = preview.candidates.filter((cand) => cand.suggestion === 'keep').map((cand) => cand.id)
  }
  if (keepIds.length === 0) {
    console.log(c.gray(t('未勾选任何服务，已取消（未写任何内容）', 'Nothing selected; cancelled (nothing was written)')))
    return
  }
  const filtered = filterMergedDoc(doc, keepIds)
  if (filtered.droppedProfiles.length > 0) {
    console.log(c.yellow(t('  ⚠ 路由 {ids} 引用了未保留的服务，将一并剔除', '  ⚠ Profiles {ids} reference dropped services and will be removed too', { ids: filtered.droppedProfiles.join(', ') })))
  }
  console.log(
    t(
      '将写入：服务 {p} 个、路由 {r} 条、自定义预设 {s} 条、定时规则 {w} 条。应用会整体替换本机可同步态（未包含在包里的现有服务会被移除），改动前自动快照',
      'Will write: {p} providers, {r} profiles, {s} custom presets, {w} schedule rules. Applying replaces all syncable state (existing services not in the packages are removed); a snapshot is taken first',
      { p: Object.keys(filtered.doc.data.providers).length, r: Object.keys(filtered.doc.data.profiles).length, s: preview.presetCount, w: preview.scheduleRules }
    )
  )
  console.log(untouchedLine())
  if (!opts.yes) {
    const ok = await confirm({ message: t('确认应用合并结果？', 'Apply the merged result?'), default: false })
    if (!ok) {
      console.log(c.gray(t('已取消，未做任何改动', 'Cancelled; nothing was changed')))
      return
    }
  }
  const applied = await applyImportedDoc(filtered.doc, { log: (line) => console.log(c.yellow(line)) })
  console.log(
    c.green(
      t('✓ 已合并导入：服务 {p}、路由 {r}、预设 {s}、定时规则 {w}；key 按本机存储重存 {k} 条', '✓ Merged and imported: {p} providers, {r} profiles, {s} presets, {w} schedule rules; {k} keys re-stored into local storage', {
        p: applied.providers.length,
        r: applied.profiles.length,
        s: applied.presetCount,
        w: applied.scheduleRules,
        k: applied.keysRestored ?? 0,
      })
    )
  )
  console.log(c.gray(t('改动前已自动快照到 backups/config/。网关运行中则配置热加载立即生效', 'A pre-change snapshot was saved to backups/config/. With the gateway running, config changes hot-reload immediately')))
}

// M2：多机自动同步（docs/design/design-cloud-sync.md §6）

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

/** 向在跑网关要同步状态的权威视图。overview 在网关进程内构建，running 看的是那边挂载的
 *  引擎单例；CLI 进程内直调 syncStatus() 时 active 恒为 null——不问网关，「等待网关接管」
 *  会常驻撒谎（2026-11-27 实测：引擎明明运行中，两台机器的 CLI 全显示等待）。 */
async function fetchGatewaySyncView(port: number, token: string): Promise<SyncStatusView | null> {
  try {
    const res = await request(`http://127.0.0.1:${port}/_modeldock/overview`, {
      headers: { 'x-modeldock-admin': token },
      signal: AbortSignal.timeout(1500),
    })
    if (res.statusCode !== 200) return null
    const body = (await res.body.json()) as { sync?: SyncStatusView | null }
    return body.sync && body.sync.mode !== 'off' ? body.sync : null
  } catch {
    return null
  }
}

/** CLI 状态解析：本地 sync.json 打底（网关没跑/探针不过时唯一可用），网关在跑则整份采纳
 *  其视图——同一 home、同一 sync.json，网关侧字段权威且更新（引擎簿记随时可能前进）。 */
async function resolveSyncStatus(): Promise<SyncStatusView> {
  const local = await syncStatus()
  if (local.mode === 'off') return local
  const gw = await gatewayLive().catch(() => null)
  if (!gw) return local
  return (await fetchGatewaySyncView(gw.port, gw.admin_token)) ?? local
}

export async function cmdSyncStatus(): Promise<void> {
  const s = await resolveSyncStatus()
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

// ── 文本资产白名单（自建 skills / 全局记忆等目录随同步包跨机收敛，见 src/sync/assets.ts）────────

export async function cmdSyncAssetsList(): Promise<void> {
  const cfg = await loadConfig()
  const dirs = cfg.sync_assets?.dirs ?? []
  if (dirs.length === 0) {
    console.log(t('未配置文本资产白名单。添加：modeldock sync assets add <目录>', 'No text-asset whitelist configured. Add one: modeldock sync assets add <dir>'))
    return
  }
  for (const dir of dirs) {
    const a = collectAssetFiles([dir], { onWarning: (line) => console.log(c.yellow(line)) })
    const files = Object.keys(a.files)
    const bytes = files.reduce((s, k) => s + Buffer.byteLength(a.files[k], 'utf8'), 0)
    const skipped = a.skipped.length
      ? t('（跳过 {n} 个二进制/超限/不可入包条目）', ' ({n} binary/oversized/unpackagable entr(y|ies) skipped)', { n: a.skipped.length })
      : ''
    console.log(t('{d} · 文本 {n} 个 / {b}KB{skipped}', '{d} · {n} text file(s) / {b}KB{skipped}', { d: dir, n: files.length, b: Math.max(1, Math.round(bytes / 1024)), skipped }))
  }
  console.log(
    c.gray(
      t(
        '白名单目录内的文本文件随多机同步自动收敛：只写入与更新，不删除本机多出的文件；~/.modeldock 与 node_modules 永不入包。改动随下一次同步生效',
        'Text files inside whitelisted dirs converge via multi-machine sync: writes and updates only, extra local files are never deleted; ~/.modeldock and node_modules are never packaged. Changes apply with the next sync tick'
      )
    )
  )
}

export async function cmdSyncAssetsAdd(dir: string): Promise<void> {
  const rel = normalizeAssetDir(dir)
  const abs = path.join(path.resolve(homeDir()), ...rel.split('/'))
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    console.error(c.red(t('✗ 目录不存在：{d}（先创建目录再 add，或确认路径拼写）', '✗ Directory does not exist: {d} (create it first, or check the path)', { d: displayPath(abs) })))
    process.exit(1)
  }
  let duplicate = false
  await mutateConfig((c2) => {
    const cur = c2.sync_assets?.dirs ?? []
    if (cur.includes(rel)) {
      duplicate = true
      return
    }
    c2.sync_assets = { ...(c2.sync_assets ?? {}), dirs: [...cur, rel] }
  })
  if (duplicate) {
    console.log(t('已在白名单中：{d}', 'Already whitelisted: {d}', { d: rel }))
    return
  }
  console.log(
    c.green(
      t(
        '✓ 已加入文本资产白名单：{d}（目录内文本文件随多机同步收敛，改动前自动快照）',
        '✓ Whitelisted for text-asset sync: {d} (text files inside converge via multi-machine sync; snapshotted before changes)',
        { d: rel }
      )
    )
  )
}

export async function cmdSyncAssetsRm(dir: string): Promise<void> {
  const rel = normalizeAssetDir(dir)
  let removed = false
  await mutateConfig((c2) => {
    const cur = c2.sync_assets?.dirs ?? []
    const next = cur.filter((d) => d !== rel)
    if (next.length === cur.length) return
    removed = true
    if (next.length > 0) c2.sync_assets = { ...(c2.sync_assets ?? {}), dirs: next }
    else delete c2.sync_assets
  })
  if (!removed) {
    console.log(t('不在白名单中：{d}', 'Not whitelisted: {d}', { d: rel }))
    return
  }
  console.log(c.green(t('✓ 已移出白名单：{d}（磁盘文件不动，本机已有副本保留）', '✓ Removed from the whitelist: {d} (files on disk are untouched; the local copy is kept)', { d: rel })))
}

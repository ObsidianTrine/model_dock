import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { confirm } from '@inquirer/prompts'
import { c, printTable, t } from '../util/index.js'
import {
  backupsDir,
  configPath,
  displayPath,
  holidaysCachePath,
  logsDir,
  modelCatalogCachePath,
  modeldockDir,
  secretsPath,
  syncJsonPath,
} from '../util/paths.js'
import { loadConfig } from '../config/store.js'
import { allAdapters } from '../adapters/registry.js'
import { cmdDetach } from './harness.js'
import { exitWithThrown } from './shared.js'
// 注意：gatewaycmd.js / secrets.js 刻意不在顶层 import——它们各自被 test/uninstall.test.ts 以
// vitest vi.mock 拦截。isolate:false + singleFork 下若在本模块顶层静态引用它们，任何早于
// uninstall.test 加载本模块的测试会把真实实现固化进共享注册表，导致其 mock 失效。改为在使用处
// 惰性 import（与下方 autostart/cliinstall 同款做法），运行时才会解析到（被 mock 的）模块。

export async function cmdAdapterList(): Promise<void> {
  const cfg = await loadConfig()
  const adapters = allAdapters(cfg)
  // detect 并行执行（Windows 注册表探测单次最坏 8s，串行 3 个桌面客户端可累到 20s 级）；
  // Promise.all 保序，row 顺序与 allAdapters 一致——与 diag.ts 的 cmdStatus 同款
  const dets = await Promise.all(adapters.map((a) => a.detect()))
  const rows = adapters.map((a, i) => ({
    id: a.id,
    label: a.label,
    installed: dets[i].installed ? '✓' : '○',
    attached: cfg.harness[a.id] ? '✓' : '○',
    current: dets[i].current ?? '',
    note: dets[i].note ?? '',
  }))
  printTable(rows, ['id', 'label', 'installed', 'attached', 'current', 'note'])
  console.log(c.gray(t('L2 声明式 pack 在 config.toml [adapter_packs.<id>] 定义；L3 外部插件在 M2', 'L2 declarative packs are defined in config.toml [adapter_packs.<id>]; L3 external plugins arrive in M2')))
}

/** 组 shell 命令行参数：始终加双引号，避免含 `&`/`^`/`;` 等元字符（但无空格）的路径被 shell 截断。
 *  已知残留：双引号内的 `$`、反引号、cmd 的 `%VAR%` 仍会展开——值域仅为 EDITOR 与 configPath()，用户自身环境，低危。 */
export function quoteArg(s: string): string {
  return `"${s}"`
}

/** 编辑器程序 + 参数 + 目标文件 → 一条 shell 命令行（每段都加双引号） */
export function buildEditCmdline(parts: string[], file: string): string {
  return [...parts, file].map(quoteArg).join(' ')
}

export async function cmdConfigEdit(): Promise<void> {
  const editorRaw = process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi')
  // EDITOR 可能带参数（如 "code -w"）：按空格拆成程序 + 参数，整体经 shell 启动（兼容 Windows 的 .cmd shim）
  const parts = editorRaw.trim().split(/\s+/).filter(Boolean)
  const cmdline = buildEditCmdline(parts, configPath())
  const before = fs.existsSync(configPath())
  if (!before) {
    console.log(c.gray(t('配置文件不存在，将创建：{f}', 'The config file does not exist yet; it will be created: {f}', { f: configPath() })))
  }
  const r = spawnSync(cmdline, { stdio: 'inherit', shell: true })
  if (r.error) {
    console.error(c.red(t('✗ 无法启动编辑器「{e}」：{m}', '✗ Failed to launch editor "{e}": {m}', { e: editorRaw, m: r.error.message })))
    console.error(c.yellow(t('提示: 检查 EDITOR 环境变量（当前：{e}），或用 EDITOR=vi modeldock config edit 临时指定', 'Hint: check the EDITOR environment variable (current: {e}), or pass EDITOR=vi modeldock config edit for one run', { e: editorRaw })))
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error(c.red(t('✗ 编辑器退出码 {s}', '✗ Editor exited with code {s}', { s: String(r.status) })))
    process.exit(r.status ?? 1)
  }
  try {
    await loadConfig()
    console.log(c.green(t('✓ 配置校验通过；网关会自动热加载', '✓ Config is valid; the gateway hot-reloads it automatically')))
  } catch (e) {
    exitWithThrown(e) // ConfigError 带 hint（config edit / restore 建议），两行式透出
  }
}

export async function cmdPresetsUpdate(): Promise<void> {
  console.log(c.gray(t('预设库远程更新在 M2 提供；当前内置预设随 CLI 版本发布', 'Remote preset updates are not available yet; built-in presets ship with the CLI')))
}

export async function cmdUsage(): Promise<void> {
  console.log(c.gray(t('用量统计在 M2 提供；当前可在 {d}/gateway-*.jsonl 查看原始请求记录（不含内容）', 'Usage stats are not available yet; for now, view raw request records (no content) in {d}/gateway-*.jsonl', { d: displayPath(logsDir()) })))
}

/** 卸载共用的程序本体清理：停网关 + 游离清扫 + 移除自启/命令行入口；不动 ~/.modeldock 与客户端接管状态 */
async function removeProgramArtifacts(): Promise<void> {
  const { cmdGatewayStop, sweepGatewayProcesses } = await import('./gatewaycmd.js')
  await cmdGatewayStop()
  // 游离网关全量清扫：仅卸载时执行（gateway stop 可能有多实例共存，如生产 8687 + dev/测试实例，不能全杀）
  sweepGatewayProcesses()

  // 开机自启服务一并移除（cmdGatewayStop 已卸载加载中的服务，这里删服务文件）
  try {
    const { uninstallAutostart } = await import('../autostart.js')
    const r = await uninstallAutostart()
    if (r.wasInstalled) console.log(c.gray(t('  已移除开机自启（{r}）', '  Start-at-login removed ({r})', { r: r.removed })))
  } catch { /* 平台不支持/未安装则跳过 */ }

  // 摘除双击安装时创建的命令行入口（macOS 软链 / Windows PATH 副本）
  try {
    const { removeCliLink } = await import('../cliinstall.js')
    const r = await removeCliLink()
    if (r.removed) console.log(c.gray(t('  已移除命令行入口（{p}）', '  Command-line entry removed ({p})', { p: String(r.path) })))
    else if (r.note) console.log(c.gray(t('  命令行入口未移除：{p}（{n}）', '  Command-line entry not removed: {p} ({n})', { p: String(r.path), n: String(r.note) })))
  } catch { /* 未安装过/平台不支持则跳过 */ }
}

export async function cmdUninstall(opts: { yes?: boolean; purge?: boolean } = {}): Promise<void> {
  const cfg = await loadConfig()
  const attached = Object.keys(cfg.harness)
  const keyRefs = Object.entries(cfg.providers).map(([id, p]) => [id, p.key_ref] as const)

  if (opts.purge === true) {
    console.log(c.bold(t('执行完整卸载（--purge）：', 'Full uninstall (--purge):')))
    for (const id of attached) console.log(t('  1. 还原 {id} 到接管前（快照）', '  1. Restore {id} to its pre-attach state (from backups)', { id }))
    console.log(t('  2. 停止网关', '  2. Stop the gateway'))
    console.log(t('  3. 清除 {n} 个已保存的密钥（含系统钥匙环条目）', '  3. Delete {n} saved keys (including OS keychain entries)', { n: keyRefs.length }))
    console.log(t('  4. 删除 {d}（含配置、key、快照、日志，不可恢复）', '  4. Delete {d} (configs, keys, backups, logs — unrecoverable)', { d: modeldockDir() }))
    console.log()

    const goOn = opts.yes === true || (await confirm({ message: t('确认完整卸载？将删除全部配置与快照且不可恢复', 'Full uninstall? This deletes all configs and backups and cannot be undone') }))
    if (!goOn) return

    for (const id of attached) {
      try {
        await cmdDetach(id, { yes: true })
      } catch (e) {
        // 关键安全闸：还原失败时绝不能删掉 backups/（那是唯一的恢复手段）
        console.error(c.red(t('✗ 还原 {id} 失败：{m}', '✗ Failed to restore {id}: {m}', { id, m: (e as Error).message })))
        console.error(c.yellow(t('  已中止卸载以保留快照（{d}）。排查后重跑 modeldock uninstall --purge；', '  Uninstall aborted to keep the backups ({d}). Fix the issue, then rerun modeldock uninstall --purge;', { d: displayPath(backupsDir()) })))
        console.error(c.yellow(t('  确认放弃快照可手动：modeldock gateway stop && rm -rf {d}', '  To give up the backups deliberately: modeldock gateway stop && rm -rf {d}', { d: modeldockDir() })))
        const { cmdGatewayStop } = await import('./gatewaycmd.js')
        await cmdGatewayStop().catch(() => {})
        return
      }
    }

    await removeProgramArtifacts()

    // 清除密钥：keychain/secret-service 条目不在 ~/.modeldock 里，rm 目录清不掉
    const { deleteSecret } = await import('../config/secrets.js')
    for (const [id, ref] of keyRefs) {
      try {
        await deleteSecret(ref)
      } catch { /* 单项失败不阻断（可能本就不存在） */ }
    }

    try {
      fs.rmSync(modeldockDir(), { recursive: true, force: true })
    } catch (e) {
      console.error(c.yellow(t('删除 {d} 失败：{m}', 'Failed to delete {d}: {m}', { d: modeldockDir(), m: (e as Error).message })))
      console.error(c.yellow(t('提示: Windows 下若网关进程刚停止可能仍占用目录，稍后手动删除即可', 'Hint: on Windows the directory may still be locked right after the gateway stops; delete it manually later')))
      return
    }
    console.log(c.green(t('✓ ModelDock 已卸载，来时无痕走时无痕', '✓ ModelDock has been uninstalled, leaving no trace')))
    return
  }

  console.log(c.bold(t('执行卸载（保留配置）：', 'Uninstall (keeping configs):')))
  console.log(t('  1. 停止网关', '  1. Stop the gateway'))
  console.log(t('  2. 移除开机自启与命令行入口', '  2. Remove start-at-login and the command-line entry'))
  console.log(t('  3. 保留 {d}（配置、密钥、快照不动；{n} 个客户端接管状态保持）', '  3. Keep {d} (configs, keys and backups untouched; attach state of {n} clients preserved)', { d: modeldockDir(), n: attached.length }))
  console.log()

  const goOn = opts.yes === true || (await confirm({ message: t('确认卸载？将停止网关；配置与密钥保留，重装后自动接回', 'Uninstall? This stops the gateway. Configs and keys are kept and reattach automatically after reinstall') }))
  if (!goOn) return

  await removeProgramArtifacts()

  console.log(c.green(t('✓ ModelDock 程序已卸载，配置与密钥保留在 {d}', '✓ The ModelDock program is uninstalled. Configs and keys are kept in {d}', { d: modeldockDir() })))
  console.log(c.yellow(t('注意: 各客户端仍指向已停止的网关，重新安装并启动网关即恢复，客户端无需改动', 'Note: clients still point at the stopped gateway. Reinstall and start the gateway to resume — no client changes needed')))
  console.log(c.gray(t('要连配置、密钥一起彻底清除并还原所有客户端：modeldock uninstall --purge', 'To also wipe configs and keys and restore all clients: modeldock uninstall --purge')))
}

export async function cmdReset(opts: { yes?: boolean; deep?: boolean } = {}): Promise<void> {
  const cfg = await loadConfig()
  const attached = Object.keys(cfg.harness)
  const providerCount = Object.keys(cfg.providers).length

  console.log(c.bold(opts.deep === true ? t('将执行清理数据（--deep）：', 'This will clean data (--deep):') : t('将执行：', 'This will:')))
  let step = 0
  if (attached.length > 0) {
    for (const id of attached) console.log(t('  {n}. 还原 {id} 到接管前（快照）', '  {n}. Restore {id} to its pre-attach state (from backups)', { n: String(++step), id }))
  }
  console.log(t('  {n}. 停止网关', '  {n}. Stop the gateway', { n: String(++step) }))
  console.log(t('  {n}. 清空配置（config.toml + secrets.json）', '  {n}. Clear the configs (config.toml + secrets.json)', { n: String(++step) }))
  if (opts.deep === true) {
    console.log(t('  {n}. 清除日志、同步状态与本机缓存（同步配置保留）', '  {n}. Clear logs, sync state and local caches (sync config is kept)', { n: String(++step) }))
    console.log(c.gray(t('  快照保留不动，仍可 modeldock restore 回溯', '  Backups are kept; roll back anytime with modeldock restore')))
  } else {
    console.log(c.gray(t('  快照和日志保留不动，可随时 modeldock restore 回溯', '  Backups and logs are kept; roll back anytime with modeldock restore')))
  }
  console.log()

  const goOn =
    opts.yes === true ||
    (await confirm({
      message: t('确认重置？将清除 {p} 个 provider、{h} 个 harness 接管', 'Reset? This clears {p} providers and {h} harness attaches', { p: providerCount, h: attached.length }),
    }))
  if (!goOn) return

  for (const id of attached) {
    try {
      await cmdDetach(id, { yes: true })
      console.log(c.green(t('  ✓ 已还原 {id}', '  ✓ Restored {id}', { id })))
    } catch (e) {
      console.error(c.yellow(t('  ✗ 还原 {id} 失败：{m}', '  ✗ Failed to restore {id}: {m}', { id, m: (e as Error).message })))
    }
  }

  const { cmdGatewayStop } = await import('./gatewaycmd.js')
  await cmdGatewayStop()

  // keychain/secret-service 条目不在 secrets.json 里，删文件清不掉
  const { deleteSecret } = await import('../config/secrets.js')
  for (const [, p] of Object.entries(cfg.providers)) {
    try {
      await deleteSecret(p.key_ref)
    } catch { /* 单项失败不阻断 */ }
  }

  removeDataPaths([configPath(), secretsPath()])

  // 保留 backups/、tray.lock、自定义预设等未列出的数据
  if (opts.deep === true) {
    removeDataPaths([logsDir(), syncJsonPath(), holidaysCachePath(), modelCatalogCachePath()])
  }

  console.log()
  console.log(c.green(t('✓ 配置已重置', '✓ Configs have been reset')))
  if (opts.deep === true) {
    console.log(c.gray(t('  日志、同步状态与缓存已清理；快照仍保留在 {b}', '  Logs, sync state and caches are cleared; backups are still kept in {b}', { b: displayPath(backupsDir()) })))
  } else {
    console.log(c.gray(t('  快照和日志仍保留在 {b} 和 {l}', '  Backups and logs are still kept in {b} and {l}', { b: displayPath(backupsDir()), l: displayPath(logsDir()) })))
  }
  console.log(c.bold(t('  下一步：modeldock init 重新配置', '  Next: run modeldock init to set up again')))
}

/** 清理一批数据路径：不存在跳过，单个失败只告警，清理必须走到底。
 *  导出仅为单测：isolate:false 下调 cmdReset 会连带网关/钥匙环等共享模块，纯路径清理需单独可测。 */
export function removeDataPaths(paths: string[]): void {
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue
      fs.rmSync(p, { recursive: true, force: true })
      console.log(c.gray(t('  已删除 {f}', '  Deleted {f}', { f: p })))
    } catch (e) {
      console.error(c.yellow(t('  删除 {f} 失败：{m}', '  Failed to delete {f}: {m}', { f: p, m: (e as Error).message })))
    }
  }
}

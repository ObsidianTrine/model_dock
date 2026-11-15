/**
 * 更新还原（一键回滚上一版，全程零下载）
 *
 * 数据面：~/.modeldock/updates/rollback.json 单槽账本，索引「上一版」产物（含托盘）：
 * - mac-app / bare / win-bare：更新换装本就保留 <安装位置>.old（install.ts 的 rename dance），
 *   账本只做索引，不新增存储、不动 .old 原位（同目录 rename 才能保住换装失败时的即时回滚）；
 * - win-setup：Inno 向导原地替换、不留旧版——弹向导前把 modeldock.exe / ModelDockTray.exe
 *   复制进 ~/.modeldock/updates/rollback/<version>/（唯一新增存储的形态，单槽约 30MB）。
 *
 * 对换式还原：还原 = 槽位版本 ↔ 当前版本对调。完成后槽位装的是刚被换下的（较新）版本，
 * 账本翻转版本号——再点一次「还原」即可免费切回，双向零下载。槽位 version === 当前版本
 * 视为陈旧槽（win-setup 向导被取消 / 翻转失败的兜底），入口自动隐藏、还原时清除。
 *
 * Windows 铁律：运行中 exe 只能 rename / 读，不能覆盖、不能删除——全程 rename dance，
 * 从不删除运行中文件；跨卷 rename（EXDEV，~/.modeldock 与安装目录异盘的边角）降级
 * copy + rename，被换下的当前版本 park 为 <target>.old 交给既有的 cleanOldVersions 清扫。
 *
 * 所有副作用（停网关/停托盘/open/spawn）复用 InstallDeps：单测注入 mock，绝不触达真实实例。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { c, t } from '../util/index.js'
import { atomicWrite, readTextIfExists } from '../util/fsx.js'
import { rollbackLedgerPath, updatesRollbackDir } from '../util/paths.js'
import { VERSION } from '../version.js'
import { UpdateError, type InstallShape } from './check.js'
import {
  appRootFromExecPath,
  defaultInstallDeps,
  detectInstallShape,
  hasWindowsUninstaller,
  type InstallDeps,
} from './install.js'
import { writeUpdateProgress } from './progress.js'
import { acquireUpdateLock } from './lock.js'

/** 还原槽位：上一版产物的索引。mainPath/trayPath 指向的文件在盘上承载上一版本体。 */
export interface RollbackSlot {
  /** 被保留版本（有效槽位必然 ≠ 当前运行版本） */
  version: string
  shape: InstallShape
  /** 上一版主程序产物：mac=<appRoot>.old；bare/win-bare=<bin>.old；win-setup=updates/rollback/<ver>/modeldock.exe */
  mainPath: string
  /** 上一版托盘产物（mac 托盘在 .app 包内不单列；托盘替换失败/缺失时省略） */
  trayPath?: string
  recordedAt: number
}

const SHAPES: readonly InstallShape[] = ['mac-app', 'bare', 'win-setup', 'win-bare']

/** 读还原账本：缺失/损坏/字段非法返回 null（入口按「无槽位」处理，不报错） */
export async function readRollbackSlot(): Promise<RollbackSlot | null> {
  const text = await readTextIfExists(rollbackLedgerPath())
  if (!text) return null
  try {
    const s = JSON.parse(text) as RollbackSlot
    if (!s || typeof s.version !== 'string' || typeof s.mainPath !== 'string') return null
    if (!SHAPES.includes(s.shape)) return null
    if (s.trayPath != null && typeof s.trayPath !== 'string') return null
    return s
  } catch {
    return null
  }
}

/** 写还原账本（atomicWrite 0600，与 staging meta 同款） */
export async function saveRollbackSlot(slot: RollbackSlot): Promise<void> {
  await atomicWrite(rollbackLedgerPath(), JSON.stringify(slot, null, 2) + '\n', 0o600)
}

/** 清还原账本（不删 win-setup 备份目录——目录由 --clean / 换槽统一收） */
export async function clearRollbackSlot(): Promise<void> {
  await fsp.rm(rollbackLedgerPath(), { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
}

/** 清 win-setup 备份目录（updates/rollback/）；mac/bare 的 .old 在安装位置，不归这里管 */
export async function clearRollbackArtifacts(): Promise<void> {
  await fsp.rm(updatesRollbackDir(), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
}

// ---------- 更新成功后的登记（runUpdate 调用，best-effort） ----------

function trayEntryName(): string {
  return 'ModelDockTray' + (process.platform === 'win32' ? '.exe' : '')
}

/** mac-app 换装成功后登记：.old 已由 installMacApp 就位，这里只校验在盘 + 写账本。 */
export async function recordMacAppRollback(execPath: string): Promise<void> {
  const appRoot = appRootFromExecPath(execPath)
  if (!appRoot) throw new UpdateError(t('无法定位 ModelDock.app 安装位置', 'Cannot locate the ModelDock.app install path'))
  const oldApp = appRoot + '.old'
  if (!fs.existsSync(oldApp)) {
    throw new UpdateError(t('上一版目录 .old 不在位，无法登记还原备份', 'The retained .old bundle is missing; cannot record the restore backup'))
  }
  await saveRollbackSlot({ version: VERSION, shape: 'mac-app', mainPath: oldApp, recordedAt: Date.now() })
}

/** bare / win-bare 换装成功后登记：主程序 .old 必在；托盘 .old 以 trayReplaced 为准（替换失败只降级）。 */
export async function recordBareRollback(execPath: string, trayReplaced: boolean): Promise<void> {
  const shape = detectInstallShape(
    execPath,
    process.platform,
    process.env.LOCALAPPDATA,
    process.platform === 'win32' ? hasWindowsUninstaller(execPath) : false
  )
  const old = execPath + '.old'
  if (!fs.existsSync(old)) {
    throw new UpdateError(t('上一版备份 .old 不在位，无法登记还原备份', 'The retained .old binary is missing; cannot record the restore backup'))
  }
  const slot: RollbackSlot = { version: VERSION, shape, mainPath: old, recordedAt: Date.now() }
  const trayOld = path.join(path.dirname(execPath), trayEntryName() + '.old')
  if (trayReplaced && fs.existsSync(trayOld)) slot.trayPath = trayOld
  await saveRollbackSlot(slot)
}

/** win-setup 弹 Inno 向导前备份当前 exe（向导原地替换不留旧版）。此刻网关与托盘已停，
 *  copy 读完全安全；托盘备份失败降级（还原时只还原主程序）。 */
export async function backupWinSetupExes(execPath: string): Promise<void> {
  const rootDir = updatesRollbackDir()
  const destDir = path.join(rootDir, VERSION)
  // 单槽账本只索引当前槽：写新槽前收掉非当前版本的兄弟目录，否则换槽后旧槽（约 30MB）成孤儿
  const entries = await fsp.readdir(rootDir).catch(() => [] as string[])
  await Promise.all(
    entries
      .filter((name) => name !== VERSION)
      .map((name) =>
        fsp.rm(path.join(rootDir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
      )
  )
  await fsp.mkdir(destDir, { recursive: true })
  const destMain = path.join(destDir, 'modeldock.exe')
  await fsp.copyFile(execPath, destMain)
  const slot: RollbackSlot = { version: VERSION, shape: 'win-setup', mainPath: destMain, recordedAt: Date.now() }
  const traySrc = path.join(path.dirname(execPath), 'ModelDockTray.exe')
  if (fs.existsSync(traySrc)) {
    const destTray = path.join(destDir, 'ModelDockTray.exe')
    await fsp.copyFile(traySrc, destTray).catch(() => {})
    if (fs.existsSync(destTray)) slot.trayPath = destTray
  }
  await saveRollbackSlot(slot)
}

// ---------- 对换式还原原语 ----------

function isExdev(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === 'EXDEV'
}

/** 对换核心：slot 位置的上一版 ↔ target 位置的当前版，全程 rename（Windows 运行中 exe
 *  可改名不可覆盖/删除，从不删除运行中文件）。跨卷 rename EXDEV 时降级 swapWithSlotByCopy。
 *  失败即整体回滚原状（当前版挪回 target、上一版挪回 slot），由编排层给恢复指引。 */
export async function swapWithSlot(slot: string, target: string): Promise<void> {
  const tmp = target + '.restoring'
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
  if (!fs.existsSync(slot)) {
    throw new UpdateError(t('上一版备份不在位：{p}', 'The retained backup is missing: {p}', { p: slot }))
  }
  let moved = false
  let parked = false
  try {
    // 槽位先挪开（目标同名的 rename 在 Windows 会失败）。首发 rename 必须在 try 内：
    // 槽位与安装目录异盘时只有这一发能抛 EXDEV，挪出去 catch 接不住、copy 降级不可达
    await fsp.rename(slot, tmp)
    moved = true
    const hadTarget = fs.existsSync(target)
    if (hadTarget) {
      await fsp.rename(target, slot) // 当前版 park 进槽位（对换；运行中文件改名安全）
      parked = true
    }
    await fsp.rename(tmp, target)
  } catch (e) {
    // 回滚原状：parked 挪回 target、上一版挪回 slot（首发 EXDEV 时两步都未发生，无可回滚）
    if (parked) await fsp.rename(slot, target).catch(() => {})
    if (moved) await fsp.rename(tmp, slot).catch(() => {})
    if (isExdev(e)) {
      await swapWithSlotByCopy(slot, target)
      return
    }
    throw e
  }
  if (process.platform !== 'win32') await fsp.chmod(target, 0o755).catch(() => {})
}

/** 跨卷兜底（EXDEV，win-setup 的 ~/.modeldock 与安装目录异盘的边角）：
 *  上一版先 copy 到 <target>.new（拷贝期间安装位原样在位，Windows 不给运行中 exe 留空窗）→
 *  当前版 park 为 <target>.old（运行中 exe 可改名，留给既有 cleanOldVersions 清扫）→
 *  staging rename 落位 → 当前版 copy 回填槽位（对换不丢切回能力）。
 *  导出供单测直测（EXDEV 无法在同卷环境确定性触发，机制按本函数验证）。 */
export async function swapWithSlotByCopy(slot: string, target: string): Promise<void> {
  const oldPark = target + '.old'
  await fsp.rm(oldPark, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
  const staging = target + '.new'
  await fsp.rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
  try {
    await fsp.copyFile(slot, staging)
    if (process.platform !== 'win32') await fsp.chmod(staging, 0o755)
  } catch (e) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
    throw e
  }
  const hadTarget = fs.existsSync(target)
  try {
    if (hadTarget) await fsp.rename(target, oldPark)
    await fsp.rename(staging, target) // target 缺位窗口只有这两次 rename 之间
  } catch (e) {
    if (hadTarget) await fsp.rename(oldPark, target).catch(() => {})
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
    throw e
  }
  try {
    if (hadTarget) await fsp.copyFile(oldPark, slot) // 槽位回填当前版（对换；copy 读运行中文件合法）
  } catch (e) {
    // 回填失败不影响还原本身：清槽位（账本已对不上），下次还原入口按无槽处理
    await fsp.rm(slot, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

/** mac-app 对换还原：运行中 bundle 改名安全（inode 不变）。三步：当前包 → .restoring、
 *  旧包 → 原位（失败即回滚）、.restoring → .old（失败仅告警——还原已成功，只是切回备份缺位）。 */
export async function restoreMacApp(appRoot: string, log: (m: string) => void): Promise<void> {
  const oldApp = appRoot + '.old'
  const tmp = appRoot + '.restoring'
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  await fsp.rename(appRoot, tmp)
  try {
    await fsp.rename(oldApp, appRoot)
  } catch (e) {
    await fsp.rename(tmp, appRoot).catch(() => {})
    throw e
  }
  try {
    await fsp.rename(tmp, oldApp)
  } catch (e) {
    log(c.yellow(t('⚠ 新版本切回备份未就位（还原本身已成功）：{m}', '⚠ The switch-back backup was not staged (restore itself succeeded): {m}', { m: (e as Error).message })))
  }
  const bin = path.join(appRoot, 'Contents', 'MacOS', 'ModelDock')
  await fsp.chmod(bin, 0o755).catch(() => {})
}

// ---------- 还原编排 ----------

export interface RestoreRunOptions {
  yes?: boolean
  /** 确认交互（CLI 默认 @inquirer/prompts；--yes 传 () => true） */
  confirm: (message: string) => Promise<boolean>
  deps?: InstallDeps
  /** 测试注入：以这个 execPath 识别安装位置（默认 process.execPath） */
  execPath?: string
  log?: (msg: string) => void
}

export interface RestoreRunResult {
  restored: boolean
  /** 还原前运行的版本 */
  fromVersion: string
  /** 还原到的版本（槽位保留的上一版） */
  toVersion: string
}

/**
 * 一键还原上一版：校验槽位 → 停网关托盘 → 对换（主程序 + 托盘）→ 账本翻转 → 拉起。
 * 零下载：产物全部来自磁盘上的 .old / 回滚目录。持更新锁（与更新/清理互斥），
 * 进度写 update-progress.json（托盘进度窗零改动复用；total=0 时托盘按转圈展示）。
 */
export async function runRestore(opts: RestoreRunOptions): Promise<RestoreRunResult> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const deps = opts.deps ?? defaultInstallDeps()
  const execPath = opts.execPath ?? process.execPath
  const platform = process.platform

  const slot = await readRollbackSlot()
  if (!slot) {
    throw new UpdateError(
      t('没有可还原的上一版本', 'No previous version to restore'),
      t('上一版在每次成功更新后自动保留（安装位置 .old 或回滚目录）；modeldock update --clean 会连同备份一起清掉', 'The previous version is retained automatically after each successful update (as .old beside the install, or in the rollback dir); `modeldock update --clean` removes it too')
    )
  }
  if (slot.version === VERSION) {
    // 陈旧槽（win-setup 向导被取消 / 账本翻转失败的兜底）：清掉并明说，不留幽灵入口
    await clearRollbackSlot().catch(() => {})
    throw new UpdateError(
      t('上一版备份与当前版本相同（v{v}），已清除失效备份', 'The retained backup matches the running version (v{v}); stale backup cleared', { v: VERSION })
    )
  }
  if (!fs.existsSync(slot.mainPath)) {
    await clearRollbackSlot().catch(() => {})
    throw new UpdateError(
      t('上一版备份已被移除（{p}）', 'The retained backup is gone ({p})', { p: slot.mainPath }),
      t('备份可能被手动删除或清理；重装旧版，或等下次更新重新保留', 'The backup may have been deleted manually or cleaned up; reinstall the old version, or wait for the next update to retain it again')
    )
  }
  let trayPath = slot.trayPath
  if (trayPath && !fs.existsSync(trayPath)) {
    log(c.yellow(t('⚠ 上一版托盘备份缺失，将只还原主程序', '⚠ Tray backup missing; restoring the main program only')))
    trayPath = undefined
  }

  // 开发态守卫（与 runUpdate 同款）：tsx 直跑时 execPath 是 node，裸形态还原会把 node 换掉
  const liveShape = detectInstallShape(
    execPath,
    platform,
    process.env.LOCALAPPDATA,
    platform === 'win32' ? hasWindowsUninstaller(execPath) : false
  )
  if ((liveShape === 'bare' || liveShape === 'win-bare') && path.basename(execPath).toLowerCase().startsWith('node')) {
    throw new UpdateError(
      t('当前是开发态（tsx 直跑源码），不支持还原', 'Running from source (tsx): restore is not supported'),
      t('请用正式安装的 ModelDock 执行 modeldock update --restore', 'Run `modeldock update --restore` from an installed ModelDock')
    )
  }

  if (opts.yes !== true) {
    const goOn = await opts.confirm(
      t('确认还原到 v{v}？期间网关会短暂中断，完成后自动拉起。', 'Restore to v{v}? The gateway pauses briefly and restarts automatically when done.', { v: slot.version })
    )
    if (!goOn) {
      log(c.gray(t('已取消，未做任何改动', 'Cancelled; nothing was changed')))
      return { restored: false, fromVersion: VERSION, toVersion: slot.version }
    }
  }

  const release = await acquireUpdateLock()
  try {
    await writeUpdateProgress('swapping', 0, 0)
    const wasLive = await deps.gatewayWasLive()
    log(t('停止网关与托盘…', 'Stopping the gateway and tray…'))
    await deps.stopGateway()
    await deps.stopTray(log)
    const prevVersion = VERSION
    // 账本翻转：槽位现在装的是刚被换下的版本（再点一次「还原」可免费切回）。
    // 对换成功立即落盘、先于任何拉起——否则拉起失败误报「还原失败」，且账本停在旧版
    // 会被下次还原的陈旧槽判定误清，丢掉免费切回能力
    const flipLedger = async (traySwapped: boolean) => {
      const flipped: RollbackSlot = { version: prevVersion, shape: slot.shape, mainPath: slot.mainPath, recordedAt: Date.now() }
      if (traySwapped && slot.trayPath) flipped.trayPath = slot.trayPath
      await saveRollbackSlot(flipped).catch(() => {})
    }
    // 拉起失败不进外层 catch：还原本身已成功，只单独告警 + 给手动启动指引
    const launchSafe = (fn: () => void, hint: string): boolean => {
      try {
        fn()
        return true
      } catch (e) {
        log(c.yellow(t('⚠ 还原成功，但启动失败：{m}。{h}', '⚠ Restore succeeded, but the launch failed: {m}. {h}', { m: (e as Error).message, h: hint })))
        return false
      }
    }
    try {
      if (slot.shape === 'mac-app') {
        const appRoot = appRootFromExecPath(execPath)
        if (!appRoot) throw new UpdateError(t('无法定位 ModelDock.app 安装位置', 'Cannot locate the ModelDock.app install path'))
        await restoreMacApp(appRoot, log)
        await flipLedger(false)
        log(c.green(t('✓ 已还原到 v{v}，正在重新启动 ModelDock…', '✓ Restored to v{v}; restarting ModelDock…', { v: slot.version })))
        launchSafe(() => deps.openApp(appRoot), t('请手动打开 ModelDock', 'Open ModelDock manually'))
      } else {
        // bare / win-bare / win-setup 同一套对换：槽位旧版 ↔ 当前版，托盘随主程序一并还原
        await swapWithSlot(slot.mainPath, execPath)
        log(c.green(t('✓ 已还原主程序到 v{v}', '✓ Main program restored to v{v}', { v: slot.version })))
        const targetTray = path.join(path.dirname(execPath), trayEntryName())
        let traySwapped = false
        if (trayPath) {
          try {
            await swapWithSlot(trayPath, targetTray)
            traySwapped = true
          } catch (e) {
            log(c.yellow(t('⚠ 托盘还原失败（主程序已还原）：{m}。旧托盘若还在运行，手动重启即可', '⚠ Tray restore failed (main program restored): {m}. If the old tray is still running, restart it manually', { m: (e as Error).message })))
          }
        }
        await flipLedger(traySwapped)
        if (wasLive) {
          if (launchSafe(() => deps.spawnDetached(execPath, ['--sea-gateway']), t('可手动启动：modeldock gateway start --daemon', 'Start it manually with `modeldock gateway start --daemon`'))) {
            log(c.green(t('✓ 网关已按原状态拉起', '✓ Gateway restarted as before')))
          }
          // 托盘不在这里抢拉：daemon 就绪后由 spawnTrayWhenGatewayReady 补拉（与更新同口径）
        } else {
          log(c.gray(t('网关之前未在运行，未自动拉起（需要时：modeldock gateway start --daemon）', 'The gateway was not running; not started automatically (start with: modeldock gateway start --daemon)')))
          if (fs.existsSync(targetTray)) {
            launchSafe(() => deps.startTray(targetTray), t('可手动启动托盘', 'Start the tray manually'))
          }
        }
      }
    } catch (e) {
      log(c.red(t('✗ 还原失败：{m}', '✗ Restore failed: {m}', { m: (e as Error).message })))
      log(c.yellow(t('网关当前已停止。重试：modeldock update --restore；或先启动网关：modeldock gateway start --daemon', 'The gateway is now stopped. Retry with `modeldock update --restore`; or start the gateway first with `modeldock gateway start --daemon`')))
      throw e
    }

    await writeUpdateProgress('restarting', 0, 0)
    log(c.green(t('还原完成。当前 v{v}（备份已换持 v{p}，可再次还原切回）', 'Restore finished. Now running v{v} (the backup now holds v{p}; restore again to switch back)', { v: slot.version, p: prevVersion })))
    await writeUpdateProgress('done', 0, 0)
    return { restored: true, fromVersion: prevVersion, toVersion: slot.version }
  } catch (e) {
    await writeUpdateProgress('failed', 0, 0, (e as Error).message)
    throw e
  } finally {
    release()
  }
}

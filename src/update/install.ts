/**
 * 自动更新 M1——平台安装与重启（实施基准：docs/design-auto-update.md §5.4）
 *
 * 三种替换手法：
 * - mac .app 整包交换：unix 允许 rename 运行中目录——旧 .app 改名 .old → 新 .app 落位 → `open` 拉起新版；
 * - unix/win 裸二进制 rename dance：旧 exe 改名 .old（Windows 允许改名运行中 exe，不允许覆盖/删除）→ 新 exe 落位；
 * - win 安装器版：下载 setup.exe 校验后弹出与首次安装一致的 Inno 向导（不静默，失败可见 + /LOG 落盘），
 *   更新器先退出释放自身 exe 锁；成功由向导 [Run] 拉起托盘，失败/被取消由 cmd `||` 串联拉回旧托盘兜底。
 *
 * 所有副作用（停网关/停托盘/open/spawn）收敛进 InstallDeps：单测注入 mock，绝不触达真实实例。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { t } from '../util/i18n.js'
import { c, sleep } from '../util/index.js'
import { killByPid, parsePidCommandLines } from '../cli/shared.js'
import { UpdateError, type InstallShape } from './check.js'

export type { InstallShape }

/** 可注入副作用集合：测试传 mock，生产用 defaultInstallDeps() */
export interface InstallDeps {
  /** 停掉受管网关实例（生产实现 = cmdGatewayStop；先卸自启服务防 KeepAlive 拉锯） */
  stopGateway: () => Promise<void>
  /** 停托盘进程（找不到就不动；mac=ModelDockTray，win=ModelDockTray.exe）。
   *  log 进更新日志：杀/验/补刀每步结果可见，失败不再静默（静默失败 = 托盘带锁活到向导）。 */
  stopTray: (log: (msg: string) => void) => Promise<void>
  /** mac：`open` 拉起新 .app（GUI 分支自会拉起网关与托盘） */
  openApp: (appPath: string) => void
  /** 分离 spawn（win 串联 cmd / unix 拉起新网关 daemon）；verbatim = 参数原样传（cmd /s /c 引号语义需要） */
  spawnDetached: (file: string, args: string[], opts?: { verbatim?: boolean }) => void
  /** 更新前的网关存活状态（决定换完是否拉回） */
  gatewayWasLive: () => Promise<boolean>
  /** 拉起托盘（bare 收尾用；win-setup 由 cmd 串联 start 托盘，不走这里） */
  startTray: (trayPath: string) => void
}

export function defaultInstallDeps(): InstallDeps {
  return {
    stopGateway: async () => {
      const { cmdGatewayStop } = await import('../cli/gatewaycmd.js')
      await cmdGatewayStop()
    },
    stopTray: async (log) => {
      await stopTrayProcesses(log)
    },
    openApp: (appPath) => {
      spawn('open', [appPath], { detached: true, stdio: 'ignore' }).unref()
    },
    spawnDetached: (file, args, opts) => {
      spawn(file, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        ...(opts?.verbatim ? { windowsVerbatimArguments: true } : {}),
      }).unref()
    },
    gatewayWasLive: async () => {
      const { gatewayLive } = await import('../gateway/state.js')
      return !!(await gatewayLive())
    },
    startTray: (trayPath) => {
      spawn(trayPath, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    },
  }
}

/** 从 listProcessLines 输出（"pid command" 行）筛出托盘 pid（纯函数，单测直接喂样本行）。
 *  判定对象是「命令行的可执行段（首个 token）」：ModelDockTray 出现在参数里（grep ModelDockTray …
 *  之类以它作参数的进程）不误杀——CORRECT-05 对 sweep 的教训同源：按命令行签名全机杀进程要收敛误杀面。
 *  取首 token 对带空格的未加引号路径会失手（CIM 输出对含空格路径惯例加引号，best-effort 可接受）。 */
export function trayPidsFromProcessLines(lines: string): number[] {
  const pids: number[] = []
  for (const { pid, cmd } of parsePidCommandLines(lines)) {
    const exe = cmd.startsWith('"') ? cmd.slice(1, cmd.indexOf('"', 1)) : cmd.split(/\s/)[0]
    if (!exe) continue
    // 输入固定是 Windows CIM 输出（反斜杠路径）——basename 必须 win32 语义：POSIX 的
    // path.basename 不切反斜杠，非 Windows 机器（跨平台测试 / CI）上整类托盘行永不命中
    if (!/^ModelDockTray(\.exe)?$/i.test(path.win32.basename(exe.replace(/"/g, '')))) continue
    pids.push(pid)
  }
  return pids
}

/** 停托盘的可注入依赖：单测全 mock（枚举与 kill 绝不触达真实进程——生产托盘常在运行），
 *  生产走 defaultInstallDeps().stopTray 的缺省实现（动态 import 真模块）。 */
export interface TrayStopDeps {
  /** 枚举本机进程命令行（"pid command" 行）；不可用返回 null */
  listProcessLines: () => string | null | Promise<string | null>
  /** 按 PID 杀进程（win=taskkill /PID，unix=SIGTERM）；返回是否生效 */
  killByPid: (pid: number, spawnSyncFn: typeof spawnSync, opts?: { tree?: boolean }) => boolean
  /** 按映像名兜底强杀所用的同步执行器（win 专属路径，注入后不触达真实 taskkill） */
  spawnSync: typeof spawnSync
  /** 杀与复查之间的小睡：taskkill 返回到句柄释放有短窗，复查枚举需要真实视图 */
  sleep: (ms: number) => Promise<void>
  /** 平台判定（单测注入 'win32' 以确定性地覆盖强杀路径；缺省 process.platform） */
  platform: string
}

async function defaultListProcessLines(): Promise<string | null> {
  const { listProcessLines } = await import('../cli/gatewaycmd.js')
  return listProcessLines()
}

/** 停托盘：按命令行精确匹配 ModelDockTray（不按映像名全局杀），
 *  「枚举 → 按 PID 杀 → 复查 → 补刀」两遍式，每步结果写进更新日志、失败不再静默；
 *  两遍后仍未停时 win 按映像名兜底强杀（ModelDockTray.exe 为 ModelDock 专用映像名，
 *  更新器自身是 modeldock.exe，无自伤面）。
 *  旧实现是尽力而为零验证：枚举空 / kill 未生效都无痕迹，托盘带锁存活到安装向导——
 *  RM 只能优雅关闭无窗口托盘（收不到关闭消息，30s 超时）→ Abort/Retry/Ignore 弹框，
 *  安装卡死在「无法自动关闭所有应用程序」（2026-10-28 用户实证，连续三次更新全中）。 */
export async function stopTrayProcesses(log: (msg: string) => void, deps?: Partial<TrayStopDeps>): Promise<void> {
  const isWin = (deps?.platform ?? process.platform) === 'win32'
  const list = deps?.listProcessLines ?? defaultListProcessLines
  const kill = deps?.killByPid ?? killByPid
  const runSync = deps?.spawnSync ?? spawnSync
  const nap = deps?.sleep ?? sleep
  /** 枚举 + 解析托盘 pid；枚举不可用 / 抛异常统一按 null（走兜底 / 终验明说） */
  const enumTray = async (): Promise<number[] | null> => {
    try {
      const lines = await list()
      return lines == null ? null : trayPidsFromProcessLines(lines)
    } catch {
      return null
    }
  }
  const killedLog = t('✓ 托盘已停止', '✓ Tray stopped')
  const unconfirmedLog = t('⚠ 进程枚举不可用，无法确认托盘是否已停止；若向导弹出「关闭应用程序」确认框请按提示处理', '⚠ Process enumeration unavailable; cannot confirm whether the tray stopped. If the wizard shows a "close applications" prompt, follow it')
  let killedAny = false
  /** 循环内出现过未生效的杀/强杀（kill 返回 false 或 taskkill 状态非 0）：此后空枚举与失败记录矛盾
   *  （枚举抖动 / taskkill 竞态），不再直接采信「✓ 已停止」——交给终验再枚举一次仲裁；
   *  终验枚举恰好不可用（null）时也据此在 win 补一发映像名强杀（S1） */
  let hadKillFailure = false
  /** 按映像名兜底强杀并记录结果（结果不再静默：status 非 0 = 未找到目标/失败；
   *  注入的 fake 返回 undefined 视为成功——与 killByPid 同约定，只桩命令拼装） */
  const forceKillByImage = (): void => {
    const r = runSync('taskkill', ['/IM', 'ModelDockTray.exe', '/F'], { stdio: 'ignore', windowsHide: true })
    const ok = !r || r.status === 0
    if (!ok) hadKillFailure = true
    log(ok
      ? c.gray(t('  已按映像名强杀托盘', '  Tray force-killed by image name'))
      : c.yellow(t('  ⚠ 按映像名强杀托盘未生效', '  ⚠ Force-killing the tray by image name did not take effect')))
  }
  for (let pass = 1; pass <= 2; pass++) {
    const pids = await enumTray()
    if (pids == null) {
      // 枚举不可用：win 按映像名兜底强杀（ModelDockTray.exe 为 ModelDock 专用映像名，
      // 更新器自身是 modeldock.exe，无自伤面）；unix 无等价物，交给终验明说
      if (!isWin) break
      log(c.yellow(t('进程枚举不可用，改按映像名强杀托盘（ModelDockTray.exe）', 'Process enumeration unavailable; killing the tray by image name (ModelDockTray.exe) instead')))
      forceKillByImage()
      killedAny = true
      await nap(800)
      continue
    }
    if (pids.length === 0) {
      // 有过未生效的杀/强杀：空枚举与失败记录矛盾，不轻信「✓ 已停止」，交终验下结论
      if (hadKillFailure) break
      // 第一遍就为空 = 托盘本就未运行；第二遍为空 = 已杀干净
      log(killedAny ? c.green(killedLog) : c.gray(t('托盘未在运行', 'Tray not running')))
      return
    }
    log(t('停止托盘进程（pid {pids}）…', 'Stopping tray process(es) (pid {pids})…', { pids: pids.join(', ') }))
    // tree:false——托盘发起的更新里更新器就是托盘的子进程，taskkill /T 会把自己一并杀掉，
    // 安装步骤永远执行不到（Windows 托盘更新必败的根因）；托盘无必须连带清理的子进程
    for (const pid of pids) {
      const ok = kill(pid, runSync, { tree: false })
      if (!ok) hadKillFailure = true
      log(ok
        ? c.gray(t('  已杀 pid {pid}', '  Killed pid {pid}', { pid: String(pid) }))
        : c.yellow(t('  ⚠ 杀 pid {pid} 未生效', '  ⚠ Failed to kill pid {pid}', { pid: String(pid) })))
    }
    killedAny = true // 做过杀动作即算：下一遍为空时给「✓ 已停止」而非「未在运行」
    await nap(800) // taskkill 返回到句柄释放有短窗，给复查枚举留出真实视图
  }
  // 终验：两遍后给明确结论——杀干净 ✓，没杀干净 / 无法确认 ⚠（旧行为的失败就败在无痕）
  let alive = await enumTray()
  if (alive != null && alive.length === 0) {
    log(c.green(killedLog))
    return
  }
  if (alive == null) {
    // 循环内已有「杀/强杀未生效」的实证而终验枚举恰好不可用（瞬时 PS 失败）：
    // win 仍按映像名补一发（S1），结果写日志后照旧落无法确认——不因枚举失败漏掉既定兜底
    if (isWin && hadKillFailure) {
      log(c.yellow(t('⚠ 托盘停止未确认且此前有杀/强杀未生效，再按映像名强杀一次（ModelDockTray.exe）', '⚠ Tray stop unconfirmed after earlier kill failures; retrying force-kill by image name (ModelDockTray.exe)')))
      forceKillByImage()
    }
    log(c.yellow(unconfirmedLog))
    return
  }
  if (isWin) {
    // 兜底降级：两遍按 PID 仍未停 → 按映像名强杀（更新器自身是 modeldock.exe，无自伤面），结果写日志
    log(c.yellow(t('⚠ 按 PID 停托盘未完全生效（pid {pids}），改按映像名强杀（ModelDockTray.exe）', '⚠ Stopping the tray by pid did not fully take effect (pid {pids}); force-killing by image name (ModelDockTray.exe)', { pids: alive.map(String).join(', ') })))
    forceKillByImage()
    await nap(800)
    alive = await enumTray()
    if (alive != null && alive.length === 0) {
      log(c.green(killedLog))
    } else if (alive == null) {
      log(c.yellow(unconfirmedLog))
    } else {
      log(c.yellow(t('⚠ 托盘仍未停止（pid {pids}），向导将尝试强制关闭；也可手动退出托盘后重试更新', '⚠ Tray still running (pid {pids}); the wizard will try to force-close it. You can also quit the tray manually and retry the update', { pids: alive.map(String).join(', ') })))
    }
    return
  }
  log(c.yellow(t('⚠ 托盘仍未停止（pid {pids}），向导将尝试强制关闭；也可手动退出托盘后重试更新', '⚠ Tray still running (pid {pids}); the wizard will try to force-close it. You can also quit the tray manually and retry the update', { pids: alive.map(String).join(', ') })))
}

// 安装形态识别

const MAC_APP_RE = /(^|[\\/])[^\\/]*\.app[\\/]Contents[\\/]MacOS[\\/]/i

/** 从 execPath 推导 .app 根目录（含 .app 段）；非 .app 形态返回 null。大小写不敏感（mac 默认 FS）。 */
export function appRootFromExecPath(execPath: string): string | null {
  const norm = execPath.replace(/\\/g, '/')
  const idx = norm.toLowerCase().lastIndexOf('.app/contents/macos/')
  if (idx === -1) return null
  // idx 指向 '.app' 的句点：最后一节目录名 + '.app' 即 app 根段
  const segs = norm.slice(0, idx).split('/')
  const base = segs.pop()
  if (!base) return null
  const appSeg = base + '.app'
  return segs.length ? segs.join('/') + '/' + appSeg : appSeg
}

/** Windows 安装器指纹：Inno 卸载器 unins000.exe 与主程序同目录（装完即在，卸载才移除）。
 *  独立成函数让 detectInstallShape 保持纯逻辑（单测传布尔即可），真机判定统一经这里。 */
export function hasWindowsUninstaller(execPath: string): boolean {
  return fs.existsSync(path.join(path.dirname(execPath), 'unins000.exe'))
}

/** 识别当前安装形态（纯函数；win 用显式参数而非读环境，便于三平台测试）。
 *  hasUninstaller = hasWindowsUninstaller(execPath) 的探测结果：安装目录可自选（installer.iss
 *  DefaultDirName 之外用户可改），装到自定义目录时路径前缀判定不到，只认 LOCALAPPDATA 会把
 *  安装器安装误判 win-bare → 自更新退化成裸 zip 替换、托盘不随更（2026-10 用户实证：装在
 *  D:\Programs\ModelDock 的机器每次升级托盘都停旧版）。 */
export function detectInstallShape(
  execPath: string,
  platform: string,
  localAppData?: string,
  hasUninstaller = false
): InstallShape {
  if (platform === 'darwin') {
    return MAC_APP_RE.test(execPath) ? 'mac-app' : 'bare'
  }
  if (platform === 'win32') {
    const lad = localAppData ?? 'C:\\Users\\u\\AppData\\Local'
    const prefix = (lad + path.sep + path.join('Programs', 'ModelDock')).toLowerCase().replace(/\\/g, '/')
    const norm = execPath.toLowerCase().replace(/\\/g, '/')
    if (norm.startsWith(prefix + '/')) return 'win-setup'
    // 自定义目录兜底：有卸载器指纹即安装器安装；向导 /DIR 预选当前目录，主程序与托盘原位一并更新
    return hasUninstaller ? 'win-setup' : 'win-bare'
  }
  return 'bare'
}

// 安装原语

/** mac .app 整包交换：staging 里解出的 ModelDock.app 换到 appRoot 位置。旧包保留为 <appRoot>.old 供回滚。 */
export async function installMacApp(stagingDir: string, appRoot: string): Promise<void> {
  const newApp = path.join(stagingDir, 'ModelDock.app')
  if (!fs.existsSync(newApp)) {
    throw new UpdateError(
      t('更新包里没有 ModelDock.app，包内容异常；已中止', 'The update package does not contain ModelDock.app; aborted')
    )
  }
  await checkWritable(path.dirname(appRoot))
  const oldApp = appRoot + '.old'
  await fsp.rm(oldApp, { recursive: true, force: true })
  // 换名运行中目录是安全的（inode 不变）；本进程从旧位置继续执行直到退出
  await fsp.rename(appRoot, oldApp)
  try {
    await fsp.rename(newApp, appRoot)
  } catch (e) {
    // 新包落位失败必须回滚，否则系统里没有可用的 ModelDock.app
    await fsp.rename(oldApp, appRoot).catch(() => {})
    throw e
  }
  const bin = path.join(appRoot, 'Contents', 'MacOS', 'ModelDock')
  await fsp.chmod(bin, 0o755).catch(() => {})
}

/** 裸二进制 rename dance：newBin 换到 targetBin 位置，旧文件保留为 .old。Windows 允许改名运行中 exe。
 *  目标不存在时直接落位（包里新增组件如托盘首次旁路带入，没有可改名的旧文件）。 */
export async function installBareBinary(newBin: string, targetBin: string): Promise<void> {
  await checkWritable(path.dirname(targetBin))
  const staging = targetBin + '.new'
  await fsp.copyFile(newBin, staging)
  if (process.platform !== 'win32') await fsp.chmod(staging, 0o755)
  const old = targetBin + '.old'
  await fsp.rm(old, { force: true }).catch(() => {})
  const hadTarget = fs.existsSync(targetBin)
  if (hadTarget) await fsp.rename(targetBin, old)
  try {
    await fsp.rename(staging, targetBin)
  } catch (e) {
    if (hadTarget) await fsp.rename(old, targetBin).catch(() => {})
    throw e
  }
}

async function checkWritable(dir: string): Promise<void> {
  try {
    await fsp.access(dir, fs.constants.W_OK)
  } catch {
    throw new UpdateError(
      t('安装目录不可写：{d}', 'Install directory is not writable: {d}', { d: dir }),
      t('macOS 请确认 ModelDock.app 在「应用程序」且当前用户是管理员；或用 sudo 修正属主后重试', 'On macOS make sure ModelDock.app is in Applications and the current user is an admin; fix ownership (sudo) and retry')
    )
  }
}

/** win 更新安装命令构造（纯函数）：弹出与首次安装一致的 Inno 向导（不静默），/DIR 预选当前安装目录。
 *  安装成功时托盘由向导收尾页的 [Run] 勾选拉起（skipifsilent 只拦静默安装，向导不受影响）；
 *  失败或被取消（退出码非 0）时 cmd 串联 `||` 拉回旧托盘兜底——旧托盘 EnsureGateway 把网关带回来，
 *  用户回到可用的旧版本而不是整机失联，两路互斥不重复弹控制台。trayPath 缺省（构建无托盘）时只装不拉。
 *  installDir 必传 = 当前运行安装目录：/DIR 把更新落点钉死在用户当初选的路径；不钉 /DIR 时落点靠
 *  注册表 UsePreviousAppDir 记忆——注册表被清理软件删掉或用户搬过安装目录时会失效，落回
 *  DefaultDirName 制造第二份安装。setupLogPath 传 /LOG 落盘：静默更新曾三连败于安装中途
 *  （2026-10-27 用户实证：unins000 已重写而主程序未换，/SUPPRESSMSGBOXES 把错误框也吞了，
 *  表现为「托盘没了、网关不回、无任何提示」），可见向导 + 落盘日志让失败当面可见、有据可查。
 *  /FORCECLOSEAPPLICATIONS：RM 兜底直接强杀残留占用者——无窗口托盘（NotifyIcon 隐藏窗口收不到
 *  关闭消息）优雅关闭必然 30s 超时 → Abort/Retry/Ignore 弹框卡住安装（2026-10-28 用户实证）；
 *  更新器已先行停托盘，此参数只兜极端残留，锁我们文件的只可能是自家进程，强杀无损。 */
export function buildWinInstallerCommand(
  setupPath: string,
  trayPath: string | null,
  installDir: string,
  setupLogPath?: string | null
): { file: string; args: string[] } {
  const log = setupLogPath ? ` /LOG="${setupLogPath}"` : ''
  const setup = `"${setupPath}" /DIR="${installDir}" /CLOSEAPPLICATIONS /FORCECLOSEAPPLICATIONS /NORESTART${log}`
  const inner = trayPath ? `${setup} || start "" "${trayPath}"` : setup
  // /s /c + 首尾引号：cmd 剥掉外层引号后按内层解析，含空格路径安全；/DIR 引号内 & 等元字符同样受保护
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${inner}"`] }
}

// 解压

// 注：解压原语已收敛到 transfer.ts 的 extractArchive（tar / Expand-Archive 平台分支、可注入执行器），
// 本域 run.ts 经 src/update/run.ts 从 transfer 引入，install.ts 不再各自维护一份。

// 收尾

/** 清理上一版残留（.old）：mac-app = <appRoot>.old；裸二进制 = <bin>.old + 托盘
 *  <binDir>/ModelDockTray(.exe).old（2026-10-26 起「托盘同版本换新」在裸形态也替换托盘并留
 *  .old——不清理的话每次自更新都攒一份旧托盘，update --clean 永远清不掉）。找不到就静默返回。 */
export async function cleanOldVersions(execPath: string): Promise<string[]> {
  const removed: string[] = []
  const candidates: string[] = []
  const appRoot = appRootFromExecPath(execPath)
  if (appRoot) candidates.push(appRoot + '.old')
  else {
    candidates.push(execPath + '.old')
    const trayExe = 'ModelDockTray' + (process.platform === 'win32' ? '.exe' : '')
    candidates.push(path.join(path.dirname(execPath), trayExe + '.old'))
  }
  for (const c of candidates) {
    const norm = c.replace(/\\/g, '/')
    if (norm === execPath.replace(/\\/g, '/')) continue
    try {
      await fsp.rm(c, { recursive: true, force: true })
      removed.push(c)
    } catch {
      /* 被占用/权限不足：下次再清 */
    }
  }
  return removed
}

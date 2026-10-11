/**
 * 自动更新 M1——平台安装与重启（实施基准：docs/design-auto-update.md §5.4）
 *
 * 三种替换手法：
 * - mac .app 整包交换：unix 允许 rename 运行中目录——旧 .app 改名 .old → 新 .app 落位 → `open` 拉起新版；
 * - unix/win 裸二进制 rename dance：旧 exe 改名 .old（Windows 允许改名运行中 exe，不允许覆盖/删除）→ 新 exe 落位；
 * - win 安装器版：下载 setup.exe 校验后静默安装（/VERYSILENT /NORESTART），更新器先退出释放自身 exe 锁，
 *   由 cmd 串联在安装器退出后拉起托盘。
 *
 * 所有副作用（停网关/停托盘/open/spawn）收敛进 InstallDeps：单测注入 mock，绝不触达真实实例。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { t } from '../util/i18n.js'
import { UpdateError, type InstallShape } from './check.js'

export type { InstallShape }

/** 可注入副作用集合：测试传 mock，生产用 defaultInstallDeps() */
export interface InstallDeps {
  /** 停掉受管网关实例（生产实现 = cmdGatewayStop；先卸自启服务防 KeepAlive 拉锯） */
  stopGateway: () => Promise<void>
  /** 停托盘进程（找不到就不动；mac=ModelDockTray，win=ModelDockTray.exe） */
  stopTray: () => Promise<void>
  /** mac：`open` 拉起新 .app（GUI 分支自会拉起网关与托盘） */
  openApp: (appPath: string) => void
  /** 分离 spawn（win 串联 cmd / unix 拉起新网关 daemon）；verbatim = 参数原样传（cmd /s /c 引号语义需要） */
  spawnDetached: (file: string, args: string[], opts?: { verbatim?: boolean }) => void
  /** 更新前的网关存活状态（决定换完是否拉回） */
  gatewayWasLive: () => Promise<boolean>
}

export function defaultInstallDeps(): InstallDeps {
  return {
    stopGateway: async () => {
      const { cmdGatewayStop } = await import('../cli/gatewaycmd.js')
      await cmdGatewayStop()
    },
    stopTray: async () => {
      await stopTrayProcesses()
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
  }
}

/** 停托盘：按命令行精确匹配 ModelDockTray（不按映像名全局杀）。尽力而为，失败静默。 */
async function stopTrayProcesses(): Promise<void> {
  try {
    const [{ listProcessLines }, { parsePidCommandLines, killByPid }] = await Promise.all([
      import('../cli/gatewaycmd.js'),
      import('../cli/shared.js'),
    ])
    const lines = listProcessLines()
    if (!lines) return
    for (const { pid, cmd } of parsePidCommandLines(lines)) {
      // 匹配托盘可执行名；排除本进程与自身路径里的误配（托盘进程极小概率自己重名）
      if (!/ModelDockTray(\.exe)?(\s|$|")/i.test(cmd)) continue
      // 已退出/权限不足：托盘残留不影响新版本运行
      killByPid(pid)
    }
  } catch {
    /* 进程枚举不可用时跳过（不影响主流程） */
  }
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

/** 识别当前安装形态（纯函数；win 用显式参数而非读环境，便于三平台测试） */
export function detectInstallShape(
  execPath: string,
  platform: string,
  localAppData?: string
): InstallShape {
  if (platform === 'darwin') {
    return MAC_APP_RE.test(execPath) ? 'mac-app' : 'bare'
  }
  if (platform === 'win32') {
    const lad = localAppData ?? 'C:\\Users\\u\\AppData\\Local'
    const prefix = (lad + path.sep + path.join('Programs', 'ModelDock')).toLowerCase().replace(/\\/g, '/')
    const norm = execPath.toLowerCase().replace(/\\/g, '/')
    return norm.startsWith(prefix + '/') ? 'win-setup' : 'win-bare'
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

/** 裸二进制 rename dance：newBin 换到 targetBin 位置，旧文件保留为 .old。Windows 允许改名运行中 exe。 */
export async function installBareBinary(newBin: string, targetBin: string): Promise<void> {
  await checkWritable(path.dirname(targetBin))
  const staging = targetBin + '.new'
  await fsp.copyFile(newBin, staging)
  if (process.platform !== 'win32') await fsp.chmod(staging, 0o755)
  const old = targetBin + '.old'
  await fsp.rm(old, { force: true }).catch(() => {})
  await fsp.rename(targetBin, old)
  try {
    await fsp.rename(staging, targetBin)
  } catch (e) {
    await fsp.rename(old, targetBin).catch(() => {})
    throw e
  }
}

async function checkWritable(dir: string): Promise<void> {
  try {
    await fsp.access(dir, fs.constants.W_OK)
  } catch {
    throw new UpdateError(
      t(
        '安装目录不可写：{d}。macOS 请确认 ModelDock.app 在「应用程序」且当前用户是管理员；或用 sudo 修正属主后重试',
        'Install directory is not writable: {d}. On macOS make sure ModelDock.app is in Applications and the current user is an admin; fix ownership (sudo) and retry',
        { d: dir }
      )
    )
  }
}

/** win 静默安装命令构造（纯函数）：更新器退出后由 cmd 等 setup 退出再拉托盘。trayPath 缺省（构建无托盘）时只装。 */
export function buildWinInstallerCommand(
  setupPath: string,
  trayPath: string | null
): { file: string; args: string[] } {
  const inner = trayPath
    ? `"${setupPath}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS && start "" "${trayPath}"`
    : `"${setupPath}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS`
  // /s /c + 首尾引号：cmd 剥掉外层引号后按内层解析，含空格路径安全
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${inner}"`] }
}

// 解压

// 注：解压原语已收敛到 transfer.ts 的 extractArchive（tar / Expand-Archive 平台分支、可注入执行器），
// 本域 run.ts 经 src/update/run.ts 从 transfer 引入，install.ts 不再各自维护一份。

// 收尾

/** 清理上一版残留（.old）：mac-app = <appRoot>.old；裸二进制 = <bin>.old。找不到就静默返回。 */
export async function cleanOldVersions(execPath: string): Promise<string[]> {
  const removed: string[] = []
  const candidates: string[] = []
  const appRoot = appRootFromExecPath(execPath)
  if (appRoot) candidates.push(appRoot + '.old')
  else candidates.push(execPath + '.old')
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

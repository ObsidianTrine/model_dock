import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homeDir, modeldockDir } from './util/paths.js'
import { t } from './util/i18n.js'
import { VERSION } from './version.js'

/**
 * CLI 自动安装（VS Code「Install 'code' command in PATH」模式）：双击 GUI 启动时把
 * `modeldock` 命令装进 PATH——macOS 在 /usr/local/bin 建软链指向当前 .app 内二进制
 * （不可写时弹一次管理员授权，拒绝后记住不再打扰）；Windows 把自身复制进
 * %LOCALAPPDATA%\Microsoft\WindowsApps（用户 PATH 默认含此目录，装 Windows 安装器后
 * 目录本身已在 PATH，自动跳过）。Linux 无双击场景，不处理。
 *
 * 测试钩子：MODELRDOCK_CLI_BIN_DIR 重定向安装位（单测/手测绝不碰真实 /usr/local/bin）。
 */

export interface CliInstallResult {
  action: 'installed' | 'updated' | 'current' | 'skipped' | 'declined' | 'aborted'
  path?: string
  note?: string
}

export const declinedMarker = () => path.join(modeldockDir(), 'cli-install-declined')

/** CLI 命令安装目录；null = 该平台不做自动安装 */
export function cliBinDir(): string | null {
  if (process.env.MODELRDOCK_CLI_BIN_DIR) return process.env.MODELRDOCK_CLI_BIN_DIR
  if (process.platform === 'darwin') return '/usr/local/bin'
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(homeDir(), 'AppData', 'Local')
    return path.join(base, 'Microsoft', 'WindowsApps')
  }
  return null
}

/** `modeldock` 命令的完整路径（cliBinDir 为 null 时同样 null） */
export function cliLinkPath(): string | null {
  const dir = cliBinDir()
  if (!dir) return null
  return path.join(dir, process.platform === 'win32' ? 'modeldock.exe' : 'modeldock')
}

/** 纯操作：把 target 以软链形式装到 link，幂等且自愈（旧链失效/普通文件占用都会重建）。
 *  拆出来是为了各 CI 平台都能单测软链语义（Windows 软链需特权，测试里跳过）。 */
export async function installBySymlink(
  link: string,
  target: string
): Promise<Exclude<CliInstallResult['action'], 'skipped' | 'declined'>> {
  await fs.promises.mkdir(path.dirname(link), { recursive: true })
  let action: 'installed' | 'updated' = 'installed'
  try {
    const st = await fs.promises.lstat(link)
    action = 'updated'
    if (st.isSymbolicLink()) {
      try {
        if (fs.realpathSync(link) === fs.realpathSync(target)) return 'current'
      } catch { /* 悬空软链：按需重建 */ }
    }
    await fs.promises.unlink(link)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  await fs.promises.symlink(target, link)
  return action
}

/** 纯操作：把 target 复制为 copyPath，用 markerPath 里的版本号做幂等（避免每次双击都拷上百 MB） */
export async function installByCopy(
  copyPath: string,
  target: string,
  markerPath: string,
  version = VERSION
): Promise<Exclude<CliInstallResult['action'], 'skipped' | 'declined'>> {
  // 目标即自身（从 PATH 上的副本直接运行且该副本就是落点）：对运行中的 exe 自拷贝在 Windows 上
  // 报 sharing violation，每次双击静默失败、版本 marker 永不更新——原位即视为已安装
  if (path.resolve(copyPath) === path.resolve(target)) return 'current'
  await fs.promises.mkdir(path.dirname(copyPath), { recursive: true })
  let existed = false
  try {
    const [st, marker] = await Promise.all([
      fs.promises.stat(copyPath),
      fs.promises.readFile(markerPath, 'utf8').catch(() => ''),
    ])
    existed = true
    if (marker.trim() === version && st.size === (await fs.promises.stat(target)).size) return 'current'
  } catch { /* 不存在 → 全新安装 */ }
  await fs.promises.copyFile(target, copyPath)
  await fs.promises.writeFile(markerPath, version + '\n')
  return existed ? 'updated' : 'installed'
}

/** AppleScript 提权执行（管理员密码弹窗）。返回是否成功；用户取消 → false。
 *  传 signal 时，abort（如 GUI 超时退出）会 kill 子进程并返回 false，避免弹窗孤儿续跑。 */
export function osaAdminRun(script: string, signal?: AbortSignal, spawnFn: typeof spawn = spawn): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawnFn('osascript', ['-e', script], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
    if (!signal) return
    if (signal.aborted) {
      child.kill()
      resolve(false)
      return
    }
    signal.addEventListener('abort', () => { child.kill(); resolve(false) }, { once: true })
  })
}

/** shell 单引号安全转义（AppleScript do shell script 内层） */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** macOS 13+ Finder 解压会传播 quarantine 隔离属性，连累软链出的 CLI 在终端被 Gatekeeper 拦；
 *  对自身 bundle 做一次自愈清除（best-effort，失败不影响主流程）。 */
function healQuarantine(execPath: string): void {
  const m = /^(.+?\.app)\//.exec(execPath)
  if (!m) return
  const child = spawn('xattr', ['-dr', 'com.apple.quarantine', m[1]], { stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

/** 双击 GUI 启动时调用：确保 `modeldock` 命令在 PATH 里。失败一律不阻断 GUI。
 *  传 signal 时提权弹窗受其节制（超时 kill 子进程），超时不写「已拒绝」标记以便下次重试。 */
export async function ensureCliInstalled(signal?: AbortSignal): Promise<CliInstallResult> {
  const link = cliLinkPath()
  if (!link) return { action: 'skipped', note: t('当前平台无双击安装场景', 'No double-click install on this platform') }

  if (process.platform === 'win32') {
    // 安装器/npm 已把所在目录管进 PATH 时无需副本（避免同一命令两份）
    const exeDir = path.dirname(process.execPath).trim().toLowerCase()
    const onPath = (process.env.PATH || '').split(path.delimiter).some((p) => p.trim().toLowerCase() === exeDir)
    if (onPath) return { action: 'skipped', path: process.execPath, note: t('所在目录已在 PATH', 'Its directory is already on PATH') }
    const marker = path.join(modeldockDir(), 'cli-copy-version')
    const action = await installByCopy(link, process.execPath, marker)
    return { action, path: link }
  }

  // macOS
  healQuarantine(process.execPath)
  try {
    const action = await installBySymlink(link, process.execPath)
    await fs.promises.rm(declinedMarker(), { force: true })
    return { action, path: link }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'EPERM') throw e
  }
  // /usr/local/bin 不可写：弹管理员授权（VS Code 同款）；拒绝过一次就不再打扰
  if (fs.existsSync(declinedMarker())) {
    return { action: 'skipped', path: link, note: t('此前已拒绝管理员授权', 'Admin authorization was declined earlier') }
  }
  const script =
    `do shell script "mkdir -p ${shQuote(path.dirname(link))} && ln -sfn ${shQuote(process.execPath)} ${shQuote(link)}" ` +
    'with administrator privileges'
  const ok = await osaAdminRun(script, signal)
  if (signal?.aborted) {
    // 超时中止：不写「已拒绝」标记，下次双击仍可重试提权
    return { action: 'aborted', path: link, note: t('安装已超时中止，可稍后重试', 'Installation timed out; you can retry later') }
  }
  if (!ok) {
    await fs.promises.mkdir(modeldockDir(), { recursive: true })
    await fs.promises.writeFile(declinedMarker(), '')
    return { action: 'declined', path: link, note: t('用户取消了管理员授权', 'Admin authorization was cancelled') }
  }
  await fs.promises.rm(declinedMarker(), { force: true })
  return { action: 'updated', path: link }
}

/** 摘除自动安装的 CLI 入口（uninstall 联动）。已由 root 建链且目录不可写时走一次提权，用户取消则留下并说明。 */
export async function removeCliLink(): Promise<{ removed: boolean; path?: string; note?: string }> {
  const link = cliLinkPath()
  if (!link || !fs.existsSync(link)) return { removed: false }
  try {
    await fs.promises.unlink(link)
    return { removed: true, path: link }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (process.platform !== 'darwin' || (code !== 'EACCES' && code !== 'EPERM')) {
      return { removed: false, path: link, note: (e as Error).message }
    }
  }
  const ok = await osaAdminRun(`do shell script "rm -f ${shQuote(link)}" with administrator privileges`)
  return ok
    ? { removed: true, path: link }
    : { removed: false, path: link, note: t('需要管理员权限，已保留；可手动删除', 'Admin privileges are required; it was kept in place — delete it manually') }
}

/** 开机自启登记用：SEA 进程若运行在临时位置（如 Downloads 里的 .app），优先用已安装的稳定命令路径。
 *  非 SEA 调用（npm/dev，execPath 是 node）返回 null，不改变既有行为。 */
export function preferInstalledCli(execPath: string): string | null {
  if (!path.basename(execPath).toLowerCase().startsWith('modeldock')) return null
  const link = cliLinkPath()
  if (!link || link === execPath) return null
  try {
    fs.statSync(link)
    return link
  } catch {
    return null
  }
}

/**
 * 自动更新 M1——编排层（实施基准：docs/design-auto-update.md §3/§5.4）
 *
 * 顺序刻意安排为：发现 → 下载 → 校验 → 才停实例 → 换 → 拉起。
 * 下载与校验（最慢、最易失败）放在停实例之前，把网关中断窗口压到最短；
 * 校验不过绝不触碰安装位置。Web 控制台一键更新（M2）复用本函数。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { c, t } from '../util/index.js'
import { VERSION } from '../version.js'
import {
  UpdateError,
  compareVersions,
  downloadAsset,
  fetchChecksums,
  fetchLatestRelease,
  findAsset,
  selectAssetName,
  verifyChecksum,
  type InstallShape,
  type ReleaseManifest,
} from './check.js'
import {
  appRootFromExecPath,
  buildWinInstallerCommand,
  cleanOldVersions,
  defaultInstallDeps,
  detectInstallShape,
  installBareBinary,
  installMacApp,
  type InstallDeps,
} from './install.js'
import { extractArchive } from './transfer.js'
import { notesSummaryText } from './notes.js'
import { writeUpdateProgress } from './progress.js'
import { DEFAULT_UPDATE_MIRRORS } from '../config/types.js'

export interface UpdateRunOptions {
  repo: string
  /** GitHub 访问令牌；null = 匿名（公开仓库默认；PAT 可选——私有仓库必需/提升限流） */
  token: string | null
  yes: boolean
  /** 确认交互（CLI 默认 @inquirer/prompts；--yes / Web 端点传 () => true） */
  confirm: (message: string) => Promise<boolean>
  deps?: InstallDeps
  /** 测试注入：GitHub API 基地址（默认 https://api.github.com） */
  apiBase?: string
  /** 下载镜像前缀列表（design §6 第 4 项；缺省 DEFAULT_UPDATE_MIRRORS，空数组=关闭镜像只走官方） */
  mirrors?: string[]
  /** 测试注入：下载重试间隔 ms（默认 2000） */
  retryDelayMs?: number
  /** 测试注入：以这个 execPath 识别安装形态（默认 process.execPath） */
  execPath?: string
  log?: (msg: string) => void
}

export interface UpdateRunResult {
  updated: boolean
  currentVersion: string
  latestVersion: string
  /** 只检查（未到安装步）时为 true */
  checkedOnly?: boolean
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 「已是最新」早退判定（runUpdate / checkUpdate 两路复用）：版本不高于当前即打行并返回 true，
 * 调用方据此直接返回 checkedOnly 结果，避免复制 fetchLatestRelease→compareVersions 块。
 */
export function logAlreadyUpToDate(
  m: ReleaseManifest,
  log: (msg: string) => void
): UpdateRunResult | null {
  if (compareVersions(m.version, VERSION) > 0) return null
  log(c.green(t('已是最新版本（v{v}）', 'Already up to date (v{v})', { v: VERSION })))
  return { updated: false, currentVersion: VERSION, latestVersion: m.version, checkedOnly: true }
}

/**
 * 打印发布说明：首段摘要 + 至多几条点题 + 发布页链接（详细条目全在发布页）。
 * 托盘把这段输出直接当原生弹窗正文，因此只输出纯文本，且链接单独成行
 * （形如 `完整说明：https://…`，托盘按 http(s) 正则取出即可加「打开发布页」按钮）。
 */
function logReleaseNotes(m: ReleaseManifest, log: (msg: string) => void): void {
  const text = notesSummaryText(m.notes)
  if (text) log(c.gray(text))
  if (m.htmlUrl) log(c.gray(t('完整说明：{u}', 'Full notes: {u}', { u: m.htmlUrl })))
}

export async function runUpdate(opts: UpdateRunOptions): Promise<UpdateRunResult> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const deps = opts.deps ?? defaultInstallDeps()
  const execPath = opts.execPath ?? process.execPath
  const platform = process.platform

  log(c.gray(t('正在检查新版本…', 'Checking for a new version…')))
  // 第三参必须显式传 LOCALAPPDATA：漏传时 win-setup 判定回落占位用户目录（C:\Users\u\…），
  // 真机路径永远不匹配 → 安装器用户被误判 win-bare，自更新退化成裸 zip 替换（跳过安装器登记、托盘不随更）
  const shape: InstallShape = detectInstallShape(execPath, platform, process.env.LOCALAPPDATA)
  // 开发态保护：tsx 直跑源码时 execPath 是 node 运行时，裸二进制替换会把 node 换成 SEA 包（毁掉 dev 环境）。
  // 覆盖 bare 与 win-bare 两种裸形态（Windows dev 态 execPath=node.exe 归 win-bare，漏掉会把 node.exe 换掉）；
  // 正式安装的 ModelDock（SEA 二进制 basename 一律 modeldock* / ModelDock）不受影响；守卫放在下载前，点了也不会发起网络请求。
  if ((shape === 'bare' || shape === 'win-bare') && path.basename(execPath).toLowerCase().startsWith('node')) {
    throw new UpdateError(
      t(
        '当前是开发态（tsx 直跑源码），不支持自更新；请用正式安装的 ModelDock 执行 modeldock update，或用安装包/安装器升级',
        'Running from source (tsx): self-update is not supported. Run modeldock update from an installed ModelDock, or upgrade with the installer/package'
      )
    )
  }
  const m: ReleaseManifest = await fetchLatestRelease(opts.repo, opts.token, opts.apiBase)
  const already = logAlreadyUpToDate(m, log)
  if (already) return already

  const assetName = selectAssetName(shape, platform, process.arch, m.version)
  const asset = assetName ? findAsset(m, assetName) : null
  if (!asset) {
    const list = m.assets.map((a) => a.name).join(', ')
    throw new UpdateError(
      t(
        '发布 v{v} 里没有适配本机的安装包（需要 {n}）。可用资产：{list}',
        'Release v{v} has no package matching this machine (expected {n}). Available assets: {list}',
        { v: m.version, n: assetName ?? '?', list }
      )
    )
  }

  log(c.bold(t('发现新版本 v{a}（当前 v{b}）', 'New version found: v{a} (current v{b})', { a: m.version, b: VERSION })))
  logReleaseNotes(m, log)
  log(t('将下载 {n}（{s}）并替换本机安装，期间网关会短暂中断', 'Will download {n} ({s}) and replace this install; the gateway pauses briefly', { n: asset.name, s: mb(asset.size) }))
  if (!opts.yes) {
    const goOn = await opts.confirm(t('继续更新？', 'Continue the update?'))
    if (!goOn) {
      log(c.gray(t('已取消，未做任何改动', 'Cancelled; nothing was changed')))
      return { updated: false, currentVersion: VERSION, latestVersion: m.version, checkedOnly: true }
    }
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-update-'))
  try {
    // 进度文件从「下载」阶段开始写：托盘进度窗与控制台卡片据此展示，更新期间界面不再毫无动静
    await writeUpdateProgress('downloading', 0, asset.size)
    log(t('下载中…', 'Downloading…'))
    const file = await downloadAsset(opts.repo, opts.token, asset, tmpDir, {
      apiBase: opts.apiBase,
      mirrors: opts.mirrors ?? DEFAULT_UPDATE_MIRRORS,
      ...(opts.retryDelayMs != null ? { retryDelayMs: opts.retryDelayMs } : {}),
      onProgress: (received, total) => {
        void writeUpdateProgress('downloading', received, total)
      },
    })
    await writeUpdateProgress('verifying', asset.size, asset.size)
    log(t('校验 SHA256…', 'Verifying SHA256…'))
    // SUMS 刻意不走镜像：完整性锚点必须来自官方 API（design §8）
    const sums = await fetchChecksums(opts.repo, opts.token, m, {
      apiBase: opts.apiBase,
      ...(opts.retryDelayMs != null ? { retryDelayMs: opts.retryDelayMs } : {}),
    })
    await verifyChecksum(file, sums)
    log(c.green(t('✓ 校验通过', '✓ Verified')))

    // 校验全过，才进入停机替换段
    await writeUpdateProgress('swapping', asset.size, asset.size)
    const wasLive = await deps.gatewayWasLive()
    log(t('停止网关与托盘…', 'Stopping the gateway and tray…'))
    await deps.stopGateway()
    await deps.stopTray()

    try {
      if (shape === 'mac-app') {
        const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-app-'))
        try {
          await extractArchive(file, staging)
          const appRoot = appRootFromExecPath(execPath)
          if (!appRoot) throw new UpdateError(t('无法定位 ModelDock.app 安装位置', 'Cannot locate the ModelDock.app install path'))
          await installMacApp(staging, appRoot)
        } finally {
          await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
        }
        log(c.green(t('✓ 已更新到 v{v}，正在重新启动 ModelDock…', '✓ Updated to v{v}; restarting ModelDock…', { v: m.version })))
        deps.openApp(appRootFromExecPath(execPath)!)
      } else if (shape === 'win-setup') {
        // setup.exe 不能在更新器还持有自身 exe 锁时等待它跑完：分离拉起 cmd 串联
        // （安装器静默装完 → 自动拉起新托盘），更新器随即退出释放锁。
        const cmd = buildWinInstallerCommand(file, path.join(path.dirname(execPath), 'ModelDockTray.exe'))
        log(c.green(t('✓ 已校验，正在静默安装 v{v}（完成后自动拉起托盘）…', '✓ Verified; installing v{v} silently (the tray relaunches automatically)…', { v: m.version })))
        deps.spawnDetached(cmd.file, cmd.args, { verbatim: true })
        // 安装器成败异步发生，更新器必须立即退出释放自身 exe 锁，无人能替它收尾：
        // 进度停在 restarting（托盘对 10 分钟未刷新的进度文件按残留过期自动收起），不谎报 done
        await writeUpdateProgress('restarting', asset.size, asset.size)
        return { updated: true, currentVersion: VERSION, latestVersion: m.version }
      } else {
        const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-bin-'))
        try {
          await extractArchive(file, staging)
          const entries = await fsp.readdir(staging)
          const entryName = platform === 'win32' ? 'modeldock.exe' : 'modeldock'
          const newBin = path.join(staging, entryName)
          if (!entries.includes(entryName) || !fs.existsSync(newBin)) {
            throw new UpdateError(t('更新包里没有入口程序 {n}，包内容异常；已中止', 'The update package does not contain the entry program {n}; aborted', { n: entryName }))
          }
          await installBareBinary(newBin, execPath)
        } finally {
          await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
        }
        log(c.green(t('✓ 已更新到 v{v}', '✓ Updated to v{v}', { v: m.version })))
        if (wasLive) {
          deps.spawnDetached(execPath, ['--sea-gateway'])
          log(c.green(t('✓ 网关已按原状态拉起', '✓ Gateway restarted as before')))
        } else {
          log(c.gray(t('网关之前未在运行，未自动拉起（需要时：modeldock gateway start --daemon）', 'The gateway was not running; not started automatically (start with: modeldock gateway start --daemon)')))
        }
      }
    } catch (e) {
      // 替换段失败：网关已停，必须给出可操作的恢复路径
      log(c.red(t('✗ 安装失败：{m}', '✗ Install failed: {m}', { m: (e as Error).message })))
      log(c.yellow(t('网关当前已停止。重试：modeldock update；或回滚/启动：见上方保留的 .old（mac 把 <安装位置>.old 改回原名），裸安装可 modeldock gateway start --daemon', 'The gateway is now stopped. Retry with modeldock update; or roll back (on macOS rename <install path>.old back) / start with modeldock gateway start --daemon')))
      throw e
    }

    await writeUpdateProgress('restarting', asset.size, asset.size)
    log(c.green(t('全部完成。旧版残留可用 modeldock update --clean 清理', 'All done. Clean up the previous version with modeldock update --clean')))
    await writeUpdateProgress('done', asset.size, asset.size)
    return { updated: true, currentVersion: VERSION, latestVersion: m.version }
  } catch (e) {
    // 下载/校验/安装任一步失败：进度文件标 failed（读方据此展示失败而非无限转圈）
    await writeUpdateProgress('failed', 0, 0, (e as Error).message)
    throw e
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** --check：只看不装（不下载大文件，不发确认） */
export async function checkUpdate(repo: string, token: string | null, opts: { apiBase?: string; log?: (m: string) => void } = {}): Promise<UpdateRunResult> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const m = await fetchLatestRelease(repo, token, opts.apiBase)
  const already = logAlreadyUpToDate(m, log)
  if (already) return already
  log(c.bold(t('有新版本：v{a}（当前 v{b}）', 'New version available: v{a} (current v{b})', { a: m.version, b: VERSION })))
  logReleaseNotes(m, log)
  log(t('执行 modeldock update 安装', 'Run modeldock update to install'))
  return { updated: false, currentVersion: VERSION, latestVersion: m.version, checkedOnly: true }
}

/** --clean：清 .old 残留（须显式确认安装位置，绝不清别的） */
export async function cleanUpdateRemnants(execPath: string, log: (m: string) => void = (x) => console.log(x)): Promise<string[]> {
  const removed = await cleanOldVersions(execPath)
  if (removed.length) {
    for (const r of removed) log(c.green(t('✓ 已清理：{p}', '✓ Removed: {p}', { p: r })))
  } else {
    log(c.gray(t('没有发现旧版残留', 'No previous-version leftovers found')))
  }
  return removed
}

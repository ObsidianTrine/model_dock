#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { buildProgram } from './cli/index.js'
import { exitWithThrown, openUrlInBrowser } from './cli/shared.js'
import { spawnTrayIfPresent, spawnTrayWhenGatewayReady } from './tray.js'
import { t } from './util/i18n.js'

function isSEA(): boolean {
  const exe = path.basename(process.execPath).toLowerCase()
  return exe.startsWith('modeldock')
}

// SEA 网关模式：独立可执行文件自身作为 daemon 子进程时，直接启动网关
if (process.argv.includes('--sea-gateway')) {
  void (async () => {
    // Windows 注册表 Run 键自启：Explorer 直启控制台程序会常驻黑窗，先分离重拉隐藏 daemon
    // （Run 键登记的命令带 --autostart 标记；重拉失败或手动运行时照常前台启动）
    const { relaunchHiddenIfAutostart } = await import('./autostart.js')
    if (await relaunchHiddenIfAutostart()) return
    const [{ startForeground }, { initLang }] = await Promise.all([import('./gateway/main.js'), import('./config/lang.js')])
    await initLang()
    const idx = process.argv.indexOf('--port')
    const port = idx >= 0 ? Number(process.argv[idx + 1]) : undefined
    // 自启（Run 键 / LaunchAgent / systemd）只登记 daemon，托盘在此等网关就绪后补拉——
    // 不拉的话重启后托盘永远缺席（npm/dev 形态 execPath 旁无托盘二进制，自动跳过）
    void spawnTrayWhenGatewayReady()
    return startForeground(port)
  })().catch((e) => {
    console.error(t('✗ 网关启动失败: {msg}', '✗ Failed to start gateway: {msg}', { msg: (e as Error).message }))
    process.exit(1)
  })
} else if (isSEA() && process.argv.length <= 2) {
  // SEA 双击启动：后台网关 + 打开浏览器
  launchGui().catch((e) => {
    console.error(`✗ ${(e as Error).message}`)
    process.exit(1)
  })
} else {
  // 语言解析必须在 buildProgram() 之前：commander 帮助文案在构建期求值
  import('./config/lang.js')
    .then(({ initLang }) => initLang(process.argv))
    .then((rest) => buildProgram().parseAsync(rest))
    // 统一出口：业务错误类打「✗ message + 提示: hint」两行，未知错误只打 message（见 shared.exitWithThrown）
    .catch((e) => exitWithThrown(e))
}

async function launchGui(): Promise<void> {
  const { initLang } = await import('./config/lang.js')
  await initLang()
  const { loadCfg, gatewayLive, DEFAULT_GATEWAY_PORT, spawnDaemonAndWait } = await import('./cli/shared.js')
  const { sleep } = await import('./util/index.js')
  const { displayPath } = await import('./util/paths.js')

  const cfg = await loadCfg()
  const port = cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT

  let live = await gatewayLive()
  if (!live) {
    console.log(t('正在启动 ModelDock 网关...', 'Starting ModelDock gateway...'))
    // GUI 双击路径用 30s 等待（与 CLI 安装等待对齐）：未签名 SEA 冷启逢 Defender/SmartScreen
    // 扫描可能 >5s，默认 5s 会误报「启动超时」而 daemon 数秒后照常起，用户重双击才恢复
    const { spawn: nodeSpawn } = await import('node:child_process')
    const daemon = await spawnDaemonAndWait([process.execPath, '--sea-gateway', '--port', String(port)], gatewayLive, nodeSpawn, 120)
    if (!daemon) {
      console.error(
        t(
          '网关启动超时。可在命令行运行 modeldock gateway start 查看详细错误。',
          'Gateway start timed out. Run "modeldock gateway start" in a terminal for details.'
        )
      )
      await sleep(3000)
      process.exit(1)
    }
    live = daemon
    console.log(t('网关已启动：http://127.0.0.1:{port}', 'Gateway started: http://127.0.0.1:{port}', { port: live.port }))
  } else {
    console.log(t('网关已在运行：http://127.0.0.1:{port}', 'Gateway already running: http://127.0.0.1:{port}', { port: live.port }))
  }

  // 打开 Web 控制台（携带 admin 令牌，与 modeldock ui 行为一致；服务端校验通过后种 cookie 并重定向到干净 URL）
  const url = `http://127.0.0.1:${live.port}/_modeldock/ui?token=${live.admin_token}`
  await openConsole(url)

  // 菜单栏/托盘：与 daemon 自启路径共用拉起逻辑（tray.ts），托盘内部单实例挡重复拉起
  spawnTrayIfPresent()

  // CLI 自动安装（幂等）：等待有界时间——GUI 进程没有别的东西拖住事件循环，
  // 不等待的话首次双击可能在软链落盘前就退出。超时中止 osascript 提权弹窗（避免弹窗孤儿
  // 续跑把结果写进死控制台），并提示改由命令行手动完成。
  const { ensureCliInstalled, declinedMarker } = await import('./cliinstall.js')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 30_000)
  let cancelled = false
  ac.signal.addEventListener('abort', () => { cancelled = true })
  try {
    const r = await ensureCliInstalled(ac.signal)
    if (r.action === 'installed' || r.action === 'updated') {
      console.log(
        t('已安装命令行 {path}（新开的终端可直接使用 modeldock）', 'CLI installed at {path} (new terminals can use modeldock directly)', {
          path: r.path ?? '',
        })
      )
    } else if (r.action === 'declined') {
      console.log(
        t(
          '已跳过命令行安装（{note}）。想再装一次：删除 {marker} 后重新启动',
          'CLI installation skipped ({note}). To retry: delete {marker} and relaunch',
          { note: r.note ?? '', marker: displayPath(declinedMarker()) }
        )
      )
    }
  } catch {
    /* CLI 安装失败不阻断 GUI */
  }
  clearTimeout(timer)
  if (cancelled) {
    console.log(
      t(
        '命令行安装超时已中止。可稍后在终端运行 modeldock 或执行安装命令手动配置。',
        'CLI installation timed out and was aborted. You can run "modeldock" in a terminal (or the install command) later to set it up.'
      )
    )
  }

  // Windows 双击场景：保持控制台窗口让用户看到状态，然后退出
  // 网关已在后台独立进程运行，此进程可以安全退出
  if (process.platform === 'win32') {
    console.log(t('\n按任意键关闭此窗口（网关在后台继续运行）...', '\nPress any key to close this window (the gateway keeps running in the background)...'))
    await new Promise<void>((resolve) => {
      process.stdin.setRawMode?.(true)
      process.stdin.resume()
      process.stdin.once('data', () => resolve())
      // 超时自动退出，避免永远挂着
      setTimeout(() => resolve(), 60_000)
    })
  }
}

/** 打开 Web 控制台：优先 Chromium 应用窗口（--app，无地址栏、任务栏独立图标），
 *  找不到 Chromium 内核浏览器或打开失败时回退系统默认浏览器。 */
async function openConsole(url: string): Promise<void> {
  console.log(t('正在打开 Web 控制台：{url}', 'Opening web console: {url}', { url }))
  if (process.env.MODELRDOCK_NO_OPEN) {
    console.log(t('（MODELRDOCK_NO_OPEN=1，保持关闭不弹窗）', '(MODELRDOCK_NO_OPEN=1, staying closed)'))
    return
  }
  if (await openAppWindow(url).catch(() => false)) return
  if (!(await openUrlInBrowser(url))) {
    console.log(t('无法自动打开浏览器，请手动访问：{url}', 'Could not open a browser automatically; visit: {url}', { url }))
  }
}

/** 尝试用 Chromium 内核浏览器弹 --app 独立窗口；找不到候选浏览器返回 false。
 *  spawn 成功即认为已交付（窗口是否弹出无法进一步探测，best-effort）。 */
async function openAppWindow(url: string): Promise<boolean> {
  let cmd: string | undefined
  let args: string[] = []
  if (process.platform === 'win32') {
    // Edge 是 Windows 10/11 必装组件，直接定位其常驻路径，不经 start 避免闪控制台
    const pf = (v: string | undefined, fallback: string) => v || fallback
    const candidates = [
      path.join(pf(process.env['ProgramFiles(x86)'], 'C:\\Program Files (x86)'), 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf(process.env.ProgramFiles, 'C:\\Program Files'), 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]
    cmd = candidates.find((p) => fs.existsSync(p))
    if (!cmd) return false
    args = ['--app=' + url, '--no-first-run', '--no-default-browser-check']
  } else if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app',
      '/Applications/Microsoft Edge.app',
      '/Applications/Chromium.app',
    ]
    const app = candidates.find((p) => fs.existsSync(p))
    if (!app) return false
    cmd = 'open'
    args = ['-na', app, '--args', '--app=' + url, '--no-first-run', '--no-default-browser-check']
  } else {
    return false
  }
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd!, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('spawn', () => { child.unref(); resolve(true) })
  })
}
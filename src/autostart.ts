import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite, ensureDir } from './util/fsx.js'
import { homeDir, logsDir, modeldockDir } from './util/paths.js'
import { t } from './util/i18n.js'
import { gatewayLive } from './gateway/state.js'
import { preferInstalledCli } from './cliinstall.js'

/** 开机自启（常驻）：把网关注册为登录自动拉起、崩溃自动重启的系统服务。
 *  macOS → LaunchAgent（KeepAlive 崩溃拉起）；Linux → systemd user unit（Restart）；
 *  Windows → 启动文件夹 VBS（登录自启，无崩溃拉起）。
 *  服务文件路径全部相对 home 推导，MODELRDOCK_FAKE_HOME 下自动隔离，测试可断言。 */

export const SERVICE_LABEL = 'com.modeldock.gateway'

export type AutostartKind = 'launchd' | 'systemd' | 'windows'

export function autostartKind(): AutostartKind | null {
  if (process.platform === 'darwin') return 'launchd'
  if (process.platform === 'linux') return 'systemd'
  if (process.platform === 'win32') return 'windows'
  return null
}

// ─── 服务文件路径 ─────────────────────────────────────────────────────────────

export function launchdPlistPath(): string {
  return path.join(homeDir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
}

export function systemdUnitPath(): string {
  return path.join(homeDir(), '.config', 'systemd', 'user', `${SERVICE_LABEL}.service`)
}

export function windowsStartupPath(): string {
  const base = process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming')
  return path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'modeldock-gateway.vbs')
}

export function serviceFilePath(): string | null {
  switch (autostartKind()) {
    case 'launchd': return launchdPlistPath()
    case 'systemd': return systemdUnitPath()
    case 'windows': return windowsStartupPath()
    default: return null
  }
}

/** 网关 daemon 的完整启动 argv（program + args），三种安装形态通用：
 *  SEA → 二进制自身 --sea-gateway；npm → node <bin cli.js> --sea-gateway；dev → node tsx cli.mjs <cli.ts> --sea-gateway。
 *  --sea-gateway 的分发在 cli.ts（三路分发第一路）；main.js/main.ts 无自启动分支，不能直接当 daemon 入口跑。 */
export function gatewayDaemonArgs(d?: { execPath?: string; entry?: string }): string[] {
  let execPath = d?.execPath ?? process.execPath
  // 显式传 entry: undefined 表示"无入口"（测试注入），不能被 ?? 吞掉回退到真实 argv
  const entry = d && 'entry' in d ? d.entry : process.argv[1]
  // 双击 Downloads 等临时位置里的 app 时，登记的应是稳定的已安装命令路径，而不是临时位置
  if (!d?.execPath) {
    const stable = preferInstalledCli(execPath)
    if (stable) execPath = stable
  }
  if (path.basename(execPath).toLowerCase().startsWith('modeldock')) return [execPath, '--sea-gateway']
  if (entry && /\.(ts|mts|cts)$/.test(entry)) {
    // dev（tsx 直跑 src/）：经项目内 tsx 跑 cli 入口
    const tsxCli = path.resolve(path.dirname(entry), '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
    if (fs.existsSync(tsxCli)) return [execPath, tsxCli, entry, '--sea-gateway']
    return [execPath, '--sea-gateway']
  }
  if (entry && /\.(js|mjs|cjs)$/.test(entry)) return [execPath, entry, '--sea-gateway']
  return [execPath, '--sea-gateway']
}

/** 一键更新子进程 argv：与网关守护同构的形态推导，尾参换成 `update --yes`。
 *  放在 autostart（gatewayDaemonArgs 的归属地）；webupdate 不静态依赖本模块——
 *  否则单测对 autostart 的整模块 mock 与共享模块注册表叠加时会把静态绑定击穿。 */
export function updateDaemonArgs(): string[] {
  const argv = gatewayDaemonArgs()
  if (argv[argv.length - 1] === '--sea-gateway') argv.pop()
  argv.push('update', '--yes')
  return argv
}

// ─── 服务文件内容生成（纯函数）───────────────────────────────────────────────

/** 登记的启动命令随文件落一份（base64 JSON），status/重装前校验用：
 *  nvm 升级 / 二进制移动后旧路径失效，自启会静默失败，必须能探出来。 */
const ARGV_MARK = 'modeldock-daemon-argv: '

function argvMark(argv: string[]): string {
  return ARGV_MARK + Buffer.from(JSON.stringify(argv), 'utf8').toString('base64')
}

export function readRecordedArgv(text: string): string[] | null {
  const m = text.match(/modeldock-daemon-argv: ([A-Za-z0-9+/=]+)/)
  if (!m) return null
  try {
    const v = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'))
    return Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0 ? (v as string[]) : null
  } catch {
    return null
  }
}

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function launchdPlistXml(argv: string[], workDir: string, outLog: string, errLog: string): string {
  const args = argv.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- ${argvMark(argv)} -->
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workDir)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
</dict>
</plist>
`
}

/** systemd ExecStart 参数引号包裹（路径可含空格）；%/$ 是 systemd 特殊字符需翻倍转义 */
function systemdQuote(s: string): string {
  return '"' + s.replace(/%/g, '%%').replace(/\$/g, '$$').replace(/"/g, '\\"') + '"'
}

/** 非 ExecStart 设置项同样会做 specifier 展开，% 需转义 */
function systemdPlain(s: string): string {
  return s.replace(/%/g, '%%')
}

export function systemdUnitIni(argv: string[], workDir: string, outLog: string, errLog: string): string {
  return `# 由 modeldock gateway install 生成，modeldock gateway uninstall 移除
# ${argvMark(argv)}
[Unit]
Description=ModelDock Gateway (local AI API gateway)
After=network-online.target

[Service]
ExecStart=${argv.map(systemdQuote).join(' ')}
WorkingDirectory=${systemdPlain(workDir)}
Restart=always
RestartSec=5
StandardOutput=append:${systemdPlain(outLog)}
StandardError=append:${systemdPlain(errLog)}

[Install]
WantedBy=default.target
`
}

export function windowsVbs(argv: string[]): string {
  // Run 第二参 0 = 隐藏窗口；VB 字符串内引号翻倍，整个命令行作为单个带引号值传递
  const cmd = argv.map((a) => `"${a}"`).join(' ')
  const lit = '"' + cmd.replace(/"/g, '""') + '"'
  return `' 由 modeldock gateway install 生成；删除本文件即取消开机自启\r\n' ${argvMark(argv)}\r\nCreateObject("WScript.Shell").Run ${lit}, 0, False\r\n`
}

// ─── 状态 / 安装 / 卸载 ──────────────────────────────────────────────────────

function execOk(cmd: string, args: string[], timeoutMs = 5000): { ok: boolean; output: string } {
  try {
    const r = spawnSync(cmd, args, { timeout: timeoutMs, encoding: 'utf8' })
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    return { ok: r.status === 0, output }
  } catch {
    return { ok: false, output: t('{cmd} 不可用', '{cmd} is not available', { cmd }) }
  }
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

export interface AutostartStatus {
  kind: AutostartKind
  installed: boolean
  /** 已加载到 init 系统（launchd bootstrap / systemd enable）；windows 恒等于 installed */
  loaded: boolean
  /** 登记的启动命令里有文件已不存在（如 nvm 升级、二进制移动），下次登录自启会失败 */
  stale: boolean
  file: string
  argv: string[]
}

/** 完整状态（含 init 系统查询，spawnSync 级开销）——CLI / 诊断用；
 *  overview 等 5s 轮询路径请用 autostartOverview()（纯 stat，无 spawn）。 */
export function autostartStatus(): AutostartStatus | null {
  const kind = autostartKind()
  const file = serviceFilePath()
  if (!kind || !file) return null
  const installed = fs.existsSync(file)
  if (!installed) return { kind, installed: false, loaded: false, stale: false, file, argv: gatewayDaemonArgs() }
  const text = fs.readFileSync(file, 'utf8')
  const argv = readRecordedArgv(text) ?? gatewayDaemonArgs()
  let loaded = true
  if (kind === 'launchd') {
    const uid = currentUid()
    loaded = uid != null && execOk('launchctl', ['print', `gui/${uid}/${SERVICE_LABEL}`]).ok
  } else if (kind === 'systemd') {
    loaded = execOk('systemctl', ['--user', 'is-enabled', `${SERVICE_LABEL}.service`]).ok
  }
  const stale = !argv[0] || !fs.existsSync(argv[0]) || argv.slice(1).some((a) => !a.startsWith('--') && !fs.existsSync(a))
  return { kind, installed, loaded, stale, file, argv }
}

/** overview 轮询用轻量状态：仅 stat 服务文件，无任何 spawn */
export function autostartOverview(): { installed: boolean; kind: AutostartKind } | null {
  const kind = autostartKind()
  const file = serviceFilePath()
  if (!kind || !file) return null
  return { installed: fs.existsSync(file), kind }
}

export interface AutostartInstallResult {
  kind: AutostartKind
  file: string
  argv: string[]
  /** true = 已由 init 系统立即拉起；false = 仅登记服务文件（当前已有网关在运行，下次登录接管） */
  started: boolean
  note?: string
}

/** 安装开机自启。网关已在运行时只登记文件、不 bootstrap（否则第二个实例被单实例保护
 *  拒掉，KeepAlive 会陷入重启循环）；未运行时立即拉起并等健康端点就绪。
 *  opts.argv：注入 daemon 启动命令（测试用——缺省按当前运行时形态推导，vitest 下
 *  会登记 node+vitest-cli 而非产品网关，无法做真实链路测试）。 */
export async function installAutostart(opts: { argv?: string[] } = {}): Promise<AutostartInstallResult> {
  const kind = autostartKind()
  if (!kind) {
    throw new Error(
      t(
        '当前平台不支持开机自启（支持 macOS / Linux systemd / Windows）',
        'Autostart is not supported on this platform (supported: macOS / Linux systemd / Windows)'
      )
    )
  }
  await ensureDir(modeldockDir())
  await ensureDir(logsDir())
  const argv = opts.argv ?? gatewayDaemonArgs()
  const outLog = path.join(logsDir(), 'service-out.log')
  const errLog = path.join(logsDir(), 'service-err.log')
  const workDir = modeldockDir()

  let file: string
  let content: string
  if (kind === 'launchd') {
    file = launchdPlistPath()
    content = launchdPlistXml(argv, workDir, outLog, errLog)
  } else if (kind === 'systemd') {
    file = systemdUnitPath()
    content = systemdUnitIni(argv, workDir, outLog, errLog)
    await ensureDir(path.dirname(file))
  } else {
    file = windowsStartupPath()
    content = windowsVbs(argv)
    await ensureDir(path.dirname(file))
  }
  await atomicWrite(file, content, 0o644)

  if (kind === 'launchd') {
    const lint = execOk('plutil', ['-lint', file])
    if (!lint.ok) {
      throw new Error(t('生成的 plist 未通过校验：{detail}', 'The generated plist failed validation: {detail}', { detail: lint.output || file }))
    }
    const running = await gatewayLive()
    if (running) {
      return {
        kind,
        file,
        argv,
        started: false,
        note: t(
          '当前网关继续由本次启动托管，服务在下次登录/重启时自动接管',
          'The current gateway keeps running under this launch; the service takes over automatically at next login or restart'
        ),
      }
    }
    stopService() // 幂等：bootstrap 对已加载的服务会报错，先卸旧
    const uid = currentUid()
    let loaded = false
    let lastOut = ''
    if (uid != null) {
      const r = execOk('launchctl', ['bootstrap', `gui/${uid}`, file])
      loaded = r.ok
      lastOut = r.output
    }
    if (!loaded) {
      // 老版本 macOS 兜底
      const r2 = execOk('launchctl', ['load', '-w', file])
      loaded = r2.ok
      if (!r2.ok) lastOut = r2.output || lastOut
    }
    if (!loaded) {
      const detail = lastOut ? t('：{out}', ': {out}', { out: lastOut }) : ''
      throw new Error(
        t(
          'launchctl 加载失败{detail}。可手动加载：launchctl load -w {file}',
          'launchctl failed to load{detail}. To load manually: launchctl load -w {file}',
          { detail, file }
        )
      )
    }
    const live = await waitGatewayLive(10_000)
    if (!live) {
      throw new Error(
        t(
          '服务已加载但网关未在 10s 内就绪，查看服务日志：{log}',
          'The service is loaded but the gateway is not ready within 10s; check the service log: {log}',
          { log: errLog }
        )
      )
    }
    return { kind, file, argv, started: true }
  }

  if (kind === 'systemd') {
    const unit = `${SERVICE_LABEL}.service`
    const dr = execOk('systemctl', ['--user', 'daemon-reload'])
    if (!dr.ok) {
      throw new Error(
        t(
          'systemd 用户实例不可用：{out}。无桌面会话时改用 modeldock gateway start --daemon',
          'The systemd user instance is unavailable: {out}. Without a desktop session, use modeldock gateway start --daemon instead',
          { out: dr.output }
        )
      )
    }
    const running = await gatewayLive()
    const r = running
      ? execOk('systemctl', ['--user', 'enable', unit])
      : execOk('systemctl', ['--user', 'enable', '--now', unit])
    if (!r.ok) throw new Error(t('systemctl enable 失败：{out}', 'systemctl enable failed: {out}', { out: r.output }))
    if (running) {
      return {
        kind,
        file,
        argv,
        started: false,
        note: t(
          '当前网关继续由本次启动托管，服务在下次登录时自动接管',
          'The current gateway keeps running under this launch; the service takes over automatically at next login'
        ),
      }
    }
    const live = await waitGatewayLive(10_000)
    if (!live) {
      throw new Error(
        t(
          '服务已启用但网关未在 10s 内就绪，查看：journalctl --user -u {unit}',
          'The service is enabled but the gateway is not ready within 10s; check: journalctl --user -u {unit}',
          { unit }
        )
      )
    }
    return { kind, file, argv, started: true }
  }

  // windows：启动项文件即全部，无运行态可立即拉起
  return {
    kind,
    file,
    argv,
    started: false,
    note: t(
      '下次登录自动启动（Windows 启动项无崩溃自动拉起）',
      'Starts automatically at next login (the Windows startup entry does not restart on crash)'
    ),
  }
}

/** 停止并卸载已加载的服务（进程随之被 init 系统终止）；服务文件保留。返回是否执行了卸载。 */
export function stopService(): boolean {
  const kind = autostartKind()
  if (kind === 'launchd') {
    const uid = currentUid()
    if (uid == null) return false
    let r = execOk('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`])
    if (!r.ok) r = execOk('launchctl', ['remove', SERVICE_LABEL])
    return r.ok
  }
  if (kind === 'systemd') return execOk('systemctl', ['--user', 'stop', `${SERVICE_LABEL}.service`], 8000).ok
  return false
}

export interface AutostartUninstallResult {
  removed: string
  wasInstalled: boolean
}

export async function uninstallAutostart(): Promise<AutostartUninstallResult> {
  const kind = autostartKind()
  const file = serviceFilePath()
  if (!kind || !file) throw new Error(t('当前平台不支持开机自启', 'Autostart is not supported on this platform'))
  const wasInstalled = fs.existsSync(file)
  if (!wasInstalled) return { removed: file, wasInstalled: false }
  if (kind !== 'windows') stopService()
  if (kind === 'systemd') execOk('systemctl', ['--user', 'disable', `${SERVICE_LABEL}.service`])
  await fs.promises.rm(file, { force: true })
  if (kind === 'systemd') execOk('systemctl', ['--user', 'daemon-reload'])
  return { removed: file, wasInstalled }
}

async function waitGatewayLive(ms: number): Promise<{ port: number; pid: number } | null> {
  const deadline = Date.now() + ms
  for (;;) {
    const live = await gatewayLive()
    if (live) return { port: live.port, pid: live.pid }
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 400))
  }
}

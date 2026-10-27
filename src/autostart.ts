import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite, ensureDir } from './util/fsx.js'
import { homeDir, logsDir, modeldockDir } from './util/paths.js'
import { t } from './util/i18n.js'
import { gatewayLive } from './gateway/state.js'
import { preferInstalledCli } from './cliinstall.js'

/** 开机自启（常驻）：把网关注册为登录自动拉起、崩溃自动重启的系统服务。
 *  macOS → LaunchAgent（KeepAlive 崩溃拉起）；Linux → systemd user unit（Restart）；
 *  Windows → HKCU 注册表 Run 键（登录自启，无崩溃拉起；崩溃拉起是 Windows 平台已知缺口）。
 *  服务文件路径全部相对 home 推导，MODELRDOCK_FAKE_HOME 下自动隔离，测试可断言。 */

export const SERVICE_LABEL = 'com.modeldock.gateway'

/** 沙箱用独立服务标识：launchd 的 label / systemd 的 unit 名是机器级全局命名空间，与生产共用
 *  同名时沙箱 install/uninstall 的 launchctl/systemctl 操作会卸掉生产服务。沙箱一律挂 .sandbox 后缀。 */
export function serviceLabel(): string {
  return process.env.MODELRDOCK_FAKE_HOME ? `${SERVICE_LABEL}.sandbox` : SERVICE_LABEL
}

export type AutostartKind = 'launchd' | 'systemd' | 'windows'

export function autostartKind(): AutostartKind | null {
  if (process.platform === 'darwin') return 'launchd'
  if (process.platform === 'linux') return 'systemd'
  if (process.platform === 'win32') return 'windows'
  return null
}

// 服务文件路径

export function launchdPlistPath(): string {
  return path.join(homeDir(), 'Library', 'LaunchAgents', `${serviceLabel()}.plist`)
}

export function systemdUnitPath(): string {
  return path.join(homeDir(), '.config', 'systemd', 'user', `${serviceLabel()}.service`)
}

export function windowsStartupPath(): string {
  // 旧版形态（XPLAT-06 迁移前）：Startup 文件夹 VBS，已不再生成，保留用于残留检测与清理。
  // 沙箱守卫：APPDATA 不随 MODELRDOCK_FAKE_HOME 重定向，直接用会把沙箱启动项写进真机「启动」文件夹
  const base = process.env.MODELRDOCK_FAKE_HOME
    ? path.join(homeDir(), 'AppData', 'Roaming')
    : process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming')
  return path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'modeldock-gateway.vbs')
}

// ── Windows：注册表 Run 键（XPLAT-06，替代 Startup 文件夹 VBS）──
// 选型：Run 键（HKCU）而非 schtasks——schtasks /sc onlogon 未提权创建被拒（实测
// 「错误: 拒绝访问。」，ONLOGON/ONSTART 触发器需管理员），装个自启不该要 UAC；
// Run 键无需管理员、无弃用风险（VBS 已转 Feature-on-Demand）。黑窗问题：Run 键
// 直启控制台程序会常驻黑窗，故登记的命令带 --autostart 标记，由 cli.ts 以
// windowsHide（CREATE_NO_WINDOW）分离重拉 daemon、父进程即退——黑窗只存活亚秒级。

export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const WINDOWS_RUN_VALUE = 'modeldock-gateway'

/** 登录自启标记：Run 键登记的命令尾参。被 Explorer 拉起的进程由 cli.ts 据此分离重拉
 *  隐藏 daemon（控制台程序被直启会常驻黑窗），普通命令行手动跑 --sea-gateway 不受影响。 */
export const AUTOSTART_LAUNCH_FLAG = '--autostart'

/** 注册表条目的「显示路径」（诊断/状态展示用；非文件系统路径，不可 fs 存在性判断） */
export function windowsRunValueDisplay(): string {
  return `${WINDOWS_RUN_KEY}\\${WINDOWS_RUN_VALUE}`
}

/** Run 键在盘的镜像文件：生产上 reg add 成功后同步落一份，供 autostartOverview 做
 *  免 spawn 的在场判断（overview 5s 轮询不能 spawn reg.exe）；沙箱（MODELRDOCK_FAKE_HOME）
 *  下不碰真机注册表，它就是 Run 键值数据本体。两者都以它为 uninstall 的删除对象之一。 */
export function windowsRunValueMirrorFile(): string {
  return path.join(modeldockDir(), 'autostart-run-key.txt')
}

/** Run 键值数据：argv 全 token 带引号空格拼接（Windows 路径不允许出现引号，可无损往返） */
export function windowsRunCommandLine(argv: string[]): string {
  return argv.map((a) => `"${a}"`).join(' ')
}

/** 从 Run 键值数据还原 argv（windowsRunCommandLine 的逆变换） */
export function parseRunCommandLine(data: string): string[] | null {
  const out: string[] = []
  const re = /"([^"]*)"/g
  for (let m = re.exec(data); m !== null; m = re.exec(data)) out.push(m[1])
  return out.length > 0 ? out : null
}

/** reg query 值行解析。输出行形如 `    modeldock-gateway    REG_SZ    "C:\..." --sea-gateway`；
 *  键名/类型 token 是固定结构（不受系统语言影响），数据段原样取出。 */
function parseRegQueryValue(output: string): string | null {
  const re = new RegExp(`^\\s*${WINDOWS_RUN_VALUE}\\s+REG_SZ\\s+(.+)$`)
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(re)
    if (m) return m[1].trim()
  }
  return null
}

function inSandbox(): boolean {
  return !!process.env.MODELRDOCK_FAKE_HOME
}

function readRunValueData(): string | null {
  if (inSandbox()) {
    try {
      return fs.readFileSync(windowsRunValueMirrorFile(), 'utf8')
    } catch {
      return null
    }
  }
  const r = execOk('reg', ['query', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE])
  return r.ok ? parseRegQueryValue(r.output) : null
}

async function writeRunValueData(data: string): Promise<void> {
  if (inSandbox()) {
    await atomicWrite(windowsRunValueMirrorFile(), data, 0o644)
    return
  }
  const r = execOk('reg', ['add', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/t', 'REG_SZ', '/d', data, '/f'])
  if (!r.ok) {
    const manual = `reg add ${WINDOWS_RUN_KEY} /v ${WINDOWS_RUN_VALUE} /t REG_SZ /d ${data} /f`
    throw new Error(
      t(
        '写入注册表启动项失败：{out}。可手动执行：{manual}',
        'Failed to write the registry Run entry: {out}. To do it manually: {manual}',
        { out: r.output, manual }
      )
    )
  }
  // 免 spawn 在场指示（autostartOverview 用），与注册表条目同步落/删
  await atomicWrite(windowsRunValueMirrorFile(), data, 0o644)
}

function deleteRunValueData(): boolean {
  const mirror = windowsRunValueMirrorFile()
  if (inSandbox()) {
    const existed = fs.existsSync(mirror)
    try {
      fs.rmSync(mirror, { force: true })
    } catch {
      /* 删不掉的残留不阻断卸载 */
    }
    return existed
  }
  const existed = readRunValueData() != null || fs.existsSync(mirror)
  execOk('reg', ['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/f'])
  try {
    fs.rmSync(mirror, { force: true })
  } catch {
    /* 同上 */
  }
  return existed
}

/** Run 键（Explorer）拉起的进程带 --autostart 时：以 windowsHide（CREATE_NO_WINDOW）分离
 *  重拉 daemon 本体，父进程随即退出——Explorer 直启控制台程序的黑窗只存活亚秒级瞬间。
 *  返回 true = 已重拉，调用方应直接退出；false = 非自启路径或重拉失败，照常前台运行。 */
export async function relaunchHiddenIfAutostart(opts: { argv?: string[] } = {}): Promise<boolean> {
  if (process.platform !== 'win32') return false
  let child: string[]
  if (opts.argv) child = opts.argv // 测试注入（与 installAutostart 的 opts.argv 同款约定）
  else if (process.argv.includes(AUTOSTART_LAUNCH_FLAG)) child = gatewayDaemonArgs()
  else return false
  return new Promise<boolean>((resolve) => {
    const c = spawn(child[0], child.slice(1), { detached: true, stdio: 'ignore', windowsHide: true })
    c.on('error', () => resolve(false))
    c.on('spawn', () => {
      c.unref()
      resolve(true)
    })
  })
}

export function serviceFilePath(): string | null {
  switch (autostartKind()) {
    case 'launchd': return launchdPlistPath()
    case 'systemd': return systemdUnitPath()
    // 注册表形态没有服务文件：给诊断/状态展示用的「显示路径」，不可拿去做 fs 存在性判断
    // （windows 的 installed/argv 判定走 readRunValueData/旧 VBS 专用逻辑，见 windowsStatus）
    case 'windows': return windowsRunValueDisplay()
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

// 服务文件内容生成（纯函数）

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

/** 登记的启动命令是否失效：argv[0] 不存在，或非 -- 开头的参数指向的文件已不存在
 *  （nvm 升级 / 二进制移动后旧路径失效，自启会静默失败，必须能探出来）。
 *  纯函数（只做 fs.existsSync，无 spawn），autostartStatus 与 doctor 共用。 */
export function recordedArgvStale(argv: string[]): boolean {
  return !argv[0] || !fs.existsSync(argv[0]) || argv.slice(1).some((a) => !a.startsWith('--') && !fs.existsSync(a))
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
  <string>${serviceLabel()}</string>
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

// 状态 / 安装 / 卸载

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

/** Windows 状态：注册表 Run 键（新形态）+ 旧 VBS（迁移前安装的残留）双源判定。
 *  新形态优先：两者并存（半迁移态）按 Run 键报告；仅剩旧 VBS 也视为已安装（用户的
 *  自启在升级后依然有效），file 报 VBS 路径、argv 从 VBS 内容的 argv 标记回读。 */
function windowsStatus(): AutostartStatus {
  const display = windowsRunValueDisplay()
  const data = readRunValueData()
  const legacyPath = windowsStartupPath()
  let legacyArgv: string[] | null = null
  try {
    legacyArgv = fs.existsSync(legacyPath) ? readRecordedArgv(fs.readFileSync(legacyPath, 'utf8')) : null
  } catch {
    legacyArgv = null
  }
  if (!data && !legacyArgv) {
    return { kind: 'windows', installed: false, loaded: false, stale: false, file: display, argv: gatewayDaemonArgs() }
  }
  const argv = (data ? parseRunCommandLine(data) : legacyArgv) ?? gatewayDaemonArgs()
  const stale = !argv[0] || !fs.existsSync(argv[0]) || argv.slice(1).some((a) => !a.startsWith('--') && !fs.existsSync(a))
  return { kind: 'windows', installed: true, loaded: true, stale, file: data ? display : legacyPath, argv }
}

/** 完整状态（含 init 系统查询，spawnSync 级开销）——CLI / 诊断用；
 *  overview 等 5s 轮询路径请用 autostartOverview()（纯 stat，无 spawn）。 */
export function autostartStatus(): AutostartStatus | null {
  const kind = autostartKind()
  const file = serviceFilePath()
  if (!kind || !file) return null
  if (kind === 'windows') return windowsStatus()
  const installed = fs.existsSync(file)
  if (!installed) return { kind, installed: false, loaded: false, stale: false, file, argv: gatewayDaemonArgs() }
  const text = fs.readFileSync(file, 'utf8')
  const argv = readRecordedArgv(text) ?? gatewayDaemonArgs()
  let loaded = true
  if (kind === 'launchd') {
    const uid = currentUid()
    loaded = uid != null && execOk('launchctl', ['print', `gui/${uid}/${serviceLabel()}`]).ok
  } else if (kind === 'systemd') {
    loaded = execOk('systemctl', ['--user', 'is-enabled', `${serviceLabel()}.service`]).ok
  }
  const stale = recordedArgvStale(argv)
  return { kind, installed, loaded, stale, file, argv }
}

/** overview 轮询用轻量状态：仅 stat 服务文件，无任何 spawn。
 *  Windows 用镜像文件 + 旧 VBS 存在性做免 spawn 判断（生产上镜像与注册表条目同步落/删；
 *  用户手动进注册表删条目属罕见漂移，CLI 侧 autostartStatus 查 reg 是权威，重新安装自愈）。 */
export function autostartOverview(): { installed: boolean; kind: AutostartKind } | null {
  const kind = autostartKind()
  const file = serviceFilePath()
  if (!kind || !file) return null
  if (kind === 'windows') {
    return { installed: fs.existsSync(windowsRunValueMirrorFile()) || fs.existsSync(windowsStartupPath()), kind }
  }
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
 *  会登记 node+vitest-cli 而非产品网关，无法做真实链路测试）。
 *  opts.healthTimeoutMs：健康等待时限（缺省 10s）。测试注入假 daemon 必然不就绪，
 *  缩短到 2s 可把用例从固定 10s 降下来；断言力不变——launchctl bootstrap / systemctl
 *  enable --now 成功即已加载，健康等待只是等它就绪。 */
export async function installAutostart(opts: { argv?: string[]; healthTimeoutMs?: number } = {}): Promise<AutostartInstallResult> {
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
  const healthWaitMs = opts.healthTimeoutMs ?? 10_000
  const outLog = path.join(logsDir(), 'service-out.log')
  const errLog = path.join(logsDir(), 'service-err.log')
  const workDir = modeldockDir()

  if (kind === 'windows') {
    // windows：注册表 Run 键即全部，无运行态可立即拉起。
    // 迁移（XPLAT-06）：装新形态时顺带清掉旧 VBS 残留（幂等，文件不存在是常态）
    const file = windowsRunValueDisplay()
    await writeRunValueData(windowsRunCommandLine([...argv, AUTOSTART_LAUNCH_FLAG]))
    const legacy = windowsStartupPath()
    const hadLegacy = fs.existsSync(legacy)
    await fs.promises.rm(legacy, { force: true })
    return {
      kind,
      file,
      argv,
      started: false,
      note: hadLegacy
        ? t(
            '下次登录自动启动（已改用注册表启动项并清理旧版 VBS；无崩溃自动拉起）',
            'Starts automatically at next login (switched to the registry Run entry and removed the legacy VBS; no restart on crash)'
          )
        : t(
            '下次登录自动启动（Windows 启动项无崩溃自动拉起）',
            'Starts automatically at next login (the Windows startup entry does not restart on crash)'
          ),
    }
  }

  let file: string
  let content: string
  if (kind === 'launchd') {
    file = launchdPlistPath()
    content = launchdPlistXml(argv, workDir, outLog, errLog)
  } else {
    file = systemdUnitPath()
    content = systemdUnitIni(argv, workDir, outLog, errLog)
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
    const live = await waitGatewayLive(healthWaitMs)
    if (!live) {
      throw new Error(
        t(
          '服务已加载但网关未在 {s}s 内就绪，查看服务日志：{log}',
          'The service is loaded but the gateway is not ready within {s}s; check the service log: {log}',
          { s: healthWaitMs / 1000, log: errLog }
        )
      )
    }
    return { kind, file, argv, started: true }
  }

  // 走到这里 kind 已收窄为 'systemd'（windows 在上方早退，launchd 分支全部路径已 return/throw）
  const unit = `${serviceLabel()}.service`
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
  const live = await waitGatewayLive(healthWaitMs)
  if (!live) {
    throw new Error(
      t(
        '服务已启用但网关未在 {s}s 内就绪，查看：journalctl --user -u {unit}',
        'The service is enabled but the gateway is not ready within {s}s; check: journalctl --user -u {unit}',
        { s: healthWaitMs / 1000, unit }
      )
    )
  }
  return { kind, file, argv, started: true }
}

/** 停止并卸载已加载的服务（进程随之被 init 系统终止）；服务文件保留。返回是否执行了卸载。 */
export function stopService(): boolean {
  const kind = autostartKind()
  if (kind === 'launchd') {
    const uid = currentUid()
    if (uid == null) return false
    let r = execOk('launchctl', ['bootout', `gui/${uid}/${serviceLabel()}`])
    if (!r.ok) r = execOk('launchctl', ['remove', serviceLabel()])
    return r.ok
  }
  if (kind === 'systemd') return execOk('systemctl', ['--user', 'stop', `${serviceLabel()}.service`], 8000).ok
  return false
}

export interface AutostartUninstallResult {
  removed: string
  wasInstalled: boolean
}

export async function uninstallAutostart(): Promise<AutostartUninstallResult> {
  const kind = autostartKind()
  if (!kind) throw new Error(t('当前平台不支持开机自启', 'Autostart is not supported on this platform'))
  if (kind === 'windows') {
    // 两种形态对称清理：注册表 Run 键（新）+ 旧版 VBS 残留（迁移前安装的），缺哪个都幂等
    const hadRun = deleteRunValueData()
    const legacy = windowsStartupPath()
    const hadLegacy = fs.existsSync(legacy)
    await fs.promises.rm(legacy, { force: true })
    return { removed: hadRun ? windowsRunValueDisplay() : legacy, wasInstalled: hadRun || hadLegacy }
  }
  const file = serviceFilePath()
  if (!file) throw new Error(t('当前平台不支持开机自启', 'Autostart is not supported on this platform'))
  const wasInstalled = fs.existsSync(file)
  if (!wasInstalled) return { removed: file, wasInstalled: false }
  stopService()
  if (kind === 'systemd') execOk('systemctl', ['--user', 'disable', `${serviceLabel()}.service`])
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

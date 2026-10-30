import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { c, sleep, localDateStr, t } from '../util/index.js'
import { randomToken } from '../util/fsx.js'
import { logsDir, displayPath } from '../util/paths.js'
import { readGatewayState, writeGatewayState } from '../gateway/state.js'
import {
  autostartStatus,
  gatewayDaemonArgs,
  installAutostart,
  stopService,
  uninstallAutostart,
  type AutostartKind,
  type AutostartStatus,
} from '../autostart.js'
import { DEFAULT_GATEWAY_PORT, gatewayLive, loadCfg, requireGateway, spawnDaemonAndWait, openUrlInBrowser, killByPid, parsePidCommandLines } from './shared.js'

export async function cmdGatewayStart(opts: { port?: string; daemon?: boolean }): Promise<void> {
  const cfg = await loadCfg()
  const live = await gatewayLive()
  if (live) {
    console.log(c.yellow(t('网关已在运行：http://127.0.0.1:{port}（pid {pid}）', 'Gateway is already running: http://127.0.0.1:{port} (pid {pid})', { port: live.port, pid: live.pid })))
    return
  }
  const port = opts.port ? Number(opts.port) : (cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT)

  if (!opts.daemon) {
    const { startForeground } = await import('../gateway/main.js')
    await startForeground(port)
    return
  }

  const daemonArgv = [...gatewayDaemonArgs(), '--port', String(port)]
  const state = await spawnDaemonAndWait(daemonArgv)
  if (state) {
    console.log(c.green(t('✓ 网关已后台启动：http://127.0.0.1:{port}（pid {pid}）', '✓ Gateway started in the background: http://127.0.0.1:{port} (pid {pid})', { port: state.port, pid: state.pid })))
    return
  }
  console.error(c.red(t('✗ 网关启动超时。可在命令行运行 modeldock gateway start 查看详细错误。', '✗ Gateway start timed out. Run "modeldock gateway start" in a terminal for details.')))
  // daemon 的崩溃/启动报错自写日志（fd 2 接管，CORRECT-07）：超时时把日志路径递给用户，报错不蒸发
  console.error(
    c.yellow(
      t(
        '提示: daemon 启动报错见日志 {log}',
        'Hint: daemon startup errors are logged to {log}',
        { log: displayPath(path.join(logsDir(), `daemon-${localDateStr()}.log`)) }
      )
    )
  )
  process.exit(1)
}

/** 轮换管理令牌：网关在跑就调运行时接口（旧 token/cookie 立即失效）；没跑则改残留状态文件（下次启动生效）。 */
export async function cmdGatewayRotateToken(): Promise<void> {
  const live = await gatewayLive()
  if (live) {
    let res: Response
    try {
      res = await fetch(`http://127.0.0.1:${live.port}/_modeldock/admin/rotate`, {
        method: 'POST',
        headers: { 'x-modeldock-admin': live.admin_token },
        signal: AbortSignal.timeout(5000),
      })
    } catch (e) {
      console.error(c.red(t('✗ 调用网关失败：{m}', '✗ Failed to call the gateway: {m}', { m: (e as Error).message })))
      process.exitCode = 1
      return
    }
    if (!res.ok) {
      console.error(c.red(t('✗ 轮换失败：{m}', '✗ Rotation failed: {m}', { m: (await res.text()).trim() || res.status })))
      process.exitCode = 1
      return
    }
    const j = (await res.json()) as { console_url: string }
    console.log(c.green(t('✓ 管理令牌已轮换，旧令牌与浏览器 cookie 已失效', '✓ Admin token rotated. The old token and browser cookie are now invalid')))
    console.log(c.gray(t('新控制台地址：{u}', 'New console URL: {u}', { u: j.console_url })))
    return
  }
  // 网关未运行：有残留状态文件就直接换（main 启动时读它），没有则下次启动本就会生成新令牌
  const state = await readGatewayState()
  if (!state) {
    console.log(c.gray(t('网关未运行且无状态文件；下次启动自动生成新令牌，无需轮换', 'The gateway is not running and there is no state file. A new token is generated on next start; nothing to rotate')))
    return
  }
  await writeGatewayState({ ...state, admin_token: randomToken('mdkadm') })
  console.log(c.green(t('✓ 管理令牌已轮换，下次网关启动生效', '✓ Admin token rotated. It takes effect on next gateway start')))
}

export async function cmdGatewayStop(): Promise<void> {
  // 系统服务托管时 KeepAlive 会在进程退出后重新拉起：先卸载服务再停进程，
  // 否则 launchd 和下面的进程清扫会互相拉锯（杀掉→重生→再杀）。
  const svc = autostartStatus()
  const managed = !!(svc?.installed && svc.loaded && svc.kind !== 'windows')
  if (managed) stopService()
  const live = await gatewayLive()
  if (!live) {
    // 服务托管的实例被 bootout 时进程已随之退出，走不到下面的 SIGTERM 分支
    if (managed) {
      console.log(c.green(t('✓ 网关已停止（系统服务已卸载）', '✓ Gateway stopped (the system service was unloaded)')))
      console.log(c.gray(t('  服务保留，下次登录自动重启；彻底移除：modeldock gateway uninstall', '  The service stays installed and restarts on next login. Remove it fully: modeldock gateway uninstall')))
    } else {
      console.log(c.gray(t('网关未在运行', 'The gateway is not running')))
    }
    return
  }
  if (live) {
    // 验活与 kill 之间的竞态（进程恰好退出/pid 被复用后瞬间死亡）会抛 ESRCH：
    // 与下方 SIGKILL 分支对称包住，视为「已停止」继续走 pidExitedWithin 复核；
    // 不包的话手动 stop 报原始错误、经 update 流程会以「安装失败：kill ESRCH」中止整个更新
    try {
      process.kill(live.pid, 'SIGTERM')
    } catch {
      /* 已退出 */
    }
    if (await pidExitedWithin(live.pid)) {
      console.log(c.green(t('✓ 网关已停止（pid {pid}）', '✓ Gateway stopped (pid {pid})', { pid: live.pid })))
      if (managed) console.log(c.gray(t('  服务保留，下次登录自动重启；彻底移除：modeldock gateway uninstall', '  The service stays installed and restarts on next login. Remove it fully: modeldock gateway uninstall')))
      return
    }
    console.log(c.yellow(t('进程未在 2s 内退出，已发 SIGKILL', 'The process did not exit within 2s; sent SIGKILL')))
    try {
      process.kill(live.pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
    // SIGKILL 同样复核并给出成败输出（此前静默收场，失败会留下悬空网关不自知）
    if (await pidExitedWithin(live.pid)) {
      console.log(c.green(t('✓ 网关已停止（pid {pid}）', '✓ Gateway stopped (pid {pid})', { pid: live.pid })))
      if (managed) console.log(c.gray(t('  服务保留，下次登录自动重启；彻底移除：modeldock gateway uninstall', '  The service stays installed and restarts on next login. Remove it fully: modeldock gateway uninstall')))
    } else {
      console.log(c.red(t('✗ 网关进程未能停止（pid {pid}），请手动结束该进程', '✗ The gateway process did not stop (pid {pid}). End it manually')))
    }
  }
}

/** 轮询等待进程退位（10×200ms，kill(pid,0) 抛错即视为已退出）。 */
async function pidExitedWithin(pid: number): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    await sleep(200)
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
  }
  return false
}

/** 按命令行签名清扫游离网关进程（含 dev 的 tsx 实例与 SEA 二进制实例）。仅本机尽力而为，失败静默跳过。
 *  做两遍：先杀子进程时，tsx watch 之类的守护父进程可能立刻重生它。
 *  沙箱守卫：清扫按命令行签名全机匹配杀进程（modeldock + gateway start），生产 8687 同样命中——
 *  沙箱（MODELRDOCK_FAKE_HOME，dev/测试实例）里执行卸载会连生产一起杀掉。沙箱只停自己
 *  （gateway stop 按 gateway.json 寻址），绝不全局扫。 */
export function sweepGatewayProcesses(): void {
  if (process.env.MODELRDOCK_FAKE_HOME) {
    console.log(c.gray(t('沙箱模式：跳过游离网关清扫（不波及其他实例）', 'Sandbox mode: skipping stray gateway sweep (other instances untouched)')))
    return
  }
  let killed = 0
  try {
    for (let pass = 0; pass < 2; pass++) {
      if (pass) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300) // 同步小睡：等守护父进程重生子进程后再补一刀
      const lines = listProcessLines()
      if (!lines) return
      for (const { pid, cmd } of parsePidCommandLines(lines)) {
        if (pid === process.pid) continue
        // 双条件收敛误杀面：必须是“网关启动”命令，且命令属于 ModelDock（CLI 源码路径或 modeldock 二进制）
        const isGatewayStart = /gateway start|--sea-gateway/.test(cmd)
        const isModelDock = /modeldock|src[\\/]cli\.ts/.test(cmd)
        if (!isGatewayStart || !isModelDock) continue
        if (killByPid(pid)) killed++
      }
    }
  } catch {
    /* 进程枚举不可用 → 跳过清扫 */
  }
  if (killed) console.log(c.gray(t('另清扫了 {n} 个游离网关进程', 'Also cleaned up {n} stray gateway process(es)', { n: killed })))
}

/** 枚举本机进程命令行，输出每行 "pid command"；不可用时返回 null（调用方跳过清扫）。
 *  Windows 没有 ps（wmic 自 Win11 24H2 起也已移除），改用 PowerShell CIM 查询。
 *  导出供 test/gatewaycmd.test.ts 做跨平台冒烟（PS 引号转义/编码在真实机器上验证）。 */
export function listProcessLines(): string | null {
  const out = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', winProcListScript()], { encoding: 'utf8' })
    : spawnSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' })
  return out.stdout || null
}

/** 脚本内只用单引号：避免 MSVCRT 参数转义与 powershell -Command 的引号二次解析互相打架 */
function winProcListScript(): string {
  return [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine } | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }`,
  ].join('; ')
}

export function autostartLine(svc: AutostartStatus | null): string {
  if (!svc) return ''
  if (!svc.installed) return t('  开机自启: {s}', '  Start at login: {s}', { s: c.gray(t('未安装（modeldock gateway install，登录自启 + 崩溃自动拉起）', 'not installed (modeldock gateway install enables start at login + auto-restart on crash)')) })
  if (svc.stale) return t('  开机自启: {s}', '  Start at login: {s}', { s: c.yellow(t('已安装但启动命令失效（重装：modeldock gateway install）', 'installed but the start command is broken (reinstall: modeldock gateway install)')) })
  if (!svc.loaded) return t('  开机自启: {s}', '  Start at login: {s}', { s: c.yellow(t('已安装（未加载，下次登录生效）', 'installed (not loaded yet; takes effect on next login)')) })
  return t('  开机自启: {s}', '  Start at login: {s}', { s: c.green(t('已安装（{k}）', 'installed ({k})', { k: kindLabel(svc.kind) })) })
}

function kindLabel(k: AutostartKind): string {
  return k === 'launchd' ? 'macOS LaunchAgent' : k === 'systemd' ? t('Linux systemd 用户服务', 'Linux systemd user service') : t('Windows 启动项', 'Windows startup entry')
}

export async function cmdGatewayStatus(): Promise<void> {
  const svc = autostartStatus()
  const live = await gatewayLive()
  if (!live) {
    console.log(c.gray(t('网关未在运行；启动：modeldock gateway start（--daemon 后台）', 'The gateway is not running. Start it: modeldock gateway start (--daemon for background)')))
    if (!svc?.installed) console.log(c.gray(t('开机自启未安装（可选）：modeldock gateway install', 'Start at login is not installed (optional): modeldock gateway install')))
    else console.log(autostartLine(svc).trimStart())
    return
  }
  console.log(c.green(t('● 网关运行中  http://127.0.0.1:{port}（pid {pid}，since {ts}）', '● Gateway running  http://127.0.0.1:{port} (pid {pid}, since {ts})', { port: live.port, pid: live.pid, ts: live.started_at })))
  console.log(autostartLine(svc))
  try {
    const res = await fetch(`http://127.0.0.1:${live.port}/_modeldock/status`, {
      headers: { 'x-modeldock-admin': live.admin_token },
      signal: AbortSignal.timeout(2000),
    })
    const j = (await res.json()) as any
    console.log(`  active_profile: ${c.bold(j.active_profile ?? t('(未设置)', '(not set)'))}`)
    console.log(`  providers: ${j.providers.join(', ') || t('(无)', '(none)')}`)
    console.log(`  profiles: ${j.profiles.join(', ') || t('(无)', '(none)')}`)
    console.log(`  harness: ${j.harness.join(', ') || t('(无)', '(none)')}`)
    console.log(t('  配置热加载次数: {n}', '  Config hot-reloads: {n}', { n: j.reloads }))
  } catch {
    console.log(c.yellow(t('  （管理端点无响应，但进程存活）', '  (The admin endpoint is not responding, but the process is alive)')))
  }
}

export async function cmdGatewayInstall(): Promise<void> {
  try {
    const r = await installAutostart()
    console.log(c.green(t('✓ 开机自启已安装（{k}）', '✓ Start at login installed ({k})', { k: kindLabel(r.kind) })))
    if (r.started) {
      const live = await gatewayLive()
      console.log(c.green(t('  网关已由系统服务拉起：http://127.0.0.1:{port}（崩溃自动重启）', '  The gateway was started by the system service: http://127.0.0.1:{port} (auto-restarts on crash)', { port: live?.port ?? '?' })))
    } else {
      console.log(c.gray(`  ${r.note}`))
    }
    console.log(c.gray(t('  服务文件：{f}', '  Service file: {f}', { f: r.file })))
    if (r.kind === 'systemd') {
      console.log(c.gray(t('  提示：桌面登录后自启；SSH/无登录场景可执行 sudo loginctl enable-linger $USER', '  Note: starts on desktop login. For SSH / headless setups run: sudo loginctl enable-linger $USER')))
    }
  } catch (e) {
    // 语义特殊：保持 process.exitCode 而非立即 exit——自启安装失败不阻断 CLI 自然退出（后续清理/输出仍要走），
    // 不照搬 exitWithError；业务错误类带 hint 时手动补打「提示: …」行
    const err = e as Error & { hint?: string }
    console.error(c.red(`✗ ${err.message}`))
    if (err.hint) console.error(c.yellow(t('提示: {h}', 'Hint: {h}', { h: err.hint })))
    process.exitCode = 1
  }
}

export async function cmdGatewayUninstall(): Promise<void> {
  const r = await uninstallAutostart()
  if (!r.wasInstalled) {
    console.log(c.gray(t('开机自启未安装', 'Start at login is not installed')))
    return
  }
  console.log(c.green(t('✓ 已移除开机自启（{r}）', '✓ Start at login removed ({r})', { r: r.removed })))
  const live = await gatewayLive()
  if (live) console.log(c.gray(t('  当前运行的网关不受影响；modeldock gateway stop 可停止', '  The running gateway is not affected. Stop it with modeldock gateway stop')))
}

export async function cmdGatewayLog(opts: { n?: string; follow?: boolean; harness?: string }): Promise<void> {
  const files = [todayFile(), yesterdayFile()].filter((f) => fs.existsSync(f))
  if (files.length === 0) {
    console.log(c.gray(t('暂无请求日志（logs/ 目录为空）', 'No request logs yet (the logs/ directory is empty)')))
    return
  }
  const print = (entries: { obj: any }[]) => {
    const filtered = entries.filter((e) => !opts.harness || e.obj.harness === opts.harness)
    const tail = filtered.slice(-(Number(opts.n ?? 30) || 30))
    for (const e of tail) {
      const o = e.obj
      const status = o.status >= 400 || o.err ? c.red(String(o.status ?? '-')) : c.green(String(o.status ?? '-'))
      console.log(
        `${c.gray((o.ts ?? '').slice(11, 19))}  ${String(o.harness ?? '-').padEnd(12)} ${String(o.profile ?? '-').padEnd(16)} ${String(o.model ?? '-').padEnd(34)} ${status} ${o.ms ?? '?'}ms${o.err ? c.red(`  ${(o.err ?? '').slice(0, 80)}`) : ''}`
      )
    }
  }
  const lastSizes = new Map<string, number>()
  for (const f of files) lastSizes.set(f, 0)
  print(readLogLines(files, lastSizes))

  if (!opts.follow) return
  console.log(c.gray(t('--- 跟随中，Ctrl+C 退出 ---', '--- Following. Press Ctrl+C to exit ---')))
  for (;;) {
    await sleep(1000)
    // 每轮重新收集日志文件：跨天轮转后新文件也能跟上
    const rotated = [todayFile(), yesterdayFile()].filter((x) => fs.existsSync(x))
    print(readLogLines(rotated, lastSizes))
  }
}

/** 读出日志文件里 since 之后的新增行（since 为每次读取的字节位置，跨文件轮转追赶）。
 *  首次读取传 lastSizes 全 0 → 读整份；JSON 半行/坏行静默跳过（半行等下次轮转）。 */
function readLogLines(files: string[], since: Map<string, number>): { obj: any }[] {
  const out: { obj: any }[] = []
  for (const f of files) {
    let size: number
    try {
      size = fs.statSync(f).size
    } catch {
      continue
    }
    const last = since.get(f) ?? 0
    if (size <= last) continue
    const fd = fs.openSync(f, 'r')
    const buf = Buffer.alloc(size - last)
    fs.readSync(fd, buf, 0, buf.length, last)
    fs.closeSync(fd)
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push({ obj: JSON.parse(line) })
      } catch {
        /* 半行或坏行：等下次轮转或跳过 */
      }
    }
    since.set(f, size)
  }
  return out
}

function todayFile(): string {
  const d = new Date()
  return path.join(logsDir(), `gateway-${localDateStr(d)}.jsonl`)
}

function yesterdayFile(): string {
  const d = new Date(Date.now() - 86_400_000)
  return path.join(logsDir(), `gateway-${localDateStr(d)}.jsonl`)
}

export async function cmdUi(): Promise<void> {
  const live = await requireGateway()
  // 管理面读写已全面要求 admin 凭据：带 token 打开（服务端种 7 天 HttpOnly cookie）
  const base = `http://127.0.0.1:${live.port}/_modeldock/ui?token=${live.admin_token}`
  await openUrlInBrowser(base)
  console.log(c.green(t('✓ Web 控制台已在浏览器打开', '✓ Web console opened in your browser')))
  console.log(c.gray(t('地址：{u}（仅本机可访问）', 'URL: {u} (local access only)', { u: base })))
}

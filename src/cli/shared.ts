import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config/types.js'
import { DEFAULT_GATEWAY_PORT } from '../config/types.js'
import { loadConfig } from '../config/store.js'
import { gatewayLive, type GatewayStateFile } from '../gateway/state.js'
import { c, t, ensureDir, sleep, getLang, localDateStr } from '../util/index.js'
import { logsDir, modeldockDir } from '../util/paths.js'

export { gatewayLive, DEFAULT_GATEWAY_PORT }

export async function loadCfg(): Promise<Config> {
  return loadConfig()
}

export async function requireGateway(): Promise<GatewayStateFile> {
  const live = await gatewayLive()
  if (!live) {
    console.error(c.red(t('网关未运行。先启动：modeldock gateway start（或 --daemon 后台运行）', 'Gateway is not running. Start it first: modeldock gateway start (or --daemon to run in the background)')))
    process.exit(1)
  }
  return live
}

export function exitWithError(msg: string, hint?: string): never {
  console.error(c.red(`✗ ${msg}`))
  if (hint) console.error(c.yellow(t('提示: {h}', 'Hint: {h}', { h: hint })))
  process.exit(1)
}

/** unknown 抛出值的统一出口（顶层 catch 与各命令 inline catch 共用）：
 *  业务错误类（ConfigError/SecretsError/AdapterError/UpstreamError/UpdateError）统一携带可选
 *  hint 字段——有就打「提示: …」两行式；未知错误只打 message。
 *  duck 读 hint 而非 instanceof：relay(undici)/adapters 等重模块图不应为此进所有命令的启动链
 *  （PERF-03 同理）；hint 供给方已收口为五类的类型字段（裸 Error 挂 hint 的逃逸口已移除），不会误伤未知错误。 */
export function exitWithThrown(e: unknown): never {
  const err = e as Error & { hint?: unknown }
  const msg = err && typeof err.message === 'string' ? err.message : String(e)
  return exitWithError(msg, err && typeof err.hint === 'string' && err.hint ? err.hint : undefined)
}

// ── CLI/进程原语（去重，DUP-01）────────────────────────────────────────────

/** 分离拉起网关守护进程并轮询就绪（默认 20×250ms=5s；rounds 可调）。返回活网关状态；超时返回 null。
 *  probe 探活函数、spawnFn 执行器均可注入（单测传 fake，避免真实探测网关/起 daemon）。
 *  SEA 双击冷启逢 Defender/SmartScreen 扫描可能 >5s，GUI 路径（cli.ts launchGui）传更大 rounds。 */
export async function spawnDaemonAndWait(
  argv: string[],
  probe: () => Promise<GatewayStateFile | null> = gatewayLive,
  spawnFn: typeof spawn = spawn,
  rounds = 20
): Promise<GatewayStateFile | null> {
  await ensureDir(modeldockDir())
  await ensureDir(logsDir()) // daemon 日志目录：daemon stderr 直写该日志文件
  const daemonLog = path.join(logsDir(), `daemon-${localDateStr()}.log`)
  // daemon stderr 直接重定向进日志文件（fd 继承），不走父进程 pipe——
  // pipe 读端会把父 CLI 事件循环钉到 daemon 退出为止：gateway start --daemon 成功后提示符
  // 永不返回、SEA 双击窗口关不掉（评测集 2026-10-crlf-proc-parse 问题 2，本机实验坐实：
  // pipe + unref → 父进程存活 8.2s=子进程存活期；而父进程一旦退出读端即关，daemon 后续
  // stderr 写入会 EPIPE——pipe 方案两头不讨好）。fd 重定向三头兼顾：零钉死、诊断全程
  // （daemon 生命周期内的 stderr 都落日志，崩溃排查不丢）、父副本即关互不影响。
  const daemonLogFd = fs.openSync(daemonLog, 'a')
  let child: ReturnType<typeof spawn>
  try {
    child = spawnFn(argv[0], argv.slice(1), {
      detached: true,
      // stdout 无诊断价值保持 ignore；stderr = 日志文件 fd
      stdio: ['ignore', 'ignore', daemonLogFd],
      // daemon 与 CLI 语言一致：config.toml 尚无 language 时 CLI 的 --lang/环境变量选择也要传下去
      env: { ...process.env, MODELRDOCK_LANG: getLang() },
      cwd: modeldockDir(),
      windowsHide: true, // Windows：detached 控制台程序默认弹驻留窗口，隐藏之
    })
  } finally {
    fs.closeSync(daemonLogFd) // 父进程副本即关：子进程已继承 fd，父退出不影响其写日志
  }
  child.unref()
  // 异步 spawn 失败（ENOENT/权限）必须挂 error 监听：不接则成 uncaught exception 杀 CLI。
  // 拉起失败时轮询会自然超时返回 null，这里只留可见报错
  child.on('error', (err) => {
    console.error(t('[modeldock] daemon 进程拉起失败：{msg}', '[modeldock] Failed to spawn the daemon process: {msg}', { msg: err.message }))
  })

  for (let i = 0; i < rounds; i++) {
    await sleep(250)
    const live = await probe()
    if (live) return live
  }
  return null
}

/** 用系统默认浏览器打开 URL：darwin=open / win=cmd start / linux=xdg-open。
 *  返回是否成功拉起（false = spawn 失败或退出，调用方可提示手动访问）。
 *  spawnFn 执行器可注入（单测传 fake，绝不真起浏览器）。 */
export function openUrlInBrowser(url: string, spawnFn: typeof spawn = spawn): Promise<boolean> {
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open'
  // start 把第一个带引号的参数当窗口标题：给空标题占位，URL 才不会被吞掉/被 shell 元字符截断
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  return new Promise<boolean>((resolve) => {
    // 异步 error 事件必须挂监听：Linux 无 xdg-open 时 spawn 失败不监听会让整个进程崩掉
    const child = spawnFn(opener, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('spawn', () => { child.unref(); resolve(true) })
  })
}

/** 按 PID 终止进程：win32 用 taskkill /T /F 杀整棵进程树（Windows 无信号语义，SIGTERM 即硬杀且不管子树）；
 *  unix 保持 SIGTERM（优雅退出）。opts.tree=false 只杀该进程本身、不递归子树——更新流程停托盘时必须用它：
 *  托盘发起的更新里更新器就是托盘的子进程，树杀会把自己一并杀掉，安装步骤永远执行不到。
 *  返回是否实际发出终结信号（false = 已退出/权限不足，调用方据此决定计数）。
 *  spawnSyncFn 执行器可注入（单测传 fake，绝不真杀进程）。 */
export function killByPid(
  pid: number,
  spawnSyncFn: typeof spawnSync = spawnSync,
  opts: { tree?: boolean } = {}
): boolean {
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/F', ...(opts.tree === false ? [] : ['/T'])]
    const r = spawnSyncFn('taskkill', args, { stdio: 'ignore', windowsHide: true })
    // spawnSync 正常返回 status 非 0 表示未找到目标/失败；注入的 fake 返回 undefined 视为成功（只桩命令拼装）
    return !r || r.status === 0
  }
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

/** 解析 "pid command" 行（listProcessLines 输出）。容错：空行/脏行跳过。
 *  先剥行尾 \r：Windows 上 PowerShell CIM 重定向输出为 CRLF（PS 5.1 实态），
 *  不归一化则每行（除恰好无换行的末行）尾部 \r 让 `(.*)$` 全部失配、解析恒为空——
 *  Windows 枚举恒空正是 stopTrayProcesses 旧实现「托盘杀不掉且无痕」的根源
 *  （2026-10-28 用户实证，三次更新托盘全存活）。 */
const PROC_LINE_RE = /^\s*(\d+)\s+(.*)$/
export function parsePidCommandLines(lines: string): { pid: number; cmd: string }[] {
  const out: { pid: number; cmd: string }[] = []
  for (const line of lines.split('\n')) {
    const m = line.replace(/\r$/, '').match(PROC_LINE_RE)
    if (!m) continue
    out.push({ pid: Number(m[1]), cmd: m[2] })
  }
  return out
}

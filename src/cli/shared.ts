import { spawn, spawnSync } from 'node:child_process'
import { Console } from 'node:console'
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

/** 同步直写流的最小形状（console.error / process.emitWarning / 崩溃处理器只消费 write） */
type SyncWriteLike = { write(chunk: string): boolean }

/** Windows 降级路径（2026-10-30 probe，Node 24 实测）：stdio ignore 下 closeSync(2) 返回成功但
 *  std fd 槽位不真正释放（fstatSync(2) 前后同 inode、writeSync(2) 仍可写），openSync(log) 永落
 *  fd 3 —— fd 2 接管天然不可行。降级为「换流不换 fd」：把 process.stderr 与全局 console 重绑到
 *  直写日志 fd 的同步流，JS 可见的 stderr 输出（console.*、emitWarning、崩溃处理器）照常落日志；
 *  Node 原生崩溃输出仍进 NUL（fd 级无解，纯 JS 上限如此）。两步都尽力而为，失败静默降级。 */
function rebindStderrToLogFd(fd: number): void {
  let fresh: SyncWriteLike | null = null
  try {
    // SyncWriteStream 与 Node stdio FILE 流同类；公开导出已在 Node 24 移除，从 memoize 实例取
    // 内部类。访问 process.stderr 会触发懒初始化（绑 fd 2 = NUL，无输出副作用），随后被覆盖。
    const stale = process.stderr as unknown as {
      constructor?: new (fd: number, opts?: { autoClose?: boolean }) => SyncWriteLike
    }
    if (stale?.constructor) fresh = new stale.constructor(fd, { autoClose: false })
  } catch {
    /* 构造失败退化为鸭子流 */
  }
  if (!fresh) {
    fresh = {
      write: (chunk) => {
        try {
          fs.writeSync(fd, chunk)
          return true
        } catch {
          return false
        }
      },
    }
  }
  try {
    const stderrDesc = Object.getOwnPropertyDescriptor(process, 'stderr')
    if (stderrDesc?.configurable) {
      Object.defineProperty(process, 'stderr', { value: fresh, configurable: true, enumerable: true })
    }
  } catch {
    /* 极端环境：放弃 stderr 重绑，继续尝试 console 替换 */
  }
  // 全局 console 在首次使用时缓存了流对象（预热后只换 process.stderr 不生效），须整体替换；
  // 公开 API new Console，stdout 传原对象保持 banner 等行为不变
  try {
    const consoleDesc = Object.getOwnPropertyDescriptor(globalThis, 'console')
    if (consoleDesc?.configurable) {
      Object.defineProperty(globalThis, 'console', {
        value: new Console({
          stdout: process.stdout as NodeJS.WritableStream,
          stderr: fresh as unknown as NodeJS.WritableStream,
        }),
        configurable: true,
        enumerable: true,
        writable: true,
      })
    }
  } catch {
    /* 极端环境：放弃 console 替换，stderr 重绑已尽力 */
  }
}

/** daemon 形态启动早期接管 fd 2 → logs/daemon-<date>.log：daemon 的崩溃/启动报错自写日志
 *  （进程级 stderr 全量落盘，含 Node 原生崩溃输出），父 CLI 才能用 stdio 全 ignore 拉起而不把
 *  自己钉住（CORRECT-07：pipe 读端 flowing 态被事件循环引用，daemon 常驻 fd 2 永不关闭）。
 *  fd 级重定向无半行缓冲/丢行问题（原父侧逐行转写随 stdio ignore 整段移除，日志保真由 fd 直写
 *  继承；Windows 换行以 \r\n 原样落盘）。必须在 daemon 进程消费 process.stderr 之前调用——
 *  stdio ignore 下 stderr 句柄懒初始化，先腾 fd 再写即全部落进日志。保留期随 pruneExpiredLogs。
 *  返回日志路径；接管失败（极端环境）返回 null，stderr 保持原状仅降级不阻断。 */
export function redirectDaemonStderrToLog(): string | null {
  const logPath = path.join(logsDir(), `daemon-${localDateStr()}.log`)
  fs.mkdirSync(logsDir(), { recursive: true })
  try {
    try {
      fs.closeSync(2) // 腾出 fd 2（stdio ignore 下 unix 指向 /dev/null；Windows 上不真正释放槽位，见 rebindStderrToLogFd）
    } catch {
      /* 已关闭 */
    }
    const fd = fs.openSync(logPath, 'a') // unix：单线程启动期最低可用 fd 必为 2
    if (fd === 2) return logPath // unix fd 级接管成功（含 Node 原生崩溃输出）
    // Windows（probe 实测 fd 恒落 3）：fd 2 接管不可行 → 换流不换 fd，JS 可见 stderr 输出落日志
    try {
      rebindStderrToLogFd(fd)
      return logPath
    } catch {
      try {
        fs.closeSync(fd)
      } catch {
        /* 尽力清理 */
      }
      return null
    }
  } catch {
    return null // 日志文件打不开：stderr 保持原状，功能不受影响
  }
}

/** 分离拉起网关守护进程并轮询就绪（默认 20×250ms=5s；rounds 可调）。返回活网关状态；超时返回 null。
 *  probe 探活函数、spawnFn 执行器均可注入（单测传 fake，避免真实探测网关/起 daemon）。
 *  SEA 双击冷启逢 Defender/SmartScreen 扫描可能 >5s，GUI 路径（cli.ts launchGui）传更大 rounds。
 *  daemon 侧经 redirectDaemonStderrToLog() 自写 logs/daemon-<date>.log（cli.ts --sea-gateway 分支），
 *  本函数 stdio 全 ignore——pipe 转写会让父 CLI 就绪后仍被读端钉住不退出（CORRECT-07）。 */
export async function spawnDaemonAndWait(
  argv: string[],
  probe: () => Promise<GatewayStateFile | null> = gatewayLive,
  spawnFn: typeof spawn = spawn,
  rounds = 20
): Promise<GatewayStateFile | null> {
  await ensureDir(modeldockDir())
  const child = spawnFn(argv[0], argv.slice(1), {
    detached: true,
    // 全 ignore：daemon 崩溃/启动报错由 daemon 侧 fd 2 接管自写日志（见上），父进程不再持
    // 任何子进程流——否则读端引用让 CLI 在就绪探测返回后仍无法退出
    stdio: ['ignore', 'ignore', 'ignore'],
    // daemon 与 CLI 语言一致：config.toml 尚无 language 时 CLI 的 --lang/环境变量选择也要传下去
    env: { ...process.env, MODELRDOCK_LANG: getLang() },
    cwd: modeldockDir(),
    windowsHide: true, // Windows：detached 控制台程序默认弹驻留窗口，隐藏之
  })
  child.unref()
  // 异步 spawn 失败（ENOENT/权限）必须挂 error 监听：不接则成 uncaught exception 杀 CLI。
  // 拉起失败时轮询会自然超时返回 null，这里只留可见报错（打到用户自己的终端 stderr）
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

import { spawn, spawnSync } from 'node:child_process'
import { Console } from 'node:console'
import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import type { Config } from '../config/types.js'
import { DEFAULT_GATEWAY_PORT } from '../config/types.js'
import { loadConfig } from '../config/store.js'
// 直取 state-file 单模块（perf-p2-polish）：绕开 gateway/state.js 聚合层——那会静态拖入
// logs→pricing-core 之外的整条 state 域；CLI 探活只需要 state-file 这 3.5KB 零重依赖叶子
import { gatewayLive, type GatewayStateFile } from '../gateway/state/state-file.js'
import { c, t, ensureDir, sleep, getLang, localDateStr } from '../util/index.js'
import { displayPath, logsDir, modeldockDir } from '../util/paths.js'
import { debugLog } from '../gateway/state/debuglog.js'

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

/** 鸭子同步直写流：真实 Writable（全量流面）+ write 覆写为 fs.writeSync 直写。
 *  面必须是完整流：process.stderr 会被 Node 内部当完整流对待——Console 错误处理链每次
 *  write 都跑「listenerCount → once → finally removeListener」（缺方法即同步抛，接管反而
 *  让 console.error 变崩溃源）；child_process 的 pipeWithoutWarning（worker/子进程 stdio
 *  继承管线，daemon 启动期 tsx transform worker 即触发）无警告 pipe 前要
 *  dest.setMaxListeners(Infinity) 再 source.pipe(dest)，鸭子裸对象缺一面就炸（两项均
 *  Node 24 实证，cruise1112 stderr 误绑）。write 覆写绕过 Writable 缓冲：缓冲异步刷，
 *  daemon「console.error 后即 process.exit」的路径（--port 校验报错等）会丢最后几行；
 *  fs.writeSync 直写同步落盘。写失败只返回 false 不抛不 emit（坏 fd 丢行好过崩进程）。 */
function makeDuckSyncWrite(fd: number): SyncWriteLike {
  const duck = new Writable({ write(_chunk, _enc, cb) { cb() } })
  duck.write = ((chunk: unknown): boolean => {
    try {
      // 两个重载各自只收 string / ArrayBufferView，联合实参必须按型分流调用
      if (typeof chunk === 'string') fs.writeSync(fd, chunk)
      else fs.writeSync(fd, Buffer.from(chunk as Uint8Array))
      return true
    } catch {
      return false
    }
  }) as unknown as typeof duck.write
  return duck
}

/** 按原 stderr 流形态构造替换流（cruise1112 stderr 误绑修复）。只复用 SyncWriteStream 的
 *  构造器——stdio ignore/文件重定向下 process.stderr 是它，构造器签名 (fd, opts) 与日志 fd
 *  同类（该类公开导出已在 Node 24 移除，只能从现有实例的 constructor 取内部类）。管道/TTY
 *  形态是 net.Socket：拿它 new 出来的是收养任意 fd 的 TCP Socket 而非文件流（数字 fd 重载
 *  还会把 autoClose 选项静默丢掉），下游行为不可控，一律走鸭子流。构造失败同样降级鸭子流，
 *  绝不向上抛。导出供单测钉住分流逻辑；生产路径只有 rebindStderrToLogFd 调用。 */
export function buildStderrReplacementStream(fd: number, staleCtor: unknown): { stream: SyncWriteLike; duck: boolean } {
  if (typeof staleCtor === 'function' && staleCtor.name === 'SyncWriteStream') {
    try {
      const real = new (staleCtor as unknown as new (fd: number, opts?: { autoClose?: boolean }) => SyncWriteLike)(fd, { autoClose: false })
      return { stream: real, duck: false }
    } catch {
      /* 构造失败退化为鸭子流 */
    }
  }
  return { stream: makeDuckSyncWrite(fd), duck: true }
}

/** Windows 降级路径（2026-10-30 probe，Node 24 实测）：stdio ignore 下 closeSync(2) 返回成功但
 *  std fd 槽位不真正释放（fstatSync(2) 前后同 inode、writeSync(2) 仍可写），openSync(log) 永落
 *  fd 3 —— fd 2 接管天然不可行。降级为「换流不换 fd」：把 process.stderr 与全局 console 重绑到
 *  直写日志 fd 的同步流，JS 可见的 stderr 输出（console.*、emitWarning、崩溃处理器）照常落日志；
 *  Node 原生崩溃输出仍进 NUL（fd 级无解，纯 JS 上限如此）。两步都尽力而为，失败静默降级。 */
/** stderr 重绑。返回最终形态：'stream'=SyncWriteStream 绑 fd 成功且属性已换；'duck'=鸭子流
 *  兜底（原流非 Sync/FILE 形态或构造失败；写入安全但 fs.writeSync 每次现做）；'none'=属性
 *  替换失败（原 stderr 原样保留）；'-console' 后缀=属性替换失败但全局 console 已整体换新
 *  （console.error 仍有健康落点）。返回值供启动诊断留痕（2026-11-07 事故：托盘拉起形态
 *  接管失效曾零痕迹）。 */
function rebindStderrToLogFd(fd: number): 'stream' | 'duck' | 'none' | 'stream-console' | 'duck-console' {
  // 访问 process.stderr 会触发懒初始化（绑 fd 2 = NUL，无输出副作用），随后被覆盖
  const { stream: fresh, duck } = buildStderrReplacementStream(
    fd,
    (process.stderr as unknown as { constructor?: unknown } | null)?.constructor
  )
  try {
    const stderrDesc = Object.getOwnPropertyDescriptor(process, 'stderr')
    if (stderrDesc?.configurable) {
      Object.defineProperty(process, 'stderr', { value: fresh, configurable: true, enumerable: true })
      return duck ? 'duck' : 'stream'
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
      return duck ? 'duck-console' : 'stream-console'
    }
  } catch {
    /* 极端环境：放弃 console 替换，stderr 重绑已尽力 */
  }
  return 'none'
}

const STDIO_DEFUSED = Symbol('modeldock-stdio-error-defused')

/** stdio 写错误降级为非致命（2026-11-07 生产事故防线）：托盘/GUI 父进程拉起的 daemon 会继承
 *  无效的 stdio 句柄，任何 stdio 写错误（EBADF 等）默认以「流上无人监听的 error 事件」形式
 *  炸掉整个进程——接入计划里 DEP0190 弃用警告的那次 stderr 写入即实证（进程零痕迹死亡）。
 *  常驻守护丢几行日志远好过整进程陪葬。幂等：同一流只挂一次（Symbol 标记防重复堆监听）。 */
export function defuseStdioErrors(): void {
  for (const stream of [process.stdout, process.stderr]) {
    try {
      const s = stream as unknown as Record<symbol, unknown> & { on?: (ev: string, cb: (...a: unknown[]) => void) => unknown }
      if (!s || s[STDIO_DEFUSED] === true) continue
      s[STDIO_DEFUSED] = true
      s.on?.('error', () => {})
    } catch {
      /* 鸭子流（无 on 方法）或懒初始化失败：无可挂，忽略 */
    }
  }
}

/** 启动诊断（无条件落盘，不挂 debug 门）：daemon stderr 接管的形态与落点是 2026-11-07 事故的
 *  直接指纹（托盘拉起形态接管失效 → 任何 stderr 写入都可能致死且零痕迹，当时无法从任何日志
 *  看出接管状态）。debug 文件行不经 stderr、必定落盘；console.error 走接管后的 stderr，健康时
 *  额外落 daemon-<date>.log。文案用稳定英文技术行（诊断机器行，不走 i18n）。 */
function bootDiag(data: Record<string, unknown>): void {
  debugLog('boot', 'stderr_takeover', data)
  try {
    console.error(`[modeldock] stderr takeover: ${JSON.stringify(data)}`)
  } catch {
    /* 坏流已 defuse（error 事件非致命），同步抛也兜住 */
  }
}

/** daemon 形态启动早期接管 fd 2 → logs/daemon-<date>.log：daemon 的崩溃/启动报错自写日志
 *  （进程级 stderr 全量落盘，含 Node 原生崩溃输出），父 CLI 才能用 stdio 全 ignore 拉起而不把
 *  自己钉住（CORRECT-07：pipe 读端 flowing 态被事件循环引用，daemon 常驻 fd 2 永不关闭）。
 *  fd 级重定向无半行缓冲/丢行问题（原父侧逐行转写随 stdio ignore 整段移除，日志保真由 fd 直写
 *  继承；Windows 换行以 \r\n 原样落盘）。必须在 daemon 进程消费 process.stderr 之前调用——
 *  stdio ignore 下 stderr 句柄懒初始化，先腾 fd 再写即全部落进日志。保留期随 pruneExpiredLogs。
 *  返回日志路径；接管失败（极端环境）返回 null，stderr 保持原状仅降级不阻断。
 *  进入即先 defuseStdioErrors()：接管成功与否未知，stdio 写错误都必须先变成非致命。 */
export function redirectDaemonStderrToLog(): string | null {
  defuseStdioErrors()
  const logPath = path.join(logsDir(), `daemon-${localDateStr()}.log`)
  fs.mkdirSync(logsDir(), { recursive: true })
  try {
    try {
      fs.closeSync(2) // 腾出 fd 2（stdio ignore 下 unix 指向 /dev/null；Windows 上不真正释放槽位，见 rebindStderrToLogFd）
    } catch {
      /* 已关闭 */
    }
    const fd = fs.openSync(logPath, 'a') // unix：单线程启动期最低可用 fd 必为 2
    if (fd === 2) {
      bootDiag({ takeover: 'fd2', fd, log: displayPath(logPath) })
      return logPath // unix fd 级接管成功（含 Node 原生崩溃输出）
    }
    // Windows（probe 实测 fd 恒落 3）：fd 2 接管不可行 → 换流不换 fd，JS 可见 stderr 输出落日志
    try {
      const mode = rebindStderrToLogFd(fd)
      defuseStdioErrors() // process.stderr 已被换成新流：新流也要挂上 error 兜底
      bootDiag({ takeover: 'rebind', fd, mode, log: displayPath(logPath) })
      return logPath
    } catch (e) {
      bootDiag({ takeover: 'failed', fd, err: (e as Error).message?.slice(0, 200) })
      try {
        fs.closeSync(fd)
      } catch {
        /* 尽力清理 */
      }
      return null
    }
  } catch (e) {
    // 日志文件打不开：stderr 保持原状，功能不受影响——但必须留痕（诊断指纹）
    bootDiag({ takeover: 'log-open-failed', err: (e as Error).message?.slice(0, 200) })
    return null
  }
}

/** 分离拉起网关守护进程并轮询就绪（默认 20×250ms=5s；rounds 可调）。返回活网关状态；超时返回 null。
 *  probe 探活函数、spawnFn 执行器均可注入（单测传 fake，避免真实探测网关/起 daemon）。
 *  SEA 双击冷启逢 Defender/SmartScreen 扫描可能 >5s，GUI 路径（cli.ts launchGui）传更大 rounds。
 *  daemon 侧经 redirectDaemonStderrToLog() 自写 logs/daemon-<date>.log（cli.ts --sea-gateway 分支）。 */
export async function spawnDaemonAndWait(
  argv: string[],
  probe: () => Promise<GatewayStateFile | null> = gatewayLive,
  spawnFn: typeof spawn = spawn,
  rounds = 20
): Promise<GatewayStateFile | null> {
  await ensureDir(modeldockDir())
  const child = spawnFn(argv[0], argv.slice(1), {
    detached: true,
    // 全 ignore：报错由 daemon 侧 fd 2 接管自写日志（见 redirectDaemonStderrToLog 注）；持流会被读端钉住不退出（CORRECT-07）
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

import { spawn, spawnSync } from 'node:child_process'
import type { Config } from '../config/types.js'
import { DEFAULT_GATEWAY_PORT } from '../config/types.js'
import { loadConfig } from '../config/store.js'
import { gatewayLive, type GatewayStateFile } from '../gateway/state.js'
import { c, t, ensureDir, sleep, getLang } from '../util/index.js'
import { modeldockDir } from '../util/paths.js'

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

// ── CLI/进程原语（去重，DUP-01）────────────────────────────────────────────

/** 分离拉起网关守护进程并轮询就绪（20×250ms）。返回活网关状态；超时返回 null。
 *  probe 探活函数、spawnFn 执行器均可注入（单测传 fake，避免真实探测网关/起 daemon）。 */
export async function spawnDaemonAndWait(
  argv: string[],
  probe: () => Promise<GatewayStateFile | null> = gatewayLive,
  spawnFn: typeof spawn = spawn
): Promise<GatewayStateFile | null> {
  await ensureDir(modeldockDir())
  const child = spawnFn(argv[0], argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    // daemon 与 CLI 语言一致：config.toml 尚无 language 时 CLI 的 --lang/环境变量选择也要传下去
    env: { ...process.env, MODELRDOCK_LANG: getLang() },
    cwd: modeldockDir(),
    windowsHide: true, // Windows：detached 控制台程序默认弹驻留窗口，隐藏之
  })
  child.unref()
  for (let i = 0; i < 20; i++) {
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
 *  unix 保持 SIGTERM（优雅退出）。返回是否实际发出终结信号（false = 已退出/权限不足，调用方据此决定计数）。
 *  spawnSyncFn 执行器可注入（单测传 fake，绝不真杀进程）。 */
export function killByPid(pid: number, spawnSyncFn: typeof spawnSync = spawnSync): boolean {
  if (process.platform === 'win32') {
    const r = spawnSyncFn('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true })
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

/** 解析 "pid command" 行（listProcessLines 输出）。容错：空行/脏行跳过。 */
const PROC_LINE_RE = /^\s*(\d+)\s+(.*)$/
export function parsePidCommandLines(lines: string): { pid: number; cmd: string }[] {
  const out: { pid: number; cmd: string }[] = []
  for (const line of lines.split('\n')) {
    const m = line.match(PROC_LINE_RE)
    if (!m) continue
    out.push({ pid: Number(m[1]), cmd: m[2] })
  }
  return out
}

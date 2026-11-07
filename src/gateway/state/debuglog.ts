import { appendLog } from './logs.js'
import { localIsoTs } from '../../util/time.js'
import { c } from '../../util/color.js'
import type { GatewayConfig } from '../../config/types.js'

/**
 * debug 日志（2026-11-07 一键接入静默死亡事故的诊断盲区补课）：
 *  - 开关三源合并，任一为真即开，**默认全关**：`gateway start --debug` 旗标 > `MODELRDOCK_DEBUG=1`
 *    环境变量 > config.toml `[gateway] debug`。config 键随热加载即时生效（改配置排障免重启），
 *    是托盘/自启拉起形态下唯一可动态开启的通道（argv 不经手）。
 *  - 落点 logs/debug-<date>.jsonl（按天 JSONL，保留期随 LOG_DAY_FILE_RE 自动清理），行结构
 *    `{ts, level:'debug', scope, op, ...data}`；scope=模块名，预留未来按 scope 过滤。
 *  - 关态零开销：调用方以 `debugOn()` 短路，不格式化不建对象；本模块状态一个布尔。
 *  - 前台 TTY 时镜像一行灰色 console（现场可见）；daemon 形态 isTTY=false 只落文件——
 *    事故教训：daemon 的 console 不可信（stdio 可能损坏），诊断以文件为准。
 *  - 脱敏纪律：data 只放 id/命令行/退出码/耗时等；key/token 一律不落（沿用 logRequest
 *    schema 无 key 字段、tokenHint 只取前 8 字符的既有口径）。
 */

let flagFromArgv = false
let on = false

/** 记录 CLI 旗标（仅 gateway start --debug / --sea-gateway --debug 传入；自启 argv 不带旗标）。 */
export function setDebugFlag(flag: boolean): void {
  flagFromArgv = flag === true
  refreshDebugOn()
}

/** 开关重算：启动后与每次热加载（reloadRuntime）调用。旗标/环境变量/配置任一为真即开。 */
export function refreshDebugOn(config?: GatewayConfig | null): void {
  on = flagFromArgv || process.env.MODELRDOCK_DEBUG === '1' || config?.debug === true
}

/** 当前 debug 是否开启（调用点短路用）。 */
export function debugOn(): boolean {
  return on
}

/** 纯函数求值（不读模块态）：doctor 展示与单测用。旗标参数供「flag 覆盖 env/config」语义验证。 */
export function debugEnabled(opts: { flag?: boolean; config?: GatewayConfig | null } = {}): boolean {
  if (opts.flag === true) return true
  if (process.env.MODELRDOCK_DEBUG === '1') return true
  return opts.config?.debug === true
}

/** debug 行落盘（调用方先 debugOn() 短路）。写失败静默——诊断日志绝不反噬主流程。 */
export function debugLog(scope: string, op: string, data?: Record<string, unknown>): void {
  try {
    const ts = localIsoTs()
    // 追加流池不自带换行（与 logRequest 同款调用方补 '\n'）
    appendLog(`debug-${ts.slice(0, 10)}.jsonl`, JSON.stringify({ ts, level: 'debug', scope, op, ...(data ?? {}) }) + '\n')
    if (process.stdout.isTTY) {
      try {
        console.error(c.gray(`[debug:${scope}] ${op}${data ? ` ${JSON.stringify(data)}` : ''}`))
      } catch {
        /* stdio 坏流（defuse 已兜 error 事件，这里兜同步抛）：吞掉 */
      }
    }
  } catch {
    /* 目录不可写等：诊断日志放弃，不影响主流程 */
  }
}

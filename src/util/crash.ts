import fs from 'node:fs'
import path from 'node:path'
import { logsDir } from './paths.js'
import { localIsoTs } from './time.js'

/** 崩溃痕迹落盘（追加式）：logs/crash-YYYYMMDD.log（本地日期，无分隔符与保留期按天 JSONL 区分）。
 *  同步写（appendFileSync）：uncaughtException 处理器随后即 process.exit，异步流的缓冲等不到刷盘。
 *  写盘失败 try/catch 包住——崩中崩绝不能再抛。 */
export function appendCrashLog(msg: string): void {
  try {
    const dir = logsDir()
    fs.mkdirSync(dir, { recursive: true })
    const d = new Date()
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    fs.appendFileSync(path.join(dir, `crash-${ymd}.log`), `[${localIsoTs(d)}] ${msg}\n`)
  } catch {
    /* 日志目录不可写等：只能放弃，不能再抛 */
  }
}

let installed = false

/** 注册进程级兜底（幂等，重复调用不重复注册；main.ts 守护入口与 cli.ts 各接一次）：
 *  - uncaughtException：落盘后优雅退出（进程状态已不可信，继续跑风险更大）；同步写保证先落盘再退。
 *  - unhandledRejection：仅记录不退出——Node ≥15 的默认行为是杀进程，但 rejection 多为单链路
 *    失败（fire-and-forget 的后台任务），留痕继续跑对常驻网关更友好。
 *  两条都同时 console.error：前台 CLI 保持「崩溃看得见」，daemon（stdio 收进 daemon 日志）靠文件。 */
export function installCrashHandlers(): void {
  if (installed) return
  installed = true
  process.on('uncaughtException', (err) => {
    const text = `uncaughtException: ${err?.stack ?? String(err)}`
    console.error(`[modeldock] ${text}`)
    appendCrashLog(text)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    const text = `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`
    console.error(`[modeldock] ${text}`)
    appendCrashLog(text)
  })
}

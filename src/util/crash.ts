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

/** 崩溃上报统一出口：**先落盘、后 console**。顺序是 2026-11-07 生产事故的直接教训——托盘/GUI
 *  父进程拉起的 daemon 可能继承损坏的 stderr（写错误反过来炸进程），console.error 若排在
 *  appendCrashLog 之前，坏流会把崩溃文件一起带走：进程以零痕迹死亡（无 crash 文件、无 daemon
 *  日志、无 WER 事件）。console 自身 try/catch 兜住——前台可见性尽力而为，落盘是底线。 */
export function reportCrash(kind: 'uncaughtException' | 'unhandledRejection', detail: string): void {
  const text = `${kind}: ${detail}`
  appendCrashLog(text)
  try {
    console.error(`[modeldock] ${text}`)
  } catch {
    /* stderr 坏流（EBADF 等）：吞掉——落盘已完成，不能再抛 */
  }
}

/** 注册进程级兜底（幂等，重复调用不重复注册；main.ts 守护入口与 cli.ts 各接一次）：
 *  - uncaughtException：落盘后优雅退出（进程状态已不可信，继续跑风险更大）；同步写保证先落盘再退。
 *  - unhandledRejection：仅记录不退出——Node ≥15 的默认行为是杀进程，但 rejection 多为单链路
 *    失败（fire-and-forget 的后台任务），留痕继续跑对常驻网关更友好。
 *  两条都同时 console.error：前台 CLI 保持「崩溃看得见」，daemon（stdio 收进 daemon 日志）靠文件。 */
export function installCrashHandlers(): void {
  if (installed) return
  installed = true
  process.on('uncaughtException', (err) => {
    reportCrash('uncaughtException', err?.stack ?? String(err))
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    reportCrash('unhandledRejection', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))
  })
}

import path from 'node:path'
import fs from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { logsDir } from '../../util/paths.js'
import { appendLine, closeAppendStream } from '../../util/fsx.js'
import { localIsoTs } from '../../util/time.js'
import type { AuditEntry, EventEntry, GatewayRuntime, LogEntry, RingEntry } from './types.js'

const RING_MAX = 500

/** 内存环形缓冲统一入口（保持 RING_MAX 上限，先进先出挤掉最旧）。导出供 setEventRingSink
 *  注册的转发等模块外写入用。 */
export function pushRing(rt: GatewayRuntime, entry: RingEntry): void {
  rt.ring.push(entry)
  if (rt.ring.length > RING_MAX) rt.ring.splice(0, rt.ring.length - RING_MAX)
}

/** 日志目录只建一次（按路径记忆）：转发热路径上每次写日志都 mkdirSync 是无谓的同步 syscall；
 *  fake home 等目录切换时路径不同会自动重建。 */
let ensuredLogDir = ''
function ensureLogDir(dir: string): void {
  if (ensuredLogDir === dir) return
  fs.mkdirSync(dir, { recursive: true })
  ensuredLogDir = dir
}

/** 高频 JSONL 落盘走 fsx 的常驻追加流池（appendFile 每条 open+write+close 走线程池，热路径
 *  上与转发争 IO）；目录仍在此按路径记忆只建一次，fake home 等目录切换时路径不同会自动重建。 */
function appendLog(file: string, line: string): void {
  const dir = logsDir()
  ensureLogDir(dir)
  appendLine(path.join(dir, file), line)
}

/** 请求日志：全量按天 JSONL 落盘（不含任何请求体）；仅错误请求（4xx/5xx/异常/自动改发）进内存环形缓冲供 Web 端展示 */
export function logRequest(rt: GatewayRuntime, entry: LogEntry): void {
  // 避免被高频正常请求刷屏
  if (entry.status === undefined || entry.status >= 400 || entry.err || entry.reason) {
    pushRing(rt, entry)
  }
  // 轻量 metrics：per-provider 耗时采样。与 health.lastMs 的「只记成功」口径不同——metrics 是
  // 吞吐/延迟观测面，失败请求的耗时同样计入分布；provider '-'（未鉴权噪音）不计
  if (entry.ms != null && entry.provider && entry.provider !== '-') {
    let m = rt.metricsLatency.get(entry.provider)
    if (!m) {
      m = { samples: [], count: 0 }
      rt.metricsLatency.set(entry.provider, m)
    }
    m.count++
    m.lastMs = entry.ms
    m.samples.push(entry.ms)
    if (m.samples.length > METRICS_SAMPLES_MAX) m.samples.splice(0, m.samples.length - METRICS_SAMPLES_MAX)
  }
  try {
    appendLog(`gateway-${entry.ts.slice(0, 10)}.jsonl`, JSON.stringify(entry) + '\n')
  } catch {
    /* 日志失败不影响转发 */
  }
}

/** 操作审计：环形缓冲（页面日志表可见）+ 按天 JSONL 落盘 audit-日期.jsonl（不含密钥明文） */
export function logAudit(rt: GatewayRuntime, entry: AuditEntry): void {
  pushRing(rt, entry)
  try {
    appendLog(`audit-${entry.ts.slice(0, 10)}.jsonl`, JSON.stringify(entry) + '\n')
  } catch {
    /* 审计失败不影响操作本身 */
  }
}

let eventRingSink: ((entry: EventEntry) => void) | null = null
/** 注册事件 → ring 转发（网关进程启动时调一次，main.ts）：ops 层（switchToService 等）没有
 *  rt 上下文，reportEvent 只落 events.jsonl；经此把同一事件同步进网关运行时 ring，页面日志表
 *  可见。传 null 撤销（测试用）。 */
export function setEventRingSink(fn: ((entry: EventEntry) => void) | null): void {
  eventRingSink = fn
}

function eventEntryOf(e: { level: 'warn' | 'error'; op: string; err: string }): EventEntry {
  return {
    ts: localIsoTs(),
    kind: 'event',
    level: e.level,
    op: e.op,
    err: e.err,
    harness: '-',
    profile: '-',
    provider: '-',
    path: `event:${e.op}`,
  }
}

/** 后台链路事件（有 rt）：错误 ring（页面日志表可见）+ events.jsonl 落盘。
 *  吞错上报通道——后台 catch 原先 `.catch(() => {})` 的失败改调这里，无声失败变成可排查痕迹。 */
export function logEvent(rt: GatewayRuntime, e: { level: 'warn' | 'error'; op: string; err: string }): void {
  const entry = eventEntryOf(e)
  pushRing(rt, entry)
  try {
    appendLog('events.jsonl', JSON.stringify(entry) + "\n")
  } catch {
    /* 事件日志失败不影响主流程 */
  }
}

/** 后台链路事件（无 rt 的 ops 层）：events.jsonl 恒落；网关进程内经 eventRingSink 同步进 ring，
 *  纯 CLI 上下文（网关未运行）只落文件。 */
export function reportEvent(e: { level: 'warn' | 'error'; op: string; err: string }): void {
  const entry = eventEntryOf(e)
  try {
    appendLog('events.jsonl', JSON.stringify(entry) + "\n")
  } catch {
    /* 事件日志失败不影响主流程 */
  }
  try {
    eventRingSink?.(entry)
  } catch {
    /* 转发失败不影响主流程 */
  }
}

// ===== 轻量 metrics（/_modeldock/metrics，admin 门内）=====

/** per-provider 耗时采样窗口上限（与日志 ring 同量级，内存有界：500 条 × 8 字节 × 服务数） */
const METRICS_SAMPLES_MAX = 500

/** 分位数（线性插值，Prometheus 口径）。samples 任意顺序、不改原数组；空数组三个分位均为 null。
 *  纯函数：/_modeldock/metrics 与单测共用。 */
export function latencyQuantiles(
  samples: readonly number[]
): { p50: number | null; p95: number | null; p99: number | null } {
  if (!samples.length) return { p50: null, p95: null, p99: null }
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number): number => {
    const pos = (sorted.length - 1) * q
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
  }
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) }
}

// 事件循环延迟采样：main.ts 启动处挂一次（懒初始化——单测直建 rt 不挂，metrics.eventLoopLagMs
// 为 null，避免测试副作用）。monitorEventLoopDelay 直方图每 60s 取一次均值后 reset。
let loopLagHist: import('node:perf_hooks').IntervalHistogram | null = null
let loopLagMs: number | null = null

/** 启动事件循环延迟采样（重复调用幂等）。失败静默：采样不可用只影响 metrics 观测面。 */
export function startEventLoopDelaySampler(sampleMs = 60_000): void {
  if (loopLagHist) return
  try {
    const h = monitorEventLoopDelay({ resolution: 20 })
    h.enable()
    loopLagHist = h
    const timer = setInterval(() => {
      const hist = loopLagHist
      if (!hist || hist.count === 0) return // 空闲窗口无样本：保留上一次采样值
      loopLagMs = hist.mean / 1e6 // ns → ms
      hist.reset()
    }, sampleMs)
    timer.unref?.()
  } catch {
    /* 采样不可用不影响网关；eventLoopLagMs 保持 null */
  }
}

/** 最近一次采样的事件循环延迟均值（ms）；未启动采样或首个采样窗口未满时为 null。 */
export function eventLoopLagMs(): number | null {
  return loopLagMs
}

/** JSONL 日志保留期清理（PERF-16）：gateway-/audit- 按天日文件无界累积，超保留天数的在
 *  网关启动与每日定时删除。文件名严格锚定、日期非法的一律不碰；被常驻流池持有句柄的
 *  日文件先关流再删（Windows 文件有本进程 fd 时 unlink 报 EPERM/EBUSY），删除失败跳过、
 *  次日定时重试。返回删除数；retentionDays 非正数视为禁用。 */
const LOG_DAY_FILE_RE = /^(gateway|audit)-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

export async function pruneExpiredLogs(retentionDays: number, now = new Date()): Promise<number> {
  const days = Math.floor(Number(retentionDays))
  if (!Number.isFinite(days) || days <= 0) return 0
  const dir = logsDir()
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  let pruned = 0
  for (const name of names) {
    const m = LOG_DAY_FILE_RE.exec(name)
    if (!m) continue
    const fileDate = new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4])).getTime()
    if (!Number.isFinite(fileDate)) continue
    if (startOfToday - fileDate <= days * 86_400_000) continue
    const full = path.join(dir, name)
    await closeAppendStream(full)
    try {
      fs.unlinkSync(full)
      pruned++
    } catch {
      /* 被外部进程占用等：跳过，次日定时重试 */
    }
  }
  return pruned
}

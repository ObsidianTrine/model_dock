import path from 'node:path'
import fs from 'node:fs'
import { createInterface } from 'node:readline'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { logsDir } from '../../util/paths.js'
import { appendLine, closeAppendStream } from '../../util/fsx.js'
import { localIsoTs } from '../../util/time.js'
import { costOfUsage, type PriceResolver } from '../../providers/pricing-core.js'
import type { AuditEntry, EventEntry, GatewayRuntime, LogEntry, RingEntry } from './types.js'

const RING_MAX = 500
/** 成功请求环形缓冲上限：只服务控制台「成功请求」筛选页的近期展示/复制，够看即可（全量在 jsonl 文件） */
const OK_RING_MAX = 200

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
 *  上与转发争 IO）；目录仍在此按路径记忆只建一次，fake home 等目录切换时路径不同会自动重建。
 *  导出给 debuglog 复用（同一目录、同一流池、同一 health 计数）。 */
export function appendLog(file: string, line: string): void {
  const dir = logsDir()
  ensureLogDir(dir)
  appendLine(path.join(dir, file), line)
}

/** 请求日志：全量按天 JSONL 落盘（不含任何请求体）；仅错误请求（4xx/5xx/异常/自动改发）进内存环形缓冲供 Web 端展示，
 *  成功请求另进 okRing 小缓冲（控制台「成功请求」筛选页用）。级别按结构化日志惯例统一补写：
 *  失败=error、偏离主选（改发/排队/退避，reason 非空）=warn、普通成功=info。 */
export function logRequest(rt: GatewayRuntime, entry: LogEntry): void {
  if (!entry.level) {
    entry.level = entry.status === undefined || entry.status >= 400 || entry.err ? 'error' : entry.reason ? 'warn' : 'info'
  }
  // 今日用量实况（overview 状态行的成本仪表）：先记账再落盘，观测失败绝不影响转发
  try {
    usageTodayAdd(entry)
  } catch {
    /* 观测失败不影响转发 */
  }
  // 避免被高频正常请求刷屏
  if (entry.status === undefined || entry.status >= 400 || entry.err || entry.reason) {
    pushRing(rt, entry)
  } else if (rt.okRing) {
    rt.okRing.push(entry)
    if (rt.okRing.length > OK_RING_MAX) rt.okRing.splice(0, rt.okRing.length - OK_RING_MAX)
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

// ===== 今日用量实况（overview 状态行的成本仪表 / usageToday）=====
// 内存累计器（usagePriceResolver 查价），网关重启后首次触达时回填扫当日日文件——
// 「今日」语义跨重启不失忆。回填走 streamRequestLogDays 流式管道异步预热（P2-11：跨日/重启
// 首笔请求曾同步 readFileSync 整份当日文件冻结事件循环、在途 SSE 全卡——与 31 天查询的
// 流式化同款治理）；在飞期间 logRequest 逐条增量照常，仪表先见增量后补全量。跨日 /
// 日志目录切换（fake home）自动重置。
// 查价器由 daemon 启动注入（perf-p2-polish）：logs 域不再静态依赖 pricing → catalog →
// catalog-snapshot（1.18MB），CLI 命令启动闭包不再拖入；未注入（CLI 直用累计器等场景）
// 时不计成本，与 createUsageAccumulator 的 priceOf 缺省行为一致。
let usagePriceResolver: PriceResolver | undefined
/** 注入今日仪表/记账查价器（daemon 启动时传 gatewayPriceResolver；测试按需注入）。 */
export function setUsagePriceResolver(r: PriceResolver | undefined): void {
  usagePriceResolver = r
}
export interface UsageTodayView {
  date: string
  requests: number
  ok: number
  failed: number
  tokens: { input: number; output: number; cache_read: number; cache_creation: number }
  cost: UsageCost | null
  unpriced_models: string[] | null
}

interface TodayTracker {
  dir: string
  date: string
  acc: ReturnType<typeof createUsageAccumulator>
  /** 增量记账时间下界（epoch ms，Date.parse 归一比较——条目 ts 与本地时钟同为带偏移 ISO，
   *  字典序跨偏移不可比）：回填只计 ts 早于该时刻的落盘条目，此后 logRequest 增量记账的条目
   *  （ts ≥ 下界）不与回填重叠——创建条目本身传其 ts 作下界，被增量记账、被回填跳过，双计
   *  窗口收敛到毫秒级（P2-11）。 */
  sinceMs: number
  backfilling: boolean
}

let todayTracker: TodayTracker | null = null

function ensureTodayTracker(sinceTs?: string): TodayTracker {
  const dir = logsDir()
  const date = localIsoTs().slice(0, 10)
  if (todayTracker && todayTracker.dir === dir && todayTracker.date === date) return todayTracker
  const t: TodayTracker = { dir, date, acc: createUsageAccumulator(usagePriceResolver), sinceMs: Date.parse(sinceTs ?? localIsoTs()), backfilling: true }
  todayTracker = t
  void backfillTodayTracker(t)
  return t
}

/** 回填当日日文件（streamRequestLogDays 流式，同 31 天查询一条解析管道）：逐行边读边累加，
 *  不再把整份文件 readFileSync 进事件循环。只计 ts 早于 sinceMs 的条目——之后的条目由
 *  logRequest 增量记账覆盖，不双计；ts 解析失败的旧日志按旧口径照计（sync 时代全量入账）；
 *  回填失败按增量口径继续（仪表短时偏小，不影响转发）。 */
async function backfillTodayTracker(t: TodayTracker): Promise<void> {
  try {
    for await (const e of streamRequestLogDays([t.date], {})) {
      const ms = Date.parse(String(e.ts))
      if (Number.isFinite(ms) && ms >= t.sinceMs) continue
      t.acc.add(e)
    }
  } catch {
    /* 回填失败不影响转发；仪表按已收到的部分展示 */
  } finally {
    t.backfilling = false
  }
}

/** logRequest 热路径记账（entry.ts 的日期即所属日——迟到条目也归对日）。 */
function usageTodayAdd(entry: LogEntry): void {
  const t = ensureTodayTracker(entry.ts)
  if (entry.ts.slice(0, 10) === t.date) t.acc.add(entry)
}

/** 今日用量视图（overview 构建用；失败/空目录返回零值视图，不抛）。 */
export function usageTodayView(): UsageTodayView {
  try {
    const { date, acc } = ensureTodayTracker()
    const s = acc.summary()
    return {
      date,
      requests: s.requests,
      ok: s.ok,
      failed: s.failed,
      tokens: s.tokens,
      cost: s.cost,
      unpriced_models: s.unpriced_models,
    }
  } catch {
    return {
      date: localIsoTs().slice(0, 10),
      requests: 0,
      ok: 0,
      failed: 0,
      tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      cost: null,
      unpriced_models: null,
    }
  }
}

/** 重置今日仪表（测试隔离：fakeHome 切换由 dir 键自愈，此钩子供显式清零）。 */
export function resetUsageTodayForTest(): void {
  todayTracker = null
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

// ===== 请求日志聚合（/_modeldock/usage，admin 门内）=====
// 数据源 = 日文件全量条目（内存 ring 只有错误与路由事件，查账要含成功流量）。
// 消费方：Web 排查、Dockmaster 编排侧（燃油实测账 / 风暴闸外部海况的数据面）。

const USAGE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 读某本地日期的请求日志（gateway-YYYY-MM-DD.jsonl，容错崩溃半行）。日期格式严格校验
 *  （防拼接逃逸），文件缺失返回空数组。 */
export function readRequestLogDay(date: string): LogEntry[] {
  if (!USAGE_DAY_RE.test(date)) return []
  const file = path.join(logsDir(), `gateway-${date}.jsonl`)
  if (!fs.existsSync(file)) return []
  const out: LogEntry[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as LogEntry)
    } catch {
      /* 崩溃半行 */
    }
  }
  return out
}

export interface UsageFilter {
  harness?: string
  profile?: string
  provider?: string
  /** 网关侧错误归类短码（LogEntry.cause 同枚举，见 state/types.ts）；/logs/query 过滤维度 */
  cause?: string
  /** HTTP 状态类（'2xx'…'5xx'）；无 status 的条目（客户端中止等）不命中任何状态类 */
  statusClass?: string
  /** 毫秒时间窗（含边界）；未提供的边界不设限 */
  fromMs?: number
  toMs?: number
}

/** 单条是否命中过滤（全部条件 AND；未提供的维度不过滤）。filterLogEntries 与流式聚合共用。 */
export function logEntryMatches(e: LogEntry, f: UsageFilter): boolean {
  if (f.harness && e.harness !== f.harness) return false
  if (f.profile && e.profile !== f.profile) return false
  if (f.provider && e.provider !== f.provider) return false
  if (f.cause && e.cause !== f.cause) return false
  if (f.statusClass) {
    if (e.status == null) return false
    if (`${Math.floor(e.status / 100)}xx` !== f.statusClass) return false
  }
  const ts = new Date(String(e.ts)).getTime()
  if (f.fromMs != null && !(ts >= f.fromMs)) return false
  if (f.toMs != null && !(ts <= f.toMs)) return false
  return true
}

/** 按维度过滤请求条目（全部条件 AND；未提供的维度不过滤）。纯函数，单测共用。 */
export function filterLogEntries(entries: LogEntry[], f: UsageFilter): LogEntry[] {
  return entries.filter((e) => logEntryMatches(e, f))
}

/** 成本聚合（USD）：仅注入 priceResolver 时产出；unpriced = 查不到单价的模型清单（按 $0 计）。 */
export interface UsageCost {
  total: number
  by_provider: Record<string, number>
  by_model: Record<string, number>
}

export interface UsageSummary {
  requests: number
  ok: number
  failed: number
  /** 失败状态计数（status 缺失计 'n/a'）；成功不进表 */
  by_status: Record<string, number>
  by_provider: Record<string, number>
  by_model: Record<string, number>
  /** 成功请求的时延分位（线性插值，同 metrics 口径） */
  latency: { p50: number | null; p95: number | null; p99: number | null }
  /** 按 model 分桶的成功请求时延（与 latency 同口径：只计成功且有 ms 的条目）。可选字段：
   *  旧版消费方/旧聚合产物不带此键不破。avg_ms 为算术均值，分位线性插值同 latencyQuantiles。 */
  latency_by_model?: Record<string, { count: number; avg_ms: number; p50_ms: number | null; p95_ms: number | null }>
  /** 实测用量（成功且有 usage 的条目；缓存读+缓存建计入 input——与 reconcile 对账口径一致） */
  tokens: { input: number; output: number; cache_read: number; cache_creation: number }
  /** 按 model 分桶的实测用量（与 tokens 同口径：成功且有 usage 的条目；缓存读+缓存建计入
   *  input_tokens）。可选字段：旧版消费方/旧聚合产物不带此键不破；窗口内条目缺 model 的
   *  （极老日志）跳过不记账——模型级容灾（model_fallback）的 per-model 观测面。 */
  tokens_by_model?: Record<
    string,
    { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }
  >
  /** 可计费口径合计（成功且有 usage 的条目，与 tokens 同口径；剔除缓存读的公式在条目落盘前
   *  已按协议形态算好——此处只求和，绝不重算）。窗口内条目缺该数字的跳过（不入和）。 */
  billable_tokens: number
  /** 上述求和是否可信完整：窗口内存在「有 usage 对象但缺 billable_tokens 数字」的条目
   *  （旧版网关日志混入）时为 true——消费方（编排侧 reconcile）据此整体回落文件直读。
   *  窗口内完全没有 usage 条目时为 false（空窗口语义：0 和是完整的）。 */
  billable_partial: boolean
  /** 成本（USD / 百万 token 牌价口径）；未注入 priceResolver 时为 null */
  cost: UsageCost | null
  /** 注入 resolver 时：命中过但查不到单价的模型名（成本按 $0 计，提醒补 pricing.json） */
  unpriced_models: string[] | null
  /** 命中条目的首尾时间戳（原样 ISO 字符串；空集为 null） */
  window: { first: string | null; last: string | null }
}

/** 聚合累加器：summarizeUsage（数组入参，单测/既有调用面）与 summarizeUsageDays（流式）
 *  共用同一套累加口径，两边结果逐字段一致。priceOf 注入时顺带累计成本（同一批成功条目）。 */
export function createUsageAccumulator(priceOf?: PriceResolver) {
  const byStatus: Record<string, number> = {}
  const byProvider: Record<string, number> = {}
  const byModel: Record<string, number> = {}
  const ms: number[] = []
  const msByModel: Record<string, number[]> = {}
  const tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
  const tokensByModel: NonNullable<UsageSummary['tokens_by_model']> = {}
  let billableTokens = 0
  let billablePartial = false
  const cost: UsageCost | null = priceOf ? { total: 0, by_provider: {}, by_model: {} } : null
  const unpriced = priceOf ? new Set<string>() : null
  let ok = 0
  let count = 0
  let first: string | null = null
  let last: string | null = null
  return {
    add(e: LogEntry) {
      count++
      first ??= e.ts
      last = e.ts
      if (e.provider) byProvider[e.provider] = (byProvider[e.provider] ?? 0) + 1
      if (e.model) byModel[e.model] = (byModel[e.model] ?? 0) + 1
      const isOk = e.status !== undefined && e.status < 400
      if (isOk) {
        ok++
        if (e.ms != null) {
          ms.push(e.ms)
          if (e.model) (msByModel[e.model] ??= []).push(e.ms)
        }
        const u = e.usage
        if (u) {
          tokens.input += (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0)
          tokens.output += u.output_tokens ?? 0
          tokens.cache_read += u.cache_read_tokens ?? 0
          tokens.cache_creation += u.cache_creation_tokens ?? 0
          // per-model 四桶与全局 tokens 同口径累加；条目缺 model（极老日志）跳过不记账
          if (e.model) {
            const tm = (tokensByModel[e.model] ??= { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 })
            tm.input_tokens += (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0)
            tm.output_tokens += u.output_tokens ?? 0
            tm.cache_read_tokens += u.cache_read_tokens ?? 0
            tm.cache_creation_tokens += u.cache_creation_tokens ?? 0
          }
          // billable 只求和不重算（公式分协议形态，条目落盘前已算好）；缺数字 = 旧版日志 → partial
          const b = u.billable_tokens
          if (typeof b === 'number' && Number.isFinite(b)) billableTokens += b
          else billablePartial = true
          if (priceOf && cost && unpriced) {
            const price = priceOf(e.provider, e.model)
            if (price) {
              const c = costOfUsage(u, price)
              cost.total += c
              if (e.provider) cost.by_provider[e.provider] = (cost.by_provider[e.provider] ?? 0) + c
              if (e.model) cost.by_model[e.model] = (cost.by_model[e.model] ?? 0) + c
            } else {
              unpriced.add(e.model || '(unknown)')
            }
          }
        }
      } else {
        const k = String(e.status ?? 'n/a')
        byStatus[k] = (byStatus[k] ?? 0) + 1
      }
    },
    summary(): UsageSummary {
      const latencyByModel: NonNullable<UsageSummary['latency_by_model']> = {}
      for (const [model, arr] of Object.entries(msByModel)) {
        const q = latencyQuantiles(arr)
        latencyByModel[model] = { count: arr.length, avg_ms: arr.reduce((a, b) => a + b, 0) / arr.length, p50_ms: q.p50, p95_ms: q.p95 }
      }
      return {
        requests: count,
        ok,
        failed: count - ok,
        by_status: byStatus,
        by_provider: byProvider,
        by_model: byModel,
        latency: latencyQuantiles(ms),
        latency_by_model: latencyByModel,
        tokens,
        tokens_by_model: tokensByModel,
        billable_tokens: billableTokens,
        billable_partial: billablePartial,
        cost,
        unpriced_models: unpriced ? [...unpriced].sort() : null,
        window: { first, last },
      }
    },
  }
}

/** 请求日志聚合（纯函数，单测共用）。成功 = status < 400；时延与用量只计成功请求。 */
export function summarizeUsage(entries: LogEntry[], priceOf?: PriceResolver): UsageSummary {
  const acc = createUsageAccumulator(priceOf)
  for (const e of entries) acc.add(e)
  return acc.summary()
}

// ===== 按小时分桶（/usage bucket=hour，编排侧长跑分时段观测）=====

/** 小时桶精简版（/usage bucket=hour 的 hours[] 条目）：UsageSummary 的子集——分时段观测只要
 *  量与时点，分位/成本明细/provider 维度留在总账（usage 字段），桶内不重复出。 */
export interface UsageHourBucket {
  /** 本地小时键（YYYY-MM-DDTHH:00，localIsoTs 截断补 :00）：字符串排序即时序 */
  hour: string
  requests: number
  /** 桶内成本合计（USD）；未注入查价器为 null（与 summary.cost 的 null 语义一致） */
  cost: number | null
  tokens: { input: number; output: number; cache_read: number; cache_creation: number }
  by_model: Record<string, number>
  by_status: Record<string, number>
}

/** 按小时分桶累加器：桶内复用 createUsageAccumulator（口径与总账逐字段同源），只投影精简版。
 *  桶键取条目本地小时——Map 收集后按键排序输出，不依赖条目落盘时序（乱序条目也归对桶）；
 *  稀疏输出：窗口内无流量的小时不出桶（744 桶零填充是浪费，消费方按 hour 键对齐即可）。 */
export function createUsageHourAccumulator(priceOf?: PriceResolver) {
  const buckets = new Map<string, ReturnType<typeof createUsageAccumulator>>()
  return {
    add(e: LogEntry): void {
      const hour = `${localIsoTs(new Date(String(e.ts))).slice(0, 13)}:00`
      let acc = buckets.get(hour)
      if (!acc) {
        acc = createUsageAccumulator(priceOf)
        buckets.set(hour, acc)
      }
      acc.add(e)
    },
    hours(): UsageHourBucket[] {
      return [...buckets.keys()].sort().map((hour) => {
        const s = buckets.get(hour)!.summary()
        return {
          hour,
          requests: s.requests,
          cost: s.cost ? s.cost.total : null,
          tokens: s.tokens,
          by_model: s.by_model,
          by_status: s.by_status,
        }
      })
    },
  }
}

/** 流式聚合：逐行读各日期文件、边过滤边累加，不落全量条目数组——/usage 查 31 天曾用
 *  readFileSync×31 + concat O(n²) 拷贝 + 全量驻留把事件循环卡数秒、在途 SSE 全冻结
 *  （2026-11-02 复查 P2-1；该端点是 Dockmaster 编排侧的轮询数据源）。聚合口径与
 *  「readRequestLogDay + filterLogEntries + summarizeUsage」逐字段一致（共享累加器）。 */
/** 流式逐条产出各日期日文件里命中过滤的请求日志（/usage 聚合与 /logs/query 明细共用同一
 *  解析管道，勿另写第二套解析）。逐行读、边过滤边产出，不落全量数组——31 天查询曾用
 *  readFileSync×31 + concat O(n²) 拷贝 + 全量驻留把事件循环卡数秒、在途 SSE 全冻结
 *  （2026-11-02 复查 P2-1；/usage 是编排侧轮询数据源）。消费方可提前终止（如 /logs/query
 *  的 limit 到手即停）：生成器 return 路径经 finally 确定性关闭 readline 与底层文件流。 */
export async function* streamRequestLogDays(days: string[], f: UsageFilter): AsyncGenerator<LogEntry> {
  for (const d of days) {
    if (!USAGE_DAY_RE.test(d)) continue
    const file = path.join(logsDir(), `gateway-${d}.jsonl`)
    if (!fs.existsSync(file)) continue
    const input = fs.createReadStream(file, 'utf8')
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (!line.trim()) continue
        let e: LogEntry
        try {
          e = JSON.parse(line) as LogEntry
        } catch {
          continue /* 崩溃半行 */
        }
        if (logEntryMatches(e, f)) yield e
      }
    } finally {
      lines.close()
      input.destroy() // 提前终止（limit 凑满）时立即释放 fd，不悬挂到 GC
    }
  }
}

export async function summarizeUsageDays(days: string[], f: UsageFilter, priceOf?: PriceResolver): Promise<UsageSummary> {
  const acc = createUsageAccumulator(priceOf)
  for await (const e of streamRequestLogDays(days, f)) acc.add(e)
  return acc.summary()
}

/** 流式聚合 + 小时桶：与 summarizeUsageDays 同一条解析管道单趟双账（总账 + hours），bucket=hour
 *  查询不付两次全量文件扫描的代价（31 天扫描是本管道存在的理由，见 streamRequestLogDays 注）。 */
export async function summarizeUsageDaysWithHours(
  days: string[],
  f: UsageFilter,
  priceOf?: PriceResolver
): Promise<{ usage: UsageSummary; hours: UsageHourBucket[] }> {
  const acc = createUsageAccumulator(priceOf)
  const hrs = createUsageHourAccumulator(priceOf)
  for await (const e of streamRequestLogDays(days, f)) {
    acc.add(e)
    hrs.add(e)
  }
  return { usage: acc.summary(), hours: hrs.hours() }
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

/** JSONL 日志保留期清理（PERF-16）：gateway-/audit-/debug-（.jsonl）与 daemon-（.log）按天日文件
 *  无界累积，超保留天数的在网关启动与每日定时删除。文件名严格锚定、日期非法的一律不碰；被常驻
 *  流池持有句柄的日文件先关流再删（Windows 文件有本进程 fd 时 unlink 报 EPERM/EBUSY），
 *  删除失败跳过、次日定时重试。返回删除数；retentionDays 非正数视为禁用。
 *  （events.jsonl 单文件与 crash-*.log 不匹配本正则、不参与清理——前者量小、后者事故痕迹保贵。） */
const LOG_DAY_FILE_RE = /^(gateway|audit|debug|daemon)-(\d{4})-(\d{2})-(\d{2})\.(jsonl|log)$/

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

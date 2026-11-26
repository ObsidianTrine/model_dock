import { localIsoTs } from '../../util/time.js'
import { t } from '../../util/i18n.js'
import { AdminCtx, jsonRequestBody, sendError } from '../admin-shared.js'
import { gatewayPriceResolver, loadPricingOverrides, lookupPrice } from '../pricing.js'
import { streamRequestLogDays, summarizeUsageDays, summarizeUsageDaysWithHours, type LogEntry, type RingEntry, type UsageHourBucket } from '../state.js'

export async function hLogs(c: AdminCtx): Promise<void> {
  const { rt, req, res } = c
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const n = Math.min(500, Math.max(1, Number(q.get('n') ?? 50) || 50))
  // 筛选视图：默认=环形缓冲原样（错误请求+控制台操作+后台事件，写入侧已分流）；
  // src=ok 取成功请求小缓冲；kind=err/audit 在 ring 上做服务端过滤——分页计数按过滤后口径，
  // 避免前端拿到稀页（客户端过滤会让「每页 N 条」名不副实）
  const src = q.get('src')
  const kind = q.get('kind')
  const base: RingEntry[] = src === 'ok' ? (rt.okRing ?? []) : rt.ring
  const filtered =
    !src && kind === 'audit'
      ? base.filter((l) => l.kind === 'audit')
      : !src && kind === 'err'
        ? base.filter((l) => l.kind !== 'audit')
        : base
  const total = filtered.length
  // page 从 1 数起，第 1 页是最新 n 条（ring 按 时间正序 追加）；越界页返回空数组
  const page = Math.max(1, Number(q.get('page') ?? 1) || 1)
  const pages = Math.max(1, Math.ceil(total / n))
  const end = Math.max(0, total - (page - 1) * n)
  const start = Math.max(0, end - n)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ logs: filtered.slice(start, end), total, page, pages }))
  return
}

/** /_modeldock/usage 查询参数 → 本地日期列表 + 毫秒窗口。date=单日（缺省今天）；from/to
 *  各自接受 YYYY-MM-DD 或 ISO 时间戳（日期形态按本地日界取起止）；跨天封顶 31 个日文件。
 *  非法返回 err 文案（双语）。 */
const USAGE_MAX_DAYS = 31
function usageQuery(q: URLSearchParams): { days: string[]; fromMs?: number; toMs?: number; err?: string } {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/
  const from = q.get('from')
  const to = q.get('to')
  if (!from && !to) {
    const date = q.get('date') ?? localIsoTs().slice(0, 10)
    if (!dateRe.test(date)) return { days: [], err: t('usage 参数 date 非法：需为 YYYY-MM-DD（本地日期）', 'Invalid usage date parameter: must be YYYY-MM-DD (local date)') }
    return { days: [date] }
  }
  const parseBound = (v: string, endOfDay: boolean): number | undefined => {
    if (dateRe.test(v)) {
      const [y, m, d] = v.split('-').map(Number)
      return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime()
    }
    const ts = new Date(v).getTime()
    return Number.isFinite(ts) ? ts : undefined
  }
  const fromMs = from ? parseBound(from, false) : undefined
  const toMs = to ? parseBound(to, true) : undefined
  if ((from && fromMs == null) || (to && toMs == null)) {
    return { days: [], err: t('usage 参数 from/to 非法：需为 YYYY-MM-DD 或 ISO 时间戳', 'Invalid usage from/to parameters: must be YYYY-MM-DD or an ISO timestamp') }
  }
  if (fromMs != null && toMs != null && toMs < fromMs) {
    return { days: [], err: t('usage 参数非法：to 早于 from', 'Invalid usage parameters: to is earlier than from') }
  }
  const lo = fromMs ?? toMs!
  const hi = toMs ?? fromMs!
  const dayStart = (ts: number) => new Date(new Date(ts).getFullYear(), new Date(ts).getMonth(), new Date(ts).getDate()).getTime()
  const startDay = dayStart(lo)
  const endDay = dayStart(hi)
  if ((endDay - startDay) / 86_400_000 + 1 > USAGE_MAX_DAYS) {
    return { days: [], err: t('usage 窗口过大：最多查询 {n} 天', 'Usage window too large: query at most {n} days', { n: USAGE_MAX_DAYS }) }
  }
  const days: string[] = []
  const cur = new Date(startDay)
  while (cur.getTime() <= endDay) {
    days.push(localIsoTs(cur).slice(0, 10))
    cur.setDate(cur.getDate() + 1)
  }
  return { days, fromMs, toMs }
}

/** /_modeldock/usage：请求日志聚合（admin 只读）。编排侧（Dockmaster 燃油实测/风暴闸）与
 *  排查的数据面：date/from/to 选日（见 usageQuery），harness/profile/provider 精确过滤；
 *  聚合口径见 summarizeUsage。bucket=hour 附加 hours[] 小时桶（精简版形状见 UsageHourBucket，
 *  稀疏输出：无流量的小时不出桶）——编排侧长跑分时段观测（油量曲线/高峰定位），总账照常返回。
 *  可计费口径字段（2026-11 billable 聚合）：usage.billable_tokens = 窗口内成功且有 usage
 *  条目的可计费 token 求和（与 tokens 同口径；公式分协议形态、条目落盘前已算好，聚合只
 *  求和不重算）；usage.billable_partial = 窗口内存在「有 usage 但缺 billable_tokens 数字」
 *  的条目（旧版网关日志混入）时为 true，此时求和只是可得部分——消费方（编排侧 reconcile）
 *  据此整体回落文件直读。窗口内无任何 usage 条目：billable_tokens=0、partial=false。 */
/** 小时桶窗口封顶：与 USAGE_MAX_DAYS 联动（31 天 × 24 = 744）。usageQuery 已按日把窗口封到
 *  31 天、今日桶数恒不超限，此检查守的是未来日上限调大后 hours[] 无感膨胀——桶数超限直接
 *  400，不做静默截断（编排侧对账宁可显式失败不可缺桶）。 */
const USAGE_MAX_HOURS = 744
export async function hUsage(c: AdminCtx): Promise<void> {
  const { req, res } = c
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const parsed = usageQuery(q)
  if (parsed.err) {
    sendError(res, 400, parsed.err, t('示例：/_modeldock/usage?date=2026-11-01&harness=zcode', 'Example: /_modeldock/usage?date=2026-11-01&harness=zcode'))
    return
  }
  const bucket = q.get('bucket')
  if (bucket != null && bucket !== 'hour') {
    return sendError(res, 400, t('usage 参数 bucket 非法：仅支持 hour', 'Invalid usage bucket parameter: only hour is supported'), t('示例：/_modeldock/usage?date=2026-11-01&bucket=hour', 'Example: /_modeldock/usage?date=2026-11-01&bucket=hour'))
  }
  const withHours = bucket === 'hour'
  if (withHours && parsed.days.length * 24 > USAGE_MAX_HOURS) {
    return sendError(res, 400, t('usage 小时桶窗口过大：最多查询 {n} 桶（31 天）', 'Usage hour-bucket window too large: query at most {n} buckets (31 days)', { n: USAGE_MAX_HOURS }), t('收窄 from/to 窗口后重试', 'Narrow the from/to window and retry'))
  }
  // 流式聚合：逐行读、边过滤边累加，不落全量数组——31 天查询曾把事件循环卡数秒、
  // 在途 SSE 全冻结（本端点是编排侧的轮询数据源，见 summarizeUsageDays 注释）
  const harness = q.get('harness') ?? undefined
  const profile = q.get('profile') ?? undefined
  const provider = q.get('provider') ?? undefined
  const withCost = q.get('cost') !== '0' // 缺省带成本；cost=0 只算 token（编排侧风暴闸等免查价路径）
  const filterOpt = { harness, profile, provider, fromMs: parsed.fromMs, toMs: parsed.toMs }
  const priceOf = withCost ? gatewayPriceResolver : undefined
  // 单趟双账：bucket=hour 经 summarizeUsageDaysWithHours 同管道同时出总账与小时桶，不二次扫文件
  const { usage, hours } = withHours
    ? await summarizeUsageDaysWithHours(parsed.days, filterOpt, priceOf)
    : { usage: await summarizeUsageDays(parsed.days, filterOpt, priceOf), hours: null as UsageHourBucket[] | null }
  const filter: Record<string, string> = {}
  if (harness) filter.harness = harness
  if (profile) filter.profile = profile
  if (provider) filter.provider = provider
  res.writeHead(200, { 'content-type': 'application/json' })
  const pricingError = withCost ? loadPricingOverrides().error ?? null : null
  res.end(JSON.stringify({ ok: true, days: parsed.days, filter: Object.keys(filter).length ? filter : null, pricing_error: pricingError, usage, ...(hours ? { hours } : {}) }))
  return
}

/** GET /_modeldock/logs/query：请求日志明细查询（admin 门内只读，编排器/Dockmaster 排障用）。
 *  /usage 只有聚合、/logs 只有内存环形缓冲（200 条），排障要窗口内明细条目（含 cause/attempts/
 *  hint/tokenHint，定义见 state/types.ts LogEntry）。from/to/date 口径与 /usage 完全一致
 *  （usageQuery，31 天封顶）；harness/provider/cause/status_class 精确过滤（status_class 取
 *  2xx…5xx）；limit 缺省 100、上限 500（非法值按 hLogs 先例夹紧不报错）；按时间倒序（最新在前）。
 *  条目原样返回落盘的 LogEntry——脱敏在落盘侧已完成（tokenHint 仅前 8 字符、无任何 key 材料），
 *  本端点绝不新增明文密钥字段。取数复用 /usage 的流式读（streamRequestLogDays），凑满 limit
 *  即停不再读更旧的日子。只读端点无状态变更，不记审计（跟随 /usage 先例）。 */
export async function hLogsQuery(c: AdminCtx): Promise<void> {
  const { req, res } = c
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const parsed = usageQuery(q)
  if (parsed.err) {
    sendError(res, 400, parsed.err, t('示例：/_modeldock/logs/query?from=2026-11-01&harness=zcode&cause=upstream_4xx', 'Example: /_modeldock/logs/query?from=2026-11-01&harness=zcode&cause=upstream_4xx'))
    return
  }
  const statusClass = q.get('status_class') ?? undefined
  if (statusClass && !/^[1-5]xx$/.test(statusClass)) {
    return sendError(res, 400, t('logs/query 参数 status_class 非法：需为 2xx/3xx/4xx/5xx', 'Invalid logs/query status_class parameter: must be 2xx/3xx/4xx/5xx'))
  }
  const filter = {
    harness: q.get('harness') ?? undefined,
    provider: q.get('provider') ?? undefined,
    cause: q.get('cause') ?? undefined,
    statusClass,
    fromMs: parsed.fromMs,
    toMs: parsed.toMs,
  }
  const limit = Math.min(500, Math.max(1, Number(q.get('limit') ?? 100) || 100))
  // 倒序取数：日文件按时间正序追加，从最新日往回读；单日把命中条目滚动截到最新 limit 条
  // （内存有界），凑满 limit 即停、不再读更旧的日子。条目无跨日乱序可能（日文件按天归属）。
  const out: LogEntry[] = []
  for (let i = parsed.days.length - 1; i >= 0 && out.length < limit; i--) {
    const dayBuf: LogEntry[] = []
    for await (const e of streamRequestLogDays([parsed.days[i]], filter)) {
      dayBuf.push(e)
      if (dayBuf.length >= limit * 2) dayBuf.splice(0, dayBuf.length - limit) // 滚动裁头：只保最新的 limit 条
    }
    if (dayBuf.length > limit) dayBuf.splice(0, dayBuf.length - limit)
    dayBuf.reverse()
    out.push(...dayBuf)
    if (out.length > limit) out.splice(limit, out.length - limit)
  }
  const filterEcho: Record<string, string> = {}
  if (filter.harness) filterEcho.harness = filter.harness
  if (filter.provider) filterEcho.provider = filter.provider
  if (filter.cause) filterEcho.cause = filter.cause
  if (filter.statusClass) filterEcho.status_class = filter.statusClass
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, days: parsed.days, filter: Object.keys(filterEcho).length ? filterEcho : null, limit, entries: out }))
  return
}

/** POST /_modeldock/pricing-lookup：批量查价（编排侧燃油账用，admin 门内）。
 *  请求体 { models: Array<string | { provider?: string; model: string }> }（≤500 条）；
 *  响应 { ok, currency:'usd', unit:'per_million_tokens', prices, missing, overrides_error }——
 *  prices 键与请求条目一一对应（带 provider 的键为 "provider/model"），查不到的进 missing（不猜价）。 */
export async function hPricingLookup(c: AdminCtx): Promise<void> {
  const { req, res } = c
  const b = await jsonRequestBody(req)
  const raw = Array.isArray(b.models) ? b.models : []
  const entries = raw
    .map((m: unknown) => {
      if (typeof m === 'string') return { provider: undefined, model: m.trim(), key: m.trim() }
      if (typeof m === 'object' && m !== null) {
        const o = m as Record<string, unknown>
        const model = typeof o.model === 'string' ? o.model.trim() : ''
        const provider = typeof o.provider === 'string' && o.provider.trim() ? o.provider.trim() : undefined
        if (model) return { provider, model, key: provider ? `${provider}/${model}` : model }
      }
      return null
    })
    .filter((x: unknown): x is { provider: string | undefined; model: string; key: string } => x !== null)
    .slice(0, 500)
  if (!entries.length) {
    return sendError(res, 400, t('缺少 models（模型名字符串或 {provider, model} 对象数组）', 'Missing models (array of model name strings or {provider, model} objects)'))
  }
  const { error } = loadPricingOverrides()
  const prices: Record<string, unknown> = {}
  const missing: string[] = []
  for (const e of entries) {
    const price = lookupPrice(e.provider, e.model)
    if (price) prices[e.key] = { ...price, source: 'priced' }
    else missing.push(e.key)
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, currency: 'usd', unit: 'per_million_tokens', prices, missing, overrides_error: error ?? null }))
  return
}

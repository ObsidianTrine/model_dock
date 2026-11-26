import http from 'node:http'
import { localIsoTs } from '../util/time.js'
import { DEFAULT_LOG_RETENTION_DAYS } from '../config/types.js'
import { syncBakedClientsForDisplayRoute } from '../ops.js'
import { refreshCatalog } from '../providers/catalog.js'
import { logAudit, logEvent, pruneExpiredLogs, sweepEphemeralHarnesses, EPHEMERAL_SWEEP_INTERVAL_MS, type GatewayRuntime } from './state.js'
import { startModelProbeLoop } from './modelprobe.js'
import { refreshCalendar } from './holidays.js'
import type { ProbeTransport } from './probe/engine.js'
import { startProbeSchedule } from './probe/schedule.js'
import { t, bi, runWithLang, normalizeLang, getLang, type Bilingual } from '../util/i18n.js'
import { errorReply, sendError } from './admin-shared.js'
import { handleRequest } from './dataplane.js'
import { pickerSyncStates } from './picker-state.js'
import { probePing } from './probe/direct.js'
import { sweepRemoteRequests, sweepSyncTickets } from './remote-device.js'

// T05 拆分后保持原导入面：测试与潜在外部引用仍按 server.js 路径取这些符号
export { OVERVIEW_TTL_MS, overviewCacheHit, overviewServeDecision, warmupOverview } from './overview-view.js'
export { runClientInstall, runClientUninstall } from './install.js'
export { errorReply, maxBodyBytes } from './admin-shared.js'
export { probe, probePing }
export type { PingResult, ProbeResult } from './probe/direct.js'
import { probe } from './probe/direct.js'

export interface GatewayStartOptions {
  port: number
  idleTimeoutMs?: number
  retries?: number
  /** 法定节假日每年自动获取（holiday-cn 数据）；默认开启，测试传 false 避免 90s 首查触发出站请求 */
  autoHolidayRefresh?: boolean
  /** 模型元数据目录（models.dev）自动刷新；默认开启，测试传 false 避免出站请求 */
  autoCatalogRefresh?: boolean
  /** 上游模型可用性周期探测（modelprobe.ts，v1 纯观测）；默认开启，测试传 false 避免出站请求
   *  （或用 modelProbeIntervals 注入短首查 + mock 上游） */
  autoModelProbe?: boolean
  /** 注入探测调度节奏（测试用）：不传用 modelprobe.ts 的 MODEL_PROBE_* 默认（启动 90s / 每 24h） */
  modelProbeIntervals?: { initialDelayMs?: number; intervalMs?: number }
  /** 探针周期调度（probe/schedule.ts：P15 被动聚合恒跑 + cost_ack 授权的周期主动面）；默认开启，
   *  测试传 false 避免 tick 触发探针（或用 probeScheduleIntervals 注入短间隔 + mock 上游） */
  autoProbeSchedule?: boolean
  /** 注入探针调度节奏（测试用）：不传用 schedule.ts 的 PROBE_SCHEDULE_* 默认（启动 90s / 每 1h） */
  probeScheduleIntervals?: { initialDelayMs?: number; intervalMs?: number; transport?: ProbeTransport }
  /** 临时 harness TTL 清扫间隔（C14，测试注入用）：不传用 EPHEMERAL_SWEEP_INTERVAL_MS（60s） */
  ephemeralSweepIntervalMs?: number
}

// UI 渲染缓存与模型目录视图缓存见 ui-cache.ts（S-01 拆分，纯搬移）







/** Claude Code gateway discovery 的硬过滤：模型 ID 不含 claude/anthropic 字样的条目全部丢弃
 *  （2.1.296 二进制实测：filter(te=>/(claude|anthropic)/i.test(te.id))，全滤光时
 *  「0 usable models after filter」，/model 选择器只剩内置档位）。 */

export function createGatewayServer(rt: GatewayRuntime, opts: GatewayStartOptions): http.Server {
  const idle = opts.idleTimeoutMs ?? 10 * 60_000
  const retries = opts.retries ?? 1
  const server = http.createServer((req, res) => {
    // 请求级语言：浏览器会话经 x-modeldock-lang 头声明（控制台 fetch 统一携带），
    // 本请求生成的全部服务端文案（错误提示/客户端卡片描述/审计条目）随之；无头回落网关默认语言。
    // AsyncLocalStorage 随异步链传播，并发请求互不串扰。
    const reqLang = normalizeLang(req.headers['x-modeldock-lang'] as string | undefined) ?? getLang()
    void runWithLang(reqLang, async () => {
      try {
        await handleRequest(rt, req, res, { idle, retries })
      } catch (e) {
        // 顶层兜底：漏出的已知错误（UpstreamError / ConfigError / 带 hint 的业务错误）映射为
        // 正确状态码并保留 message + hint——控制台的失败提示依赖它们，不再一律 500「网关内部错误」
        if (res.headersSent) {
          res.destroy()
          return
        }
        const r = errorReply(e)
        if (r.status >= 500) console.error("[gateway] %s %s %s", req.method, req.url ?? "", t('网关内部错误:', 'Gateway internal error:'), e)
        sendError(res, r.status, r.message, r.hint)
      }
    })
  })
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 75_000
  server.timeout = idle
  server.on('connection', (s) => s.setNoDelay(true))
  // 实际端口自动回写 rt.port：登录 cookie 名内嵌端口号做同机双实例隔离（cookies.ts），
  // 端口必须以真实监听地址为准（EADDRINUSE 顺延、listen(0) 随机端口都覆盖），不能靠调用方手动赋值
  server.on('listening', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') rt.port = addr.port
  })

  // 健康清扫：周期性探活处于熔断冷却期的服务，连通即恢复（故障切换常开后熔断态任何模式下都可能命中，清扫不再看开关）
  const sweeper = setInterval(() => {
    // 顺带清扫直拉票据：孤儿条目（preview 后无人确认 / 附近直拉无人跟进）此前只在同类入口懒清扫，
    // 无人认领就常驻到进程结束（含解密 Syncdoc 与 report）
    sweepSyncTickets()
    sweepRemoteRequests()
    const now = Date.now()
    for (const [id, h] of rt.health) {
      if (h.meltdown_until == null || h.meltdown_until > now) continue
      const p = rt.config.providers[id]
      if (!p || p.enabled === false) continue
      void probePing(rt, p)
        .then((r) => {
          if (r.ok) {
            const hh = rt.health.get(id)
            if (hh) {
              hh.meltdown_until = undefined
              hh.meltdown_cls = undefined
              hh.errWindow = { t0: Date.now(), count: 0 }
              hh.lastMs = r.ms
            }
          }
        })
        .catch(() => {})
    }
  }, 60_000)
  sweeper.unref?.()
  server.on('close', () => clearInterval(sweeper))

  // 临时 harness TTL 清扫（C14，「用完即焚」语义见 state/types.ts EphemeralHarnessState 注）；
  // 测试经 opts.ephemeralSweepIntervalMs 注入短间隔
  const ephSweeper = setInterval(() => {
    sweepEphemeralHarnesses(rt)
  }, opts.ephemeralSweepIntervalMs ?? EPHEMERAL_SWEEP_INTERVAL_MS)
  ephSweeper.unref?.()
  server.on('close', () => clearInterval(ephSweeper))

  // 定时 prefer 窗口接管主候选的展示路由跟随：窗口边界没有事件（请求级时间函数），周期对比
  // 「展示路由」（人工当前 > prefer 窗口 > active_profile，不含熔断等瞬态），变化才把烤模型
  // 客户端（/model 策划表、模型列表）按窗口目标重写一次——手动切换 / 钉定仍走各自的即时同步。
  // 基线初始为 undefined：首检按变化处理一次（refresh 有内容一致守卫，已同步则零写盘），
  // 自愈「网关停摆期间窗口已变」「接入发生在窗口接管期间」两类陈旧；模型生效本身不受此影响
  // （转发按请求即时翻译）。接入/断开后由 handler 将基线置失效，下一检强制校准。
  const pickerSync = pickerSyncStates.get(rt) ?? pickerSyncStates.set(rt, { route: undefined }).get(rt)!
  const pickerSyncTick = () => {
    void syncBakedClientsForDisplayRoute(rt, pickerSync, { port: rt.port })
      .then((r) => {
        if (r.changed) {
          // detail 双语经 bi() 成对构造（两个语言参数同写，未来改文案不漏语言），按审计条目的 zh/en 字段落
          const detail: Bilingual | undefined = r.refreshed.length
            ? bi(`已同步重写 ${r.refreshed.join('、')} 的客户端配置（重开会话生效）`, `rewrote client configs for ${r.refreshed.join(', ')} (restart sessions to apply)`)
            : undefined
          const takeoverOp = bi('定时窗口接管路由', 'Schedule window takeover')
          logAudit(rt, {
            ts: localIsoTs(),
            kind: 'audit',
            op: takeoverOp.zh,
            op_en: takeoverOp.en,
            target: r.route ?? '-',
            detail: detail?.zh,
            detail_en: detail?.en,
            ok: true,
            source: 'token',
          })
        }
      })
      .catch((e: unknown) => {
        // 定时窗口接管重写客户端失败不再无声吞掉：事件落 ring/当日事件日文件（eventsLogName）可排查
        logEvent(rt, { level: 'warn', op: 'display_route_sync', err: e instanceof Error ? e.message : String(e) })
      })
  }
  // 周期 15s：定时窗口的判定粒度是分钟（HH:mm），更密的 tick 只产生注定 changed:false 的空转
  // （路由未变时是纯内存短路）。首检延后 30s 错峰：基线初始 undefined，首检必做一次全量烤模型
  // 客户端校准（读客户端文件 + 解析 + 比对，有内容一致守卫不写盘），不必叠在启动窗口——
  // 同期还有 sync 引擎首 tick 与 90s 后的节假日/模型目录拉取
  const pickerSyncFirst = setTimeout(pickerSyncTick, 30_000)
  const pickerSyncTimer = setInterval(pickerSyncTick, 15_000)
  pickerSyncFirst.unref?.()
  pickerSyncTimer.unref?.()
  server.on('close', () => {
    clearTimeout(pickerSyncFirst)
    clearInterval(pickerSyncTimer)
  })

  // 节假日日历每年自动获取（数据源 holiday-cn，国务院公告人工校对）：启动 90s 后首查、之后每 24h；
  // POST /schedule/holidays-cn 可即时触发（CLI/运维用）。失败静默，不影响网关服务
  const holidayTimers: NodeJS.Timeout[] = []
  if (opts.autoHolidayRefresh !== false) {
    const auto = () => void refreshCalendar(rt, { manual: false }).catch((e: unknown) => {
      logEvent(rt, { level: 'warn', op: 'calendar_refresh', err: e instanceof Error ? e.message : String(e) })
    })
    const first = setTimeout(auto, 90_000)
    const loop = setInterval(auto, 24 * 3600_000)
    first.unref?.()
    loop.unref?.()
    holidayTimers.push(first, loop)
  }
  server.on('close', () => holidayTimers.forEach((t) => { clearTimeout(t); clearInterval(t) }))

  // 模型元数据目录（models.dev）自动刷新：启动 90s 后首查、之后每 24h 检查（缓存 7 天内新鲜则跳过）。
  // 失败静默保留旧缓存，不影响网关服务；MODELRDOCK_DISABLE_CATALOG_FETCH=1 停用
  const catalogTimers: NodeJS.Timeout[] = []
  if (opts.autoCatalogRefresh !== false) {
    const autoCatalog = () => void refreshCatalog({ manual: false }).catch(() => {})
    const catFirst = setTimeout(autoCatalog, 90_000)
    const catLoop = setInterval(autoCatalog, 24 * 3600_000)
    catFirst.unref?.()
    catLoop.unref?.()
    catalogTimers.push(catFirst, catLoop)
  }
  server.on('close', () => catalogTimers.forEach((t2) => { clearTimeout(t2); clearInterval(t2) }))

  // 上游模型可用性周期探测（v1 纯观测，modelprobe.ts）：启动 90s 错峰首查、之后每 24h 一轮；
  // 结果（含失败负缓存）只存内存，GET /_modeldock/model-availability 消费。不影响转发路由；
  // 测试传 autoModelProbe:false 停用，或 modelProbeIntervals 注入短首查（配 mock 上游）
  if (opts.autoModelProbe !== false) {
    startModelProbeLoop(rt, server, opts.modelProbeIntervals)
  }

  // 探针周期调度（provider-probe-suite 任务 13，probe/schedule.ts）：每小时 tick——P15 被动聚合
  // 恒跑（零 token）；含 token 主动面（P1）仅在当前本地小时命中 [probe] schedule_hours 且
  // cost_ack=true 时执行，同受 budget_tokens 月度硬闸（闸在引擎内）。不影响转发路由；测试传
  // autoProbeSchedule:false 停用，或 probeScheduleIntervals 注入短间隔（配 mock 上游）
  if (opts.autoProbeSchedule !== false) {
    startProbeSchedule(rt, server, opts.probeScheduleIntervals)
  }

  // JSONL 日志保留期清理：启动即清一次、之后每 24h；保留天数读 rt.config（随 reloadRuntime
  // 跟随配置变化），log_retention_days=0 禁用。删除为尽力而为，失败静默不影响网关服务
  const pruneLogs = async () => {
    try {
      const days = rt.config.gateway?.log_retention_days ?? DEFAULT_LOG_RETENTION_DAYS
      const pruned = await pruneExpiredLogs(days)
      if (pruned > 0) {
        console.log(
          t('✓ 已清理 {count} 个过期日志文件（保留 {days} 天）', '✓ Pruned {count} expired log files (kept {days} days)', { count: pruned, days })
        )
      }
    } catch {
      /* 清理失败不影响网关服务 */
    }
  }
  const pruneLoop = setInterval(() => void pruneLogs(), 24 * 3600_000)
  pruneLoop.unref?.()
  server.on('close', () => clearInterval(pruneLoop))
  void pruneLogs()

  return server
}

import type { Dispatcher } from 'undici'
import type { Config, ProfileConfig, ProviderConfig } from '../../config/types.js'
import type { HolidayCalendar, HolidayDayNamed } from '../daytype.js'

export interface LogEntry {
  ts: string
  /** 默认 'request'（转发请求）；管理面连接测试也记为 request，便于排查 */
  kind?: 'request'
  harness: string
  profile: string
  provider: string
  model?: string
  path: string
  status?: number
  ms?: number
  err?: string
  /** 路由事件标记：仅在偏离主选直连成功时设置（failover_to:<id>、replayed_from:<id>、down_all）；缺席=普通成功，日志过滤依赖「非空即事件」 */
  reason?: string
  /** 请求关联 ID（8 字节 hex）：handleRequest 入口生成，与响应头 x-modeldock-request-id、错误响应体
   *  modeldock.requestId 三处一致，供用户拿 id 在日志里检索一次失败请求的全链路。 */
  requestId?: string
  /** 401 归因线索：无效 token 的前 8 字符（绝不写完整 token）；err 文案按此前缀反查已知 harness 点名归属 */
  tokenHint?: string
  /** 上游响应观测到的 token 用量（狗粮对账口径：缓存读计入输入成本）。
   *  从响应流旁路解析（SSE 逐行 / 小体积 JSON），尽力而为——旧日志与解析失败时缺省。 */
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
  }
}

/** 操作审计：Web 控制台修改类配置操作（添加/编辑/删除服务、切换、接入等） */
export interface AuditEntry {
  ts: string
  kind: 'audit'
  /** 操作名（中文渲染，如「添加服务」）；双语条目另有 op_en */
  op: string
  /** 操作名英文渲染；缺省 = 旧条目只有主字段语言，展示端按需回退 */
  op_en?: string
  /** 操作目标，如服务 id、客户端 id、路由名（原文照存，枚举型值另有 target_en） */
  target: string
  /** 操作目标英文渲染（仅 target 为枚举型文案时存在，如 开启/关闭） */
  target_en?: string
  /** 变更摘要（不含任何密钥明文；中文渲染） */
  detail?: string
  /** 变更摘要英文渲染；缺省 = 旧条目 */
  detail_en?: string
  ok: boolean
  err?: string
  /** err 的英文渲染（err 为动态文本时无对译则缺省） */
  err_en?: string
  /** 来源：web（本机控制台同源）、token（携带 admin token，CLI 兼容调用）、lan（手机简版控制台）、tray（系统托盘，x-modeldock-source 头标记） */
  source: 'web' | 'token' | 'lan' | 'tray'
}

/** 后台链路事件（无请求上下文的吞错上报）：定时任务、后台挂载、密钥迁移等失败，经
 *  logEvent（有 rt）/ reportEvent（ops 层无 rt）记录。op 是程序字段用英文短词；err 是错误
 *  原文（动态文本，可能是任一语言）。harness/profile/provider/path 为占位：页面日志表把非
 *  audit 条目按请求行渲染，占位保证各列不显示 undefined（UI 不必改）。 */
export interface EventEntry {
  ts: string
  kind: 'event'
  level: 'warn' | 'error'
  op: string
  err: string
  harness: '-'
  profile: '-'
  provider: '-'
  path: string
}

export type RingEntry = LogEntry | AuditEntry | EventEntry

export interface ResolvedTarget {
  harness: string
  profileName: string
  profile: ProfileConfig
  provider: ProviderConfig
  /** 故障切换候选的模型映射（"<providerId>:<modelId>" 条目）；设置时请求体模型强制改写为该值 */
  modelOverride?: string
  /** 该 target 由客户端钉住路由（harness.route）解析而来：pickTarget 以钉住服务为最高优先主候选，
   *  不随全局「正在使用」（当前槽/定时窗口）走——与展示层口径一致（overview 客户端卡、烤模型重写均豁免钉住） */
  viaHarnessPin?: boolean
}

export type ResolveResult =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; status: number; message: string; hint?: string }

export interface GatewayRuntime {
  config: Config
  /** token → harness id */
  tokens: Map<string, string>
  ring: RingEntry[]
  startedAt: number
  adminToken: string
  reloads: number
  /** proxy 配置值 → dispatcher（undefined = 直连） */
  dispatchers: Map<string, Dispatcher | undefined>
  /** providerId → 自动路由健康/熔断状态（仅 auto_failover 开启时使用） */
  health: Map<string, HealthState>
  /** 实际监听端口（可能因占用与配置不同） */
  port?: number
  /** 手机简版控制台（LAN）第二监听器运行态；随网关生命周期启停。host=实际绑定地址（对外 URL 只列真正可达的地址） */
  lan?: { server: import('node:http').Server; port: number; token: string; host: string }
  /** 节假日日历的 rt 级缓存（30s TTL 懒加载，见 calendarCache；日历缓存文件更新最迟 30s 生效）：
   *  定时窗口 dayFilter 判定与 overview 日类型/假期展示共用 */
  calendar?: HolidayCalendar
  calendarDays?: HolidayDayNamed[]
  calendarAt?: number
  /** 配置目录 watcher 存活状态（main.ts 接线：watch 建立成功 → true，watcher close → false）。
   *  只读状态位：health 端点消费；未接线（嵌入式/测试直建 rt）为 undefined → health 报 null（未知）。 */
  watcherAlive?: boolean
  /** providerId → 轻量耗时 ring（最近 500 条 ms 采样 + 累计请求数；/_modeldock/metrics 消费）。
   *  logRequest 顺手累计，reload 不清空（跨热加载保留观测连续性）。 */
  metricsLatency: Map<string, ProviderLatencyRing>
}

/** per-provider 耗时采样的有界结构：samples 是环形窗口（超出裁最旧），count 是进程生命周期
 *  内该 provider 的总请求数（单调递增，不受窗口裁剪影响），lastMs 是最近一条耗时。 */
export interface ProviderLatencyRing {
  samples: number[]
  count: number
  lastMs?: number
}

/** 健康状态：滑动窗口错误计数 + 熔断截止时间。窗口内错误数达阈值即熔断，冷却后探活恢复。 */
export interface HealthState {
  /** 60s 滑动错误窗口（t0 起算点，count 错误次数） */
  errWindow: { t0: number; count: number }
  /** 熔断截止时间戳；未熔断则为 undefined */
  meltdown_until?: number
  /** 连续成功次数（≥3 清零熔断） */
  okStreak: number
  /** 最近一次成功请求/探活的耗时 ms（供 overview 展示与备用链同优先级决胜；失败不写，见 recordOutcome） */
  lastMs?: number
}

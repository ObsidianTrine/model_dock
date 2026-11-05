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
  /** 路由事件标记：仅在偏离主选直连成功时设置（failover_to:<id>、replayed_from:<id>、down_all、skip_all）；缺席=普通成功，日志过滤依赖「非空即事件」 */
  reason?: string
  /** 请求关联 ID（8 字节 hex）：handleRequest 入口生成，与响应头 x-modeldock-request-id、错误响应体
   *  modeldock.requestId 三处一致，供用户拿 id 在日志里检索一次失败请求的全链路。 */
  requestId?: string
  /** 401 归因线索：无效 token 的前 8 字符（绝不写完整 token）；err 文案按此前缀反查已知 harness 点名归属 */
  tokenHint?: string
  /** 上游响应观测到的 token 用量（总口径：缓存读计入输入成本）。
   *  从响应流旁路解析（SSE 逐行 / 小体积 JSON），尽力而为——旧日志与解析失败时缺省。
   *  billable_tokens 为可计费口径（剔除缓存读，公式见 src/gateway/usage.ts）：
   *  orchestrator token 熔断与 reconcile 分歧率用；旧日志无此字段。 */
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
    billable_tokens?: number
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
  /** 最近一次 reloadRuntime 加载对应的 config.toml 盘上指纹（store.configStatKey，mtimeMs:size）。
   *  watcher 收到 config.toml 事件后按此去重：persistConfig 自家写盘已随写热加载，防抖到期
   *  指纹未变即跳过第二次整包 reload。undefined = 本进程尚未加载过（首个事件保守重载）。 */
  lastConfigKey?: string
  /** proxy 配置值 → dispatcher（undefined = 直连） */
  dispatchers: Map<string, Dispatcher | undefined>
  /** providerId → 自动路由健康/熔断状态（仅 auto_failover 开启时使用） */
  health: Map<string, HealthState>
  /** harnessId → 数据面限额计数（tokenlimits.ts；内存态重启清零，未配 limits 的 harness 无条目） */
  tokenUsage: Map<string, TokenUsageState>
  /** runtime-only 临时 harness 注册表（id → 状态；provision/revoke/TTL sweeper 维护，
   *  逻辑见 state/runtime.ts）。内存态：进程重启即全部失效（设计如此——用完即焚凭据），
   *  config 热加载经 reapplyEphemeralHarnesses 重登记幸存条目。 */
  ephemeral: Map<string, EphemeralHarnessState>
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
  /** providerId → 海况滑窗错误分桶（/_modeldock/metrics 的 providers[].errors 与 sea_state 数据源）。
   *  recordOutcome 顺手记账（与熔断判定同源不同构，见 state/sea.ts）；reload 随服务删除清理。 */
  seaErrors?: Map<string, SeaProviderErrors>
  /** 上游模型可用性探测运行态（modelprobe.ts 周期探测写入；GET /_modeldock/model-availability 消费） */
  modelProbe?: ModelProbeState
  /** provider 多 key 池运行态（内存态，重启清零；配置热加载全清——key 可能已被替换，
   *  按索引记的失效冷却对换上的新 key 不成立）。逻辑见 state/keypool.ts。 */
  keyPool: KeyPoolState
}

/** 多 key 池运行态：cooldown = providerId → key 池索引（providerKeyRefs 下标）→ 冷却截止 ms 时间戳；
 *  rr = providerId → round-robin 轮转游标（把并发 worker 的请求均摊到池内各 key，避免集中撞 429）。 */
export interface KeyPoolState {
  cooldown: Map<string, Map<number, number>>
  rr: Map<string, number>
}

/** per-provider 耗时采样的有界结构：samples 是环形窗口（超出裁最旧），count 是进程生命周期
 *  内该 provider 的总请求数（单调递增，不受窗口裁剪影响），lastMs 是最近一条耗时。 */
export interface ProviderLatencyRing {
  samples: number[]
  count: number
  lastMs?: number
}

/** 单 harness 的数据面限额计数状态（内存态，rt 级；重启清零）。见 state/tokenlimits.ts。 */
export interface TokenUsageState {
  /** rpm 固定窗口起点（实现为整窗清零：now - rpmStart > 60s 时 rpmCount 归零——窗口边界
   *  附近存在 2× 突发空间，对「熔断丝」定位可接受；如需精确限流改双桶/真滑动窗口） */
  rpmStart: number
  /** 窗口内请求数（含失败/中止——它们同样是上游压力） */
  rpmCount: number
  /** 本地日键（YYYY-MM-DD），跨日自动清零 */
  dayKey: string
  /** 当日累计 token（input 含缓存读/建 + output，与 reconcile 对账口径一致） */
  dayTokens: number
  /** 当日累计可计费 token（usage.billable_tokens：剔除缓存读；旧 usage 无该字段按 0 起步）。
   *  不参与 daily_tokens 限额判定（那是 runaway 熔断丝，总口径正确），仅供
   *  /_modeldock/harness-usage 消费方（编排器预算实测账）读用。 */
  dayBillableTokens: number
}

/** runtime-only 临时 harness（C14）：POST /_modeldock/harness/provision 签发的「用完即焚」
 *  worker 凭据。只活在网关内存（重启清零 = 全部临时凭据即刻失效，设计如此，短命凭据不值得
 *  持久化）；config.toml / secrets.json 永不落盘——mutateConfig 每次从盘上重读（loadConfig
 *  structuredClone），rt.config 里注入的临时条目没有任何写回路径。 */
export interface EphemeralHarnessState {
  id: string
  /** 随机 token（mdk_eph_ 前缀）；明文只在 provision 响应出现一次，任何列示端点与审计日志绝不回显 */
  token: string
  /** 钉定 profile 名；缺省 = 跟随 active_profile（与持久 harness 的 route 字段同语义） */
  route?: string
  /** 签发时刻（epoch ms） */
  createdAt: number
  /** 到期时刻（epoch ms）：TTL sweeper 过点即摘（60s 节奏，分钟级精度足够） */
  expiresAt: number
  /** 配了就挂进 tokenlimits per-harness 日限额（超限 429 与现有 daily_tokens 行为一致） */
  maxDailyTokens?: number
}

/** 健康状态：滑动窗口错误计数 + 熔断截止时间。窗口内错误数达阈值即熔断，冷却后探活恢复。 */
export interface HealthState {  /** 60s 滑动错误窗口（t0 起算点，count 错误次数） */
  errWindow: { t0: number; count: number }
  /** 熔断截止时间戳；未熔断则为 undefined */
  meltdown_until?: number
  /** 触发本次熔断的错误类（connect/429/5xx/quota）；随熔断清零一并清除。观测面暴露用
   *  （/_modeldock/metrics 熔断字段；编排侧风暴闸只对 quota/429 类外部风暴感兴趣）。 */
  meltdown_cls?: 'connect' | '429' | '5xx' | 'quota'
  /** 连续成功次数（≥3 清零熔断） */
  okStreak: number
  /** 最近一次成功请求/探活的耗时 ms（供 overview 展示与备用链同优先级决胜；失败不写，见 recordOutcome） */
  lastMs?: number
}

// ===== 海况观测（state/sea.ts 维护；全部内存态，重启清零）=====

/** 海况滑窗单分钟分桶：错误类与 HealthState.meltdown_cls 同枚举。total 含成功与中性 4xx
 *  （作错误率分母）；429 不含 quota——relay 分类互斥（429+quota 体归 quota），quota 单列。 */
export interface SeaMinuteBucket {
  /** epoch 分钟数（floor(ms / 60000)）：环形槽位与新鲜度判定键 */
  minute: number
  total: number
  connect: number
  '429': number
  '5xx': number
  quota: number
}

/** 窗口聚合视图（metrics providers[].errors 的 last_5m/last_60m 暴露形状）：
 *  error_rate = 四类错误合计 / total（中性 4xx 只摊分母），四位小数。 */
export interface SeaWindowView {
  total: number
  connect: number
  '429': number
  '5xx': number
  quota: number
  error_rate: number
}

/** providerId → 海况分桶运行态。slots 固定 60 槽环形（槽位 = minute % 60，槽内 minute 不匹配
 *  即陈旧数据、按需清零重用免裁剪）；lastError* 供排查定位最近一次错误（经 recordOutcome 记账）。 */
export interface SeaProviderErrors {
  slots: (SeaMinuteBucket | undefined)[]
  lastErrorAt?: number
  lastErrorCls?: 'connect' | '429' | '5xx' | 'quota'
}

/** 聚合海况信号（metrics 的 sea_state 字段形状）：storm 判定常量见 state/sea.ts 顶部。 */
export interface SeaState {
  storm: boolean
  /** 命中的风暴规则短码（meltdown_majority / rate_429_60m），storm=false 时为空数组 */
  reasons: string[]
  /** 当前处于熔断期的 enabled 服务数 */
  meltdown_count: number
  updated_at: string
}

// ===== 上游模型可用性探测（modelprobe.ts 维护；内存态，重启清零）=====

/** 单个 provider 的上游模型目录探测结果（GET /_modeldock/model-availability 的条目形状） */
export interface ProviderAvailability {
  ok: boolean
  /** ISO 时间戳：本次探测完成时刻（成功失败都刷新） */
  fetched_at: string
  /** ok=true：上游 /models 返回的模型 id（保持上游顺序） */
  model_ids?: string[]
  /** ok=false：失败原因（fetchModelIds 聚合报错，含逐候选端点尝试明细） */
  error?: string
}

/** 上游模型可用性探测运行态 */
export interface ModelProbeState {
  /** providerId → 最近一次探测结果（含失败负缓存：端点只读缓存，不触发补打失败上游） */
  results: Map<string, ProviderAvailability>
  /** 探测中的 providerId：调度 tick 与在飞请求去重，不重复打上游 */
  inflight: Set<string>
}

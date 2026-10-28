import type { Lang } from '../util/i18n.js'

export type Protocol = 'anthropic' | 'openai' | 'responses'
export type AuthStyle = 'bearer' | 'x-api-key'
export type ModelSource = 'preset' | 'fetched' | 'manual'
export type { Lang }

export interface ModelMeta {
  display_name?: string
  /** 输入上下文（tokens） */
  context_window?: number
  /** 最大输出（tokens） */
  max_output?: number
  capabilities?: string[]
  source: ModelSource
}

export interface ProviderConfig {
  name?: string
  base_url: string
  protocol: Protocol
  auth_style: AuthStyle
  /** file:<id> | keychain:<id> | env:<VAR> | 明文值（不推荐） */
  key_ref: string
  /** direct | env | http://host:port */
  proxy?: 'direct' | 'env' | string
  /** 是否参与自动路由（默认 true；设 false = 手动下线，不探测也不作候选） */
  enabled?: boolean
  /** 自动路由候选排序权重（数值大者优先；缺省 0；仅 auto_failover 开启时生效） */
  priority?: number
  /** 每协议的 base_url（如同时支持 anthropic/openai/responses 供不同客户端直连）；base_url 作缺省/默认协议端点 */
  endpoints?: Partial<Record<Protocol, string>>
  models?: Record<string, ModelMeta>
}

export interface ProfileConfig {
  name?: string
  provider: string
  default_model?: string
  /** 请求模型名（支持 * 通配）→ 上游模型名 */
  aliases?: Record<string, string>
  /** 故障切换候选（主服务不可达时依次尝试）。条目："<providerId>"（透传原模型名）或 "<providerId>:<modelId>"（改写为该模型） */
  fallback?: string[]
}

export interface HarnessEntry {
  /** gateway = 指向本地网关；file = 接管文件但客户端自管路由；direct = 独立直连（写上游 url+key，不经网关） */
  mode: 'gateway' | 'file' | 'direct'
  /** default = 跟随 active_profile；否则钉死到某 profile。direct 模式下 = 直连目标 profile（切回网关/换目标时用） */
  route?: string
  /** direct 模式：实际写入客户端的直连地址（PlanResult.writtenBaseUrl；workbuddy 等按 url 匹配自己条目时用） */
  direct_base?: string
  token?: string
  attached_at?: string
  files?: string[]
  /** attach 时选定的客户端自身 profile（如 dsh 的 desktop / web）；模式切换时按此范围重写 */
  client_profiles?: string[]
  /** 接入时写入的网关地址（如 http://127.0.0.1:8687）；detach 据此做精确匹配，避免误删用户其他本地代理配置 */
  gateway_base?: string
}

export interface AdapterPack {
  format: 'json' | 'toml' | 'yaml'
  config_file: string
  detect?: { file_exists?: boolean; key_path?: string }
  /** 路径表达式 → 值模板，支持 {token} {port} {base_url} {base_url_openai} 变量 */
  upsert: Record<string, string>
}

export interface GatewayConfig {
  port?: number
  idle_timeout_ms?: number
  retries?: number
  /** 等待上游响应头的时限 ms（非流式长推理可能超 60s；默认 60000） */
  headers_timeout_ms?: number
  /** 网关请求体缓冲上限（MB，默认 16）。模型改写需完整缓冲请求体；超限返回 413。确需更大包体（大 PDF/多附件）时上调 */
  max_body_mb?: number
  /** JSONL 日志（gateway-*.jsonl / audit-*.jsonl）按天文件保留天数：早于该天数的日文件在网关启动与每日定时自动删除（默认 30）；0 = 禁用清理、全部保留 */
  log_retention_days?: number
  /** 开启「程序自动选主」（定时窗口按时间接管主服务；默认关=主服务完全由人工/默认路由决定）。故障切换（主服务不可达时切备用）不受此开关影响，始终可用 */
  auto_failover?: boolean
  /** 「当前」槽人工钉定的主服务 id：设置后实际路由优先走它（人为修改优先于程序自动，含定时窗口；它不可达时自动落回窗口/默认路由再故障切换）；留空=自动态，程序按窗口/默认路由选主 */
  auto_route_provider?: string
  /** 已送达状态下允许切换备用服务的上游状态码（如 [429,503]）；缺省空 = 不切换（安全边界：已送达的响应原样返回） */
  failover_status_codes?: number[]
  /** 「下一个切换」槽人工钉定：主服务不可达时优先切到它（插到备用链首位；它也不可用时按备用链自动顺延）；留空=按 priority/实测耗时自动排序 */
  route_next?: string
  /** 自动备用链：手动 fallback 之外，自动把已启用服务补进切换候选（按定时窗口/优先级/实测耗时排序，模型名原样透传）；缺省开，仅显式 false 关闭 */
  auto_fallback?: boolean
  /** 定时切换：时段内优先走指定服务/模型（每次请求实时求值，无定时器）；生效日由日类型判定（法定节假日数据源 holiday-cn） */
  schedule?: { enabled?: boolean; windows?: ScheduleWindow[] }
}

export interface ScheduleWindow {
  /** HH:mm（本地时间，含） */
  start: string
  /** HH:mm（本地时间，不含；小于 start 视为跨午夜，后半夜归属窗口起始日） */
  end: string
  /** 候选条目语法："<providerId>"（透传模型）或 "<providerId>:<modelId>"（改写模型） */
  target: string
  /** 生效的星期几（1=周一…7=周日）；缺省 = 不限。与 dayFilter 同时配置时取交集 */
  days?: number[]
  /** 生效日类型（日历判定，节假日数据源 holiday-cn）：workday=周一至五与调休补班日（不含法定节假日）；weekend=周六日；holiday=法定放假日；缺省 = 每天 */
  dayFilter?: 'workday' | 'weekend' | 'holiday'
  /** 窗口模式：'prefer'（缺省）= 时段内优先走 target；'avoid' = 时段内避开 target 服务（其余服务照常按优先级顺延；仅到服务粒度，模型部分被忽略） */
  mode?: 'prefer' | 'avoid'
}

export interface Config {
  version: number
  /** 界面语言（CLI 输出 / 报错 / 网关日志消息）：zh | en，缺省 zh；--lang 与环境变量 MODELRDOCK_LANG 可临时覆盖 */
  language?: Lang
  active_profile?: string
  providers: Record<string, ProviderConfig>
  profiles: Record<string, ProfileConfig>
  harness: Record<string, HarnessEntry>
  adapter_packs?: Record<string, AdapterPack>
  gateway?: GatewayConfig
  /** 手机简版控制台（LAN）：第二监听器，只读状态+切换；默认关。实现见 src/gateway/lan.ts */
  lan?: LanConfig
  security?: { store?: 'file' | 'keychain' }
  backup?: { keep?: number }
  update?: UpdateConfig
  import?: ImportStateConfig
  /** 文本资产同步白名单目录（家目录相对 POSIX 路径，见 src/sync/assets.ts）；每机自选属机器态，不随包同步 */
  sync_assets?: { dirs?: string[] }
}

/** 一键导入（存量收编）状态 */
export interface ImportStateConfig {
  /** 已忽略候选的归一化地址（「暂不导入」/导入完成后记忆）：自动弹卡不再提示；「添加服务 → 勾选导入」手动入口不受影响 */
  dismissed?: string[]
}

/** 手机简版控制台（LAN）配置 */
export interface LanConfig {
  enabled?: boolean
  /** LAN 监听端口（默认 8787，避开主端口 8687 的 +1 顺延链；冲突自动 +1） */
  port?: number
}

/** 自动更新（公开仓库匿名直连 + 可选 PAT + 镜像回退链，见 docs/design-auto-update.md §6） */
export interface UpdateConfig {
  /** 更新源仓库 owner/name（默认公开主仓库；改指私有仓库时需配 token_ref） */
  repo?: string
  /** 更新 feed 基地址（默认 GitHub API；自建源/本地 mock 可覆盖，见 docs/design-auto-update.md §4 三阶段） */
  api_base?: string
  /** PAT 在 secrets 中的 key_ref（setSecret 返回值；令牌本体存 secrets.json/keychain，不进 config 明文）。
   *  可选：公开仓库匿名即可更新，令牌仅私有仓库必需、或把匿名限流 60 次/时提到 5000 次/时 */
  token_ref?: string
  /** 下载镜像前缀列表（拼在 browser_download_url 前；仅资产走镜像，SHA256SUMS 永走官方 API）。
   *  空数组 = 关闭镜像只走官方直连；缺省用 DEFAULT_UPDATE_MIRRORS */
  mirror?: string[]
}

export const CONFIG_VERSION = 1

/** 网关默认端口（唯一常量出处；config.gateway.port 可覆盖） */
export const DEFAULT_GATEWAY_PORT = 8687

/** JSONL 日志日文件默认保留天数（见 GatewayConfig.log_retention_days；0 = 禁用清理） */
export const DEFAULT_LOG_RETENTION_DAYS = 30

/** 自动更新默认源仓库（公开主仓库，匿名可读；见 docs/design-auto-update.md §6） */
export const DEFAULT_UPDATE_REPO = 'ObsidianTrine/model_dock'

/** 下载镜像回退链默认值（大陆加速；design §6 第 4 项）。官方直连是隐式末位，不在此列 */
export const DEFAULT_UPDATE_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/']

/** 手机简版控制台默认端口（主端口顺延链 8687+10 之外，避免撞车） */
export const DEFAULT_LAN_PORT = 8787

export function emptyConfig(): Config {
  return { version: CONFIG_VERSION, providers: {}, profiles: {}, harness: {} }
}

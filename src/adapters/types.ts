import type { AuthStyle, Config, Protocol } from '../config/types.js'

export interface DetectResult {
  installed: boolean
  configFiles: string[]
  current?: string
  note?: string
}

export interface FileChange {
  path: string
  /** null = 新建文件 */
  before: string | null
  after: string
  note?: string
}

export interface AttachOptions {
  mode: 'gateway' | 'file'
  profile?: string
  /** 限定写入的客户端自身 profile（如 dsh 的 desktop / web）；缺省 = 该客户端的全部 profile */
  clientProfiles?: string[]
  gatewayPort: number
  token: string
  setDefault?: boolean
  takeoverModels?: boolean
  /** 切换前的模式（模式切换时传入）：direct → gateway 时 adapter 需清掉 direct 写入的模型映射 env */
  fromMode?: 'gateway' | 'file' | 'direct'
  /** 独立直连（direct 模式）：写上游 base_url + 真实 key 而非网关地址 + 本地 token。
   *  缺省 = 网关模式，行为完全不变。客户端配置不再经过网关（网关挂掉后该客户端照常工作）。 */
  direct?: {
    /** 上游 API 地址（anthropic 协议端点；provider.base_url 为缺省） */
    base_url: string
    /** 上游 OpenAI 协议端点（openai 兼容客户端 / adapter pack 模板 {base_url_openai} 用） */
    base_url_openai?: string
    /** 上游 Responses 协议端点（codex 用；缺省回退 base_url） */
    base_url_responses?: string
    /** 上游服务声明的协议（adapter 据此选端点与 api 类型） */
    protocol: Protocol
    /** 上游真实 key 明文（写入客户端配置文件，直连的本质） */
    key: string
    /** 上游鉴权方式：bearer → AUTH_TOKEN 类变量；x-api-key → API_KEY 类变量 */
    auth_style: AuthStyle
  }
}

export interface PlanResult {
  changes: FileChange[]
  notes: string[]
  /** 需合并进 ModelDock config 的 profile 更新（如 --takeover-models 迁入的模型映射） */
  profileUpdates?: { aliases?: Record<string, string>; default_model?: string }
  /** attach 过程中从外部目录（如 dsh 内置 catalog）补全的模型元数据，写回 ModelDock 模型目录 */
  providerModelMeta?: { provider: string; models: Record<string, import('../config/types.js').ModelMeta> }
  /** direct 模式：实际写入客户端的直连地址（ops 据此登记 harness.direct_base，供幂等重接/清理匹配） */
  writtenBaseUrl?: string
}

export interface AdapterStatus {
  installed: boolean
  attached: boolean
  pointing?: 'gateway' | 'other' | 'unknown'
  detail?: string
}

/**
 * 客户端安装元数据。installed（配置文件存在）为 false 时，Web 控制台据此渲染「安装并接入」按钮：
 * 有 command 则 ModelDock 直接自动安装（npm 类 / 平台脚本类），否则仅提供安装指引。
 * command 为硬编码常量命令，由服务端以 shell 执行，无拼接风险。
 */
export interface ClientInstall {
  /** 自动安装命令。npm 类写 'npm i -g …'；安装方式分平台时（小米官方脚本等）用 { posix, win32 } 映射。
   *  执行时服务端自动注入 npm 镜像 registry；needsNode 时先保障 Node 可用（缺则下载托管运行时） */
  command?: string | { posix: string; win32: string }
  /** 命令是否依赖 node/npm（npm 类客户端为 true；平台脚本类如小米安装器自带二进制则省略）：
   *  本机无 Node 时先下载托管 Node 运行时再执行安装命令 */
  needsNode?: boolean
  /** 该客户端在 PATH 上的命令名（如 claude）。执行 command 前先探测它：
   *  命令已存在说明用户其实装好了（多半只是配置文件还没生成），此时必须跳过 npm 全局安装——
   *  npm 会先把现有安装目录与 shim 改名 retire 再重建，postinstall 一旦不成功
   *  （平台可选依赖没下到 / --ignore-scripts），留下的只是一个报错桩，命令会直接失效。 */
  probe?: string
  /** 手动安装指引正文（command 缺失或安装失败时展示，需可操作） */
  guide: string
  /** 官方链接（可省；仅填确信的，避免编造 URL） */
  homepage?: string
  /** 自动卸载命令（npm 类客户端声明；脚本类安装器无官方卸载、桌面应用走系统卸载，均省略——
   *  省略时控制台不提供卸载按钮、/uninstall 端点拒绝）。执行环境与安装一致：沙箱下全局落点
   *  同样经 npm_config_prefix 重定向，只卸装进沙箱的副本 */
  uninstall?: string | { posix: string; win32: string }
  /** 安装成功后需生成的空配置文件：让 detect 的 installed 生效、planAttach 可运行。
   *  path 惰性求值（模块加载时 homeDir 可能尚未被测试重定向） */
  bootstrap?: { path: string | (() => string); content: string }
}

/** 平台映射命令按当前平台解析成单条字符串（overview 序列化、执行、UI 确认框共用） */
export function resolveInstallCommand(cmd: ClientInstall['command']): string | null {
  if (!cmd) return null
  if (typeof cmd === 'string') return cmd
  return process.platform === 'win32' ? cmd.win32 : cmd.posix
}

/** 是否为 npm 全局安装（npm i/install/add … -g/--global …）：其落点可经 npm_config_prefix 重定向，
 *  沙箱模式（MODELRDOCK_FAKE_HOME）因此支持自动安装。脚本类安装（curl|bash、irm|iex 等）
 *  落点由第三方脚本决定、无法重定向，沙箱内不予执行。 */
export function isNpmGlobalInstall(cmd: string): boolean {
  return /^npm(?:\.cmd)?\s+(?:i|install|add)\s+(?:--\S+\s+|-\S+\s+)*(?:-g|--global)(?:\s|$)/.test(cmd.trim())
}

export class AdapterError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'AdapterError'
  }
}

/**
 * adapter 只负责"计算改动"（plan*），落盘统一走 engine.applyChanges：
 * diff 预览 → 快照 → 原子写 → 回读校验，保证非侵入与可还原。
 */
export interface HarnessAdapter {
  id: string
  label: string
  /** 支持独立直连（planAttach 认 AttachOptions.direct 并写上游 url+key）。无文件形态的客户端（generic）为 false */
  directMode?: boolean
  /** 模型列表/默认模型烙在客户端配置文件里（dsh 的 patch models、workbuddy 的 models.json、zcode 的 personalModelIds）：
   *  全局切换服务后需按新路由重写客户端文件才跟随（其余客户端指向网关、零改动即跟随） */
  bakesModels?: boolean
  install?: ClientInstall
  detect(): Promise<DetectResult>
  /** 客户端自身 profile 名列表（如 dsh 的 desktop / web），供 UI 渲染接入范围选择；无此概念的 adapter 不实现 */
  clientProfileOptions?(): Promise<string[]>
  planAttach(opts: AttachOptions, cfg: Config): Promise<PlanResult>
  planDetach(cfg: Config): Promise<PlanResult>
  status(cfg: Config, gatewayPort: number): Promise<AdapterStatus>
}

export function gatewayBase(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function gatewayBaseOpenAI(port: number): string {
  return `http://127.0.0.1:${port}/v1`
}

/** 严格判断 URL 是否指向本机回环地址（127.x / ::1 / localhost），端口可选精确匹配。
 *  替代过宽的 includes('127.0.0.1')：那会误伤含该子串的公网域名。 */
export function isGatewayUrl(value: string | undefined | null, port?: number): boolean {
  if (!value) return false
  const m = /^https?:\/\/(127\.\d+\.\d+\.\d+|\[::1\]|::1|localhost)(?::(\d+))?(?:[/?#]|$)/i.exec(value.trim())
  if (!m) return false
  if (port !== undefined) return Number(m[2] ?? 80) === port
  return true
}

/** detach 判据：优先与接入时记录的 gateway_base 按源（host+port）精确比较；
 *  未记录（旧版接入的 harness）时退回回环启发式。 */
export function isOursGatewayUrl(
  value: string | undefined | null,
  harnessId: string,
  cfg: Config
): boolean {
  if (!value) return false
  const gb = cfg.harness[harnessId]?.gateway_base
  if (gb) {
    try {
      return new URL(value.trim()).origin === new URL(gb).origin
    } catch {
      return false
    }
  }
  return isGatewayUrl(value)
}

import { t } from '../util/i18n.js'
import type { Config, ModelMeta, Protocol } from '../config/types.js'
import type { AttachOptions } from './types.js'
import { gatewayBase, gatewayBaseOpenAI } from './types.js'

/** 上下文变体后缀（[1m]/[128k] 等）：是请求参数标记，不是独立模型 id；NAME 显示与清洗时剥掉 */
export const CONTEXT_SUFFIX_RE = /\[\d+[MmKk]\]$/

export function stripContextSuffix(id: string): string {
  return id.replace(CONTEXT_SUFFIX_RE, '')
}

export interface ResolvedRoute {
  routeName?: string
  profile?: Config['profiles'][string]
  providerId?: string
  provider?: Config['providers'][string]
  modelMap: Record<string, ModelMeta>
}

/** 路由 → profile → provider → 模型目录 解析（dsh/zcode/workbuddy/provider-json 共用）：
 *  显式 opts.profile 优先（钉定路由），否则随全局 active_profile 走当前路由对应服务的模型目录 */
export function resolveRoute(opts: Pick<AttachOptions, 'profile'>, cfg: Config): ResolvedRoute {
  const routeName = opts.profile ?? cfg.active_profile
  const profile = routeName ? cfg.profiles[routeName] : undefined
  const providerId = profile?.provider
  const provider = providerId ? cfg.providers[providerId] : undefined
  return { routeName, profile, providerId, provider, modelMap: provider?.models ?? {} }
}

/** 「模型列表取自当前路由…」展示 note（dsh/zcode/workbuddy/provider-json 文案一致，一并收敛） */
export function routeModelNote(routeName: string, provider: string, count: number): string {
  return t(
    '模型列表取自当前路由「{route}」（{provider}）：{count} 个模型',
    'The model list comes from the current route "{route}" ({provider}): {count} models',
    { route: String(routeName), provider: String(provider), count }
  )
}

/** 直连 wire 选择：dsh（llm-pi 插件）专用。ZCode 的 api.type 是另一套枚举，走下方 zcodeApiType，
 *  两者不可互换——dsh 的 openai wire 名 openai-completions 写进 ZCode 会让整份 provider_config.json 被拒收。 */
export function directWire(d: AttachOptions['direct'] | undefined): {
  api: 'anthropic-messages' | 'openai-completions' | undefined
  base: string | undefined
} {
  return {
    api: d ? (d.protocol === 'openai' ? 'openai-completions' : 'anthropic-messages') : undefined,
    base: d ? (d.protocol === 'openai' ? (d.base_url_openai ?? d.base_url) : d.base_url) : undefined,
  }
}

/** 直连 Responses 协议警告（dsh 专用：llm-pi 没有 responses wire，ZCode 自己有 openai-responses 不用此提示） */
export function directResponsesNote(label: string): string {
  return t(
    '提示: 该服务是 Responses 协议，{label} 不支持该 wire 类型；直连条目按 anthropic-messages 写入，请确认上游兼容',
    'Note: this service uses the Responses protocol, which {label} does not support as a wire type; the direct entry is written as anthropic-messages — make sure the upstream is compatible',
    { label }
  )
}

/** 网关模式 wire 选择（dsh/llm-pi 专用）：跟随当前路由服务的协议。网关不做跨协议转换，
 *  客户端说哪门 wire 必须与服务协议一致，否则 anthropic 路径拼上 openai 端点必 404。
 *  openai 协议 → openai-completions 且 base 带 /v1（llm-pi 的 openai wire 追加 /chat/completions，
 *  落到网关规范路径 /v1/chat/completions，ROUTED_PATH_RE 的模型改写才生效）；
 *  anthropic/responses → anthropic-messages 且 base 不带 /v1（追加 /v1/messages）。无路由时保持旧默认。 */
export function gatewayWire(provider: { protocol: Protocol } | undefined): {
  api: 'anthropic-messages' | 'openai-completions'
  base: (port: number) => string
} {
  return provider?.protocol === 'openai'
    ? { api: 'openai-completions', base: gatewayBaseOpenAI }
    : { api: 'anthropic-messages', base: gatewayBase }
}

/** 网关模式接入状态判定：客户端 base 为本网关两种规范形态（anthropic 不带 /v1、openai 带 /v1）
 *  之一即本网关。gatewayWire 起写入形态随服务协议二选一，status 只认旧形态会把新写入误判
 *  为「其他实例写入」且重写无法消除（重写幂等写回同形态）。 */
export function isGatewayBase(base: string | undefined, port: number): boolean {
  return base === gatewayBase(port) || base === gatewayBaseOpenAI(port)
}

/** 「未配置 Responses 协议端点、直连回退了默认地址」note（codex / zcode 同款） */
export function directResponsesEndpointNote(): string {
  return t(
    '提示: 该服务未配置 Responses 协议端点，直连使用了默认地址；请确认上游支持 Responses API，或在「编辑服务」里补填',
    'Note: this service has no Responses protocol endpoint, so direct mode used the default URL; make sure the upstream supports the Responses API, or fill it in under Edit Service'
  )
}

/** 「独立直连已写入明文 Key」note（codex/dsh/zcode/provider-json/packs/workbuddy 手抄收敛为同一文案）。
 *  url 缺失（dsh 这类经 refs 间接引用、note 不带地址的）时省略地址子句。 */
export function directAttachNote(url?: string | number): string {
  return url !== undefined
    ? t(
        '独立直连：已写入上游 {url} 与真实 Key（明文），网关挂掉后该客户端不受影响',
        'Direct mode: wrote the upstream {url} and the real key (plaintext); this client keeps working if the gateway is down',
        { url: String(url) }
      )
    : t(
        '独立直连：已写入真实 Key（明文），网关挂掉后该客户端不受影响',
        'Direct mode: wrote the real key (plaintext); this client keeps working if the gateway is down'
      )
}
import { t } from '../util/i18n.js'
import { textEqualsIgnoreEol } from '../util/diff.js'
import type { Config, ModelMeta, Protocol, ProviderConfig } from '../config/types.js'
import { AdapterError, type AttachOptions, type FileChange, type PlanResult } from './types.js'
import { gatewayBase, gatewayBaseOpenAI, isOursGatewayUrl, type HarnessAdapter } from './types.js'

/** 等值过滤帮手：内容无变化返回 null（稳态重接/周期 refresh 零快照零写盘），有变化才产出 FileChange。
 *  dsh/zcode 内联了同款判定；其余适配器统一走这里（known-issues P2：此前 5 处稳态重接也整包
 *  快照+写盘，与 dsh 声明的设计意图不一致）。
 *  比较走 textEqualsIgnoreEol（CRLF 归一化）：Windows 编辑器保存的客户端配置是 CRLF 而
 *  序列化输出恒 LF，逐字节比较会把仅行尾差异的稳态误判为有变化、每次整写盘+快照。 */
export function changeIfChanged(
  path: string,
  before: string | null,
  after: string,
  note?: string
): FileChange | null {
  return textEqualsIgnoreEol(after, before) ? null : { path, before, after, note }
}

/** 「string 才透传」三元防抖收敛（T25，七处同款）：entry 里的 URL 字段来自任意 JSON 形态，
 *  只有 string 才参与 isOursGatewayUrl 判定。 */
export function oursEntryUrl(x: unknown, harnessId: string, cfg: Config): boolean {
  return isOursGatewayUrl(typeof x === 'string' ? x : undefined, harnessId, cfg)
}

/** planDetach 空结果尾收敛（T25，七处手抄 { changes: [], notes: [...] }）：notes 由调用方
 *  给定（t() 实参原样上移，各现场的措辞差异——label 前缀/「当前」——逐字节保留）。 */
export function noChangeResult(notes: string[]): PlanResult {
  return { changes: [], notes }
}

/** status() pointing 三态收敛（T25）：dsh/zcode 逐字相同的 isGatewayBase 三元 + detail 拼接，
 *  仅「无 provider 占位文案」不同（参数化）。 */
export function pointingStatus(
  base: string | undefined,
  models: number,
  port: number,
  noProviderZh: string,
  noProviderEn: string
): { pointing: 'gateway' | 'other' | 'unknown'; detail: string } {
  return {
    pointing: isGatewayBase(base, port) ? 'gateway' : base ? 'other' : 'unknown',
    detail:
      (base ?? t(noProviderZh, noProviderEn)) +
      (models > 0 ? t(' · {count} 个模型', ' · {count} models', { count: models }) : ''),
  }
}

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

/** 钉路由/接入的协议兼容校验（hHarnessRoute / cmdHarnessRoute / planAttach 三口共用口径）：
 *  网关不做跨协议翻译（relay.upstreamEndpoint 对未配客户端协议端点的候选直接 candidateSkip），
 *  单协议客户端钉到不支持该协议的服务 = 钉成功但永远打不到（请求只会被静默改发给别家，
 *  2026-11-08 claude-code 钉 bigmodel 报 404 即此）。声明了 clientProtocols 且目标服务一个都不
 *  支持 → 返回可操作的拒绝原因（双语）；多协议/未知客户端未声明 → 放行不校验（宁漏检不误拦）。 */
export function pinProtocolConflict(
  adapter: HarnessAdapter | undefined,
  provider: ProviderConfig,
  providerId?: string
): string | undefined {
  const want = adapter?.clientProtocols
  if (!adapter || !want?.length) return undefined
  const supported = want.some((p) => provider.endpoints?.[p] || provider.protocol === p)
  if (supported) return undefined
  const wantStr = want.join(' / ')
  const svc = provider.name || providerId || '?'
  return t(
    '客户端「{client}」只支持 {want} 协议，服务「{svc}」没有该协议端点——钉过去请求只会被改发给别的服务，永远打不到。修复二选一：在「编辑服务」里给「{svc}」补 {want} 协议端点；或改钉其他支持 {want} 的服务',
    'Client "{client}" speaks only {want}, and service "{svc}" has no such protocol endpoint — pinned requests would always fail over to other services and never reach this one. Fix either way: add a {want} endpoint to "{svc}" under "Edit Service", or pin to another service that supports {want}',
    { client: adapter.label, want: wantStr, svc }
  )
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

/** 外部配置字段级守卫（provider-json/codex/zcode 的 attach 共用）：客户端配置文件用户可手编、
 *  其他工具可写坏（provider: "x"、model_providers: 123），字段类型不对时对原始值赋属性会以裸
 *  TypeError 冒到 CLI 顶层——转 AdapterError 带文件路径与当前类型，可操作。结构级畸形（整个
 *  文件不是对象）各 adapter 已另有守卫，这里收敛**字段级**。undefined/null 视为「缺省」放行
 *  （调用方随后 ??= 正常建表）；detach 侧不做此抛错（清理要宽容，类型不对就跳过对应清理）。 */
export function ensurePlainObjectField(value: unknown, field: string, path: string): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AdapterError(
      t('{path} 的「{field}」不是对象（当前是 {kind}），已中止（未做任何改动）', '"{field}" in {path} is not an object (got {kind}); aborted (nothing changed)', { path, field, kind: Array.isArray(value) ? 'array' : typeof value }),
      t('把该字段改成对象（或删掉让 ModelDock 重建）后重新接入', 'Make the field an object (or remove it and let ModelDock rebuild it), then attach again')
    )
  }
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
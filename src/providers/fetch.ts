import { request } from 'undici'
import type { ProviderConfig } from '../config/types.js'
import { getSecret } from '../config/secrets.js'
import { buildDispatcher } from '../gateway/proxy.js'
import { t } from '../util/i18n.js'
import { saneContextWindow, saneMaxOutput } from './known.js'

export interface UpstreamMeta {
  context_window?: number
  max_output?: number
}

export interface FetchedModels {
  ids: string[]
  display: Record<string, string>
  endpoint: string
  /** 上游 /models 响应自带的模型元数据（仅收录通过边界校验的数值字段）；响应未提供则无该条 */
  meta: Record<string, UpstreamMeta>
}

function authHeaders(provider: ProviderConfig, key: string): Record<string, string> {
  if (provider.protocol === 'anthropic') {
    const h: Record<string, string> = { 'anthropic-version': '2023-06-01' }
    if (provider.auth_style === 'x-api-key') h['x-api-key'] = key
    else h.authorization = `Bearer ${key}`
    return h
  }
  return { authorization: `Bearer ${key}` }
}

/** 剥掉 base 尾部的协议/版本段（/v1、/v1beta、/anthropic、/openai、/compatible-mode 等），得到根变体 */
function stripProtocolPath(u: string): string {
  const seg = u.split('/')
  while (seg.length && /^(v\d+(?:beta)?|anthropic|openai|compatible-mode)$/.test(seg[seg.length - 1])) seg.pop()
  return seg.join('/') || u
}

/** 从 base_url 生成 models 候选端点多条（base 原样 + 逐层剥协议后缀的各根变体，各配 /v1/models 与 /models） */
function modelEndpoints(base: string): string[] {
  const out: string[] = []
  const push = (u: string) => { if (u && out.indexOf(u) < 0) out.push(u) }
  let cur = base.replace(/\/+$/, '')
  for (let i = 0; i < 4; i++) {
    push(`${cur}/v1/models`)
    push(`${cur}/models`)
    const s = stripProtocolPath(cur)
    if (s === cur) break
    cur = s
  }
  return out
}

/**
 * 解析单条模型条目自带的元数据（各家字段名归一化，取首个通过边界校验的数值）：
 * - 上下文：DeepSeek context_window / Kimi、Together、OpenRouter context_length /
 *   Anthropic max_input_tokens / vLLM max_model_len / Gemini inputTokenLimit（含 snake 写法）/
 *   Mistral max_context_length / Fireworks contextLength
 * - 输出：DeepSeek max_output_tokens / Gemini outputTokenLimit（含 snake 写法）/
 *   Groq、OpenRouter（top_provider 嵌套）max_completion_tokens；
 *   max_tokens 仅在 anthropic 协议下当作最大输出（其语义是「max_tokens 参数的上限」；
 *   OpenAI 系响应里该键含义不明，一律不采信）
 */
export function parseUpstreamModelMeta(item: unknown, protocol: string): UpstreamMeta {
  if (typeof item !== 'object' || item === null) return {}
  const rec = item as Record<string, unknown>
  const out: UpstreamMeta = {}
  const ctx = saneContextWindow(pickNumber(rec, [
    'context_window', 'context_length', 'max_input_tokens', 'max_model_len',
    'input_token_limit', 'inputTokenLimit', 'max_context_length', 'contextLength',
  ]))
  if (ctx !== undefined) out.context_window = ctx
  const nested = typeof rec.top_provider === 'object' && rec.top_provider !== null
    ? (rec.top_provider as Record<string, unknown>)
    : undefined
  const outRaw = pickNumber(rec, ['max_output_tokens', 'output_token_limit', 'outputTokenLimit', 'maxOutputTokens'])
    ?? (nested ? pickNumber(nested, ['max_completion_tokens']) : undefined)
    ?? (protocol === 'anthropic' ? pickNumber(rec, ['max_tokens']) : undefined)
  const outVal = saneMaxOutput(outRaw)
  if (outVal !== undefined) out.max_output = outVal
  return out
}

function pickNumber(rec: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'number') return v
  }
  return undefined
}

/**
 * 自动拉取上游可用模型列表：从 base_url 派生「原样 + 剥协议后缀」多条候选（/v1/models、/models），
 * 逐个试到返回 200 且 data[].id 非空；都不行则抛可执行提示（上层可走厂商已知兜底）。
 * 健壮性：每端点 15s、整体 60s 截止；非 200 / 异常路径排空响应体释放连接；响应体超 20MB 视为异常跳过。
 */
export async function fetchModelIds(provider: ProviderConfig): Promise<FetchedModels> {
  const key = await getSecret(provider.key_ref)
  if (!key) throw new Error(t('key 未设置，先 modeldock provider set-key', 'Key not set; run modeldock provider set-key first'))
  const candidates = modelEndpoints(provider.base_url)

  const dispatcher = buildDispatcher(provider.proxy)
  const deadline = Date.now() + 60_000
  const MAX_BODY_BYTES = 20 * 1024 * 1024
  // 逐候选记录结果（错误信息里全部列出，用户才知道测了哪些地址）
  const attempts: string[] = []
  for (const endpoint of candidates) {
    if (Date.now() > deadline) {
      attempts.push(attempts.length ? t('后续候选因整体超时（60s）未再尝试', 'Remaining candidates skipped: overall timeout (60s)') : t('整体超时（60s 内未能拉取到模型列表）', 'Overall timeout (60s): no model list fetched'))
      break
    }
    let up
    try {
      up = await request(endpoint, {
        method: 'GET',
        headers: authHeaders(provider, key),
        dispatcher,
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      })
    } catch (e) {
      attempts.push(`${endpoint} → ${(e as Error).message}`)
      continue
    }
    try {
      if (up.statusCode === 200) {
        const len = Number(up.headers['content-length'] ?? 0)
        if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
          attempts.push(t('{endpoint} 响应体异常偏大（{len} 字节），跳过', '{endpoint}: response body abnormally large ({len} bytes), skipped', { endpoint, len }))
          await up.body.dump().catch(() => {})
          continue
        }
        const j = JSON.parse(await up.body.text())
        const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : []
        const ids: string[] = []
        const display: Record<string, string> = {}
        const meta: Record<string, UpstreamMeta> = {}
        for (const item of arr) {
          if (typeof item?.id !== 'string') continue
          ids.push(item.id)
          if (typeof item?.display_name === 'string') display[item.id] = item.display_name
          const m = parseUpstreamModelMeta(item, provider.protocol)
          if (m.context_window !== undefined || m.max_output !== undefined) meta[item.id] = m
        }
        if (ids.length === 0) {
          attempts.push(t('{endpoint} 返回 200 但没有模型列表', '{endpoint} returned 200 but no model list', { endpoint }))
          continue
        }
        return { ids, display, endpoint, meta }
      }
      attempts.push(`${endpoint} → HTTP ${up.statusCode}`)
      // 非 200：必须排空/关闭响应体，否则连接无法复用（连续多端点会泄漏 socket）
      await up.body.dump().catch(() => {})
    } catch (e) {
      attempts.push(`${endpoint} → ${(e as Error).message}`)
      await up.body.dump().catch(() => {})
    }
  }
  throw new Error(
    t('自动拉取模型失败（已按接口地址派生 {n} 个候选并逐个尝试）：{attempts}。',
      'Auto-fetch of the model list failed ({n} candidate endpoints derived from the base URL were tried one by one): {attempts}.',
      { n: candidates.length, attempts: attempts.join(t('；', '; ')) }) +
    t('可手动登记：modeldock model set <providerId> <model> --ctx …', 'Register manually: modeldock model set <providerId> <model> --ctx …')
  )
}

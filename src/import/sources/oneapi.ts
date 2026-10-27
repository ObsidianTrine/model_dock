/** one-api / new-api 渠道导入源（管理 API 拉取，需站点地址 + 系统访问令牌，分页带 60s deadline） */
import { slugify } from '../../util/index.js'
import { t } from '../../util/i18n.js'
import { stripApiEndpoint, type ImportCandidate, type ImportSource, type RawRow } from './common.js'
import type { Protocol } from '../../config/types.js'

/* ── one-api / new-api 渠道（管理 API 拉取）───────────────────────────────────
 *  渠道数据在服务端数据库，本机自动检测拿不到；走管理 API：GET /api/channel/?p=N，
 *  鉴权为「个人设置 → 系统访问令牌」（Authorization 原样携带，one-api auth.go 实析）。
 *  只导入 OpenAI 兼容 / Anthropic 类型；Azure、Gemini 原生、Bedrock 等协议 ModelDock
 *  无法直连，跳过并注明。base_url 为空（官方直连渠道）时按类型映射官方端点，无映射跳过。 */

export interface OneApiImportSource {
  url: string
  token: string
}

/** one-api 渠道 type → ModelDock 协议。14=Anthropic；其余为 OpenAI 兼容生态（one-api
 *  relay/channeltype/define.go iota 序号，原生 Gemini/Azure/Bedrock 等不在列）。 */
const ONEAPI_TYPE_ANTHROPIC = new Set([14])
const ONEAPI_TYPE_OPENAI = new Set([1, 2, 4, 5, 6, 7, 8, 9, 10, 12, 13, 16, 17, 19, 20, 21, 22, 25, 26, 27, 28, 29, 30, 31, 32, 36, 37, 39, 40, 41, 44, 45, 50, 51])

/** 常见类型未填 base_url 时的官方端点（openai 形态 base，可带 /v1 也可以不带） */
const ONEAPI_TYPE_OFFICIAL_BASE: Record<number, string> = {
  1: 'https://api.openai.com/v1',
  14: 'https://api.anthropic.com',
  16: 'https://open.bigmodel.cn/api/paas/v4',
  17: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  20: 'https://openrouter.ai/api/v1',
  25: 'https://api.moonshot.cn/v1',
  28: 'https://api.mistral.ai/v1',
  29: 'https://api.groq.com/openai/v1',
  36: 'https://api.deepseek.com/v1',
  39: 'https://api.together.xyz/v1',
  40: 'https://ark.cn-beijing.volces.com/api/v3',
  41: 'https://api.novita.ai/v3/openai',
  44: 'https://api.siliconflow.cn/v1',
  45: 'https://api.x.ai/v1',
}

/** one-api 渠道行 → 导入候选；不支持的类型/缺信息返回带 skip_reason 的占位（供用户看原因） */
export function oneApiChannelToCandidate(ch: RawRow): ImportCandidate {
  const type = Number(ch.type ?? 0)
  const name = typeof ch.name === 'string' && ch.name.trim() ? ch.name.trim() : `channel-${ch.id ?? '?'}`
  const base = (typeof ch.base_url === 'string' && ch.base_url.trim()) || ONEAPI_TYPE_OFFICIAL_BASE[type] || ''
  const key = typeof ch.key === 'string' ? ch.key.trim() : ''
  const source: ImportSource = 'oneapi'
  const disabled = Number(ch.status ?? 1) !== 1
  if (disabled) {
    return { ...emptyOneApiCandidate(name), skip_reason: t('渠道已停用', 'Channel is disabled') }
  }
  const protocol: Protocol | null = ONEAPI_TYPE_ANTHROPIC.has(type) ? 'anthropic' : ONEAPI_TYPE_OPENAI.has(type) ? 'openai' : null
  if (!protocol) {
    return { ...emptyOneApiCandidate(name), skip_reason: t('渠道类型 {type} 走非 OpenAI/Anthropic 兼容上游，暂不支持导入', 'Channel type {type} uses a non-OpenAI/Anthropic-compatible upstream; import is not supported yet', { type }) }
  }
  if (!base) {
    return { ...emptyOneApiCandidate(name), skip_reason: t('渠道未填 base_url 且类型 {type} 无官方端点映射，请手动添加', 'The channel has no base_url and type {type} has no official endpoint mapping; add it manually', { type }) }
  }
  if (!key) {
    return { ...emptyOneApiCandidate(name), skip_reason: t('渠道未填 Key', 'The channel has no key') }
  }
  const models = String(ch.models ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
  return {
    source,
    suggest_id: `oneapi-${slugify(name)}`,
    name: `one-api · ${name}`,
    base_url: stripApiEndpoint(base),
    protocol,
    auth_style: 'bearer',
    key,
    models: models.length > 0 ? models : undefined,
    is_current: false,
  }
}

function emptyOneApiCandidate(name: string): ImportCandidate {
  return {
    source: 'oneapi',
    suggest_id: `oneapi-${slugify(name)}`,
    name: `one-api · ${name}`,
    base_url: '',
    protocol: 'openai',
    auth_style: 'bearer',
    key: null,
  }
}

export async function scanOneApi(src: OneApiImportSource): Promise<ImportCandidate[]> {
  const root = src.url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(root)) {
    throw new Error(t('one-api 地址必须以 http:// 或 https:// 开头', 'The one-api URL must start with http:// or https://'))
  }
  const token = src.token.trim().replace(/^Bearer\s+/i, '')
  if (!token) {
    throw new Error(t('管理令牌不能为空（one-api「个人设置 → 系统访问令牌」）', 'The admin token cannot be empty (one-api "Personal settings → System access token")'))
  }
  // one-api 原版按固定页大小分页（忽略 page_size），循环翻到空页为止；new-api 沿用同路由。
  // 60s 整体 deadline：50 页×15s 串行最坏 ~12min，deadline 到点抛可操作报错而不是无限拖
  const deadline = Date.now() + 60_000
  const rows: RawRow[] = []
  for (let page = 0; page < 50; page++) {
    const remaining = deadline - Date.now()
    if (remaining < 1_000) {
      throw new Error(t('one-api 拉取超时（整体超过 60 秒，站点过慢或渠道过多）', 'one-api pagination timed out (over 60s total; site too slow or too many channels)'))
    }
    let res: Response
    try {
      res = await fetch(`${root}/api/channel/?p=${page}&page_size=100`, {
        headers: { Authorization: token },
        signal: AbortSignal.timeout(Math.min(15_000, remaining)),
      })
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? t('请求超时', 'request timed out') : (e as Error).message
      throw new Error(t('无法访问 one-api 站点（{url}）：{msg}。请确认地址可达、站点为 one-api / new-api', 'Cannot reach the one-api site ({url}): {msg}. Check that the URL is reachable and the site is one-api / new-api', { url: root, msg }))
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(t('令牌无效或无管理员权限（HTTP {status}）。请在 one-api「个人设置」生成系统访问令牌后重试', 'The token is invalid or lacks admin rights (HTTP {status}). Generate a system access token under one-api "Personal settings" and retry', { status: res.status }))
    }
    if (!res.ok) {
      throw new Error(t('拉取渠道失败：HTTP {status}。请确认这是 one-api / new-api 站点', 'Failed to fetch channels: HTTP {status}. Confirm this is a one-api / new-api site', { status: res.status }))
    }
    let body: { success?: unknown; message?: unknown; data?: unknown }
    try {
      body = (await res.json()) as typeof body
    } catch {
      throw new Error(t('返回内容不是 JSON——该地址可能不是 one-api / new-api 站点', 'The response is not JSON — the URL may not be a one-api / new-api site'))
    }
    if (body.success === false) {
      throw new Error(t('one-api 返回错误：{msg}', 'one-api returned an error: {msg}', { msg: String(body.message ?? '') }))
    }
    const data = Array.isArray(body.data) ? (body.data as RawRow[]) : []
    if (data.length === 0) break
    rows.push(...data)
  }
  return rows.map(oneApiChannelToCandidate)
}

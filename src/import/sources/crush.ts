/** Crush 导入源（~/.config/crush/crush.json，providers 对象 map，type 决定上游协议） */
import path from 'node:path'
import { homeDir, readTextIfExists, slugify } from '../../util/index.js'
import { t } from '../../util/i18n.js'
import { parseJsonTolerant } from '../../adapters/format.js'
import { isLocalBaseUrl, placeholder, stripApiEndpoint, type ImportCandidate, type RawRow } from './common.js'
import type { Protocol } from '../../config/types.js'

/* ── Crush（~/.config/crush/crush.json）───────────────────────────────────────
 *  providers 是对象 map，条目 {id,name,base_url,type,api_key,models:[{id}]}；type 决定
 *  上游协议（"openai"/"anthropic" 可直连，gemini/bedrock/vertex 等原生协议暂不支持）。
 *  Catwalk 内置渠道通常不写 base_url，直接跳过。 */

export async function scanCrush(): Promise<ImportCandidate[]> {
  const p = path.join(homeDir(), '.config', 'crush', 'crush.json')
  const text = await readTextIfExists(p)
  if (text === null) return []
  const parsed = parseJsonTolerant(text)
  if (!parsed) {
    return [placeholder('crush', t('crush.json 存在但解析失败（JSON/JSONC 语法错误），无法读取', 'crush.json exists but failed to parse (JSON/JSONC syntax error); cannot read it'))]
  }
  const providers = (parsed.value as { providers?: Record<string, RawRow> }).providers
  const out: ImportCandidate[] = []
  for (const [id, prov] of Object.entries(providers ?? {})) {
    const base = typeof prov?.base_url === 'string' ? prov.base_url.trim() : ''
    if (!base || isLocalBaseUrl(base)) continue
    const type = typeof prov.type === 'string' ? prov.type : 'openai'
    const protocol: Protocol | null = type === 'openai' ? 'openai' : type === 'anthropic' ? 'anthropic' : null
    if (!protocol) {
      out.push({
        ...placeholder('crush', t('Crush 渠道「{id}」的上游类型 {type} 走非 OpenAI/Anthropic 兼容协议，暂不支持导入', 'The Crush provider "{id}" uses upstream type {type}, which is not OpenAI/Anthropic-compatible; import is not supported yet', { id, type })),
        suggest_id: `crush-${slugify(id)}`,
        name: `Crush · ${typeof prov.name === 'string' && prov.name ? prov.name : id}`,
        skip_reason: t('协议不支持', 'unsupported protocol'),
      })
      continue
    }
    const models = Array.isArray(prov.models)
      ? prov.models.map((m: unknown) => (typeof m === 'object' && m !== null && typeof (m as RawRow).id === 'string' ? (m as RawRow).id as string : typeof m === 'string' ? m : '')).filter(Boolean)
      : []
    out.push({
      source: 'crush',
      suggest_id: `crush-${slugify(id)}`,
      name: `Crush · ${typeof prov.name === 'string' && prov.name ? prov.name : id}`,
      base_url: stripApiEndpoint(base),
      protocol,
      auth_style: 'bearer',
      key: typeof prov.api_key === 'string' && prov.api_key ? prov.api_key : null,
      models: models.length > 0 ? models : undefined,
    })
  }
  return out
}

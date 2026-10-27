/** claude-code-router 导入源（~/.claude-code-router/config.json） */
import path from 'node:path'
import { homeDir, readTextIfExists, slugify } from '../../util/index.js'
import { t } from '../../util/i18n.js'
import { parseJsonTolerant } from '../../adapters/format.js'
import { hostOf, isLocalBaseUrl, placeholder, stripApiEndpoint, type ImportCandidate, type RawRow } from './common.js'
import type { Protocol } from '../../config/types.js'

/* ── claude-code-router（~/.claude-code-router/config.json）─────────────────── */

export async function scanCcr(): Promise<ImportCandidate[]> {
  const p = path.join(homeDir(), '.claude-code-router', 'config.json')
  const text = await readTextIfExists(p)
  if (text === null) return []
  const parsed = parseJsonTolerant(text)
  if (!parsed) {
    return [placeholder('ccr', t('config.json 存在但解析失败（JSON/JSONC 语法错误），无法读取', 'config.json exists but failed to parse (JSON/JSONC syntax error); cannot read it'))]
  }
  const root = parsed.value as { Providers?: RawRow[]; providers?: RawRow[]; Router?: Record<string, unknown> }
  const list = Array.isArray(root.Providers) ? root.Providers : Array.isArray(root.providers) ? root.providers : []
  const activeName = typeof root.Router?.default === 'string' ? root.Router.default.split(',')[0] : ''
  const out: ImportCandidate[] = []
  for (const prov of list) {
    const name = typeof prov.name === 'string' ? prov.name.trim() : ''
    const base = typeof prov.api_base_url === 'string' ? prov.api_base_url.trim() : ''
    if (!base || isLocalBaseUrl(base)) continue
    // 上游协议：URL 是 /v1/messages 或 transformer 声明 anthropic 才算 anthropic，其余按 openai chat 兼容
    const transformer = JSON.stringify(prov.transformer ?? '')
    const protocol: Protocol = /\/v1\/messages/i.test(base) || transformer.includes('anthropic') ? 'anthropic' : 'openai'
    out.push({
      source: 'ccr',
      suggest_id: `ccr-${slugify(name || hostOf(base))}`,
      name: `Claude Code Router · ${name || hostOf(base)}`,
      base_url: stripApiEndpoint(base),
      protocol,
      auth_style: 'bearer',
      key: typeof prov.api_key === 'string' && prov.api_key ? prov.api_key : null,
      models: Array.isArray(prov.models) ? prov.models.filter((m): m is string => typeof m === 'string') : undefined,
      is_current: !!name && activeName === name || undefined,
    })
  }
  return out
}

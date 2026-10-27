/** WorkBuddy 导入源（models.json，条目 url 是完整请求端点，同上游多模型合并为一个候选） */
import { readTextIfExists, slugify } from '../../util/index.js'
import { t } from '../../util/i18n.js'
import { modelsFileCandidates as workbuddyModelsFileCandidates } from '../../adapters/workbuddy.js'
import { parseJsonTolerant } from '../../adapters/format.js'
import { firstExisting, hostOf, isLocalBaseUrl, normalizeBaseUrl, placeholder, stripApiEndpoint, type ImportCandidate, type RawRow } from './common.js'

/* ── WorkBuddy（models.json）─────────────────────────────────────────────────
 *  条目 url 是完整请求端点（如 https://api.deepseek.com/chat/completions），剥掉端点
 *  层转 base_url；同一上游多个模型条目合并成一个候选（models 聚合）。 */

export async function scanWorkbuddy(): Promise<ImportCandidate[]> {
  const p = await firstExisting(workbuddyModelsFileCandidates())
  if (p === null) return []
  const text = await readTextIfExists(p)
  const parsed = parseJsonTolerant(text ?? '')
  if (!parsed) {
    return [placeholder('workbuddy', t('models.json 存在但解析失败（JSON 语法错误），无法读取', 'models.json exists but failed to parse (JSON syntax error); cannot read it'))]
  }
  const root = parsed.value as unknown
  const entries: RawRow[] = Array.isArray(root) ? root : Array.isArray((root as RawRow)?.models) ? ((root as RawRow).models as RawRow[]) : []
  const byUrl = new Map<string, ImportCandidate>()
  for (const e of entries) {
    const url = typeof e?.url === 'string' ? e.url.trim() : ''
    if (!url || isLocalBaseUrl(url)) continue // 指向本地网关（attach 过）的条目不收编
    const base = stripApiEndpoint(url)
    const norm = normalizeBaseUrl(base)
    const mid = typeof e?.id === 'string' && e.id ? e.id : ''
    const prev = byUrl.get(norm)
    if (prev) {
      if (mid && !prev.models?.includes(mid)) prev.models = [...(prev.models ?? []), mid]
      continue
    }
    byUrl.set(norm, {
      source: 'workbuddy',
      suggest_id: `workbuddy-${slugify(mid || hostOf(base))}`,
      name: `WorkBuddy · ${hostOf(base)}`,
      base_url: base,
      protocol: 'openai',
      auth_style: 'bearer',
      key: typeof e?.apiKey === 'string' && e.apiKey ? e.apiKey : null,
      models: mid ? [mid] : undefined,
    })
  }
  return [...byUrl.values()]
}

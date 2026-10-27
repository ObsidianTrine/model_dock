/** Gemini CLI 第三方中转导入源（~/.gemini/.env 的 GOOGLE_GEMINI_BASE_URL） */
import path from 'node:path'
import { homeDir, readTextIfExists, slugify } from '../../util/index.js'
import { t } from '../../util/i18n.js'
import { envBaseUrl, hostOf, isLocalBaseUrl, stripApiEndpoint, type ImportCandidate } from './common.js'

/* ── Gemini CLI 第三方中转（~/.gemini/.env）───────────────────────────────────
 *  官方 Google 登录不写中转变量、没有可收编的候选；配了 GOOGLE_GEMINI_BASE_URL 的
 *  一定是第三方中转站，这类站点几乎都同时提供 OpenAI 兼容端点，故按 openai 协议导入
 *  （Gemini 原生协议 ModelDock 不支持）。仅 shell 环境变量的场景也兜底读取。 */

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const m = s.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

function envApiKey(env: Record<string, unknown>): string | null {
  const v = env.GEMINI_API_KEY ?? env.GOOGLE_GEMINI_API_KEY
  return typeof v === 'string' && v ? v : null
}

export async function scanGemini(): Promise<ImportCandidate[]> {
  const envText = await readTextIfExists(path.join(homeDir(), '.gemini', '.env'))
  const env = { ...parseDotEnv(envText ?? ''), ...(process.env as Record<string, string>) }
  const base = envBaseUrl(env)
  if (!base || isLocalBaseUrl(base)) return []
  const host = hostOf(base)
  return [
    {
      source: 'gemini',
      suggest_id: `gemini-${slugify(host)}`,
      name: `Gemini CLI · ${host}`,
      base_url: stripApiEndpoint(base),
      protocol: 'openai',
      auth_style: 'bearer',
      key: envApiKey(env),
      key_note: t('来自 ~/.gemini/.env（Gemini CLI 中转配置）', 'From ~/.gemini/.env (Gemini CLI relay config)'),
      is_current: true,
    },
  ]
}

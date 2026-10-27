/** Claude Code 导入源（~/.claude/settings.json 的 env 段） */
import path from 'node:path'
import { homeDir, readTextIfExists } from '../../util/index.js'
import { t } from '../../util/i18n.js'
import { collectModelEnvs, isLocalBaseUrl, placeholder, type ImportCandidate } from './common.js'

export async function scanClaude(): Promise<ImportCandidate[]> {
  const p = path.join(homeDir(), '.claude', 'settings.json')
  const text = await readTextIfExists(p)
  if (text === null) return []
  let env: Record<string, string> = {}
  try {
    env = (JSON.parse(text) as { env?: Record<string, string> }).env ?? {}
  } catch {
    return [placeholder('claude', t('settings.json 存在但解析失败（JSON 语法错误），无法读取', 'settings.json exists but failed to parse (JSON syntax error); cannot read it'))]
  }
  const base = env.ANTHROPIC_BASE_URL
  if (!base) return []
  if (isLocalBaseUrl(base)) {
    return [
      {
        source: 'claude',
        suggest_id: 'claude-current',
        name: t('Claude Code 当前指向（本地代理）', 'Claude Code current target (local proxy)'),
        base_url: base,
        protocol: 'anthropic',
        auth_style: 'bearer',
        key: null,
        skip_reason: t('指向本地代理，真实上游请从 cc-switch 导入', 'Points to a local proxy; import the real upstream from cc-switch'),
      },
    ]
  }
  return [
    {
      source: 'claude',
      suggest_id: 'claude-direct',
      name: t('Claude Code 当前直连上游', 'Claude Code current direct upstream'),
      base_url: base,
      protocol: 'anthropic',
      auth_style: 'bearer',
      key: env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? null,
      models: collectModelEnvs(env),
      is_current: true,
    },
  ]
}

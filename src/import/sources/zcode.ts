/** ZCode 导入源（两代存储在同一函数内合并扫描：旧 ~/.zcode/v2/config.json + 现行 provider_config.json） */
import path from 'node:path'
import { homeDir, readTextIfExists, slugify } from '../../util/index.js'
import { t } from '../../util/i18n.js'
import { isLocalBaseUrl, placeholder, type ImportCandidate } from './common.js'

export async function scanZcode(): Promise<ImportCandidate[]> {
  const p = path.join(homeDir(), '.zcode', 'v2', 'config.json')
  const text = await readTextIfExists(p)
  // 两代存储各自独立扫描、结果合并：旧版 config.json 缺席不能短路掉现行 provider_config.json
  // 的扫描（早退会把只配了新版自定义供应商的用户漏成空手）
  const out: ImportCandidate[] = []
  let root: any
  try {
    root = text === null ? null : JSON.parse(text)
  } catch {
    out.push(placeholder('zcode', t('config.json 存在但解析失败（JSON 语法错误），无法读取', 'config.json exists but failed to parse (JSON syntax error); cannot read it')))
  }
  for (const [key, raw] of Object.entries<any>(root?.provider ?? {})) {
    const base = raw?.options?.baseURL ?? raw?.baseURL
    const apiKey = raw?.options?.apiKey ?? raw?.apiKey
    if (typeof base !== 'string' || base === '') continue
    if (isLocalBaseUrl(base)) continue
    if (typeof apiKey !== 'string' || apiKey === '') {
      out.push({
        source: 'zcode',
        suggest_id: `zcode-${slugify(key.replace(/^builtin:/, '').replace(/^preset:/, ''))}`,
        name: `ZCode · ${key}`,
        base_url: base,
        protocol: 'anthropic',
        auth_style: 'bearer',
        key: null,
        skip_reason: t('该 provider 没有 apiKey（可能是 oauth 登录态），ModelDock 无法收编', 'This provider has no apiKey (likely an OAuth login); ModelDock cannot import it'),
      })
      continue
    }
    out.push({
      source: 'zcode',
      suggest_id: `zcode-${slugify(key.replace(/^builtin:/, '').replace(/^preset:/, ''))}`,
      name: `ZCode · ${raw?.name ?? key}`,
      base_url: base,
      protocol: 'anthropic',
      auth_style: 'bearer',
      key: apiKey,
    })
  }
  // 现行个人供应商存储（provider_config.json）：用户在 ZCode 设置里加的自定义供应商都落这里，
  // 只扫旧版 config.json 会常年漏掉现行一代（版本漂移）。跳过 ModelDock 自己的条目与停用条目；
  // api.type 枚举 → 协议（其余按 anthropic 兜底）。与旧扫描重合的条目由 applyImport 的
  // 「地址+key」去重收敛，不会重复导入。
  const personalText = await readTextIfExists(path.join(homeDir(), '.zcode', 'v2', 'provider_config.json'))
  if (personalText) {
    let personal: any
    try {
      personal = JSON.parse(personalText)
    } catch {
      return [...out, placeholder('zcode', t('provider_config.json 存在但解析失败（JSON 语法错误），无法读取', 'provider_config.json exists but failed to parse (JSON syntax error); cannot read it'))]
    }
    const rules = personal?.config?.providerConfigRules?.providerRules
    if (Array.isArray(rules)) {
      for (const r of rules) {
        const pid = typeof r?.providerId === 'string' ? r.providerId : ''
        if (!pid || pid === 'modeldock') continue
        if (r?.enabled === false) continue
        const base = typeof r?.config?.api?.baseUrl === 'string' ? r.config.api.baseUrl : ''
        const apiKey = typeof r?.config?.access?.apiKey === 'string' ? r.config.access.apiKey : ''
        if (base === '' || isLocalBaseUrl(base)) continue
        const apiType = r?.config?.api?.type
        const protocol = apiType === 'openai-chat-completions' ? 'openai' : apiType === 'openai-responses' ? 'responses' : 'anthropic'
        const name = typeof r?.providerName === 'string' && r.providerName !== '' ? r.providerName : pid
        if (apiKey === '') {
          out.push({
            source: 'zcode',
            suggest_id: `zcode-${slugify(pid)}`,
            name: `ZCode · ${name}`,
            base_url: base,
            protocol,
            auth_style: 'bearer',
            key: null,
            skip_reason: t('该 provider 没有 apiKey（可能是 oauth 登录态），ModelDock 无法收编', 'This provider has no apiKey (likely an OAuth login); ModelDock cannot import it'),
          })
          continue
        }
        out.push({
          source: 'zcode',
          suggest_id: `zcode-${slugify(pid)}`,
          name: `ZCode · ${name}`,
          base_url: base,
          protocol,
          auth_style: 'bearer',
          key: apiKey,
        })
      }
    }
  }
  return out
}

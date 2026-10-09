import { loadConfig } from './store.js'
import { normalizeLang, setLang, t, type Lang } from '../util/i18n.js'

export const LANG_ENV = 'MODELRDOCK_LANG'

/** 从 argv 摘除 --lang <v> / --lang=<v>（任意位置生效）。
 *  --lang 不注册进 commander（子命令位置会报 unknown option），必须先摘除再把 argv 交给 commander。 */
export function extractLangArgv(argv: string[]): { rest: string[]; raw?: string } {
  const rest: string[] = []
  let raw: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--lang') {
      const v = argv[i + 1]
      if (v !== undefined && !v.startsWith('-')) {
        raw = v
        i++
      } else {
        raw = ''
      }
      continue
    }
    if (a.startsWith('--lang=')) {
      raw = a.slice('--lang='.length)
      continue
    }
    rest.push(a)
  }
  return { rest, raw }
}

function invalidLangError(v: string): Error {
  return new Error(t('无效的语言：「{v}」（支持 zh | en）', 'Invalid language "{v}" (supported: zh | en)', { v: v || '(空)' }))
}

/** 解析并设置本次进程语言，返回摘除 --lang 后的 argv（不传 argv 则不动 argv，供 daemon/GUI 用）。
 *  优先级：--lang > 环境变量 MODELRDOCK_LANG > config.toml language > zh。
 *  config 读取失败不阻断（语言保持默认），配置错误稍后由正常加载路径报出。 */
export async function initLang(argv?: string[]): Promise<string[]> {
  let rest = argv ?? []
  let raw: string | undefined
  if (argv) {
    const r = extractLangArgv(argv)
    rest = r.rest
    raw = r.raw
  }
  let lang: Lang | undefined
  if (raw !== undefined) {
    lang = normalizeLang(raw)
    if (!lang) throw invalidLangError(raw)
  }
  if (!lang) {
    const env = process.env[LANG_ENV]
    lang = normalizeLang(env)
    if (!lang && env) throw invalidLangError(env)
  }
  if (!lang) {
    try {
      lang = normalizeLang((await loadConfig()).language)
    } catch {
      /* 配置损坏：语言回落默认，错误由命令自身的 loadConfig 报出 */
    }
  }
  setLang(lang ?? 'zh')
  return rest
}

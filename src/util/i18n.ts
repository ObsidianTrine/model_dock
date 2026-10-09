import { AsyncLocalStorage } from 'node:async_hooks'

/** 轻量 i18n 内核：内联双语对 + {name} 占位插值，零依赖。
 *  与 Web 控制台 ui.ts 内嵌的浏览器端 t() 语义同构、互不相干。 */

export type Lang = 'zh' | 'en'

let current: Lang = 'zh'

/** 请求级语言（HTTP 服务用）：AsyncLocalStorage 随异步链传播，并发请求互不串扰；
 *  CLI/无上下文场景回落全局 current。 */
const als = new AsyncLocalStorage<Lang>()

/** 在指定语言上下文中执行 fn（仅服务端请求处理用；fn 内 t() 取该语言） */
export function runWithLang<T>(lang: Lang, fn: () => T): T {
  return als.run(lang, fn)
}

function currentLang(): Lang {
  return als.getStore() ?? current
}

export function setLang(lang: Lang): void {
  current = lang
}

export function getLang(): Lang {
  return currentLang()
}

/** 宽松归一化：'zh'/'zh-CN'/'zh_CN' → 'zh'，'en'/'en-US' → 'en'；识别不了返回 undefined */
export function normalizeLang(v: string | undefined | null): Lang | undefined {
  if (!v) return undefined
  const s = v.trim().toLowerCase().replace(/_/g, '-')
  if (s.startsWith('zh')) return 'zh'
  if (s.startsWith('en')) return 'en'
  return undefined
}

/** 双语值：占位符参数与拼接工具的元素，可按语言分别取值 */
export interface Bilingual {
  zh: string
  en: string
}

export type BiValue = string | number | Bilingual

function interp(s: string, params: Record<string, BiValue> | undefined, lang: Lang): string {
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, (k, name) => {
    const v = params[name]
    if (v === undefined) return k
    if (typeof v === 'string') return v
    if (typeof v === 'number') return String(v)
    return lang === 'en' ? v.en : v.zh
  })
}

/** 取双语文案：当前语言为 en 且英文非空时返回英文，否则回退中文。
 *  中文原文即 key，两参都必填，结构上不存在漏翻译的条目。 */
export function t(zh: string, en: string, params?: Record<string, BiValue>): string {
  const lang = currentLang()
  return interp(lang === 'en' && en ? en : zh, params, lang)
}

/** 同时渲染两种语言（与当前语言无关），供持久化条目双语存储（如审计日志 op/detail） */
export function bi(zh: string, en: string, params?: Record<string, BiValue>): Bilingual {
  return { zh: interp(zh, params, 'zh'), en: interp(en || zh, params, 'en') }
}

/** 双语拼接：字符串元素视为语言无关原文，Bilingual 元素各取各语言 */
export function biCat(...parts: Array<BiValue | undefined | null>): Bilingual {
  const ps = parts.filter((p): p is BiValue => p !== undefined && p !== null && p !== '')
  const pick = (lang: Lang): string =>
    ps
      .map((p) => (typeof p === 'string' ? p : typeof p === 'number' ? String(p) : lang === 'en' ? p.en : p.zh))
      .join('')
  return { zh: pick('zh'), en: pick('en') }
}

/** 双语 join：分隔符中英各一，元素同 biCat */
export function biJoin(sepZh: string, sepEn: string, parts: Array<BiValue | undefined | null>): Bilingual {
  const ps = parts.filter((p): p is BiValue => p !== undefined && p !== null && p !== '')
  const pick = (lang: Lang): string =>
    ps.map((p) => (typeof p === 'string' ? p : typeof p === 'number' ? String(p) : lang === 'en' ? p.en : p.zh)).join(lang === 'en' ? sepEn : sepZh)
  return { zh: pick('zh'), en: pick('en') }
}

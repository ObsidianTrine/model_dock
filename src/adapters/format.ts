import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml'
import { parseDocument } from 'yaml'
import { AdapterError } from './types.js'
import { t } from '../util/i18n.js'

export { tomlParse, tomlStringify }
export { parseDocument }

export function detectJsonIndent(text: string): string {
  const m = text.match(/\{\s*\n([ \t]+)"/) ?? text.match(/[:,]\s*\n([ \t]+)"/)
  return m ? m[1] : '  '
}

export function serializeJson(root: unknown, indent: string, trailingNewline: boolean): string {
  const s = JSON.stringify(root, null, indent)
  return trailingNewline ? s + '\n' : s
}

export function parseJsonStrict(text: string, file: string): Record<string, unknown> {
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new AdapterError(
      t('{file} 不是合法 JSON，已中止（未做任何改动）：{err}', '{file} is not valid JSON; aborted (nothing changed): {err}', {
        file,
        err: (e as Error).message,
      })
    )
  }
}

/** 剥掉 // 与 /* *\/ 注释（字符串字面量与转义内不动），用于 JSONC 宽容解析 */
function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += c
  }
  return out
}

/**
 * 宽容 JSON 解析：先按严格 JSON 解；失败后只做**无歧义**的 JSONC 修复（剥注释）再试一次。
 * MiMoCode 的官方推荐配置是 .jsonc，用户手写注释很常见。返回 null 表示两种方式都失败；
 * comments=true 表示原文含注释——重写为标准 JSON 时会丢，调用方必须提示（原文有快照兜底）。
 */
export function parseJsonTolerant(text: string): { value: unknown; comments: boolean } | null {
  try {
    return { value: JSON.parse(text), comments: false }
  } catch {
    /* 落到 JSONC 再试 */
  }
  const stripped = stripJsonComments(text)
  if (stripped === text) return null
  try {
    return { value: JSON.parse(stripped), comments: true }
  } catch {
    return null
  }
}

/** YAML 文档级修改：未触碰的节点连同注释一起保留 */
export function yamlSetText(doc: ReturnType<typeof parseDocument>, path: (string | number)[], value: unknown): void {
  doc.setIn(path, value)
}

export function yamlDelete(doc: ReturnType<typeof parseDocument>, path: (string | number)[]): void {
  doc.deleteIn(path)
}

/**
 * TOML 根层标量必须出现在任何 [table] 之前；重建对象时把标量提到最前，
 * 避免既有 config 中键顺序导致的序列化非法。
 */
export function reorderTomlRoot(root: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(root)) {
    if (v === null || typeof v !== 'object') out[k] = v
  }
  for (const [k, v] of Object.entries(root)) {
    if (v !== null && typeof v === 'object') out[k] = v
  }
  return out
}

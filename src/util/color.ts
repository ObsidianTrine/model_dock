import { t } from './i18n.js'
const enabled = process.stdout.isTTY && !process.env.NO_COLOR

function wrap(code: number, s: string): string {
  return enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s)
}

export const c = {
  bold: (s: string) => wrap(1, s),
  dim: (s: string) => wrap(2, s),
  red: (s: string) => wrap(31, s),
  green: (s: string) => wrap(32, s),
  yellow: (s: string) => wrap(33, s),
  blue: (s: string) => wrap(34, s),
  magenta: (s: string) => wrap(35, s),
  cyan: (s: string) => wrap(36, s),
  gray: (s: string) => wrap(90, s),
}

/** key/token 展示统一脱敏：短凭据整段隐藏（前缀+后缀对短 token 泄漏比例过高） */
export function maskSecret(v: string | null | undefined): string {
  if (!v) return t('(未设置)', '(not set)')
  if (v.length < 20) return '***'
  return `${v.slice(0, 4)}…${v.slice(-4)}`
}

/** 显示宽度：CJK/全角按 2 计（先剥 ANSI 颜色码），否则含中文的列必然错位 */
function displayWidth(s: string): number {
  const clean = s.replace(/\x1b\[[0-9;]*m/g, '')
  let w = 0
  for (const ch of clean) {
    const cp = ch.codePointAt(0) ?? 0
    w +=
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首…Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
      (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
      (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
      (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展
        ? 2
        : 1
  }
  return w
}

function padDisplay(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - displayWidth(s)))
}

/** 简单对齐表格输出 */
export function printTable(rows: Record<string, string>[], cols?: string[]): void {
  if (rows.length === 0) return
  const keys = cols ?? Object.keys(rows[0])
  const width: Record<string, number> = {}
  for (const k of keys) width[k] = Math.max(displayWidth(k), ...rows.map((r) => displayWidth(r[k] ?? '')))
  const line = (cells: string[]) => cells.map((s, i) => padDisplay(s, width[keys[i]])).join('  ')
  console.log(line(keys))
  for (const r of rows) console.log(line(keys.map((k) => r[k] ?? '')))
}

export function hint(msg: string): void {
  console.error(c.yellow(t('提示: {msg}', 'Hint: {msg}', { msg })))
}

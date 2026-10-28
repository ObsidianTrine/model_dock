#!/usr/bin/env node
/**
 * i18n 审计：把「用户可见文案必须走 t() 双语」的工程约定变成一条命令可验证的约束。
 *
 * 扫描 src/**\/*.ts，启发式找出疑似硬编码用户可见文案：含 CJK 字符的字符串/模板字面量，
 * 且不在 t()/bi()/biCat()/biJoin() 调用实参内、不是 { zh: .., en: .. } 双语对的成员。
 * 注释内的 CJK 天然不算（词法层已剥离）；每个发现标注出现位置（console/stdio/throw/error/return/其他）。
 * 模板字面量按静态段判定（${} 表达式内的字符串另行独立审计，`..${t('中文',..)}..` 不算硬编码）。
 *
 * 排除范围：src/gateway/ui.ts、ui-minified.ts、ui/ 目录、lan.ts、lanAssets.ts，
 * 以及同为「内嵌页体」的 console-shared.ts（两页共用的浏览器端 JS 片段，trT 由注入页提供）与
 * cloud/console.ts（云端控制台页）——浏览器端 data-i18n 机制（与 src/util/i18n.ts 语义同构、
 * 互不相干）独立存在，另立卡处理。
 *
 * 白名单（特例必须写理由，两种形式）：
 *   1. 行内标注：违规行（或紧邻的上一行）写  // i18n-audit:ignore <理由>  ——随代码走，推荐；
 *      理由为空视为无效标注，仍按违规报告。
 *   2. 脚本段 WHITELIST：文件（支持 dir/** 前缀）+ 可选行号（按字符串起始行匹配） + reason
 *      ——整文件数据类豁免等。
 *
 * 用法：node scripts/i18n-audit.mjs
 *   退出码 0 = 无违规；1 = 有违规（含疑似，逐条人工复核后修 t() 或补白名单）。
 * 不在 vitest 套件内、不接 CI 门禁——人工可复跑的回归工具。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

/** 内嵌页体：浏览器端 data-i18n / 页面注入 trT 机制独立存在，不参与本审计（另立卡处理） */
const EXCLUDE = [
  'src/gateway/ui.ts',
  'src/gateway/ui-minified.ts',
  'src/gateway/ui/',
  'src/gateway/lan.ts',
  'src/gateway/lanAssets.ts',
  'src/gateway/console-shared.ts',
  'src/cloud/console.ts'
]

/** 双语助手：实参内的字符串视为已走 t() 机制 */
const HELPERS = new Set(['t', 'bi', 'biCat', 'biJoin'])

/** CJK 判定：汉字 + 假名 + CJK 标点/全角符号（文案常含「」、（）等） */
const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/

/**
 * 脚本段白名单。file 支持精确路径与 `dir/**` 前缀；line 省略 = 整文件。
 * reason 必填——这里是「为什么不走 t()」的可追溯理由（枚举值/写进客户端配置/被程序比较等）。
 */
const WHITELIST = [
  {
    file: 'src/install/noderuntime.ts',
    line: 28,
    reason: '写入 shell rc 文件的 PATH 行标记（RC_PATH_MARK）：须跨语言稳定，才能按标记定位/撤销 PATH 行；属写进客户端配置的字符串，非界面文案'
  },
  {
    file: 'src/install/noderuntime.ts',
    line: 294,
    reason: '写入 shell rc 文件的整行（含「删除本行即撤销」自述注释）：机器配置文件自带说明，走 t() 会随语言变化破坏标记稳定性；双语提示已由安装输出的 t() 文案覆盖'
  },
  {
    file: 'src/import/sources/cc-switch.ts',
    line: 163,
    reason: '导入源生成的 provider 显示名（写进用户配置的数据值，非界面文案）；「cc-switch · 名称（Gemini）」为来源标识惯例，双语化属数据模型改动'
  },
  {
    file: 'src/presets/data.ts',
    line: 134,
    reason: '内置预设模型展示名（写进 provider 配置的数据值，非界面文案）；「DeepSeek Flash（V4.1）」为版本标识'
  },
  {
    file: 'src/presets/data.ts',
    line: 149,
    reason: '内置预设模型展示名（写进 provider 配置的数据值，非界面文案）；同 presets/data.ts:134'
  },
  {
    file: 'src/update/notes.ts',
    line: 115,
    reason: '正则字面量的 CJK 标点属匹配字符类（匹配中英文括号包裹的 URL），非文案'
  },
  {
    file: 'src/update/notes.ts',
    line: 128,
    reason: '截断断点搜索的标点字符集（，、；：）)），属处理逻辑参数，非文案'
  },
  {
    file: 'src/autostart.ts',
    line: 292,
    reason: '生成进 systemd unit 文件的文件头注释：机器配置文件自带说明，非界面文案'
  }
]

const IGNORE_RE = /i18n-audit:\s*ignore\s*(.*)$/

// ---------------------------------------------------------------- 词法扫描

/**
 * 轻量 TS 词法：剥离注释，产出 string/template 与标识符、标点 token。
 * 模板字面量按静态段判定 CJK（cjkStatic 字段）；${} 表达式递归词法化——
 * 表达式里的字符串/模板/调用作为独立 token 参与 t() 区间豁免，
 * `..${t('中文', ..)}..` 这类模板不会被误判为硬编码文案。
 */
function tokenize(src) {
  const tokens = []
  const n = src.length
  let i = 0
  let line = 1

  const scanString = (quote) => {
    const start = i
    const startLine = line
    i++
    while (i < n) {
      const ch = src[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === quote) { i++; break }
      if (ch === '\n') line++
      i++
    }
    tokens.push({ type: 'string', start, end: i, startLine, text: src.slice(start, i) })
  }

  const scanRegex = () => {
    const start = i
    const startLine = line
    i++
    let inClass = false
    while (i < n) {
      const ch = src[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === '[') inClass = true
      if (ch === ']') inClass = false
      if (ch === '/' && !inClass) { i++; break }
      if (ch === '\n') { line++; i++; continue }
      i++
    }
    while (i < n && /[a-z]/i.test(src[i])) i++ // flags
    tokens.push({ type: 'regex', start, end: i, startLine, text: src.slice(start, i) })
  }

  const skipLineComment = () => {
    const start = i
    i += 2
    while (i < n && src[i] !== '\n') i++
    tokens.push({ type: 'comment', start, end: i, startLine: line, text: src.slice(start, i) })
  }

  const skipBlockComment = () => {
    const start = i
    const startLine = line
    i += 2
    while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
      if (src[i] === '\n') line++
      i++
    }
    i = Math.min(n, i + 2)
    tokens.push({ type: 'comment', start, end: i, startLine, text: src.slice(start, i) })
  }

  /** 模板字面量（src[i] === '`'）：静态段逐字符记 CJK；${} 内递归词法化，嵌套串独立成 token */
  const scanTemplate = () => {
    const start = i
    const startLine = line
    let cjkStatic = false
    i++
    for (;;) {
      if (i >= n) break // 未闭合：吞到文件尾
      const ch = src[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === '`') { i++; break }
      if (ch === '\n') { line++; i++; continue }
      if (ch === '$' && src[i + 1] === '{') {
        i += 2
        let depth = 1
        while (i < n && depth > 0) {
          const e = src[i]
          if (e === '{') {
            tokens.push({ type: 'punct', start: i, end: i + 1, startLine: line, text: e })
            depth++
            i++
          } else if (e === '}') {
            depth--
            i++
            if (depth > 0) tokens.push({ type: 'punct', start: i - 1, end: i, startLine: line, text: '}' })
          } else if (e === "'" || e === '"') {
            scanString(e)
          } else if (e === '`') {
            scanTemplate()
          } else if (e === '/' && src[i + 1] === '/') {
            i += 2
            while (i < n && src[i] !== '\n') i++
          } else if (e === '/' && src[i + 1] === '*') {
            i += 2
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
              if (src[i] === '\n') line++
              i++
            }
            i = Math.min(n, i + 2)
          } else if (e === '/' && isRegexStart(src, i)) {
            scanRegex()
          } else if (/[A-Za-z_$]/.test(e)) {
            const s = i
            while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++
            tokens.push({ type: 'ident', start: s, end: i, startLine: line, text: src.slice(s, i) })
          } else if (/[0-9]/.test(e)) {
            const s = i
            while (i < n && /[0-9a-fA-FxXoObB_.]/.test(src[i])) i++
            tokens.push({ type: 'num', start: s, end: i, startLine: line, text: src.slice(s, i) })
          } else {
            if (e === '\n') line++
            tokens.push({ type: 'punct', start: i, end: i + 1, startLine: line, text: e })
            i++
          }
        }
        continue
      }
      if (CJK_RE.test(ch)) cjkStatic = true
      i++
    }
    tokens.push({ type: 'template', start, end: i, startLine, text: src.slice(start, i), cjkStatic })
  }

  while (i < n) {
    const c = src[i]
    if (c === '\n') { line++; i++; continue }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue }

    // 行注释 / 块注释
    if (c === '/' && src[i + 1] === '/') { skipLineComment(); continue }
    if (c === '/' && src[i + 1] === '*') { skipBlockComment(); continue }
    // 字符串 / 模板字面量
    if (c === "'" || c === '"') { scanString(c); continue }
    if (c === '`') { scanTemplate(); continue }
    // 正则字面量（启发式：前一字符可结束表达式时视为除号/注释已处理）
    if (c === '/' && isRegexStart(src, i)) { scanRegex(); continue }
    // 标识符/关键字
    if (/[A-Za-z_$]/.test(c)) {
      const start = i
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++
      tokens.push({ type: 'ident', start, end: i, startLine: line, text: src.slice(start, i) })
      continue
    }
    // 数字
    if (/[0-9]/.test(c)) {
      const start = i
      while (i < n && /[0-9a-fA-FxXoObB_.]/.test(src[i])) i++
      tokens.push({ type: 'num', start, end: i, startLine: line, text: src.slice(start, i) })
      continue
    }
    // 标点与其他
    tokens.push({ type: 'punct', start: i, end: i + 1, startLine: line, text: c })
    i++
  }
  return tokens
}

/** 正则字面量启发：前一个非空白字符可结束表达式（标识符/数字/)]/引号尾）则视为除号；
 *  跨行情况（上一非空白字符在上一行）只可能是正则——除号不能跨行（ASI 会断句）。 */
function isRegexStart(src, i) {
  let j = i - 1
  while (j >= 0 && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r')) j--
  if (j < 0) return true
  if (src[j] === '\n') return true
  return !/[A-Za-z0-9_$)\]'"`]/.test(src[j])
}

// ---------------------------------------------------------------- 结构分析

/** 收集所有函数调用 span（dotted 名 + 实参区间 [open, close]） */
function findCallSpans(tokens) {
  const spans = []
  for (let k = 0; k < tokens.length - 1; k++) {
    const tok = tokens[k]
    if (tok.type !== 'ident') continue
    const nxt = tokens[k + 1]
    if (nxt.type !== 'punct' || nxt.text !== '(') continue
    let name = tok.text
    let j = k - 1
    while (j >= 1 && tokens[j].type === 'punct' && tokens[j].text === '.' && tokens[j - 1].type === 'ident') {
      name = tokens[j - 1].text + '.' + name
      j -= 2
    }
    let depth = 0
    let close = -1
    for (let m = k + 1; m < tokens.length; m++) {
      const t2 = tokens[m]
      if (t2.type !== 'punct') continue
      if (t2.text === '(') depth++
      else if (t2.text === ')') { depth--; if (depth === 0) { close = m; break } }
    }
    if (close > k + 1) spans.push({ name, open: k + 1, close })
  }
  return spans
}

/** 判定违规 token 的出现位置（仅用于报告归类） */
function classify(tokens, k, spans) {
  for (const s of spans) {
    if (s.open <= k && k <= s.close) {
      if (s.name.startsWith('console.')) return 'console'
      if (s.name === 'Error') return 'error'
      if (s.name.endsWith('.write')) return 'stdio'
      return 'call:' + s.name
    }
  }
  for (let j = k - 1; j >= Math.max(0, k - 6); j--) {
    const t2 = tokens[j]
    if (t2.type === 'ident' && t2.text === 'return') return 'return'
    if (t2.type === 'ident' && t2.text === 'throw') return 'throw'
    if (t2.type === 'punct' && (t2.text === ';' || t2.text === '}' || t2.text === '{')) break
  }
  return '其他'
}

// ---------------------------------------------------------------- 主流程

function listTsFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) listTsFiles(full, out)
    else if (ent.name.endsWith('.ts')) out.push(full)
  }
  return out
}

function rel(file) {
  return file.slice(ROOT.length + 1).split('\\').join('/')
}

function isExcluded(relPath) {
  return EXCLUDE.some((e) => (e.endsWith('/') ? relPath.startsWith(e) : relPath === e))
}

function matchFile(pattern, file) {
  if (pattern === file) return true
  if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -3))
  if (pattern.endsWith('*')) return file.startsWith(pattern.slice(0, -1))
  return false
}

/** 文案摘要：去引号、压缩空白、截断 */
function summarize(text, max = 64) {
  let s = text
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')) || (s.startsWith('`') && s.endsWith('`'))) {
    s = s.slice(1, -1)
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

function auditFile(file) {
  const relPath = rel(file)
  const src = readFileSync(file, 'utf8')
  const tokens = tokenize(src)
  const spans = findCallSpans(tokens)

  // 行内豁免标注：本行或上一行的 // i18n-audit:ignore <理由>
  const ignoreLines = new Map()
  for (const tok of tokens) {
    if (tok.type !== 'comment' || !tok.text.startsWith('//')) continue
    const m = IGNORE_RE.exec(tok.text)
    if (m) ignoreLines.set(tok.startLine, m[1].trim())
  }
  // 脚本段白名单（文件级 / 文件+行）
  const wlFile = WHITELIST.filter((w) => matchFile(w.file, relPath))

  const violations = []
  const exempted = []
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]
    if (tok.type !== 'string' && tok.type !== 'template') continue
    // 模板按静态段判定：${} 表达式内的 CJK 由其内部字符串 token 独立审计
    if (tok.type === 'template' ? !tok.cjkStatic : !CJK_RE.test(tok.text)) continue
    // 双语助手实参内 → 豁免
    if (spans.some((s) => s.open <= k && k <= s.close && HELPERS.has(s.name))) continue
    // { zh: '..', en: '..' } 双语对成员 → 豁免
    if (
      k >= 2 &&
      tokens[k - 1].type === 'punct' && tokens[k - 1].text === ':' &&
      tokens[k - 2].type === 'ident' && (tokens[k - 2].text === 'zh' || tokens[k - 2].text === 'en')
    ) {
      continue
    }
    // 行内标注豁免（须有理由）
    const line = tok.startLine
    const igReason = ignoreLines.get(line) ?? ignoreLines.get(line - 1)
    if (igReason !== undefined) {
      if (igReason) exempted.push({ relPath, line, reason: igReason })
      else violations.push({ relPath, line, kind: '其他', text: tok.text, note: '行内豁免缺少理由（i18n-audit:ignore 后必须写原因）' })
      continue
    }
    // 脚本段白名单（整文件，或行号匹配；行号按字符串起始行）
    const wl = wlFile.find((w) => w.line === undefined || w.line === line)
    if (wl) {
      exempted.push({ relPath, line, reason: wl.reason })
      continue
    }
    violations.push({ relPath, line, kind: classify(tokens, k, spans), text: tok.text })
  }
  return { relPath, violations, exempted }
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      [
        '用法：node scripts/i18n-audit.mjs',
        '',
        '扫描 src/**/*.ts 中含 CJK 且未走 t()/bi()/biCat()/biJoin() 的字符串/模板字面量',
        '（排除 src/gateway/ui* 与 lan* 等内嵌页体——浏览器端 data-i18n 机制独立，另立卡）。',
        '',
        '豁免方式（必须写理由）：',
        '  行内：违规行或上一行写  // i18n-audit:ignore <理由>',
        '  脚本段：本文件顶部 WHITELIST 数组（文件/文件+行 + reason）',
        '',
        '退出码：0 = 无违规；1 = 有违规（逐条复核后改走 t() 或补白名单）。'
      ].join('\n')
    )
    return
  }

  const files = listTsFiles(SRC).filter((f) => !isExcluded(rel(f)))
  const results = files.map(auditFile)
  const allViolations = results.flatMap((r) => r.violations)
  const allExempted = results.flatMap((r) => r.exempted)

  console.log(`i18n 审计：${files.length} 个文件，发现 ${allViolations.length} 处疑似硬编码文案，白名单豁免 ${allExempted.length} 处\n`)

  if (allViolations.length) {
    let cur = ''
    for (const v of allViolations) {
      if (v.relPath !== cur) {
        console.log(`\n${v.relPath}`)
        cur = v.relPath
      }
      console.log(`  L${v.line} [${v.kind}] ${summarize(v.text)}`)
      if (v.note) console.log(`       ↳ ${v.note}`)
    }
    console.log('\n修复：用户可见文案改走 t(\'中文\', \'English\')；确属不该走 t() 的加白名单并注明理由。')
  }

  if (allExempted.length) {
    console.log('白名单豁免明细：')
    for (const e of allExempted) console.log(`  ${e.relPath}:${e.line}  — ${e.reason}`)
    console.log('')
  }

  // 白名单条目卫生：报了没命中的（行号漂移/路径写错），提醒清理
  const stale = WHITELIST.filter((w) => {
    const hits = allExempted.filter((e) => (w.line === undefined ? e.relPath === w.file : e.relPath === w.file && e.line === w.line))
    return hits.length === 0
  })
  if (stale.length) {
    console.log('注意：以下脚本段白名单条目未命中任何豁免（行号漂移或路径有误，可清理）：')
    for (const w of stale) console.log(`  ${w.file}${w.line ? ':' + w.line : ''}`)
    console.log('')
  }

  process.exitCode = allViolations.length ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}

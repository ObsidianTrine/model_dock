// UI 内联 JS 最小化产物生成（PERF-25 Phase 2，T4 拆分的发布构建链配套）。
// 用法：node scripts/gen-ui-min.mjs            # 重新生成 src/gateway/ui-minified.ts
//       node scripts/gen-ui-min.mjs --check    # 只对拍（CI/freshness 测试同款逻辑），漂移退出码 1
//
// 原理：src/gateway/ui/ 各域模块是「模板字面量源文本」（ui.ts 按原次序拼装）。本脚本按 ui.ts
// 拼装次序抽出各片段源文本 + 解析 console-shared.ts 的共用片段，合成完整内联脚本后交给
// esbuild minify（正规最小化——known-issues PERF-25 结论：裸正则剥注释会剥坏字符串字面量，
// 必须走正规最小化），产物以 TS 模板字面量转义后落盘 src/gateway/ui-minified.ts。
// ui.ts 运行时改为引用 UI_JS_MIN；源片段模块保留不动（维护面 + ui-lint 扫描面）。
// 源片段或 console-shared 变更后必须重跑本脚本——test/ui-min-fresh.test.ts 会兜底对拍。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 从「export const NAME = `...`」形态的 TS 模块里抽出字面量源文本（不含首尾反引号）。
 *  终止反引号按转义感知扫描（前缀反斜杠数为偶数才是真结束），兼容行首/行尾两种收尾格式。 */
function extractConst(src, name) {
  const open = src.indexOf(`export const ${name} = \``)
  if (open < 0) throw new Error(`gen-ui-min: 未找到 ${name}`)
  const start = open + `export const ${name} = \``.length
  for (let i = start; i < src.length; i++) {
    if (src[i] !== '`') continue
    let slashes = 0
    for (let j = i - 1; j >= 0 && src[j] === '\\'; j--) slashes++
    if (slashes % 2 === 0) return src.slice(start, i)
  }
  throw new Error(`gen-ui-min: ${name} 缺少结束反引号`)
}

/** TS 模板字面量转义：反斜杠、反引号、${ 三类，其余原样（体积优先，不做 unicode 转义） */
function escapeForTemplate(s) {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

/** 模板字面量源文本 → 求值后的值：交给 JS 自身语义处理转义（\\、\`、\$、\n…）与插值，
 *  避免手写 unescape 漏掉冷门转义序列。构建期执行自有源码，等价于 ui.ts 运行时的字面量求值。 */
function evalFragment(source, sharedValue) {
  return new Function('CONSOLE_SHARED_JS', 'return `' + source + '`')(sharedValue)
}

export function generateUiMin() {
  // 拼装次序 = T04 拆分的固定域次序（ui.ts 现在只引用 UI_JS_MIN 单一产物，次序知识收敛于此）。
  // 对拍纪律：ui/ 目录里每发现一个 UI_JS_* 常量都必须出现在 ORDER 中（新增片段漏登记会在这里红灯，
  // 防止新片段静默不进服务页面）。
  const ORDER = [
    'UI_JS_KIT',
    'UI_JS_MODALS',
    'UI_JS_WIRING',
    'UI_JS_I18N',
    'UI_JS_SHARED',
    'UI_JS_APP',
    'UI_JS_OVERVIEW',
    'UI_JS_UPDATE',
    'UI_JS_AUTOROUTE',
    'UI_JS_SERVICES',
    'UI_JS_SCHED_STATE',
    'UI_JS_CONFIGPACK',
    'UI_JS_SCHEDULE',
    'UI_JS_CLIENTS',
    'UI_JS_EDIT',
    'UI_JS_LOGS',
    'UI_JS_BOOT',
  ]
  const dir = path.join(ROOT, 'src', 'gateway', 'ui')
  const sharedSrc = fs.readFileSync(path.join(ROOT, 'src', 'gateway', 'console-shared.ts'), 'utf8').replace(/\r\n/g, '\n')
  const sharedValue = evalFragment(extractConst(sharedSrc, 'CONSOLE_SHARED_JS'), '')
  const discovered = new Set()
  // 目录内容循环外读一次建 Map（插入序 = readdir 序，ORDER 命中语义不变）：原先 ORDER 每条目
  // readdir + 全目录逐文件读是 O(n²)，且本脚本在每次 npm test 的 freshness 对拍里跑
  const moduleSrc = new Map(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n')])
  )
  let script = ''
  for (const name of ORDER) {
    const hit = [...moduleSrc].find(([, src]) => src.includes(`export const ${name} = \``))
    if (!hit) throw new Error(`gen-ui-min: 常量 ${name} 不在 ui/ 任何模块中`)
    discovered.add(name)
    script += evalFragment(extractConst(hit[1], name), sharedValue)
  }
  for (const [f, src] of moduleSrc) {
    for (const m of src.matchAll(/export const (UI_JS_[A-Z0-9_]+) = `/g)) {
      if (!discovered.has(m[1])) throw new Error(`gen-ui-min: ui/${f} 的 ${m[1]} 未登记进 ORDER——请补进顺序表，否则该片段不会进服务页面`)
    }
  }
  // ui.ts 必须保持「引用最小化产物」形态（防止有人切回源片段直服、最小化失效）
  const shell = fs.readFileSync(path.join(ROOT, 'src', 'gateway', 'ui.ts'), 'utf8').replace(/\r\n/g, '\n')
  if (!shell.includes('${UI_JS_MIN}') || /\$\{UI_JS_(?!MIN\})[A-Z0-9_]+\}/.test(shell)) {
    throw new Error('gen-ui-min: ui.ts 未引用 ${UI_JS_MIN}（或仍残留源片段插值）——请先完成 Phase 2 形态切换')
  }
  // esbuild 正规最小化（devDependency，build-sea 同款动态 import）
  return import('esbuild').then((esbuild) =>
    esbuild.transformSync(script, { minify: true, target: ['es2020'], loader: 'js', legalComments: 'none' }).code
  )
}

export async function buildModuleContent() {
  const min = await generateUiMin()
  const header = [
    '/**',
    ' * Web 控制台 · 内联 JS 最小化产物（PERF-25 Phase 2）——由 scripts/gen-ui-min.mjs 生成，勿手改。',
    ' * 源片段在 src/gateway/ui/ 各域模块；源变更后重跑 `node scripts/gen-ui-min.mjs`，',
    ' * test/ui-min-fresh.test.ts 会对拍兜底。JSON 语义的模板转义：反斜杠/反引号/${ 均已转义。',
    ' */',
    'export const UI_JS_MIN = `',
  ].join('\n')
  return `${header}${escapeForTemplate(min)}\`\n`
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const outPath = path.join(ROOT, 'src', 'gateway', 'ui-minified.ts')
  const content = await buildModuleContent()
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n') : ''
    if (cur !== content) {
      console.error('gen-ui-min --check: ui-minified.ts 与重新生成结果不一致（源片段已变更？）——重跑 node scripts/gen-ui-min.mjs')
      process.exit(1)
    }
    console.log('gen-ui-min --check: up to date')
  } else {
    fs.writeFileSync(outPath, content)
    const min = (content.match(/export const UI_JS_MIN = `/) ?? [null])[0] ? 'ok' : 'broken'
    console.log(`gen-ui-min: wrote src/gateway/ui-minified.ts (${Buffer.byteLength(content)} bytes, ${min})`)
  }
}

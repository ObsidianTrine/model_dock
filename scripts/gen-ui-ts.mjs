// Web 控制台「真 TS 通道」构建脚本（S-03）。
// 用法：node scripts/gen-ui-ts.mjs            # 重新生成 src/gateway/ui-ts-bundled.ts
//       node scripts/gen-ui-ts.mjs --check    # 只对拍（freshness 测试同款逻辑），漂移退出码 1
//
// 原理：src/gateway/ui/ts/ 是真 TypeScript 源码（受 tsconfig 与 ESLint 检查），以 src 目录
// 内的模块方式 import 宿主类型与彼此。本脚本以 ts/entry.ts 为入口交给 esbuild 打成 IIFE
// （globalName __MDUI_TS）、按 esbuild 正规最小化，再按产物 metafile 的 exports 追加
// `var <name> = __MDUI_TS.<name>` 别名——bundle 注入在既有内联脚本之后的独立 <script>
// （见 src/gateway/ui.ts），于全局作用域运行；别名让既有调用点零改动。
//
// 输出形态与 src/gateway/ui-minified.ts 一致：TS 模板字面量常量 + 「由脚本生成、勿手改」头注。
// 源或 entry 导出变更后必须重跑本脚本——test/ui-ts-bundle-fresh.test.ts 会兜底对拍。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = path.join(ROOT, 'src', 'gateway', 'ui', 'ts', 'entry.ts')

/** TS 模板字面量转义：反斜杠、反引号、${ 三类，其余原样（与 gen-ui-min 同款语义） */
function escapeForTemplate(s) {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

export async function generateUiTsBundle() {
  const esbuild = await import('esbuild')
  // 扫描构建（esm 形态）只为拿到可靠的导出名：IIFE 产物的 metafile.exports 恒为空，
  // 而别名表必须与 entry 的导出逐一对齐（新增导出漏登记 = 页面调用点静默悬空）。
  const scan = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
    outfile: 'ui-ts-scan.js',
  })
  const scanKey = Object.keys(scan.metafile.outputs).find((k) => k.endsWith('.js'))
  if (!scanKey) throw new Error('gen-ui-ts: 扫描构建未产出 JS 文件')
  const exported = (scan.metafile.outputs[scanKey].exports ?? []).slice().sort()
  if (!exported.length) throw new Error('gen-ui-ts: entry 未导出任何符号——别名表为空会让页面调用点全部悬空')
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    globalName: '__MDUI_TS',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
    outfile: 'ui-ts-bundle.js',
  })
  // 既有内联脚本按裸名调用这些函数；别名必须与导出名一致（不允许重命名）。
  // bundle 运行在独立 <script> 的全局作用域（页面拼装在 src/gateway/ui.ts），宿主闭包内符号
  // 经 window.__MDUI_HOST__ 桥接：函数按名绑定到包装函数局部，view/liveUsage/LANG 由模块侧
  // 走 host.view()/host.liveUsage()/host.lang() 取实时值。
  const deps = ['esc', 't', 'createModal', 'fmtTok', 'fmtUsd']
  const binds = deps.map((d) => `  var ${d} = host.${d}`).join('\n')
  const aliases = exported.map((name) => `var ${name} = __MDUI_TS__.${name}`).join('\n')
  const code = result.outputFiles[0].text.trimEnd()
  return [
    'var __MDUI_TS__ = (function (host) {',
    binds,
    code,
    '  return __MDUI_TS',
    '})(globalThis.__MDUI_HOST__)',
    aliases,
  ].join('\n')
}

export async function buildBundleContent() {
  const bundle = await generateUiTsBundle()
  const header = [
    '/**',
    ' * Web 控制台 · 真 TS 通道 bundle（S-03）——由 scripts/gen-ui-ts.mjs 生成，勿手改。',
    ' * 源：src/gateway/ui/ts/**（受 tsconfig 与 ESLint 检查）；源变更后重跑 `npm run gen:ui-ts`，',
    ' * test/ui-ts-bundle-fresh.test.ts 会对拍兜底。JSON 语义的模板转义：反斜杠/反引号/${ 均已转义。',
    ' * 注入点：src/gateway/ui.ts 里既有 UI_JS_MIN 之后的独立 <script>，全局作用域运行',
    ' * （宿主闭包内符号经 window.__MDUI_HOST__ 桥接，见 UI_JS_BOOT 尾部装配与 ui/ts/host.ts）。',
    ' */',
    'export const UI_TS_BUNDLE = `',
  ].join('\n')
  return `${header}${escapeForTemplate(bundle)}\`\n`
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const outPath = path.join(ROOT, 'src', 'gateway', 'ui-ts-bundled.ts')
  const content = await buildBundleContent()
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n') : ''
    if (cur !== content) {
      console.error('gen-ui-ts --check: ui-ts-bundled.ts 与重新生成结果不一致（ts/ 源已变更？）——重跑 node scripts/gen-ui-ts.mjs')
      process.exit(1)
    }
    console.log('gen-ui-ts --check: up to date')
  } else {
    fs.writeFileSync(outPath, content)
    console.log(`gen-ui-ts: wrote src/gateway/ui-ts-bundled.ts (${Buffer.byteLength(content)} bytes)`)
  }
}

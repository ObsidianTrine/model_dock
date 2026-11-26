/**
 * Web 控制台 · 真 TS 通道打包入口（S-03）。
 *
 * 只 re-export 需要被既有内联脚本引用的符号：scripts/gen-ui-ts.mjs 用 esbuild 打包后，
 * 按产物 metafile 的 exports 追加 `var <name> = __MDUI_TS.<name>` 别名，使既有调用点
 * （services.ts 的 usageBadgeSlotHtml、overview.ts/services.ts 的 updateSvcUsage）保持原样。
 *
 * 新增模块：在本文件加一行 export，并在 scripts/gen-ui-ts.mjs 的文档注释里登记用途。
 */
export { usageBadgeSlotHtml, updateSvcUsage } from './usage.js'

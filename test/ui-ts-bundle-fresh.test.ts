import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildBundleContent } from '../scripts/gen-ui-ts.mjs'
import { UI_HTML } from '../src/gateway/ui.js'
import { UI_JS_MIN } from '../src/gateway/ui-minified.js'
import { UI_TS_BUNDLE } from '../src/gateway/ui-ts-bundled.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// S-03 真 TS 通道防漂移：src/gateway/ui/ts/** 源变更后必须重跑 `npm run gen:ui-ts`，
// 否则服务出去的 bundle 就是旧的。此处复用生成器同款逻辑对拍（--check 等价）。
describe('ui-ts-bundled.ts freshness（对拍防漂移）', () => {
  it('重新生成结果与提交产物逐字节一致（LF 归一）', async () => {
    const committed = readFileSync(path.join(ROOT, 'src', 'gateway', 'ui-ts-bundled.ts'), 'utf8').replace(/\r\n/g, '\n')
    const regenerated = await buildBundleContent()
    expect(regenerated).toBe(committed)
  })

  it('UI_HTML 引用 bundle：全文在场，且位于最小化脚本（UI_JS_MIN）之后', () => {
    const head = UI_TS_BUNDLE.slice(0, 200)
    expect(UI_HTML).toContain(head)
    const minPos = UI_HTML.indexOf(UI_JS_MIN.slice(0, 200))
    const tsPos = UI_HTML.indexOf(head)
    expect(minPos).toBeGreaterThan(-1)
    expect(tsPos).toBeGreaterThan(minPos)
  })

  it('别名表与 entry 导出对齐（别名缺失 = 页面调用点静默悬空）', () => {
    expect(UI_TS_BUNDLE).toMatch(/var usageBadgeSlotHtml = __MDUI_TS__\.usageBadgeSlotHtml/)
    expect(UI_TS_BUNDLE).toMatch(/var updateSvcUsage = __MDUI_TS__\.updateSvcUsage/)
  })

  it('bundle 非空且显著小于源片段（真有压缩效果，防止 gen 退化成透传）', () => {
    const src = readFileSync(path.join(ROOT, 'src', 'gateway', 'ui', 'ts', 'usage.ts'), 'utf8')
    const bundleLen = UI_TS_BUNDLE.length - 'export const UI_TS_BUNDLE = `'.length - 2
    expect(bundleLen).toBeGreaterThan(0)
    expect(bundleLen).toBeLessThan(src.length)
  })
})

import fs, { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildModuleContent } from '../scripts/gen-ui-min.mjs'
import { UI_HTML } from '../src/gateway/ui.js'
import { UI_JS_MIN } from '../src/gateway/ui-minified.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// PERF-25 Phase 2 防漂移：ui/ 源片段或 console-shared 变更后必须重跑 scripts/gen-ui-min.mjs，
// 否则服务出去的最小化脚本就是旧的。此处复用生成器同款逻辑对拍（--check 等价）。
describe('ui-minified.ts freshness（对拍防漂移）', () => {
  it('重新生成结果与提交产物逐字节一致（LF 归一）', async () => {
    const committed = readFileSync(path.join(ROOT, 'src', 'gateway', 'ui-minified.ts'), 'utf8').replace(/\r\n/g, '\n')
    const regenerated = await buildModuleContent()
    expect(regenerated).toBe(committed)
  })

  it('UI_HTML 实际引用最小化产物：包含 UI_JS_MIN 全文、无残留 UI_JS_* 源片段插值', () => {
    expect(UI_HTML).toContain(UI_JS_MIN.slice(0, 200))
    expect(UI_HTML).not.toMatch(/\$\{UI_JS_[A-Z_]+\}/)
  })

  it('最小化产物非空且显著小于源片段（真有压缩效果，防止 gen 退化成透传）', () => {
    // 源片段总体积（ui/ 目录全部 JS 片段源文本）
    const dir = path.join(ROOT, 'src', 'gateway', 'ui')
    const srcBytes = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0)
    expect(Buffer.byteLength(UI_JS_MIN)).toBeGreaterThan(10_000) // 不是空产物
    expect(Buffer.byteLength(UI_JS_MIN)).toBeLessThan(srcBytes) // 真压缩了
  })
})

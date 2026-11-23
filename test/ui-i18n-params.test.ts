import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UI_JS_I18N } from '../src/gateway/ui/i18n.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 浏览器端 t() 片段层求值（merge-preview-wide-modal 扩权验收锚）：片段顶层引用 localStorage，
// node 无此全局不能整段求值——只抽 t() 函数体、LANG 以参数注入（与浏览器闭包同形）。
// 行为锚 = util/i18n.ts interp 同款语义：占位符插值必须在产物真实生效，而非仅 grep 传参形态。
function makeT(lang: string): (zh: string, en: string, params?: Record<string, unknown>) => string {
  const start = UI_JS_I18N.indexOf('function t(')
  const end = UI_JS_I18N.indexOf('function i18nPick')
  expect(start, '片段内未找到 t() 定义').toBeGreaterThan(0)
  expect(end, '片段内未找到 t() 后边界').toBeGreaterThan(start)
  return new Function('LANG', UI_JS_I18N.slice(start, end) + '\nreturn t')(lang)
}

describe('浏览器端 t() 第三参插值（util/i18n.ts interp 同款）', () => {
  it('number → String()；string → 原样；Bilingual → 按当前语言取（验收锚：t(…,{n:2}) 输出 a 2 b）', () => {
    const zh = makeT('zh')
    expect(zh('a {n} b', 'a {n} b', { n: 2 })).toBe('a 2 b')
    expect(zh('{p}', '{p}', { p: 'https://x.example' })).toBe('https://x.example')
    expect(zh('{w}', '{w}', { w: { zh: '中文', en: 'English' } })).toBe('中文')
    const en = makeT('en')
    expect(en('{w}', '{w}', { w: { zh: '中文', en: 'English' } })).toBe('English')
    // 英文文案同样参与插值（旧手串形态里英文分支靠同一 replace 链，升级后由 interp 承担）
    expect(en('合并 {n} 条重复', '{n} duplicates merged', { n: 3 })).toBe('3 duplicates merged')
  })

  it('params 缺席或键缺失 → 占位符保持字面量；双参调用行为零变化', () => {
    const zh = makeT('zh')
    expect(zh('a {n} b', 'a {n} b')).toBe('a {n} b')
    expect(zh('a {n} b', 'a {n} b', undefined)).toBe('a {n} b')
    expect(zh('{n} {m}', '{n} {m}', { n: 1 })).toBe('1 {m}')
    // 语言选择不受第三参影响（既有全部双参调用的兼容面）
    expect(makeT('en')('中文', 'English')).toBe('English')
    expect(makeT('zh')('中文', 'English')).toBe('中文')
  })

  it('edit.ts ×2 / autoroute.ts ×1 既有传参在场：旧运行时吞参的泄漏由 t() 升级修复（防删参回退）', () => {
    // 这三处（模型容灾 {model}、{proto} 接口地址）早已传第三参，但旧 t() 只收双参——
    // 本卡运行时升级后自动生效。此断言钉住「调用侧传参」，与上方行为用例构成端到端链路。
    const editSrc = readFileSync(path.join(ROOT, 'src', 'gateway', 'ui', 'edit.ts'), 'utf8')
    const arSrc = readFileSync(path.join(ROOT, 'src', 'gateway', 'ui', 'autoroute.ts'), 'utf8')
    expect(editSrc).toContain(', { model: from })')
    expect(editSrc).toContain(', { proto: pk })')
    expect(arSrc).toContain(', { proto: pk })')
  })
})

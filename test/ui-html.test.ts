import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 取内嵌页面的静态 HTML 段（<body> 起点到首个 <script> 为止，脚本内的模板串不算）。 */
function staticBody(file: string): string {
  const s = readFileSync(path.join(ROOT, 'src', 'gateway', file), 'utf8')
  return s.slice(s.indexOf('<body>'), s.indexOf('<script>'))
}

/** 静态段 div 开闭差值：0 = 配对。 */
function divDelta(file: string): number {
  const body = staticBody(file)
  return (body.match(/<div\b/g) ?? []).length - (body.match(/<\/div>/g) ?? []).length
}

// v1.1.0 事故兜底（c78adb3）：收编入口调整时多写一个 </div> 把 .wrap 提前闭合——
// 服务卡全宽、顶部空白，但页面交互与元素查找全部正常，既有用例测不出 DOM 结构破坏。
// 这里对内嵌页面的静态 HTML 做配对断言，防同类回归。
describe('Web 控制台静态 HTML 结构', () => {
  it('ui.ts body 段 div 开闭配对', () => {
    expect(divDelta('ui.ts')).toBe(0)
  })

  it('lan.ts 静态段 div 开闭配对', () => {
    expect(divDelta('lan.ts')).toBe(0)
  })
})

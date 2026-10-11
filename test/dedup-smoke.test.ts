import { describe, it, expect } from 'vitest'
import { UI_HTML } from '../src/gateway/ui.js'
import { CONSOLE_SHARED_JS } from '../src/gateway/console-shared.js'
import { renderMobilePage } from '../src/gateway/lan.js'

function scriptBlocks(html: string): string[] {
  const blocks: string[] = []
  const re = /<script>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(html))) blocks.push(m[1])
  return blocks
}

// ui.ts / lan.ts 的内嵌 <script> 都是服务端 template 字面量吐给浏览器；此处用各自"求值后"的最终
// HTML（UI_HTML=导出常量、renderMobilePage()=纯函数），对每个脚本块做 new Function，防内嵌 JS 语法炸整页。
const LAN_HTML = renderMobilePage()

describe('dedup-rd-ui 内嵌脚本冒烟', () => {
  it.each([
    ['ui.ts', scriptBlocks(UI_HTML)],
    ['lan.ts', scriptBlocks(LAN_HTML)],
  ])('%s 每个 <script> 块都能 new Function 编译（无语法炸整页）', (_name, blocks) => {
    expect(blocks.length).toBeGreaterThan(0)
    for (const b of blocks) expect(() => new Function(b)).not.toThrow()
  })

  it('共用片段 CONSOLE_SHARED_JS 单独可解析', () => {
    expect(() => new Function(CONSOLE_SHARED_JS)).not.toThrow()
  })

  it('收敛断言：applyPollTimer 零命中 / ~/.modeldock/logs 不出现', () => {
    expect(UI_HTML.includes('applyPollTimer')).toBe(false) // DEAD-07
    expect(UI_HTML.includes('~/.modeldock/logs')).toBe(false) // DESIGN-08
    expect(LAN_HTML.includes('~/.modeldock/logs')).toBe(false) // DESIGN-08
  })
})
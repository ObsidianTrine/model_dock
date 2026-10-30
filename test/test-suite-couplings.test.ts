// 测试套件顺序耦合前提的门禁（T21；vitest.config.ts 头注「顺序耦合对」的机器化）。
// 背景：singleFork 共享 mock 注册表，且 vitest 按历史运行时长缓存排序（慢者先行，
// 非字母序）——uninstall.test.ts 体量最大、几乎恒先运行，zz-quickwins / update-tray
// 依赖该前提：zz-quickwins 用惰性 import basic.ts 防 registry 污染（其文件头注）；
// update-tray 因 uninstall.test 已 mock gatewaycmd 而刻意不重复 mock（其文件头注）。
// 本测试与文件排序无关，只钉真正 load-bearing 的两个不变量：mock 属主关系 + 不重复
// mock——谁删了 uninstall 的 mock、或复制了第二份，这里立刻红，逼先审耦合对再动代码。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const readTest = (f: string): string =>
  // 剥掉整行 // 注释再断言：update-tray 的头注里就有「vi.mock('...gatewaycmd.js')」字样
  fs.readFileSync(path.join(import.meta.dirname, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

const GATEWAYCMD_MOCK = /vi\.mock\(['"][^'"]*gatewaycmd\.js['"]/

describe('测试套件顺序耦合前提（T21 门禁）', () => {
  it('gatewaycmd 的 vi.mock 属主仍是 uninstall.test.ts（另两文件的排序前提）', () => {
    expect(readTest('uninstall.test.ts')).toMatch(GATEWAYCMD_MOCK)
  })

  it('zz-quickwins.test.ts 不重复 mock gatewaycmd（singleFork 跨文件 mock 雷区约定）', () => {
    expect(readTest('zz-quickwins.test.ts')).not.toMatch(GATEWAYCMD_MOCK)
  })

  it('update-tray.test.ts 不重复 mock gatewaycmd（其头注声明的既有约定）', () => {
    expect(readTest('update-tray.test.ts')).not.toMatch(GATEWAYCMD_MOCK)
  })

  it('耦合对的字典序前提成立：两文件都在且 zz-quickwins 恒排 uninstall 之后（卡 T21-③）', () => {
    // 存在性 + 字典序一起钉：谁把 zz-quickwins 改名/挪走、或 uninstall 改名导致排序前提
    // 反转，这里先红，逼先重审「惰性 import 防 registry 污染」的耦合再动代码
    expect(fs.existsSync(path.join(import.meta.dirname, 'uninstall.test.ts'))).toBe(true)
    expect(fs.existsSync(path.join(import.meta.dirname, 'zz-quickwins.test.ts'))).toBe(true)
    expect('zz-quickwins.test.ts' > 'uninstall.test.ts').toBe(true)
  })
})

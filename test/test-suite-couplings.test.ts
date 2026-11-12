// 测试套件顺序耦合前提的门禁（T21；vitest.config.ts 头注「顺序耦合对」的机器化）。
// 背景：singleFork 共享 mock 注册表，zz-quickwins / update-tray 与 uninstall.test.ts 存在
// mock/registry 层面的耦合（各自文件头注有声明）。断言形态的历史沿革：
//   ① 原用 'zz-quickwins' > 'uninstall' 字典序静态断言钉「uninstall 恒先运行」——恒真，
//     钉不住任何东西（假绿面，2026-11-05 审查发现）。
//   ② 曾改运行期收集序成对断言（test/helpers/run-order.ts 观测）——但 vitest 5 BaseSequencer
//     按「failed 先行 → 缓存时长降序 → 无缓存按文件字节大小降序」混合排序，顺序随缓存状态
//     漂移：暖缓存全量 uninstall(43ms) 先行、四文件子集 zz(421ms，basic.js 冷加载计入测试
//     时长)反超、冷缓存全量 update-tray 先行（均 2026-11-05 实测）——任何「uninstall 恒先
//     于 X」的成对断言必然间歇红，同样不可钉。
//   ③ 最终定案：运行序前提本就不是 load-bearing 的不变量。vitest 5 isolate:false 下先
//     collectTests 顺序收集全部文件、后 runFiles 跑用例（5.0.5 源码 startTests 实证），
//     vi.mock 注册先于一切测试期动态 import——真正的风险只有一个：别的测试文件在收集期
//     静态 import basic.js（basic.js 内联真实 gatewaycmd，会抢在 uninstall 的 vi.mock 注册
//     之前载入共享 registry，令 uninstall 的 mock 失效、单测摸到真实网关停止/清扫）。
//     因此本门禁钉静态属主关系：gatewaycmd mock 唯一属主 uninstall、basic.js 静态 import
//     唯一属主 uninstall、不重复 mock；收集序观测记录保留作排障线索（不作断言）。
//   ④ 2026-11-12 审查 F6 后扩展：autostart 是第二个真实共享 mock 点（gateway/syncpull/
//     uninstall 三属主），同样受收集序漂移支配——钉法不是「谁独占」（三文件都必须 mock，
//     见 syncpull 头注），而是「属主集合固定 + 工厂单源 test/mocks/autostart.ts」：形状
//     统一后谁家工厂胜出都等价，uninstall 的调用计数断言不再间歇红。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { testFileRunOrder } from './helpers/run-order.js'

const readTest = (f: string): string =>
  // 剥掉整行 // 注释再断言：update-tray 的头注里就有「vi.mock('...gatewaycmd.js')」字样
  fs.readFileSync(path.join(import.meta.dirname, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

const GATEWAYCMD_MOCK = /vi\.mock\(['"][^'"]*gatewaycmd\.js['"]/
const BASIC_STATIC_IMPORT = /^import\s.+['"][^'"]*basic\.js['"]/m
const AUTOSTART_MOCK = /vi\.mock\(['"][^'"]*src[/\\]autostart\.js['"]/
const AUTOSTART_FACTORY = /mocks[/\\]autostart\.js/
const AUTOSTART_OWNERS = ['gateway.test.ts', 'syncpull.test.ts', 'uninstall.test.ts']

describe('测试套件顺序耦合前提（T21 门禁）', () => {
  it('gatewaycmd 的 vi.mock 属主仍是 uninstall.test.ts（另两文件的前提）', () => {
    expect(readTest('uninstall.test.ts')).toMatch(GATEWAYCMD_MOCK)
  })

  it('zz-quickwins.test.ts 不重复 mock gatewaycmd（singleFork 跨文件 mock 雷区约定）', () => {
    expect(readTest('zz-quickwins.test.ts')).not.toMatch(GATEWAYCMD_MOCK)
  })

  it('update-tray.test.ts 不重复 mock gatewaycmd（其头注声明的既有约定）', () => {
    expect(readTest('update-tray.test.ts')).not.toMatch(GATEWAYCMD_MOCK)
  })

  it('autostart 的 vi.mock 属主集合仍是固定三文件（T21④，2026-11-12 审查 F6）', () => {
    // 三文件都必须 mock（syncpull 头注：不 mock 会把真实 launchctl 绑进 server.js 静态绑定；
    // uninstall 不 mock 会摸到真实 launchctl 超时），但不得新增第四家——isolate:false 共享
    // 注册表下多一家 mock 就多一分收集序歧义，入栅逼先重审
    const owners = fs
      .readdirSync(import.meta.dirname)
      .filter((f) => f.endsWith('.test.ts') && AUTOSTART_MOCK.test(readTest(f)))
      .sort()
    expect(
      owners,
      'autostart vi.mock 属主集合漂移——新增属主先审共享注册表耦合，减少属主先看 syncpull 头注的 server.js 静态绑定前提'
    ).toEqual([...AUTOSTART_OWNERS].sort())
  })

  it('autostart mock 工厂单源 test/mocks/autostart.ts（T21④：形状统一才对收集序漂移免疫）', () => {
    for (const f of AUTOSTART_OWNERS) {
      expect(
        readTest(f),
        `${f} 的 autostart mock 工厂须单源于 mocks/autostart.js——内联形状回潮会让「哪个工厂胜出」重新依赖收集序（uninstall 调用计数间歇红的根因，2026-11-12 审查 F6）`
      ).toMatch(AUTOSTART_FACTORY)
    }
  })

  it('耦合对三文件都在（谁改名/挪走逼先重审耦合），收集序观测记录就绪', () => {
    expect(fs.existsSync(path.join(import.meta.dirname, 'uninstall.test.ts'))).toBe(true)
    expect(fs.existsSync(path.join(import.meta.dirname, 'zz-quickwins.test.ts'))).toBe(true)
    expect(fs.existsSync(path.join(import.meta.dirname, 'update-tray.test.ts'))).toBe(true)
    // 收集序在收集期完成、先于一切用例执行（原理见 run-order.ts 头注）；记录随时长缓存
    // 漂移、不作成对断言（沿革见文件头注①②③）。这里只验观测器接线未被破坏（记录的
    // 都是测试文件名）；silent 模式下通过用例不回显，失败/verbose 场景可读
    expect(testFileRunOrder().every((f) => f.endsWith('.test.ts'))).toBe(true)
    console.log(`[couplings] 本次运行收集序：${testFileRunOrder().join(' → ') || '<单文件运行，无记录>'}`)
  })

  it('basic.js 的静态 import 唯一属主是 uninstall.test.ts（其余测试文件一律惰性 import）', () => {
    // vitest 5 收集期先于测试期（见文件头注③）：唯一能把真实 gatewaycmd 抢先载入共享
    // registry 的途径是收集期静态 import basic.js。uninstall 是唯一属主（其 vi.mock 经
    // hoist 先于自身 import 注册，自洽）；其余文件（含 zz-quickwins 的 loadQuoting 惰性
    // import、本文件字符串里的动态 import 示例）必须在测试期动态 import。守卫被删时
    // 这里立刻红，逼先重审耦合再动代码。readTest 已剥整行 // 注释；正则锚定行首 import +
    // 行内 from '…basic.js'（`.` 不跨行），不误伤函数体内缩进的动态 import()
    const offenders = fs
      .readdirSync(import.meta.dirname)
      .filter((f) => f.endsWith('.test.ts') && f !== 'uninstall.test.ts' && BASIC_STATIC_IMPORT.test(readTest(f)))
    expect(
      offenders,
      `以下测试文件静态 import basic.js，会在收集期抢先载入真实 gatewaycmd（shared registry）、令 uninstall.test.ts 的 vi.mock 失效：${offenders.join('、')}——改惰性 import（参照 zz-quickwins 的 loadQuoting）或先重审耦合`
    ).toEqual([])
  })
})

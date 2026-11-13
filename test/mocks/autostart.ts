/**
 * autostart mock 工厂（T21 单源）：三个属主（gateway / syncpull / uninstall）共用同一
 * spread 形状——isolate:false 共享注册表下谁家的工厂胜出取决于收集序，只有形状统一成
 * 「胜出无关」才消得掉 uninstall 调用计数断言的间歇红（2026-11-12 审查 F6）。
 * vi.mock 的工厂内动态 import 本文件（vitest hoist 限制的官方解法）。
 * uninstallAutostart 用 vi.fn 包装有状态实现：uninstall.test.ts 断言调用计数，
 * gateway/syncpull 断言 overview 即时性——两派语义都在（红线：不改 mock 行为语义）。
 */
import { vi } from 'vitest'

type AutostartModule = typeof import('../../src/autostart.js')

/** spread 型：内存 installed 状态 + importOriginal 保留其余纯函数导出。gateway/syncpull/uninstall 共用。
 *  isolate:false 共享模块注册表下整模块替换会击穿其他文件经 webupdate 等新链路的静态绑定，
 *  所以必须 spread 原模块，只覆写三个状态函数。 */
export async function spreadAutostartMock(): Promise<AutostartModule> {
  const original = await import('../../src/autostart.js')
  let installed = false
  return {
    ...original,
    autostartOverview: () => ({ installed, kind: 'launchd' as const }),
    installAutostart: async () => {
      installed = true
      return { kind: 'launchd' as const, file: '/fake/com.modeldock.gateway.plist', argv: ['modeldock', '--sea-gateway'], started: false }
    },
    uninstallAutostart: vi.fn(async () => {
      const was = installed
      installed = false
      return { removed: '/fake/com.modeldock.gateway.plist', wasInstalled: was }
    }),
  }
}

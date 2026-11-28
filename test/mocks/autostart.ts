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
/** 开关状态外置为模块级单例：三属主工厂在套件内可能被重新实例化（收集序胜出 + 模块缓存
 *  失效时机随缓存漂移），闭包内 flag 会把「install 写入的实例」与「autostartOverview 读取的
 *  实例」分裂成两份状态——gateway.test.ts POST /autostart 后 overview 回灌 false 的偶发假红
 *  即此（2026-11-28 双侧探针实证：POST 走实例 A、overview 读实例 B）。单例让所有实例共享
 *  一份开关，实例分裂无害化；单实例世界下行为逐字节不变。 */
export const autostartMockState = { installed: false }

export async function spreadAutostartMock(): Promise<AutostartModule> {
  const original = await import('../../src/autostart.js')
  return {
    ...original,
    autostartOverview: () => ({ installed: autostartMockState.installed, kind: 'launchd' as const }),
    installAutostart: async () => {
      autostartMockState.installed = true
      return { kind: 'launchd' as const, file: '/fake/com.modeldock.gateway.plist', argv: ['modeldock', '--sea-gateway'], started: false }
    },
    uninstallAutostart: vi.fn(async () => {
      const was = autostartMockState.installed
      autostartMockState.installed = false
      return { removed: '/fake/com.modeldock.gateway.plist', wasInstalled: was }
    }),
  }
}

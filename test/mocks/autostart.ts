/**
 * autostart mock 工厂（T21 单源）：gateway/syncpull 用带状态的 spread 型（overview 即时性
 * 回归共用同一形状，此前两处人肉同步漂移中），uninstall 用无状态 vi.fn 型。
 * vi.mock 的工厂内动态 import 本文件（vitest hoist 限制的官方解法）。
 * 导出字段集与历史三处内联逐一对齐——形状不变，只收敛来源（红线：不改 mock 行为语义）。
 */
import { vi } from 'vitest'

type AutostartModule = typeof import('../../src/autostart.js')

/** spread 型：内存 installed 状态 + importOriginal 保留其余纯函数导出。gateway/syncpull 共用。
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
    uninstallAutostart: async () => {
      const was = installed
      installed = false
      return { removed: '/fake/com.modeldock.gateway.plist', wasInstalled: was }
    },
  }
}

/** vi.fn 型：无状态，仅 uninstallAutostart 换 vi.fn（uninstall 断言调用与返回值） */
export async function viFnAutostartMock(): Promise<AutostartModule> {
  const original = await import('../../src/autostart.js')
  return {
    ...original,
    uninstallAutostart: vi.fn(async () => ({ wasInstalled: false, removed: '' })),
  }
}

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
 *  即此（2026-11-28 双侧探针实证）。单例让所有实例共享一份开关，实例分裂无害化。 */
export const autostartMockState = { installed: false }

/** 沙箱工件同步：mock install/uninstall 除内存开关外，在 MODELRDOCK_FAKE_HOME 沙箱内
 *  落/删与真实 install 相同的盘上工件（win=注册表镜像文件、linux/mac=服务文件）。
 *  动机：消费方（overview-view 等）对 autostart.js 的静态绑定在 collect-then-run + 缓存序
 *  漂移下可能冻结为 REAL 版本（真 fs 检查），若 mock 只翻内存开关就会出现「install 假、
 *  overview 真」的绑定劈叉，overview 读到与操作相反的状态。工件落盘让内存态与盘上态
 *  始终一致，任何绑定组合下 observable 行为相同；非沙箱绝不触碰（守卫在 first line）。 */
async function syncSandboxArtifacts(installed: boolean): Promise<void> {
  if (!process.env.MODELRDOCK_FAKE_HOME) return
  const fsm = await import('node:fs')
  const { atomicWrite } = await import('../../src/util/fsx.js')
  const original = await import('../../src/autostart.js')
  const kind = original.autostartKind()
  if (!kind) return
  try {
    if (kind === 'windows') {
      const mirror = original.windowsRunValueMirrorFile()
      if (installed) await atomicWrite(mirror, 'mock-run-value', 0o644)
      else fsm.rmSync(mirror, { force: true })
    } else {
      const file = kind === 'launchd' ? original.launchdPlistPath() : original.systemdUnitPath()
      if (installed) await atomicWrite(file, 'mock-service-file', 0o644)
      else fsm.rmSync(file, { force: true })
    }
  } catch { /* 工件同步失败不阻断 mock 语义：内存开关仍是主真相源 */ }
}

export async function spreadAutostartMock(): Promise<AutostartModule> {
  const original = await import('../../src/autostart.js')
  return {
    ...original,
    autostartOverview: () => ({ installed: autostartMockState.installed, kind: 'launchd' as const }),
    installAutostart: async () => {
      autostartMockState.installed = true
      await syncSandboxArtifacts(true)
      return { kind: 'launchd' as const, file: '/fake/com.modeldock.gateway.plist', argv: ['modeldock', '--sea-gateway'], started: false }
    },
    uninstallAutostart: vi.fn(async () => {
      const was = autostartMockState.installed
      autostartMockState.installed = false
      await syncSandboxArtifacts(false)
      return { removed: '/fake/com.modeldock.gateway.plist', wasInstalled: was }
    }),
  }
}

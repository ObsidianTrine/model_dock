import { describe, expect, it, vi } from 'vitest'
import { stopTrayProcesses, type TrayStopDeps } from '../src/update/install.js'

// 本文件只测停托盘的编排（枚举 → 按 PID 杀 → 复查 → 补刀 → 兜底强杀 → 终验）：
// 进程枚举与 kill 一律注入 mock，绝不触达真实 ModelDockTray 进程（AGENTS 红线：
// 生产托盘常在运行，单测禁做任何真实枚举/杀操作）。平台也注入，三 OS 确定性覆盖 win 强杀路径。
// 不用 vi.mock('../src/cli/gatewaycmd.js')：uninstall.test 已 mock 该模块，跨文件重复 mock
// 在 isolate:false + singleFork 下互相覆盖（vitest 隔离模型雷区）。

type Sync = TrayStopDeps['spawnSync']

interface Harness {
  logs: string[]
  kill: ReturnType<typeof vi.fn>
  sync: ReturnType<typeof vi.fn>
  run: () => Promise<void>
}

/** 编排桩：listProcessLines 按脚本依次返回枚举结果（耗尽后重复最后一个），kill / spawnSync 全 vi.fn */
function makeHarness(enums: (string | null)[], opts: { killOk?: boolean; platform?: string; syncStatus?: number } = {}): Harness {
  const logs: string[] = []
  const kill = vi.fn((_pid: number, _s: Sync, _o?: { tree?: boolean }) => opts.killOk ?? true)
  // 缺省返回 undefined（= killByPid 约定里的「只桩命令拼装，视为成功」）；syncStatus 模拟 taskkill 失败状态
  const sync = vi.fn(() => (opts.syncStatus === undefined ? undefined : { status: opts.syncStatus }))
  let i = 0
  const deps: TrayStopDeps = {
    listProcessLines: () => enums[Math.min(i++, enums.length - 1)],
    killByPid: kill,
    spawnSync: sync as unknown as Sync,
    sleep: async () => {},
    platform: opts.platform ?? 'win32',
  }
  return { logs, kill, sync, run: () => stopTrayProcesses((m) => logs.push(m), deps) }
}

/** 伪造枚举输出：一行一个托盘 pid（真机 CIM 形态：引号包裹路径） */
const tray = (...pids: number[]): string =>
  pids.map((p) => `${p} "D:\\Programs\\ModelDock\\ModelDockTray.exe"`).join('\n')

/** CRLF 枚举输出：Windows PowerShell CIM 重定向的真实形态（PS 5.1）——B1 回归样本 */
const trayCrlf = (...pids: number[]): string =>
  pids.map((p) => `${p} "D:\\Programs\\ModelDock\\ModelDockTray.exe"`).join('\r\n') + '\r\n'

describe('stopTrayProcesses（枚举与 kill 全 mock；平台注入）', () => {
  it('首轮全杀成功：枚举命中 → 按 PID 杀 → 复查为空 → ✓ 已停止', async () => {
    const h = makeHarness([tray(111), '', ''])
    await expect(h.run()).resolves.toBeUndefined()
    expect(h.kill).toHaveBeenCalledTimes(1)
    expect(h.kill).toHaveBeenCalledWith(111, expect.anything(), { tree: false }) // tree:false：更新器是托盘子进程，/T 会自伤
    const log = h.logs.join('\n')
    expect(log).toContain('停止托盘进程（pid 111）')
    expect(log).toContain('已杀 pid 111')
    expect(log).toContain('✓ 托盘已停止')
    expect(h.sync).not.toHaveBeenCalled() // 未到兜底，不按映像名强杀
  })

  it('首轮漏杀：复查仍见 pid → 补刀 → 终验为空 → ✓ 已停止', async () => {
    const h = makeHarness([tray(111), tray(111), ''])
    await h.run()
    expect(h.kill).toHaveBeenCalledTimes(2) // 两遍各杀一次 = 补刀
    expect(h.kill.mock.calls.map((c) => c[0] as number)).toEqual([111, 111])
    expect(h.logs.join('\n')).toContain('✓ 托盘已停止')
    expect(h.sync).not.toHaveBeenCalled()
  })

  it('两遍按 PID 杀均未生效 → 映像名兜底强杀 → 复查仍活 → 警告且不抛异常', async () => {
    const h = makeHarness([tray(111), tray(111), tray(111), tray(111)], { killOk: false })
    await expect(h.run()).resolves.toBeUndefined() // 全部手段失败也只落警告，不把更新流程炸掉
    expect(h.kill).toHaveBeenCalledTimes(2)
    const log = h.logs.join('\n')
    expect(log).toContain('杀 pid 111 未生效') // kill 结果写日志，不再静默
    expect(log).toContain('按 PID 停托盘未完全生效（pid 111）')
    expect(h.sync).toHaveBeenCalledTimes(1)
    expect(h.sync).toHaveBeenCalledWith('taskkill', ['/IM', 'ModelDockTray.exe', '/F'], expect.anything())
    expect(log).toContain('⚠ 托盘仍未停止')
  })

  it('映像名兜底强杀成功：兜底后复查为空 → ✓ 已停止（兜底结果写日志）', async () => {
    const h = makeHarness([tray(111), tray(111), tray(111), ''], { killOk: false })
    await h.run()
    expect(h.sync).toHaveBeenCalledTimes(1)
    expect(h.logs.join('\n')).toContain('✓ 托盘已停止')
  })

  it('枚举不可用：win 每遍按映像名强杀兜底，终验仍无法确认 → ⚠ 提示', async () => {
    const h = makeHarness([null, null, null])
    await h.run()
    expect(h.kill).not.toHaveBeenCalled()
    expect(h.sync).toHaveBeenCalledTimes(2) // 两遍各兜底一次
    expect(h.logs.join('\n')).toContain('进程枚举不可用，改按映像名强杀托盘（ModelDockTray.exe）')
    expect(h.logs.join('\n')).toContain('无法确认托盘是否已停止')
  })

  it('托盘未在运行：首遍枚举为空 → 直说不跑（不杀）', async () => {
    const h = makeHarness(['', ''])
    await h.run()
    expect(h.kill).not.toHaveBeenCalled()
    expect(h.sync).not.toHaveBeenCalled()
    expect(h.logs.join('\n')).toContain('托盘未在运行')
  })

  it('unix 无映像名强杀等价物：两遍杀失败 → 直接警告（taskkill 一次不调）', async () => {
    const h = makeHarness([tray(111), tray(111), tray(111)], { killOk: false, platform: 'linux' })
    await h.run()
    expect(h.kill).toHaveBeenCalledTimes(2)
    expect(h.sync).not.toHaveBeenCalled()
    expect(h.logs.join('\n')).toContain('⚠ 托盘仍未停止')
  })

  it('unix 枚举不可用：不杀不强杀，终验落「无法确认」', async () => {
    const h = makeHarness([null, null], { platform: 'linux' })
    await h.run()
    expect(h.kill).not.toHaveBeenCalled()
    expect(h.sync).not.toHaveBeenCalled()
    expect(h.logs.join('\n')).toContain('无法确认托盘是否已停止')
  })

  it('Windows CRLF 枚举行（PS 5.1 重定向实态）也能命中并杀 pid——B1 回归', async () => {
    const h = makeHarness([trayCrlf(111), '', ''])
    await h.run()
    expect(h.kill).toHaveBeenCalledTimes(1)
    expect(h.kill).toHaveBeenCalledWith(111, expect.anything(), { tree: false })
    expect(h.logs.join('\n')).toContain('✓ 托盘已停止')
  })

  it('首轮杀失败而复查枚举瞬时为空：不轻信「✓ 已停止」，交终验仲裁', async () => {
    const h = makeHarness([tray(111), '', tray(111), tray(111)], { killOk: false })
    await h.run()
    expect(h.kill).toHaveBeenCalledTimes(1)
    expect(h.sync).toHaveBeenCalledTimes(1) // 终验仍见活 pid → 映像名兜底
    const log = h.logs.join('\n')
    expect(log).not.toContain('✓ 托盘已停止') // 空枚举 + 杀失败记录不得直接宣告成功
    expect(log).toContain('⚠ 托盘仍未停止')
  })

  it('终验枚举不可用但循环内有杀失败实证：win 仍补一发映像名强杀（S1）', async () => {
    const h = makeHarness([tray(111), tray(111), null], { killOk: false })
    await h.run()
    expect(h.kill).toHaveBeenCalledTimes(2)
    expect(h.sync).toHaveBeenCalledTimes(1)
    expect(h.sync).toHaveBeenCalledWith('taskkill', ['/IM', 'ModelDockTray.exe', '/F'], expect.anything())
    const log = h.logs.join('\n')
    expect(log).toContain('再按映像名强杀一次')
    expect(log).toContain('无法确认托盘是否已停止')
  })

  it('映像名强杀返回失败状态：结果写日志（不再静默）', async () => {
    const h = makeHarness([tray(111), tray(111), tray(111), tray(111)], { killOk: false, syncStatus: 128 })
    await h.run()
    expect(h.sync).toHaveBeenCalledTimes(1)
    expect(h.logs.join('\n')).toContain('按映像名强杀托盘未生效')
  })
})

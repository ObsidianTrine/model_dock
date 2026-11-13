import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readUpdateProgress, resetUpdateProgressThrottleForTests } from '../src/update/progress.js'
import {
  backupWinSetupExes,
  clearRollbackArtifacts,
  readRollbackSlot,
  recordBareRollback,
  recordMacAppRollback,
  restoreMacApp,
  runRestore,
  saveRollbackSlot,
  swapWithSlot,
  swapWithSlotByCopy,
  type RollbackSlot,
} from '../src/update/rollback.js'
import { cleanUpdateRemnants } from '../src/update/run.js'
import { rollbackLedgerPath, updatesRollbackDir } from '../src/util/paths.js'
import { fakeHome } from './helpers.js'
import { VERSION } from '../src/version.js'

// 本文件绝不触达真实网络与真实实例：还原是纯本地 fs 对换（零下载），副作用
// （停网关/停托盘/open/spawn）全部注入 mock（AGENTS 红线）；账本与回滚目录
// 在 fakeHome 下隔离，不读写真实 ~/.modeldock。

let tmp = ''
let h: ReturnType<typeof fakeHome>

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-rollback-'))
  h = fakeHome()
  resetUpdateProgressThrottleForTests()
})
afterEach(async () => {
  h.restore()
  await fsp.rm(tmp, { recursive: true, force: true })
})

function mockDeps(opts: { wasLive?: boolean } = {}) {
  const calls = { stopGateway: 0, stopTray: 0, openApp: [] as string[], detached: [] as { file: string; args: string[] }[], startTray: [] as string[], wasLive: opts.wasLive ?? false }
  const deps = {
    stopGateway: vi.fn(async () => { calls.stopGateway++ }),
    stopTray: vi.fn(async () => { calls.stopTray++ }),
    openApp: vi.fn((p: string) => { calls.openApp.push(p) }),
    spawnDetached: vi.fn((file: string, args: string[]) => { calls.detached.push({ file, args }) }),
    gatewayWasLive: vi.fn(async () => calls.wasLive),
    startTray: vi.fn((p: string) => { calls.startTray.push(p) }),
  }
  return { deps, calls }
}

/** 造一个已登记的 bare 槽位：主程序 + 托盘各带 .old（内容 OLD/CUR 可区分） */
async function makeBareFixture(opts: { withTray?: boolean; wasLive?: boolean } = {}) {
  const binDir = path.join(tmp, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const exeName = process.platform === 'win32' ? 'modeldock.exe' : 'modeldock'
  const trayName = 'ModelDockTray' + (process.platform === 'win32' ? '.exe' : '')
  const execPath = path.join(binDir, exeName)
  fs.writeFileSync(execPath, 'CUR-BIN')
  fs.writeFileSync(execPath + '.old', 'OLD-BIN')
  const trayPath = path.join(binDir, trayName)
  const slot: RollbackSlot = { version: '0.9.9', shape: 'bare', mainPath: execPath + '.old', recordedAt: Date.now() }
  if (opts.withTray) {
    fs.writeFileSync(trayPath, 'CUR-TRAY')
    fs.writeFileSync(trayPath + '.old', 'OLD-TRAY')
    slot.trayPath = trayPath + '.old'
  }
  await saveRollbackSlot(slot)
  return { binDir, execPath, trayPath, slot }
}

const restoreOpts = (over: { yes?: boolean; confirm?: (m: string) => Promise<boolean>; deps?: unknown; execPath?: string; log?: (m: string) => void } = {}) => ({
  yes: over.yes ?? true,
  confirm: over.confirm ?? (async () => true),
  ...(over.deps ? { deps: over.deps as never } : {}),
  ...(over.execPath ? { execPath: over.execPath } : {}),
  ...(over.log ? { log: over.log } : {}),
})

// ---------- 账本读写 ----------

describe('还原账本（rollback.json）', () => {
  it('roundtrip：写读一致', async () => {
    const slot: RollbackSlot = { version: '0.9.9', shape: 'mac-app', mainPath: '/x/ModelDock.app.old', recordedAt: 123 }
    await saveRollbackSlot(slot)
    expect(await readRollbackSlot()).toEqual(slot)
  })

  it('损坏账本字段非法一律按无槽处理（入口自动隐藏，不报错）', async () => {
    expect(await readRollbackSlot()).toBeNull()
    await fsp.mkdir(updatesRollbackDir(), { recursive: true })
    await fsp.writeFile(rollbackLedgerPath(), '{broken json', 'utf8')
    expect(await readRollbackSlot()).toBeNull()
    await fsp.writeFile(rollbackLedgerPath(), JSON.stringify({ version: '0.9.9', shape: 'nope', mainPath: '/x' }), 'utf8')
    expect(await readRollbackSlot()).toBeNull()
    await fsp.writeFile(rollbackLedgerPath(), JSON.stringify({ version: 123, shape: 'bare', mainPath: '/x' }), 'utf8')
    expect(await readRollbackSlot()).toBeNull()
  })
})

// ---------- 换装成功后的登记钩子 ----------

describe('登记（runUpdate 记账钩子的单测面）', () => {
  it('recordMacAppRollback：.old 在位 → 槽位 version=当前版本、mainPath 指向 .old', async () => {
    const appRoot = path.join(tmp, 'Applications', 'ModelDock.app')
    const execPath = path.join(appRoot, 'Contents', 'MacOS', 'ModelDock')
    fs.mkdirSync(path.dirname(execPath), { recursive: true })
    fs.mkdirSync(appRoot + '.old', { recursive: true })
    await recordMacAppRollback(execPath)
    expect(await readRollbackSlot()).toMatchObject({ version: VERSION, shape: 'mac-app', mainPath: appRoot + '.old' })
  })

  it('recordMacAppRollback：.old 缺失（登记前被清）→ 抛错，调用方降级为告警', async () => {
    const execPath = path.join(tmp, 'Applications', 'ModelDock.app', 'Contents', 'MacOS', 'ModelDock')
    fs.mkdirSync(path.dirname(execPath), { recursive: true })
    await expect(recordMacAppRollback(execPath)).rejects.toThrow(/\.old/)
    expect(await readRollbackSlot()).toBeNull()
  })

  it('recordBareRollback：主程序 .old 必在；托盘 .old 以 trayReplaced 为准', async () => {
    const execPath = path.join(tmp, 'bin', process.platform === 'win32' ? 'modeldock.exe' : 'modeldock')
    fs.mkdirSync(path.dirname(execPath), { recursive: true })
    fs.writeFileSync(execPath + '.old', 'OLD')
    const trayOld = path.join(path.dirname(execPath), 'ModelDockTray' + (process.platform === 'win32' ? '.exe' : '') + '.old')
    fs.writeFileSync(trayOld, 'OLD-TRAY')

    await recordBareRollback(execPath, true)
    expect(await readRollbackSlot()).toMatchObject({ version: VERSION, shape: 'bare', mainPath: execPath + '.old', trayPath: trayOld })

    await recordBareRollback(execPath, false)
    const slot = await readRollbackSlot()
    expect(slot?.trayPath).toBeUndefined()
  })

  it('backupWinSetupExes：当前 exe 复制进回滚目录（Inno 向导不留旧版的唯一备份面）', async () => {
    const installDir = path.join(tmp, 'Programs', 'ModelDock')
    fs.mkdirSync(installDir, { recursive: true })
    const execPath = path.join(installDir, 'modeldock.exe')
    fs.writeFileSync(execPath, 'OLD-BIN')

    await backupWinSetupExes(execPath)
    const slot = await readRollbackSlot()
    const backupDir = path.join(updatesRollbackDir(), VERSION)
    expect(slot).toMatchObject({ version: VERSION, shape: 'win-setup', mainPath: path.join(backupDir, 'modeldock.exe') })
    expect(fs.readFileSync(path.join(backupDir, 'modeldock.exe'), 'utf8')).toBe('OLD-BIN')
    expect(slot?.trayPath).toBeUndefined()

    // 带托盘：一并备份
    fs.writeFileSync(path.join(installDir, 'ModelDockTray.exe'), 'OLD-TRAY')
    await backupWinSetupExes(execPath)
    const slot2 = await readRollbackSlot()
    expect(slot2?.trayPath).toBe(path.join(backupDir, 'ModelDockTray.exe'))
    expect(fs.readFileSync(path.join(backupDir, 'ModelDockTray.exe'), 'utf8')).toBe('OLD-TRAY')
  })
})

// ---------- 对换原语（真实 fs，临时目录） ----------

describe('对换原语', () => {
  it('swapWithSlot：同目录对换——槽位旧版落 target、当前版 park 进槽位（切回零下载的数据面）', async () => {
    const target = path.join(tmp, 'bin', 'modeldock')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'CUR')
    const slot = target + '.old'
    fs.writeFileSync(slot, 'OLD')

    await swapWithSlot(slot, target)

    expect(fs.readFileSync(target, 'utf8')).toBe('OLD')
    expect(fs.readFileSync(slot, 'utf8')).toBe('CUR')
    expect(fs.existsSync(target + '.restoring')).toBe(false)
  })

  it('swapWithSlot：槽位缺失 → 抛错且 target 原样（编排层此前已有 existsSync 校验，这里兜底）', async () => {
    const target = path.join(tmp, 'bin', 'modeldock')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'CUR')
    await expect(swapWithSlot(target + '.old', target)).rejects.toThrow(/不在位|missing/)
    expect(fs.readFileSync(target, 'utf8')).toBe('CUR')
  })

  it('swapWithSlotByCopy：跨目录对换（EXDEV 兜底的机制等价形态）——落位 + 槽位回填 + .old park', async () => {
    const slotDir = path.join(tmp, 'rollback', '0.9.9')
    const installDir = path.join(tmp, 'Programs', 'ModelDock')
    fs.mkdirSync(slotDir, { recursive: true })
    fs.mkdirSync(installDir, { recursive: true })
    const slot = path.join(slotDir, 'modeldock.exe')
    fs.writeFileSync(slot, 'OLD')
    const target = path.join(installDir, 'modeldock.exe')
    fs.writeFileSync(target, 'CUR')

    await swapWithSlotByCopy(slot, target)

    expect(fs.readFileSync(target, 'utf8')).toBe('OLD')
    expect(fs.readFileSync(slot, 'utf8')).toBe('CUR') // 槽位回填当前版：可再切回
    expect(fs.existsSync(target + '.old')).toBe(true) // park 的当前版留给 cleanOldVersions 清扫
    expect(fs.existsSync(target + '.new')).toBe(false)
  })

  it.skipIf(process.platform !== 'darwin')('restoreMacApp：整包对换，再对换一次即切回（双向零下载）', async () => {
    const appRoot = path.join(tmp, 'Applications', 'ModelDock.app')
    const bin = path.join(appRoot, 'Contents', 'MacOS', 'ModelDock')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, 'CUR')
    const oldBin = path.join(appRoot + '.old', 'Contents', 'MacOS', 'ModelDock')
    fs.mkdirSync(path.dirname(oldBin), { recursive: true })
    fs.writeFileSync(oldBin, 'OLD')

    const lines: string[] = []
    await restoreMacApp(appRoot, (m) => lines.push(m))
    expect(fs.readFileSync(bin, 'utf8')).toBe('OLD')
    expect(fs.readFileSync(path.join(appRoot + '.old', 'Contents', 'MacOS', 'ModelDock'), 'utf8')).toBe('CUR')
    expect(fs.existsSync(appRoot + '.restoring')).toBe(false)
    expect(lines.join('\n')).not.toContain('⚠')

    await restoreMacApp(appRoot, (m) => lines.push(m))
    expect(fs.readFileSync(bin, 'utf8')).toBe('CUR') // 对换对称：又回到开始时的状态
  })

  it.skipIf(process.platform !== 'darwin')('restoreMacApp：.old 缺失 → 回滚原状并抛错（还原失败不留半换状态）', async () => {
    const appRoot = path.join(tmp, 'Applications', 'ModelDock.app')
    const bin = path.join(appRoot, 'Contents', 'MacOS', 'ModelDock')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, 'CUR')

    await expect(restoreMacApp(appRoot, () => {})).rejects.toThrow()
    expect(fs.readFileSync(bin, 'utf8')).toBe('CUR')
    expect(fs.existsSync(appRoot + '.restoring')).toBe(false)
  })
})

// ---------- runRestore 编排 ----------

describe('runRestore 编排（副作用注入，fakeHome 隔离锁与进度）', () => {
  it('bare 全链路（网关在跑）：主程序与托盘一并对换、新二进制拉回 daemon、账本翻转、进度 done', async () => {
    const f = await makeBareFixture({ withTray: true, wasLive: true })
    const { deps, calls } = mockDeps({ wasLive: true })

    const r = await runRestore(restoreOpts({ deps, execPath: f.execPath }))

    expect(r).toEqual({ restored: true, fromVersion: VERSION, toVersion: '0.9.9' })
    expect(calls.stopGateway).toBe(1)
    expect(calls.stopTray).toBe(1)
    expect(fs.readFileSync(f.execPath, 'utf8')).toBe('OLD-BIN')
    expect(fs.readFileSync(f.execPath + '.old', 'utf8')).toBe('CUR-BIN')
    expect(fs.readFileSync(f.trayPath, 'utf8')).toBe('OLD-TRAY')
    expect(fs.readFileSync(f.trayPath + '.old', 'utf8')).toBe('CUR-TRAY')
    // 网关在跑 → spawn 还原后的二进制做 daemon（托盘由 spawnTrayWhenGatewayReady 补拉）
    expect(calls.detached).toEqual([{ file: f.execPath, args: ['--sea-gateway'] }])
    expect(calls.startTray).toHaveLength(0)
    // 账本翻转：槽位现在装的是刚被换下的版本（再点一次「还原」可免费切回）
    expect(await readRollbackSlot()).toMatchObject({ version: VERSION, shape: 'bare', mainPath: f.execPath + '.old', trayPath: f.trayPath + '.old' })
    expect((await readUpdateProgress())?.stage).toBe('done')
  })

  it('bare 全链路（网关未在跑）：不 spawn daemon，直接拉还原后的托盘', async () => {
    const f = await makeBareFixture({ withTray: true })
    const { deps, calls } = mockDeps({ wasLive: false })

    const r = await runRestore(restoreOpts({ deps, execPath: f.execPath }))

    expect(r.restored).toBe(true)
    expect(calls.detached).toHaveLength(0)
    expect(calls.startTray).toEqual([f.trayPath])
  })

  it.skipIf(process.platform !== 'darwin')('mac-app：整包对换 + open 拉起，账本翻转 mainPath 不变', async () => {
    const appRoot = path.join(tmp, 'Applications', 'ModelDock.app')
    const execPath = path.join(appRoot, 'Contents', 'MacOS', 'ModelDock')
    fs.mkdirSync(path.dirname(execPath), { recursive: true })
    fs.writeFileSync(execPath, 'CUR')
    const oldBin = path.join(appRoot + '.old', 'Contents', 'MacOS', 'ModelDock')
    fs.mkdirSync(path.dirname(oldBin), { recursive: true })
    fs.writeFileSync(oldBin, 'OLD')
    await saveRollbackSlot({ version: '0.9.9', shape: 'mac-app', mainPath: appRoot + '.old', recordedAt: Date.now() })
    const { deps, calls } = mockDeps({ wasLive: true })

    const r = await runRestore(restoreOpts({ deps, execPath }))

    expect(r).toEqual({ restored: true, fromVersion: VERSION, toVersion: '0.9.9' })
    expect(fs.readFileSync(execPath, 'utf8')).toBe('OLD')
    expect(fs.readFileSync(path.join(appRoot + '.old', 'Contents', 'MacOS', 'ModelDock'), 'utf8')).toBe('CUR')
    expect(calls.openApp).toEqual([appRoot])
    expect(calls.detached).toHaveLength(0) // mac 整包路径由 openApp → GUI 自拉网关
    expect(await readRollbackSlot()).toMatchObject({ version: VERSION, shape: 'mac-app', mainPath: appRoot + '.old' })
  })

  it('win-setup：回滚目录备份的 exe 落回安装位、槽位回填当前版（对换切回面）', async () => {
    // 托盘名按平台取（trayEntryName 同口径）：win-setup 实际只在 win 发生，机制在三平台同构可测
    const trayName = 'ModelDockTray' + (process.platform === 'win32' ? '.exe' : '')
    const installDir = path.join(tmp, 'Programs', 'ModelDock')
    fs.mkdirSync(installDir, { recursive: true })
    const execPath = path.join(installDir, process.platform === 'win32' ? 'modeldock.exe' : 'modeldock')
    fs.writeFileSync(execPath, 'CUR-BIN')
    fs.writeFileSync(path.join(installDir, trayName), 'CUR-TRAY')
    const backupDir = path.join(updatesRollbackDir(), '0.9.9')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(path.join(backupDir, path.basename(execPath)), 'OLD-BIN')
    fs.writeFileSync(path.join(backupDir, trayName), 'OLD-TRAY')
    await saveRollbackSlot({ version: '0.9.9', shape: 'win-setup', mainPath: path.join(backupDir, path.basename(execPath)), trayPath: path.join(backupDir, trayName), recordedAt: Date.now() })
    const { deps, calls } = mockDeps({ wasLive: true })

    const r = await runRestore(restoreOpts({ deps, execPath }))

    expect(r.restored).toBe(true)
    expect(fs.readFileSync(execPath, 'utf8')).toBe('OLD-BIN')
    expect(fs.readFileSync(path.join(installDir, trayName), 'utf8')).toBe('OLD-TRAY')
    // 槽位回填当前版（对换）：跨目录对换在同卷走 rename，无 .old park
    expect(fs.readFileSync(path.join(backupDir, path.basename(execPath)), 'utf8')).toBe('CUR-BIN')
    expect(fs.readFileSync(path.join(backupDir, trayName), 'utf8')).toBe('CUR-TRAY')
    expect(calls.detached).toEqual([{ file: execPath, args: ['--sea-gateway'] }])
    expect(await readRollbackSlot()).toMatchObject({ version: VERSION, shape: 'win-setup', mainPath: path.join(backupDir, path.basename(execPath)) })
  })

  it('托盘备份缺失：只还原主程序 + 告警，账本翻转不带 trayPath', async () => {
    const f = await makeBareFixture({ withTray: false })
    // 手工补一条带 trayPath 的账本但托盘备份文件不在盘
    await saveRollbackSlot({ version: '0.9.9', shape: 'bare', mainPath: f.execPath + '.old', trayPath: f.trayPath + '.old', recordedAt: Date.now() })
    const lines: string[] = []
    const { deps, calls } = mockDeps({ wasLive: true })

    const r = await runRestore(restoreOpts({ deps, execPath: f.execPath, log: (m) => lines.push(m) }))

    expect(r.restored).toBe(true)
    expect(lines.join('\n')).toMatch(/托盘备份缺失|Tray backup missing/)
    expect(fs.readFileSync(f.execPath, 'utf8')).toBe('OLD-BIN')
    expect(fs.existsSync(f.trayPath)).toBe(false) // 托盘没被造出来，保持缺席
    const slot = await readRollbackSlot()
    expect(slot?.version).toBe(VERSION)
    expect(slot?.trayPath).toBeUndefined()
    expect(calls.stopTray).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('托盘对换失败（槽位目录只读）：主程序已还原 + 降级告警，账本不带 trayPath', async () => {
    const f = await makeBareFixture({ withTray: false })
    // 托盘槽位放进只读目录：rename 出槽位即 EACCES（win 无等价 chmod 语义，仅 unix 跑）
    const roDir = path.join(tmp, 'ro-tray')
    fs.mkdirSync(roDir, { recursive: true })
    fs.writeFileSync(path.join(roDir, 'ModelDockTray.old'), 'OLD-TRAY')
    fs.chmodSync(roDir, 0o555)
    await saveRollbackSlot({ version: '0.9.9', shape: 'bare', mainPath: f.execPath + '.old', trayPath: path.join(roDir, 'ModelDockTray.old'), recordedAt: Date.now() })
    const { deps } = mockDeps({ wasLive: false })

    try {
      const r = await runRestore(restoreOpts({ deps, execPath: f.execPath }))
      expect(r.restored).toBe(true)
      expect(fs.readFileSync(f.execPath, 'utf8')).toBe('OLD-BIN')
      // 主程序已还原而托盘对换失败：账本翻转仍写，但不带 trayPath（托盘保持现状）
      const slot = await readRollbackSlot()
      expect(slot?.version).toBe(VERSION)
      expect(slot?.trayPath).toBeUndefined()
    } finally {
      fs.chmodSync(roDir, 0o755) // 放开权限让 tmpdir 能删干净
    }
  })

  it('无槽位：可操作报错（含保留机制说明 hint），实例零触碰', async () => {
    const f = await makeBareFixture()
    await fsp.rm(rollbackLedgerPath(), { force: true })
    const { deps, calls } = mockDeps()
    const err = await runRestore(restoreOpts({ deps, execPath: f.execPath })).then(
      () => null,
      (e) => e as Error & { hint?: string }
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toMatch(/没有可还原|No previous version/)
    expect(err!.hint).toMatch(/更新后自动保留|--clean/)
    expect(calls.stopGateway).toBe(0)
    expect(calls.stopTray).toBe(0)
    expect(fs.readFileSync(f.execPath, 'utf8')).toBe('CUR-BIN')
  })

  it('陈旧槽（version === 当前版本，win-setup 向导被取消的形态）：清槽 + 报错，不留幽灵入口', async () => {
    const f = await makeBareFixture()
    await saveRollbackSlot({ version: VERSION, shape: 'bare', mainPath: f.execPath + '.old', recordedAt: Date.now() })
    const { deps } = mockDeps()
    await expect(runRestore(restoreOpts({ deps, execPath: f.execPath }))).rejects.toThrow(/相同|stale|matches/)
    expect(await readRollbackSlot()).toBeNull()
    expect(fs.readFileSync(f.execPath, 'utf8')).toBe('CUR-BIN') // 未做任何替换
  })

  it('备份产物已被移除（手动删 / .old 被清）：清槽 + 报错', async () => {
    const f = await makeBareFixture()
    fs.rmSync(f.execPath + '.old', { recursive: true, force: true })
    const { deps } = mockDeps()
    await expect(runRestore(restoreOpts({ deps, execPath: f.execPath }))).rejects.toThrow(/已被移除|is gone/)
    expect(await readRollbackSlot()).toBeNull()
  })

  it('开发态守卫：execPath 是 node（tsx 直跑）时拒绝还原，不触碰任何实例', async () => {
    const f = await makeBareFixture()
    const nodeExecPath = path.join(tmp, 'never-exists', 'node')
    const { deps, calls } = mockDeps()
    await expect(runRestore(restoreOpts({ deps, execPath: nodeExecPath }))).rejects.toThrow(/开发态|tsx|source/)
    expect(calls.stopGateway).toBe(0)
    expect(fs.readFileSync(f.execPath, 'utf8')).toBe('CUR-BIN')
  })

  it('确认拒绝：不做任何改动（不持锁、不停实例、账本不动）', async () => {
    const f = await makeBareFixture({ withTray: true })
    const { deps, calls } = mockDeps()
    const r = await runRestore(restoreOpts({ yes: false, confirm: async () => false, deps, execPath: f.execPath }))
    expect(r.restored).toBe(false)
    expect(r.toVersion).toBe('0.9.9')
    expect(calls.stopGateway).toBe(0)
    expect(calls.stopTray).toBe(0)
    expect(fs.readFileSync(f.execPath, 'utf8')).toBe('CUR-BIN')
    expect((await readRollbackSlot())?.version).toBe('0.9.9')
  })

  it('--clean 连带清理：账本与回滚目录一起消失（否则留幽灵入口）', async () => {
    const f = await makeBareFixture({ withTray: true })
    const backupDir = updatesRollbackDir()
    fs.mkdirSync(path.join(backupDir, VERSION), { recursive: true })
    fs.writeFileSync(path.join(backupDir, VERSION, 'modeldock.exe'), 'STALE')

    await cleanUpdateRemnants(f.execPath)

    expect(await readRollbackSlot()).toBeNull()
    expect(fs.existsSync(backupDir)).toBe(false)
    expect(fs.existsSync(f.execPath + '.old')).toBe(false) // 既有 .old 清理行为不回归
  })
})

/** mock deps 每个副作用都未被触发的守卫（编排失败用例的附加断言） */
function callsClosed(deps: { stopGateway: ReturnType<typeof vi.fn>; stopTray: ReturnType<typeof vi.fn> }): boolean {
  return deps.stopGateway.mock.calls.length === 0 && deps.stopTray.mock.calls.length === 0
}

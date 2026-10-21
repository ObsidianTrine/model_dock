import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { spawnTrayIfPresent, spawnTrayWhenGatewayReady, trayBinaryPath } from '../src/tray.js'

// 托盘拉起决策逻辑（src/tray.ts）：打包形态 execPath 旁有托盘二进制才拉，daemon 就绪后才拉。
// 全部经 opts 注入 execPath / spawnFn / probe，不 mock 模块——node:child_process 已被
// cli-shared.test.ts mock，本文件再 mock 会撞 vitest 单进程共享注册表雷区。

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'modeldock-tray-'))
}

interface SpawnCall {
  file: string
  args: string[]
  opts: Record<string, unknown>
  errored: boolean
  unreffed: boolean
}

/** 记录调用的假 spawn：返回可 .on('error') / .unref() 的伪 ChildProcess */
function fakeSpawn(calls: SpawnCall[]): typeof spawn {
  const fn = ((file: string, args: string[], opts: Record<string, unknown>) => {
    const rec: SpawnCall = { file, args, opts, errored: false, unreffed: false }
    calls.push(rec)
    const e = new EventEmitter() as unknown as ChildProcess
    e.on = ((event: string, cb: () => void) => {
      if (event === 'error') {
        rec.errored = true
        void cb
      }
      return e
    }) as ChildProcess['on']
    e.unref = () => {
      rec.unreffed = true
      return e
    }
    return e
  }) as unknown as typeof spawn
  return fn
}

describe('trayBinaryPath', () => {
  it('execPath 旁有托盘二进制时返回路径', () => {
    const dir = tmpDir()
    const exe = path.join(dir, 'modeldock')
    fs.writeFileSync(exe, '')
    fs.writeFileSync(path.join(dir, 'ModelDockTray'), '')
    expect(trayBinaryPath(exe)).toBe(path.join(dir, 'ModelDockTray'))
  })

  it('旁无托盘二进制时返回 null（npm/dev 形态）', () => {
    const dir = tmpDir()
    const exe = path.join(dir, 'modeldock')
    fs.writeFileSync(exe, '')
    expect(trayBinaryPath(exe)).toBeNull()
  })

  it('win32 下二进制名带 .exe 后缀', () => {
    const dir = tmpDir()
    const exe = path.join(dir, 'modeldock.exe')
    fs.writeFileSync(exe, '')
    fs.writeFileSync(path.join(dir, 'ModelDockTray.exe'), '')
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      expect(trayBinaryPath(exe)).toBe(path.join(dir, 'ModelDockTray.exe'))
    } finally {
      if (desc) Object.defineProperty(process, 'platform', desc)
    }
  })
})

describe('spawnTrayIfPresent', () => {
  it('托盘不存在时不 spawn', () => {
    const dir = tmpDir()
    const calls: SpawnCall[] = []
    spawnTrayIfPresent({ execPath: path.join(dir, 'modeldock'), spawnFn: fakeSpawn(calls) })
    expect(calls).toHaveLength(0)
  })

  it('托盘存在时 detached + 隐藏窗口拉起一次，并挂 error 吞错、unref 脱离生命周期', () => {
    const dir = tmpDir()
    const exe = path.join(dir, 'modeldock')
    fs.writeFileSync(exe, '')
    fs.writeFileSync(path.join(dir, 'ModelDockTray'), '')
    const calls: SpawnCall[] = []
    spawnTrayIfPresent({ execPath: exe, spawnFn: fakeSpawn(calls) })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe(path.join(dir, 'ModelDockTray'))
    expect(calls[0].args).toEqual([])
    expect(calls[0].opts.detached).toBe(true)
    expect(calls[0].opts.stdio).toBe('ignore')
    expect(calls[0].opts.windowsHide).toBe(true)
    expect(calls[0].errored).toBe(true)
    expect(calls[0].unreffed).toBe(true)
  })
})

describe('spawnTrayWhenGatewayReady', () => {
  it('网关已就绪：立即拉托盘，不等待', async () => {
    const dir = tmpDir()
    const exe = path.join(dir, 'modeldock')
    fs.writeFileSync(exe, '')
    fs.writeFileSync(path.join(dir, 'ModelDockTray'), '')
    const calls: SpawnCall[] = []
    await spawnTrayWhenGatewayReady({
      execPath: exe,
      spawnFn: fakeSpawn(calls),
      probe: async () => true,
      timeoutMs: 1000,
    })
    expect(calls).toHaveLength(1)
  })

  it('网关稍后就绪：轮询到健康再拉', async () => {
    const dir = tmpDir()
    const exe = path.join(dir, 'modeldock')
    fs.writeFileSync(exe, '')
    fs.writeFileSync(path.join(dir, 'ModelDockTray'), '')
    const calls: SpawnCall[] = []
    let n = 0
    await spawnTrayWhenGatewayReady({
      execPath: exe,
      spawnFn: fakeSpawn(calls),
      probe: async () => ++n >= 2,
      timeoutMs: 5000,
    })
    expect(calls).toHaveLength(1)
  })

  it('超时仍不就绪（daemon 没起来）：放弃拉托盘并返回', async () => {
    const dir = tmpDir()
    const exe = path.join(dir, 'modeldock')
    fs.writeFileSync(exe, '')
    fs.writeFileSync(path.join(dir, 'ModelDockTray'), '')
    const calls: SpawnCall[] = []
    let probes = 0
    await spawnTrayWhenGatewayReady({
      execPath: exe,
      spawnFn: fakeSpawn(calls),
      probe: async () => {
        probes++
        return false
      },
      timeoutMs: 700,
    })
    expect(calls).toHaveLength(0)
    expect(probes).toBeGreaterThanOrEqual(1)
    expect(probes).toBeLessThanOrEqual(3) // 700ms 内 500ms 轮询最多两轮，第三轮前必因超时退出
  })

  it('托盘二进制不存在：即使网关就绪也不 spawn（npm/dev 形态）', async () => {
    const dir = tmpDir()
    const calls: SpawnCall[] = []
    await spawnTrayWhenGatewayReady({
      execPath: path.join(dir, 'modeldock'),
      spawnFn: fakeSpawn(calls),
      probe: async () => true,
      timeoutMs: 1000,
    })
    expect(calls).toHaveLength(0)
  })
})

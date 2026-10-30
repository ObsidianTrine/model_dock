import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import {
  clearCommandMemo,
  commandOnPath,
  commandOnPathSandbox,
  shouldRetryAtomicWrite,
} from '../src/util/fsx.js'
import { regQueryAny } from '../src/adapters/presence.js'

// PERF-07（fsx PATH memo）+ XPLAT-01（EBUSY 重试）+ PERF-08（注册表三视图并行）三件套的
// 定点测试，独立成文件（T21 复核：adapters/store 现已零 vi.mock——仅 adapters.test.ts 有
// console spy——「避免 mock 污染」的旧理由已不存在，独立文件保留为低耦合组织方式）。

describe('fsx PATH memo（PERF-07）', () => {
  it('非 FAKE_HOME 下同一 cmd 二次调用 memo 命中，不再触达 fs', () => {
    const prevFake = process.env.MODELRDOCK_FAKE_HOME
    if (prevFake !== undefined) delete process.env.MODELRDOCK_FAKE_HOME
    clearCommandMemo()
    const spy = vi.spyOn(fs, 'existsSync')
    try {
      const cmd = 'mdk-memo-probe-9f' // 不在 PATH 上，走全目录扫描，existsSync 必然多次
      commandOnPath(cmd)
      const afterFirst = spy.mock.calls.length
      expect(afterFirst).toBeGreaterThan(0)
      commandOnPath(cmd)
      expect(spy.mock.calls.length).toBe(afterFirst) // 二次命中 memo，未再读盘
    } finally {
      spy.mockRestore()
      clearCommandMemo()
      if (prevFake === undefined) delete process.env.MODELRDOCK_FAKE_HOME
      else process.env.MODELRDOCK_FAKE_HOME = prevFake
    }
  })

  it('FAKE_HOME 下绕过 memo：装完立即可见，且每次仍触达 fs', () => {
    const h = fakeHome()
    clearCommandMemo()
    const spy = vi.spyOn(fs, 'existsSync')
    const prevPath = process.env.PATH
    const sep = process.platform === 'win32' ? ';' : ':'
    try {
      const base = path.join(h.home, 'probe-bin')
      fs.mkdirSync(base, { recursive: true })
      const cmd = 'mdk-memo-sandbox-7q'
      process.env.PATH = `${base}${sep}${prevPath ?? ''}`
      expect(commandOnPathSandbox(cmd)).toBe(false) // 初始未安装
      const beforeAdd = spy.mock.calls.length
      fs.writeFileSync(path.join(base, process.platform === 'win32' ? `${cmd}.cmd` : cmd), '')
      expect(commandOnPathSandbox(cmd)).toBe(true) // 装完立即可见：memo 未缓存旧 miss
      expect(spy.mock.calls.length).toBeGreaterThan(beforeAdd) // 绕过 memo，二次调用仍读盘
    } finally {
      if (prevPath === undefined) delete process.env.PATH
      else process.env.PATH = prevPath
      spy.mockRestore()
      clearCommandMemo()
      h.restore()
    }
  })
})

describe('atomicWrite 错误码重试判定（XPLAT-01）', () => {
  it('EPERM/EACCES/EBUSY 可重试；ENOENT 等目标缺失类不可', () => {
    expect(shouldRetryAtomicWrite('EPERM')).toBe(true)
    expect(shouldRetryAtomicWrite('EACCES')).toBe(true)
    expect(shouldRetryAtomicWrite('EBUSY')).toBe(true)
    expect(shouldRetryAtomicWrite('ENOENT')).toBe(false)
    expect(shouldRetryAtomicWrite('EROFS')).toBe(false)
    expect(shouldRetryAtomicWrite(undefined)).toBe(false)
  })
})

describe('注册表三视图并行聚合（PERF-08）', () => {
  const KEYS = ['K1', 'K2', 'K3']

  /** 可控制的 exec 桩：登记调用并挂起，直到外部放行，便于断言「三视图并行发起」。 */
  function makeGate(
    payloads: Record<string, string>
  ): { exec: (cmd: string, args: string[], t: number) => Promise<string>; release: () => void; calls: { key: string; app: string }[] } {
    const calls: { key: string; app: string }[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const exec = (_cmd: string, args: string[], _t: number): Promise<string> => {
      const key = args[1]
      const app = args[4]
      calls.push({ key, app })
      return new Promise((resolve) => gate.then(() => resolve(payloads[key] ?? '')))
    }
    return { exec, release, calls }
  }

  it('三视图并行发起（Promise.all 语义）：放行前三条查询已全部进入飞行', async () => {
    const { exec, release, calls } = makeGate({})
    const pending = regQueryAny(exec, KEYS, 'testsuite-a', 8000)
    await Promise.resolve() // 让 exec 体同步跑完登记
    expect(calls.length).toBe(3) // 三条全部发起（未串行等各自完成）
    expect(calls.map((c) => c.key)).toEqual(KEYS)
    release() // 放行，全部 miss
    await expect(pending).resolves.toBe(false)
  })

  it('任一路输出含应用名即命中（大小写不敏感）；全部 miss 则未命中', async () => {
    const immediate =
      (payloads: Record<string, string>) =>
      (_cmd: string, args: string[], _t: number): Promise<string> =>
        Promise.resolve(payloads[args[1]] ?? '')
    await expect(regQueryAny(immediate({ K2: '  DisplayName    {ABC}    REG_SZ   Foo Suite 1' }), KEYS, 'FOO SUITE', 8000)).resolves.toBe(true)
    await expect(regQueryAny(immediate({ K1: 'junk', K2: 'other', K3: '' }), KEYS, 'neversuchapp', 8000)).resolves.toBe(false)
  })
})

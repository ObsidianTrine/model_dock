import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fakeHome } from './helpers.js'
import { exitWithThrown, killByPid, openUrlInBrowser, requireGateway, spawnDaemonAndWait } from '../src/cli/shared.js'
import { localDateStr } from '../src/util/index.js'
import { logsDir } from '../src/util/paths.js'

// cli/shared.ts 原语补测（cli-shared.test.ts 已覆盖拼装主干）：错误出口 exitWithThrown、
// requireGateway 未运行分支、win32 浏览器 opener、kill 失败分支、daemon stderr 半行缓冲与
// 全轮超时。纪律同 cli-shared.test.ts：绝不 vi.mock('node:child_process')，一律注入 fake
// 执行器；平台差异用 process.platform spy。

class ExitError extends Error {
  constructor(public code: number | undefined) {
    super(`exit:${code}`)
  }
}

let logs: string[] = []
let errs: string[] = []
function captureConsole(): void {
  logs = []
  errs = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '))
  })
}

function stubExit(): void {
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code)
  }) as never)
}

afterEach(() => {
  vi.mocked(process.exit).mockRestore?.()
  vi.mocked(console.log).mockRestore?.()
  vi.mocked(console.error).mockRestore?.()
})

function fakeChild() {
  const c = new EventEmitter() as any
  c.unref = vi.fn()
  c.stderr = new EventEmitter()
  return c
}

describe('requireGateway / exitWithThrown', () => {
  it('网关未运行：exit(1) 并提示启动命令', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(requireGateway()).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('网关未运行')
    } finally {
      h.restore()
    }
  })

  it('exitWithThrown：带 hint 打两行式；无 hint 只打 message；非 Error 抛出值走 String', () => {
    captureConsole()
    stubExit()
    expect(() => exitWithThrown(Object.assign(new Error('boom'), { hint: 'hh' }))).toThrow(ExitError)
    expect(errs.join('\n')).toContain('boom')
    expect(errs.join('\n')).toContain('提示')
    expect(errs.join('\n')).toContain('hh')

    errs = []
    expect(() => exitWithThrown(new Error('plain'))).toThrow(ExitError)
    expect(errs.join('\n')).toContain('plain')
    expect(errs.join('\n')).not.toContain('提示')

    errs = []
    expect(() => exitWithThrown('string-thrown')).toThrow(ExitError)
    expect(errs.join('\n')).toContain('string-thrown')
  })
})

describe('openUrlInBrowser 平台分支', () => {
  it('win32：cmd /c start 空标题占位打开（URL 不被吞/截断）', async () => {
    const plat = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const fakeSpawn = vi.fn(() => {
      const child = fakeChild()
      process.nextTick(() => child.emit('spawn'))
      return child
    })
    try {
      await expect(openUrlInBrowser('http://127.0.0.1:1/x', fakeSpawn)).resolves.toBe(true)
      expect(fakeSpawn).toHaveBeenCalledWith('cmd', ['/c', 'start', '', 'http://127.0.0.1:1/x'], expect.objectContaining({ detached: true }))
    } finally {
      plat.mockRestore()
    }
  })
})

describe('killByPid 失败分支', () => {
  it('win32 taskkill 返回非 0 状态：判定未发出终结信号', () => {
    const plat = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const fakeSpawnSync = vi.fn(() => ({ status: 1 }))
    try {
      expect(killByPid(42, fakeSpawnSync)).toBe(false)
    } finally {
      plat.mockRestore()
    }
  })

  it('unix process.kill 抛错（进程已退出）：返回 false 不抛', () => {
    const plat = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    const fakeSpawnSync = vi.fn()
    try {
      expect(killByPid(7, fakeSpawnSync)).toBe(false)
      expect(fakeSpawnSync).not.toHaveBeenCalled()
    } finally {
      plat.mockRestore()
      kill.mockRestore()
    }
  })
})

describe('spawnDaemonAndWait 超时与 stderr 重定向', () => {
  it('daemon stderr 走 fd 重定向（stdio[2]=数字 fd 而非 pipe），父进程副本 spawn 后立即关闭', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      const child = fakeChild()
      const fakeSpawn = vi.fn(() => child)
      const openSpy = vi.spyOn(fs, 'openSync')
      const closeSpy = vi.spyOn(fs, 'closeSync')
      try {
        const res = await spawnDaemonAndWait(['node', '--sea-gateway', '--port', '18977'], async () => null, fakeSpawn, 1)
        expect(res).toBeNull()

        const opts = fakeSpawn.mock.calls[0][2] as { stdio: unknown[] }
        expect(typeof opts.stdio[2]).toBe('number') // fd 而非 'pipe'：父进程零管道、零钉死
        const fd = opts.stdio[2] as number
        expect(openSpy).toHaveBeenCalledWith(expect.stringContaining(`daemon-${localDateStr()}.log`), 'a')
        expect(closeSpy).toHaveBeenCalledWith(fd) // 父副本即关：子进程已继承 fd
      } finally {
        openSpy.mockRestore()
        closeSpy.mockRestore()
      }
    } finally {
      h.restore()
    }
  })

  it('真实子进程：父副本关闭后写 stderr 仍落日志（fd 继承，无 EPIPE、诊断不丢）', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      // 假 daemon：150ms 后往 stderr 写一行再退出——父进程此刻早已关闭自己的 fd 副本
      const argv = [process.execPath, '-e', 'setTimeout(() => { console.error("late-stderr-line"); process.exit(0) }, 150)']
      const res = await spawnDaemonAndWait(argv, async () => null, spawn, 1)
      expect(res).toBeNull()
      const daemonLog = path.join(logsDir(), `daemon-${localDateStr()}.log`)
      await vi.waitFor(() => {
        expect(fs.readFileSync(daemonLog, 'utf8')).toContain('late-stderr-line')
      })
    } finally {
      h.restore()
    }
  })

  it('daemon 拉起失败（spawn error）：打可见报错但不崩', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      const child = fakeChild()
      const fakeSpawn = vi.fn(() => {
        process.nextTick(() => child.emit('error', new Error('ENOENT')))
        return child
      })
      const res = await spawnDaemonAndWait(['no-such-bin'], async () => null, fakeSpawn, 1)
      expect(res).toBeNull()
      expect(errs.join('\n')).toContain('拉起失败')
    } finally {
      h.restore()
    }
  })
})

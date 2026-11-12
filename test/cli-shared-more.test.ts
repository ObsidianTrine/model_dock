import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Console } from 'node:console'
import { fakeHome } from './helpers.js'
import { buildStderrReplacementStream, exitWithThrown, killByPid, openUrlInBrowser, requireGateway, spawnDaemonAndWait } from '../src/cli/shared.js'

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

describe('spawnDaemonAndWait 超时与 spawn 契约', () => {
  it('全轮探活失败：返回 null；stdio 全 ignore、不挂任何子进程流读端（CORRECT-07：pipe 读端会让 CLI 就绪后无法退出）', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      const child = fakeChild()
      const stderrOn = vi.spyOn(child.stderr, 'on')
      const fakeSpawn = vi.fn(() => child)
      const res = await spawnDaemonAndWait(['node', '--sea-gateway', '--port', '18977'], async () => null, fakeSpawn, 1)
      expect(res).toBeNull()
      // CORRECT-07 契约：daemon 崩溃/启动报错由 daemon 侧 fd 2 接管自写日志（cli.ts --sea-gateway 分支），
      // 父进程 stdio 全 ignore 且不给 child.stderr 挂任何监听——否则读端 flowing 态把事件循环钉住
      expect(fakeSpawn).toHaveBeenCalledWith(
        'node',
        ['--sea-gateway', '--port', '18977'],
        expect.objectContaining({ detached: true, stdio: ['ignore', 'ignore', 'ignore'] })
      )
      expect(stderrOn).not.toHaveBeenCalled()
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

// ── stderr 接管按流形态分流（cruise1112 stderr 误绑修复）────────────────────
// 修复船 4 发现：管道 stderr（net.Socket）形态下旧实现拿 stale.constructor 误当
// SyncWriteStream 重绑，下游 console.error 在 Node Console 的 finally removeListener
// 上同步炸 → cli.ts 顶层 .catch 再炸 → unhandledRejection → exit 0 静默。

/** 名字伪装成 SyncWriteStream 的构造器（分流判定只认 constructor.name），并记录构造入参 */
function namedSyncWriteStreamCtor(throwInCtor = false): (new (fd: number, opts?: { autoClose?: boolean }) => { write(): boolean }) & { lastArgs?: unknown[] } {
  const cls = class FakeSyncWrite {
    static lastArgs: unknown[] = []
    fd: number
    constructor(fd: number, opts?: { autoClose?: boolean }) {
      cls.lastArgs = [fd, opts]
      this.fd = fd
      if (throwInCtor) throw new Error('boom-from-ctor')
    }
    write(): boolean {
      return true
    }
  }
  Object.defineProperty(cls, 'name', { value: 'SyncWriteStream' })
  return cls as unknown as (new (fd: number, opts?: { autoClose?: boolean }) => { write(): boolean }) & { lastArgs?: unknown[] }
}

function tempLogPath(): string {
  return path.join(os.tmpdir(), `md-stderr-rebind-${process.pid}-${Date.now()}.log`)
}

describe('buildStderrReplacementStream：按原 stderr 流形态分流（绝不抛）', () => {
  it('SyncWriteStream 形态（stdio ignore/文件重定向）：复用其构造器绑日志 fd，duck=false', () => {
    const ctor = namedSyncWriteStreamCtor()
    const { stream, duck } = buildStderrReplacementStream(7, ctor)
    expect(duck).toBe(false)
    expect(stream).toBeInstanceOf(ctor)
    expect(ctor.lastArgs).toEqual([7, { autoClose: false }])
  })

  it('net.Socket 形态（管道 stderr）：走鸭子流，绝不复用 Socket 构造器', () => {
    class Socket {
      write(): boolean {
        return true
      }
    }
    const { stream, duck } = buildStderrReplacementStream(7, Socket)
    expect(duck).toBe(true)
    expect(stream).not.toBeInstanceOf(Socket)
  })

  it('构造器抛错（名为 SyncWriteStream）：降级鸭子流，不向上抛', () => {
    const ctor = namedSyncWriteStreamCtor(true)
    const { stream, duck } = buildStderrReplacementStream(7, ctor)
    expect(duck).toBe(true)
    expect(typeof stream.write).toBe('function')
  })

  it('鸭子流：write 落盘 + Console 监听面齐备——console.error 不再炸 removeListener（回归钉）', () => {
    const logPath = tempLogPath()
    const fd = fs.openSync(logPath, 'a')
    try {
      class Socket {
        write(): boolean {
          return true
        }
      }
      const { stream, duck } = buildStderrReplacementStream(fd, Socket)
      expect(duck).toBe(true)
      // Node Console[kWriteToConsole] 每次 write 都跑「listenerCount→once→finally removeListener」，
      // 缺任一方法 console.error 自身同步抛（Node 24 实证）——鸭子流必须补齐最小监听面
      const c = new Console({ stdout: process.stdout, stderr: stream as unknown as NodeJS.WritableStream })
      expect(() => c.error('duck-console-line')).not.toThrow()
      expect(stream.listenerCount('error')).toBe(0)
      expect(() => {
        stream.once('error', () => {})
        stream.removeListener('error', () => {})
      }).not.toThrow()
      // fs.writeSync 直写无缓冲：落盘可同步断言
      stream.write('duck-direct-line')
      const content = fs.readFileSync(logPath, 'utf8')
      expect(content).toContain('duck-console-line')
      expect(content).toContain('duck-direct-line')
    } finally {
      fs.closeSync(fd)
      try {
        fs.unlinkSync(logPath)
      } catch {
        /* Windows 句柄延迟释放时容忍残留（tmpdir） */
      }
    }
  })

  it('鸭子流写入已关闭的 fd：返回 false 不抛（降级语义）', () => {
    const logPath = tempLogPath()
    const fd = fs.openSync(logPath, 'a')
    fs.closeSync(fd)
    try {
      const { stream, duck } = buildStderrReplacementStream(fd, undefined)
      expect(duck).toBe(true)
      expect(stream.write('x')).toBe(false)
    } finally {
      try {
        fs.unlinkSync(logPath)
      } catch {
        /* 容忍残留（tmpdir） */
      }
    }
  })
})


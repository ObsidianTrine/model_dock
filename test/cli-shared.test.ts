import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
// 注意：本项目 vitest isolate:false（singleFork，模块/mock 注册表全进程共享）。
// 四个共享原语都经 child_process 执行——这里【不】用 vi.mock('node:child_process')（会全局污染
// 其它测试文件），而是给每个原语注入 fake 执行器（spawnFn / spawnSyncFn）验证「命令拼装 / 超时 kill」，
// 绝不真起 daemon / 绝不真杀进程。
import {
  killByPid,
  openUrlInBrowser,
  parsePidCommandLines,
  spawnDaemonAndWait,
} from '../src/cli/shared.js'
import { osaAdminRun } from '../src/cliinstall.js'

const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 读源码文本做结构断言：这些共享原语必须收敛进 shared.ts，调用方不得各自内联。 */
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(WORKTREE_ROOT, 'src', rel), 'utf8')
}

/** 造一个可控假子进程（仿 spawn 返回值的最小表面：on/unref/kill）。 */
function fakeChild() {
  const c = new EventEmitter() as any
  c.unref = vi.fn()
  c.kill = vi.fn(() => true)
  return c
}

describe('DUP-01 结构断言：原语收敛进 shared.ts', () => {
  // cli.ts / gatewaycmd.ts 曾各自复制「win 用 cmd start 空标题占位开浏览器」技巧
  it("浏览器打开：`'/c', 'start'` 只留在 shared，cli.ts / gatewaycmd.ts 不再内联", () => {
    expect(readSrc('cli/shared.ts')).toContain(`'/c', 'start'`)
    for (const rel of ['cli.ts', 'cli/gatewaycmd.ts']) {
      expect(readSrc(rel)).not.toContain(`'/c', 'start'`)
    }
  })
  it('进程行解析正则 (\\d+)\\s+(.*) 只留在 shared，gatewaycmd / update install 不再重复', () => {
    const sub = '(\\d+)\\s+(.*)$'
    expect(readSrc('cli/shared.ts')).toContain(sub)
    for (const rel of ['cli/gatewaycmd.ts', 'update/install.ts']) {
      expect(readSrc(rel)).not.toContain(sub)
    }
  })
  it("守护进程拉起统一走 spawnDaemonAndWait：cli.ts / gatewaycmd.ts 不再各自内联 20×250ms 轮询", () => {
    const pollLoop = /for \(let i = 0; i < 20; i\+\+\)/
    for (const rel of ['cli.ts', 'cli/gatewaycmd.ts']) {
      expect(readSrc(rel)).not.toMatch(pollLoop)
    }
    expect(readSrc('cli/shared.ts')).toContain('spawnDaemonAndWait')
  })
})

describe('parsePidCommandLines（纯函数，无副作用）', () => {
  it('解析 "pid command" 行；空白/非法行容错跳过', () => {
    const out = parsePidCommandLines('12345 node src/cli.ts --sea-gateway\n  678 rest of the line\n\nnot-a-line\n')
    expect(out).toEqual([
      { pid: 12345, cmd: 'node src/cli.ts --sea-gateway' },
      { pid: 678, cmd: 'rest of the line' },
    ])
  })
  it('空输入返回空数组', () => {
    expect(parsePidCommandLines('')).toEqual([])
  })
})

describe('killByPid 平台分支（注入 fake spawnSync，桩验命令拼装，绝不真杀进程）', () => {
  it('win32：走 taskkill /PID /F /T（整棵进程树）', () => {
    const plat = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const kill = vi.spyOn(process, 'kill')
    const fakeSpawnSync = vi.fn()
    try {
      killByPid(42, fakeSpawnSync)
      expect(fakeSpawnSync).toHaveBeenCalledWith('taskkill', ['/PID', '42', '/F', '/T'], expect.objectContaining({ stdio: 'ignore' }))
      expect(kill).not.toHaveBeenCalled()
    } finally {
      plat.mockRestore()
      kill.mockRestore()
    }
  })
  it('win32 + tree:false：只杀该进程本身，不带 /T（更新流程停托盘用——更新器是托盘的子进程，树杀会自杀）', () => {
    const plat = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const fakeSpawnSync = vi.fn()
    try {
      killByPid(42, fakeSpawnSync, { tree: false })
      expect(fakeSpawnSync).toHaveBeenCalledWith('taskkill', ['/PID', '42', '/F'], expect.objectContaining({ stdio: 'ignore' }))
    } finally {
      plat.mockRestore()
    }
  })
  it('unix：走 process.kill(pid, SIGTERM)，不调 taskkill', () => {
    const plat = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {})
    const fakeSpawnSync = vi.fn()
    try {
      killByPid(7, fakeSpawnSync)
      expect(kill).toHaveBeenCalledWith(7, 'SIGTERM')
      expect(fakeSpawnSync).not.toHaveBeenCalled()
    } finally {
      plat.mockRestore()
      kill.mockRestore()
    }
  })
})

describe('openUrlInBrowser（注入 fake spawn，桩验命令拼装，绝不真开浏览器）', () => {
  it('spawn 失败（如系统无 xdg-open 的 async error）返回 false 不抛异常', async () => {
    const plat = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const fakeSpawn = vi.fn(() => {
      const child = fakeChild()
      process.nextTick(() => child.emit('error', new Error('ENOENT')))
      return child
    })
    try {
      await expect(openUrlInBrowser('http://127.0.0.1:1/x', fakeSpawn)).resolves.toBe(false)
      expect(fakeSpawn).toHaveBeenCalledWith('xdg-open', ['http://127.0.0.1:1/x'], expect.objectContaining({ detached: true }))
    } finally {
      plat.mockRestore()
    }
  })
  it('spawn 成功（spawn 事件）返回 true', async () => {
    const plat = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const fakeSpawn = vi.fn(() => {
      const child = fakeChild()
      process.nextTick(() => child.emit('spawn'))
      return child
    })
    try {
      await expect(openUrlInBrowser('http://127.0.0.1:1/y', fakeSpawn)).resolves.toBe(true)
      expect(fakeSpawn).toHaveBeenCalledWith('open', ['http://127.0.0.1:1/y'], expect.anything())
    } finally {
      plat.mockRestore()
    }
  })
})

describe('DUP-01 拉起守护进程（注入 fake spawn + 探活，绝不真起 daemon）', () => {
  it('轮询到活网关返回状态；未活返回 null，且 spawn 参数原样传递', async () => {
    let call = 0
    const fakeSpawn = vi.fn(() => fakeChild())
    const res = await spawnDaemonAndWait(
      ['node', '--sea-gateway', '--port', '9999'],
      async () => {
        call++
        // 第一次轮询不活，第二次活 → 触发超时循环提前退出
        if (call === 2) return { port: 9999, pid: 5, admin_token: 'x', started_at: '' } as any
        return null
      },
      fakeSpawn
    )
    expect(res).toEqual(expect.objectContaining({ port: 9999 }))
    expect(fakeSpawn).toHaveBeenCalledWith('node', ['--sea-gateway', '--port', '9999'], expect.objectContaining({ detached: true, stdio: 'ignore' }))
  })
})

describe('DESIGN-13 提权弹窗超时终止（osaAdminRun，注入 fake spawn）', () => {
  it('signal abort 时 kill 掉 osascript 子进程并 resolve false', async () => {
    const ac = new AbortController()
    const child = fakeChild()
    const fakeSpawn = vi.fn(() => child)
    const p = osaAdminRun('do shell script "x"', ac.signal, fakeSpawn)
    ac.abort()
    await expect(p).resolves.toBe(false)
    expect(child.kill).toHaveBeenCalled()
    expect(fakeSpawn).toHaveBeenCalledWith('osascript', ['-e', 'do shell script "x"'], expect.anything())
  })
  it('signal 未传入时不受控（行为不变，正常 resolve）', async () => {
    const child = fakeChild()
    const fakeSpawn = vi.fn(() => {
      process.nextTick(() => child.emit('close', 0))
      return child
    })
    await expect(osaAdminRun('do shell script "y"', undefined, fakeSpawn)).resolves.toBe(true)
  })
})
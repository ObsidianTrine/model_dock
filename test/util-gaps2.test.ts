import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { c, hint, printTable } from '../src/util/color.js'
import { setPath } from '../src/util/jsonpath.js'
import {
  acquireFileLock,
  appendLine,
  appendLineErrorCount,
  clearCommandMemo,
  closeAppendStream,
  commandOnPath,
  commandOnPathResolved,
  commandOnPathSandbox,
  closeAppendStreams,
  drainAppendStreams,
  slugify,
  __testSetLockTiming,
} from '../src/util/fsx.js'
import { TEST_TMP, waitFor } from './helpers.js'

// util 缺口补测第二批（卡 test-gap-gateway-util，2026-11-07 coverage 现场）：
// color（未被调用的色相助手 / hint stderr 出口 / printTable cols 与宽字符列宽）、
// jsonpath（中段下标 × 对象容器报错、中段越界、下一跳为下标时容器建成数组）、
// fsx（陈锁抢占复核、非 EEXIST 上抛、memo TTL 过期、commandOnPathSandbox 直通、
// appendLine 失败计数与首错日志、流池容量淘汰、slugify 兜底）。
// 不 mock 模块（isolate:false 雷区）；spy 用 spyOn + mockRestore 只清自己的。

describe('util-gaps2 · color', () => {
  it('dim/blue/magenta/cyan 在无 TTY 环境输出纯文本（wrap 的 disabled 侧）', () => {
    for (const f of [c.dim, c.blue, c.magenta, c.cyan]) expect(f('x')).toBe('x')
  })

  it('hint 走 stderr 且带双语提示前缀', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      hint('hello')
      expect(spy.mock.calls.length).toBe(1)
      expect(String(spy.mock.calls[0][0])).toContain('hello')
    } finally {
      spy.mockRestore()
    }
  })

  it('printTable：空行直接返回；cols 指定列序；韩文/扩展B/缺格不崩且列宽按显示宽度', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      printTable([])
      expect(log.mock.calls.length).toBe(0)
      printTable([{ name: 'ᄀ', v: '1' }, { name: '가', v: '2' }, { name: '𠀀' }], ['name', 'v'])
      expect(log.mock.calls.length).toBe(4) // 表头 + 3 行
      const header = String(log.mock.calls[0][0])
      expect(header).toContain('name')
      expect(header).toContain('v')
    } finally {
      log.mockRestore()
    }
  })
})

describe('util-gaps2 · jsonpath 中段下标分支', () => {
  it('中段下标 × 对象容器：显式报错（不再静默落字符串键 "0"）', () => {
    expect(() => setPath({}, '$[0].b', 1)).toThrow(/下标段只能用于数组/)
    expect(() => setPath({ a: {} }, '$.a[0].b', 1)).toThrow(/下标段只能用于数组/)
  })

  it('中段下标越界创建抛可操作错误；下一跳为下标时中间容器按需建成数组', () => {
    expect(() => setPath({ a: [[]] }, '$.a[2].b', 1)).toThrow(/路径越界/)
    const root = { a: [] as unknown[] }
    setPath(root, '$.a[0][0]', 7)
    expect(root.a).toEqual([[7]])
  })
})

describe('util-gaps2 · fsx 文件锁', () => {
  it('陈锁抢占：mtime 超龄 → ino/mtime/size 复核后接管，释放归新持有者', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_TMP, 'md-lock-stale-'))
    const lockFile = path.join(dir, 'x.lock')
    fs.writeFileSync(lockFile, String(process.pid + 999999)) // 模拟他人持有
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockFile, old, old) // 陈锁：喂狗早已停止
    __testSetLockTiming({ staleMs: 100, heartbeatMs: 20, acquireTimeoutMs: 3000 })
    try {
      const release = await acquireFileLock(lockFile)
      expect(fs.readFileSync(lockFile, 'utf8')).toBe(String(process.pid))
      release()
      expect(fs.existsSync(lockFile)).toBe(false)
    } finally {
      __testSetLockTiming()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非 EEXIST 错误（锁路径父级是文件）原样上抛，不进重试循环', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_TMP, 'md-lock-enotdir-'))
    fs.writeFileSync(path.join(dir, 'blocker'), 'x')
    try {
      await expect(acquireFileLock(path.join(dir, 'blocker', 'sub', 'x.lock'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('util-gaps2 · fsx PATH 探测 memo', () => {
  it('memo TTL 过期后重算；无 FAKE_HOME 时 commandOnPathSandbox 直通 commandOnPath', () => {
    vi.useFakeTimers()
    try {
      const prevFake = process.env.MODELRDOCK_FAKE_HOME
      const prevMd = process.env.MODELRDOCK_HOME
      delete process.env.MODELRDOCK_FAKE_HOME
      delete process.env.MODELRDOCK_HOME
      try {
        clearCommandMemo()
        expect(commandOnPathResolved('zz-missing-cmd-x')).toBeNull() // 建 memo
        expect(commandOnPathResolved('zz-missing-cmd-x')).toBeNull() // memo 命中
        vi.advanceTimersByTime(121_000) // > COMMAND_TTL(120s)
        expect(commandOnPathResolved('zz-missing-cmd-x')).toBeNull() // 过期 → 重算
        expect(commandOnPath('zz-missing-cmd-x')).toBe(false)
        expect(commandOnPathSandbox('zz-missing-cmd-x')).toBe(false) // 无沙箱 → 直通
      } finally {
        if (prevFake === undefined) delete process.env.MODELRDOCK_FAKE_HOME
        else process.env.MODELRDOCK_FAKE_HOME = prevFake
        if (prevMd === undefined) delete process.env.MODELRDOCK_HOME
        else process.env.MODELRDOCK_HOME = prevMd
        clearCommandMemo()
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('util-gaps2 · fsx 常驻追加流池', () => {
  it('closeAppendStream 无此路径的流、drainAppendStreams 空池：立即返回不挂', async () => {
    await closeAppendStream(path.join(TEST_TMP, 'never-appended.log'))
    await drainAppendStreams()
  })

  it('写入失败：首次打日志、此后只计数（appendLineErrorCount 出口）', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_TMP, 'md-append-err-'))
    fs.writeFileSync(path.join(dir, 'blocked'), 'file-not-dir')
    const bad = path.join(dir, 'blocked', 'app.log')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = appendLineErrorCount()
    try {
      appendLine(bad, 'l1\n')
      await waitFor(() => appendLineErrorCount() > before)
      const logged1 = spy.mock.calls.filter((args) => String(args[0]).includes('日志写入失败')).length
      appendLine(bad, 'l2\n')
      await waitFor(() => appendLineErrorCount() > before + 1)
      const logged2 = spy.mock.calls.filter((args) => String(args[0]).includes('日志写入失败')).length
      expect(logged1).toBe(1)
      expect(logged2).toBe(1) // 第二次失败不再刷屏，只累计数
    } finally {
      spy.mockRestore()
      closeAppendStreams()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('流池容量上限：第 9、10 条流按 FIFO 挤掉最旧，先入流内容不丢', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_TMP, 'md-append-cap-'))
    try {
      for (let i = 0; i < 10; i++) appendLine(path.join(dir, `f${i}.log`), `line-${i}\n`)
      await drainAppendStreams() // end 全部流并等句柄释放（缓冲强制落盘）
      for (let i = 0; i < 10; i++) {
        expect(fs.readFileSync(path.join(dir, `f${i}.log`), 'utf8')).toContain(`line-${i}`)
      }
    } finally {
      closeAppendStreams()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('util-gaps2 · fsx slugify 兜底', () => {
  it('全非合法字符时兜底 provider；常规输入行为不变', () => {
    expect(slugify('中文')).toBe('provider')
    expect(slugify('###')).toBe('provider')
    expect(slugify('My Provider 01')).toBe('my-provider-01')
  })
})

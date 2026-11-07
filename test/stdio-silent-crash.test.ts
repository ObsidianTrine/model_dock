// 2026-11-07 生产事故回归（托盘拉起的 daemon 一键接入 Claude Code 时零痕迹静默死亡）：
// ① crash 处理器 console.error 在前、appendCrashLog 在后——stderr 坏流把崩溃文件一起吞掉；
// ② cliVersion 用 args+shell 组合触发 DEP0190 弃用警告写 stderr——接入计划全链路唯一 spawn，
//    在损坏 stdio 形态下这条写入即进程死亡点；
// ③ stdio 写错误无人监听时以 error 事件炸掉进程——daemon 启动须挂兜底。
// 三个修复各一条回归用例，纯文件/流断言，不 mock 模块（vitest 单 fork 共享模块态；
// spy 只清自己的，不用 restoreAllMocks——见 AGENTS vitest 隔离模型）。
import { describe, expect, it, afterEach, afterAll, beforeAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { reportCrash } from '../src/util/crash.js'
import { logsDir } from '../src/util/paths.js'
import { cliVersion } from '../src/adapters/presence.js'
import { defuseStdioErrors } from '../src/cli/shared.js'

// ---------- reportCrash：先落盘后 console ----------

describe('reportCrash（崩溃上报顺序）', () => {
  const h = fakeHome()
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  // 落点经 logsDir() 计算（FAKE_HOME 下 = <fake>/.modeldock/logs），不手拼层级
  const crashFile = path.join(logsDir(), `crash-${ymd}.log`)
  let errSpy: ReturnType<typeof vi.spyOn> | undefined

  afterEach(() => {
    errSpy?.mockRestore()
    errSpy = undefined
  })
  afterAll(() => h.restore())

  it('console.error 抛错（stderr 坏流）时崩溃文件仍先落盘、reportCrash 不上抛', () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('EBADF: broken stderr')
    })
    expect(() => reportCrash('uncaughtException', 'boom-stack')).not.toThrow()
    expect(fs.existsSync(crashFile)).toBe(true)
    expect(fs.readFileSync(crashFile, 'utf8')).toContain('uncaughtException: boom-stack')
  })

  it('正常 stderr：console.error 仍收到 [modeldock] 前缀文本（前台可见性不回退），文件同步落盘', () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    reportCrash('unhandledRejection', 'reason-x')
    expect(errSpy).toHaveBeenCalledWith('[modeldock] unhandledRejection: reason-x')
    expect(fs.readFileSync(crashFile, 'utf8')).toContain('unhandledRejection: reason-x')
  })
})

// ---------- cliVersion：shell 形态不再触发 DEP0190 ----------

describe('cliVersion 版本探测（DEP0190 回归）', () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldock-cliv-'))
  let prevPath: string | undefined
  const cmdName = 'fakeclivx'

  beforeAll(() => {
    // 平台各自的可执行形态：win 是 .cmd 包装（正是旧实现需要 shell 的原因），unix 是 shebang 脚本
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDir, `${cmdName}.cmd`), '@echo 9.9.9\r\n')
    } else {
      const p = path.join(binDir, cmdName)
      fs.writeFileSync(p, '#!/bin/sh\necho 9.9.9\n')
      fs.chmodSync(p, 0o755)
    }
    prevPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`
  })
  afterAll(() => {
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    fs.rmSync(binDir, { recursive: true, force: true })
  })

  it('spawn <cmd> --version 不产生 DEP0190 警告，版本解析行为不变', async () => {
    let depFired = false
    const onWarn = (w: Error & { code?: string }): void => {
      if (w.code === 'DEP0190') depFired = true
    }
    process.on('warning', onWarn)
    try {
      const ver = await cliVersion(cmdName, cmdName)
      expect(ver).toBe('9.9.9')
    } finally {
      process.off('warning', onWarn)
    }
    expect(depFired).toBe(false)
  })
})

// ---------- defuseStdioErrors：stdio 写错误非致命 ----------

describe('defuseStdioErrors（stdio error 兜底）', () => {
  it('给 stdout/stderr 挂 error 监听且幂等（重复调用不堆监听）、自身不抛', () => {
    const outBefore = process.stdout.listenerCount('error')
    const errBefore = process.stderr.listenerCount('error')
    expect(() => defuseStdioErrors()).not.toThrow()
    expect(process.stdout.listenerCount('error')).toBe(outBefore + 1)
    expect(process.stderr.listenerCount('error')).toBe(errBefore + 1)
    expect(() => defuseStdioErrors()).not.toThrow()
    expect(process.stdout.listenerCount('error')).toBe(outBefore + 1)
    expect(process.stderr.listenerCount('error')).toBe(errBefore + 1)
  })
})

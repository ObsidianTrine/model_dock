import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fakeHome, REPO_ROOT, TSX_LOADER } from './helpers.js'
import { appendCrashLog } from '../src/util/crash.js'
import { assertNotRealHomeWrite, atomicWrite, inTestContext, shouldRetryAtomicWrite } from '../src/util/fsx.js'
import { logsDir } from '../src/util/paths.js'
import { maskSecret, printTable } from '../src/util/color.js'

/** 子进程端到端（进程级 handler 不能在同进程注册——会吞 vitest 自己的异常语义） */
const CRASH_TS = JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'src/util/crash.ts')).href)

function runChild(code: string, env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', TSX_LOADER, '--input-type=module', '-e', code], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('util 缺口补测（卡 34：coverage 现场 crash 25% / fsx 75% / color 80%）', () => {
  it('shouldRetryAtomicWrite：Windows rename 重试码表（EPERM/EACCES/EBUSY 重试，ENOENT 等直接失败）', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) expect(shouldRetryAtomicWrite(code)).toBe(true)
    for (const code of ['ENOENT', 'EISDIR', 'EINVAL', undefined]) expect(shouldRetryAtomicWrite(code)).toBe(false)
  })

  it('inTestContext：agent CLI 环境标记命中（ZCODE_*/CLAUDECODE），受信写者豁免口不在此覆盖', () => {
    const saved = ['VITEST', 'VITEST_WORKER_ID', 'MODELRDOCK_TEST', 'ZCODE_ENV', 'CLAUDECODE'].map((k) => [k, process.env[k]] as const)
    try {
      for (const [k] of saved) delete process.env[k]
      // 本会话（ZCode 内）env 自带其他 ZCODE_* 标记：按 fsx 源清单逐个移除再断言
      for (const k of ['ZCODE_APP_VERSION', 'ZCODE_ENV', 'ZCODE_RUNTIME_ENV', 'ZCODE_PROCESS_LABEL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete process.env[k]
      process.env.ZCODE_ENV = '1'
      expect(inTestContext()).toBe(true) // agent 标记单独成立
      delete process.env.ZCODE_ENV
      process.env.CLAUDECODE = '1'
      expect(inTestContext()).toBe(true)
      delete process.env.CLAUDECODE
      for (const k of ['ZCODE_APP_VERSION', 'ZCODE_ENV', 'ZCODE_RUNTIME_ENV', 'ZCODE_PROCESS_LABEL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete process.env[k]
      expect(inTestContext()).toBe(false) // 全部标记移除后为假
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('assertNotRealHomeWrite：MODELRDOCK_HOME 下的目标被拒且报错可操作；豁免开关放行；沙箱外目标放行', () => {
    const h = fakeHome()
    const savedHome = process.env.MODELRDOCK_HOME
    const savedAllow = process.env.MODELRDOCK_ALLOW_REAL_HOME_WRITE
    try {
      const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'realhome-'))
      process.env.MODELRDOCK_HOME = realHome
      const target = path.join(realHome, 'config.toml')
      expect(() => assertNotRealHomeWrite(target)).toThrow(/真实 home/)
      expect(() => assertNotRealHomeWrite(target.toUpperCase())).toThrow(/真实 home/) // win32 大小写绕过同拦
      process.env.MODELRDOCK_ALLOW_REAL_HOME_WRITE = '1'
      expect(() => assertNotRealHomeWrite(target)).not.toThrow()
      delete process.env.MODELRDOCK_ALLOW_REAL_HOME_WRITE
      expect(() => assertNotRealHomeWrite(path.join(os.tmpdir(), 'elsewhere.toml'))).not.toThrow()
      fs.rmSync(realHome, { recursive: true, force: true })
    } finally {
      if (savedHome === undefined) delete process.env.MODELRDOCK_HOME
      else process.env.MODELRDOCK_HOME = savedHome
      if (savedAllow === undefined) delete process.env.MODELRDOCK_ALLOW_REAL_HOME_WRITE
      else process.env.MODELRDOCK_ALLOW_REAL_HOME_WRITE = savedAllow
      h.restore()
    }
  })

  it('appendCrashLog：日志路径被文件占用时静默放弃（崩中崩不抛）', () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(path.dirname(logsDir()), { recursive: true })
      fs.writeFileSync(logsDir(), 'not a dir') // logsDir() 落点是一个文件：mkdirSync 必败
      expect(() => appendCrashLog('boom in broken dir')).not.toThrow()
    } finally {
      h.restore()
    }
  })

  it('installCrashHandlers 端到端（子进程）：uncaughtException 落盘后 exit 1', () => {
    const h = fakeHome()
    try {
      const child = runChild(
        `
        const { installCrashHandlers } = await import(${CRASH_TS});
        installCrashHandlers();
        setTimeout(() => { throw new Error('e2e-uncaught') }, 50);
        `,
        { MODELRDOCK_FAKE_HOME: process.env.MODELRDOCK_FAKE_HOME ?? '' }
      )
      expect(child.status).toBe(1)
      const files = fs.existsSync(logsDir()) ? fs.readdirSync(logsDir()).filter((f) => f.startsWith('crash-')) : []
      expect(files.length).toBeGreaterThan(0)
      const text = fs.readFileSync(path.join(logsDir(), files[0]), 'utf8')
      expect(text).toContain('uncaughtException')
      expect(text).toContain('e2e-uncaught')
    } finally {
      h.restore()
    }
  })

  it('installCrashHandlers 端到端（子进程）：unhandledRejection 只留痕不退出', () => {
    const h = fakeHome()
    try {
      const child = runChild(
        `
        const { installCrashHandlers } = await import(${CRASH_TS});
        installCrashHandlers();
        void Promise.reject(new Error('e2e-rejection'));
        setTimeout(() => { console.log('still-alive'); process.exit(0) }, 300);
        `,
        { MODELRDOCK_FAKE_HOME: process.env.MODELRDOCK_FAKE_HOME ?? '' }
      )
      expect(child.status).toBe(0)
      expect(child.stdout).toContain('still-alive')
      const files = fs.existsSync(logsDir()) ? fs.readdirSync(logsDir()).filter((f) => f.startsWith('crash-')) : []
      expect(files.length).toBeGreaterThan(0)
      const text = fs.readFileSync(path.join(logsDir(), files[0]), 'utf8')
      expect(text).toContain('unhandledRejection')
      expect(text).toContain('e2e-rejection')
    } finally {
      h.restore()
    }
  })

  it('maskSecret 三档：null → 未设置、短凭据整段隐藏、长凭据首尾保留', () => {
    expect(maskSecret(null)).toContain('未设置')
    expect(maskSecret('short')).toBe('***')
    expect(maskSecret('sk-abcdefghijklmnopqrst')).toBe('sk-a…qrst')
  })

  it('printTable：CJK 与 ANSI 混排列宽不崩、单元格齐全', () => {
    const rows = [
      { name: '服务甲', key: '\x1b[31mred\x1b[0m' },
      { name: 'svc-b', key: 'plain' },
    ]
    const logs: string[] = []
    const orig = console.log
    console.log = (s: string) => logs.push(s)
    try {
      printTable(rows, ['name', 'key'])
    } finally {
      console.log = orig
    }
    expect(logs).toHaveLength(3)
    expect(logs.join('\n')).toContain('服务甲')
    expect(logs.join('\n')).toContain('svc-b')
  })

  it('atomicWrite 冒烟：内容落盘、目录自建（重试循环的真实路径护栏）', async () => {
    const h = fakeHome()
    try {
      const file = path.join(logsDir(), 'sub', 'w.txt')
      await atomicWrite(file, 'hello')
      expect(fs.readFileSync(file, 'utf8')).toBe('hello')
      await atomicWrite(file, 'world') // 覆盖写走 rename 分支
      expect(fs.readFileSync(file, 'utf8')).toBe('world')
      expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toHaveLength(0) // 无残留 tmp
    } finally {
      h.restore()
    }
  })
})

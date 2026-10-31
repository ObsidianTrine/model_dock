import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEST_TMP } from './helpers.js'
import { __testSetTrustedRealHomeWriter, atomicWrite, withFileLock } from '../src/util/fsx.js'

/**
 * 真实 home 写入门禁（2026-10-05 / 2026-10-30 两次生产覆盖事故防线）：
 * 测试/agent 上下文进程对真实 home 的 atomicWrite / withFileLock 一律拒绝。
 *
 * 「真实 home 替身」技巧：门禁的 realModeldockDir 也认 MODELRDOCK_HOME——把它指到临时目录，
 * 拦截与放行断言全部落在这替身上，本文件对真正的 ~/.modeldock 零写入（AGENTS.md 红线）。
 */

// vitest worker 天然注入 VITEST=true，门禁在套件内全程武装；此处自证前提，防 vitest 未来
// 改名让全部用例空转成假绿
if (process.env.VITEST !== 'true') throw new Error('realhome-write-guard 测试要求 VITEST env（vitest worker 注入）')

/** 上下文标记（门禁判「是不是测试/agent 进程」的依据）：clearContextEnv 只清这些——
 *  绝不能碰 MODELRDOCK_FAKE_HOME/MODELRDOCK_HOME，否则「真实 home 替身」失效、门禁的
 *  保护目标跟着漂移，用例假绿（实测踩中）。 */
const CONTEXT_MARKERS = [
  'VITEST',
  'VITEST_WORKER_ID',
  'MODELRDOCK_TEST',
  'ZCODE_APP_VERSION',
  'ZCODE_ENV',
  'ZCODE_RUNTIME_ENV',
  'ZCODE_PROCESS_LABEL',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
] as const

/** 上下文判定相关的全部 env（含 T29 的 agent CLI 标记——本套件自身可能跑在 ZCode 会话里，
 *  「模拟生产进程」的用例必须把这些一并清掉才成立）。 */
const ENV_KEYS = [
  ...CONTEXT_MARKERS,
  'MODELRDOCK_FAKE_HOME',
  'MODELRDOCK_HOME',
  'MODELRDOCK_ALLOW_REAL_HOME_WRITE',
] as const
const savedEnv: Record<string, string | undefined> = {}

function stashEnv(): void {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
}

/** 清掉上下文标记，模拟「无任何标记的生产进程」（home 重定向变量保留：替身不失效） */
function clearContextEnv(): void {
  for (const k of CONTEXT_MARKERS) delete process.env[k]
}

/** 建一个「真实 home 替身」：MODELRDOCK_HOME 指向临时目录（门禁据此判真实 home），返回替身下
 *  的 .modeldock 路径。替身由调用方收尾删除。 */
function makeFakeRealHome(): string {
  const standIn = fs.mkdtempSync(path.join(TEST_TMP, 'modeldock-realhome-'))
  delete process.env.MODELRDOCK_FAKE_HOME
  process.env.MODELRDOCK_HOME = standIn
  return path.join(standIn, '.modeldock')
}

describe('真实 home 写入门禁（fsx 漏斗）', () => {
  it('测试上下文 + 未设 FAKE_HOME：atomicWrite 拒写且连目录创建都不发生', async () => {
    stashEnv()
    try {
      const md = makeFakeRealHome()
      await expect(atomicWrite(path.join(md, 'config.toml'), 'x')).rejects.toThrow(/MODELRDOCK_FAKE_HOME/)
      expect(fs.existsSync(md)).toBe(false) // 门禁在 ensureDir 之前：目录都不许建
    } finally {
      restoreEnv()
    }
  })

  it('MODELRDOCK_ALLOW_REAL_HOME_WRITE=1 显式豁免放行', async () => {
    stashEnv()
    try {
      const md = makeFakeRealHome()
      process.env.MODELRDOCK_ALLOW_REAL_HOME_WRITE = '1'
      await expect(atomicWrite(path.join(md, 'config.toml'), 'x')).resolves.toBeUndefined()
      expect(fs.existsSync(path.join(md, 'config.toml'))).toBe(true)
    } finally {
      restoreEnv()
    }
  })

  it('非 vitest 进程的显式标记 MODELRDOCK_TEST=1 同样触发门禁', async () => {
    stashEnv()
    try {
      const md = makeFakeRealHome()
      delete process.env.VITEST
      delete process.env.VITEST_WORKER_ID
      process.env.MODELRDOCK_TEST = '1'
      await expect(atomicWrite(path.join(md, 'config.toml'), 'x')).rejects.toThrow(/MODELRDOCK_FAKE_HOME/)
    } finally {
      restoreEnv()
    }
  })

  it('非测试上下文（生产网关进程）：清掉全部上下文标记后一切照旧可写', async () => {
    stashEnv()
    try {
      const md = makeFakeRealHome()
      clearContextEnv() // 本套件可能跑在 ZCode 会话里：连 agent 标记一并清掉才是真·生产现场
      await expect(atomicWrite(path.join(md, 'config.toml'), 'x')).resolves.toBeUndefined()
    } finally {
      restoreEnv()
    }
  })

  it('agent CLI 环境标记（ZCode，本会话子进程实测）：即便无 vitest 标记也触发门禁（T29）', async () => {
    stashEnv()
    try {
      const md = makeFakeRealHome()
      clearContextEnv()
      process.env.ZCODE_APP_VERSION = '3.16.3'
      await expect(atomicWrite(path.join(md, 'config.toml'), 'x')).rejects.toThrow(/MODELRDOCK_FAKE_HOME/)
      expect(fs.existsSync(md)).toBe(false)
    } finally {
      restoreEnv()
    }
  })

  it('agent CLI 环境标记（Claude Code 文档口径）：CLAUDECODE=1 触发门禁（T29）', async () => {
    stashEnv()
    try {
      const md = makeFakeRealHome()
      clearContextEnv()
      process.env.CLAUDECODE = '1'
      await expect(atomicWrite(path.join(md, 'config.toml'), 'x')).rejects.toThrow(/MODELRDOCK_FAKE_HOME/)
    } finally {
      restoreEnv()
    }
  })

  it('受信写者（ModelDock 自家入口进程）：带 agent 标记也放行；复位后恢复拦截（T29）', async () => {
    stashEnv()
    try {
      const md = makeFakeRealHome()
      clearContextEnv()
      process.env.ZCODE_ENV = 'production' // 用户从 agent 集成终端手起网关的现场
      __testSetTrustedRealHomeWriter(true)
      try {
        await expect(atomicWrite(path.join(md, 'config.toml'), 'x')).resolves.toBeUndefined()
        expect(fs.existsSync(path.join(md, 'config.toml'))).toBe(true)
      } finally {
        __testSetTrustedRealHomeWriter(false)
      }
      await expect(atomicWrite(path.join(md, 'config.toml'), 'x')).rejects.toThrow(/MODELRDOCK_FAKE_HOME/)
    } finally {
      restoreEnv()
    }
  })

  it('沙箱内写不受限；但 FAKE_HOME 已设时字面量指向真实 home 仍被拦（防旁路）', async () => {
    stashEnv()
    try {
      const md = makeFakeRealHome()
      const sandbox = fs.mkdtempSync(path.join(TEST_TMP, 'modeldock-guard-sandbox-'))
      process.env.MODELRDOCK_FAKE_HOME = sandbox
      await expect(atomicWrite(path.join(sandbox, '.modeldock', 'config.toml'), 'x')).resolves.toBeUndefined()
      await expect(atomicWrite(path.join(md, 'config.toml'), 'x')).rejects.toThrow(/MODELRDOCK_FAKE_HOME/)
      fs.rmSync(sandbox, { recursive: true, force: true })
    } finally {
      restoreEnv()
    }
  })

  it('withFileLock 对真实 home 锁文件同样拒绝', async () => {
    stashEnv()
    try {
      const md = makeFakeRealHome()
      await expect(withFileLock(path.join(md, 'config.toml.lock'), undefined, async () => 1)).rejects.toThrow(
        /MODELRDOCK_FAKE_HOME/
      )
      expect(fs.existsSync(md)).toBe(false)
    } finally {
      restoreEnv()
    }
  })

  it('真实 home 判定回退 os.homedir()：无 MODELRDOCK_HOME 时门禁按 ~/.modeldock 计算', async () => {
    stashEnv()
    try {
      delete process.env.MODELRDOCK_HOME
      delete process.env.MODELRDOCK_FAKE_HOME
      // 不真正写 ~：用「路径相同即拒」的判定面——构造 homedir 下的探测路径，断言拒绝信息里带它
      const probe = path.join(os.homedir(), '.modeldock', '.guard-probe-never-written')
      await expect(atomicWrite(probe, 'x')).rejects.toThrow(/MODELRDOCK_FAKE_HOME/)
      expect(fs.existsSync(probe)).toBe(false)
    } finally {
      restoreEnv()
    }
  })
})

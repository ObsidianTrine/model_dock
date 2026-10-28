import path from 'node:path'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { fakeHome } from './helpers.js'
import { cmdSyncPause, cmdSyncResume, cmdSyncSetup, cmdSyncStatus } from '../src/cli/sync.js'
import { readSyncState, updateSyncState } from '../src/sync/state.js'

// sync CLI 壳：status/pause/resume 全路径进程内可测（只读写 sync.json，无网络）；
// setup 只覆盖 --target 非法值分支（合法分支会进 @inquirer 交互/口令 stdin，引擎本体由
// synctarget.test.ts / syncagent.test.ts 覆盖）。
class ExitError extends Error {
  constructor(public code: number | undefined) {
    super(`exit:${code}`)
  }
}

let logs: string[] = []
let errs: string[] = []
function capture(): void {
  logs = []
  errs = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '))
  })
}

afterEach(() => {
  vi.mocked(console.log).mockRestore?.()
  vi.mocked(console.error).mockRestore?.()
  vi.mocked(process.exit).mockRestore?.()
})

function stubExit(): void {
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code)
  }) as never)
}

describe('cmdSyncStatus', () => {
  it('未启用：提示 setup 入口', async () => {
    const h = fakeHome()
    capture()
    try {
      await cmdSyncStatus()
      expect(logs.join('\n')).toContain('未启用')
    } finally {
      h.restore()
    }
  })

  it('target 模式：显示目标、设备与 rev；暂停态给出 resume 指引', async () => {
    const h = fakeHome()
    capture()
    try {
      await updateSyncState({ mode: 'target', paused: false, target: { kind: 'localdir', dir: path.join(h.home, 'syncdir') } })
      await cmdSyncStatus()
      let out = logs.join('\n')
      expect(out).toContain('多机同步')
      expect(out).toContain('localdir')
      expect(out).toContain('本机设备')

      await updateSyncState({ paused: true, lastError: 'boom', lastConflictTs: '2026-10-12T00:00:00.000Z' })
      logs = []
      await cmdSyncStatus()
      out = logs.join('\n')
      expect(out).toContain('已暂停')
      expect(out).toContain('最近冲突')
      expect(out).toContain('boom')
    } finally {
      h.restore()
    }
  })
})

describe('cmdSyncPause / cmdSyncResume', () => {
  it('未启用时 pause/resume 都 exit(1) 并提示 setup', async () => {
    const h = fakeHome()
    stubExit()
    capture()
    try {
      await expect(cmdSyncPause()).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('未启用')
      errs = []
      await expect(cmdSyncResume()).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('未启用')
    } finally {
      h.restore()
    }
  })

  it('target 模式：pause 落盘 paused=true；重复 pause 幂等；resume 恢复并清 lastError', async () => {
    const h = fakeHome()
    capture()
    try {
      await updateSyncState({ mode: 'target', paused: false, target: { kind: 'localdir', dir: path.join(h.home, 'syncdir') }, lastError: 'e1' })
      await cmdSyncPause()
      expect((await readSyncState())?.paused).toBe(true)

      logs = []
      await cmdSyncPause()
      expect(logs.join('\n')).toContain('本来就是暂停状态')

      await cmdSyncResume()
      const st = await readSyncState()
      expect(st?.paused).toBe(false)
      expect(st?.lastError).toBeNull()

      logs = []
      await cmdSyncResume()
      expect(logs.join('\n')).toContain('不在暂停状态')
    } finally {
      h.restore()
    }
  })
})

describe('cmdSyncSetup 参数校验', () => {
  it('--target 非法值 exit(1)', async () => {
    const h = fakeHome()
    stubExit()
    capture()
    try {
      await expect(cmdSyncSetup({ target: 'ftp' })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('只支持 webdav 或 localdir')
    } finally {
      h.restore()
    }
  })

  it('webdav：地址为空 exit(1)（显式传参，不经交互）', async () => {
    // 注：只测空串——纯空白串在此分支漏检（sync.ts askTargetConfig 对显式传入的 o.url 不做
    // trim，与 dir/username 的写法不一致，疑似源码笔误，已记入交付说明另立卡）
    const h = fakeHome()
    stubExit()
    capture()
    try {
      await expect(cmdSyncSetup({ target: 'webdav', url: '', username: 'u', password: 'p' })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('地址不能为空')
    } finally {
      h.restore()
    }
  })

  it('webdav：用户名与密码为空 exit(1)', async () => {
    const h = fakeHome()
    stubExit()
    capture()
    try {
      await expect(cmdSyncSetup({ target: 'webdav', url: 'https://dav.example.com', dir: 'md', username: '', password: '' })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('用户名与密码不能为空')
    } finally {
      h.restore()
    }
  })

  it('localdir：目录为空 exit(1)', async () => {
    const h = fakeHome()
    stubExit()
    capture()
    try {
      await expect(cmdSyncSetup({ target: 'localdir', dir: '   ' })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('目录不能为空')
    } finally {
      h.restore()
    }
  })
})

// passphraseHint 等价类归 passphrase-hint.test.ts（曾在此双写，2026-10-21 去重删除；独有
// 的 'abcd123!@#' 用例已并入）。

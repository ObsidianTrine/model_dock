import path from 'node:path'
import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { fakeHome } from './helpers.js'
import { openEnvelope, sealEnvelope } from '../src/sync/crypto.js'
import { displayPath } from '../src/util/paths.js'
import { codexAdapter } from '../src/adapters/codex.js'
import { dshAdapter } from '../src/adapters/dsh.js'
import { runWithLang, setLang } from '../src/util/i18n.js'
import { UpdateError, validateAssetName } from '../src/update/check.js'

describe('quickwins 1: openEnvelope 复用 macKey', () => {
  const doc = { fmt: 'modeldock-syncdoc' as const, v: 1, ts: 't', data: { providers: {}, profiles: {} } }

  it('正确口令解密成功', () => {
    const env = sealEnvelope(doc as never, 'right')
    expect(openEnvelope(env as never, 'right')).toEqual(doc as never)
  })

  it('错误口令仍拒', () => {
    const env = sealEnvelope(doc as never, 'right')
    expect(() => openEnvelope(env as never, 'wrong')).toThrow(/口令不正确|incorrect/)
  })
})

describe('quickwins 2: config edit 引号', () => {
  // basic.ts 是「扇出很广」模块（AGENTS 已知踩雷点）：静态 import 会早于 uninstall.test 加载
  // 真实 gatewaycmd，破坏其 vi.mock（singleFork 共享注册表）。改用惰性 import，在 mock 已
  // hoist 后的运行期加载，互不干扰。
  async function loadQuoting() {
    return await import('../src/cli/basic.js')
  }

  it('quoteArg 始终加双引号', async () => {
    const { quoteArg } = await loadQuoting()
    expect(quoteArg('code')).toBe('"code"')
    expect(quoteArg('/a&b')).toBe('"/a&b"')
    expect(quoteArg('has space')).toBe('"has space"')
  })

  it('buildEditCmdline：code -w（无空格元字符路径）、含空格路径统统被引号包裹', async () => {
    const { buildEditCmdline } = await loadQuoting()
    expect(buildEditCmdline(['code', '-w'], '/Users/x/.modeldock/config.toml')).toBe(
      '"code" "-w" "/Users/x/.modeldock/config.toml"'
    )
    expect(buildEditCmdline(['code'], '/a&b/config.toml')).toBe('"code" "/a&b/config.toml"')
    expect(buildEditCmdline(['code'], '/dir with space/config.toml')).toBe('"code" "/dir with space/config.toml"')
  })
})

describe('quickwins 3: displayPath Windows 分隔符缩写', () => {
  it('home 下路径（含 \\ 与 /）缩写 ~ 前缀；home 外原样', () => {
    const home = '/home/user'
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home)
    try {
      expect(displayPath(home + '/x')).toBe('~' + '/x')
      expect(displayPath(home + '\\x')).toBe('~' + '\\x')
      expect(displayPath('/home/user/x')).toBe('~/x')
      expect(displayPath('/elsewhere/x')).toBe('/elsewhere/x')
      // path.join 在 win32 产反斜杠形态（\home\user\a\b），与 posix 形态的 mock home
      // 字面不相容——期望值按「缩写前缀 + 后缀原样保留」的平台无关语义计算
      const joined = path.join(home, 'a', 'b')
      expect(displayPath(joined)).toBe('~' + joined.slice(home.length))
    } finally {
      spy.mockRestore()
    }
  })
})

describe('quickwins 4: codex bootstrap.path 惰性', () => {
  it('MODELRDOCK_FAKE_HOME 下调用返回沙箱内路径（非模块加载固化路径）', () => {
    const h = fakeHome()
    try {
      const p = codexAdapter.install?.bootstrap?.path
      expect(typeof p).toBe('function')
      const resolved = (p as () => string)()
      expect(resolved.startsWith(h.home)).toBe(true)
      expect(resolved.endsWith(path.join('.codex', 'config.toml'))).toBe(true)
    } finally {
      h.restore()
    }
  })
})

describe('quickwins 5: dsh label i18n', () => {
  it('默认中文返回中文原文；en 返回英文', () => {
    setLang('zh')
    expect(dshAdapter.label).toBe('dsh（DeepSeek Harness）')
    runWithLang('en', () => {
      expect(dshAdapter.label).toBe('dsh (DeepSeek Harness)')
    })
  })
})

describe('quickwins 6: 更新资产名校验', () => {
  it('合法名通过不抛错', () => {
    expect(() => validateAssetName('modeldock-win-x64.exe')).not.toThrow()
    expect(() => validateAssetName('..hidden')).not.toThrow()
  })

  it.each(['../x', 'a/b', 'a\\b', '..'])('非法名 %s 抛 UpdateError 且提示可操作', (name) => {
    expect(() => validateAssetName(name)).toThrow(UpdateError)
  })

  it('报错文案双语完整', () => {
    setLang('zh')
    try {
      validateAssetName('../x')
    } catch (e) {
      expect((e as Error).message).toContain('..')
    }
    const en = runWithLang('en', () => {
      try {
        validateAssetName('../x')
      } catch (e) {
        return (e as Error).message
      }
      return ''
    })
    expect(en).toContain('..')
    expect(en).toMatch(/[A-Za-z]/)
  })
})
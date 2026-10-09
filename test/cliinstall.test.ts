import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import {
  cliBinDir,
  cliLinkPath,
  ensureCliInstalled,
  installByCopy,
  installBySymlink,
  preferInstalledCli,
  removeCliLink,
} from '../src/cliinstall.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bin-'))
}

describe('CLI 安装位解析', () => {
  it('MODELRDOCK_CLI_BIN_DIR 覆盖默认安装位（测试绝不碰真实 /usr/local/bin）', () => {
    const prev = process.env.MODELRDOCK_CLI_BIN_DIR
    try {
      delete process.env.MODELRDOCK_CLI_BIN_DIR
      if (process.platform === 'darwin') expect(cliBinDir()).toBe('/usr/local/bin')
      if (process.platform === 'linux') expect(cliBinDir()).toBeNull()
      const dir = tmpDir()
      process.env.MODELRDOCK_CLI_BIN_DIR = dir
      expect(cliBinDir()).toBe(dir)
      expect(cliLinkPath()).toBe(path.join(dir, process.platform === 'win32' ? 'modeldock.exe' : 'modeldock'))
    } finally {
      if (prev === undefined) delete process.env.MODELRDOCK_CLI_BIN_DIR
      else process.env.MODELRDOCK_CLI_BIN_DIR = prev
    }
  })
})

describe.skipIf(process.platform === 'win32')('installBySymlink（Windows 无软链权限，跳过）', () => {
  it('安装 → 幂等 current → 悬空自愈 → 普通文件替换', async () => {
    const h = fakeHome()
    try {
      const dir = tmpDir()
      const target = path.join(dir, 'real-bin')
      fs.writeFileSync(target, 'binary')
      const link = path.join(dir, 'modeldock')

      expect(await installBySymlink(link, target)).toBe('installed')
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(target))
      expect(await installBySymlink(link, target)).toBe('current')

      // 软链指向别处（app 挪窝后的旧链）→ 自愈重建
      const staleTarget = path.join(dir, 'stale')
      fs.writeFileSync(staleTarget, 'old')
      fs.rmSync(link)
      fs.symlinkSync(staleTarget, link)
      expect(await installBySymlink(link, target)).toBe('updated')
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(target))

      // 普通文件占用位置（老的手动 mv 安装）→ 替换为软链
      fs.rmSync(link)
      fs.writeFileSync(link, 'stale-file')
      expect(await installBySymlink(link, target)).toBe('updated')
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    } finally {
      h.restore()
    }
  })
})

describe('installByCopy', () => {
  it('复制 → 幂等 → 版本变化重拷', async () => {
    const h = fakeHome()
    try {
      const dir = tmpDir()
      const target = path.join(dir, 'modeldock-src.exe')
      const copy = path.join(dir, 'modeldock.exe')
      const marker = path.join(h.home, 'cli-copy-version')
      fs.writeFileSync(target, 'v1-body')

      expect(await installByCopy(copy, target, marker, '1.0.0')).toBe('installed')
      expect(fs.readFileSync(copy, 'utf8')).toBe('v1-body')
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe('1.0.0')

      expect(await installByCopy(copy, target, marker, '1.0.0')).toBe('current')

      fs.writeFileSync(target, 'v2-body-longer')
      expect(await installByCopy(copy, target, marker, '1.0.1')).toBe('updated')
      expect(fs.readFileSync(copy, 'utf8')).toBe('v2-body-longer')
    } finally {
      h.restore()
    }
  })
})

describe('preferInstalledCli（开机自启登记稳定路径）', () => {
  it('SEA 进程名才换链，npm/dev（node）不换；链接不存在不换', () => {
    const h = fakeHome()
    const prev = process.env.MODELRDOCK_CLI_BIN_DIR
    try {
      const dir = tmpDir()
      process.env.MODELRDOCK_CLI_BIN_DIR = dir
      // cliLinkPath 在 Windows 落 modeldock.exe：路径要与实现一致，否则 statSync 落空
      const link = path.join(dir, process.platform === 'win32' ? 'modeldock.exe' : 'modeldock')
      fs.writeFileSync(link, 'bin')

      // /Applications 里双击启动的 SEA：登记改走稳定链接
      expect(preferInstalledCli('/Applications/ModelDock.app/Contents/MacOS/ModelDock')).toBe(link)
      // npm / dev 调用（execPath 是 node）：不改变既有行为
      expect(preferInstalledCli('/usr/local/bin/node')).toBeNull()
      // 链接恰好就是运行位置：无需换
      expect(preferInstalledCli(link)).toBeNull()

      // 链接失效（app 挪窝后尚未重建）：不换
      fs.rmSync(link)
      expect(preferInstalledCli('/Applications/ModelDock.app/Contents/MacOS/ModelDock')).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.MODELRDOCK_CLI_BIN_DIR
      else process.env.MODELRDOCK_CLI_BIN_DIR = prev
      h.restore()
    }
  })
})

// macOS 上做一次端到端：重定向安装位后 ensure/remove 全链路（不碰真实 /usr/local/bin）
describe.skipIf(process.platform !== 'darwin')('ensureCliInstalled / removeCliLink（macOS 全链路）', () => {
  it('安装 → 幂等 → 摘除', async () => {
    const h = fakeHome()
    const prev = process.env.MODELRDOCK_CLI_BIN_DIR
    try {
      const dir = tmpDir()
      process.env.MODELRDOCK_CLI_BIN_DIR = dir
      const link = path.join(dir, 'modeldock')

      // vitest 的 execPath 是 node 二进制，真实存在，可直接作为软链目标
      const r1 = await ensureCliInstalled()
      expect(r1.action).toBe('installed')
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(process.execPath))

      const r2 = await ensureCliInstalled()
      expect(r2.action).toBe('current')

      const r3 = await removeCliLink()
      expect(r3.removed).toBe(true)
      expect(fs.existsSync(link)).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.MODELRDOCK_CLI_BIN_DIR
      else process.env.MODELRDOCK_CLI_BIN_DIR = prev
      h.restore()
    }
  })
})

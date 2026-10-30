import fs from 'node:fs'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { fakeHome } from './helpers.js'
import { cmdUninstall } from '../src/cli/basic.js'
import { saveConfig } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { modeldockDir, configPath } from '../src/util/paths.js'
import { cmdGatewayStop, sweepGatewayProcesses } from '../src/cli/gatewaycmd.js'
import { deleteSecret } from '../src/config/secrets.js'
import { uninstallAutostart } from '../src/autostart.js'
import { removeCliLink } from '../src/cliinstall.js'

// 卸载流程会停真实网关、清扫真实进程、动系统钥匙环与命令行入口（/usr/local/bin）：
// 四组依赖一律 mock，单测只验证 cmdUninstall 自身的编排与保留/清除边界。
vi.mock('../src/cli/gatewaycmd.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cli/gatewaycmd.js')>()),
  cmdGatewayStop: vi.fn(async () => {}),
  sweepGatewayProcesses: vi.fn(() => {}),
}))
vi.mock('../src/config/secrets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/secrets.js')>()),
  deleteSecret: vi.fn(async () => {}),
}))
vi.mock('../src/autostart.js', async () => {
  const { viFnAutostartMock } = await import('./mocks/autostart.js')
  return viFnAutostartMock()
})
vi.mock('../src/cliinstall.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cliinstall.js')>()),
  removeCliLink: vi.fn(async () => ({ removed: false })),
}))

function baseCfg(): Config {
  return {
    ...emptyConfig(),
    security: { store: 'file' },
    providers: {
      up: {
        name: 'mock',
        base_url: 'http://127.0.0.1:1',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'file:sk-upstream-secret',
      },
    },
  }
}

describe('cmdUninstall 拆分语义（默认保留配置 / --purge 彻底清除）', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('默认：只卸程序——停网关/清自启/清命令行入口，配置目录与密钥原样保留', async () => {
    const h = fakeHome()
    try {
      await saveConfig(baseCfg())
      expect(fs.existsSync(configPath())).toBe(true)

      await cmdUninstall({ yes: true })

      expect(fs.existsSync(modeldockDir())).toBe(true)
      expect(fs.existsSync(configPath())).toBe(true)
      expect(deleteSecret).not.toHaveBeenCalled()
      expect(cmdGatewayStop).toHaveBeenCalledTimes(1)
      expect(sweepGatewayProcesses).toHaveBeenCalledTimes(1)
      expect(uninstallAutostart).toHaveBeenCalledTimes(1)
      expect(removeCliLink).toHaveBeenCalledTimes(1)
      const out = logSpy.mock.calls.map((a) => String(a[0])).join('\n')
      expect(out).toContain('uninstall --purge')
    } finally {
      h.restore()
    }
  })

  it('--purge：停网关 → 清密钥 → 删整个配置目录', async () => {
    const h = fakeHome()
    try {
      await saveConfig(baseCfg())

      await cmdUninstall({ yes: true, purge: true })

      expect(fs.existsSync(modeldockDir())).toBe(false)
      expect(deleteSecret).toHaveBeenCalledWith('file:sk-upstream-secret')
      expect(cmdGatewayStop).toHaveBeenCalledTimes(1)
      expect(sweepGatewayProcesses).toHaveBeenCalledTimes(1)
      expect(uninstallAutostart).toHaveBeenCalledTimes(1)
      expect(removeCliLink).toHaveBeenCalledTimes(1)
    } finally {
      h.restore()
    }
  })

  it('未初始化（无配置目录）时默认卸载不报错、也不创建目录', async () => {
    const h = fakeHome()
    try {
      await cmdUninstall({ yes: true })

      expect(fs.existsSync(modeldockDir())).toBe(false)
      expect(cmdGatewayStop).toHaveBeenCalledTimes(1)
      expect(deleteSecret).not.toHaveBeenCalled()
    } finally {
      h.restore()
    }
  })
})

import fs from 'node:fs'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { fakeHome } from './helpers.js'
import { recordTestFile } from './helpers/run-order.js'
import { cmdUninstall } from '../src/cli/basic.js'
import { saveConfig } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { modeldockDir, configPath } from '../src/util/paths.js'
import { cmdGatewayStop, sweepGatewayProcesses } from '../src/cli/gatewaycmd.js'
import { deleteSecret } from '../src/config/secrets.js'
import { uninstallAutostart } from '../src/autostart.js'
import { removeCliLink } from '../src/cliinstall.js'

// 收集序登记：test-suite-couplings 门禁经共享观测器断言 uninstall 恒先于 zz-quickwins /
// update-tray 收集（helper 零依赖，顶层 import 不触碰 basic.js，无 registry 污染）
recordTestFile('uninstall.test.ts')

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

  it('--purge：多 key 池（keys[] + 池存在时残留的 key_ref）的密钥条目全量清除（P1-2 回归）', async () => {
    const h = fakeHome()
    try {
      const cfg = baseCfg()
      cfg.providers['up'].keys = ['file:sk-pool-1', 'file:sk-pool-2']
      await saveConfig(cfg)

      await cmdUninstall({ yes: true, purge: true })

      expect(fs.existsSync(modeldockDir())).toBe(false)
      // 全量口径：池内 2 条 + 残留 key_ref 旧引用共 3 条全删（旧实现只删 key_ref 单条）
      expect(deleteSecret).toHaveBeenCalledWith('file:sk-pool-1')
      expect(deleteSecret).toHaveBeenCalledWith('file:sk-pool-2')
      expect(deleteSecret).toHaveBeenCalledWith('file:sk-upstream-secret')
      expect(deleteSecret).toHaveBeenCalledTimes(3)
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

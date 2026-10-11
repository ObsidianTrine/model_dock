import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeHome } from './helpers.js'
import { cmdUpdate, UPDATE_TOKEN_SECRET_ID } from '../src/cli/update.js'
import { getSecret } from '../src/config/secrets.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { emptyConfig } from '../src/config/types.js'
import { configPath } from '../src/util/paths.js'
// cmdUpdate 的网络与安装层整体 mock（工厂内定义 vi.fn，再从被 mock 模块导入引用）：
// 这里只验证 CLI 编排——令牌存取、参数透传、无令牌匿名继续
vi.mock('../src/update/run.js', () => ({
  runUpdate: vi.fn(async () => ({ updated: true, currentVersion: '0.1.0', latestVersion: '9.9.9' })),
  checkUpdate: vi.fn(async () => ({ updated: false, currentVersion: '0.1.0', latestVersion: '9.9.9' })),
  cleanUpdateRemnants: vi.fn(async () => []),
}))
import { runUpdate, checkUpdate, cleanUpdateRemnants } from '../src/update/run.js'

const mockRun = vi.mocked(runUpdate)
const mockCheck = vi.mocked(checkUpdate)
const mockClean = vi.mocked(cleanUpdateRemnants)

describe('cmdUpdate CLI 编排', () => {
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('无令牌：匿名继续（公开仓库免 PAT），token=null 透传给 runUpdate', async () => {
    const h = fakeHome()
    try {
      await cmdUpdate({ yes: true })
      expect(process.exitCode).toBeUndefined()
      expect(mockRun).toHaveBeenCalledTimes(1)
      const arg = mockRun.mock.calls[0][0] as { repo: string; token: string | null }
      expect(arg.token).toBeNull()
      expect(arg.repo.length).toBeGreaterThan(0)
    } finally {
      h.restore()
    }
  })

  it('--token：令牌进 secrets（config 只存引用），随后透传 repo/token 给 runUpdate', async () => {
    const h = fakeHome()
    try {
      // 固定 file 存储，避免 defaultStore 落到系统钥匙串（测试不得触达真实 keychain）
      await saveConfig({ ...emptyConfig(), security: { store: 'file' } })
      await cmdUpdate({ token: 'ghp_abc', yes: true })

      const cfg = await loadConfig()
      const ref = cfg.update?.token_ref
      expect(ref).toMatch(/^file:/)
      expect(await getSecret(ref!)).toBe('ghp_abc')
      expect(fs.existsSync(configPath())).toBe(true)

      expect(mockRun).toHaveBeenCalledTimes(1)
      const arg = mockRun.mock.calls[0][0] as { repo: string; token: string; yes: boolean }
      expect(arg.token).toBe('ghp_abc')
      expect(arg.yes).toBe(true)
      expect(arg.repo.length).toBeGreaterThan(0)
    } finally {
      h.restore()
    }
  })

  it('已存令牌：从 secrets 读取并继续；--check 只检查不安装', async () => {
    const h = fakeHome()
    try {
      await saveConfig({ ...emptyConfig(), security: { store: 'file' } })
      await cmdUpdate({ token: 'ghp_saved' })
      vi.clearAllMocks()
      await cmdUpdate({ check: true })
      expect(mockCheck).toHaveBeenCalledTimes(1)
      expect(mockRun).not.toHaveBeenCalled()
    } finally {
      h.restore()
    }
  })

  it('--clean：纯本地清理，不要求令牌、不联网', async () => {
    const h = fakeHome()
    try {
      await cmdUpdate({ clean: true })
      expect(mockClean).toHaveBeenCalledTimes(1)
      expect(mockCheck).not.toHaveBeenCalled()
      expect(mockRun).not.toHaveBeenCalled()
    } finally {
      h.restore()
    }
  })

  it('UPDATE_TOKEN_SECRET_ID 是稳定的 secrets 键（跨升级读取既有令牌）', () => {
    expect(UPDATE_TOKEN_SECRET_ID).toBe('update-token')
    // 空配置不含 update 段（向后兼容旧 config.toml）
    expect(emptyConfig().update).toBeUndefined()
  })
})

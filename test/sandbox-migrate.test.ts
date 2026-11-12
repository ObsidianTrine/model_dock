import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { makeKeyRef, setSecret } from '../src/config/secrets.js'
import { migrateSandboxKeyRefsToLocal } from '../src/config/sandbox.js'
import type { Config } from '../src/config/types.js'

// 沙箱密钥引用落地（migrateSandboxKeyRefsToLocal）：
//  - 无外部引用 → 无操作
//  - 外部条目读不到（钥匙环里不存在该 account，只发生一次只读查询）→ 引用保持原样、security.store 仍落地为 file
//  - 全部改写后幂等
// 不测「外部值可读」路径：那需要在真机钥匙环造条目，超出单测边界（该路径由 dev 沙箱首启实测覆盖）。

function baseCfg(partial?: Partial<Config>): Config {
  return {
    version: 1,
    active_profile: 'main',
    security: { store: 'file' },
    providers: {
      ark: { base_url: 'https://ark.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: makeKeyRef('file', 'ark') },
    },
    profiles: { main: { provider: 'ark', default_model: 'm1' } },
    harness: {},
    ...partial,
  } as Config
}

describe('migrateSandboxKeyRefsToLocal', () => {
  it('无外部引用：直接返回空数组，配置零改动', async () => {
    const h = fakeHome()
    try {
      await setSecret('ark', 'sk-plain', 'file')
      await saveConfig(baseCfg())
      expect(await migrateSandboxKeyRefsToLocal()).toEqual([])
      expect((await loadConfig()).providers.ark.key_ref).toBe(makeKeyRef('file', 'ark'))
    } finally {
      h.restore()
    }
  })

  it('外部条目读不到：引用保持原样（不落空 file 引用），security.store 落地为 file', async () => {
    const h = fakeHome()
    try {
      // keychain:mdk-hc-* 是精心挑选的不存在 account：真机钥匙环只被只读查询一次、必然未命中
      await saveConfig(baseCfg({
        security: { store: 'keychain' },
        providers: {
          ark: { base_url: 'https://ark.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'keychain:mdk-hc-missing-a' },
          sec: { base_url: 'https://sec.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'keychain:mdk-hc-missing-b' },
        },
        update: { token_ref: 'keychain:mdk-hc-missing-t' },
      } as Partial<Config>))
      const migrated = await migrateSandboxKeyRefsToLocal()
      expect(migrated).toEqual([])
      const cfg = await loadConfig()
      expect(cfg.providers.ark.key_ref).toBe('keychain:mdk-hc-missing-a')
      expect(cfg.providers.sec.key_ref).toBe('keychain:mdk-hc-missing-b')
      expect(cfg.update?.token_ref).toBe('keychain:mdk-hc-missing-t')
      expect(cfg.security.store).toBe('file')
      // 再跑一遍：幂等，结果一致
      expect(await migrateSandboxKeyRefsToLocal()).toEqual([])
    } finally {
      h.restore()
    }
  })

  it('手编非串 key_ref（TOML 整数）：isExternal 短路防御，不再 parseKeyRef 抛错打断启动', async () => {
    const h = fakeHome()
    try {
      // `key_ref = 5`（TOML 合法、形状错）：此前 `!ref` 放行数字 → parseKeyRef 抛 SecretsError
      // 整体 reject，「单项失败跳过不影响其余」被打破、沙箱网关启动被单条坏数据卡死
      await saveConfig(baseCfg({
        security: { store: 'keychain' },
        providers: {
          bad: { base_url: 'https://b.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 5 },
          ark: { base_url: 'https://ark.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'keychain:mdk-hc-missing-c' },
        },
      } as unknown as Partial<Config>))
      const migrated = await migrateSandboxKeyRefsToLocal()
      expect(migrated).toEqual([]) // 坏条目与读不到的外部条目都跳过，不抛错
      const cfg = await loadConfig()
      expect(cfg.providers.bad.key_ref).toBe(5) // 坏值原样保留（守卫兜底），不误改写
      expect(cfg.providers.ark.key_ref).toBe('keychain:mdk-hc-missing-c')
      expect(cfg.security.store).toBe('file')
    } finally {
      h.restore()
    }
  })
})

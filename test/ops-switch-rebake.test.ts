// switchToService 内聚重烤（codex-rebake-profiles 卡）：切换路由后烤模型客户端必须跟随。
// 事故背景：云端/同步引擎远程切换回调（main.ts applySwitch）只切不重烤——烤入客户端
// 失联（gpt-6-astra 事故同型）。修复 = refresh 内聚进 switchToService/switchToServiceWithRoute
// 单一漏斗，调用方零改动全覆盖；本用例锁行为。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { applyChanges } from '../src/adapters/engine.js'
import { codexAdapter } from '../src/adapters/codex.js'
import { switchToService, switchToServiceWithRoute } from '../src/ops.js'
import { tomlParse } from '../src/adapters/format.js'

const TOKEN = 'mdk_switch_rebake_test_token'

const cfg = (): Config => ({
  ...emptyConfig(),
  providers: {
    p1: { name: 'GLM', base_url: 'https://a.example.com/v1', protocol: 'openai', auth_style: 'bearer', key_ref: 'k1', models: { 'glm-5-3-flash-260828': { source: 'manual' } } },
    p2: { name: 'MiMo', base_url: 'https://b.example.com/v1', protocol: 'responses', auth_style: 'bearer', key_ref: 'k2', models: { 'mimo-v2.6-pro': { source: 'manual' } } },
  },
  profiles: {
    glm: { provider: 'p1', default_model: 'glm-5-3-flash-260828' },
    mimo: { provider: 'p2', default_model: 'mimo-v2.6-pro' },
  },
  active_profile: 'glm',
  harness: { codex: { mode: 'gateway', route: 'default', attached_at: '2026-11-11T00:00:00Z' } },
})

describe('switchToService 内聚重烤', () => {
  it('切换服务后烤入 codex 的默认模型跟随新路由（云端回调缺口回归）', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfg())
      // 先按 glm 路由接入（烤入 glm 默认模型）
      const plan = await codexAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true, profile: 'glm' },
        await loadConfig()
      )
      await applyChanges('codex', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
      const cfgPath = path.join(h.home, '.codex', 'config.toml')
      expect((tomlParse(fs.readFileSync(cfgPath, 'utf8')) as any).model).toBe('glm-5-3-flash-260828')

      // 直接调 switchToService（云端 applySwitch 同款入口，旧实现这里不重烤）
      await switchToService('p2')
      const root = tomlParse(fs.readFileSync(cfgPath, 'utf8')) as any
      expect(root.model).toBe('mimo-v2.6-pro') // 烤入模型跟随新路由
      expect((await loadConfig()).active_profile).toBe('mimo')
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('switchToServiceWithRoute 同样内聚重烤；稳态再切零副作用不炸', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfg())
      const plan = await codexAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true, profile: 'glm' },
        await loadConfig()
      )
      await applyChanges('codex', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
      await switchToServiceWithRoute('p2', true)
      const cfgPath = path.join(h.home, '.codex', 'config.toml')
      expect((tomlParse(fs.readFileSync(cfgPath, 'utf8')) as any).model).toBe('mimo-v2.6-pro')
      // 切回 glm（往返）：烤入模型跟随回来，稳态守卫不炸
      await switchToServiceWithRoute('p1', false)
      expect((tomlParse(fs.readFileSync(cfgPath, 'utf8')) as any).model).toBe('glm-5-3-flash-260828')
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })
})

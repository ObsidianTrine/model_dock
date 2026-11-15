// codex profiles 多路由（codex-rebake-profiles 卡）：为每条 ModelDock 路由写
// [profiles.<id>]，`codex -p <id>` 一键切换路由免控制台往返。守卫：用户自设同名
// profile 不覆盖；detach 只收自家条目。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { applyChanges } from '../src/adapters/engine.js'
import { codexAdapter } from '../src/adapters/codex.js'
import { tomlParse } from '../src/adapters/format.js'

const TOKEN = 'mdk_codex_profiles_test_token'

const cfgMulti = (): Config => ({
  ...emptyConfig(),
  providers: {
    p1: { name: 'GLM', base_url: 'https://a.example.com/v1', protocol: 'openai', auth_style: 'bearer', key_ref: 'k1', models: { 'glm-5-3-flash-260828': { source: 'manual' } } },
    p2: { name: 'MiMo', base_url: 'https://b.example.com/v1', protocol: 'responses', auth_style: 'bearer', key_ref: 'k2', models: { 'mimo-v2.6-pro': { source: 'manual' } } },
    p3: { name: '空目录', base_url: 'https://c.example.com/v1', protocol: 'openai', auth_style: 'bearer', key_ref: 'k3' },
  },
  profiles: {
    demo: { provider: 'p1', default_model: 'glm-5-3-flash-260828' },
    beta: { provider: 'p2', default_model: 'mimo-v2.6-pro' },
    broken: { provider: 'p3', default_model: 'x' }, // provider 无模型目录 → 跳过
  },
  active_profile: 'demo',
})

async function attach(profile = 'demo') {
  const plan = await codexAdapter.planAttach(
    { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true, profile },
    await loadConfig()
  )
  await applyChanges('codex', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
  return plan
}

const readRoot = (home: string) => tomlParse(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')) as Record<string, any>

describe('codex profiles 多路由', () => {
  it('attach 为每条路由写 [profiles.<id>]；无模型的 provider 路由跳过', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgMulti())
      await attach()
      const root = readRoot(h.home)
      expect(root.profiles.demo).toEqual({ model_provider: 'modeldock', model: 'glm-5-3-flash-260828' })
      expect(root.profiles.beta).toEqual({ model_provider: 'modeldock', model: 'mimo-v2.6-pro' })
      expect(root.profiles.broken).toBeUndefined() // provider 无模型目录
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('用户自设同名 profile 不覆盖（note 提示）；我们的旧条目随刷新更新', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgMulti())
      await attach()
      // 手改 config：demo 改成用户自设（provider 不是我们）、beta 留我们的旧值
      const cfgPath = path.join(h.home, '.codex', 'config.toml')
      const raw = fs.readFileSync(cfgPath, 'utf8')
      fs.writeFileSync(cfgPath, raw.replace(/model_provider = "modeldock"[\s\S]*?model = "mimo-v2\.6-pro"/, 'model_provider = "modeldock"\nmodel = "stale-model"'))
      const plan2 = await codexAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true, profile: 'demo' },
        await loadConfig()
      )
      await applyChanges('codex', 'attach', plan2.changes, { yes: true, redactions: [TOKEN] })
      const root = readRoot(h.home)
      expect(root.profiles.beta.model).toBe('mimo-v2.6-pro') // 自家旧值刷新回配置真值
      // demo 若被误判为用户自设需保留——此处它 provider 仍是 modeldock（替换只动了 beta 段），
      // 断言用户自设场景见下一用例
      expect(root.profiles.demo.model_provider).toBe('modeldock')
      expect(plan2.notes.some((n) => n.includes('用户自设') || n.includes('user-defined'))).toBe(false)
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('同名 profile model_provider 非 modeldock → 跳过并 note', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgMulti())
      await attach()
      // 用户在 demo 段加自定义 provider
      const cfgPath = path.join(h.home, '.codex', 'config.toml')
      const raw = fs.readFileSync(cfgPath, 'utf8')
      fs.writeFileSync(cfgPath, raw.replace('[profiles.demo]\nmodel_provider = "modeldock"', '[profiles.demo]\nmodel_provider = "my-own"'))
      const plan2 = await codexAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true, profile: 'demo' },
        await loadConfig()
      )
      await applyChanges('codex', 'attach', plan2.changes, { yes: true, redactions: [TOKEN] })
      const root = readRoot(h.home)
      expect(root.profiles.demo.model_provider).toBe('my-own') // 用户定义原样保留
      expect(plan2.notes.some((n) => n.includes('demo'))).toBe(true) // note 点名跳过
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('用户 profile 未写 model_provider（继承根级 provider）→ 同样跳过不覆盖', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgMulti())
      await attach()
      // 用户把 demo 段改成只写 model（codex 语义：model_provider 缺省=继承根级 provider）
      const cfgPath = path.join(h.home, '.codex', 'config.toml')
      fs.writeFileSync(
        cfgPath,
        fs
          .readFileSync(cfgPath, 'utf8')
          .replace('[profiles.demo]\nmodel_provider = "modeldock"\nmodel = "glm-5-3-flash-260828"', '[profiles.demo]\nmodel = "user-own-model"')
      )
      const plan2 = await codexAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true, profile: 'demo' },
        await loadConfig()
      )
      await applyChanges('codex', 'attach', plan2.changes, { yes: true, redactions: [TOKEN] })
      const root = readRoot(h.home)
      expect(root.profiles.demo).toEqual({ model: 'user-own-model' }) // 用户定义原样保留，不被劫持成 modeldock
      expect(plan2.notes.some((n) => n.includes('demo'))).toBe(true)
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('直连模式不写 profiles（modeldock 条目=单一直连上游，烤入其他路由默认模型必 400）', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgMulti())
      const plan = await codexAdapter.planAttach(
        {
          mode: 'gateway',
          gatewayPort: 8687,
          token: TOKEN,
          profile: 'demo',
          direct: { base_url: 'https://up.example.com/v1', base_url_responses: 'https://up.example.com/responses', protocol: 'openai', key: 'sk-x', auth_style: 'bearer' },
        },
        await loadConfig()
      )
      const after = tomlParse(plan.changes[0]!.after) as Record<string, any>
      expect(after.profiles).toBeUndefined() // 多路由 profiles 只在网关模式烤入
      expect(after.model_catalog_json).toBeUndefined() // 直连同口径（既有行为）
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('detach 收回自家条目（用户自设保留；收空整键删除）', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgMulti())
      await attach()
      // beta 段改成用户自设
      const cfgPath = path.join(h.home, '.codex', 'config.toml')
      fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8').replace('[profiles.beta]\nmodel_provider = "modeldock"', '[profiles.beta]\nmodel_provider = "my-own"'))
      const det = await codexAdapter.planDetach(await loadConfig())
      await applyChanges('codex', 'detach', det.changes, { yes: true, redactions: [TOKEN] })
      const root = readRoot(h.home)
      expect(root.profiles.demo).toBeUndefined() // 自家条目收回
      expect(root.profiles.beta.model_provider).toBe('my-own') // 用户定义保留
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('detach 后无任何自家条目 → profiles 键整删不留空表', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgMulti())
      await attach()
      const det = await codexAdapter.planDetach(await loadConfig())
      await applyChanges('codex', 'detach', det.changes, { yes: true, redactions: [TOKEN] })
      const root = readRoot(h.home)
      expect(root.profiles).toBeUndefined()
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('attach 未带 --set-default → detach 同样收回自家 profiles 条目（收回不锁根级接管态）', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgMulti())
      const plan = await codexAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, profile: 'demo' }, // 不设 setDefault：根级 provider 保持用户原值
        await loadConfig()
      )
      await applyChanges('codex', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
      const before = readRoot(h.home)
      expect(before.model_provider).toBeUndefined() // 根级未被接管
      expect(before.profiles.demo).toBeDefined() // profiles 条目照写（codex -p 不依赖根级接管）
      expect(before.model_catalog_json).toBeDefined()
      const det = await codexAdapter.planDetach(await loadConfig())
      await applyChanges('codex', 'detach', det.changes, { yes: true, redactions: [TOKEN] })
      const root = readRoot(h.home)
      expect(root.model_providers?.modeldock).toBeUndefined()
      expect(root.profiles).toBeUndefined() // 自家条目收回，不残留指向已删 provider 的死引用
      expect(root.model_catalog_json).toBeUndefined()
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })
})

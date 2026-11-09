// codex /model 目录（model_catalog_json 机制）——2026-11-09 codex-catalog-ship 卡
// 实证背景：codex 0.167 的 /model 选择器数据源 = 编译进二进制的 OpenAI 静态预设 +
// model_catalog_json 指向的目录文件，从不查询 provider；无此键时网关模型不可见、
// 从内置预设选中即 400（路由目录不含）。小米 token plan 官方模板即此机制的范本。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { applyChanges } from '../src/adapters/engine.js'
import { buildCodexCatalog, codexAdapter, codexCatalogPath } from '../src/adapters/codex.js'
import { tomlParse } from '../src/adapters/format.js'

const TOKEN = 'mdk_codex_catalog_test_token_123'

const cfgWithModels = (): Config => ({
  ...emptyConfig(),
  providers: {
    p1: {
      name: 'GLM 中转',
      base_url: 'https://x.example.com/v1',
      protocol: 'openai',
      auth_style: 'bearer',
      key_ref: 'k',
      models: {
        'glm-5-3-flash-260828': { source: 'manual', context_window: 1048576, max_output: 131072 },
        'glm-4.6v': { source: 'manual', capabilities: ['vision'] },
        'zzz-plain-text-only': { source: 'manual' },
      },
    },
  },
  profiles: { demo: { provider: 'p1', default_model: 'glm-5-3-flash-260828' } },
  active_profile: 'demo',
})

async function attach(opts: Partial<Parameters<typeof codexAdapter.planAttach>[0]> = {}) {
  const plan = await codexAdapter.planAttach(
    { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true, profile: 'demo', ...opts },
    await loadConfig()
  )
  await applyChanges('codex', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
  return plan
}

const readRoot = (home: string) =>
  tomlParse(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')) as Record<string, any>

describe('codex model_catalog_json 生成', () => {
  it('attach 生成 catalog：键指向 ModelDock 文件，内容按路由服务商模型目录投影', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgWithModels())
      const plan = await attach()
      const root = readRoot(h.home)
      expect(root.model_catalog_json).toBe(codexCatalogPath())
      expect(root.model_catalog_json).toContain(path.join('.modeldock', 'codex-catalog.json'))

      const raw = fs.readFileSync(codexCatalogPath(), 'utf8')
      const catalog = JSON.parse(raw) as { models: Record<string, unknown>[] }
      expect(catalog.models).toHaveLength(3)
      const flash = catalog.models.find((m) => m.slug === 'glm-5-3-flash-260828')!
      expect(flash.display_name).toBe('glm-5-3-flash-260828')
      expect(flash.description).toBe('GLM 中转: glm-5-3-flash-260828')
      expect(flash.context_window).toBe(1048576)
      expect(flash.max_context_window).toBe(1048576)
      expect(flash.visibility).toBe('list')
      expect(flash.supported_in_api).toBe(true)
      // 模态走视觉能力链（glm-5-3-flash 在内置表带 vision → text+image；此处不断言具体值）
      expect(flash.input_modalities).toContain('text')
      expect((flash.supported_reasoning_levels as unknown[]).length).toBe(4)
      const vision = catalog.models.find((m) => m.slug === 'glm-4.6v')!
      expect(vision.input_modalities).toEqual(['text', 'image'])
      // 无任何元数据的模型：无窗口硬造（codex 回落自身假定）、无 vision → 纯文本模态
      const plain = catalog.models.find((m) => m.slug === 'zzz-plain-text-only')!
      expect(plain.context_window).toBeUndefined()
      expect(plain.input_modalities).toEqual(['text'])
      // serde 必填字段（0.167 实测逐轮探明）：缺失即拒载
      expect(flash.shell_type).toBe('unified_exec')
      expect(flash.support_verbosity).toBe(false)
      expect(flash.truncation_policy).toEqual({ mode: 'tokens', limit: 10000 })
      expect(flash.experimental_supported_tools).toEqual([])
      // base_instructions = codex 自家默认指令（与无 catalog 时行为一致），非第三方人设
      expect(String(flash.base_instructions)).toContain('coding agent')
      expect(flash.model_messages).toBeUndefined()
      expect(flash.tool_mode).toBeUndefined()
      // web_search 工具缺省关（小米等上游 400 实测；用户显式值不动）
      expect(root.web_search).toBe('disabled')
      // change 记录注明目录用途
      expect(plan.changes.some((c) => c.path === codexCatalogPath())).toBe(true)
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('服务商模型目录为空 → fail-open：不写键、无 catalog change、config 正常接入', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig({
        ...emptyConfig(),
        providers: { p1: { name: 'x', base_url: 'https://x.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'k' } },
        profiles: { demo: { provider: 'p1', default_model: 'm1' } },
        active_profile: 'demo',
      })
      const plan = await attach()
      const root = readRoot(h.home)
      expect(root.model_catalog_json).toBeUndefined()
      expect(root.web_search).toBeUndefined() // 目录空 → 连带缺省也不写
      expect(root.model_provider).toBe('modeldock') // 接入本身不受影响
      expect(plan.changes.some((c) => c.path === codexCatalogPath())).toBe(false)
      expect(fs.existsSync(codexCatalogPath())).toBe(false)
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('用户已设 web_search → 不覆盖；缺省值仅补空', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgWithModels())
      const plan = await attach()
      expect(readRoot(h.home).web_search).toBe('disabled')
      // 手改成用户显式值再 attach：尊重不覆盖（引号风格无关的整行替换）
      const cfgPath = path.join(h.home, '.codex', 'config.toml')
      fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8').replace(/web_search = .*/, 'web_search = "auto"'))
      const plan2 = await codexAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true, profile: 'demo' },
        await loadConfig()
      )
      await applyChanges('codex', 'attach', plan2.changes, { yes: true, redactions: [TOKEN] })
      expect(readRoot(h.home).web_search).toBe('auto')
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('用户自设 model_catalog_json → 尊重不覆盖，note 提示以用户文件为准', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgWithModels())
      const plan = await attach({ setDefault: true })
      // 手改 config 模拟用户自设（attach 已写入我们的指针，换成他值再 attach 一次）
      const cfgPath = path.join(h.home, '.codex', 'config.toml')
      fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8').replace(codexCatalogPath(), '/custom/catalog.json'))
      const plan2 = await codexAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true, profile: 'demo' },
        await loadConfig()
      )
      await applyChanges('codex', 'attach', plan2.changes, { yes: true, redactions: [TOKEN] })
      const root = readRoot(h.home)
      expect(root.model_catalog_json).toBe('/custom/catalog.json')
      expect(plan2.changes.some((c) => c.path === codexCatalogPath())).toBe(false)
      expect(plan2.notes.some((n) => n.includes('/custom/catalog.json'))).toBe(true)
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('detach 收回 ModelDock catalog 指针；用户自设的他值不动', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgWithModels())
      await attach()
      let det = await codexAdapter.planDetach(await loadConfig())
      await applyChanges('codex', 'detach', det.changes, { yes: true, redactions: [TOKEN] })
      let root = readRoot(h.home)
      expect(root.model_catalog_json).toBeUndefined()

      // 用户自设值：不收回
      await attach()
      const cfgPath = path.join(h.home, '.codex', 'config.toml')
      fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8').replace(codexCatalogPath(), '/custom/catalog.json'))
      det = await codexAdapter.planDetach(await loadConfig())
      await applyChanges('codex', 'detach', det.changes, { yes: true, redactions: [TOKEN] })
      root = readRoot(h.home)
      expect(root.model_catalog_json).toBe('/custom/catalog.json')
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })
})

describe('codex 直连守卫', () => {
  it('direct + anthropic 协议 → AdapterError（codex 只讲 Responses，结构性不可直连）', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgWithModels())
      await expect(
        codexAdapter.planAttach(
          {
            mode: 'gateway', gatewayPort: 8687, token: TOKEN,
            direct: { base_url: 'https://up.example.com', protocol: 'anthropic', key: 'sk-x', auth_style: 'x-api-key' },
          },
          await loadConfig()
        )
      ).rejects.toThrow(/Responses/)
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('direct + openai 协议缺 base_url_responses → 回退 base_url 并强提示 Responses-only', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await saveConfig(cfgWithModels())
      const plan = await codexAdapter.planAttach(
        {
          mode: 'gateway', gatewayPort: 8687, token: TOKEN,
          direct: { base_url: 'https://up.example.com/v1', protocol: 'openai', key: 'sk-x', auth_style: 'bearer' },
        },
        await loadConfig()
      )
      expect(plan.changes[0]?.after).toContain('base_url = "https://up.example.com/v1"')
      expect(plan.notes.some((n) => n.includes('wire_api=chat 已移除'))).toBe(true)
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })
})

describe('buildCodexCatalog 单元', () => {
  it('目录空返回 null（fail-open）', () => {
    expect(buildCodexCatalog(emptyConfig(), 'nope')).toBeNull()
  })
  it('priority 按目录顺序、display_name 优先用元数据', () => {
    const cfg: Config = {
      ...emptyConfig(),
      providers: {
        p1: {
          name: 'P',
          base_url: 'https://x.example.com',
          protocol: 'openai',
          auth_style: 'bearer',
          key_ref: 'k',
          models: {
            'm-a': { source: 'manual', display_name: 'Model A' },
            'm-b': { source: 'manual' },
          },
        },
      },
    }
    const cat = buildCodexCatalog(cfg, 'p1')!
    expect(cat.models.map((m) => m.priority)).toEqual([0, 1])
    expect(cat.models[0].display_name).toBe('Model A')
    expect(cat.models[1].display_name).toBe('m-b')
    // 元数据缺窗口时不硬造（codex 回落自身假定）
    expect(cat.models[0].context_window).toBeUndefined()
  })
})

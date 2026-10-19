import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import {
  validateServiceInput,
  resolveServiceModels,
  resolveFallbackChain,
  type AddServiceSubmittedModels,
} from '../src/ops.js'
import { emptyConfig } from '../src/config/types.js'
import { saveConfig, loadConfig } from '../src/config/store.js'
import { findPreset } from '../src/presets/data.js'
import { cmdProviderAdd } from '../src/cli/providers.js'

// 纯函数（validateServiceInput / resolveServiceModels / resolveFallbackChain）直接测，无 fakeHome。
// cmdProviderAdd 交互壳：用显式 preset+key+yes 驱动（不经 @inquirer 提问），真实走 addService
// 验证委托与 active_profile 语义——见文件尾说明。跨文件雷区：本文件不使用 vi.mock。

describe('validateServiceInput（纯函数：地址/协议端点校验）', () => {
  it('合法：显式 https base_url 通过，无端点', () => {
    const r = validateServiceInput({ baseUrl: 'https://api.example.com/v1' })
    expect(r.finalBaseUrl).toBe('https://api.example.com/v1')
    expect(r.cleanEndpoints).toBeUndefined()
  })

  it('合法：地址缺省回落预设地址，且剔除空串端点只留合法端点', () => {
    const r = validateServiceInput({
      presetBaseUrl: 'https://preset.example.com',
      endpoints: { openai: 'https://api.example.com/v1', anthropic: '   ' },
    })
    expect(r.finalBaseUrl).toBe('https://preset.example.com')
    // 空串端点被剔除，只留 openai
    expect(r.cleanEndpoints).toEqual({ openai: 'https://api.example.com/v1' })
  })

  it('非法：地址为空（预设也无地址）→ 抛可操作双语错误', () => {
    expect(() => validateServiceInput({})).toThrow(/http:\/\/ 或 https:\/\//)
  })

  it('非法：非 http(s) 协议地址 → 抛错', () => {
    expect(() => validateServiceInput({ baseUrl: 'ftp://api.example.com' })).toThrow(/http:\/\/ 或 https:\/\//)
  })

  it('非法：协议端点非 http(s) → 抛错', () => {
    expect(() => validateServiceInput({ baseUrl: 'https://a.com', endpoints: { anthropic: 'ftp://x' } })).toThrow(
      /http:\/\/ 或 https:\/\//
    )
  })
})

describe('resolveServiceModels（纯函数：模型目录解析——提交即权威）', () => {
  const presetModels: Record<string, { display_name: string; context_window?: number; max_output?: number; source: 'preset' }> = {
    a: { display_name: 'A', context_window: 128000, max_output: 4096, source: 'preset' },
    c: { display_name: 'C', context_window: 32000, source: 'preset' },
  }

  it('合法：无用户提交 → 原样返回预设目录', () => {
    expect(resolveServiceModels(undefined, presetModels)).toEqual(presetModels)
  })

  it('合法：用户提交 = 权威全量目录（删掉的预设模型不复活）', () => {
    const submitted: AddServiceSubmittedModels = {
      a: { context_window: 200000, display_name: 'A' }, // 保留 a 并精修
      b: { display_name: 'B 新', context_window: 100 }, // 新 id 追加
    }
    const r = resolveServiceModels(submitted, presetModels)!
    expect(r.a).toMatchObject({ context_window: 200000, display_name: 'A', source: 'manual' })
    expect(r.b).toMatchObject({ display_name: 'B 新', context_window: 100, source: 'manual' })
    expect(r.c).toBeUndefined() // 用户删掉的预设模型不得由预设目录猜回
  })

  it('合法：空对象提交 = 用户删光，返回空目录（不回落预设）', () => {
    expect(resolveServiceModels({}, presetModels)).toEqual({})
  })

  it('非法/归一：空 id 剔除，只保留非空 id', () => {
    const submitted: AddServiceSubmittedModels = {
      '': { display_name: '空' },
      '   ': { display_name: '空格' },
      only: { display_name: 'Only' },
    }
    const r = resolveServiceModels(submitted, undefined)!
    expect(Object.keys(r)).toEqual(['only'])
    expect(r.only).toMatchObject({ display_name: 'Only', source: 'manual' })
  })

  it('非法/归一：能力清洗（非数组整体丢弃 / 数组只留合法小写项）', () => {
    const submitted: AddServiceSubmittedModels = {
      a: { capabilities: 'not-an-array' }, // 非数组 → 整体清洗为空
      b: { capabilities: ['Vision', '  VISION ', 'x'.repeat(25), '', 3] }, // 去重/小写/滤超长与非法类型
    }
    const r = resolveServiceModels(submitted, undefined)!
    expect(r.a.capabilities).toBeUndefined()
    expect(r.b.capabilities).toEqual(['vision'])
  })
})

describe('resolveFallbackChain（纯函数：失败切换候选链）', () => {
  const providers = {
    other: { base_url: 'https://a.example.com' },
    other2: { base_url: 'https://b.example.com' },
  }

  it('合法：未提供 → undefined；空数组 → 空数组', () => {
    expect(resolveFallbackChain(undefined, 'self', providers)).toBeUndefined()
    expect(resolveFallbackChain([], 'self', providers)).toEqual([])
  })

  it('合法：保留 id 与 id:model 形态，跳过自身与重复条目', () => {
    const r = resolveFallbackChain(['other', 'other', 'other:modelA', 'other2:modelB', 'self'], 'self', providers)
    expect(r).toEqual(['other', 'other2:modelB'])
  })

  it('非法：条目语法无效（空串 / 只有模型缺服务 id）→ 抛可操作双语错误', () => {
    for (const bad of [['  '], [':modelA']]) {
      expect(() => resolveFallbackChain(bad, 'self', providers)).toThrow(/服务ID 或 服务ID:模型ID/)
    }
  })

  it('非法：目标服务不存在 → 抛可操作双语错误', () => {
    expect(() => resolveFallbackChain(['ghost'], 'self', providers)).toThrow(/刷新页面同步最新列表/)
  })
})

describe('结构断言（DRIFT-03）：targetGatewayPort 已删除', () => {
  it('src/ 内零命中 targetGatewayPort', () => {
    const root = path.join(import.meta.dirname, '..', 'src')
    const hits: string[] = []
    for (const f of walkTs(root)) {
      if (fs.readFileSync(f, 'utf8').includes('targetGatewayPort')) hits.push(f)
    }
    expect(hits).toEqual([])
  })
})

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkTs(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

// ── cmdProviderAdd 交互壳：委托 addService + active_profile 语义 ─────────────────────────────
// 说明：不在单进程里 mock @inquirer（跨文件雷区）。改用显式 preset/--key/--yes 驱动，问答全部
// 跳过（search 因提供 preset 不触发；password 因 --key 不触发；confirm 因 --yes 不触发），
// 让整条链路真实走 ops.addService。active_profile 行为由 addService 既有语义承担——
// 断言「空配置建 auto-<id> 并设为 active」与「已有 active 不被抢走」，即证明委托与对齐项成立。

describe('cmdProviderAdd 交互壳（委托 ops.addService）', () => {
  it('空配置 + --yes：委托 addService 建 auto-<id> 路由并设为 active_profile', async () => {
    const h = fakeHome()
    try {
      await saveConfig({ ...emptyConfig(), security: { store: 'file' } })
      await cmdProviderAdd('deepseek-anthropic', { key: 'sk-test', yes: true, noFetch: true })
      const cfg = await loadConfig()
      // 服务真由 addService 写入：id=预设短名 slug，base_url 取预设
      expect(cfg.providers['deepseek']?.base_url).toBe(findPreset('deepseek-anthropic')!.base_url)
      expect(cfg.providers['deepseek']?.key_ref.startsWith('file:')).toBe(true)
      // ops 命名：auto-<id> profile，且不再造旧的同名 profile / 不另设 active
      expect(cfg.profiles['auto-deepseek']?.provider).toBe('deepseek')
      expect(cfg.profiles['deepseek']).toBeUndefined()
      expect(cfg.active_profile).toBe('auto-deepseek')
    } finally {
      h.restore()
    }
  })

  it('已有 active_profile：即使 --yes 也不再抢默认路由（不再无条件覆盖）', async () => {
    const h = fakeHome()
    try {
      await saveConfig({
        ...emptyConfig(),
        security: { store: 'file' },
        providers: {
          other: { name: 'Other', base_url: 'https://other.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:other' },
        },
        profiles: { pother: { name: 'pother', provider: 'other' } },
        active_profile: 'pother',
      })
      await cmdProviderAdd('deepseek-anthropic', { key: 'sk-test2', yes: true, noFetch: true })
      const cfg = await loadConfig()
      expect(cfg.providers['deepseek']?.base_url).toBe(findPreset('deepseek-anthropic')!.base_url)
      expect(cfg.profiles['auto-deepseek']?.provider).toBe('deepseek')
      // 核心对齐项：现有 active_profile 不被新服务抢走
      expect(cfg.active_profile).toBe('pother')
    } finally {
      h.restore()
    }
  })
})
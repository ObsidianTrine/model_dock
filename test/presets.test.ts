import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { PRESETS, applyUserPresets, readUserPresets, reloadPresets, findPreset } from '../src/presets/data.js'

// fakeHome + readUserPresets(它们按调用时刻的 modeldockDir 决定读到哪个目录)直接测
// readUserPresets/reloadPresets；applyUserPresets 是纯函数不碰文件系统，单独测。

afterEach(() => {
  // 回到"无自定义文件"的内置态，避免污染同进程其他用例/文件
  reloadPresets()
})

describe('applyUserPresets（纯合并逻辑）', () => {
  it('无自定义时原样返回内置库', () => {
    const merged = applyUserPresets([])
    expect(merged.length).toBeGreaterThan(0)
    expect(PRESETS).not.toBe(merged) // 不共享同一引用防误改
  })

  it('同名 id 覆盖内置，新 id 追加且保留内置其余', () => {
    const merged = applyUserPresets([
      { id: 'custom', label: '我的自定义', vendor: '公司', base_url: 'https://my.internal/v1', protocol: 'openai', auth_style: 'bearer' },
      { id: 'corp-gw', label: '公司网关', vendor: '公司', base_url: 'https://gw.internal/v1', protocol: 'openai', auth_style: 'bearer' },
    ])
    const custom = merged.find((p) => p.id === 'custom')
    expect(custom?.label).toBe('我的自定义') // 覆盖了内置 custom
    expect(merged.find((p) => p.id === 'corp-gw')?.label).toBe('公司网关') // 新 id 追加
    expect(merged.some((p) => p.id === 'deepseek-anthropic')).toBe(true) // 内置其余保留
    expect(merged.filter((p) => p.id === 'custom').length).toBe(1) // 不会被重复
  })
})

describe('readUserPresets（文件读取 + 校验）', () => {
  it('文件不存在返回空数组', () => {
    const h = fakeHome()
    try {
      expect(readUserPresets()).toEqual([])
    } finally {
      h.restore()
    }
  })

  it('读取合法 JSON（数组或 {presets} 两种形态）', () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.modeldock')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'presets.json'),
        JSON.stringify([
          {
            id: 'corp-gw',
            label: '公司网关',
            base_url: 'https://gw.internal/v1',
            protocol: 'openai',
            models: [{ id: 'corp-chat', context_window: 128000, display_name: 'Corp Chat' }],
          },
        ])
      )
      const out = readUserPresets()
      expect(out).toHaveLength(1)
      expect(out[0].id).toBe('corp-gw')
      expect(out[0].models?.[0]?.id).toBe('corp-chat')
    } finally {
      h.restore()
    }
  })

  it('格式错误抛可操作报错', () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.modeldock')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'presets.json'), '{ not json ')
      expect(() => readUserPresets()).toThrow(/格式错误/)
    } finally {
      h.restore()
    }
  })
})

describe('懒加载（BUG-12：模块载入不碰 user presets，格式错误推迟到首次查询才抛）', () => {
  it('presets.json 格式错误：import presets/data 不抛（module 顶层零 IO 零 throw），首次 findPreset 才抛可操作报错（含文件路径）', async () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.modeldock')
      fs.mkdirSync(dir, { recursive: true })
      const fp = path.join(dir, 'presets.json')
      fs.writeFileSync(fp, '{ not json ')
      // query 参数强制独立模块实例：fresh 的懒加载态（presetsLoaded=false），避免吃到本文件顶部 import 已加载的真实模块状态
      // @ts-expect-error 带查询串的模块 specifier 无类型声明（运行时合法：查询串强制独立实例）
      const mod = await import('../src/presets/data.js?lazyerror')
      // 顶层的 findPreset 若在读文件的懒加载路径上抛错，就证明 import 本身没抛、错误在查询时到达：
      // 这里能走到 import 成功 + 查询抛错两步，分别对应「import 不抛」与「首次查询抛可操作报错」
      expect(() => mod.findPreset('any-id')).toThrow(/格式错误/)
      expect(() => mod.findPreset('any-id')).toThrow(/presets\.json/) // 文案含文件路径
      // 同一 fresh 实例再次查询仍走失败路径（未缓存半加载态），保持一致
      expect(() => mod.reloadPresets()).toThrow(/格式错误/)
    } finally {
      h.restore()
    }
  })
})

describe('reloadPresets（合并进运行时列表）', () => {
  it('自定义覆盖内置 custom 且 findPreset 生效', () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.modeldock')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'presets.json'),
        JSON.stringify([{ id: 'custom', label: '公司自定义', base_url: 'https://gw.internal/v1', protocol: 'anthropic', auth_style: 'bearer' }])
      )
      reloadPresets()
      expect(findPreset('custom')?.label).toBe('公司自定义')
      expect(findPreset('corp-gw')).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('还原后回到内置库', () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.modeldock')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'presets.json'),
        JSON.stringify([{ id: 'custom', label: '公司自定义', base_url: 'https://gw.internal/v1' }])
      )
      reloadPresets()
      expect(findPreset('custom')?.label).toBe('公司自定义')
    } finally {
      h.restore()
    }
    reloadPresets()
    expect(findPreset('custom')?.label).not.toBe('公司自定义')
  })
})
describe('火山方舟套餐模型元数据（2026-10 官方套餐概览）', () => {
  it('ark 两预设共用官方清单：14/16 带上下文与最大输出，auto 与 2-0-lite 留空', () => {
    for (const id of ['ark-coding-plan', 'ark-agent-plan']) {
      const p = findPreset(id)
      expect(p).toBeDefined()
      const models = p!.models ?? []
      expect(models.length).toBe(16)
      const filled = models.filter((m) => m.context_window && m.max_output)
      expect(filled.length).toBe(14)
      expect(models.find((m) => m.id === 'auto')?.context_window).toBeUndefined()
      expect(models.find((m) => m.id === 'doubao-seed-2-0-lite-260215')?.context_window).toBeUndefined()
      // 官方数值抽查：kimi-k3 方舟侧输出 128K（与 Moonshot 直连 1M 不同）、deepseek 384K=393216
      expect(models.find((m) => m.id === 'kimi-k3')).toMatchObject({ context_window: 1048576, max_output: 131072 })
      expect(models.find((m) => m.id === 'deepseek-v4-pro-ga-260813')).toMatchObject({ context_window: 1048576, max_output: 393216 })
      expect(models.find((m) => m.id === 'kimi-k2.7-code')).toMatchObject({ context_window: 262144, max_output: 32768 })
    }
  })

  it('knownModelMeta 覆盖方舟 output_name 新旧 id 形态（存量配置展示兜底）', async () => {
    const { knownModelMeta } = await import('../src/providers/known.js')
    expect(knownModelMeta('doubao-seed-2-1-pro-260915')).toMatchObject({ context_window: 1048576, max_output: 262144 })
    expect(knownModelMeta('doubao-seed-2.1-pro')).toMatchObject({ context_window: 1048576, max_output: 262144 })
    expect(knownModelMeta('kimi-k2-8-260901')).toMatchObject({ context_window: 1048576, max_output: 1048576 })
    expect(knownModelMeta('minimax-m3-modelhub')).toMatchObject({ context_window: 1048576, max_output: 131072 })
    expect(knownModelMeta('deepseek-v4-pro-ga-260813')).toMatchObject({ context_window: 1048576, max_output: 393216 })
  })
})
describe('预设目录 2026-10-11 刷新（官方文档核对）', () => {
  it('Kimi 三预设：K2.7-Code/K2.6 补 32K 输出与视觉，highspeed 补全长，文档直链 platform.kimi 新域', () => {
    for (const id of ['kimi-openai-cn', 'kimi-anthropic-cn', 'kimi-anthropic-global']) {
      const models = findPreset(id)!.models ?? []
      expect(models.find((m) => m.id === 'kimi-k2.7-code')).toMatchObject({
        context_window: 262144,
        max_output: 32768,
        capabilities: expect.arrayContaining(['vision']),
      })
      expect(models.find((m) => m.id === 'kimi-k2.6')).toMatchObject({ max_output: 32768, capabilities: expect.arrayContaining(['vision']) })
      expect(models.find((m) => m.id === 'kimi-k3')?.capabilities).toContain('vision')
    }
    expect(findPreset('kimi-openai-cn')!.models!.find((m) => m.id === 'kimi-k2.7-code-highspeed')).toMatchObject({
      context_window: 262144,
      max_output: 32768,
    })
    expect(findPreset('kimi-anthropic-cn')!.docs_url).toBe('https://platform.kimi.com/docs')
    expect(findPreset('kimi-anthropic-global')!.docs_url).toBe('https://platform.kimi.ai/docs')
  })

  it('无目录预设补齐：dashscope=qwen3.8 系、siliconflow=托管热门款、mimo 双预设=v2.6 系、z.ai 补 flashx', () => {
    expect(findPreset('dashscope-openai')!.models!.map((m) => m.id)).toEqual(['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash'])
    const sf = findPreset('siliconflow')!.models ?? []
    expect(sf.find((m) => m.id === 'deepseek-ai/DeepSeek-V4-Pro')).toMatchObject({ context_window: 1048576, max_output: 393216 })
    expect(sf.find((m) => m.id === 'Pro/moonshotai/Kimi-K2.6')).toMatchObject({ context_window: 262144, max_output: 32768 })
    for (const id of ['mimo-token-plan-cn', 'mimo-api']) {
      expect(findPreset(id)!.models!.map((m) => m.id)).toEqual(['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed'])
    }
    expect(findPreset('zai-anthropic')!.models!.find((m) => m.id === 'glm-5.3-flashx')).toBeDefined()
  })

  it('knownModelMeta 覆盖 kimi-k2.6 / highspeed 与 MiMo 视觉（存量配置兜底）', async () => {
    const { knownModelMeta } = await import('../src/providers/known.js')
    expect(knownModelMeta('kimi-k2.6')).toMatchObject({ context_window: 262144, max_output: 32768 })
    expect(knownModelMeta('kimi-k2.6')?.capabilities).toContain('vision')
    expect(knownModelMeta('kimi-k2.7-code-highspeed')?.context_window).toBe(262144)
    expect(knownModelMeta('mimo-v2.6-flash')?.capabilities).toContain('vision')
  })
})

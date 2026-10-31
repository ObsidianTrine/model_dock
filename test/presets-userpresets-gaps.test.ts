import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { presetsJsonPath } from '../src/util/paths.js'
import { knownModelsForBaseUrl, readUserPresets, reloadPresets, validateUserPresetEntries } from '../src/presets/data.js'

/**
 * 测试盲区补齐：src/presets/data.ts 分支缺口（2026-10-29 全量 coverage 实测圈出）。
 * 覆盖面：readUserPresets 非 ENOENT 读错误与顶层形态校验、validateUserPresetEntries
 * 逐条归一化分支（缺 id / endpoints 形状 / 模型字段合法性 / label·vendor·docs_url 回退）、
 * knownModelsForBaseUrl 按 host 匹配三态。分支→用例映射见 test/coverage-gaps-presets-sync.md。
 */

afterEach(() => {
  // fakeHome 已还原为无自定义文件，重载回内置态，不污染同进程后续文件（与 presets.test.ts 同口径）
  reloadPresets()
})

function writePresetsRaw(text: string): void {
  fs.mkdirSync(path.dirname(presetsJsonPath()), { recursive: true })
  fs.writeFileSync(presetsJsonPath(), text)
}

describe('readUserPresets 读错误与顶层形态（缺口补齐）', () => {
  it('presets.json 是目录（读错误非 ENOENT）：抛含文件路径的「读取失败」报错', () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(presetsJsonPath(), { recursive: true })
      // ENOENT 走「无自定义」返回 []；其余读错误必须给出可操作报错而非裸栈
      expect(() => readUserPresets()).toThrow(/读取自定义预设|Failed to read the custom presets/)
      expect(() => readUserPresets()).toThrow(/presets\.json/)
    } finally {
      h.restore()
    }
  })

  it('顶层是对象但没有 presets 数组：报「顶层应为数组，或 { presets: [...] }」', () => {
    const h = fakeHome()
    try {
      writePresetsRaw('{"foo":1}')
      expect(() => readUserPresets()).toThrow(/顶层应为数组|top level must be an array/)
    } finally {
      h.restore()
    }
  })
})

describe('validateUserPresetEntries 逐条归一化（缺口补齐）', () => {
  it('条目为 null / 缺 id：报第 n 条缺少 id（含文件名与序号）', () => {
    expect(() => validateUserPresetEntries([null], 'p.json')).toThrow(/第 1 条缺少 id|Entry 1 .*missing id/)
    expect(() => validateUserPresetEntries([{ label: '没 id' }], 'p.json')).toThrow(/第 1 条缺少 id/)
    expect(() => validateUserPresetEntries([{ id: 'a' }, { vendor: 'v' }], 'p.json')).toThrow(/第 2 条缺少 id|Entry 2/)
  })

  it('模型条目为 null / 缺 id：报「缺失 id 的模型条目」且含预设 id', () => {
    expect(() => validateUserPresetEntries([{ id: 'corp', models: [null] }], 'p.json')).toThrow(/缺失 id 的模型条目|model entry missing id/)
    try {
      validateUserPresetEntries([{ id: 'corp', models: [{ display_name: 'x' }] }], 'p.json')
      expect.unreachable('应抛出')
    } catch (e) {
      expect((e as Error).message).toContain('corp')
    }
  })

  it('endpoints：合法键保留、非法键/非字符串/空白值丢弃、缺省归一为 undefined', () => {
    const out = validateUserPresetEntries(
      [
        {
          id: 'gw',
          endpoints: { openai: 'https://a.internal/v1', grpc: 'https://g.internal', responses: 42, anthropic: '   ' },
        },
      ],
      'p.json'
    )
    // 仅合法协议键 + 非空字符串值保留（trim 后）
    expect(out[0]!.endpoints).toEqual({ openai: 'https://a.internal/v1' })
    // endpoints 整个缺省 → undefined（不是空对象）
    const bare = validateUserPresetEntries([{ id: 'bare' }], 'p.json')
    expect(bare[0]!.endpoints).toBeUndefined()
  })

  it('标量归一化：label/vendor 缺省回退 id、docs_url 保留或丢弃、needs_proxy 仅显式 true、protocol/auth_style 非法回退', () => {
    const [bare] = validateUserPresetEntries([{ id: 'p1' }], 'p.json')
    expect(bare!.label).toBe('p1')
    expect(bare!.vendor).toBe('p1')
    expect(bare!.needs_proxy).toBe(false)
    expect(bare!.docs_url).toBeUndefined()

    const [full] = validateUserPresetEntries(
      [{ id: 'p2', label: 'L', vendor: 'V', docs_url: 'https://docs.example.com', needs_proxy: true, protocol: 'weird', auth_style: 'weird' }],
      'p.json'
    )
    expect(full!.protocol).toBe('openai')
    expect(full!.auth_style).toBe('bearer')
    expect(full!.docs_url).toBe('https://docs.example.com')
    expect(full!.needs_proxy).toBe(true)
    // 空串 docs_url 视为无
    const [emptyDocs] = validateUserPresetEntries([{ id: 'p3', docs_url: '' }], 'p.json')
    expect(emptyDocs!.docs_url).toBeUndefined()
  })

  it('模型字段：合法数值保留、0/负数丢弃、无字段跳过、capabilities 逐项 String 化', () => {
    const [p] = validateUserPresetEntries(
      [
        {
          id: 'p',
          models: [
            { id: 'a', context_window: 1000, max_output: 500, capabilities: [1, 'tools'] },
            { id: 'b' },
            { id: 'c', context_window: 0, max_output: -5, display_name: 42 },
          ],
        },
      ],
      'p.json'
    )
    expect(p!.models![0]).toEqual({ id: 'a', context_window: 1000, max_output: 500, capabilities: ['1', 'tools'] })
    // 无可选字段：只留 id
    expect(p!.models![1]).toEqual({ id: 'b' })
    // 非法数值与非字符串 display_name 一律丢弃
    expect(p!.models![2]).toEqual({ id: 'c' })

    // CORRECT-11 ①：Infinity 曾穿透旧守卫（typeof number 且 >0，!Number.isNaN 又是不可达死臂）——
    // 改 Number.isFinite 后与 NaN/±Infinity 一并拒收
    const [inf] = validateUserPresetEntries(
      [{ id: 'q', models: [{ id: 'inf', context_window: Infinity, max_output: -Infinity }] }],
      'q.json'
    )
    expect(inf!.models![0]).toEqual({ id: 'inf' })
  })
})

describe('knownModelsForBaseUrl 按 host 匹配（缺口补齐）', () => {
  it('命中方舟 host：合并返回内置模型目录（source=preset）', () => {
    const h = fakeHome()
    try {
      const out = knownModelsForBaseUrl('https://ark.cn-beijing.volces.com/api/plan')
      // ark-coding-plan 与 ark-agent-plan 同 host，两份目录都并入
      expect(out['doubao-seed-evolving']).toMatchObject({ context_window: 1048576, max_output: 262144, source: 'preset' })
      expect(out['glm-5.3']).toBeDefined()
    } finally {
      h.restore()
    }
  })

  it('host 匹配但预设无模型目录（groq）：返回空对象；非法 URL 同样返回空对象', () => {
    const h = fakeHome()
    try {
      expect(knownModelsForBaseUrl('https://api.groq.com/openai/v1')).toEqual({})
      expect(knownModelsForBaseUrl('::::not-a-url')).toEqual({})
    } finally {
      h.restore()
    }
  })
})

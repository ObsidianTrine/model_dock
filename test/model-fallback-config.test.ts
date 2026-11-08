import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { loadConfig, ConfigError } from '../src/config/store.js'
import { resolveModelFallback } from '../src/ops/service.js'
import { priceDiffRatios, priceWithinTolerance } from '../src/providers/pricing-core.js'
import { configPath } from '../src/util/paths.js'
import type { ModelMeta } from '../src/config/types.js'

/** 便捷单价构造（USD/百万 token）。 */
const P = (input: number, output: number) => ({ input, output })
/** 注入式查价表：模型 → 价；缺失 = 查不到（null，触发 fail-closed）。 */
const priceTable = (t: Record<string, { input: number; output: number }>) => (m: string) => t[m] ?? null
const META = (extra: Partial<ModelMeta> = {}): ModelMeta => ({ source: 'manual', ...extra })

describe('priceDiffRatios / priceWithinTolerance（价格闸门算式）', () => {
  it('同价 → 0；input/output 独立计档', () => {
    expect(priceDiffRatios(P(10, 30), P(10, 30))).toEqual({ input: 0, output: 0 })
    expect(priceDiffRatios(P(100, 50), P(110, 50))).toEqual({ input: 0.1, output: 0 })
    expect(priceDiffRatios(P(100, 50), P(100, 60))).toEqual({ input: 0, output: 0.2 })
  })

  it('源价为 0：目标同为 0 → 0（相等免费）；目标 >0 → Infinity（拒绝）', () => {
    expect(priceDiffRatios(P(0, 0), P(0, 0)).input).toBe(0)
    expect(priceDiffRatios(P(0, 0), P(5, 5)).input).toBe(Number.POSITIVE_INFINITY)
  })

  it('闸门：恰好 5% 放行（≤），5% 以上拒绝；cache 桶不参与', () => {
    expect(priceWithinTolerance(P(100, 30), P(105, 31.5))).toBe(true)
    expect(priceWithinTolerance(P(100, 30), P(105.1, 30))).toBe(false)
    expect(priceWithinTolerance(P(100, 30), P(100, 30.01), 0.05)).toBe(true)
    // cache_read 差异不影响闸门（计费时缺省回落 input 价）
    expect(priceWithinTolerance({ input: 10, output: 10, cache_read: 1 }, { input: 10, output: 10, cache_read: 2 })).toBe(true)
  })
})

describe('resolveModelFallback（模型级容灾映射校验）', () => {
  const flatPrices = { 'glm-5.3-flash': P(2, 8), 'glm-5.2': P(2, 8) }
  const ctx = (over: Partial<Parameters<typeof resolveModelFallback>[2]> = {}) => ({
    lookupPrice: priceTable(flatPrices),
    ...over,
  })

  it('undefined/null/空表 → undefined（无映射）', () => {
    expect(resolveModelFallback(undefined, 'v', ctx())).toBeUndefined()
    expect(resolveModelFallback(null, 'v', ctx())).toBeUndefined()
    expect(resolveModelFallback({}, 'v', ctx())).toBeUndefined()
  })

  it('形状非法（标量/数组/空值条目）→ ConfigError', () => {
    expect(() => resolveModelFallback('x', 'v', ctx())).toThrow(ConfigError)
    expect(() => resolveModelFallback(['a'], 'v', ctx())).toThrow(ConfigError)
    expect(() => resolveModelFallback({ flash: '' }, 'v', ctx())).toThrow(ConfigError)
    expect(() => resolveModelFallback({ flash: 123 as unknown as string }, 'v', ctx())).toThrow(ConfigError)
    expect(() => resolveModelFallback({ '': 'glm-5.2' }, 'v', ctx())).toThrow(ConfigError)
  })

  it('合法映射 → 归一返回；自映射拒绝', () => {
    expect(resolveModelFallback({ ' glm-5.3-flash ': 'glm-5.2' }, 'v', ctx())).toEqual({ 'glm-5.3-flash': 'glm-5.2' })
    expect(() => resolveModelFallback({ 'glm-5.3-flash': 'glm-5.3-flash' }, 'v', ctx())).toThrow(/不能指向自身|cannot point to itself/)
  })

  it('映射环拒绝；单向传递链合法', () => {
    // 环检测在价格闸门之后，环条目的模型也要给价
    const ab = { a: P(1, 1), b: P(1, 1) }
    expect(() => resolveModelFallback({ a: 'b', b: 'a' }, 'v', ctx({ lookupPrice: priceTable(ab) }))).toThrow(/环|cycle/)
    expect(resolveModelFallback({ a: 'b', b: 'c' }, 'v', ctx({ lookupPrice: priceTable({ ...ab, c: P(1, 1) }) }))).toEqual({ a: 'b', b: 'c' })
  })

  it('查不到价 fail-closed：报错点名缺价模型并提示补 pricing.json', () => {
    const e = (() => {
      try {
        resolveModelFallback({ 'glm-5.3-flash': 'glm-5.2' }, 'v', ctx({ lookupPrice: priceTable({ 'glm-5.3-flash': P(2, 8) }) }))
        return null
      } catch (err) {
        return err as ConfigError
      }
    })()
    expect(e).toBeInstanceOf(ConfigError)
    expect(e?.message).toContain('glm-5.2')
    expect(e?.hint).toContain('pricing.json')
  })

  it('价格差超限：报错带两档百分比与上限；闸门边界值放行', () => {
    const dearer = { 'glm-5.3-flash': P(2, 8), 'glm-5.2': P(2, 9) } // output 差 12.5%
    expect(() => resolveModelFallback({ 'glm-5.3-flash': 'glm-5.2' }, 'v', ctx({ lookupPrice: priceTable(dearer) }))).toThrow(/超限|too wide/)
    // 边界 5%：用整数价避免浮点减法噪声（10/200 与 40/800 均精确等于 0.05）
    const edge = { 'glm-5.3-flash': P(200, 800), 'glm-5.2': P(210, 840) }
    expect(resolveModelFallback({ 'glm-5.3-flash': 'glm-5.2' }, 'v', ctx({ lookupPrice: priceTable(edge) }))).toBeDefined()
  })

  it('目录成员：目录非空时 source/target 都须在册（防 typo）；目录未管理容忍字面量', () => {
    const catalog = { 'glm-5.3-flash': META(), 'glm-5.2': META() }
    expect(resolveModelFallback({ 'glm-5.3-flash': 'glm-5.2' }, 'v', ctx({ models: catalog }))).toBeDefined()
    expect(() => resolveModelFallback({ 'glm-5.3-flash': 'glm-5.2-typo' }, 'v', ctx({ models: catalog }))).toThrow(/不在|not in the catalog/)
    // 目录未管理（空表）：任意字面量放行（查价注入恒有价）
    expect(resolveModelFallback({ 'some-unknown': 'another-unknown' }, 'v', ctx({ models: {}, lookupPrice: () => P(1, 1) }))).toBeDefined()
  })
})

describe('migrate 手编 config.toml 的 model_fallback 形状守卫', () => {
  /** 在沙箱 home 落一份最小 config.toml（.modeldock 目录可能尚不存在，先建）。 */
  const writeConfigToml = (lines: string[]): void => {
    const p = configPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, [...lines, ''].join('\n'), 'utf8')
  }
  const writeToml = (fallbackBody: string): { restore: () => void } => {
    const h = fakeHome()
    writeConfigToml([
      'version = 1',
      '',
      '[providers.volc]',
      'base_url = "https://ark.example.com"',
      'protocol = "openai"',
      'auth_style = "bearer"',
      'key_ref = "file:volc"',
      '',
      '[providers.volc.model_fallback]',
      fallbackBody,
    ])
    return h
  }

  it('合法表形状放行且字段可达', async () => {
    const h = writeToml('"glm-5.3-flash" = "glm-5.2"')
    try {
      const cfg = await loadConfig()
      expect(cfg.providers.volc?.model_fallback).toEqual({ 'glm-5.3-flash': 'glm-5.2' })
    } finally {
      h.restore()
    }
  })

  it('值非字符串 / 数组值 / 整节为标量 → ConfigError 且指名 model_fallback', async () => {
    for (const body of ['"glm-5.3-flash" = 123', '"glm-5.3-flash" = ["a"]']) {
      const h = writeToml(body)
      try {
        await expect(loadConfig()).rejects.toThrow(/model_fallback/)
      } finally {
        h.restore()
      }
    }
    const h = fakeHome()
    try {
      writeConfigToml([
        'version = 1',
        '[providers.volc]',
        'base_url = "https://x"',
        'protocol = "openai"',
        'auth_style = "bearer"',
        'key_ref = "file:v"',
        'model_fallback = 5',
      ])
      await expect(loadConfig()).rejects.toThrow(ConfigError)
    } finally {
      h.restore()
    }
  })

  it('未配 model_fallback 的存量配置零影响', async () => {
    const h = fakeHome()
    try {
      writeConfigToml([
        'version = 1',
        '[providers.volc]',
        'base_url = "https://x"',
        'protocol = "openai"',
        'auth_style = "bearer"',
        'key_ref = "file:v"',
      ])
      const cfg = await loadConfig()
      expect(cfg.providers.volc?.model_fallback).toBeUndefined()
    } finally {
      h.restore()
    }
  })
})

// 防路径回归哨兵：本文件仅经 fakeHome 沙箱写 config.toml，不得触真实 home
describe('哨兵：临时目录隔离', () => {
  it('configPath 落在 MODELRDOCK_FAKE_HOME 下', () => {
    const h = fakeHome()
    try {
      expect(configPath().startsWith(path.join(h.home, '')) || configPath().includes(h.home)).toBe(true)
    } finally {
      h.restore()
    }
  })
})

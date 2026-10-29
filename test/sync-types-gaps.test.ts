import { describe, expect, it } from 'vitest'
import { SYNCDOC_FMT, validateSyncdoc, type Syncdoc } from '../src/sync/types.js'

/**
 * 测试盲区补齐：src/sync/types.ts validateSyncdoc 剩余拒绝分支（2026-10-29 全量 coverage 实测圈出）。
 * 既有 syncdoc.test.ts 已覆盖：fmt/v(99)/缺 ts/data、provider 缺 base_url、未知 protocol、
 * 无 key 无 key_ref、profile 缺 provider、规则缺 target、userPresets {nope:1}、篡改信封。
 * 本文件补：顶层非对象、fmt/v 缺失形态、providers/profiles 段与条目形状、endpoints/models 形状、
 * auth_style 非法、fallback 形状、userPresets/scheduleRules 为 null 放行、规则条目形状/HH:mm/dayFilter。
 */

function sampleDoc(): Syncdoc {
  return {
    fmt: SYNCDOC_FMT,
    v: 1,
    ts: '2026-10-29T00:00:00.000Z',
    data: {
      providers: {
        ark: { base_url: 'https://ark.example.com/api', protocol: 'anthropic', auth_style: 'bearer', key: 'sk-test' },
      },
      profiles: { main: { provider: 'ark', default_model: 'auto' } },
      userPresets: [],
      scheduleRules: [{ start: '09:00', end: '18:00', target: 'ark' }],
    },
  }
}

function field(over: (d: Syncdoc) => void): Syncdoc {
  const d = sampleDoc()
  over(d)
  return d
}

describe('validateSyncdoc 顶层与 fmt/v 形态（缺口补齐）', () => {
  it('顶层非对象（null / 字符串 / 数组）拒绝', () => {
    expect(() => validateSyncdoc(null)).toThrow(/不是合法的 JSON 对象|not a valid JSON object/)
    expect(() => validateSyncdoc('x')).toThrow(/不是合法的 JSON 对象/)
    expect(() => validateSyncdoc([1])).toThrow(/不是合法的 JSON 对象/)
  })

  it('fmt 缺失：报错文案里 fmt 为空串占位', () => {
    const d = sampleDoc() as Record<string, unknown>
    delete d.fmt
    expect(() => validateSyncdoc(d)).toThrow(/fmt=/)
  })

  it('v 非正整数（0 / 1.5 / 字符串）拒绝', () => {
    expect(() => validateSyncdoc(field((d) => { (d as unknown as { v: unknown }).v = 0 }))).toThrow(/缺少有效的格式版本号|no valid format version/)
    expect(() => validateSyncdoc(field((d) => { (d as unknown as { v: unknown }).v = 1.5 }))).toThrow(/缺少有效的格式版本号/)
    expect(() => validateSyncdoc(field((d) => { (d as unknown as { v: unknown }).v = '1' }))).toThrow(/缺少有效的格式版本号/)
  })
})

describe('validateSyncdoc providers/profiles 形状（缺口补齐）', () => {
  it('providers 段非对象（数组/字符串）拒绝', () => {
    expect(() => validateSyncdoc(field((d) => { (d.data as unknown as Record<string, unknown>).providers = [] }))).toThrow(/providers 段格式错误|Invalid providers section/)
    expect(() => validateSyncdoc(field((d) => { (d.data as unknown as Record<string, unknown>).providers = 'x' }))).toThrow(/providers 段格式错误/)
  })

  it('provider 条目非对象拒绝', () => {
    expect(() => validateSyncdoc(field((d) => { (d.data.providers as unknown as Record<string, unknown>).ark = 42 }))).toThrow(/条目格式错误|Invalid entry/)
  })

  it('auth_style 非法拒绝', () => {
    expect(() =>
      validateSyncdoc(field((d) => { (d.data.providers.ark as unknown as Record<string, unknown>).auth_style = 'sig' }))
    ).toThrow(/auth_style/)
  })

  it('endpoints 非 object 拒绝（数组与标量都算）', () => {
    expect(() =>
      validateSyncdoc(field((d) => { (d.data.providers.ark as unknown as Record<string, unknown>).endpoints = [] }))
    ).toThrow(/endpoints 格式错误|invalid endpoints/)
    expect(() =>
      validateSyncdoc(field((d) => { (d.data.providers.ark as unknown as Record<string, unknown>).endpoints = 'https://x' }))
    ).toThrow(/endpoints 格式错误/)
  })

  it('models 目录非 object（数组也算）拒绝', () => {
    expect(() =>
      validateSyncdoc(field((d) => { (d.data.providers.ark as unknown as Record<string, unknown>).models = [] }))
    ).toThrow(/models 目录格式错误|invalid models catalog/)
  })

  it('profiles 段非对象 / profile 条目非对象 / fallback 非数组拒绝', () => {
    expect(() => validateSyncdoc(field((d) => { (d.data as unknown as Record<string, unknown>).profiles = [] }))).toThrow(/profiles 段格式错误|Invalid profiles section/)
    expect(() => validateSyncdoc(field((d) => { (d.data.profiles as unknown as Record<string, unknown>).main = 7 }))).toThrow(/条目格式错误|Invalid entry/)
    expect(() =>
      validateSyncdoc(field((d) => { (d.data.profiles.main as unknown as Record<string, unknown>).fallback = 'ark' }))
    ).toThrow(/fallback 格式错误|invalid fallback/)
  })
})

describe('validateSyncdoc userPresets / scheduleRules 形状（缺口补齐）', () => {
  it('userPresets 与 scheduleRules 显式 null：视为缺省放行', () => {
    expect(() =>
      validateSyncdoc(field((d) => { (d.data as unknown as Record<string, unknown>).userPresets = null }))
    ).not.toThrow()
    expect(() =>
      validateSyncdoc(field((d) => { (d.data as unknown as Record<string, unknown>).scheduleRules = null }))
    ).not.toThrow()
  })

  it('scheduleRules 非数组 / 规则条目非对象拒绝', () => {
    expect(() =>
      validateSyncdoc(field((d) => { (d.data as unknown as Record<string, unknown>).scheduleRules = {} }))
    ).toThrow(/定时规则格式错误|Invalid schedule rules/)
    expect(() =>
      validateSyncdoc(field((d) => { (d.data as unknown as Record<string, unknown>).scheduleRules = [42] }))
    ).toThrow(/第 1 条格式错误|Schedule rule #1 is malformed/)
  })

  it('start/end 非 HH:mm 拒绝（正则只验形状：两位数字:两位数字，不验数值范围）', () => {
    expect(() =>
      validateSyncdoc(field((d) => { d.data.scheduleRules[0]!.start = '9:00' }))
    ).toThrow(/start\/end 应为 HH:mm|start\/end must be HH:mm/)
    expect(() =>
      validateSyncdoc(field((d) => { d.data.scheduleRules[0]!.end = '12:3' }))
    ).toThrow(/HH:mm/)
  })

  it('dayFilter 非法值拒绝（三种合法值放行）', () => {
    expect(() =>
      validateSyncdoc(field((d) => { d.data.scheduleRules[0]!.dayFilter = 'allday' as never }))
    ).toThrow(/dayFilter/)
    for (const f of ['workday', 'weekend', 'holiday'] as const) {
      expect(() => validateSyncdoc(field((d) => { d.data.scheduleRules[0]!.dayFilter = f }))).not.toThrow()
    }
  })
})

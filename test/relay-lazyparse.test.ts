import { describe, expect, it } from 'vitest'
import { rewriteModel, topLevelModel } from '../src/gateway/relay.js'
import type { ResolvedTarget } from '../src/gateway/state.js'

// 对 `perf01-relay-lazy-parse` 引入的「懒解析快路径」的回归测试。核心不变量：
// 改写判定只需模型名字符串；「判定不需改写」时返回入参 body 本身的同一 Buffer 引用，
// 证明未 parse + 未重序列化。改写确实需要时行为与旧实现逐字节等价。

const ROUTED = '/v1/messages'
const mk = (s: string) => Buffer.from(s, 'utf8')

function target(opts: {
  default_model?: string
  aliases?: Record<string, string>
  modelOverride?: string
  providerModels?: Record<string, { source: 'manual' }>
}): ResolvedTarget {
  return {
    harness: 'test',
    profileName: 'p',
    profile: {
      name: 'p',
      provider: 'prov',
      ...(opts.default_model ? { default_model: opts.default_model } : {}),
      ...(opts.aliases ? { aliases: opts.aliases } : {}),
    },
    provider: {
      base_url: 'https://up.example.com',
      protocol: 'anthropic',
      auth_style: 'bearer',
      key_ref: 'file:k',
      ...(opts.providerModels ? { models: opts.providerModels } : {}),
    },
    ...(opts.modelOverride ? { modelOverride: opts.modelOverride } : {}),
  }
}

describe('relay 懒解析快路径：不需改写时返回入参 body 同一引用', () => {
  it('配 default_model 且请求模型与目标一致：final === wire，body 同引用', () => {
    const t = target({ default_model: 'gpt-4o' })
    const body = mk('{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}')
    const r = rewriteModel(t, body, ROUTED)
    expect(r.body).toBe(body) // 未 parse、未重序列化
    expect(r.modelAfter).toBe('gpt-4o')
  })

  it('配 default_model 但请求为非内置模型：不改写，body 同引用', () => {
    const t = target({ default_model: 'dm' })
    const body = mk('{"model":"some-other-model"}')
    const r = rewriteModel(t, body, ROUTED)
    expect(r.body).toBe(body)
    expect(r.modelAfter).toBe('some-other-model')
  })

  it('大请求体长 while 体：不需改写时不 parse（body 同引用即旁证）', () => {
    const t = target({ default_model: 'dm' })
    const content = 'x'.repeat(1_000_000)
    const body = mk(`{"model":"gpt-x","messages":[{"role":"user","content":"${content}"}]}`)
    const r = rewriteModel(t, body, ROUTED)
    expect(r.body).toBe(body)
    expect(r.modelAfter).toBe('gpt-x')
  })
})

describe('relay 懒解析快路径：需改写时正确改写', () => {
  it('tierFallback：claude 内置名改写为 default_model', () => {
    const t = target({ default_model: 'glm-5-3-flash' })
    const body = mk('{"model":"claude-sonnet-4-5"}')
    const r = rewriteModel(t, body, ROUTED)
    expect(r.body).not.toBe(body) // 确需改写 → 产出新序列化 Buffer
    expect(r.modelAfter).toBe('glm-5-3-flash')
    expect(JSON.parse(r.body.toString('utf8')).model).toBe('glm-5-3-flash')
  })

  it('anthropic. 剥壳：目录内真实 ID 还原', () => {
    const t = target({ default_model: 'fallback', providerModels: { 'gpt-x': { source: 'manual' } } })
    const body = mk('{"model":"anthropic.gpt-x"}')
    const r = rewriteModel(t, body, ROUTED)
    expect(r.modelAfter).toBe('gpt-x')
    expect(JSON.parse(r.body.toString('utf8')).model).toBe('gpt-x')
  })

  it('anthropic. 剥壳后 ID 不在目录：保持原样透传（body 同引用）', () => {
    const t = target({ default_model: 'fallback', providerModels: { 'gpt-x': { source: 'manual' } } })
    const body = mk('{"model":"anthropic.unknown"}')
    const r = rewriteModel(t, body, ROUTED)
    expect(r.body).toBe(body)
    expect(r.modelAfter).toBe('anthropic.unknown')
  })
})

describe('relay aliases 命中与透传', () => {
  it('命中：按别名改写', () => {
    const t = target({ aliases: { 'old-model': 'new-model' } })
    const body = mk('{"model":"old-model"}')
    const r = rewriteModel(t, body, ROUTED)
    expect(r.modelAfter).toBe('new-model')
    expect(JSON.parse(r.body.toString('utf8')).model).toBe('new-model')
  })

  it('未命中：透传原引用', () => {
    const t = target({ aliases: { 'old-model': 'new-model' } })
    const body = mk('{"model":"other-model"}')
    const r = rewriteModel(t, body, ROUTED)
    expect(r.body).toBe(body)
    expect(r.modelAfter).toBe('other-model')
  })
})

describe('relay modelOverride 优先', () => {
  it('即使命中别名，候选级映射仍压过别名改写', () => {
    const t = target({ aliases: { 'a': 'alias-m' }, modelOverride: 'override-m' })
    const body = mk('{"model":"a"}')
    const r = rewriteModel(t, body, ROUTED)
    expect(r.modelAfter).toBe('override-m')
    expect(JSON.parse(r.body.toString('utf8')).model).toBe('override-m')
  })
})

describe('relay pre === null 回落全量解析（行为与改前一致）', () => {
  it('含转义键：扫描器给 null，全量解析仍正确改写 claude 内置名', () => {
    const t = target({ default_model: 'dm' })
    const esc = mk('{"mod\\u0065l":"claude-3-5-haiku"}')
    expect(topLevelModel(esc)).toBeNull()
    const r = rewriteModel(t, esc, ROUTED)
    expect(r.modelAfter).toBe('dm')
    expect(JSON.parse(r.body.toString('utf8')).model).toBe('dm')
  })

  it('截断（非 JSON）：透传原引用、无 modelAfter', () => {
    const t = target({ default_model: 'dm' })
    const bad = mk('{"model":"x"')
    expect(topLevelModel(bad)).toBeNull()
    const r = rewriteModel(t, bad, ROUTED)
    expect(r.body).toBe(bad)
    expect(r.modelAfter).toBeUndefined()
  })

  it('顶层非对象数组：全量解析不抽取 model，无 default 时原引用透传', () => {
    const arr = mk('[{"model":"x"}]')
    expect(topLevelModel(arr)).toBeNull()
    const r = rewriteModel(target({}), arr, ROUTED)
    expect(r.body).toBe(arr)
    expect(r.modelAfter).toBeUndefined()
  })
})
import { describe, expect, it } from 'vitest'
import { rewriteModel, topLevelModel } from '../src/gateway/relay.js'
import type { ResolvedTarget } from '../src/gateway/state.js'

// 对 `perf01-relay-lazy-parse` 引入的「懒解析快路径」的回归测试。核心不变量：
// 改写判定只需模型名字符串；「判定不需改写」时返回入参 body 本身的同一 Buffer 引用，
// 证明未 parse + 未重序列化。改写确实需要时行为与旧实现逐字节等价。
//
// `perf-relay-rewrite` 再加一层字节级原位替换：确需改写且浅扫描已锁定顶层 model 值的
// 字节区间、新名仅含 JSON 安全字符（无需转义）时，三段拼接（前缀原样 + "新值" + 后缀原样）
// 免掉全量 JSON.parse + stringify。证明「未走全量解析」的判据：含不规则空白 / 重复键 /
// 多字节字符的体，改写后除 model 值外所有字节原样保留（stringify 会压缩空白并合并重复键）。

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

// ---------------------------------------------------------------------------
// 字节级原位替换快路径（perf-relay-rewrite）：确需改写时免全量 JSON.parse + stringify。
// 命中条件：浅扫描定位到顶层 model 字符串值的字节区间（qStart ≥ 0）且新名通过
// SAFE_MODEL_NAME_RE 白名单（无需转义）；其余回落全量路径，行为逐字节等价。

describe('relay 字节级原位替换快路径', () => {
  it('典型体（多条消息 + model 在最前）：改写结果与全量 parse/stringify 路径字节一致', () => {
    const t = target({ default_model: 'glm-4.6:deepseek' }) // 新名含 : ——白名单内的复合命名
    const parsed = { model: 'claude-sonnet-4-5-20250929', messages: [{ role: 'user', content: '你好，世界' }], max_tokens: 64 }
    const body = mk(JSON.stringify(parsed))
    const r = rewriteModel(t, body, ROUTED)
    expect(r.modelAfter).toBe('glm-4.6:deepseek')
    // 紧凑体上拼接结果与 stringify 逐字节一致（键序、标点完全相同）
    expect(r.body.toString('utf8')).toBe(JSON.stringify({ ...parsed, model: 'glm-4.6:deepseek' }))
    expect(JSON.parse(r.body.toString('utf8')).model).toBe('glm-4.6:deepseek')
  })

  it('旧值长新值短：claude-sonnet-4-5-20250929 → glm-4.6，前后缀字节原样', () => {
    const t = target({ default_model: 'glm-4.6' })
    const raw = '{"a":1,"model":"claude-sonnet-4-5-20250929","note":"中文尾巴"}'
    const r = rewriteModel(t, mk(raw), ROUTED)
    expect(r.body.toString('utf8')).toBe('{"a":1,"model":"glm-4.6","note":"中文尾巴"}')
  })

  it('旧值短新值长：glm-4.6 → claude-sonnet-4-5-20250929（别名映射），长度差正确', () => {
    const t = target({ aliases: { 'glm-4.6': 'claude-sonnet-4-5-20250929' } })
    const raw = '{"model":"glm-4.6","msgs":["中文消息"]}'
    const r = rewriteModel(t, mk(raw), ROUTED)
    expect(r.body.toString('utf8')).toBe('{"model":"claude-sonnet-4-5-20250929","msgs":["中文消息"]}')
  })

  it('确未走全量解析：不规则空白 + 重复键 + 多字节，除 model 值外字节原样保留', () => {
    const t = target({ default_model: 'glm-4.6' })
    const raw = '{"msgs":["你好，世界"],"model" :  "claude-sonnet-4-5-20250929" ,"model":"claude-haiku","note":"中文内容"}'
    const r = rewriteModel(t, mk(raw), ROUTED)
    expect(r.modelAfter).toBe('glm-4.6') // 改写判定取末次出现（JSON.parse 同语义）
    // 拼接只替换末次 model 值的引号区间，其余字节（首现 model、空白、中文）一模一样
    expect(r.body.toString('utf8')).toBe(
      '{"msgs":["你好，世界"],"model" :  "claude-sonnet-4-5-20250929" ,"model":"glm-4.6","note":"中文内容"}'
    )
    // 对照：全量 stringify 会压缩空白、合并重复键——字节不同，证明快路径确实没走它
    const full = JSON.parse(raw) as Record<string, unknown>
    full.model = 'glm-4.6'
    expect(r.body.toString('utf8')).not.toBe(JSON.stringify(full))
    // 语义与 stringify 等价
    expect(JSON.parse(r.body.toString('utf8'))).toEqual(full)
  })

  it('model 值是最后一个键且后有空白：尾缀字节原样保留', () => {
    const t = target({ default_model: 'dm' })
    const r = rewriteModel(t, mk('{"model":"claude-x"  \n}'), ROUTED)
    expect(r.body.toString('utf8')).toBe('{"model":"dm"  \n}')
  })

  it('旧值含转义序列：整段值字节（含引号）被替换为不带转义的新名', () => {
    const t = target({ aliases: { 'mo"del': 'safe-model' } })
    const r = rewriteModel(t, mk('{"model":"mo\\"del","k":1}'), ROUTED)
    expect(r.modelAfter).toBe('safe-model')
    expect(r.body.toString('utf8')).toBe('{"model":"safe-model","k":1}')
  })

  it('旧值含多字节 UTF-8：区间按字节定位正确，替换不损伤', () => {
    const t = target({ aliases: { '旧模型': 'glm-4.6' } })
    const r = rewriteModel(t, mk('{"model":"旧模型","note":"世界"}'), ROUTED)
    expect(r.body.toString('utf8')).toBe('{"model":"glm-4.6","note":"世界"}')
  })

  it('新名含需转义字符（unicode）：回落全量 parse/stringify，结果正确', () => {
    const t = target({ aliases: { 'old': '中文模型' } })
    const raw = '{"model" : "old" ,  "k":1}'
    const r = rewriteModel(t, mk(raw), ROUTED)
    expect(r.modelAfter).toBe('中文模型')
    // 全量路径旁证：stringify 压缩了原体的不规则空白
    expect(r.body.toString('utf8')).toBe('{"model":"中文模型","k":1}')
    expect(JSON.parse(r.body.toString('utf8')).model).toBe('中文模型')
  })

  it('新名含引号（需转义）：回落全量路径，转义正确', () => {
    const t = target({ aliases: { 'old': 'a"b' } })
    const r = rewriteModel(t, mk('{"model":"old","k":1}'), ROUTED)
    expect(r.body.toString('utf8')).toBe('{"model":"a\\"b","k":1}')
    expect(JSON.parse(r.body.toString('utf8')).model).toBe('a"b')
  })

  it('顶层 model 值非字符串（无可替换区间）：回落全量路径整字段替换', () => {
    const t = target({ default_model: 'dm' })
    const r = rewriteModel(t, mk('{"model":123,"k":1}'), ROUTED)
    expect(r.modelAfter).toBe('dm')
    expect(r.body.toString('utf8')).toBe('{"model":"dm","k":1}')
  })

  it('顶层无 model 键：回落全量路径注入 default_model（既有行为）', () => {
    const t = target({ default_model: 'dm' })
    const r = rewriteModel(t, mk('{"messages":[],"k":1}'), ROUTED)
    expect(r.modelAfter).toBe('dm')
    expect(JSON.parse(r.body.toString('utf8')).model).toBe('dm')
  })

  it('顶层非对象（数组）/ 解析失败：透传不谎报 modelAfter（既有回归）', () => {
    const dm = target({ default_model: 'dm' })
    const arr = mk('[{"model":"claude-x"}]')
    const r1 = rewriteModel(dm, arr, ROUTED)
    expect(r1.body).toBe(arr)
    expect(r1.modelAfter).toBeUndefined()
    const bad = mk('{"model":"x"')
    const r2 = rewriteModel(dm, bad, ROUTED)
    expect(r2.body).toBe(bad)
    expect(r2.modelAfter).toBeUndefined()
  })
})
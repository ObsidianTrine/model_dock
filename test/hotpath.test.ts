import { describe, expect, it } from 'vitest'
import { Agent, ProxyAgent } from 'undici'
import { fakeHome } from './helpers.js'
import { rewriteModel, topLevelModel } from '../src/gateway/relay.js'
import { buildDispatcher } from '../src/gateway/proxy.js'
import { createUsageTap, type UsageStats } from '../src/gateway/usage.js'
import { buildRuntime, logRequest, type ResolvedTarget } from '../src/gateway/state.js'
import { globToRegExp, matchAlias } from '../src/util/glob.js'
import { drainAppendStreams } from '../src/util/fsx.js'
import { logsDir } from '../src/util/paths.js'
import fs from 'node:fs'
import path from 'node:path'
import type { Transform } from 'node:stream'

// ---------- 公共小工具 ----------

function target(opts: { default_model?: string; aliases?: Record<string, string>; modelOverride?: string }): ResolvedTarget {
  return {
    harness: 'test',
    profileName: 'p',
    profile: {
      name: 'p',
      provider: 'prov',
      ...(opts.default_model ? { default_model: opts.default_model } : {}),
      ...(opts.aliases ? { aliases: opts.aliases } : {}),
    },
    provider: { base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' },
    ...(opts.modelOverride ? { modelOverride: opts.modelOverride } : {}),
  }
}

const ROUTED = '/v1/messages'

/** 原实现参照（快路径之前的完整解析逻辑），快路径必须与它逐字段等价 */
function legacyRewrite(t: ResolvedTarget, body: Buffer, p: string): { body: Buffer; modelAfter?: string } {
  if (body.length === 0 || !/\/v1\/(messages|messages\/count_tokens|chat\/completions|completions|responses|embeddings)$/.test(p.split('?')[0])) return { body }
  let json: any
  try {
    json = JSON.parse(body.toString('utf8'))
  } catch {
    return { body }
  }
  if (!json || typeof json !== 'object') return { body }
  const requested = typeof json.model === 'string' ? json.model : undefined
  const alias = requested ? matchAlias(t.profile.aliases, requested) : undefined
  const final = t.modelOverride ?? alias ?? requested ?? t.profile.default_model
  let modelAfter = requested
  if (final !== undefined && final !== requested) {
    json.model = final
    modelAfter = final
    return { body: Buffer.from(JSON.stringify(json), 'utf8'), modelAfter }
  }
  if (final !== undefined) modelAfter = final
  return { body, modelAfter }
}

function feedTap(chunks: Buffer[], contentType: string): Promise<UsageStats> {
  const tap = createUsageTap(contentType) as Transform & { getUsage: () => UsageStats }
  return new Promise((resolve) => {
    tap.on('finish', () => resolve(tap.getUsage()))
    for (const c of chunks) tap.write(c)
    tap.end()
  })
}

// ---------- A3：模型改写快路径（顶层 model 浅扫描与全量解析等价） ----------

describe('topLevelModel：浅扫描与 JSON.parse 同语义', () => {
  const cases: Array<[string, string | undefined]> = [
    ['{"model":"gpt-x","messages":[]}', 'gpt-x'],
    ['{"messages":[]}', undefined], // 无 model 键
    ['{"model":123}', undefined], // 非字符串值
    ['{"model":null}', undefined],
    ['{"model":"a","model":"b"}', 'b'], // 重复键取最后一个（JSON.parse 同语义）
    ['{"model":"x","model":5}', undefined], // 末次出现非字符串
    ['{"m":{"model":"inner"},"model":"outer"}', 'outer'], // 嵌套键不算
    ['{"model":"first","x":{"model":"inner"}}', 'first'], // 顶层的在前，后续嵌套键不覆盖
    ['{"n":{"d":[1,2,{"model":"deep"}]},"model":"top"}', 'top'], // 数组内嵌套键不算
    ['{"prompt":"say \\"model\\": hi","model":"real"}', 'real'], // 字符串值里的 "model": 字面量不算
    ['{"a":"},\\"model\\":\\"evil\\"","model":"good"}', 'good'], // 值含转义引号与花括号序列
    ['{"model":"mo\\"del"}', 'mo"del'], // 值内转义解码
    ['{"model":"\\u4e2d\\u6587"}', '中文'], // unicode 转义值解码
    ['{"model" :  "spaced" }', 'spaced'], // 空白变体
    ['  {"model":"lead"}\n', 'lead'], // 前导空白
    ['{"model":""}', ''], // 空字符串
    ['{"model":"含中文"}', '含中文'], // 多字节值
    ['{}', undefined],
  ]
  for (const [body, want] of cases) {
    it(`扫描结果一致：${body.slice(0, 40)}`, () => {
      expect(topLevelModel(Buffer.from(body, 'utf8'))).toBe(want)
      const parsed = JSON.parse(body) as { model?: unknown }
      expect(topLevelModel(Buffer.from(body, 'utf8'))).toBe(typeof parsed.model === 'string' ? parsed.model : undefined)
    })
  }

  it('无法安全判定时返回 null（调用方退回完整解析）', () => {
    expect(topLevelModel(Buffer.from(''))).toBeNull()
    expect(topLevelModel(Buffer.from('notjson'))).toBeNull()
    expect(topLevelModel(Buffer.from('['))).toBeNull()
    expect(topLevelModel(Buffer.from('{"model":"x"'))).toBeNull() // 截断
    expect(topLevelModel(Buffer.from('{"mod\\u0065l":"u"}'))).toBeNull() // 转义键名放弃
    expect(topLevelModel(Buffer.from('\uFEFF{"model":"bom"}'))).toBeNull() // BOM
  })
})

describe('rewriteModel：纯透传快路径与原实现逐字段等价', () => {
  const bodies = [
    '{"model":"gpt-x","messages":[{"role":"user","content":"hi"}]}',
    '{"messages":[]}',
    '{"model":123}',
    '{"model":"a","model":"b"}',
    '{"m":{"model":"inner"},"model":"outer"}',
    '{"a":"},\\"model\\":\\"evil\\"","model":"good"}',
    '{"model":"mo\\"del"}',
    '{"model" :  "spaced" }',
    '[{"model":"arr"}]',
    '{"model":"x"',
    '\uFEFF{"model":"bom"}',
    '{"model":"m","messages":"' + 'x'.repeat(300_000) + '"}',
  ]
  const plain = target({})

  for (const b of bodies) {
    it(`透传等价：${b.slice(0, 36)}${b.length > 40 ? '…' : ''}`, () => {
      const body = Buffer.from(b, 'utf8')
      const got = rewriteModel(plain, body, ROUTED)
      const want = legacyRewrite(plain, body, ROUTED)
      expect(got.modelAfter).toBe(want.modelAfter)
      expect(got.body.equals(want.body)).toBe(true)
      expect(got.body).toBe(body) // 无改写必须原样透传（不重序列化）
    })
  }

  it('非路由路径不解析不重写', () => {
    const body = Buffer.from('{"model":"a"}')
    const r = rewriteModel(plain, body, '/v1/files')
    expect(r.body).toBe(body)
    expect(r.modelAfter).toBeUndefined()
  })

  it('有 default_model / aliases / override 时走完整解析并正常改写', () => {
    const body = Buffer.from('{"model":"gpt-x"}')
    // 别名精确命中
    const r1 = rewriteModel(target({ aliases: { 'gpt-x': 'upstream-x' } }), body, ROUTED)
    expect(r1.modelAfter).toBe('upstream-x')
    expect(JSON.parse(r1.body.toString('utf8')).model).toBe('upstream-x')
    // 别名通配命中（正则编译缓存路径）
    const r2 = rewriteModel(target({ aliases: { 'gpt-*': 'mapped' } }), body, ROUTED)
    expect(r2.modelAfter).toBe('mapped')
    // default_model 兜底：请求缺 model 键时注入
    const r3 = rewriteModel(target({ default_model: 'dm' }), Buffer.from('{"messages":[]}'), ROUTED)
    expect(r3.modelAfter).toBe('dm')
    expect(JSON.parse(r3.body.toString('utf8')).model).toBe('dm')
    // 候选级映射优先于一切
    const r4 = rewriteModel(target({ aliases: { 'gpt-x': 'alias-win' }, modelOverride: 'override-win' }), body, ROUTED)
    expect(r4.modelAfter).toBe('override-win')
    // 请求模型等于目标：不改写不重序列化
    const r5 = rewriteModel(target({ default_model: 'gpt-x' }), body, ROUTED)
    expect(r5.modelAfter).toBe('gpt-x')
    expect(r5.body).toBe(body)
  })
})

describe('globToRegExp：编译缓存不改变匹配行为', () => {
  it('同 pattern 复用同一 RegExp 实例', () => {
    expect(globToRegExp('a.b*')).toBe(globToRegExp('a.b*'))
    expect(globToRegExp('a.b*').test('a.bX')).toBe(true)
    expect(globToRegExp('a.b*').test('aXbX')).toBe(false)
  })
})

// ---------- A1：direct 共享调优 Agent ----------

describe('buildDispatcher：direct 单例与代理分支', () => {
  it('direct 两次调用返回同一 Agent 实例（连接复用跨请求生效）', () => {
    const a = buildDispatcher(undefined)
    expect(a).toBe(buildDispatcher('direct'))
    expect(a).toBeInstanceOf(Agent)
  })

  it('显式代理 URL 返回 ProxyAgent；env 模式按环境变量分流', () => {
    expect(buildDispatcher('http://127.0.0.1:7890')).toBeInstanceOf(ProxyAgent)
    const saved: Record<string, string | undefined> = {}
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    try {
      expect(buildDispatcher('env')).toBe(buildDispatcher(undefined)) // 无代理环境变量回落直连
      process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
      expect(buildDispatcher('env')).toBeInstanceOf(ProxyAgent)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

// ---------- A4：usage tap 预过滤 + UTF-8 跨 chunk ----------

describe('createUsageTap：预过滤与多字节边界', () => {
  it('SSE 带中文 content 且 chunk 在多字节字符中间切开：usage 仍提取（StringDecoder）', async () => {
    const line = 'data: {"choices":[{"delta":{"content":"模型测试"}}],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n'
    const buf = Buffer.from(line, 'utf8')
    // 「模」是 3 字节 UTF-8，从其首字节后 1 字节处切开
    const head = Buffer.from('data: {"choices":[{"delta":{"content":"模', 'utf8')
    const usage = await feedTap([buf.subarray(0, head.length), buf.subarray(head.length)], 'text/event-stream')
    expect(usage).toEqual({ input_tokens: 11, output_tokens: 7, cache_read_tokens: 0, cache_creation_tokens: 0 })
  })

  it('anthropic 形态：message_start/message_delta 提取不变，无 usage 的 delta 行跳过解析', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}}}',
      'data: {"type":"content_block_delta","delta":{"text":"你好，世界"}}',
      'data: {"type":"message_delta","usage":{"output_tokens":42}}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n'
    const usage = await feedTap([Buffer.from(sse, 'utf8')], 'text/event-stream')
    expect(usage).toEqual({ input_tokens: 100, output_tokens: 42, cache_read_tokens: 20, cache_creation_tokens: 5 })
  })

  it('非流式 JSON：中文跨 chunk 切开，顶层 usage 照常提取', async () => {
    const json = '{"content":"模型输出内容","usage":{"prompt_tokens":3,"completion_tokens":4}}'
    const buf = Buffer.from(json, 'utf8')
    const head = Buffer.from('{"content":"模', 'utf8')
    const usage = await feedTap([buf.subarray(0, head.length), buf.subarray(head.length)], 'application/json')
    expect(usage).toEqual({ input_tokens: 3, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 })
  })
})

// ---------- A2：请求日志常驻流 ----------

describe('logRequest：常驻追加流按序落盘', () => {
  it('同文件两条按写入顺序排列，格式与 appendFile 时代一致', async () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as any, 'tok')
      logRequest(rt, { ts: '2026-10-07T10:00:00.000+08:00', harness: 'a', profile: 'p', provider: 'pr', path: '/v1/messages', status: 200, ms: 5 })
      logRequest(rt, { ts: '2026-10-07T10:00:01.000+08:00', harness: 'a', profile: 'p', provider: 'pr', path: '/v1/messages', status: 200, ms: 6 })
      await new Promise((r) => setTimeout(r, 60)) // 流异步刷盘，稍等落盘
      const dir = logsDir()
      const file = fs.readdirSync(dir).find((f) => f.startsWith('gateway-'))!
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]).ms).toBe(5)
      expect(JSON.parse(lines[1]).ms).toBe(6)
    } finally {
      h.restore()
    }
  })

  it('drainAppendStreams 排空缓冲：关停前写入的行已落盘（不依赖 sleep）', async () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as any, 'tok')
      logRequest(rt, { ts: '2026-10-07T11:00:00.000+08:00', harness: 'a', profile: 'p', provider: 'pr', path: '/v1/messages', status: 200, ms: 7 })
      await drainAppendStreams()
      const dir = logsDir()
      const file = fs.readdirSync(dir).find((f) => f.startsWith('gateway-'))!
      const entries = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      expect(entries.at(-1).ms).toBe(7)
    } finally {
      h.restore()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { Agent, ProxyAgent } from 'undici'
import { fakeHome, REPO_ROOT, TSX_LOADER } from './helpers.js'
import http from 'node:http'
import { sendError } from '../src/gateway/admin-shared.js'
import { rewriteModel, topLevelModel, forwardToUpstream, UpstreamError } from '../src/gateway/relay.js'
import { buildDispatcher } from '../src/gateway/proxy.js'
import { createUsageTap, type UsageStats } from '../src/gateway/usage.js'
import { buildRuntime, logRequest, type ResolvedTarget } from '../src/gateway/state.js'
import { setSecret } from '../src/config/secrets.js'
import { globToRegExp, matchAlias } from '../src/util/glob.js'
import { drainAppendStreams, appendLine } from '../src/util/fsx.js'
import { logsDir } from '../src/util/paths.js'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import type { Transform } from 'node:stream'

// 公共小工具

function target(opts: { default_model?: string; aliases?: Record<string, string>; modelOverride?: string; providerModels?: Record<string, { source: 'manual' }> }): ResolvedTarget {
  return {
    harness: 'test',
    profileName: 'p',
    profile: {
      name: 'p',
      provider: 'prov',
      ...(opts.default_model ? { default_model: opts.default_model } : {}),
      ...(opts.aliases ? { aliases: opts.aliases } : {}),
    },
    provider: { base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k', ...(opts.providerModels ? { models: opts.providerModels } : {}) },
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

// A3：模型改写快路径（顶层 model 浅扫描与全量解析等价）

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

  it('顶层数组 + default_model：按契约原样透传不谎报 modelAfter（CORRECT-09 ①）', () => {
    // typeof [] === 'object' 曾穿透 injectModel 守卫：expando 写入被 stringify 丢弃、
    // modelAfter 却谎报已改写——修复后数组按「顶层非对象」契约返回 null 原样透传
    const body = Buffer.from('[{"model":"arr"}]')
    const r1 = rewriteModel(target({ default_model: 'dm' }), body, ROUTED)
    expect(r1.body).toBe(body)
    expect(r1.modelAfter).toBeUndefined()
    const r2 = rewriteModel(target({ default_model: 'dm' }), Buffer.from('[1,2,3]'), ROUTED)
    expect(r2.body.toString('utf8')).toBe('[1,2,3]')
    expect(r2.modelAfter).toBeUndefined()
  })

  it('claude 内置模型名无别名时兜底改写为 default_model（网关模式客户端不带模型 env）', () => {
    const dm = target({ default_model: 'glm-5-3-flash-260828' })
    for (const m of ['claude-sonnet-4-5-20250929', 'claude-opus-4-1', 'claude-haiku-4-5', 'claude-fable-5-1', 'claude-3-5-haiku-20241022']) {
      const r = rewriteModel(dm, Buffer.from(JSON.stringify({ model: m })), ROUTED)
      expect(r.modelAfter).toBe('glm-5-3-flash-260828')
      expect(JSON.parse(r.body.toString('utf8')).model).toBe('glm-5-3-flash-260828')
    }
    // 请求名恰为 default_model：不改写不重序列化
    const bodySame = Buffer.from('{"model":"claude-sonnet-4-5"}')
    const rSame = rewriteModel(target({ default_model: 'claude-sonnet-4-5' }), bodySame, ROUTED)
    expect(rSame.modelAfter).toBe('claude-sonnet-4-5')
    expect(rSame.body).toBe(bodySame)
    // 显式别名优先于内置名兜底
    const rAlias = rewriteModel(
      target({ default_model: 'dm', aliases: { 'claude-sonnet-*': 'sonnet-target' } }),
      Buffer.from('{"model":"claude-sonnet-4-5"}'),
      ROUTED
    )
    expect(rAlias.modelAfter).toBe('sonnet-target')
    // 候选级映射仍优先于一切
    const rOv = rewriteModel(
      target({ default_model: 'dm', modelOverride: 'override-win' }),
      Buffer.from('{"model":"claude-sonnet-4-5"}'),
      ROUTED
    )
    expect(rOv.modelAfter).toBe('override-win')
  })

  it('服务目录里真有 claude-* 模型（中转上游）：显式点名透传，不兜底改写', () => {
    const dm = target({ default_model: 'dm', providerModels: { 'claude-sonnet-4-5': { source: 'manual' as const } } })
    const body = Buffer.from('{"model":"claude-sonnet-4-5"}')
    const r = rewriteModel(dm, body, ROUTED)
    expect(r.modelAfter).toBe('claude-sonnet-4-5')
    expect(r.body).toBe(body)
    // 目录里没有的其他 claude-* 仍走兜底
    const r2 = rewriteModel(dm, Buffer.from('{"model":"claude-haiku-4-5"}'), ROUTED)
    expect(r2.modelAfter).toBe('dm')
  })

  it('无 default_model 时 claude 内置名原样透传；非内置名不受兜底影响', () => {
    // 无 default_model、无别名：快路径纯透传（nothing to rewrite to）
    const body1 = Buffer.from('{"model":"claude-sonnet-4-5"}')
    const r1 = rewriteModel(target({}), body1, ROUTED)
    expect(r1.modelAfter).toBe('claude-sonnet-4-5')
    expect(r1.body).toBe(body1)
    // 非 claude 内置名不触发兜底（有 default_model 也不改写）
    const body2 = Buffer.from('{"model":"gpt-x"}')
    const r2 = rewriteModel(target({ default_model: 'dm' }), body2, ROUTED)
    expect(r2.modelAfter).toBe('gpt-x')
    expect(r2.body).toBe(body2)
  })

  it('discovery 别名剥壳：anthropic.<id> 按服务目录还原真实 ID', () => {
    const cat = { 'glm-5.3': { source: 'manual' as const }, 'anthropic.real': { source: 'manual' as const } }
    // 目录里有剥壳后的 ID：还原并重写请求体
    const body1 = Buffer.from('{"model":"anthropic.glm-5.3"}')
    const r1 = rewriteModel(target({ providerModels: cat }), body1, ROUTED)
    expect(r1.modelAfter).toBe('glm-5.3')
    expect(JSON.parse(r1.body.toString('utf8')).model).toBe('glm-5.3')
    // 上游真有 anthropic. 开头的模型 ID：不误剥
    const body2 = Buffer.from('{"model":"anthropic.real"}')
    const r2 = rewriteModel(target({ providerModels: cat }), body2, ROUTED)
    expect(r2.modelAfter).toBe('anthropic.real')
    expect(r2.body).toBe(body2)
    // 剥壳后的 ID 不在目录：保持原样
    const body3 = Buffer.from('{"model":"anthropic.unknown"}')
    const r3 = rewriteModel(target({ providerModels: cat }), body3, ROUTED)
    expect(r3.modelAfter).toBe('anthropic.unknown')
    expect(r3.body).toBe(body3)
    // 剥壳后的 ID 与别名表匹配：按别名继续翻译
    const r5 = rewriteModel(
      target({ providerModels: cat, aliases: { 'glm-5.3': 'upstream-glm' } }),
      Buffer.from('{"model":"anthropic.glm-5.3"}'),
      ROUTED
    )
    expect(r5.modelAfter).toBe('upstream-glm')
  })
})

describe('globToRegExp：编译缓存不改变匹配行为', () => {
  it('同 pattern 复用同一 RegExp 实例', () => {
    expect(globToRegExp('a.b*')).toBe(globToRegExp('a.b*'))
    expect(globToRegExp('a.b*').test('a.bX')).toBe(true)
    expect(globToRegExp('a.b*').test('aXbX')).toBe(false)
  })
})

// A1：direct 共享调优 Agent

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

// A4：usage tap 预过滤 + UTF-8 跨 chunk

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

  it('SSE 行缓冲封顶（卡 31）：超长无换行 chunk 触发封顶，后续 usage 不再解析（只透传）', async () => {
    // 2MB chunk 远超 Transform highWaterMark：feedTap 不消费 readable 侧会背压卡死 finish，
    // 这里自行接线并 resume() 排空
    const tap = createUsageTap('text/event-stream') as Transform & { getUsage: () => UsageStats }
    tap.resume()
    tap.write(Buffer.from('data: ' + 'x'.repeat(1024 * 1024 + 16), 'utf8'))
    tap.write(Buffer.from('data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n', 'utf8'))
    const usage = await new Promise<UsageStats>((resolve) => {
      tap.on('finish', () => resolve(tap.getUsage()))
      tap.end()
    })
    expect(usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 })
  })

  it('封顶阈值内的正常 SSE 不受影响（对照）', async () => {
    const usage = await feedTap([Buffer.from('data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n', 'utf8')], 'text/event-stream')
    expect(usage.input_tokens).toBe(5)
    expect(usage.output_tokens).toBe(2)
  })
})

describe('sendError：请求体未读完统一 connection: close（卡 31）', () => {
  function stubRes(readableEnded: boolean, withBody = true) {
    const headers: Record<string, string> = {}
    const res = {
      req: { readableEnded, headers: withBody ? { 'content-length': '128' } : {} },
      setHeader: (k: string, v: string) => {
        headers[k] = v
      },
      getHeader: (k: string) => headers[k],
      writeHead: () => {},
      end: () => {},
    } as unknown as http.ServerResponse
    return { res, headers }
  }

  it('429/401/403/400 早退应答断开 keep-alive；读完的请求不断；413 特判保留', () => {
    for (const status of [429, 401, 403, 400]) {
      const { res, headers } = stubRes(false)
      sendError(res, status, 'm')
      expect(headers['connection']).toBe('close')
    }
    const done = stubRes(true)
    sendError(done.res, 500, 'm')
    expect(done.headers['connection']).toBeUndefined()
    const bodyless = stubRes(false, false)
    sendError(bodyless.res, 404, 'm')
    expect(bodyless.headers['connection']).toBeUndefined() // 无 body 的 GET 错误不再断连（复审③）
    const over = stubRes(true)
    sendError(over.res, 413, 'm')
    expect(over.headers['connection']).toBe('close')
  })
})

// A2：请求日志常驻流

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

describe('forwardToUpstream：客户端断开中止', () => {
  it('signal 已中止：中止错误原样上抛，不包成 UpstreamError、不触发重试链', async () => {
    const h = fakeHome()
    try {
      await setSecret('k', 'sk-test', 'file')
      const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as any, 'tok')
      const ctl = new AbortController()
      ctl.abort()
      let caught: unknown
      try {
        await forwardToUpstream(rt, target({}), {
          method: 'POST', path: '/v1/messages', headers: {},
          body: Buffer.from('{"model":"m"}'), idleTimeoutMs: 1000, retries: 3, signal: ctl.signal,
        })
        expect.unreachable('应抛出中止错误')
      } catch (e) {
        caught = e
      }
      // 断开短路的核心语义：错误不被包成 502 UpstreamError（修复前 ECONNREFUSED 类会重试 3 次
      // 再包成 transport 错误走 failover）、不重试——signal.aborted 分支先于重试判断直接上抛
      expect(caught).not.toBeInstanceOf(UpstreamError)
    } finally {
      await drainAppendStreams()
      h.restore()
    }
  })
})

describe('appendLine 空闲刷盘（XPLAT-02：Windows stop 硬杀前的尾部持久性）', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  // 阈值 3s + 扫描间隔 1s + 落盘余量：等待必须覆盖「最后一次写入 → sweep 命中 → end 刷盘完成」全程
  const IDLE_WAIT_MS = 4600

  it('空闲超阈值自动刷盘：不 drain 不 close，行已完整落盘', async () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(logsDir(), { recursive: true }) // appendLine 契约：调用方保证目录存在
      const file = path.join(logsDir(), 'idle-flush.jsonl')
      for (let i = 0; i < 30; i++) appendLine(file, JSON.stringify({ i, msg: `行-${i}` }) + '\n')
      await sleep(IDLE_WAIT_MS)
      // 关键：读之前不做任何 drain/close——数据必须已因 idle 刷盘写到 fd，而非还在流缓冲里
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(30)
      expect(JSON.parse(lines.at(-1)!).i).toBe(29)
      await drainAppendStreams() // 仅收尾释放 fd（Windows 上 restore 删目录需无占用）
    } finally {
      h.restore()
    }
  })

  it('空闲被关流后再次写入：流自动重建、两段行序完整不丢', async () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(logsDir(), { recursive: true }) // appendLine 契约：调用方保证目录存在
      const file = path.join(logsDir(), 'idle-recreate.jsonl')
      appendLine(file, JSON.stringify({ seq: 1 }) + '\n')
      await sleep(IDLE_WAIT_MS) // sweep 已把该流 end 并摘出池
      appendLine(file, JSON.stringify({ seq: 2 }) + '\n') // 走重建分支
      await drainAppendStreams()
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
      expect(lines.map((l) => JSON.parse(l).seq)).toEqual([1, 2])
    } finally {
      h.restore()
    }
  })

  it('端到端：子进程写日志不经清理路径直接退出，尾部完整（模拟 Windows stop 硬杀）', async () => {
    const h = fakeHome()
    try {
      const child = [
        `import { appendLine } from '${pathToFileURL(path.join(REPO_ROOT, 'src', 'util', 'fsx.ts')).href}'`,
        `const file = process.argv[2]`,
        `for (let i = 0; i < 30; i++) appendLine(file, JSON.stringify({ i, msg: 'tail-' + i }) + '\\n')`,
        // 不 drain 不 close：等 idle 刷盘扫过再自灭退出（无清理路径 ≈ Windows TerminateProcess 的丢弃语义）
        `setTimeout(() => process.exit(0), 5000)`,
      ].join('\n')
      const script = path.join(h.home, 'idle-exit-child.mjs')
      fs.writeFileSync(script, child)
      fs.mkdirSync(logsDir(), { recursive: true }) // appendLine 契约：调用方保证目录存在
      const r = spawnSync(process.execPath, ['--import', TSX_LOADER, script, path.join(logsDir(), 'e2e.jsonl')], {
        env: { ...process.env, MODELRDOCK_FAKE_HOME: h.home },
        encoding: 'utf8',
        timeout: 60_000,
      })
      expect(r.status).toBe(0)
      const lines = fs.readFileSync(path.join(logsDir(), 'e2e.jsonl'), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(30)
      expect(JSON.parse(lines.at(-1)!).i).toBe(29)
    } finally {
      h.restore()
    }
  })
})

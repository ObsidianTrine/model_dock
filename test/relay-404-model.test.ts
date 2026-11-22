import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { forwardWithFailover } from '../src/gateway/relay.js'
import { buildRuntime } from '../src/gateway/state.js'
import { setSecret } from '../src/config/secrets.js'
import { fakeHome } from './helpers.js'
import type { Config, ProfileConfig, ProviderConfig } from '../src/config/types.js'

// 上游 404 model 类纳入候选切换（2026-11-16 夜航模式 A 判死链）：claude 会话中途的辅助模型请求经
// tierFallback 改写为 profile.default_model，钉定主候选目录不含该模型 → 上游 404 UnsupportedModel
// 原样回传（404 不在 failover_status_codes）→ CLI [claude-code:unrecognized_model] 退出 → 任务判死。
// carve-out 边界（relay.ts forwardWithFailover）：仅 ROUTED_PATH + 链中段 + 错误体命中 MODEL_MISSING_RE
// 才切；非 model 体 404（路径级资源不存在）/非 routed 路径/链尾一律原样回传，response 字节不变。
// 全部真实入口（不 mock 模块——isolate:false 共享注册表是雷区）；mock 上游 listen(0) 随机端口。

const ROUTED = '/v1/messages'
// 真实样本（2026-11-16 夜航 VDR）：火山方舟 coding-plan 对不支持模型的 404 体
const UNSUPPORTED_MODEL_BODY =
  '{"error":{"code":"UnsupportedModel","message":"The requested model does not support the coding plan feature."}}'

/** 可编程 mock 上游：handler 拿 (req, res, 序号, body) 自行写响应；记录收到的请求体。 */
async function startMock(handler: (req: http.IncomingMessage, res: http.ServerResponse, i: number, body: string) => void) {
  const reqs: { body: string }[] = []
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      reqs.push({ body })
      handler(req, res, reqs.length - 1, body)
    })
  })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const close = () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()) })
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, reqs, close }
}

function providerCfg(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { name: 'p', base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k', priority: 0, ...over }
}

function buildRt(providers: Record<string, ProviderConfig>, gateway: Record<string, unknown> = {}): ReturnType<typeof buildRuntime> {
  return buildRuntime({ providers, profiles: {}, harness: {}, gateway: { auto_fallback: true, ...gateway } } as unknown as Config, 'tok')
}

function baseOn(cfg: Config, id: string, profileOver: Partial<ProfileConfig> = {}): Parameters<typeof forwardWithFailover>[1] {
  return {
    harness: 'test',
    profileName: 'p',
    profile: { name: 'p', provider: id, ...profileOver },
    provider: cfg.providers[id],
  }
}

function fwdOpts(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { method: 'POST', path: ROUTED, headers: {}, body: Buffer.from(JSON.stringify({ model: 'glm-4.7', messages: [] })), idleTimeoutMs: 5000, retries: 0, ...over }
}

/** 目录条目快捷构造（过滤只看键名存在） */
function catalog(...ids: string[]): Record<string, { source: 'fetched' }> {
  return Object.fromEntries(ids.map((id) => [id, { source: 'fetched' as const }]))
}

const unsupported404 = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(UNSUPPORTED_MODEL_BODY)
}
const ok200 = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"ok":true}')
}

describe('relay · 上游 404 model 类纳入候选切换', () => {
  it('主候选 404 UnsupportedModel（coding-plan 文案）且链上有目录含模型的存活候选 → 成功切换，attempts/model_mismatch 留痕齐全', async () => {
    const h = fakeHome()
    const pa = await startMock(unsupported404)
    const pb = await startMock(ok200)
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      const rt = buildRt({
        // 主候选（钉定）：目录不含 claude-haiku（tierFallback 改写为 default_model 生效），也不含改写目标
        pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa', models: catalog('glm-4.6') }),
        // 自动补尾候选：目录含改写目标 glm-4.5-air → filterModelCompatible 保留
        pb: providerCfg({ name: 'pb', base_url: pb.url, key_ref: 'file:pb', models: catalog('glm-4.5-air') }),
      })
      // 不配 failover_status_codes：404 不在白名单（默认 [429,503]），切换只能来自 model 类 carve-out
      const r = await forwardWithFailover(
        rt,
        baseOn(rt.config as Config, 'pa', { default_model: 'glm-4.5-air' }),
        fwdOpts({ body: Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5', messages: [] })) }) as never,
      )
      expect(r.status).toBe(200)
      expect(r.usedProviderId).toBe('pb')
      expect(r.reason).toBe('failover_to:pb,model_mismatch:pa,replayed_from:pa')
      expect(pb.reqs.length).toBe(1)
      expect(JSON.parse(pb.reqs[0].body).model).toBe('glm-4.5-air') // tierFallback 改写后的模型原样改发
      expect(r.attempts).toEqual([
        { provider: 'pa', status: 404, ms: expect.any(Number) },
        { provider: 'pb', status: 200, ms: expect.any(Number) },
      ])
    } finally {
      await Promise.all([pa.close(), pb.close()])
      h.restore()
    }
  })

  it('负例：404 路径资源不存在（非 model 体）不切候选，原样回传（response 字节不变）', async () => {
    const h = fakeHome()
    const NOT_FOUND_BODY = '{"error":{"message":"not found"}}'
    const pa = await startMock((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(NOT_FOUND_BODY)
    })
    const pb = await startMock(ok200)
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      const rt = buildRt({
        pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa' }),
        pb: providerCfg({ name: 'pb', base_url: pb.url, key_ref: 'file:pb' }),
      })
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts() as never)
      expect(r.status).toBe(404)
      expect(r.usedProviderId).toBe('pa')
      expect(r.cause).toBe('upstream_4xx')
      expect(await r.body.text()).toBe(NOT_FOUND_BODY) // 体逐字节一致（未切换，仅解压重包口径）
      expect(pb.reqs.length).toBe(0)
    } finally {
      await Promise.all([pa.close(), pb.close()])
      h.restore()
    }
  })

  it('负例：非 ROUTED_PATH 的 404 不切（即便错误体命中模型缺失语义）', async () => {
    const h = fakeHome()
    const pa = await startMock(unsupported404)
    const pb = await startMock(ok200)
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      const rt = buildRt({
        pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa' }),
        pb: providerCfg({ name: 'pb', base_url: pb.url, key_ref: 'file:pb' }),
      })
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts({ path: '/v1/models' }) as never)
      expect(r.status).toBe(404)
      expect(r.usedProviderId).toBe('pa')
      expect(pb.reqs.length).toBe(0)
    } finally {
      await Promise.all([pa.close(), pb.close()])
      h.restore()
    }
  })

  it('负例：单候选（链尾）404 UnsupportedModel 原样回传，response 字节不变', async () => {
    const h = fakeHome()
    const pa = await startMock(unsupported404)
    try {
      await setSecret('pa', 'sk-pa', 'file')
      const rt = buildRt({ pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa' }) }, { auto_fallback: false })
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts() as never)
      expect(r.status).toBe(404)
      expect(r.usedProviderId).toBe('pa')
      expect(r.cause).toBe('upstream_4xx')
      expect(await r.body.text()).toBe(UNSUPPORTED_MODEL_BODY)
    } finally {
      await pa.close()
      h.restore()
    }
  })

  it('中段按 carve-out 切换后链尾仍 404 model 体 → 如实透传（不循环），全链留痕', async () => {
    const h = fakeHome()
    const pa = await startMock(unsupported404)
    const pb = await startMock(unsupported404)
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      const rt = buildRt({
        pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa' }),
        pb: providerCfg({ name: 'pb', base_url: pb.url, key_ref: 'file:pb' }),
      })
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts() as never)
      expect(r.status).toBe(404)
      expect(r.usedProviderId).toBe('pb')
      expect(r.cause).toBe('upstream_4xx')
      expect(r.reason).toBe('failover_to:pb,model_mismatch:pa,replayed_from:pa')
      expect(r.attempts).toEqual([
        { provider: 'pa', status: 404, ms: expect.any(Number) },
        { provider: 'pb', status: 404, ms: expect.any(Number) },
      ])
    } finally {
      await Promise.all([pa.close(), pb.close()])
      h.restore()
    }
  })
})

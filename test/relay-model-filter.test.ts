import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { forwardWithFailover } from '../src/gateway/relay.js'
import { buildRuntime, pickTarget } from '../src/gateway/state.js'
import { setSecret } from '../src/config/secrets.js'
import { fakeHome } from './helpers.js'
import type { Config, ProfileConfig, ProviderConfig } from '../src/config/types.js'
import type { ResolvedTarget } from '../src/gateway/state/types.js'

// 自动候选模型相容过滤（2026-11-08 生产事故：bigmodel-2 限流 429 → 自动补尾把 glm-4.7 原样发往
// 不支持它的服务 → 必然 400 Unsupported model，整链失败且错误日志噪音掩盖真因）：
// - 自动补尾候选按「别名改写后实际会发送的模型名」对照候选服务目录，目录已管理（非空）且不含该模型的剔除
// - 目录未管理（models 缺省/空）不拦；手动 fallback 不受过滤；扫描拿不准的 body 整体不过滤
// 全部真实入口（不 mock 模块——isolate:false 共享注册表是雷区）；mock 上游 listen(0) 随机端口。

const ROUTED = '/v1/messages'

/** 可编程 mock 上游：handler 拿 (req, res, 序号) 自行写响应；记录收到的请求体。 */
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
  return { name: 'p', base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k', ...over }
}

function buildRt(providers: Record<string, ProviderConfig>, gateway: Record<string, unknown> = {}): ReturnType<typeof buildRuntime> {
  return buildRuntime({ providers, profiles: {}, harness: {}, gateway: { auto_fallback: true, ...gateway } } as unknown as Config, 'tok')
}

function baseOn(cfg: Config, id: string, profileOver: Partial<ProfileConfig> = {}): ResolvedTarget {
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

/** 目录条目快捷构造（source 随意，过滤只看键名存在） */
function catalog(...ids: string[]): Record<string, { source: 'fetched' }> {
  return Object.fromEntries(ids.map((id) => [id, { source: 'fetched' as const }]))
}

const ok200 = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"ok":true}')
}

describe('relay · 自动候选模型相容过滤', () => {
  it('主候选 429 → 目录不含请求模型的自动候选被剔除（model_mismatch 留痕），改发目录含模型的候选', async () => {
    const h = fakeHome()
    const pa = await startMock((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"rate limited"}}')
    })
    const pb = await startMock(ok200)
    const pc = await startMock(ok200) // 目录不含 glm-4.7：不应被重放
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      await setSecret('pc', 'sk-pc', 'file')
      const rt = buildRt(
        {
          pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa', models: catalog('glm-4.7') }),
          pb: providerCfg({ name: 'pb', base_url: pb.url, key_ref: 'file:pb', models: catalog('glm-4.7') }),
          pc: providerCfg({ name: 'pc', base_url: pc.url, key_ref: 'file:pc', models: catalog('glm-4.6') }),
        },
        { failover_status_codes: [429] },
      )
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts() as never)
      expect(r.usedProviderId).toBe('pb')
      expect(r.reason).toBe('failover_to:pb,model_mismatch:pc,replayed_from:pa')
      expect(pc.reqs.length).toBe(0)
      expect(r.attempts).toEqual(
        expect.arrayContaining([
          { provider: 'pc', note: 'model_mismatch' },
          { provider: 'pa', status: 429, ms: expect.any(Number) },
          { provider: 'pb', status: 200, ms: expect.any(Number) },
        ]),
      )
    } finally {
      await Promise.all([pa.close(), pb.close(), pc.close()])
      h.restore()
    }
  })

  it('目录未管理（models 缺省）的自动候选不拦：照常改发', async () => {
    const h = fakeHome()
    const pa = await startMock((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"rate limited"}}')
    })
    const pb = await startMock(ok200)
    const pc = await startMock(ok200) // 目录已管理但不含 glm-4.7：剔除
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      await setSecret('pc', 'sk-pc', 'file')
      const rt = buildRt(
        {
          pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa', models: catalog('glm-4.7') }),
          pb: providerCfg({ name: 'pb', base_url: pb.url, key_ref: 'file:pb' }), // 未拉取过目录
          pc: providerCfg({ name: 'pc', base_url: pc.url, key_ref: 'file:pc', models: catalog('glm-4.6') }),
        },
        { failover_status_codes: [429] },
      )
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts() as never)
      expect(r.usedProviderId).toBe('pb')
      expect(r.reason).toBe('failover_to:pb,model_mismatch:pc,replayed_from:pa')
      expect(pc.reqs.length).toBe(0)
    } finally {
      await Promise.all([pa.close(), pb.close(), pc.close()])
      h.restore()
    }
  })

  it('手动 fallback 不受模型过滤：目录不含请求模型也照常改发（显式配置优先）', async () => {
    const h = fakeHome()
    const pa = await startMock((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"rate limited"}}')
    })
    const pb = await startMock(ok200)
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      const rt = buildRt(
        {
          pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa', models: catalog('glm-4.7') }),
          pb: providerCfg({ name: 'pb', base_url: pb.url, key_ref: 'file:pb', models: catalog('glm-4.6') }),
        },
        { failover_status_codes: [429], auto_fallback: false },
      )
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), { ...fwdOpts(), fallbackIds: ['pb'] } as never)
      expect(r.usedProviderId).toBe('pb')
      expect(r.reason).toBe('failover_to:pb,replayed_from:pa')
      expect(pb.reqs.length).toBe(1)
    } finally {
      await Promise.all([pa.close(), pb.close()])
      h.restore()
    }
  })

  it('别名改写后对账：profile 别名映射到的模型名不在候选目录 → 剔除；实际发送别名结果', async () => {
    const h = fakeHome()
    const pa = await startMock((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"rate limited"}}')
    })
    const pb = await startMock(ok200)
    const pc = await startMock(ok200)
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      await setSecret('pc', 'sk-pc', 'file')
      const rt = buildRt(
        {
          pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa', models: catalog('glm-4.7') }),
          pb: providerCfg({ name: 'pb', base_url: pb.url, key_ref: 'file:pb', models: catalog('glm-4.7') }),
          pc: providerCfg({ name: 'pc', base_url: pc.url, key_ref: 'file:pc', models: catalog('other-model') }),
        },
        { failover_status_codes: [429] },
      )
      const base = baseOn(rt.config as Config, 'pa', { aliases: { 'my-glm': 'glm-4.7' } })
      const r = await forwardWithFailover(rt, base, fwdOpts({ body: Buffer.from(JSON.stringify({ model: 'my-glm', messages: [] })) }) as never)
      expect(r.usedProviderId).toBe('pb')
      expect(r.reason).toBe('failover_to:pb,model_mismatch:pc,replayed_from:pa')
      expect(JSON.parse(pb.reqs[0].body).model).toBe('glm-4.7') // 改写层与过滤层同源：实际发送别名结果
      expect(pc.reqs.length).toBe(0)
    } finally {
      await Promise.all([pa.close(), pb.close(), pc.close()])
      h.restore()
    }
  })

  it('claude-* 内置名兜底改写参与对账：default_model 在候选目录 → 保留，不在 → 剔除', async () => {
    const h = fakeHome()
    const pa = await startMock((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"rate limited"}}')
    })
    const pb = await startMock(ok200)
    const pc = await startMock(ok200)
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      await setSecret('pc', 'sk-pc', 'file')
      const rt = buildRt(
        {
          pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa', models: catalog('glm-4.7') }),
          pb: providerCfg({ name: 'pb', base_url: pb.url, key_ref: 'file:pb', models: catalog('glm-4.7') }),
          pc: providerCfg({ name: 'pc', base_url: pc.url, key_ref: 'file:pc', models: catalog('other-model') }),
        },
        { failover_status_codes: [429] },
      )
      const base = baseOn(rt.config as Config, 'pa', { default_model: 'glm-4.7' })
      const r = await forwardWithFailover(rt, base, fwdOpts({ body: Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })) }) as never)
      expect(r.usedProviderId).toBe('pb')
      expect(r.reason).toBe('failover_to:pb,model_mismatch:pc,replayed_from:pa')
      expect(pc.reqs.length).toBe(0)
    } finally {
      await Promise.all([pa.close(), pb.close(), pc.close()])
      h.restore()
    }
  })

  it('body 无 model 键：按 default_model 对账（与改写层注入行为同口径）', async () => {
    const h = fakeHome()
    const pa = await startMock((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"rate limited"}}')
    })
    const pb = await startMock(ok200)
    const pc = await startMock(ok200)
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      await setSecret('pc', 'sk-pc', 'file')
      const rt = buildRt(
        {
          pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa', models: catalog('glm-4.7') }),
          pb: providerCfg({ name: 'pb', base_url: pb.url, key_ref: 'file:pb', models: catalog('glm-4.7') }),
          pc: providerCfg({ name: 'pc', base_url: pc.url, key_ref: 'file:pc', models: catalog('other-model') }),
        },
        { failover_status_codes: [429] },
      )
      const base = baseOn(rt.config as Config, 'pa', { default_model: 'glm-4.7' })
      const r = await forwardWithFailover(rt, base, fwdOpts({ body: Buffer.from(JSON.stringify({ messages: [] })) }) as never)
      expect(r.usedProviderId).toBe('pb')
      expect(r.reason).toBe('failover_to:pb,model_mismatch:pc,replayed_from:pa')
      expect(JSON.parse(pb.reqs[0].body).model).toBe('glm-4.7') // 改写层给无 model 请求注入 default_model
      expect(pc.reqs.length).toBe(0)
    } finally {
      await Promise.all([pa.close(), pb.close(), pc.close()])
      h.restore()
    }
  })

  it('body 扫描拿不准（含转义键）→ 整体不过滤：宁放过不误杀', async () => {
    const h = fakeHome()
    const pa = await startMock((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"rate limited"}}')
    })
    const pb = await startMock(ok200) // 目录不含 glm-4.7：扫描拿不准时仍应被尝试
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      const rt = buildRt(
        {
          pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa', models: catalog('glm-4.7') }),
          pb: providerCfg({ name: 'pb', base_url: pb.url, key_ref: 'file:pb', models: catalog('other-model') }),
        },
        { failover_status_codes: [429] },
      )
      const body = Buffer.from('{"a\\u0041":1,"model":"glm-4.7"}') // 转义键 → 浅扫描放弃（null）
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts({ body }) as never)
      expect(r.usedProviderId).toBe('pb')
      expect(r.reason).toBe('failover_to:pb,replayed_from:pa') // 无 model_mismatch
      expect(pb.reqs.length).toBe(1)
    } finally {
      await Promise.all([pa.close(), pb.close()])
      h.restore()
    }
  })

  it('非 routed path：模型过滤不参与（改写层同样不生效），候选照旧', async () => {
    const h = fakeHome()
    const pa = await startMock((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"rate limited"}}')
    })
    const pb = await startMock(ok200)
    try {
      await setSecret('pa', 'sk-pa', 'file')
      await setSecret('pb', 'sk-pb', 'file')
      const rt = buildRt(
        {
          pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa', models: catalog('glm-4.7') }),
          pb: providerCfg({ name: 'pb', base_url: pb.url, key_ref: 'file:pb', models: catalog('other-model') }),
        },
        { failover_status_codes: [429] },
      )
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts({ path: '/v1/other' }) as never)
      expect(r.usedProviderId).toBe('pb')
      expect(r.reason).toBe('failover_to:pb,replayed_from:pa')
      expect(pb.reqs.length).toBe(1)
    } finally {
      await Promise.all([pa.close(), pb.close()])
      h.restore()
    }
  })

  it('pickTarget 给自动补尾候选打 auto 标记；主候选与手动链不打', async () => {
    const h = fakeHome()
    try {
      const rt = buildRt({
        pa: providerCfg({ name: 'pa', base_url: 'http://127.0.0.1:1', key_ref: 'file:pa' }),
        pb: providerCfg({ name: 'pb', base_url: 'http://127.0.0.1:1', key_ref: 'file:pb' }),
      })
      const picked = pickTarget(rt, baseOn(rt.config as Config, 'pa'), undefined)
      expect(picked.ok).toBe(true)
      const ordered = (picked as { ok: true; ordered: { providerId: string; auto?: boolean }[] }).ordered
      expect(ordered.map((c) => c.providerId)).toEqual(['pa', 'pb'])
      expect(ordered[0].auto).toBeUndefined()
      expect(ordered[1].auto).toBe(true)
    } finally {
      h.restore()
    }
  })
})

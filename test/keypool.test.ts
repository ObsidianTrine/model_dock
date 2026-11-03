import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { KEY_COOLDOWN_MS, keyInCooldown, keyPoolHealthView, markKeyCooldown, nextRotation, resetKeyPool } from '../src/gateway/state/keypool.js'
import { buildRuntime, reloadRuntime } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { forwardToUpstream, forwardWithFailover, UpstreamError } from '../src/gateway/relay.js'
import { providerKeyRefs, resolveProviderKeys, setSecret } from '../src/config/secrets.js'
import { loadConfig, mutateConfig } from '../src/config/store.js'
import { fakeHome } from './helpers.js'
import type { Config, ProviderConfig } from '../src/config/types.js'

// Provider 多 key 池 + key 级失效处理（P0①+P1⑥）：
// - providerKeyRefs/resolveProviderKeys：keys 缺省回落 [key_ref]、逐 ref 解析单个失败跳过
// - state/keypool：per provider+key索引 冷却（15min，内存态）与 round-robin 游标
// - relay：池内轮转、401/403 标记冷却 + 换 key 重试一次、全灭 candidateSkip 换 provider 候选
// 全部走真实入口（不 mock 模块——isolate:false 共享注册表是雷区）；keys 走 fakeHome file 后端。

function providerCfg(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { name: 'p', base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:p', ...over }
}

describe('keypool · providerKeyRefs（keys 缺省回落 [key_ref]）', () => {
  it('keys 非空以其为准；key_ref 保留但不并入池', () => {
    expect(providerKeyRefs({ key_ref: 'file:a', keys: ['file:b', 'env:K'] })).toEqual(['file:b', 'env:K'])
  })

  it('keys 缺省 / 空数组 / 全非串条目 → 回落 [key_ref]（向后兼容单 key 配置）', () => {
    expect(providerKeyRefs({ key_ref: 'file:a' })).toEqual(['file:a'])
    expect(providerKeyRefs({ key_ref: 'file:a', keys: [] })).toEqual(['file:a'])
    expect(providerKeyRefs({ key_ref: 'file:a', keys: [123, null] as unknown as string[] })).toEqual(['file:a'])
  })

  it('两处都不配 = 现有「无 key」行为：空串哨兵交给 getSecret 层给可操作报错', () => {
    expect(providerKeyRefs({})).toEqual([''])
    expect(providerKeyRefs({ keys: [] })).toEqual([''])
  })
})

describe('keypool · resolveProviderKeys（逐 ref 解析、单个失败跳过）', () => {
  it('成功解析的 key 带原始索引；缺失条目（file:ghost）只跳过不致命', async () => {
    const h = fakeHome()
    try {
      await setSecret('k0', 'sk-0', 'file')
      await setSecret('k2', 'sk-2', 'file')
      const pool = await resolveProviderKeys(['file:k0', 'file:ghost', 'file:k2'])
      expect(pool.map((e) => ({ index: e.index, key: e.key }))).toEqual([
        { index: 0, key: 'sk-0' },
        { index: 2, key: 'sk-2' },
      ])
    } finally {
      h.restore()
    }
  })

  it('env: 引用解析自环境变量；未设置的 env 与空引用（空 plain 哨兵）同样跳过', async () => {
    process.env.MD_KEYPOOL_TEST_ENV = 'env-key-value'
    try {
      const pool = await resolveProviderKeys(['env:MD_KEYPOOL_TEST_ENV', 'env:MD_KEYPOOL_MISSING', ''])
      expect(pool).toEqual([{ index: 0, ref: 'env:MD_KEYPOOL_TEST_ENV', key: 'env-key-value' }])
    } finally {
      delete process.env.MD_KEYPOOL_TEST_ENV
    }
  })
})

describe('keypool · 冷却态与轮转游标（内存态，rt 级）', () => {
  it('markKeyCooldown 只冷却目标索引；15min 后自动解封（过期条目惰性清除）', () => {
    const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 't')
    const t0 = 1_700_000_000_000
    markKeyCooldown(rt, 'p', 0, t0)
    expect(keyInCooldown(rt, 'p', 0, t0)).toBe(true)
    expect(keyInCooldown(rt, 'p', 1, t0)).toBe(false)
    // 恰好到期：until <= now 即解封
    expect(keyInCooldown(rt, 'p', 0, t0 + KEY_COOLDOWN_MS)).toBe(false)
    // 过期条目已被惰性删除，观测面不再列出
    expect(keyPoolHealthView(rt, 'p', 2, t0 + KEY_COOLDOWN_MS).cooldown).toEqual([])
  })

  it('keyPoolHealthView：healthy = total - 冷却数，冷却项带剩余 ms；绝无 key 明文出口', () => {
    const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 't')
    const t0 = 1_700_000_000_000
    markKeyCooldown(rt, 'p', 1, t0)
    markKeyCooldown(rt, 'p', 0, t0 + 1000)
    const v = keyPoolHealthView(rt, 'p', 3, t0 + 2000)
    expect(v.healthy).toBe(1)
    expect(v.cooldown).toEqual([
      { index: 0, remaining_ms: KEY_COOLDOWN_MS - 1000 },
      { index: 1, remaining_ms: KEY_COOLDOWN_MS - 2000 },
    ])
    expect(JSON.stringify(v)).not.toContain('sk-')
  })

  it('nextRotation round-robin：多 key 池轮转均摊，单 key 恒取唯一一把；resetKeyPool 清零', () => {
    const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 't')
    expect([nextRotation(rt, 'p', [0, 1, 2]), nextRotation(rt, 'p', [0, 1, 2]), nextRotation(rt, 'p', [0, 1, 2]), nextRotation(rt, 'p', [0, 1, 2])]).toEqual([0, 1, 2, 0])
    expect(nextRotation(rt, 'single', [5])).toBe(5)
    expect(nextRotation(rt, 'single', [5])).toBe(5)
    expect(nextRotation(rt, 'x', [])).toBeUndefined()
    resetKeyPool(rt)
    expect(nextRotation(rt, 'p', [0, 1, 2])).toBe(0)
  })

  it('reloadRuntime（配置热加载）清零 key 池运行态：换 key 立即恢复轮转，无须等满冷却', async () => {
    const h = fakeHome()
    try {
      await mutateConfig((c) => {
        c.providers['rp'] = providerCfg({ key_ref: 'file:rk', keys: ['file:rk'] })
      })
      const rt = buildRuntime(await loadConfig(), 't')
      markKeyCooldown(rt, 'rp', 0)
      expect(keyInCooldown(rt, 'rp', 0)).toBe(true)
      await reloadRuntime(rt)
      expect(keyInCooldown(rt, 'rp', 0)).toBe(false)
      expect(nextRotation(rt, 'rp', [0])).toBe(0)
    } finally {
      h.restore()
    }
  })
})

// ---------------------------------------------------------------------------
// relay 集成：真实 forwardToUpstream / forwardWithFailover + 本地 mock 上游（listen(0) 随机端口）。
// mock 按请求记录 authorization 头，可编程「哪把 key 被拒」。
describe('keypool · relay 集成（池轮转 / 401 换 key / 全灭切候选）', () => {
  const body = Buffer.from(JSON.stringify({ model: 'm', messages: [] }))
  const ROUTED = '/v1/messages'

  interface Mock {
    url: string
    auths: string[]
    count: () => number
    close: () => Promise<void>
  }

  /** auth → status 的可编程 mock：handler 返回响应码（缺省 200）。逐请求记录 Bearer 后的 key。 */
  async function startKeyMock(handler?: (auth: string) => number): Promise<Mock> {
    const auths: string[] = []
    const s = http.createServer((req, res) => {
      const auth = String(req.headers.authorization ?? '')
      auths.push(auth)
      const status = handler ? handler(auth) : 200
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: status < 400, error: status >= 400 ? { message: 'invalid api key' } : undefined }))
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const close = () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()) })
    return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, auths, count: () => auths.length, close }
  }

  function buildRt(providers: Record<string, ProviderConfig>): ReturnType<typeof buildRuntime> {
    const cfg = { providers, profiles: {}, harness: {}, gateway: { auto_fallback: false } } as unknown as Config
    return buildRuntime(cfg, 'tok')
  }

  function baseOn(cfg: Config, id: string): Parameters<typeof forwardToUpstream>[1] {
    return {
      harness: 'test',
      profileName: 'p',
      profile: { name: 'p', provider: id },
      provider: cfg.providers[id],
    }
  }

  async function twoKeyProvider(mock: Mock, id = 'pa'): Promise<ProviderConfig> {
    await setSecret(`${id}-0`, 'sk-A', 'file')
    await setSecret(`${id}-1`, 'sk-B', 'file')
    return providerCfg({ name: id, base_url: mock.url, key_ref: `file:${id}-0`, keys: [`file:${id}-0`, `file:${id}-1`] })
  }

  it('round-robin 轮转：两个连续请求分别用池内两把 key（不再全体挤一把）', async () => {
    const h = fakeHome()
    const mock = await startKeyMock()
    try {
      const pa = await twoKeyProvider(mock)
      const rt = buildRt({ pa })
      const cfg = rt.config as Config
      await forwardToUpstream(rt, baseOn(cfg, 'pa'), { method: 'POST', body, path: ROUTED, headers: {}, idleTimeoutMs: 5000, retries: 0 })
      await forwardToUpstream(rt, baseOn(cfg, 'pa'), { method: 'POST', body, path: ROUTED, headers: {}, idleTimeoutMs: 5000, retries: 0 })
      expect(mock.auths).toEqual(['Bearer sk-A', 'Bearer sk-B'])
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('首 key 401 → 标记冷却 + 换下一把 healthy key 重试一次，本请求成功', async () => {
    const h = fakeHome()
    const mock = await startKeyMock((auth) => (auth === 'Bearer sk-A' ? 401 : 200))
    try {
      const pa = await twoKeyProvider(mock)
      const rt = buildRt({ pa })
      const cfg = rt.config as Config
      const r1 = await forwardToUpstream(rt, baseOn(cfg, 'pa'), { method: 'POST', body, path: ROUTED, headers: {}, idleTimeoutMs: 5000, retries: 0 })
      expect(r1.status).toBe(200)
      expect(mock.auths).toEqual(['Bearer sk-A', 'Bearer sk-B']) // 换 key 重试发生了一次
      // 失效 key 已标记冷却（只此索引），healthy key 不受牵连
      expect(keyInCooldown(rt, 'pa', 0)).toBe(true)
      expect(keyInCooldown(rt, 'pa', 1)).toBe(false)
      // 下一次请求直接从 healthy key 起步：不再撞 401
      const r2 = await forwardToUpstream(rt, baseOn(cfg, 'pa'), { method: 'POST', body, path: ROUTED, headers: {}, idleTimeoutMs: 5000, retries: 0 })
      expect(r2.status).toBe(200)
      expect(mock.auths).toEqual(['Bearer sk-A', 'Bearer sk-B', 'Bearer sk-B'])
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('池内全部 key 401：换 key 重试仍拒 → candidateSkip 进 failover 链，两把都标记冷却', async () => {
    const h = fakeHome()
    const mock = await startKeyMock(() => 401)
    try {
      const pa = await twoKeyProvider(mock)
      const rt = buildRt({ pa })
      const cfg = rt.config as Config
      const err = await forwardToUpstream(rt, baseOn(cfg, 'pa'), { method: 'POST', body, path: ROUTED, headers: {}, idleTimeoutMs: 5000, retries: 0 }).then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(UpstreamError)
      const e = err as UpstreamError
      expect(e.status).toBe(503)
      expect(e.candidateSkip).toBe(true)
      expect(mock.auths).toEqual(['Bearer sk-A', 'Bearer sk-B']) // 先后试了两把
      expect(keyInCooldown(rt, 'pa', 0)).toBe(true)
      expect(keyInCooldown(rt, 'pa', 1)).toBe(true)
      // 冷却期内再次请求：解析层直接 candidateSkip，不再打上游（无新增请求）
      await expect(forwardToUpstream(rt, baseOn(cfg, 'pa'), { method: 'POST', body, path: ROUTED, headers: {}, idleTimeoutMs: 5000, retries: 0 })).rejects.toMatchObject({ status: 503, candidateSkip: true })
      expect(mock.count()).toBe(2)
      expect(e.hint).toContain('set-key')
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('forwardWithFailover：key 池全灭的 provider 被跳过，切到备用 provider（同请求内）', async () => {
    const h = fakeHome()
    const bad = await startKeyMock(() => 401)
    const good = await startKeyMock()
    try {
      const pa = await twoKeyProvider(bad)
      await setSecret('pb-0', 'sk-PB', 'file')
      const pb = providerCfg({ name: 'pb', base_url: good.url, key_ref: 'file:pb-0' })
      const rt = buildRt({ pa, pb })
      const cfg = rt.config as Config
      const r = await forwardWithFailover(rt, baseOn(cfg, 'pa'), { method: 'POST', body, path: ROUTED, headers: {}, idleTimeoutMs: 5000, retries: 0, fallbackIds: ['pb'] })
      expect(r.usedProviderId).toBe('pb')
      expect(r.status).toBe(200)
      expect(r.reason).toBe('failover_to:pb,replayed_from:pa')
      expect(bad.count()).toBe(2) // pa 先后试两把 key 后才让位
      expect(good.auths).toEqual(['Bearer sk-PB'])
    } finally {
      await bad.close()
      await good.close()
      h.restore()
    }
  })

  it('单 key 池向后兼容：首个 401 原样透传客户端（看得到上游错误体）；下一次请求起自动跳过', async () => {
    const h = fakeHome()
    const mock = await startKeyMock(() => 401)
    try {
      await setSecret('ps-0', 'sk-PS', 'file')
      const ps = providerCfg({ name: 'ps', base_url: mock.url, key_ref: 'file:ps-0' })
      const rt = buildRt({ ps })
      const cfg = rt.config as Config
      // 首个请求：无第二把 key 可换，401 保持既有透传行为
      const r1 = await forwardToUpstream(rt, baseOn(cfg, 'ps'), { method: 'POST', body, path: ROUTED, headers: {}, idleTimeoutMs: 5000, retries: 0 })
      expect(r1.status).toBe(401)
      expect(mock.count()).toBe(1)
      expect(keyInCooldown(rt, 'ps', 0)).toBe(true)
      // 后续请求：key 冷却 → candidateSkip（有备用 provider 时即自动切换），不再打上游
      await expect(forwardToUpstream(rt, baseOn(cfg, 'ps'), { method: 'POST', body, path: ROUTED, headers: {}, idleTimeoutMs: 5000, retries: 0 })).rejects.toMatchObject({ status: 503, candidateSkip: true })
      expect(mock.count()).toBe(1)
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('非模型 API 端点的 401 不做 key 级失效处理：透传且不冷却（路径级权限≠key 失效，防误伤）', async () => {
    const h = fakeHome()
    const mock = await startKeyMock(() => 401)
    try {
      await setSecret('pn-0', 'sk-PN', 'file')
      const pn = providerCfg({ name: 'pn', base_url: mock.url, key_ref: 'file:pn-0' })
      const rt = buildRt({ pn })
      const cfg = rt.config as Config
      // /unauth 不是 ROUTED_PATH_RE 对话端点：401 原样透传（既有行为），key 不进冷却
      const r1 = await forwardToUpstream(rt, baseOn(cfg, 'pn'), { method: 'POST', body, path: '/unauth', headers: {}, idleTimeoutMs: 5000, retries: 0 })
      expect(r1.status).toBe(401)
      expect(keyInCooldown(rt, 'pn', 0)).toBe(false)
      // 后续请求照常到达上游（provider 未被误停）
      const r2 = await forwardToUpstream(rt, baseOn(cfg, 'pn'), { method: 'POST', body, path: '/unauth', headers: {}, idleTimeoutMs: 5000, retries: 0 })
      expect(r2.status).toBe(401)
      expect(mock.count()).toBe(2)
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('池内个别引用不可读（file:ghost）只跳过该把，其余 key 照常轮转', async () => {
    const h = fakeHome()
    const mock = await startKeyMock()
    try {
      await setSecret('pg-1', 'sk-GOOD', 'file')
      const pg = providerCfg({ name: 'pg', base_url: mock.url, key_ref: 'file:pg-0', keys: ['file:pg-0', 'file:pg-1'] })
      const rt = buildRt({ pg })
      const cfg = rt.config as Config
      const r = await forwardToUpstream(rt, baseOn(cfg, 'pg'), { method: 'POST', body, path: ROUTED, headers: {}, idleTimeoutMs: 5000, retries: 0 })
      expect(r.status).toBe(200)
      expect(mock.auths).toEqual(['Bearer sk-GOOD'])
    } finally {
      await mock.close()
      h.restore()
    }
  })
})

// ---------------------------------------------------------------------------
// admin 可见性：/_modeldock/metrics 暴露 per-provider key 数量与健康态，绝无 key 明文
describe('keypool · /_modeldock/metrics 观测面', () => {
  it('keypool 字段：total/healthy/冷却索引与剩余 ms；响应不含 key 值', async () => {
    const h = fakeHome()
    const rt = buildRuntime(
      {
        version: 1,
        providers: { mp: providerCfg({ name: 'mp', key_ref: 'file:mk-0', keys: ['file:mk-0', 'file:mk-1'] }) },
        profiles: {},
        harness: {},
      } as unknown as Config,
      'admin-token-x',
    )
    markKeyCooldown(rt, 'mp', 1)
    const server = createGatewayServer(rt, { port: 0 })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}/_modeldock/metrics`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      expect(res.status).toBe(200)
      const raw = await res.text()
      const j = JSON.parse(raw) as { keypool: Record<string, { total: number; healthy: number; cooldown: Array<{ index: number; remaining_ms: number }> }> }
      expect(j.keypool.mp).toEqual({ total: 2, healthy: 1, cooldown: [{ index: 1, remaining_ms: expect.any(Number) }] })
      // 绝不返回 key 明文/引用原文（ref 可能内嵌明文 key）
      expect(raw).not.toContain('sk-')
      expect(raw).not.toContain('file:mk-0')
    } finally {
      server.closeAllConnections?.()
      await new Promise<void>((r) => server.close(() => r()))
      h.restore()
    }
  })
})

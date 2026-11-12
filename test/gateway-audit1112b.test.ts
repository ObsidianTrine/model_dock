import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { fakeHome } from './helpers.js'
import { buildRuntime, reloadRuntime, registerEphemeralHarness, logRequest, usageTodayView, resetUsageTodayForTest, type GatewayRuntime } from '../src/gateway/state.js'
import { forwardWithFailover, readUpstreamErrorText, type ForwardOptions } from '../src/gateway/relay.js'
import { acquireProviderSlot, providerConcurrencyStats } from '../src/gateway/concurrency.js'
import { probeProviderModels } from '../src/gateway/modelprobe.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { invalidateOverviewCache } from '../src/gateway/overview-view.js'
import { setSecret } from '../src/config/secrets.js'
import { saveConfig } from '../src/config/store.js'
import type { Config, ProviderConfig } from '../src/config/types.js'
import { logsDir } from '../src/util/paths.js'
import { localIsoTs } from '../src/util/time.js'

// schedule 端点/overview 构建会后台拉节假日日历（外网），模型目录同理：测试环境一律禁用
// （与 gateway.test.ts 同款环境护栏，防沙箱内触发出站请求）
process.env.MODELRDOCK_DISABLE_HOLIDAY_FETCH = '1'
process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'

// 桌面客户端 presence 探测在 Windows 上要跑 reg 全树注册表扫描（拖慢 overview 构建）：
// 统一按「未安装」判定跳过子进程（与 gateway.test.ts 同款）
const DESKTOP_PRESENCE_IDS = ['workbuddy', 'zcode', 'mimo-desktop']
beforeEach(() => {
  for (const id of DESKTOP_PRESENCE_IDS) {
    process.env[`MODELRDOCK_FAKE_${id.toUpperCase().replace(/-/g, '_')}_PRESENT`] = '0'
  }
})
afterEach(() => {
  for (const id of DESKTOP_PRESENCE_IDS) {
    delete process.env[`MODELRDOCK_FAKE_${id.toUpperCase().replace(/-/g, '_')}_PRESENT`]
  }
})

/** 夜航审查 cruise1112-audit-gateway 批次 B（非 server.ts findings）的回归测试：
 *  P1-3 modelprobe 池口径 / P2-4 relay 计时口径 / P2-5 accept-encoding 剥离（usage 明文）/
 *  P2-6 错误体有界读 / P2-7 reloadRuntime 清理 / P2-9 并发闸热调小 / P2-11 今日仪表流式回填 /
 *  P2-8 hOverview 先构建再发头。 */

const body = Buffer.from(JSON.stringify({ model: 'm', messages: [] }))
const ROUTED = '/v1/messages'

function providerCfg(id: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { name: id, base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: `file:${id}`, priority: 0, ...over }
}

function buildRt(providers: Record<string, ProviderConfig>, gateway?: Config['gateway']): GatewayRuntime {
  const cfg = { providers, profiles: {}, harness: {}, gateway: { auto_fallback: false, ...gateway } } as unknown as Config
  return buildRuntime(cfg, 'tok')
}

function baseOn(cfg: { providers: Record<string, ProviderConfig> }, id: string) {
  return { harness: 'test', profileName: 'p', profile: { name: 'p', provider: id }, provider: cfg.providers[id] }
}

function fwd(over: Partial<ForwardOptions> = {}): ForwardOptions {
  return { method: 'POST', path: ROUTED, headers: {}, body, idleTimeoutMs: 60_000, retries: 1, ...over }
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.()
  return new Promise((r) => server.close(() => r()))
}

/** 首个请求慢 N ms、后续即回的 200 上游：P2-4 排队等待不计入候选耗时的验证用 */
function firstSlowMock(firstMs: number): { server: http.Server; url: Promise<string> } {
  let hits = 0
  const server = http.createServer((_req, res) => {
    const delay = hits === 0 ? firstMs : 0
    hits++
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }, delay)
  })
  return { server, url: listen(server) }
}

/** 「客户端要压缩才压缩」的规矩上游（P2-5）：请求带 accept-encoding 时回 gzip 体，否则回明文。
 *  记录每个请求实际收到的 accept-encoding 供断言「网关出站不再索取压缩」。 */
function gzipAwareUpstream(): { server: http.Server; url: Promise<string>; seenAcceptEncoding: () => string | undefined } {
  let lastAE: string | undefined
  const server = http.createServer((req, res) => {
    lastAE = req.headers['accept-encoding'] as string | undefined
    const payload = JSON.stringify({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 7, output_tokens: 3 } })
    if (lastAE) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(zlib.gzipSync(Buffer.from(payload, 'utf8')))
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(payload)
    }
  })
  return { server, url: listen(server), seenAcceptEncoding: () => lastAE }
}

/** 管理面网关（P2-8）：起在随机端口，返回 rt 供用例投毒 */
async function setupGateway(cfg: Config): Promise<{ rt: GatewayRuntime; port: number; closeAll: () => Promise<void> }> {
  await saveConfig(cfg)
  const rt = buildRuntime(cfg, 'admin-token-x')
  const server = createGatewayServer(rt, { port: 0 })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return {
    rt,
    port,
    closeAll: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

describe('P1-3 modelprobe：key 池全量口径探测（池-only 服务不再被跳过）', () => {
  it('手编 keys 数组、无 key_ref 的服务：首个可读池 ref 折回探测，模型列表进缓存', async () => {
    const h = fakeHome()
    const up = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }))
    })
    const base = await listen(up)
    try {
      const cfg = { providers: { p1: providerCfg('p1', { base_url: base, key_ref: undefined, keys: ['file:pool-a'] }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRuntime(cfg, 'tok')
      await setSecret('pool-a', 'sk-pool', 'file')
      await probeProviderModels(rt, 'p1')
      const r = rt.modelProbe?.results.get('p1')
      expect(r?.ok).toBe(true)
      expect(r?.model_ids).toEqual(['m1', 'm2'])
    } finally {
      await close(up)
      h.restore()
    }
  })

  it('未配 key / 引用条目缺失：维持「从未探测」缺席语义，不留条目', async () => {
    const h = fakeHome()
    try {
      // 完全未配 key 的服务：不留条目（缺席 = 从未探测 ≠ 不可用，既有语义）
      const cfg = { providers: { p2: providerCfg('p2', { key_ref: undefined }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRuntime(cfg, 'tok')
      await probeProviderModels(rt, 'p2')
      expect(rt.modelProbe?.results.has('p2')).toBe(false)
      // 引用条目缺失（file:xxx 无对应密钥）：getSecret 返回空，等同未配 key——同样缺席，
      // 不与「密钥后端抛错」的负缓存混淆（读不到 ≠ 探失败）
      const cfg2 = { providers: { p3: providerCfg('p3', { key_ref: 'file:no-such-entry' }) }, profiles: {}, harness: {} } as unknown as Config
      const rt2 = buildRuntime(cfg2, 'tok')
      await probeProviderModels(rt2, 'p3')
      expect(rt2.modelProbe?.results.has('p3')).toBe(false)
    } finally {
      h.restore()
    }
  })
})

describe('P2-4 relay：并发闸排队等待不计入候选耗时（recordOutcome 口径）', () => {
  it('排队 200ms 后取槽：health.lastMs 只含上游耗时（旧口径会记成 ~200ms+）', async () => {
    const h = fakeHome()
    const mock = firstSlowMock(150)
    try {
      const cfg = { providers: { a: providerCfg('a', { base_url: await mock.url, max_concurrency: 1 }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      await setSecret('a', 'sk-a', 'file')
      const target = baseOn(cfg, 'a')
      const opts = fwd()
      // R1 占住唯一槽位（上游 150ms 后响应；槽位由返回值 release 句柄持有）
      const r1 = await forwardWithFailover(rt, target, opts)
      expect(r1.status).toBe(200)
      // R2 到达即排队；期间排队者可观测
      const p2 = forwardWithFailover(rt, target, opts)
      await new Promise((r) => setTimeout(r, 30))
      expect(providerConcurrencyStats(rt, 'a').queued).toBe(1)
      // 持有槽位 200ms 模拟排队等待窗口，再放行
      await new Promise((r) => setTimeout(r, 200))
      r1.release!()
      const r2 = await p2
      expect(r2.status).toBe(200)
      r2.release?.()
      // 旧口径：t0 在取槽前 → lastMs ≈ 230ms+；新口径：t0 在取槽后 → 只含上游往返（毫秒级）
      const lastMs = rt.health.get('a')?.lastMs
      expect(lastMs).toBeDefined()
      expect(lastMs!).toBeLessThan(100)
    } finally {
      await close(mock.server)
      h.restore()
    }
  })
})

describe('P2-5 出站不索取压缩：usage tap 恒见明文（日限额护栏不失明）', () => {
  it('客户端带 accept-encoding: gzip 请求：上游请求头无 accept-encoding，用量照常入账', async () => {
    const h = fakeHome()
    const up = gzipAwareUpstream()
    try {
      const base = await up.url
      const cfg = {
        version: 1,
        active_profile: 'demo',
        security: { store: 'file' },
        providers: { up: providerCfg('up', { base_url: base }) },
        profiles: { demo: { provider: 'up', default_model: 'preset-model' } },
        harness: { 'claude-code': { mode: 'gateway', route: 'default', token: 'mdk_harness_token_abcdef' } },
      } as unknown as Config
      await setSecret('up', 'sk-up', 'file')
      const gw = await setupGateway(cfg)
      try {
        const res = await fetch(`http://127.0.0.1:${gw.port}/v1/messages`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer mdk_harness_token_abcdef',
            'content-type': 'application/json',
            'accept-encoding': 'gzip',
          },
          body: JSON.stringify({ model: 'preset-model', max_tokens: 10, messages: [] }),
        })
        expect(res.status).toBe(200)
        const j = (await res.json()) as { usage?: { output_tokens: number } }
        expect(j.usage?.output_tokens).toBe(3) // 客户端拿到的是明文体（tap 同源）
        expect(up.seenAcceptEncoding()).toBeUndefined() // 出站头已剥离：上游不压缩 → tap 见明文
        // 用量落账（日志条目带 usage）：旧口径下上游压缩体进 tap → usage 缺失
        const dayFile = path.join(logsDir(), `gateway-${localIsoTs().slice(0, 10)}.jsonl`)
        let logged = false
        for (let i = 0; i < 120 && !logged; i++) {
          const raw = fs.existsSync(dayFile) ? fs.readFileSync(dayFile, 'utf8') : ''
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue
            try {
              const e = JSON.parse(line) as { harness?: string; usage?: { output_tokens: number } }
              if (e.harness === 'claude-code' && e.usage?.output_tokens === 3) logged = true
            } catch {
              /* 崩溃半行 */
            }
          }
          if (!logged) await new Promise((r) => setTimeout(r, 25))
        }
        expect(logged).toBe(true)
      } finally {
        await gw.closeAll()
      }
    } finally {
      await close(up.server)
      h.restore()
    }
  })
})

describe('P2-6 上游错误体有界读（1MB 上限截断保留头部）', () => {
  it('无限流式错误体：读到上限即停、流被销毁，不再整体进堆', async () => {
    const CHUNK = 64 * 1024
    // 永远有数据的错误体（异常/恶意上游形态）：旧实现会一直读到达上限内存
    const endless = new Readable({ read() { this.push(Buffer.alloc(CHUNK, 0x61)) } })
    const text = await readUpstreamErrorText({}, endless as unknown as Parameters<typeof readUpstreamErrorText>[1])
    const n = Buffer.byteLength(text)
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThanOrEqual(1024 * 1024 + CHUNK) // 截断在上限附近，不吞全量
    expect(endless.destroyed).toBe(true) // for-await break → 流就地销毁、连接释放
  })
})

describe('P2-7 reloadRuntime 清理 metricsLatency 与非临时 tokenUsage', () => {
  it('已删 provider 的延迟采样与已删 harness 的 token 计数被清，幸存者与临时条目保留', async () => {
    const h = fakeHome()
    try {
      const cfg = {
        version: 1,
        security: { store: 'file' },
        providers: { keep: providerCfg('keep') },
        profiles: {},
        harness: { h1: { mode: 'gateway' } },
      } as unknown as Config
      await saveConfig(cfg)
      const rt = buildRuntime(cfg, 'tok')
      rt.metricsLatency.set('keep', { samples: [1], count: 1 })
      rt.metricsLatency.set('ghost', { samples: [2], count: 1 })
      const usage = { rpmStart: 0, rpmCount: 1, dayKey: '2026-11-13', dayTokens: 5, dayBillableTokens: 3 }
      rt.tokenUsage.set('h1', { ...usage })
      rt.tokenUsage.set('ghost-h', { ...usage })
      // 临时 harness：reload 后 reapply 重注入 config.harness，其计数不得被清理误删
      registerEphemeralHarness(rt, { id: 'eph-x', ttlMinutes: 10 })
      rt.tokenUsage.set('eph-x', { ...usage })
      await reloadRuntime(rt)
      expect(rt.metricsLatency.has('keep')).toBe(true)
      expect(rt.metricsLatency.has('ghost')).toBe(false)
      expect(rt.tokenUsage.has('h1')).toBe(true)
      expect(rt.tokenUsage.has('ghost-h')).toBe(false)
      expect(rt.tokenUsage.has('eph-x')).toBe(true)
    } finally {
      h.restore()
    }
  })
})

describe('P2-9 并发闸热加载调小上限：release/pump 按新上限放行（不吃陈旧 lastLimit）', () => {
  it('上限 5→1 热改后：释放槽位不再超放排队者，在途不越过新上限', async () => {
    const h = fakeHome()
    try {
      const cfg = { providers: { a: providerCfg('a', { max_concurrency: 5 }) }, profiles: {}, harness: {} } as unknown as Config
      const rt = buildRt(cfg.providers)
      // 占满全部 5 个槽位，第 6 个请求进入排队
      const slots = []
      for (let i = 0; i < 5; i++) slots.push(await acquireProviderSlot(rt, 'a', 5, 5_000, undefined))
      const p6 = acquireProviderSlot(rt, 'a', 5, 5_000, undefined)
      await new Promise((r) => setTimeout(r, 0))
      expect(providerConcurrencyStats(rt, 'a')).toEqual({ inFlight: 5, queued: 1 })
      // 模拟热加载把 max_concurrency 调小到 1（reloadRuntime 整包换 config 的等效形态）
      cfg.providers.a = { ...cfg.providers.a, max_concurrency: 1 }
      slots[4].release()
      await new Promise((r) => setTimeout(r, 0))
      // 旧口径：pump 按 lastLimit=5 → 排队者立即放行，在途瞬时 5 不降反回满。
      // 新口径：pump 实时重读配置 → 排队者继续等，在途自然回落
      expect(providerConcurrencyStats(rt, 'a')).toEqual({ inFlight: 4, queued: 1 })
      for (let i = 0; i < 4; i++) slots[i].release()
      const s6 = await p6 // 容量按新上限腾出后排队者放行
      expect(providerConcurrencyStats(rt, 'a')).toEqual({ inFlight: 1, queued: 0 })
      s6.release()
    } finally {
      h.restore()
    }
  })
})

describe('P2-11 今日用量仪表：跨日/重启首请求流式异步回填（事件循环不再冻结）', () => {
  it('当日日志回填异步完成且与增量记账不双计', async () => {
    const h = fakeHome()
    try {
      resetUsageTodayForTest()
      const dir = logsDir()
      fs.mkdirSync(dir, { recursive: true })
      const day = localIsoTs().slice(0, 10)
      const mk = (ts: string, input: number, output: number): string =>
        JSON.stringify({ ts, harness: 'h', profile: 'p', provider: 'prov', path: '/v1/messages', status: 200, ms: 5, usage: { input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_creation_tokens: 0 } })
      // 3 条「重启前」的当日日志（ts 早于仪表创建时刻）
      const rows = [0, 1, 2].map((i) => mk(localIsoTs(new Date(Date.now() - 5000 - i)), 10, 5)).join('\n') + '\n'
      fs.writeFileSync(path.join(dir, `gateway-${day}.jsonl`), rows)
      // 首次触达（overview /usage-live 同路径）：tracker 创建 + 异步回填，不阻塞本调用
      let v = usageTodayView()
      expect(v.date).toBe(day)
      const deadline = Date.now() + 3000
      while (v.requests < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
        v = usageTodayView()
      }
      expect(v.requests).toBe(3) // 回填收齐当日存盘条目
      expect(v.tokens.input).toBe(30) // 累计口径 input（无缓存字段）× 3 条
      // 增量记账（logRequest 热路径）：ts ≥ 回填下界，不与回填重叠 → 恰好 +1 不双计
      const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 'tok')
      logRequest(rt, { ts: localIsoTs(), harness: 'h', profile: 'p', provider: 'prov', path: '/v1/messages', status: 200, ms: 1, usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } })
      v = usageTodayView()
      expect(v.requests).toBe(4)
      expect(v.tokens.input).toBe(31)
      resetUsageTodayForTest()
    } finally {
      h.restore()
    }
  })
})

describe('P2-8 hOverview 先构建再发头：构建失败回可操作错误 JSON 而非 RST', () => {
  it('overview 构建抛错（config 投毒）：客户端收到 500 + JSON error 体', async () => {
    const h = fakeHome()
    try {
      const cfg = {
        version: 1,
        active_profile: 'demo',
        security: { store: 'file' },
        providers: { up: providerCfg('up') },
        profiles: { demo: { provider: 'up' } },
        harness: {},
      } as unknown as Config
      const gw = await setupGateway(cfg)
      try {
        // 投毒：读取 config.providers 即抛（buildOverview 内未兜底的异常形态）
        invalidateOverviewCache()
        Object.defineProperty(gw.rt.config, 'providers', {
          configurable: true,
          get() {
            throw new Error('poisoned-for-test')
          },
        })
        const res = await fetch(`http://127.0.0.1:${gw.port}/_modeldock/overview`, {
          headers: { 'x-modeldock-admin': 'admin-token-x' },
        })
        // 旧口径：先发 200 头再 await → 失败时连接被 destroy，客户端拿到 200 空体/网络错误。
        // 新口径：头未发，顶层兜底 sendError → 500 + 可解析 JSON
        expect(res.status).toBe(500)
        const j = (await res.json()) as { error?: { message?: string } }
        expect(typeof j.error?.message).toBe('string')
      } finally {
        await gw.closeAll()
      }
    } finally {
      h.restore()
    }
  })
})

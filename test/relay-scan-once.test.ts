import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { __testResetScanCount, __testScanCount, forwardWithFailover, rewriteModel } from '../src/gateway/relay.js'
import { buildRuntime } from '../src/gateway/state.js'
import { setSecret } from '../src/config/secrets.js'
import { fakeHome } from './helpers.js'
import type { Config, ProfileConfig, ProviderConfig } from '../src/config/types.js'
import type { ResolvedTarget } from '../src/gateway/state/types.js'

// perf-relay-scan-once：9b2229f 在 forwardWithFailover 无条件 topLevelModel(opts.body) 全量扫描 +
// 逐候选 rewriteModel 内再各扫一次（浅扫描无早退必须走到顶层 `}`，大体上每次数 ms 级）——单候选
// 常态链每请求 2 次、N 候选 N+1 次。修复后整链只扫一次：forwardWithFailover 算一次经 opts.bodyScan
// 下沉复用（改写层只造新 Buffer 从不原地改入参，候选切换 / 429 原地重试后 body 不变，同一扫描
// 全程有效）；非 routed / 空体时改写层与过滤层都不需要它，0 次扫描。
// 扫描次数经 __testScanCount 模块内计数器观测（__test* 套路，不碰 vi.mock 跨文件雷区）；
// 「对外行为字节级不变」由各用例一并断言。全部真实入口（不 mock 模块）；mock 上游 listen(0)。

const ROUTED = '/v1/messages'
const mk = (s: string) => Buffer.from(s, 'utf8')

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

/** 目录条目快捷构造（过滤只看键名存在） */
function catalog(...ids: string[]): Record<string, { source: 'fetched' }> {
  return Object.fromEntries(ids.map((id) => [id, { source: 'fetched' as const }]))
}

const ok200 = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"ok":true}')
}

describe('relay · 全量体扫描整链一次（perf-relay-scan-once）', () => {
  it('单 provider（仅主候选，无自动候选）routed 请求：恰 1 次扫描（修复前对账+改写 2 次），体字节原样透传', async () => {
    const h = fakeHome()
    const pa = await startMock(ok200)
    try {
      await setSecret('pa', 'sk-pa', 'file')
      const rt = buildRt({ pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa' }) })
      __testResetScanCount()
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts() as never)
      expect(r.status).toBe(200)
      expect(__testScanCount()).toBe(1)
      // 行为透明：未配改写时请求体逐字节原样到达上游，modelAfter 如实
      expect(pa.reqs[0].body).toBe(JSON.stringify({ model: 'glm-4.7', messages: [] }))
      expect(r.modelAfter).toBe('glm-4.7')
    } finally {
      await pa.close()
      h.restore()
    }
  })

  it('非 routed path：0 次扫描（修复前对账无条件 topLevelModel 也扫 1 次）', async () => {
    const h = fakeHome()
    const pa = await startMock(ok200)
    try {
      await setSecret('pa', 'sk-pa', 'file')
      const rt = buildRt({ pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa' }) })
      __testResetScanCount()
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts({ path: '/v1/other' }) as never)
      expect(r.status).toBe(200)
      expect(__testScanCount()).toBe(0)
      expect(pa.reqs[0].body).toBe(JSON.stringify({ model: 'glm-4.7', messages: [] }))
    } finally {
      await pa.close()
      h.restore()
    }
  })

  it('429 failover 链（主候选 → 自动候选，含剔除候选）：整链恰 1 次扫描（修复前 3 次），别名改写字节正确', async () => {
    const h = fakeHome()
    const pa = await startMock((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"rate limited"}}')
    })
    const pb = await startMock(ok200)
    const pc = await startMock(ok200) // 目录不含别名目标 glm-4.7：不应被重放
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
      __testResetScanCount()
      const r = await forwardWithFailover(rt, base, fwdOpts({ body: Buffer.from(JSON.stringify({ model: 'my-glm', messages: [] })) }) as never)
      expect(r.usedProviderId).toBe('pb')
      expect(r.reason).toBe('failover_to:pb,model_mismatch:pc,replayed_from:pa')
      expect(__testScanCount()).toBe(1) // 对账 + pa/pb 两个候选的改写全靠下沉的同一份扫描
      // 复用的字节区间仍指向原 body：pb 实际收到别名改写结果
      expect(JSON.parse(pb.reqs[0].body).model).toBe('glm-4.7')
      expect(pc.reqs.length).toBe(0)
    } finally {
      await Promise.all([pa.close(), pb.close(), pc.close()])
      h.restore()
    }
  })

  it('429 原地重试（Retry-After ≤5s）：重试不改体，恰 1 次扫描（修复前对账+首改写+重试改写 3 次）', async () => {
    const h = fakeHome()
    let hits = 0
    const pa = await startMock((_req, res) => {
      hits++
      if (hits === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
        res.end('{"error":{"message":"rate limited"}}') // 非额度体 → 原地重试
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      }
    })
    try {
      await setSecret('pa', 'sk-pa', 'file')
      const rt = buildRt({ pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa' }) })
      __testResetScanCount()
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts() as never)
      expect(r.status).toBe(200)
      expect(r.reason).toBe('retried_429:pa')
      expect(pa.reqs.length).toBe(2)
      expect(pa.reqs[1].body).toBe(pa.reqs[0].body) // 重试体逐字节一致
      expect(__testScanCount()).toBe(1)
    } finally {
      await pa.close()
      h.restore()
    }
  })

  it('扫描拿不准（转义键）body：恰 1 次扫描，prescan=null 走全量解析路径不重扫', async () => {
    const h = fakeHome()
    const pa = await startMock(ok200)
    try {
      await setSecret('pa', 'sk-pa', 'file')
      const rt = buildRt({ pa: providerCfg({ name: 'pa', base_url: pa.url, key_ref: 'file:pa' }) })
      __testResetScanCount()
      const body = Buffer.from('{"a\\u0041":1,"model":"glm-4.7"}') // 转义键 → 浅扫描放弃（null）
      const r = await forwardWithFailover(rt, baseOn(rt.config as Config, 'pa'), fwdOpts({ body }) as never)
      expect(r.status).toBe(200)
      expect(__testScanCount()).toBe(1) // 对账与改写共用同一份 null 结果，全量解析路径不再补扫
      expect(pa.reqs[0].body).toBe('{"a\\u0041":1,"model":"glm-4.7"}') // 未配改写：体原样透传
    } finally {
      await pa.close()
      h.restore()
    }
  })

  it('rewriteModel 复用 prescan 与自扫逐字节等价（改写 / 不改写同引用 / null 全量路径）', () => {
    const t = (): ResolvedTarget => ({
      harness: 'test',
      profileName: 'p',
      profile: { name: 'p', provider: 'prov', aliases: { 'my-glm': 'glm-4.7' } },
      provider: { base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' },
    })
    // 改写路径：prescan 的字节区间直接喂 splice，结果与自扫一致（含多字节字符原样保留）
    const raw = '{"model":"my-glm","note":"世界","messages":[]}'
    const qStart = raw.indexOf('"my-glm"')
    const prescan = { value: 'my-glm', qStart, qEnd: qStart + '"my-glm"'.length }
    const selfScan = rewriteModel(t(), mk(raw), ROUTED)
    const reused = rewriteModel(t(), mk(raw), ROUTED, prescan)
    expect(selfScan.modelAfter).toBe('glm-4.7')
    expect(reused.modelAfter).toBe('glm-4.7')
    expect(reused.body.toString('utf8')).toBe(selfScan.body.toString('utf8'))
    expect(reused.body.toString('utf8')).toBe('{"model":"glm-4.7","note":"世界","messages":[]}')
    // 不改写路径：final === wire 时返回入参同一 Buffer 引用，prescan 不改变该性质
    const raw2 = '{"model":"glm-4.7","messages":[]}'
    const inC = mk(raw2)
    expect(rewriteModel(t(), inC, ROUTED).body).toBe(inC)
    const inD = mk(raw2)
    const q2 = raw2.indexOf('"glm-4.7"')
    const d = rewriteModel(t(), inD, ROUTED, { value: 'glm-4.7', qStart: q2, qEnd: q2 + '"glm-4.7"'.length })
    expect(d.body).toBe(inD)
    // prescan=null（扫描拿不准）：与自扫 null 同走全量解析路径，结果一致
    const raw3 = '{"a\\u0041":1,"model":"my-glm"}'
    const e = rewriteModel(t(), mk(raw3), ROUTED)
    const f = rewriteModel(t(), mk(raw3), ROUTED, null)
    expect(f.modelAfter).toBe(e.modelAfter)
    expect(f.body.toString('utf8')).toBe(e.body.toString('utf8'))
  })
})

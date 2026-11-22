import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { makeRelayProbeTransport, probeCooldownUntil, runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport } from '../src/gateway/probe/engine.js'
import { P1_CANARY, runP1 } from '../src/gateway/probe/runners/p1.js'
import { getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { setSecret } from '../src/config/secrets.js'
import { fakeHome } from './helpers.js'
import type { Config, ProviderConfig } from '../src/config/types.js'

// P1 鉴权回声（provider-probe-suite 任务 3）：mock 上游分别驱动五种归档（healthy/auth-dead/
// quota/unreachable/degraded），断言 verdict 与归档一致；quota 判定复用 relay 的 isQuotaError
// （402 与 429+额度特征归 quota，普通 429 走引擎退避+冷却）；三协议路径拼装经 probeWire 与
// server.ts probe() 同源；调用入探针账本（探针独立账本，不进请求日志）。

function mkRt(providers: Record<string, unknown> = {}): GatewayRuntime {
  return buildRuntime({ providers, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const providerCfg = (protocol: string): Record<string, unknown> => ({
  name: 'acme',
  base_url: 'https://acme.test',
  protocol,
  auth_style: 'bearer',
  key_ref: 'plain:sk-probe-p1-key',
})

const targetOf = (providerId = 'acme', model = 'm', keyFp = 'fp1') => ({ providerId, model, keyFp })

const okBody = (): string =>
  JSON.stringify({ model: 'm', choices: [{ message: { content: P1_CANARY } }], usage: { input_tokens: 5, output_tokens: 2 } })

const runP1Suite = (rt: GatewayRuntime, transport: ProbeTransport, target = targetOf()) =>
  runProbeSuite(rt, { probeIds: ['p1'], targets: [target], transport, runner: runP1, confirmed: true })

describe('probe-p1 · 五态归档', () => {
  it('200 精确回显 MODELDOCK-OK → healthy（canary 单样本）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt({ acme: providerCfg('openai') })
      let calls = 0
      const transport: ProbeTransport = async (req) => {
        calls++
        expect(req.path).toBe('/v1/chat/completions')
        expect(req.body?.toString('utf8')).toContain(P1_CANARY)
        return { status: 200, ms: 7, bodyText: okBody(), usage: { input_tokens: 5, output_tokens: 2 } }
      }
      const r = await runP1Suite(rt, transport)
      expect(calls).toBe(1) // canary 单样本
      expect(r.upstreamRequests).toBe(1)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'm')
      expect(v?.state).toBe('healthy')
      expect(v?.evidence.status).toBe(200)
      expect(v?.evidence.source).toBe('probe:p1')
      // 账本：usage 合计入账（5+2），预估按 S 档 200
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(1)
      expect(ledger[0].probe_id).toBe('p1')
      expect(ledger[0].tokens).toBe(7)
      expect(ledger[0].estimated_tokens).toBe(200)
      expect(ledger[0].key_fp).toBe('fp1')
    } finally {
      h.restore()
    }
  })

  it('200 但回显不匹配 → degraded（宁严勿松）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => ({
        status: 200,
        ms: 5,
        bodyText: JSON.stringify({ choices: [{ message: { content: 'hello there' } }] }),
      })
      await runP1Suite(rt, transport)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'm')
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.err).toContain('MODELDOCK-OK')
    } finally {
      h.restore()
    }
  })

  it('401/403 → auth-dead；500/400 等其余 4xx/5xx → degraded', async () => {
    const h = fakeHome()
    try {
      for (const [status, expected] of [
        [401, 'auth-dead'],
        [403, 'auth-dead'],
        [500, 'degraded'],
        [404, 'degraded'],
      ] as const) {
        const rt = mkRt()
        const transport: ProbeTransport = async () => ({
          status,
          ms: 4,
          bodyText: JSON.stringify({ error: { message: `upstream ${status}` } }),
        })
        await runP1Suite(rt, transport, { providerId: 'acme', model: `m-${expected}-${status}`, keyFp: 'fp1' })
        const v = getProbeVerdict(rt, 'acme', `fp1`, `m-${expected}-${status}`)
        expect(v?.state, `status ${status}`).toBe(expected)
        expect(v?.evidence.status).toBe(status)
        expect(v?.evidence.err).toBe(`upstream ${status}`)
      }
    } finally {
      h.restore()
    }
  })

  it('402 → quota；429+额度特征 → quota（isQuotaError 单一口径，不触发冷却）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => ({ status: 402, ms: 3, bodyText: 'insufficient balance' })
      await runP1Suite(rt, transport, targetOf('acme', 'm-402', 'fp1'))
      expect(getProbeVerdict(rt, 'acme', 'fp1', 'm-402')?.state).toBe('quota')
      expect(probeCooldownUntil(rt, 'acme')).toBeUndefined() // 额度死不是限流：不退避不冷却

      const rt2 = mkRt()
      const transport2: ProbeTransport = async () => ({
        status: 429,
        ms: 3,
        bodyText: JSON.stringify({ error: { message: 'AccountQuotaExceeded: 额度不足' } }),
      })
      await runP1Suite(rt2, transport2, targetOf('acme', 'm-429q', 'fp1'))
      expect(getProbeVerdict(rt2, 'acme', 'fp1', 'm-429q')?.state).toBe('quota')
      expect(probeCooldownUntil(rt2, 'acme')).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('普通 429（无额度特征）→ degraded + 引擎退避重试 + provider 探针冷却', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => ({
        status: 429,
        ms: 2,
        headers: { 'retry-after': '0' },
        bodyText: 'too many requests',
      })
      const r = await runP1Suite(rt, transport)
      expect(r.upstreamRequests).toBe(2) // 首样本 + 退避重试
      expect(getProbeVerdict(rt, 'acme', 'fp1', 'm')?.state).toBe('degraded')
      expect(probeCooldownUntil(rt, 'acme')).not.toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('transport 抛错（网络失败）→ unreachable', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' })
      }
      await runP1Suite(rt, transport)
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'm')
      expect(v?.state).toBe('unreachable')
      expect(v?.evidence.err).toContain('ECONNREFUSED')
    } finally {
      h.restore()
    }
  })
})

describe('probe-p1 · 三协议拼装', () => {
  it('anthropic/responses/openai 按协议拼路径与回复抽取（与 server.ts probe() 同源 wire）', async () => {
    const h = fakeHome()
    try {
      // anthropic：/v1/messages + content[].text 抽取
      const rtA = mkRt({ acme: providerCfg('anthropic') })
      const seen: Array<{ path?: string; body: string }> = []
      const tA: ProbeTransport = async (req) => {
        seen.push({ path: req.path, body: req.body?.toString('utf8') ?? '' })
        return { status: 200, ms: 1, bodyText: JSON.stringify({ content: [{ type: 'text', text: ` ${P1_CANARY} ` }] }) }
      }
      await runP1Suite(rtA, tA)
      expect(seen[0].path).toBe('/v1/messages')
      expect(JSON.parse(seen[0].body).max_tokens).toBe(16)
      expect(getProbeVerdict(rtA, 'acme', 'fp1', 'm')?.state).toBe('healthy') // trim 后全等

      // responses：/v1/responses + max_output_tokens + output[].content[].text 抽取
      const rtR = mkRt({ acme: providerCfg('responses') })
      const tR: ProbeTransport = async (req) => {
        seen.push({ path: req.path, body: req.body?.toString('utf8') ?? '' })
        return {
          status: 200,
          ms: 1,
          bodyText: JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: P1_CANARY }] }] }),
        }
      }
      await runP1Suite(rtR, tR, targetOf('acme', 'mr', 'fp2'))
      expect(seen[1].path).toBe('/v1/responses')
      expect(JSON.parse(seen[1].body).max_output_tokens).toBe(16)
      expect(getProbeVerdict(rtR, 'acme', 'fp2', 'mr')?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })
})

// 生产 transport 冷却豁免（provider-probe-suite-t4b）：P1/P12 走 makeRelayProbeTransport（真
// forwardToUpstream + 本地 mock 上游，listen(0) 随机端口），上游 401/403 不得在 rt.keyPool
// 打冷却标记——探针探死 key 是观测行为，打了标 15min 内 P2 复审会被 healthy 过滤挡住、真实
// 转发的可用把位被探针单方面削减（任务 4 只豁免了 forced/P2 路径，此处补齐生产面）。换 key
// 重试/透传是既有语义，不动——只豁免「打标」这一个副作用。
describe('probe-p1 · 生产 transport 冷却豁免（t4b）', () => {
  interface Mock {
    url: string
    auths: string[]
    close: () => Promise<void>
  }

  async function startAuthMock(handler?: () => number): Promise<Mock> {
    const auths: string[] = []
    const s = http.createServer((req, res) => {
      auths.push(String(req.headers.authorization ?? ''))
      req.resume()
      req.on('end', () => {
        const status = handler ? handler() : 200
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: status >= 400 ? { message: 'invalid api key' } : undefined }))
      })
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const close = () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()) })
    return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, auths, close }
  }

  const openaiCfg = (url: string, refs: string[]): Record<string, unknown> => ({
    name: 'acme',
    base_url: url,
    protocol: 'openai',
    auth_style: 'bearer',
    key_ref: refs[0],
    ...(refs.length > 1 ? { keys: refs } : {}),
  })

  it('401 → auth-dead 且 rt.keyPool 冷却 Map 零新增；二次探针仍直达上游（未被冷却过滤挡住）', async () => {
    const h = fakeHome()
    const mock = await startAuthMock(() => 401)
    try {
      await setSecret('acme-0', 'sk-PROBE', 'file')
      const rt = mkRt({ acme: openaiCfg(mock.url, ['file:acme-0']) })
      await runP1Suite(rt, makeRelayProbeTransport(rt))
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'm')
      expect(v?.state).toBe('auth-dead')
      expect(v?.evidence.status).toBe(401)
      expect(mock.auths).toEqual(['Bearer sk-PROBE']) // 单 key 池无换 key 重试，401 原样归档
      expect(rt.keyPool.cooldown.size).toBe(0) // 修复前：此把会被打 15min 冷却
      // 冷却零打标的操作面后果：第二次探针不被 keyInCooldown 过滤挡在本地，仍真实到达上游
      await runP1Suite(rt, makeRelayProbeTransport(rt))
      expect(mock.auths).toEqual(['Bearer sk-PROBE', 'Bearer sk-PROBE'])
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('403 同口径：auth-dead 且冷却 Map 零新增', async () => {
    const h = fakeHome()
    const mock = await startAuthMock(() => 403)
    try {
      await setSecret('acme-0', 'sk-PROBE', 'file')
      const rt = mkRt({ acme: openaiCfg(mock.url, ['file:acme-0']) })
      await runP1Suite(rt, makeRelayProbeTransport(rt))
      const v = getProbeVerdict(rt, 'acme', 'fp1', 'm')
      expect(v?.state).toBe('auth-dead')
      expect(v?.evidence.status).toBe(403)
      expect(rt.keyPool.cooldown.size).toBe(0)
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('多 key 池双把皆 401：换 key 重试照走（既有语义不动）、首把与换 key 后两处打标点全部豁免', async () => {
    const h = fakeHome()
    const mock = await startAuthMock(() => 401)
    try {
      await setSecret('acme-0', 'sk-A', 'file')
      await setSecret('acme-1', 'sk-B', 'file')
      const rt = mkRt({ acme: openaiCfg(mock.url, ['file:acme-0', 'file:acme-1']) })
      await runP1Suite(rt, makeRelayProbeTransport(rt))
      expect(mock.auths).toEqual(['Bearer sk-A', 'Bearer sk-B']) // 非 forced 既有换 key 重试未被改动
      expect(rt.keyPool.cooldown.size).toBe(0) // relay.ts 两处 markKeyCooldown 调用点均未打标
    } finally {
      await mock.close()
      h.restore()
    }
  })
})

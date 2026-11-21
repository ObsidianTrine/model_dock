import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { markKeyCooldown } from '../src/gateway/state/keypool.js'
import { makeRelayProbeTransport, probeCooldownUntil, runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport } from '../src/gateway/probe/engine.js'
import { planP2Targets, runP2, runP2Audit } from '../src/gateway/probe/runners/p2.js'
import { P1_CANARY, runP1 } from '../src/gateway/probe/runners/p1.js'
import { getProbeVerdict, keyFingerprint } from '../src/gateway/probe/verdict.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { recordModelOutcome } from '../src/gateway/state/routing.js'
import { setSecret } from '../src/config/secrets.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// P2 钥匙池审计（provider-probe-suite 任务 4）：resolveProviderKeys 逐把解析池 key，每把各跑
// 一次 P1（runP2 与 runP1 同一判定实现），输出逐 key 结论（index+verdict+状态码）。全链走
// makeRelayProbeTransport → forwardToUpstream(forceKeyIndex) → 本地 mock 上游（listen(0)）：
// 逐把直发——冷却过滤/401 换 key 重试/markKeyCooldown 全部绕行，探针运行后 rt.keyPool 冷却
// Map 长度不变（池态零扰动，探针不打冷却）。

function mkRt(providers: Record<string, unknown> = {}): GatewayRuntime {
  return buildRuntime({ providers, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

// 按 bearer key 分行为的 mock 上游：sk-live 回 200 精确回文；sk-dead 回 401；sk-quota 回
// 429+额度特征（isQuotaError 命中 → quota，不触发引擎 429 退避与探针冷却）。逐请求记录
// authorization，可断言「每把 key 恰好直发一次、按池序、互不串把」。
const KEY_BEHAVIOR: Record<string, { status: number; body: string }> = {
  'sk-live': {
    status: 200,
    body: JSON.stringify({ model: 'm', choices: [{ message: { content: P1_CANARY } }], usage: { input_tokens: 3, output_tokens: 1 } }),
  },
  'sk-dead': { status: 401, body: JSON.stringify({ error: { message: 'invalid api key' } }) },
  'sk-quota': { status: 429, body: JSON.stringify({ error: { message: 'AccountQuotaExceeded: insufficient quota' } }) },
}

interface BehaviorMock {
  url: string
  auths: string[]
  models: string[]
  close: () => Promise<void>
}

async function startBehaviorMock(): Promise<BehaviorMock> {
  const auths: string[] = []
  const models: string[] = []
  const s = http.createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '')
    auths.push(auth)
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        models.push(String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown }).model))
      } catch {
        models.push('?')
      }
      const key = auth.replace(/^Bearer\s+/, '')
      const b = KEY_BEHAVIOR[key] ?? { status: 500, body: 'unknown key' }
      res.writeHead(b.status, { 'content-type': 'application/json' })
      res.end(b.body)
    })
  })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const close = () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()) })
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, auths, models, close }
}

async function threeKeyRt(mock: BehaviorMock): Promise<GatewayRuntime> {
  await setSecret('pk-0', 'sk-live', 'file')
  await setSecret('pk-1', 'sk-dead', 'file')
  await setSecret('pk-2', 'sk-quota', 'file')
  return mkRt({
    pk: {
      name: 'pk',
      base_url: mock.url,
      protocol: 'openai',
      auth_style: 'bearer',
      key_ref: 'file:pk-0',
      keys: ['file:pk-0', 'file:pk-1', 'file:pk-2'],
    },
  })
}

const runP2Suite = (rt: GatewayRuntime, transport: ProbeTransport, targets: Awaited<ReturnType<typeof planP2Targets>>) =>
  runProbeSuite(rt, { probeIds: ['p2'], targets, transport, runner: runP2, confirmed: true })

describe('probe-p2 · 逐把审计（3 把 key 池）', () => {
  it('mock 上游分别回 200/401/429-quota：逐 key 结论 healthy/auth-dead/quota 且互不影响', async () => {
    const h = fakeHome()
    const mock = await startBehaviorMock()
    try {
      const rt = await threeKeyRt(mock)
      const targets = await planP2Targets(rt, 'pk', 'm')
      // 逐把展开：index = 配置 refs 原始位置，keyFp = sha256 前 8 位指纹（无明文）
      expect(targets.map((t) => t.keyIndex)).toEqual([0, 1, 2])
      expect(targets.map((t) => t.keyFp)).toEqual([keyFingerprint('sk-live'), keyFingerprint('sk-dead'), keyFingerprint('sk-quota')])
      const r = await runP2Suite(rt, makeRelayProbeTransport(rt), targets)
      expect(r.dispatched).toBe(3)
      expect(r.upstreamRequests).toBe(3)
      // 逐 key 结论互不影响：各自按真实上游行为归档
      const [fp0, fp1, fp2] = targets.map((t) => t.keyFp)
      const v0 = getProbeVerdict(rt, 'pk', fp0!, 'm')
      const v1 = getProbeVerdict(rt, 'pk', fp1!, 'm')
      const v2 = getProbeVerdict(rt, 'pk', fp2!, 'm')
      expect(v0?.state).toBe('healthy')
      expect(v0?.evidence.status).toBe(200)
      expect(v1?.state).toBe('auth-dead')
      expect(v1?.evidence.status).toBe(401)
      expect(v2?.state).toBe('quota')
      expect(v2?.evidence.status).toBe(429)
      // 互不影响的关键证据：每把 key 恰好直发一次、按池序——401 不换 key 重试（换 key 会把
      // 「这把死了」伪装成「那把活着」），429-quota 不触发引擎退避重试
      expect(mock.auths).toEqual(['Bearer sk-live', 'Bearer sk-dead', 'Bearer sk-quota'])
      // 探针不打 key 冷却：401 的 sk-dead 不进冷却，Map 长度不变（恒 0）
      expect(rt.keyPool.cooldown.get('pk')?.size ?? 0).toBe(0)
      // 额度死不是限流：provider 级探针冷却也不触发
      expect(probeCooldownUntil(rt, 'pk')).toBeUndefined()
      // 账本逐把落条目，key_fp 各归其把（探针独立账本，预估按 S 档 200/把）
      const ledger = await readProbeLedger()
      expect(ledger).toHaveLength(3)
      expect(ledger.map((e) => e.key_fp)).toEqual([fp0, fp1, fp2])
      expect(ledger.every((e) => e.probe_id === 'p2' && e.provider === 'pk' && e.estimated_tokens === 200)).toBe(true)
      expect(ledger.map((e) => e.tokens)).toEqual([4, 0, 0])
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('冷却中的 key 仍被逐把审计（forceKeyIndex 绕过冷却过滤），冷却 Map 不被探针顺延/新增', async () => {
    const h = fakeHome()
    const mock = await startBehaviorMock()
    try {
      const rt = await threeKeyRt(mock)
      markKeyCooldown(rt, 'pk', 1) // sk-dead 已被转发路径打入冷却
      const cooldownBefore = rt.keyPool.cooldown.get('pk')!.get(1)
      const targets = await planP2Targets(rt, 'pk', 'm')
      const r = await runP2Suite(rt, makeRelayProbeTransport(rt), targets)
      expect(r.dispatched).toBe(3) // 冷却中的把位不跳过——审计对象恰包括它
      expect(getProbeVerdict(rt, 'pk', targets[1]!.keyFp!, 'm')?.state).toBe('auth-dead') // 探到真实死活
      // 池态零扰动：既有冷却原样（未清除未顺延），无新增把位
      expect(rt.keyPool.cooldown.get('pk')!.size).toBe(1)
      expect(rt.keyPool.cooldown.get('pk')!.get(1)).toBe(cooldownBefore)
      expect(mock.auths).toEqual(['Bearer sk-live', 'Bearer sk-dead', 'Bearer sk-quota'])
    } finally {
      await mock.close()
      h.restore()
    }
  })

  it('runP2Audit 一站式输出逐 key 结论（index+verdict+状态码）', async () => {
    const h = fakeHome()
    const mock = await startBehaviorMock()
    try {
      const rt = await threeKeyRt(mock)
      const audit = await runP2Audit(rt, { providerId: 'pk', model: 'm', transport: makeRelayProbeTransport(rt), confirmed: true })
      expect(audit.run.dispatched).toBe(3)
      expect(audit.keys.map((k) => [k.index, k.verdict, k.status])).toEqual([
        [0, 'healthy', 200],
        [1, 'auth-dead', 401],
        [2, 'quota', 429],
      ])
      // 结论只带指纹，绝无 key 明文
      expect(JSON.stringify(audit.keys)).not.toContain('sk-')
    } finally {
      await mock.close()
      h.restore()
    }
  })
})

describe('probe-p2 · 目标展开与错误面', () => {
  it('池内不可读引用跳过（index 保位）；全部不可读给可操作报错', async () => {
    const h = fakeHome()
    try {
      await setSecret('pg-1', 'sk-good', 'file')
      const rt = mkRt({ pg: { name: 'pg', base_url: 'http://127.0.0.1:1', protocol: 'openai', auth_style: 'bearer', key_ref: 'file:pg-0', keys: ['file:pg-0', 'file:pg-1'] } })
      const targets = await planP2Targets(rt, 'pg', 'm')
      expect(targets.map((t) => t.keyIndex)).toEqual([1]) // file:pg-0 读不到 → 跳过，index 保留原始位

      const empty = mkRt({ pe: { name: 'pe', base_url: 'http://127.0.0.1:1', protocol: 'openai', auth_style: 'bearer', key_ref: 'file:pe-ghost' } })
      await expect(planP2Targets(empty, 'pe', 'm')).rejects.toThrow(/set-key/)
      await expect(planP2Targets(empty, 'no-such', 'm')).rejects.toThrow(/no-such/)
    } finally {
      h.restore()
    }
  })

  it('探针 transport 恒禁 mfGate：熔断中模型按原模型直发、modelAfter 不改写、零熔断计数', async () => {
    const h = fakeHome()
    const mock = await startBehaviorMock()
    try {
      await setSecret('pk-0', 'sk-live', 'file')
      const rt = mkRt({
        pk: {
          name: 'pk',
          base_url: mock.url,
          protocol: 'openai',
          auth_style: 'bearer',
          key_ref: 'file:pk-0',
          model_fallback: { m: 'backup-m' },
        },
      })
      for (let i = 0; i < 3; i++) recordModelOutcome(rt, 'pk', 'm', { ok: false, cls: 'quota' }) // (pk, m) 进熔断
      // 探针 transport 直调（不经引擎）：melted 模型按原模型直发——探测对象就是被点名的模型本身
      const resp = await makeRelayProbeTransport(rt)({ providerId: 'pk', model: 'm' })
      expect(resp.status).toBe(200)
      expect(mock.models[0]).toBe('m') // 原模型直发，未被预改写为 backup-m
      expect(resp.modelAfter).toBe('m') // 无改写：modelAfter = 原模型
      expect(rt.modelFallbackCounts?.size ?? 0).toBe(0) // 不调 recordModelFallback：熔断计数零新增
    } finally {
      await mock.close()
      h.restore()
    }
  })
})

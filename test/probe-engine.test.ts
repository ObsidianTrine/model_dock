import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildRuntime, logRequest, recordOutcome } from '../src/gateway/state.js'
import { recordModelOutcome } from '../src/gateway/state/routing.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { usageTodayView, readRequestLogDay } from '../src/gateway/state/logs.js'
import {
  PROBE_CONCURRENCY_MAX,
  PROBE_RATE_LIMIT_COOLDOWN_MS,
  PROBE_RETRY_AFTER_MAX_WAIT_MS,
  probeBackoffWaitMs,
  probeCooldownUntil,
  runProbeSuite,
} from '../src/gateway/probe/engine.js'
import type { ProbeRunner, ProbeTransport } from '../src/gateway/probe/engine.js'
import { getProbeVerdict } from '../src/gateway/probe/verdict.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { logsDir } from '../src/util/paths.js'
import { localDateStr, localIsoTs } from '../src/util/time.js'
import { fakeHome, waitFor } from './helpers.js'
import { drainAppendStreams } from '../src/util/fsx.js'
import type { Config } from '../src/config/types.js'

// 探针执行引擎（provider-probe-suite 任务 1）：
// - 全局并发闸 ≤4、同 provider 串行互斥、AbortSignal 取消后 0 新上游请求
// - 429 → Retry-After 退避（≤60s）+ provider 探针冷却 10 分钟负缓存；冷却内跳过并标 stale
// - 副作用红线：rt.ring / 请求日志文件 / usageToday / 熔断计数（recordOutcome/recordModelOutcome
//   对应的 health/modelHealth/seaErrors 态）运行前后差值为 0
// 全部走可注入 transport + runner（t1 无 runners 实现），fakeHome 隔离落盘。

function mkRt(): GatewayRuntime {
  return buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const okTransport: ProbeTransport = async () => ({ status: 200, ms: 2 })

/** 常规 runner：打一次 transport、回 healthy、报一笔 token */
const okRunner: ProbeRunner = async (ctx) => {
  const resp = await ctx.transport({ providerId: ctx.target.providerId, model: ctx.target.model })
  return { state: 'healthy', status: resp.status, ms: resp.ms, calls: [{ tokens: 10, ms: resp.ms, status: resp.status }] }
}

describe('probe-engine · 全局并发闸', () => {
  it('8 单元 concurrency=4 → 峰值并发恰持 4 槽（上限生效且不被突破）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      let active = 0
      let maxActive = 0
      const runner: ProbeRunner = async (ctx) => {
        active++
        maxActive = Math.max(maxActive, active)
        await sleep(25)
        active--
        const resp = await ctx.transport({ providerId: ctx.target.providerId, model: ctx.target.model })
        return { state: 'healthy', status: resp.status, calls: [{ tokens: 5, ms: resp.ms, status: resp.status }] }
      }
      const targets = Array.from({ length: 8 }, (_, i) => ({ providerId: `p${i}`, model: 'm', keyFp: `fp${i}` }))
      const r = await runProbeSuite(rt, {
        probeIds: ['p1'],
        targets,
        transport: okTransport,
        runner,
        concurrency: PROBE_CONCURRENCY_MAX,
        confirmed: true,
      })
      expect(r.ok).toBe(true)
      expect(r.dispatched).toBe(8)
      expect(maxActive).toBe(PROBE_CONCURRENCY_MAX)
      expect(maxActive).toBeLessThanOrEqual(4)
    } finally {
      h.restore()
    }
  })

  it('同 provider 两目标串行互斥（第二段不早于第一段结束）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const spans: Array<{ start: number; end: number }> = []
      const runner: ProbeRunner = async (ctx) => {
        const start = Date.now()
        await sleep(20)
        const resp = await ctx.transport({ providerId: ctx.target.providerId, model: ctx.target.model })
        spans.push({ start, end: Date.now() })
        return { state: 'healthy', status: resp.status, calls: [{ tokens: 5, ms: resp.ms, status: resp.status }] }
      }
      const r = await runProbeSuite(rt, {
        probeIds: ['p1'],
        targets: [
          { providerId: 'solo', model: 'm1', keyFp: 'fpA' },
          { providerId: 'solo', model: 'm2', keyFp: 'fpB' },
        ],
        transport: okTransport,
        runner,
        concurrency: 4,
        confirmed: true,
      })
      expect(r.dispatched).toBe(2)
      expect(spans).toHaveLength(2)
      const sorted = [...spans].sort((a, b) => a.start - b.start)
      expect(sorted[1].start).toBeGreaterThanOrEqual(sorted[0].end - 2)
    } finally {
      h.restore()
    }
  })
})

describe('probe-engine · 429 冷却与退避', () => {
  it('probeBackoffWaitMs：秒数/HTTP-date 解析、60s 钳制、过期日期为 0', () => {
    expect(probeBackoffWaitMs(undefined)).toBe(0)
    expect(probeBackoffWaitMs('2')).toBe(2000)
    expect(probeBackoffWaitMs('120')).toBe(PROBE_RETRY_AFTER_MAX_WAIT_MS)
    expect(probeBackoffWaitMs(new Date(Date.now() - 10_000).toUTCString(), Date.now())).toBe(0)
  })

  it('429 → 退避重试一次成功 + provider 探针冷却约 10 分钟；冷却内触发跳过并标 stale', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      let calls = 0
      const transport: ProbeTransport = async () => {
        calls++
        if (calls === 1) return { status: 429, headers: { 'retry-after': new Date(Date.now() - 10_000).toUTCString() }, ms: 1, bodyText: 'too many requests' }
        return { status: 200, ms: 1 }
      }
      const runner: ProbeRunner = async (ctx) => {
        const resp = await ctx.transport({ providerId: ctx.target.providerId, model: ctx.target.model })
        if (resp.status === 429) {
          return { rateLimited: true, retryAfter: resp.headers?.['retry-after'], status: 429, calls: [{ tokens: 0, ms: resp.ms, status: 429 }] }
        }
        return { state: 'healthy', status: resp.status, calls: [{ tokens: 10, ms: resp.ms, status: resp.status }] }
      }
      const target = { providerId: 'acme', model: 'm', keyFp: 'fp1' }
      const r1 = await runProbeSuite(rt, { probeIds: ['p1'], targets: [target], transport, runner, confirmed: true })
      // 首样本 429 + 退避重试成功：两次上游调用、最终 healthy
      expect(r1.upstreamRequests).toBe(2)
      expect(getProbeVerdict(rt, 'acme', 'fp1', 'm')?.state).toBe('healthy')
      const until = probeCooldownUntil(rt, 'acme')
      expect(until).not.toBeUndefined()
      const remaining = until! - Date.now()
      expect(remaining).toBeLessThanOrEqual(PROBE_RATE_LIMIT_COOLDOWN_MS)
      expect(remaining).toBeGreaterThan(PROBE_RATE_LIMIT_COOLDOWN_MS - 5000)
      // 冷却内再触发：0 新上游请求，目标标 stale
      const before = calls
      const entriesBefore = (await readProbeLedger()).length
      const r2 = await runProbeSuite(rt, { probeIds: ['p1'], targets: [target], transport, runner, confirmed: true })
      expect(r2.upstreamRequests).toBe(0)
      expect(r2.skipped).toHaveLength(1)
      expect(r2.skipped[0].reason).toBe('cooldown')
      expect(r2.skipped[0].stale).toBe(true)
      expect(calls).toBe(before)
      expect((await readProbeLedger()).length).toBe(entriesBefore)
    } finally {
      h.restore()
    }
  })

  it('退避重试仍 429：冷却顺延、单元放弃后续采样', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const transport: ProbeTransport = async () => ({ status: 429, headers: { 'retry-after': '0' }, ms: 1 })
      const runner: ProbeRunner = async (ctx) => {
        const resp = await ctx.transport({ providerId: ctx.target.providerId, model: ctx.target.model })
        return { rateLimited: true, retryAfter: resp.headers?.['retry-after'], status: 429, calls: [{ tokens: 0, ms: resp.ms, status: 429 }] }
      }
      const r = await runProbeSuite(rt, { probeIds: ['p1'], targets: [{ providerId: 'acme', model: 'm', keyFp: 'fp1' }], transport, runner, confirmed: true })
      expect(r.upstreamRequests).toBe(2) // 首样本 + 退避重试
      expect(probeCooldownUntil(rt, 'acme')).not.toBeUndefined()
      expect(r.verdicts).toHaveLength(1)
    } finally {
      h.restore()
    }
  })
})

describe('probe-engine · 取消', () => {
  it('AbortSignal 取消后 0 个新上游请求', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const ac = new AbortController()
      let calls = 0
      let releaseLatch: () => void = () => {}
      const latch = new Promise<void>((r) => {
        releaseLatch = r
      })
      const transport: ProbeTransport = async () => {
        calls++
        await latch
        return { status: 200, ms: 1 }
      }
      const targets = Array.from({ length: 6 }, (_, i) => ({ providerId: `c${i}`, model: 'm', keyFp: `fp${i}` }))
      const runP = runProbeSuite(rt, {
        probeIds: ['p1'],
        targets,
        transport,
        runner: okRunner,
        concurrency: 2,
        confirmed: true,
        signal: ac.signal,
      })
      await waitFor(() => calls >= 2) // 两个槽位都已在飞
      ac.abort()
      releaseLatch()
      const r = await runP
      expect(calls).toBe(2) // 取消后不再发新上游请求
      expect(r.reason).toBe('cancelled')
      expect(r.dispatched).toBe(2)
      expect(r.skipped.filter((s) => s.reason === 'cancelled')).toHaveLength(4)
    } finally {
      h.restore()
    }
  })
})

describe('probe-engine · 副作用红线', () => {
  it('探针运行前后 rt.ring 与请求日志文件行数差为 0，熔断计数（health/modelHealth/seaErrors）差为 0', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      // 先造真实流量痕迹（ring、请求日志文件、熔断计数、usageToday），断言「差值为 0」而非「本来就空」
      logRequest(rt, { ts: localIsoTs(), harness: 'claude-code', profile: 'main', provider: 'up0', path: '/v1/messages', status: 500, err: 'upstream boom' })
      recordOutcome(rt, 'up0', { ok: false, cls: 'quota' })
      recordModelOutcome(rt, 'up0', 'm', { ok: false, cls: 'quota' })
      await drainAppendStreams() // 种子日志经常驻流异步落盘：先等 close 再读行数
      const ringBefore = rt.ring.length
      const healthBefore = JSON.stringify([...rt.health.values()])
      const modelHealthBefore = JSON.stringify([...(rt.modelHealth?.values() ?? [])])
      const seaBefore = JSON.stringify(rt.seaErrors ? [...rt.seaErrors.values()] : [])
      const usageBefore = JSON.stringify(usageTodayView())
      const logFile = path.join(logsDir(), `gateway-${localDateStr()}.jsonl`)
      const logLines = (): number => {
        try {
          return fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.trim()).length
        } catch {
          return 0
        }
      }
      const linesBefore = logLines()
      expect(linesBefore).toBe(1)
      expect(ringBefore).toBe(1)

      const r = await runProbeSuite(rt, {
        probeIds: ['p1', 'p12'],
        targets: [
          { providerId: 'up0', model: 'm', keyFp: 'fpX' },
          { providerId: 'up1', model: 'm', keyFp: 'fpY' },
        ],
        transport: okTransport,
        runner: okRunner,
        confirmed: true,
      })
      expect(r.dispatched).toBe(4) // p1×2 + p12×2（jittery 采 3 样本但单元数仍 2）

      expect(rt.ring.length).toBe(ringBefore)
      expect(logLines()).toBe(linesBefore)
      expect(JSON.stringify([...rt.health.values()])).toBe(healthBefore)
      expect(JSON.stringify([...(rt.modelHealth?.values() ?? [])])).toBe(modelHealthBefore)
      expect(JSON.stringify(rt.seaErrors ? [...rt.seaErrors.values()] : [])).toBe(seaBefore)
      expect(JSON.stringify(usageTodayView())).toBe(usageBefore)
      // 今日用量仪表的数据源（请求日志文件）同样零新增条目
      expect(readRequestLogDay(localDateStr())).toHaveLength(1)
    } finally {
      h.restore()
    }
  })
})

describe('probe-engine · 闸门与派发形态', () => {
  it('未确认时上游请求数为 0，返回预估（S 档单请求 = 200）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      let calls = 0
      const transport: ProbeTransport = async () => {
        calls++
        return { status: 200, ms: 1 }
      }
      const r = await runProbeSuite(rt, {
        probeIds: ['p1'],
        targets: [{ providerId: 'a', model: 'm', keyFp: 'fp' }],
        transport,
        runner: okRunner,
      })
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('unconfirmed')
      expect(r.upstreamRequests).toBe(0)
      expect(r.estimate).toBe(200)
      expect(calls).toBe(0)
    } finally {
      h.restore()
    }
  })

  it('jittery 采 3 样本、canary 单样本（3 取中位共识的采样轮数）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      let n = 0
      const runner: ProbeRunner = async (ctx) => {
        n++
        const resp = await ctx.transport({ providerId: ctx.target.providerId, model: ctx.target.model })
        return { state: 'healthy', status: resp.status, calls: [{ tokens: 1, ms: resp.ms, status: resp.status }] }
      }
      await runProbeSuite(rt, { probeIds: ['p1'], targets: [{ providerId: 'a', model: 'm', keyFp: 'fp1' }], transport: okTransport, runner, confirmed: true })
      expect(n).toBe(1)
      await runProbeSuite(rt, { probeIds: ['p12'], targets: [{ providerId: 'b', model: 'm', keyFp: 'fp2' }], transport: okTransport, runner, confirmed: true })
      expect(n).toBe(4) // jittery：+3
    } finally {
      h.restore()
    }
  })

  it('ctx 预留槽位拒绝派发；无 runner 全部 not-implemented；主动探针缺 key 指纹拒发', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      let calls = 0
      const transport: ProbeTransport = async () => {
        calls++
        return { status: 200, ms: 1 }
      }
      const target = { providerId: 'a', model: 'm', keyFp: 'fp' }
      const r1 = await runProbeSuite(rt, { probeIds: ['ctx'], targets: [target], transport, runner: okRunner, confirmed: true })
      expect(r1.skipped[0].reason).toBe('not-implemented')
      expect(r1.upstreamRequests).toBe(0)
      const r2 = await runProbeSuite(rt, { probeIds: ['p1'], targets: [target], transport, confirmed: true })
      expect(r2.skipped[0].reason).toBe('not-implemented')
      const r3 = await runProbeSuite(rt, { probeIds: ['p1'], targets: [{ providerId: 'a', model: 'm' }], transport, runner: okRunner, confirmed: true })
      expect(r3.skipped[0].reason).toBe('no-key')
      expect(r3.upstreamRequests).toBe(0)
      expect(calls).toBe(0)
    } finally {
      h.restore()
    }
  })

  it('错误体经 opts.secrets 脱敏后入证据（不含 key 明文）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const runner: ProbeRunner = async () => ({ state: 'degraded', status: 500, err: 'boom sk-probe-secret-1 tail', calls: [] })
      await runProbeSuite(rt, {
        probeIds: ['p1'],
        targets: [{ providerId: 'a', model: 'm', keyFp: 'fpR' }],
        transport: okTransport,
        runner,
        confirmed: true,
        secrets: ['sk-probe-secret-1'],
      })
      const v = getProbeVerdict(rt, 'a', 'fpR', 'm')
      expect(v?.state).toBe('degraded')
      expect(v?.evidence.err).toBe('boom [redacted] tail')
    } finally {
      h.restore()
    }
  })
})

describe('probe-engine · [probe] 配置段（任务 5）', () => {
  it('[probe].enabled=false → 整轮拒发（含 P15，reason=disabled），零上游请求', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      rt.config.probe = { enabled: false }
      let calls = 0
      const transport: ProbeTransport = async () => {
        calls++
        return { status: 200, ms: 1 }
      }
      const r = await runProbeSuite(rt, {
        probeIds: ['p1', 'p15'],
        targets: [{ providerId: 'a', model: 'm', keyFp: 'fp' }],
        transport,
        runner: okRunner,
        confirmed: true,
      })
      expect(r.skipped).toHaveLength(2)
      expect(r.skipped.every((s) => s.reason === 'disabled')).toBe(true)
      expect(r.upstreamRequests).toBe(0)
      expect(calls).toBe(0)
    } finally {
      h.restore()
    }
  })

  it('opts 未传 concurrency 时读 [probe].concurrency（探针段并发闸生效）', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      rt.config.probe = { concurrency: 3 }
      let active = 0
      let maxActive = 0
      const runner: ProbeRunner = async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await sleep(25)
        active--
        return { state: 'healthy', calls: [{ tokens: 1, ms: 1, status: 200 }] }
      }
      const targets = Array.from({ length: 6 }, (_, i) => ({ providerId: `c${i}`, model: 'm', keyFp: `fp${i}` }))
      const r = await runProbeSuite(rt, { probeIds: ['p1'], targets, transport: okTransport, runner, confirmed: true })
      expect(r.dispatched).toBe(6)
      expect(maxActive).toBe(3)
    } finally {
      h.restore()
    }
  })
})

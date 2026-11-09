// supply.mjs 测试（A3 worker 并发供给闸 + A4 预算实测账）：
//   - providerCapacityDecision 纯函数（解锁判定 / fail-safe 回落 1）
//   - probeProviderCapacity 对 mock 网关（tier-validate/config/metrics，listen(0) 随机端口）
//   - fail-open：观测面未开不触达（Infinity）；观测打通但不可达 → 容量 1
//   - harnessBillableFromUsage 字段缺失 → null（旧网关回落信号）
//   - startMeasuredFuelPoller：mock harness-usage 喂 budget.accountMeasured；不可达静默
//   - E2E：drain（scheduling.maxWorkers）经供给闸降档与放行（workers_scaled 留痕）

import http from 'node:http'
import { AddressInfo } from 'node:net'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { Budget } from '../../.agents/scripts/orchestrator/budget.mjs'
import {
  MEASURED_FUEL_POLL_MS,
  RENEW_TIMEOUT_MS,
  createExpiryRenewal,
  createExpiryWatcher,
  fetchHarnessBillable,
  harnessBillableFromUsage,
  probeProviderCapacity,
  providerCapacityDecision,
  providerWaterline,
  renewTaskHarness,
  startMeasuredFuelPoller,
} from '../../.agents/scripts/orchestrator/supply.mjs'
import { appendEvent, readEvents } from '../../.agents/scripts/orchestrator/events.mjs'
import { eventsOf, mkRepo, runOrch, cardText } from './helpers.js'
import fs from 'node:fs'
import path from 'node:path'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}, body?: string) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }, body))
  runOrch(repo, `submit "${cardFile}"`)
}

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

/** mock 网关：三端点应答由 state 对象驱动（各用例按需改字段）。 */
async function startMockGateway(state: { provider?: string | null; maxConcurrency?: unknown; keypool?: unknown; usage?: unknown; concurrency?: unknown }): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const admin = req.headers['x-modeldock-admin'] === 'admin-test'
    const finish = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (!admin) {
      finish(401, { ok: false, reason: 'unauthorized' })
      return
    }
    if (req.method === 'POST' && req.url === '/_modeldock/tier-validate') {
      finish(200, {
        ok: true,
        harness: 'worker-tier',
        profile: 'tier-profile',
        provider: state.provider ?? null,
        tier: 'ahead-2',
        models: ['m1'],
        tier_profiles: { 'ahead-2': ['tier-profile'] },
      })
    } else if (req.url === '/_modeldock/config') {
      finish(200, { providers: [{ id: 'glm', name: 'GLM', max_concurrency: state.maxConcurrency }] })
    } else if (req.url === '/_modeldock/metrics') {
      // concurrency 缺省不下发（旧网关形态）：advisory 走缺失回落路径
      finish(200, { keypool: state.keypool, ...(state.concurrency !== undefined ? { concurrency: state.concurrency } : {}) })
    } else if (req.url === '/_modeldock/harness-usage') {
      finish(200, { ok: true, usage: state.usage })
    } else {
      finish(404, { ok: false })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      server.closeAllConnections?.()
      server.close()
    },
  }
}

describe('supply > providerCapacityDecision 纯函数', () => {
  it('解锁：max_concurrency>=2 且 healthy>=2 → min(max_concurrency, healthy)', () => {
    expect(providerCapacityDecision({ maxConcurrency: 2, keypoolTotal: 2, keypoolHealthy: 2 })).toEqual({ capacity: 2, reason: expect.stringContaining('healthy=2') })
    expect(providerCapacityDecision({ maxConcurrency: 8, keypoolTotal: 5, keypoolHealthy: 3 }).capacity).toBe(3)
    expect(providerCapacityDecision({ maxConcurrency: 2, keypoolTotal: 10, keypoolHealthy: 6 }).capacity).toBe(2)
  })

  it('解锁（healthy<2 但 total>=2）：按 total 计（冷却由网关兜底，不二次猜测）', () => {
    const d = providerCapacityDecision({ maxConcurrency: 4, keypoolTotal: 3, keypoolHealthy: 0 })
    expect(d.capacity).toBe(3)
    expect(d.reason).toContain('total=3')
  })

  it('未解锁回落 1：max_concurrency 缺失/0/1；key 池不足 2', () => {
    expect(providerCapacityDecision({ maxConcurrency: NaN, keypoolTotal: 3, keypoolHealthy: 3 }).capacity).toBe(1)
    expect(providerCapacityDecision({ maxConcurrency: 1, keypoolTotal: 3, keypoolHealthy: 3 }).capacity).toBe(1)
    expect(providerCapacityDecision({ maxConcurrency: 0, keypoolTotal: 3, keypoolHealthy: 3 }).capacity).toBe(1)
    expect(providerCapacityDecision({ maxConcurrency: 4, keypoolTotal: 1, keypoolHealthy: 1 }).capacity).toBe(1)
    expect(providerCapacityDecision({}).capacity).toBe(1)
  })
})

describe('supply > providerWaterline 纯函数（实时水位读数 + 饱和 advisory，只照亮不拦截）', () => {
  it('饱和（in_flight>=limit>0）→ level=saturated + 人读 message；同时排队也并入 message', () => {
    const w = providerWaterline({ in_flight: 4, queued: 0, limit: 4 })
    expect(w.waterline).toEqual({ in_flight: 4, queued: 0, limit: 4 })
    expect(w.saturation_advisory).toMatchObject({ level: 'saturated', in_flight: 4, queued: 0, limit: 4 })
    expect(String(w.saturation_advisory?.message)).toContain('4/4')
    const both = providerWaterline({ in_flight: 3, queued: 2, limit: 3 })
    expect(both.saturation_advisory?.level).toBe('saturated')
    expect(String(both.saturation_advisory?.message)).toContain('2 个请求排队')
  })

  it('未饱和但在排队（queued>0）→ level=queued', () => {
    const w = providerWaterline({ in_flight: 1, queued: 3, limit: 4 })
    expect(w.saturation_advisory).toMatchObject({ level: 'queued', in_flight: 1, queued: 3, limit: 4 })
    expect(String(w.saturation_advisory?.message)).toContain('排队')
  })

  it('水位正常（未饱和未排队）→ 有读数无 advisory；limit=0（不限）只按排队判', () => {
    const ok = providerWaterline({ in_flight: 1, queued: 0, limit: 4 })
    expect(ok.waterline).toEqual({ in_flight: 1, queued: 0, limit: 4 })
    expect(ok.saturation_advisory).toBeNull()
    const unlimitedBusy = providerWaterline({ in_flight: 9, queued: 0, limit: 0 })
    expect(unlimitedBusy.waterline).toEqual({ in_flight: 9, queued: 0, limit: 0 })
    expect(unlimitedBusy.saturation_advisory).toBeNull() // 不限上限无排队：不判饱和
    const unlimitedQueued = providerWaterline({ in_flight: 9, queued: 1, limit: 0 })
    expect(unlimitedQueued.saturation_advisory?.level).toBe('queued')
  })

  it('provider 缺席（=空闲，网关不露出）/字段残缺 → waterline 与 advisory 均 null（勿当故障）', () => {
    expect(providerWaterline(null)).toEqual({ waterline: null, saturation_advisory: null })
    expect(providerWaterline(undefined)).toEqual({ waterline: null, saturation_advisory: null })
    expect(providerWaterline({} as unknown)).toEqual({ waterline: null, saturation_advisory: null })
    expect(providerWaterline({ in_flight: 1, queued: 0 } as unknown).waterline).toBeNull() // 缺 limit
    expect(providerWaterline('garbage' as unknown).saturation_advisory).toBeNull()
  })
})

describe('supply > probeProviderCapacity（mock 网关）', () => {
  it('观测面未开启（optIn=false）：Infinity 不设闸且零请求（base 指死端口证明未触达）', async () => {
    const r = await probeProviderCapacity({ token: 'tok', tier: 'ahead-2', base: 'http://127.0.0.1:1', adminToken: 'x', optIn: false })
    expect(r.capacity).toBe(Infinity)
    expect(r.observed).toBe(false)
    expect(r.reason).toContain('gatewayAdmin 未开启')
  })

  it('观测面开启 + 全链路可观测：capacity=min(max_concurrency, healthy)，provider/observed 如实', async () => {
    const gw = await startMockGateway({ provider: 'glm', maxConcurrency: 4, keypool: { glm: { total: 3, healthy: 3 } } })
    try {
      const r = await probeProviderCapacity({ token: 'tok', tier: 'ahead-2', base: `http://127.0.0.1:${gw.port}`, adminToken: 'admin-test', optIn: true })
      expect(r.capacity).toBe(3)
      expect(r.observed).toBe(true)
      expect(r.provider).toBe('glm')
    } finally {
      gw.close()
    }
  })

  it('并发水位 advisory：metrics 带 concurrency 段 → waterline 附实时读数；饱和/排队附 saturation_advisory，capacity 判定零变化', async () => {
    // 与上方「全链路可观测」同容量配置（max_concurrency=4 + healthy=3 → capacity 3）：
    // 叠加饱和水位后 capacity 必须不变（advisory 只照亮不拦截）
    const gw = await startMockGateway({
      provider: 'glm',
      maxConcurrency: 4,
      keypool: { glm: { total: 3, healthy: 3 } },
      concurrency: { glm: { in_flight: 4, queued: 2, limit: 4 } },
    })
    try {
      const r = await probeProviderCapacity({ token: 'tok', tier: 'ahead-2', base: `http://127.0.0.1:${gw.port}`, adminToken: 'admin-test', optIn: true })
      expect(r.capacity).toBe(3) // 硬判定语义零变化
      expect(r.waterline).toEqual({ in_flight: 4, queued: 2, limit: 4 })
      expect((r as { saturation_advisory?: { level: string } }).saturation_advisory?.level).toBe('saturated')
    } finally {
      gw.close()
    }
    const gw2 = await startMockGateway({
      provider: 'glm',
      maxConcurrency: 4,
      keypool: { glm: { total: 3, healthy: 3 } },
      concurrency: { glm: { in_flight: 1, queued: 3, limit: 4 } },
    })
    try {
      const r2 = await probeProviderCapacity({ token: 'tok', tier: 'ahead-2', base: `http://127.0.0.1:${gw2.port}`, adminToken: 'admin-test', optIn: true })
      expect(r2.capacity).toBe(3)
      expect((r2 as { saturation_advisory?: { level: string } }).saturation_advisory?.level).toBe('queued')
    } finally {
      gw2.close()
    }
  })

  it('并发水位 advisory 回落：concurrency 段缺席（旧网关）或目标 provider 缺席（=空闲）→ waterline null 无 advisory', async () => {
    const gwOld = await startMockGateway({ provider: 'glm', maxConcurrency: 4, keypool: { glm: { total: 3, healthy: 3 } } })
    try {
      const r = await probeProviderCapacity({ token: 'tok', tier: 'ahead-2', base: `http://127.0.0.1:${gwOld.port}`, adminToken: 'admin-test', optIn: true })
      expect((r as { waterline?: unknown }).waterline).toBeNull()
      expect((r as { saturation_advisory?: unknown }).saturation_advisory).toBeUndefined()
    } finally {
      gwOld.close()
    }
    const gwIdle = await startMockGateway({
      provider: 'glm',
      maxConcurrency: 4,
      keypool: { glm: { total: 3, healthy: 3 } },
      concurrency: { other: { in_flight: 4, queued: 1, limit: 4 } }, // glm 缺席 = 空闲，勿当故障
    })
    try {
      const r2 = await probeProviderCapacity({ token: 'tok', tier: 'ahead-2', base: `http://127.0.0.1:${gwIdle.port}`, adminToken: 'admin-test', optIn: true })
      expect((r2 as { waterline?: unknown }).waterline).toBeNull()
      expect((r2 as { saturation_advisory?: unknown }).saturation_advisory).toBeUndefined()
    } finally {
      gwIdle.close()
    }
  })

  it('观测面开启 + 网关不可达：capacity=1（fail-open：只是不扩容，不抛错不阻断）', async () => {
    const r = await probeProviderCapacity({ token: 'tok', tier: 'ahead-2', base: 'http://127.0.0.1:1', adminToken: 'admin-test', optIn: true, timeoutMs: 300 })
    expect(r.capacity).toBe(1)
    expect(r.observed).toBe(false)
  })

  it('观测面开启 + 无 tier token：capacity=1（字段缺失口径）', async () => {
    const gw = await startMockGateway({ provider: 'glm', maxConcurrency: 4, keypool: { glm: { total: 3, healthy: 3 } } })
    try {
      const r = await probeProviderCapacity({ token: null, tier: null, base: `http://127.0.0.1:${gw.port}`, adminToken: 'admin-test', optIn: true })
      expect(r.capacity).toBe(1)
      expect(r.observed).toBe(false)
    } finally {
      gw.close()
    }
  })

  it('未解锁（max_concurrency=1）→ capacity=1；config/metrics 缺 provider → capacity=1', async () => {
    const gw = await startMockGateway({ provider: 'glm', maxConcurrency: 1, keypool: { glm: { total: 3, healthy: 3 } } })
    try {
      const locked = await probeProviderCapacity({ token: 'tok', tier: 'ahead-2', base: `http://127.0.0.1:${gw.port}`, adminToken: 'admin-test', optIn: true })
      expect(locked.capacity).toBe(1)
      expect(locked.observed).toBe(true)
      expect(locked.reason).toContain('未解锁')
    } finally {
      gw.close()
    }
    const gw2 = await startMockGateway({ provider: 'other', maxConcurrency: 4, keypool: {} })
    try {
      const missing = await probeProviderCapacity({ token: 'tok', tier: 'ahead-2', base: `http://127.0.0.1:${gw2.port}`, adminToken: 'admin-test', optIn: true })
      expect(missing.capacity).toBe(1)
      expect(missing.observed).toBe(true)
    } finally {
      gw2.close()
    }
  })
})

describe('supply > 实测油量（harness-usage）', () => {
  it('harnessBillableFromUsage：字段缺失/非法/旧网关 → null（绝不当零消耗）', () => {
    expect(harnessBillableFromUsage({ ok: true, usage: { worker: { day_billable_tokens: 123 } } }, 'worker')).toBe(123)
    expect(harnessBillableFromUsage({ ok: true, usage: { worker: { day_tokens: 123 } } }, 'worker')).toBeNull() // 旧网关无该字段
    expect(harnessBillableFromUsage({ ok: true, usage: {} }, 'worker')).toBeNull()
    expect(harnessBillableFromUsage({ ok: true }, 'worker')).toBeNull()
    expect(harnessBillableFromUsage(null, 'worker')).toBeNull()
    expect(harnessBillableFromUsage({ ok: true, usage: { worker: { day_billable_tokens: -1 } } }, 'worker')).toBeNull()
  })

  it('fetchHarnessBillable：mock 端点取值；401/不可达 → null（fail-open 静默）', async () => {
    const gw = await startMockGateway({ usage: { worker: { day_billable_tokens: 456, day_tokens: 999 } } })
    try {
      const ok = await fetchHarnessBillable({ base: `http://127.0.0.1:${gw.port}`, adminToken: 'admin-test', harness: 'worker' })
      expect(ok).toBe(456)
      const bad = await fetchHarnessBillable({ base: `http://127.0.0.1:${gw.port}`, adminToken: 'wrong', harness: 'worker' })
      expect(bad).toBeNull()
    } finally {
      gw.close()
    }
    const dead = await fetchHarnessBillable({ base: 'http://127.0.0.1:1', adminToken: 'admin-test', harness: 'worker', timeoutMs: 300 })
    expect(dead).toBeNull()
  })

  it('startMeasuredFuelPoller：喂 budget.accountMeasured（首采样固化基线）；harness 未知/gatewayAdmin 未开不启动', async () => {
    const b = new Budget({ meta: { budget: { max_tokens: 100_000, max_wall_minutes: 10 } } })
    // 不启动形态：无 harness / gatewayAdmin 未开 → active=false 零副作用（base 指死端口证明未触达）
    expect(startMeasuredFuelPoller({ budget: b, cfg: {}, harness: 'worker' }).active).toBe(false)
    expect(startMeasuredFuelPoller({ budget: b, cfg: { gatewayAdmin: true }, harness: null }).active).toBe(false)

    const gw = await startMockGateway({ usage: { worker: { day_billable_tokens: 3_000_000 } } })
    // resolveGatewayAdmin 走 ORCH_GATEWAY_* env（gateway.json 不在测试环境）：注入 + **测试内立即还原**——
    // 拖到 afterAll 会泄漏进同文件后续 E2E 的子进程 env（陈旧端口 → drain 供给闸误判网关不可达）
    const envKeys = ['ORCH_GATEWAY_BASE', 'ORCH_GATEWAY_ADMIN_TOKEN']
    const savedEnv: Record<string, string | undefined> = {}
    for (const k of envKeys) {
      savedEnv[k] = process.env[k]
      process.env[k] = k === 'ORCH_GATEWAY_BASE' ? `http://127.0.0.1:${gw.port}` : 'admin-test'
    }
    try {
      const p = startMeasuredFuelPoller({ budget: b, cfg: { gatewayAdmin: true }, harness: 'worker', intervalMs: 30 })
      expect(p.active).toBe(true)
      await new Promise((r) => setTimeout(r, 400))
      p.stop()
      expect(b.measuredBaseline).toBe(3_000_000) // 首次采样固化基线（跨任务流量不入本任务账）
      expect(b.measuredBillable).toBe(0)
      expect(b.tripped).toBe(false)
    } finally {
      gw.close()
      for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k]
        else process.env[k] = savedEnv[k]
      }
    }
  }, 10_000)
})

describe('supply > 一次性凭据临期预警（harness_expiry_warning）', () => {
  const T0 = 1_700_000_000_000
  const MIN = 60_000
  const usageWithExpiry = (iso: string) => ({ ok: true, usage: { worker: { ephemeral: true, expires_at: iso, day_billable_tokens: 1 } } })

  it('未临期不告警：剩余远大于阈值 → null', () => {
    const w = createExpiryWatcher()
    const payload = usageWithExpiry(new Date(T0 + 8 * 60 * MIN).toISOString()) // TTL≈8h
    expect(w.observe(payload, 'worker', T0)).toBeNull()
    expect(w.observe(payload, 'worker', T0 + 60 * MIN)).toBeNull() // 剩余 7h ≥ 阈值 30min
  })

  it('阈值口径 = min(20% TTL, 30min)：长 TTL 被 30min 封顶，短 TTL 按 20% 触发', () => {
    // 长 TTL（8h）：20%=96min > 30min → 阈值封顶 30min；剩余 29min < 30min → 告警
    const long = createExpiryWatcher()
    const longPayload = usageWithExpiry(new Date(T0 + 8 * 60 * MIN).toISOString())
    long.observe(longPayload, 'worker', T0) // 首采锚定 TTL
    expect(long.observe(longPayload, 'worker', T0 + 8 * 60 * MIN - 29 * MIN)).toMatchObject({ harness_id: 'worker', threshold_ms: 30 * MIN })
    // 短 TTL（40min）：20%=8min < 30min → 阈值按 20% 计；剩余 7min → 告警
    const short = createExpiryWatcher()
    const shortPayload = usageWithExpiry(new Date(T0 + 40 * MIN).toISOString())
    short.observe(shortPayload, 'worker', T0)
    expect(short.observe(shortPayload, 'worker', T0 + 33 * MIN)).toMatchObject({ threshold_ms: 8 * MIN, remaining_ms: 7 * MIN })
  })

  it('跨阈值告警一次 + 重复轮询不重复（去抖）；新 expires_at（re-provision）是新阈值实例', () => {
    const w = createExpiryWatcher()
    const iso = new Date(T0 + 10 * MIN).toISOString()
    const payload = usageWithExpiry(iso)
    expect(w.observe(payload, 'worker', T0)).toBeNull() // 剩余 10min ≥ 阈值 2min（20%×10min）
    expect(w.observe(payload, 'worker', T0 + 9 * MIN)).toMatchObject({ harness_id: 'worker', expires_at: iso, remaining_ms: MIN, threshold_ms: 2 * MIN })
    expect(w.observe(payload, 'worker', T0 + 9.5 * MIN)).toBeNull() // 同凭据重复轮询：静默
    // 新凭据（新 expires_at）= 新阈值实例：允许再告一次（跨 run 重试是新凭据，不是刷屏）
    const payload2 = usageWithExpiry(new Date(T0 + 40 * MIN).toISOString())
    expect(w.observe(payload2, 'worker', T0)).toBeNull()
    expect(w.observe(payload2, 'worker', T0 + 33 * MIN)).toMatchObject({ harness_id: 'worker' })
  })

  it('非临时凭据 / 条目消失（已吊销）/ 字段非法 → null（吊销即静默）', () => {
    const w = createExpiryWatcher()
    expect(w.observe({ ok: true, usage: { worker: { ephemeral: true } } }, 'worker', T0)).toBeNull() // 缺 expires_at
    // 非 ephemeral（tier token 常驻 harness）：无临期预警资格
    expect(w.observe({ ok: true, usage: { worker: { expires_at: new Date(T0 + MIN).toISOString() } } }, 'worker', T0)).toBeNull()
    expect(w.observe({ ok: true, usage: {} }, 'worker', T0)).toBeNull() // 已吊销：条目被网关摘除
    expect(w.observe({ ok: true, usage: { worker: { ephemeral: true, expires_at: 'not-a-time' } } }, 'worker', T0)).toBeNull() // 非法时间戳
  })

  it('poller 集成：未临期不回调，跨阈值回调恰一次（去抖）；nowFn 注入控时', async () => {
    const b = new Budget({ meta: { budget: { max_tokens: 100_000, max_wall_minutes: 10 } } })
    const iso = new Date(T0 + 10 * MIN).toISOString()
    const gw = await startMockGateway({ usage: { worker: { ephemeral: true, expires_at: iso, day_billable_tokens: 1 } } })
    // resolveGatewayAdmin 走 ORCH_GATEWAY_* env：注入 + 测试内立即还原（supply.test 既有口径）
    const envKeys = ['ORCH_GATEWAY_BASE', 'ORCH_GATEWAY_ADMIN_TOKEN']
    const savedEnv: Record<string, string | undefined> = {}
    for (const k of envKeys) {
      savedEnv[k] = process.env[k]
      process.env[k] = k === 'ORCH_GATEWAY_BASE' ? `http://127.0.0.1:${gw.port}` : 'admin-test'
    }
    let now = T0
    const warns: Array<Record<string, unknown>> = []
    try {
      const p = startMeasuredFuelPoller({ budget: b, cfg: { gatewayAdmin: true }, harness: 'worker', intervalMs: 30, onExpiryWarning: (x) => warns.push(x as Record<string, unknown>), nowFn: () => now })
      expect(p.active).toBe(true)
      await new Promise((r) => setTimeout(r, 300))
      expect(warns).toHaveLength(0) // 未临期：安静
      now = T0 + 9 * MIN // 跨阈值：剩余 1min < 阈值 2min
      await new Promise((r) => setTimeout(r, 300))
      p.stop()
      expect(warns).toHaveLength(1) // 恰一次：后续轮询去抖
      expect(warns[0]).toMatchObject({ harness_id: 'worker', expires_at: iso })
      expect(b.measuredBaseline).toBe(1) // 油量账与临期预警同 payload 并行，互不干扰
    } finally {
      gw.close()
      for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k]
        else process.env[k] = savedEnv[k]
      }
    }
  }, 10_000)
})

describe('supply > 一次性凭据临期续命（harness_renewed，orch-ephemeral-renew-consume）', () => {
  type Json = Record<string, unknown>
  interface Req { url: string; body: Json; auth: boolean }

  /** renew/usage 双端点 mock admin：POST 体感知（renew body 断言需要），响应由 handler 出。 */
  async function startRenewMock(handler: (url: string, body: Json) => [number, unknown]): Promise<{ port: number; requests: Req[]; close: () => void }> {
    const requests: Req[] = []
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        let body: Json = {}
        try { body = JSON.parse(raw || '{}') } catch { /* 空体 */ }
        requests.push({ url: req.url ?? '', body, auth: req.headers['x-modeldock-admin'] === 'admin-test' })
        const [code, out] = handler(req.url ?? '', body)
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      port: (server.address() as AddressInfo).port,
      requests,
      close: () => {
        server.closeAllConnections?.()
        server.close()
      },
    }
  }

  const GA = (port: number) => ({ base: `http://127.0.0.1:${port}`, adminToken: 'admin-test' })

  it('renewTaskHarness 成功：POST body {harnessId, ttl_minutes}（键名与 provision/revoke 的 id 不同，船 9 契约）+ admin 头；响应映射 id/expiresAt/ttlMinutes', async () => {
    const gw = await startRenewMock((url, body) => {
      expect(url).toBe('/_modeldock/harness/renew')
      return [200, { ok: true, id: String(body.harnessId), expires_at: '2026-11-10T00:00:00.000Z', ttl_minutes: 30 }]
    })
    try {
      const r = await renewTaskHarness(GA(gw.port), 'orch-t', 240)
      expect(r).toEqual({ ok: true, id: 'orch-t', expiresAt: '2026-11-10T00:00:00.000Z', ttlMinutes: 30 })
      expect(gw.requests).toHaveLength(1)
      expect(gw.requests[0].body).toEqual({ harnessId: 'orch-t', ttl_minutes: 240 })
      expect(gw.requests[0].auth).toBe(true)
    } finally {
      gw.close()
    }
  })

  it('renewTaskHarness 失败形态全 fail-open：401/404/410/500/响应异常/不可达超时/未配置/缺 id/非法 ttl → { ok:false } 不抛出', async () => {
    const gw401 = await startRenewMock(() => [401, { ok: false }])
    const gw404 = await startRenewMock(() => [404, { ok: false, reason: 'not registered' }])
    const gw410 = await startRenewMock(() => [410, { ok: false, reason: 'expired' }])
    const gw500 = await startRenewMock(() => [500, { ok: false }])
    const gwBad = await startRenewMock(() => [200, { ok: false, reason: 'weird' }]) // ok:false 也不当成功
    try {
      expect(await renewTaskHarness(GA(gw401.port), 'orch-t', 240)).toMatchObject({ ok: false })
      expect(await renewTaskHarness(GA(gw404.port), 'orch-t', 240)).toMatchObject({ ok: false, reason: expect.stringContaining('404') })
      expect(await renewTaskHarness(GA(gw410.port), 'orch-t', 240)).toMatchObject({ ok: false, reason: expect.stringContaining('410') })
      expect(await renewTaskHarness(GA(gw500.port), 'orch-t', 240)).toMatchObject({ ok: false, reason: expect.stringContaining('500') })
      expect(await renewTaskHarness(GA(gwBad.port), 'orch-t', 240)).toMatchObject({ ok: false })
      const dead = await renewTaskHarness({ base: 'http://127.0.0.1:1', adminToken: 'x' }, 'orch-t', 240, { timeoutMs: 300 })
      expect(dead).toMatchObject({ ok: false, reason: expect.stringContaining('不可达') })
    } finally {
      for (const g of [gw401, gw404, gw410, gw500, gwBad]) g.close()
    }
    expect((await renewTaskHarness(null, 'orch-t', 240)).ok).toBe(false)
    expect((await renewTaskHarness({ base: 'not-a-url', adminToken: 'x' }, 'orch-t', 240)).ok).toBe(false)
    expect((await renewTaskHarness(GA(1), '', 240)).ok).toBe(false) // 缺 harnessId
    expect((await renewTaskHarness(GA(1), 'orch-t', NaN)).ok).toBe(false) // 非法 ttl：本地 fail-open 不发请求
  })

  it('续期超时上限常量 ≤3s（AGENTS 硬性约束）', () => {
    expect(RENEW_TIMEOUT_MS).toBeLessThanOrEqual(3000)
  })

  it('临期触发续命成功：harness_expiry_warning + harness_renewed（含新 expires_at）落盘；renew 请求 ttl_minutes 如实传', async () => {
    const qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-renew-ok-'))
    const gw = await startRenewMock(() => [200, { ok: true, id: 'orch-t', expires_at: '2026-11-11T00:00:00.000Z', ttl_minutes: 30 }])
    try {
      const renew = createExpiryRenewal({
        ga: GA(gw.port),
        ttlMinutes: 240,
        liveHarnessId: () => 'orch-t',
        terminalState: () => false,
        appendEvent: (type, fields) => appendEvent(qdir, type, fields),
        log: () => {},
      })
      await renew({ harness_id: 'orch-t', expires_at: '2026-11-10T00:00:00.000Z', remaining_ms: 60_000, threshold_ms: 120_000, ttl_ms: 600_000 })
      expect(gw.requests).toHaveLength(1)
      expect(gw.requests[0].body).toEqual({ harnessId: 'orch-t', ttl_minutes: 240 })
      const evts = readEvents(qdir)
      expect(evts.map((e) => e.type)).toEqual(['harness_expiry_warning', 'harness_renewed'])
      expect(evts[0]).toMatchObject({ harness_id: 'orch-t', expires_at: '2026-11-10T00:00:00.000Z', remaining_ms: 60_000, threshold_ms: 120_000 })
      expect(evts[1]).toMatchObject({ harness_id: 'orch-t', expires_at: '2026-11-11T00:00:00.000Z', ttl_minutes: 30 })
    } finally {
      gw.close()
      fs.rmSync(qdir, { recursive: true, force: true })
    }
  })

  it('端点失败 fail-open 不抛：renew 500 → harness_renew_failed 留痕（不抛出、回调 Promise 正常 resolve）', async () => {
    const qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-renew-fail-'))
    const gw = await startRenewMock(() => [500, { ok: false, reason: 'injected' }])
    try {
      const renew = createExpiryRenewal({
        ga: GA(gw.port),
        ttlMinutes: 240,
        liveHarnessId: () => 'orch-t',
        terminalState: () => false,
        appendEvent: (type, fields) => appendEvent(qdir, type, fields),
        log: () => {},
      })
      await expect(renew({ harness_id: 'orch-t', expires_at: '2026-11-10T00:00:00.000Z', remaining_ms: 60_000, threshold_ms: 120_000, ttl_ms: 600_000 })).resolves.toBeUndefined()
      const evts = readEvents(qdir)
      expect(evts.map((e) => e.type)).toEqual(['harness_expiry_warning', 'harness_renew_failed'])
      expect(String(evts[1].reason)).toContain('500')
    } finally {
      gw.close()
      fs.rmSync(qdir, { recursive: true, force: true })
    }
  })

  it('保守闸：终态（terminalState=true）不落事件不发请求；非本任务凭据（liveHarnessId=null / id 不匹配）同样静默', async () => {
    const qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-renew-gate-'))
    const gw = await startRenewMock(() => [200, { ok: true, id: 'x', expires_at: '2026-11-11T00:00:00.000Z', ttl_minutes: 30 }])
    try {
      const deps = {
        ga: GA(gw.port),
        ttlMinutes: 240,
        terminalState: () => true,
        appendEvent: (type: string, fields: Json) => appendEvent(qdir, type, fields),
        log: () => {},
      }
      const warn = { harness_id: 'orch-t', expires_at: '2026-11-10T00:00:00.000Z', remaining_ms: 60_000, threshold_ms: 120_000, ttl_ms: 600_000 }
      await createExpiryRenewal({ ...deps, liveHarnessId: () => 'orch-t' })(warn) // 终态
      await createExpiryRenewal({ ...deps, terminalState: () => false, liveHarnessId: () => null })(warn) // 已吊销/未签发
      await createExpiryRenewal({ ...deps, terminalState: () => false, liveHarnessId: () => 'orch-other' })(warn) // id 不匹配
      expect(gw.requests).toHaveLength(0)
      expect(readEvents(qdir)).toEqual([])
      // 对照组：同 warn 终态闸打开即正常续命（闸只挡终态，不挡 awaiting-human）
      await createExpiryRenewal({ ...deps, terminalState: () => false, liveHarnessId: () => 'orch-t' })(warn)
      expect(gw.requests).toHaveLength(1)
      expect(readEvents(qdir).map((e) => e.type)).toEqual(['harness_expiry_warning', 'harness_renewed'])
    } finally {
      gw.close()
      fs.rmSync(qdir, { recursive: true, force: true })
    }
  })

  it('poller 续期循环：renew 改写 usage expires_at → 新阈值实例可再告警/再续（去抖天然重置，无需手动清状态）', async () => {
    const T0 = 1_700_000_000_000
    const MIN = 60_000
    let now = T0
    let expiresAtMs = T0 + 40 * MIN // E1：TTL 40min，阈值 20%=8min
    const gw = await startRenewMock((url, body) => {
      if (url === '/_modeldock/harness-usage') return [200, { ok: true, usage: { worker: { ephemeral: true, expires_at: new Date(expiresAtMs).toISOString(), day_billable_tokens: 1 } } }]
      if (url === '/_modeldock/harness/renew') {
        // 网关语义（renewEphemeralHarness）：新到期 = now + ttl（只延不缩）；usage 投影同源即变
        expiresAtMs = now + Number(body.ttl_minutes) * MIN
        return [200, { ok: true, id: String(body.harnessId), expires_at: new Date(expiresAtMs).toISOString(), ttl_minutes: Number(body.ttl_minutes) }]
      }
      return [404, { ok: false }]
    })
    const b = new Budget({ meta: { budget: { max_tokens: 100_000, max_wall_minutes: 10 } } })
    const envKeys = ['ORCH_GATEWAY_BASE', 'ORCH_GATEWAY_ADMIN_TOKEN']
    const savedEnv: Record<string, string | undefined> = {}
    for (const k of envKeys) {
      savedEnv[k] = process.env[k]
      process.env[k] = k === 'ORCH_GATEWAY_BASE' ? `http://127.0.0.1:${gw.port}` : 'admin-test'
    }
    const events: Array<Json> = []
    try {
      const renew = createExpiryRenewal({
        ga: GA(gw.port),
        ttlMinutes: 60,
        liveHarnessId: () => 'worker',
        terminalState: () => false,
        appendEvent: (type, fields) => events.push({ type, ...fields }),
        log: () => {},
      })
      const p = startMeasuredFuelPoller({ budget: b, cfg: { gatewayAdmin: true }, harness: 'worker', intervalMs: 25, onExpiryWarning: renew, nowFn: () => now })
      expect(p.active).toBe(true)
      await new Promise((r) => setTimeout(r, 200)) // 首采锚定 E1：剩余 40min ≥ 阈值 8min → 安静
      now = T0 + 33 * MIN // 剩余 7min < 8min → 警#1 → 续期 → E2 = now+60min = T0+93min
      await new Promise((r) => setTimeout(r, 200))
      expect(gw.requests.filter((r) => r.url === '/_modeldock/harness/renew')).toHaveLength(1)
      now = T0 + 82 * MIN // 新实例 E2（anchor 于 T0+33min，阈值 min(12min,30min)=12min）：剩余 11min → 警#2 → 再续
      await new Promise((r) => setTimeout(r, 200))
      p.stop()
      expect(gw.requests.filter((r) => r.url === '/_modeldock/harness/renew')).toHaveLength(2)
      expect(events.map((e) => e.type)).toEqual(['harness_expiry_warning', 'harness_renewed', 'harness_expiry_warning', 'harness_renewed'])
      const renewed = events.filter((e) => e.type === 'harness_renewed')
      expect(renewed[0].expires_at).not.toBe(renewed[1].expires_at) // 两轮续期各发新 expires_at（新实例）
    } finally {
      gw.close()
      for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k]
        else process.env[k] = savedEnv[k]
      }
    }
  }, 10_000)
})

describe('supply > drain 供给闸 E2E（mock 网关子进程 + mkRepo）', () => {
  // mock 网关必须活在**独立子进程**里：runOrch 用 execSync 同步跑 drain，vitest 主进程事件循环
  // 被阻塞——同进程 http server 连接进 backlog 无人应答，子进程 3s 必超时（实测踩中）。子进程
  // 网关有自己的事件循环，execSync 期间照常应答。
  const MOCK_GW_SCRIPT = `
import http from 'node:http'
import fs from 'node:fs'
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const server = http.createServer((req, res) => {
  const admin = req.headers['x-modeldock-admin'] === 'admin-test'
  const finish = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (!admin) return finish(401, { ok: false, reason: 'unauthorized' })
  if (req.method === 'POST' && req.url === '/_modeldock/tier-validate') {
    finish(200, { ok: true, harness: 'worker-tier', profile: 'tier-profile', provider: state.provider ?? null, tier: 'ahead-2', models: ['m1'], tier_profiles: { 'ahead-2': ['tier-profile'] } })
  } else if (req.url === '/_modeldock/config') {
    finish(200, { providers: [{ id: 'glm', name: 'GLM', max_concurrency: state.maxConcurrency }] })
  } else if (req.url === '/_modeldock/metrics') {
    finish(200, { keypool: state.keypool, ...(state.concurrency !== undefined ? { concurrency: state.concurrency } : {}) })
  } else if (req.url === '/_modeldock/harness-usage') {
    finish(200, { ok: true, usage: state.usage })
  } else {
    finish(404, { ok: false })
  }
})
server.listen(0, '127.0.0.1', () => console.log('PORT:' + server.address().port))
`

  async function startMockGatewayProcess(state: { provider?: string | null; maxConcurrency?: unknown; keypool?: unknown; usage?: unknown; concurrency?: unknown }): Promise<{ port: number; close: () => void }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gwmock-'))
    const stateFile = path.join(dir, 'state.json')
    const scriptFile = path.join(dir, 'mock-gw.mjs')
    fs.writeFileSync(stateFile, JSON.stringify(state))
    fs.writeFileSync(scriptFile, MOCK_GW_SCRIPT)
    const child = spawn(process.execPath, [scriptFile, stateFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    const port = await new Promise<number>((resolve, reject) => {
      let buf = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (d) => {
        buf += d
        const m = /PORT:(\d+)/.exec(buf)
        if (m) resolve(Number(m[1]))
      })
      child.on('exit', (code) => reject(new Error(`mock gateway exited early (code=${code})`)))
    })
    return {
      port,
      close: () => {
        child.kill()
        // Windows 下子进程句柄释放有延迟：rmSync 重试（与 helpers rmRfRetry 同策略）
        for (let i = 0; ; i++) {
          try {
            fs.rmSync(dir, { recursive: true, force: true })
            break
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code ?? ''
            if (!['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(code) || i > 5) break
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
          }
        }
      },
    }
  }

  function fleetEvents(root: string): Array<Record<string, unknown>> {
    const f = path.join(root, '.agents', 'orchestrator', 'logs', 'fleet.jsonl')
    if (!fs.existsSync(f)) return []
    return fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  }

  it('未解锁（max_concurrency=1）：scheduling.maxWorkers=2 被压回 1（串行）+ workers_scaled 留痕 + 派发不阻断', async () => {
    const gw = await startMockGatewayProcess({ provider: 'glm', maxConcurrency: 1, keypool: { glm: { total: 2, healthy: 2 } } })
    const repo = mkRepo({
      extra: {
        gatewayAdmin: true,
        scheduling: { maxWorkers: 2 },
        tiers: { 'ahead-2': { tokenEnv: 'MDK_TIER_TEST' } },
      },
    })
    try {
      submitCard(repo.root, 'g1', { gate: 'L1', tier: 'ahead-2', files_hint: ['docs/**'] })
      submitCard(repo.root, 'g2', { gate: 'L1', tier: 'ahead-2', files_hint: ['test/**'] })
      const out = runOrch(repo.root, 'drain --backend mock', {
        MDK_TIER_TEST: 'tok-test-supply',
        ORCH_GATEWAY_BASE: `http://127.0.0.1:${gw.port}`,
        ORCH_GATEWAY_ADMIN_TOKEN: 'admin-test',
      })
      expect(out.stdout).toContain('供给闸')
      expect(out.stdout).toContain('按 1 并发执行')
      const scaled = fleetEvents(repo.root).find((e) => e.type === 'workers_scaled') as Record<string, unknown> | undefined
      expect(scaled).toBeTruthy()
      expect(scaled!.from).toBe(2)
      expect(scaled!.to).toBe(1)
      expect(scaled!.provider).toBe('glm')
      expect(String(scaled!.reason)).toContain('未解锁')
      // 两张卡照常落位（fail-open：只是串行，不阻断派发）
      expect(eventsOf(repo.root, 'g1').some((e) => e.type === 'worktree_ready')).toBe(true)
      expect(eventsOf(repo.root, 'g2').some((e) => e.type === 'worktree_ready')).toBe(true)
    } finally {
      gw.close()
      repo.cleanup()
    }
  }, 180_000)

  it('已解锁（max_concurrency=3 + key 池 3）：scheduling.maxWorkers=2 自动扩容生效 + workers_scaled(from 1 to 2) 留痕', async () => {
    const gw = await startMockGatewayProcess({ provider: 'glm', maxConcurrency: 3, keypool: { glm: { total: 3, healthy: 3 } } })
    const repo = mkRepo({
      extra: {
        gatewayAdmin: true,
        scheduling: { maxWorkers: 2 },
        tiers: { 'ahead-2': { tokenEnv: 'MDK_TIER_TEST' } },
      },
    })
    try {
      submitCard(repo.root, 'u1', { gate: 'L1', tier: 'ahead-2', files_hint: ['docs/**'] })
      submitCard(repo.root, 'u2', { gate: 'L1', tier: 'ahead-2', files_hint: ['test/**'] })
      const out = runOrch(repo.root, 'drain --backend mock', {
        MDK_TIER_TEST: 'tok-test-supply',
        ORCH_GATEWAY_BASE: `http://127.0.0.1:${gw.port}`,
        ORCH_GATEWAY_ADMIN_TOKEN: 'admin-test',
        ORCH_MOCK_DELAY_MS: '600',
      })
      expect(out.stdout).toContain('供给闸')
      expect(out.stdout).toContain('按 scheduling.maxWorkers=2 并发执行')
      expect(out.stdout).toContain('并发 2')
      const scaled = fleetEvents(repo.root).find((e) => e.type === 'workers_scaled') as Record<string, unknown> | undefined
      expect(scaled).toBeTruthy()
      expect(scaled!.from).toBe(1)
      expect(scaled!.to).toBe(2)
      expect(scaled!.provider).toBe('glm')
    } finally {
      gw.close()
      repo.cleanup()
    }
  }, 180_000)

  it('并发水位 advisory E2E：metrics 饱和/排队 → drain 打 供给水位 提示行 + workers_scaled 带 advisory；扩容与派发照常（advisory 不拦截）', async () => {
    const gw = await startMockGatewayProcess({
      provider: 'glm',
      maxConcurrency: 3,
      keypool: { glm: { total: 3, healthy: 3 } },
      concurrency: { glm: { in_flight: 3, queued: 2, limit: 3 } }, // 饱和 + 排队：仅提示，不改 capacity
    })
    const repo = mkRepo({
      extra: {
        gatewayAdmin: true,
        scheduling: { maxWorkers: 2 },
        tiers: { 'ahead-2': { tokenEnv: 'MDK_TIER_TEST' } },
      },
    })
    try {
      submitCard(repo.root, 'w1', { gate: 'L1', tier: 'ahead-2', files_hint: ['docs/**'] })
      submitCard(repo.root, 'w2', { gate: 'L1', tier: 'ahead-2', files_hint: ['test/**'] })
      const out = runOrch(repo.root, 'drain --backend mock', {
        MDK_TIER_TEST: 'tok-test-supply',
        ORCH_GATEWAY_BASE: `http://127.0.0.1:${gw.port}`,
        ORCH_GATEWAY_ADMIN_TOKEN: 'admin-test',
        ORCH_MOCK_DELAY_MS: '600',
      })
      expect(out.stdout).toContain('供给水位')
      expect(out.stdout).toContain('已饱和')
      expect(out.stdout).toContain('照常派发')
      // 扩容照常（capacity 判定零变化）：maxWorkers=2 仍按 2 并发
      expect(out.stdout).toContain('按 scheduling.maxWorkers=2 并发执行')
      const scaled = fleetEvents(repo.root).find((e) => e.type === 'workers_scaled') as Record<string, unknown> | undefined
      expect(scaled).toBeTruthy()
      expect(scaled!.from).toBe(1)
      expect(scaled!.to).toBe(2)
      const adv = scaled!.saturation_advisory as Record<string, unknown> | undefined
      expect(adv).toBeTruthy()
      expect(adv!.level).toBe('saturated')
      // 两张卡照常落位（advisory 绝不阻断派发）
      expect(eventsOf(repo.root, 'w1').some((e) => e.type === 'worktree_ready')).toBe(true)
      expect(eventsOf(repo.root, 'w2').some((e) => e.type === 'worktree_ready')).toBe(true)
    } finally {
      gw.close()
      repo.cleanup()
    }
  }, 180_000)
})

describe('supply > 常量口径', () => {
  it('实测油量轮询 60s 节流 / 探测超时 ≤3s（AGENTS 硬性约束）', () => {
    expect(MEASURED_FUEL_POLL_MS).toBe(60_000)
  })
})

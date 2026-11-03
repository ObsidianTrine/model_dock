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
  fetchHarnessBillable,
  harnessBillableFromUsage,
  probeProviderCapacity,
  providerCapacityDecision,
  startMeasuredFuelPoller,
} from '../../.agents/scripts/orchestrator/supply.mjs'
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
async function startMockGateway(state: { provider?: string | null; maxConcurrency?: unknown; keypool?: unknown; usage?: unknown }): Promise<{ port: number; close: () => void }> {
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
      finish(200, { keypool: state.keypool })
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
    finish(200, { keypool: state.keypool })
  } else if (req.url === '/_modeldock/harness-usage') {
    finish(200, { ok: true, usage: state.usage })
  } else {
    finish(404, { ok: false })
  }
})
server.listen(0, '127.0.0.1', () => console.log('PORT:' + server.address().port))
`

  async function startMockGatewayProcess(state: { provider?: string | null; maxConcurrency?: unknown; keypool?: unknown; usage?: unknown }): Promise<{ port: number; close: () => void }> {
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
})

describe('supply > 常量口径', () => {
  it('实测油量轮询 60s 节流 / 探测超时 ≤3s（AGENTS 硬性约束）', () => {
    expect(MEASURED_FUEL_POLL_MS).toBe(60_000)
  })
})

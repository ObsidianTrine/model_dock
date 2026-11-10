// 海况数据面（A1，2026-11-04）测试：/_modeldock/metrics 消费——快照提取、节流缓存、
// fetchSeaSnapshot（gatewayAdmin 门控）、countUpstreamStorm 同步桥（gwDir 同目录
// gateway.json 信任域 + /usage 聚合中间层 + 日志扫描回落）+ drain 级 E2E（metrics 风暴 → 滞留派发）。
// 网关 mock 两种形态（fleet.test.ts 同款原则，绝不触达 8687/8890）：
//   - 进程内 listen(0)：异步取数路径（fetchSeaSnapshot）——测试进程事件循环空闲可应答；
//     base 一律经 ORCH_GATEWAY_BASE env 显式注入，杜绝 discoverGatewayState 摸到真实网关。
//   - 子进程 serve：同步桥（spawnSync 阻塞事件循环）与 runOrch（execSync 阻塞）场景——
//     服务器必须独立进程，否则阻塞期间无法应答（实测 3s 超时假死）。

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import { fakeHome } from '../helpers.js'
import { cardText, eventsOf, mkRepo, readCard, runOrch } from './helpers.js'
import {
  countUpstreamStorm,
  fetchSeaSnapshot,
  readFleetEvents,
  resetSeaSnapshotCache,
  seaSnapshotFromMetricsJson,
} from '../../.agents/scripts/orchestrator/weather.mjs'
import { gatewayLogsDir } from '../../.agents/scripts/orchestrator/reconcile.mjs'
import { toIsoLocal } from '../../.agents/scripts/orchestrator/events.mjs'

beforeEach(() => resetSeaSnapshotCache())
afterAll(() => resetSeaSnapshotCache())

/** ORCH_GATEWAY_BASE/ADMIN_TOKEN env 显式指向 mock（保存现场，finally 恢复）。 */
function setGatewayEnv(url: string, token = 'mock-admin') {
  process.env.ORCH_GATEWAY_BASE = url
  process.env.ORCH_GATEWAY_ADMIN_TOKEN = token
}
function clearGatewayEnv() {
  delete process.env.ORCH_GATEWAY_BASE
  delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
}

/** 进程内 admin mock（只伺服 /_modeldock/metrics），带请求计数。 */
function mockMetrics({ payload, status = 200 }: { payload?: unknown; status?: number } = {}) {
  let hits = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url !== '/_modeldock/metrics') {
        res.writeHead(404)
        res.end('{}')
        return
      }
      hits += 1
      if (req.headers['x-modeldock-admin'] !== 'mock-admin') {
        res.writeHead(401)
        res.end('{}')
        return
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload ?? {}))
    })
  })
  return new Promise<{ url: string; hits: () => number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        hits: () => hits,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

/**
 * 独立子进程 admin mock：伺服多端点（payloads: { "GET /_modeldock/metrics": {...}, ... }）。
 * 子进程把实际端口写到 report 文件（listen(0)），测试轮询该文件后使用；收尾 kill。
 * 用于 spawnSync / execSync 阻塞测试进程事件循环的场景。
 */
async function spawnAdminMock(payloads: Record<string, unknown>): Promise<{ port: number; close: () => void }> {
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sea-mock-')), 'port.txt')
  const child = spawn(process.execPath, ['-e', MOCK_SERVER_SCRIPT], {
    env: { ...process.env, MOCK_ADMIN_PAYLOADS: JSON.stringify(payloads), MOCK_ADMIN_REPORT: report },
    stdio: 'ignore',
  })
  const t0 = Date.now()
  for (;;) {
    if (fs.existsSync(report)) break
    if (Date.now() - t0 > 10_000) {
      child.kill()
      throw new Error('mock admin 子进程 10s 未就绪')
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  const port = Number(fs.readFileSync(report, 'utf8').trim())
  return {
    port,
    close: () => {
      child.kill()
      try {
        fs.rmSync(path.dirname(report), { recursive: true, force: true })
      } catch { /* 清理失败无害 */ }
    },
  }
}

const MOCK_SERVER_SCRIPT = `
const http = require('node:http');
const fs = require('node:fs');
const payloads = JSON.parse(process.env.MOCK_ADMIN_PAYLOADS || '{}');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.headers['x-modeldock-admin'] !== 'mock-admin') { res.writeHead(401); res.end('{}'); return; }
    const p = payloads[req.method + ' ' + req.url.split('?')[0]];
    if (p === undefined) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(p));
  });
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.MOCK_ADMIN_REPORT, String(server.address().port));
});
`;

const METRICS_PAYLOAD = {
  event_loop_lag_ms: 1.2,
  providers: {
    'prov-a': { count: 10, last_ms: 120, p50: 100, p95: 300, p99: 500, errors: { last_5m: { total: 20, connect: 1, '429': 6, '5xx': 0, quota: 1, error_rate: 0.4 }, last_60m: { total: 90, connect: 2, '429': 7, '5xx': 1, quota: 2, error_rate: 0.13 } } },
    'prov-b': { errors: { last_5m: { total: 10, connect: 0, '429': 0, '5xx': 0, quota: 0, error_rate: 0 }, last_60m: { total: 30, connect: 0, '429': 1, '5xx': 0, quota: 0, error_rate: 0.03 } } },
  },
  meltdown: [{ provider: 'prov-a', class: '429', until: '2026-11-04T12:00:00.000Z', remaining_ms: 60_000 }],
  sea_state: { storm: true, reasons: ['meltdown_majority', 'rate_429_60m'], meltdown_count: 1, updated_at: '2026-11-04T11:00:00.000Z' },
  keypool: {},
}

describe('weather > 海况快照提取（seaSnapshotFromMetricsJson）', () => {
  it('提取 sea_state / meltdown / 5m+60m 分桶计数与 429 率；多 provider 求和', () => {
    const s = seaSnapshotFromMetricsJson(METRICS_PAYLOAD, 1_000)
    expect(s).toMatchObject({
      mode: 'ok',
      at: 1_000,
      storm: true,
      reasons: ['meltdown_majority', 'rate_429_60m'],
      meltdownCount: 1,
      meltdown: ['prov-a'],
      total5m: 30,
      count429_5m: 6,
      countQuota_5m: 1,
      count429_60m: 8, // 7 + 1
      countQuota_60m: 2,
    })
    expect(s.rate429_5m).toBeCloseTo(6 / 30, 6) // Σ429(5m)=6 / Σtotal(5m)=30
  })

  it('容错：空对象/缺 sea_state/缺分桶 → mode ok 全零，不抛（旧版网关兼容）', () => {
    const s = seaSnapshotFromMetricsJson({}, 2_000)
    expect(s).toMatchObject({ mode: 'ok', storm: false, reasons: [], meltdown: [], meltdownCount: 0, total5m: 0, count429_60m: 0 })
    const s2 = seaSnapshotFromMetricsJson({ providers: { p: { count: 3 } } }, 2_000) // 只有耗时无分桶
    expect(s2).toMatchObject({ count429_5m: 0, count429_60m: 0 })
  })
})

describe('weather > 并发水位 advisory（2026-11 concurrency signal，纯增量只照亮不拦截）', () => {
  it('seaSnapshotFromMetricsJson：concurrency 段 → queued_providers 计数 + max_in_flight_ratio（limit=0 不进分母；全空 → ratio null）', () => {
    const s = seaSnapshotFromMetricsJson({
      concurrency: {
        busy: { in_flight: 4, queued: 2, limit: 4 },
        partial: { in_flight: 1, queued: 0, limit: 4 },
        unlimited: { in_flight: 9, queued: 1, limit: 0 }, // 不限上限：不进占比分母，但计排队
        idle: { in_flight: 0, queued: 0, limit: 3 }, // 缺席=空闲口径：不排队不拉占比
      },
    }, 1_000)
    expect(s.concurrency).toEqual({ queued_providers: 2, max_in_flight_ratio: 1 })
    const s2 = seaSnapshotFromMetricsJson({ concurrency: { a: { in_flight: 0, queued: 0, limit: 0 } } }, 1_000)
    expect(s2.concurrency).toEqual({ queued_providers: 0, max_in_flight_ratio: null })
  })

  it('seaSnapshotFromMetricsJson：缺 concurrency 段/形态异常 → advisory null（旧网关按缺失处理，不抛）', () => {
    expect(seaSnapshotFromMetricsJson({}, 2_000).concurrency).toBeNull()
    expect(seaSnapshotFromMetricsJson({ concurrency: [] }, 2_000).concurrency).toBeNull() // 数组形态视同缺失
    expect(seaSnapshotFromMetricsJson({ concurrency: { a: 'garbage' } }, 2_000).concurrency).toEqual({ queued_providers: 0, max_in_flight_ratio: null })
  })

  it('fetchSeaSnapshot：metrics 带 concurrency 段 → 快照 advisory 正确；storm 等既有位不受影响', async () => {
    const m = await mockMetrics({
      payload: {
        ...METRICS_PAYLOAD,
        concurrency: { 'prov-a': { in_flight: 2, queued: 3, limit: 8 }, 'prov-b': { in_flight: 0, queued: 0, limit: 0 } },
      },
    })
    setGatewayEnv(m.url)
    try {
      const snap = await fetchSeaSnapshot({ gatewayAdmin: true }, { now: 1_000, timeoutMs: 2000 })
      expect(snap.mode).toBe('ok')
      expect((snap as { storm: boolean }).storm).toBe(true) // 权威风暴位照旧（advisory 零依赖）
      expect((snap as { concurrency: unknown }).concurrency).toEqual({ queued_providers: 1, max_in_flight_ratio: 0.25 })
    } finally {
      clearGatewayEnv()
      await m.close()
    }
  })

  it('fetchSeaSnapshot：metrics 缺 concurrency 段（旧网关）→ 快照 advisory null，其余字段照常', async () => {
    const m = await mockMetrics({ payload: METRICS_PAYLOAD }) // METRICS_PAYLOAD 无 concurrency
    setGatewayEnv(m.url)
    try {
      const snap = await fetchSeaSnapshot({ gatewayAdmin: true }, { now: 1_000, timeoutMs: 2000 })
      expect(snap.mode).toBe('ok')
      expect((snap as { concurrency: unknown }).concurrency).toBeNull()
    } finally {
      clearGatewayEnv()
      await m.close()
    }
  })
})

describe('weather > fetchSeaSnapshot（async，gatewayAdmin 门控 + 节流缓存）', () => {
  it('ok 快照 + 5min 节流（第二次调用零新增请求）；负缓存（非 200）同样节流', async () => {
    const m = await mockMetrics({ payload: METRICS_PAYLOAD })
    setGatewayEnv(m.url)
    try {
      const cfg = { gatewayAdmin: true }
      const first = await fetchSeaSnapshot(cfg, { now: 1_000, timeoutMs: 2000 })
      expect(first.mode).toBe('ok')
      expect((first as { storm: boolean }).storm).toBe(true)
      // TTL 内命中缓存：不发新请求
      const second = await fetchSeaSnapshot(cfg, { now: 1_000 + 60_000, timeoutMs: 2000 })
      expect(second.mode).toBe('ok')
      expect(m.hits()).toBe(1)
      // 非 200 → unavailable，负缓存 60s 内也不重发
      const m2 = await mockMetrics({ status: 500 })
      try {
        setGatewayEnv(m2.url)
        const bad1 = await fetchSeaSnapshot(cfg, { now: 10_000, timeoutMs: 2000 })
        expect(bad1.mode).toBe('unavailable')
        const bad2 = await fetchSeaSnapshot(cfg, { now: 10_000 + 30_000, timeoutMs: 2000 })
        expect(bad2.mode).toBe('unavailable')
        expect(m2.hits()).toBe(1)
        // 负缓存滑过 → 重新探测
        await fetchSeaSnapshot(cfg, { now: 10_000 + 120_000, timeoutMs: 2000 })
        expect(m2.hits()).toBe(2)
      } finally {
        await m2.close()
      }
    } finally {
      clearGatewayEnv()
      await m.close()
    }
  })

  it('gatewayAdmin 未开 → unavailable 零请求（可移植工具链不默认读 ModelDock 状态，真实网关零触达）', async () => {
    const m = await mockMetrics({ payload: METRICS_PAYLOAD })
    setGatewayEnv(m.url)
    try {
      const r = await fetchSeaSnapshot({ gatewayAdmin: false }, { timeoutMs: 2000 })
      expect(r.mode).toBe('unavailable')
      expect(m.hits()).toBe(0)
    } finally {
      clearGatewayEnv()
      await m.close()
    }
  })
})

describe('weather > countUpstreamStorm 同步桥（gwDir 同目录 gateway.json 信任域）', () => {
  /** 建一个假 .modeldock 布局：<root>/.modeldock/{logs, gateway.json}。 */
  function mkModeldock(root: string, gatewayJson?: object) {
    const logs = path.join(root, '.modeldock', 'logs')
    fs.mkdirSync(logs, { recursive: true })
    if (gatewayJson !== undefined) fs.writeFileSync(path.join(root, '.modeldock', 'gateway.json'), JSON.stringify(gatewayJson))
    return logs
  }

  function writeGwEntry(logs: string, ageMs: number, status: number) {
    const ts = toIsoLocal(new Date(Date.now() - ageMs))
    fs.appendFileSync(path.join(logs, `gateway-${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ts, harness: 'zcode', profile: 'p', provider: 'up', path: '/v1/messages', status }) + '\n')
  }

  it('gateway.json 可发现 → metrics 计数（60m 429+quota 求和，windowMs 不作用于 metrics 模式）', async () => {
    const m = await spawnAdminMock({ 'GET /_modeldock/metrics': METRICS_PAYLOAD })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sea-bridge-'))
    try {
      const logs = mkModeldock(root, { port: m.port, admin_token: 'mock-admin' })
      writeGwEntry(logs, 0, 429) // 日志里另有 1 条：metrics 可得时不应被计入
      const n = countUpstreamStorm(logs, { windowMs: 15 * 60_000 })
      expect(n).toBe(10) // count429_60m(8) + countQuota_60m(2)
    } finally {
      m.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('gateway.json 指向死端口 → 同步桥失败落回日志扫描（fail-open）；负缓存生效不重复撞超时', async () => {
    const deadPort = 1 // 保留端口，连不上
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sea-dead-'))
    try {
      const logs = mkModeldock(root, { port: deadPort, admin_token: 'x' })
      writeGwEntry(logs, 0, 429)
      writeGwEntry(logs, 60_000, 402)
      const t0 = Date.now()
      expect(countUpstreamStorm(logs, { windowMs: 15 * 60_000 })).toBe(2)
      expect(Date.now() - t0).toBeLessThan(10_000) // 失败路径不吃满超时
      expect(countUpstreamStorm(logs, { windowMs: 15 * 60_000 })).toBe(2) // 负缓存内第二次：仍日志计数
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('无 gateway.json → 原日志扫描（行为与历史版本一致）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sea-plain-'))
    try {
      const logs = mkModeldock(root) // 只建日志目录
      writeGwEntry(logs, 0, 429)
      writeGwEntry(logs, 20 * 60_000, 429) // 15 分钟窗外
      expect(countUpstreamStorm(logs, { windowMs: 15 * 60_000 })).toBe(1)
      expect(countUpstreamStorm(null, { windowMs: 15 * 60_000 })).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('weather > countUpstreamStorm /usage 聚合中间层（A3：metrics 不可得时的次优数据面）', () => {
  function mkModeldock(root: string, gatewayJson?: object) {
    const logs = path.join(root, '.modeldock', 'logs')
    fs.mkdirSync(logs, { recursive: true })
    if (gatewayJson !== undefined) fs.writeFileSync(path.join(root, '.modeldock', 'gateway.json'), JSON.stringify(gatewayJson))
    return logs
  }

  function writeGwEntry(logs: string, ageMs: number, status: number) {
    const ts = toIsoLocal(new Date(Date.now() - ageMs))
    fs.appendFileSync(path.join(logs, `gateway-${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ts, harness: 'zcode', profile: 'p', provider: 'up', path: '/v1/messages', status }) + '\n')
  }

  it('metrics 不可得（404）→ by_status 计数（429+402，键口径可精确区分；文件里的条目不再计入）', async () => {
    // mock 只伺服 /_modeldock/usage：metrics 键缺席 → 404 → seaSnapshotSync 落空 → usage 桥
    const m = await spawnAdminMock({ 'GET /_modeldock/usage': { ok: true, usage: { requests: 6, ok: 1, failed: 5, by_status: { '429': 3, '402': 1, '500': 1, 'n/a': 2 } } } })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sea-usage-'))
    try {
      const logs = mkModeldock(root, { port: m.port, admin_token: 'mock-admin' })
      writeGwEntry(logs, 0, 429) // 文件里的风暴信号：端点可得时不应被计入
      writeGwEntry(logs, 60_000, 402)
      expect(countUpstreamStorm(logs, { windowMs: 15 * 60_000 })).toBe(4) // by_status 429×3 + 402×1
    } finally {
      m.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('端点答 0（窗口内无风暴）→ 恒 0：端点优先于文件扫描（file 直读只剩兜底地位）', async () => {
    const m = await spawnAdminMock({ 'GET /_modeldock/usage': { ok: true, usage: { requests: 1, ok: 1, failed: 0, by_status: {} } } })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sea-usage-zero-'))
    try {
      const logs = mkModeldock(root, { port: m.port, admin_token: 'mock-admin' })
      writeGwEntry(logs, 0, 429) // 文件里有 429，但端点（网关权威聚合）说没有
      expect(countUpstreamStorm(logs, { windowMs: 15 * 60_000 })).toBe(0)
    } finally {
      m.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('weather > drain E2E（metrics 风暴 → 滞留派发，日志扫描为回落）', () => {
  it('网关 sea_state 风暴 + 60m 429 达阈 → drain 停止派发，weather_hold 事件带 metrics 计数', async () => {
    const m = await spawnAdminMock({ 'GET /_modeldock/metrics': METRICS_PAYLOAD })
    const h = fakeHome()
    try {
      // gateway.json 落在 fakeHome/.modeldock/（同步桥信任域），网关日志目录同壳
      fs.mkdirSync(path.join(h.home, '.modeldock'), { recursive: true })
      fs.writeFileSync(path.join(h.home, '.modeldock', 'gateway.json'), JSON.stringify({ port: m.port, admin_token: 'mock-admin' }))
      const repo = mkRepo({ extra: { weatherHold: { enabled: true, threshold: 99, windowMinutes: 60, upstream: { source: 'metrics', threshold: 5, windowMinutes: 60 } } } })
      try {
        const card = path.join(repo.root, 'card-sea-metrics.md')
        fs.writeFileSync(card, cardText({ id: 'sea-metrics' }))
        runOrch(repo.root, `submit "${card}"`)
        const out = runOrch(repo.root, 'drain --backend mock')
        expect(out.stdout).toContain('风暴滞留')
        expect(out.stdout).toContain('上游风暴')
        expect(readCard(repo.root, 'pending', 'sea-metrics')).toBeTruthy() // 未派发
        expect(eventsOf(repo.root, 'sea-metrics')).toEqual([])
        const hold = readFleetEvents(repo.root).find((e) => e.type === 'weather_hold')
        expect(hold).toBeTruthy()
        expect(hold?.upstream).toEqual({ count: 10, threshold: 5, windowMinutes: 60 })
      } finally {
        repo.cleanup()
      }
    } finally {
      m.close()
      h.restore()
    }
  })

  it('网关不可达（死端口）→ 落回日志扫描：日志 429/402 达阈照样滞留（fail-open 原行为）', async () => {
    const h = fakeHome()
    try {
      const dir = gatewayLogsDir() // fakeHome/.modeldock/logs（gatewayLogsDir 自建路径，目录需先建）
      fs.mkdirSync(path.join(h.home, '.modeldock'), { recursive: true })
      fs.writeFileSync(path.join(h.home, '.modeldock', 'gateway.json'), JSON.stringify({ port: 1, admin_token: 'x' }))
      fs.mkdirSync(dir!, { recursive: true })
      const ts = toIsoLocal(new Date())
      for (let i = 0; i < 6; i++) {
        fs.appendFileSync(path.join(dir!, `gateway-${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ts, harness: 'zcode', profile: 'p', provider: 'up', path: '/v1/messages', status: 429 }) + '\n')
      }
      const repo = mkRepo({ extra: { weatherHold: { threshold: 99, windowMinutes: 60, upstream: { source: 'metrics', threshold: 5, windowMinutes: 60 } } } })
      try {
        const card = path.join(repo.root, 'card-sea-fallback.md')
        fs.writeFileSync(card, cardText({ id: 'sea-fallback' }))
        runOrch(repo.root, `submit "${card}"`)
        const out = runOrch(repo.root, 'drain --backend mock')
        expect(out.stdout).toContain('风暴滞留')
        expect(readCard(repo.root, 'pending', 'sea-fallback')).toBeTruthy()
      } finally {
        repo.cleanup()
      }
    } finally {
      h.restore()
    }
  })
})

// 派发预检（A5，2026-11-04）测试：model-availability 数据面 + tier-validate provider 解析
// + 滞留判定矩阵 + run 级 E2E（mock admin：worker 模型不在上游目录 → 卡转 blocked +
// dispatch_held 事件；目录含模型 → 照常派发 fail-open）。
// 网关 mock 形态（weather-sea.test.ts 同款原则，绝不触达 8687/8890）：
//   - 进程内 listen(0)：async 预检路径（precheck/fetchModelAvailability），base 经
//     ORCH_GATEWAY_BASE env 显式注入——杜绝 discoverGatewayState 摸到真实网关；
//   - 子进程 serve：runOrch（execSync 阻塞测试进程事件循环）的 E2E 场景。

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
  availabilityVerdict,
  fetchModelAvailability,
  fetchProviderModelFallback,
  precheckModelAvailability,
  resetAvailabilityCache,
} from '../../.agents/scripts/orchestrator/availability.mjs'

beforeEach(() => resetAvailabilityCache())
afterAll(() => resetAvailabilityCache())

const NOW = Date.now()
const freshAt = new Date(NOW - 60_000).toISOString() // 1 分钟前（新鲜）
const staleAt = new Date(NOW - 30 * 3600_000).toISOString() // 30 小时前（>25h 陈旧）

function setGatewayEnv(url: string, token = 'mock-admin') {
  process.env.ORCH_GATEWAY_BASE = url
  process.env.ORCH_GATEWAY_ADMIN_TOKEN = token
}
function clearGatewayEnv() {
  delete process.env.ORCH_GATEWAY_BASE
  delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
}

/** 独立子进程 admin mock（多端点；见 weather-sea.test.ts spawnAdminMock 注）。 */
async function spawnAdminMock(payloads: Record<string, unknown>): Promise<{ url: string; close: () => void }> {
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-avail-mock-')), 'port.txt')
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
    url: `http://127.0.0.1:${port}`,
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

/** tier-validate 成功响应（token → profile p-glm → provider prov-glm）。 */
const TIER_VALIDATE_OK = { ok: true, harness: 'zcode', profile: 'p-glm', provider: 'prov-glm', tier: 'ahead-4', models: ['glm-5.3-flash'], tier_profiles: {} }

describe('availability > 滞留判定（availabilityVerdict 纯函数）', () => {
  const model = 'glm-5.3-flash'

  it('hold 全条件：条目存在 + 新鲜 + ok + model_ids 非空 + 模型不在列表', () => {
    expect(availabilityVerdict({ 'prov-glm': { ok: true, fetched_at: freshAt, model_ids: ['glm-other'] } }, 'prov-glm', model, { now: NOW })).toMatchObject({ hold: true, reason: 'model_unavailable' })
  })

  it('fail-open 矩阵：缺席 / 陈旧 / 未来时间戳 / ok=false / model_ids 空 / 模型在列表 / 无 provider', () => {
    const av = {
      'prov-glm': { ok: true, fetched_at: freshAt, model_ids: [model] },
      'prov-stale': { ok: true, fetched_at: staleAt, model_ids: ['glm-other'] },
      'prov-future': { ok: true, fetched_at: new Date(NOW + 3600_000).toISOString(), model_ids: ['glm-other'] },
      'prov-failed': { ok: false, fetched_at: freshAt, error: 'upstream timeout' },
      'prov-empty': { ok: true, fetched_at: freshAt, model_ids: [] },
    }
    expect(availabilityVerdict(av, 'prov-absent', model, { now: NOW }).reason).toBe('absent') // 从未探测 ≠ 不可用
    expect(availabilityVerdict(av, 'prov-stale', model, { now: NOW }).reason).toBe('stale')
    expect(availabilityVerdict(av, 'prov-future', model, { now: NOW }).reason).toBe('stale')
    expect(availabilityVerdict(av, 'prov-failed', model, { now: NOW }).reason).toBe('probe-failed') // 探测失败 ≠ 模型不可用
    expect(availabilityVerdict(av, 'prov-empty', model, { now: NOW }).reason).toBe('empty-model-ids')
    expect(availabilityVerdict(av, 'prov-glm', model, { now: NOW }).reason).toBe('listed')
    expect(availabilityVerdict(av, null as unknown as string, model, { now: NOW }).hold).toBe(false)
  })
})

describe('availability > fetchModelAvailability（gatewayAdmin 门控 + 节流缓存）', () => {
  it('ok 快照缓存命中（第二次零请求）；非 200 负缓存；未开 gatewayAdmin 零请求', async () => {
    let hits = 0
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (req.url !== '/_modeldock/model-availability' || req.headers['x-modeldock-admin'] !== 'mock-admin') {
          res.writeHead(req.url !== '/_modeldock/model-availability' ? 404 : 401)
          res.end('{}')
          return
        }
        hits += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, availability: { 'prov-glm': { ok: true, fetched_at: freshAt, model_ids: ['glm-x'] } } }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    setGatewayEnv(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    try {
      const cfg = { gatewayAdmin: true }
      const first = await fetchModelAvailability(cfg, { now: NOW, timeoutMs: 2000 })
      expect(first.mode).toBe('ok')
      await fetchModelAvailability(cfg, { now: NOW + 60_000, timeoutMs: 2000 })
      expect(hits).toBe(1) // 5min TTL 内命中缓存
      const off = await fetchModelAvailability({ gatewayAdmin: false }, { timeoutMs: 2000 })
      expect(off.mode).toBe('unavailable')
      expect(hits).toBe(1) // 未开闸：零请求
      // 非 200 → 负缓存
      setGatewayEnv('http://127.0.0.1:1') // 死端口：连不上
      const bad = await fetchModelAvailability(cfg, { now: NOW + 600_000, timeoutMs: 2000 })
      expect(bad.mode).toBe('unavailable')
      const bad2 = await fetchModelAvailability(cfg, { now: NOW + 610_000, timeoutMs: 2000 })
      expect(bad2.mode).toBe('unavailable') // 负缓存 60s 内不重试
    } finally {
      clearGatewayEnv()
      server.close()
    }
  })
})

describe('availability > precheckModelAvailability（tier-validate → provider → 判定）', () => {
  const TIER = { name: 'ahead-4', token: 'tok-ahead4', tokenEnv: 'MDK_TIER_AHEAD4_TOKEN', gatewayAdmin: true, gatewayBase: null }

  it('hold：tier token 解析到 provider，worker 模型不在其上游目录', async () => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (req.headers['x-modeldock-admin'] !== 'mock-admin') {
          res.writeHead(401)
          res.end('{}')
          return
        }
        if (req.url === '/_modeldock/tier-validate' && req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(TIER_VALIDATE_OK))
          return
        }
        if (req.url === '/_modeldock/model-availability') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, availability: { 'prov-glm': { ok: true, fetched_at: freshAt, model_ids: ['glm-other'] } } }))
          return
        }
        res.writeHead(404)
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    setGatewayEnv(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    try {
      const r = await precheckModelAvailability({ cfg: { gatewayAdmin: true }, tier: TIER, model: 'glm-5.3-flash', now: NOW, timeoutMs: 2000 })
      expect(r).toMatchObject({ hold: true, reason: 'model_unavailable', provider: 'prov-glm', model: 'glm-5.3-flash' })
    } finally {
      clearGatewayEnv()
      server.close()
    }
  })

  it('fail-open：tier 未配 token / 无模型 / admin 未配 / provider 解析否定 / gatewayBase 异源', async () => {
    let tierHits = 0
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (req.headers['x-modeldock-admin'] !== 'mock-admin') {
          res.writeHead(401)
          res.end('{}')
          return
        }
        if (req.url === '/_modeldock/tier-validate' && req.method === 'POST') {
          tierHits += 1
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, harness: 'zcode', profile: 'p-glm', provider: 'prov-glm', tier: 'ahead-4', models: [], tier_profiles: {} }))
          return
        }
        res.writeHead(404)
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    setGatewayEnv(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    try {
      const cfg = { gatewayAdmin: true }
      expect((await precheckModelAvailability({ cfg, tier: null, model: 'glm-5.3-flash', now: NOW, timeoutMs: 2000 })).reason).toBe('no-tier-token')
      expect((await precheckModelAvailability({ cfg, tier: TIER, model: null, now: NOW, timeoutMs: 2000 })).reason).toBe('no-model')
      expect((await precheckModelAvailability({ cfg: {}, tier: TIER, model: 'glm-5.3-flash', now: NOW, timeoutMs: 2000 })).reason).toBe('admin-unavailable')
      // gatewayBase 异源 → 短路不预检（跨源比对会张冠李戴）
      const mismatch = await precheckModelAvailability({ cfg, tier: { ...TIER, gatewayBase: 'http://127.0.0.1:9' }, model: 'glm-5.3-flash', now: NOW, timeoutMs: 2000 })
      expect(mismatch).toMatchObject({ hold: false, reason: 'gateway-base-mismatch' })
      expect(tierHits).toBe(0) // 短路：零请求
    } finally {
      clearGatewayEnv()
      server.close()
    }
  })

  it('provider 解析权威否定（token 未注册）→ provider-unresolved 照常派发', async () => {
    let tierHits = 0
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (req.headers['x-modeldock-admin'] !== 'mock-admin') {
          res.writeHead(401)
          res.end('{}')
          return
        }
        if (req.url === '/_modeldock/tier-validate' && req.method === 'POST') {
          tierHits += 1
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, reason: 'unknown_token' }))
          return
        }
        res.writeHead(404)
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    setGatewayEnv(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    try {
      const r = await precheckModelAvailability({ cfg: { gatewayAdmin: true }, tier: { name: 'ahead-4', token: 'tok-ahead4', tokenEnv: 'MDK_TIER_AHEAD4_TOKEN', gatewayAdmin: true, gatewayBase: null }, model: 'glm-5.3-flash', now: NOW, timeoutMs: 2000 })
      expect(r).toMatchObject({ hold: false, reason: 'provider-unresolved' })
      expect(tierHits).toBe(1)
    } finally {
      clearGatewayEnv()
      server.close()
    }
  })
})

describe('availability > 备用模型 advisory（fallbackMissing，M3）', () => {
  const TIER = { name: 'ahead-4', token: 'tok-ahead4', tokenEnv: 'MDK_TIER_AHEAD4_TOKEN', gatewayAdmin: true, gatewayBase: null }

  /** 三端点进程内 mock：tier-validate（provider 解析）+ model-availability（目录快照）+
   *  service/model-fallback（映射，带命中计数；mfStatus 模拟端点缺席/旧版网关 404）。 */
  async function startAdvisoryMock(opts: { availability: Record<string, unknown>; mf?: unknown; mfStatus?: number }) {
    let mfHits = 0
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (req.headers['x-modeldock-admin'] !== 'mock-admin') {
          res.writeHead(401)
          res.end('{}')
          return
        }
        if (req.url === '/_modeldock/tier-validate' && req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(TIER_VALIDATE_OK))
          return
        }
        if (req.url === '/_modeldock/model-availability') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, availability: opts.availability }))
          return
        }
        if (req.url === '/_modeldock/service/model-fallback' && req.method === 'POST') {
          mfHits += 1
          if (opts.mfStatus) {
            res.writeHead(opts.mfStatus)
            res.end('{}')
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(opts.mf ?? { ok: true, id: 'prov-glm', model_fallback: null }))
          return
        }
        res.writeHead(404)
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      hits: () => mfHits,
      close: () => server.close(),
    }
  }

  it('worker 在目录 + 备用目标缺席（严格条件成立）→ fallbackMissing 留痕且 hold=false 照常派发', async () => {
    const m = await startAdvisoryMock({
      availability: { 'prov-glm': { ok: true, fetched_at: freshAt, model_ids: ['glm-5.3-flash', 'glm-x'] } },
      mf: { ok: true, id: 'prov-glm', model_fallback: { 'glm-5.3-flash': 'glm-gone', 'glm-a': 'glm-x' } },
    })
    setGatewayEnv(m.url)
    try {
      const r = await precheckModelAvailability({ cfg: { gatewayAdmin: true }, tier: TIER, model: 'glm-5.3-flash', now: NOW, timeoutMs: 2000 })
      expect(r).toMatchObject({ hold: false, reason: 'listed', provider: 'prov-glm', model: 'glm-5.3-flash', fallbackMissing: ['glm-gone'] })
    } finally {
      clearGatewayEnv()
      m.close()
    }
  })

  it('备用目标都在目录 → 无 advisory（无 fallbackMissing 字段）', async () => {
    const m = await startAdvisoryMock({
      availability: { 'prov-glm': { ok: true, fetched_at: freshAt, model_ids: ['glm-5.3-flash', 'glm-x'] } },
      mf: { ok: true, id: 'prov-glm', model_fallback: { 'glm-5.3-flash': 'glm-x' } },
    })
    setGatewayEnv(m.url)
    try {
      const r = await precheckModelAvailability({ cfg: { gatewayAdmin: true }, tier: TIER, model: 'glm-5.3-flash', now: NOW, timeoutMs: 2000 })
      expect(r).toMatchObject({ hold: false, reason: 'listed' })
      expect(r.fallbackMissing).toBeUndefined()
    } finally {
      clearGatewayEnv()
      m.close()
    }
  })

  it('预检不可得（映射端点 404 / 未配置 null）→ 无 advisory 不报错；worker hold 路径零映射请求', async () => {
    const m = await startAdvisoryMock({
      availability: { 'prov-glm': { ok: true, fetched_at: freshAt, model_ids: ['glm-5.3-flash'] } },
      mfStatus: 404, // 旧版网关无此端点
    })
    setGatewayEnv(m.url)
    try {
      const cfg = { gatewayAdmin: true }
      const r = await precheckModelAvailability({ cfg, tier: TIER, model: 'glm-5.3-flash', now: NOW, timeoutMs: 2000 })
      expect(r).toMatchObject({ hold: false, reason: 'listed' })
      expect(r.fallbackMissing).toBeUndefined()
      // 未配置（model_fallback: null）→ 同款无 advisory
      const m2 = await startAdvisoryMock({
        availability: { 'prov-glm': { ok: true, fetched_at: freshAt, model_ids: ['glm-5.3-flash'] } },
        mf: { ok: true, id: 'prov-glm', model_fallback: null },
      })
      setGatewayEnv(m2.url)
      try {
        const r2 = await precheckModelAvailability({ cfg, tier: TIER, model: 'glm-5.3-flash', now: NOW, timeoutMs: 2000 })
        expect(r2.fallbackMissing).toBeUndefined()
      } finally {
        clearGatewayEnv()
        m2.close()
      }
      // worker 模型 hold（不在目录）→ 不做映射核验（advisory 只在 worker 预检通过后）
      const m3 = await startAdvisoryMock({
        availability: { 'prov-glm': { ok: true, fetched_at: freshAt, model_ids: ['glm-other'] } },
        mf: { ok: true, id: 'prov-glm', model_fallback: { 'glm-5.3-flash': 'glm-gone' } },
      })
      setGatewayEnv(m3.url)
      try {
        const r3 = await precheckModelAvailability({ cfg, tier: TIER, model: 'glm-5.3-flash', now: NOW, timeoutMs: 2000 })
        expect(r3).toMatchObject({ hold: true, reason: 'model_unavailable' })
        expect(m3.hits()).toBe(0) // 零映射请求
      } finally {
        clearGatewayEnv()
        m3.close()
      }
    } finally {
      clearGatewayEnv()
      m.close()
    }
  })

  it('映射查询节流：同一 provider 两次预检只打一次 service/model-fallback（5min TTL 命中缓存）', async () => {
    const m = await startAdvisoryMock({
      availability: { 'prov-glm': { ok: true, fetched_at: freshAt, model_ids: ['glm-5.3-flash'] } },
      mf: { ok: true, id: 'prov-glm', model_fallback: { 'glm-5.3-flash': 'glm-gone' } },
    })
    setGatewayEnv(m.url)
    try {
      const cfg = { gatewayAdmin: true }
      await precheckModelAvailability({ cfg, tier: TIER, model: 'glm-5.3-flash', now: NOW, timeoutMs: 2000 })
      await precheckModelAvailability({ cfg, tier: TIER, model: 'glm-5.3-flash', now: NOW + 60_000, timeoutMs: 2000 })
      expect(m.hits()).toBe(1) // 5min TTL 内命中缓存
    } finally {
      clearGatewayEnv()
      m.close()
    }
  })

  it('fetchProviderModelFallback 直连：ok 映射返回 + 5min 缓存；404 负缓存 60s 内不重试；未开 gatewayAdmin 零请求', async () => {
    const cfg = { gatewayAdmin: true }
    const m = await startAdvisoryMock({
      availability: {},
      mf: { ok: true, id: 'prov-glm', model_fallback: { 'glm-5.3-flash': 'glm-x' } },
    })
    setGatewayEnv(m.url)
    try {
      expect(await fetchProviderModelFallback(cfg, 'prov-glm', { now: NOW, timeoutMs: 2000 })).toEqual({ 'glm-5.3-flash': 'glm-x' })
      expect(await fetchProviderModelFallback(cfg, 'prov-glm', { now: NOW + 30_000, timeoutMs: 2000 })).toEqual({ 'glm-5.3-flash': 'glm-x' })
      expect(m.hits()).toBe(1) // ok 5min 缓存命中
      // 非 200（旧版网关无此端点）→ 负缓存 60s
      const m2 = await startAdvisoryMock({ availability: {}, mfStatus: 404 })
      setGatewayEnv(m2.url)
      try {
        expect(await fetchProviderModelFallback(cfg, 'prov-glm', { now: NOW, timeoutMs: 2000 })).toBeNull()
        expect(await fetchProviderModelFallback(cfg, 'prov-glm', { now: NOW + 30_000, timeoutMs: 2000 })).toBeNull()
        expect(m2.hits()).toBe(1) // 负缓存 60s 内不重试
        expect(await fetchProviderModelFallback(cfg, 'prov-glm', { now: NOW + 120_000, timeoutMs: 2000 })).toBeNull()
        expect(m2.hits()).toBe(2) // 过期后重试
      } finally {
        clearGatewayEnv()
        m2.close()
      }
      // 未开 gatewayAdmin → 零请求
      expect(await fetchProviderModelFallback({}, 'prov-glm', { now: NOW + 240_000, timeoutMs: 2000 })).toBeNull()
      expect(m.hits()).toBe(1)
    } finally {
      clearGatewayEnv()
      m.close()
    }
  })
})

describe('availability > run E2E（mock 后端 + mock admin 子进程）', () => {
  const REPO_EXTRA = {
    gatewayAdmin: true,
    tiers: { 'ahead-4': { tokenEnv: 'MDK_TIER_AHEAD4_TOKEN' } },
    worker: { backend: 'mock', model: 'glm-5.3-flash' }, // 预检对象 = workflow.json worker.model
  }
  const RUN_ENV = { ORCH_GATEWAY_ADMIN_TOKEN: 'mock-admin', MDK_TIER_AHEAD4_TOKEN: 'tok-ahead4' }

  it('worker 模型不在上游目录 → run 干净退出，卡 pending→blocked + dispatch_held 事件（队列不丢）', async () => {
    const m = await spawnAdminMock({
      'POST /_modeldock/tier-validate': TIER_VALIDATE_OK,
      'GET /_modeldock/model-availability': { ok: true, availability: { 'prov-glm': { ok: true, fetched_at: new Date().toISOString(), model_ids: ['glm-other'] } } },
    })
    const h = fakeHome()
    try {
      const repo = mkRepo({ extra: REPO_EXTRA })
      try {
        const card = path.join(repo.root, 'card-avail-hold.md')
        fs.writeFileSync(card, cardText({ id: 'avail-hold', tier: 'ahead-4' }))
        runOrch(repo.root, `submit "${card}"`)
        const out = runOrch(repo.root, 'run avail-hold --backend mock', { ...RUN_ENV, ORCH_GATEWAY_BASE: m.url })
        expect(out.status).toBe(0)
        expect(out.stdout).toContain('派发预检滞留')
        expect(out.stdout).toContain('model_unavailable')
        expect(readCard(repo.root, 'blocked', 'avail-hold')).toBeTruthy()
        const events = eventsOf(repo.root, 'avail-hold')
        expect(events.find((e) => e.type === 'dispatch_held')).toMatchObject({ reason: 'model_unavailable', provider: 'prov-glm', model: 'glm-5.3-flash' })
        expect(events.some((e) => e.type === 'worker_spawned')).toBe(false) // 未烧一程注定失败的 worker
      } finally {
        repo.cleanup()
      }
    } finally {
      m.close()
      h.restore()
    }
  })

  it('目录含 worker 模型 → 预检放行照常派发（fail-open 底线：预检绝不误伤正常派发）', async () => {
    const m = await spawnAdminMock({
      'POST /_modeldock/tier-validate': TIER_VALIDATE_OK,
      'GET /_modeldock/model-availability': { ok: true, availability: { 'prov-glm': { ok: true, fetched_at: new Date().toISOString(), model_ids: ['glm-5.3-flash', 'glm-x'] } } },
    })
    const h = fakeHome()
    try {
      const repo = mkRepo({ extra: REPO_EXTRA })
      try {
        const card = path.join(repo.root, 'card-avail-pass.md')
        fs.writeFileSync(card, cardText({ id: 'avail-pass', tier: 'ahead-4' }))
        runOrch(repo.root, `submit "${card}"`)
        runOrch(repo.root, 'run avail-pass --backend mock', { ...RUN_ENV, ORCH_GATEWAY_BASE: m.url })
        expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', 'avail-pass.md'))).toBe(false) // 未被预检拉黑
        expect(eventsOf(repo.root, 'avail-pass').some((e) => e.type === 'dispatch_held')).toBe(false)
        expect(eventsOf(repo.root, 'avail-pass').some((e) => e.type === 'worker_spawned')).toBe(true)
      } finally {
        repo.cleanup()
      }
    } finally {
      m.close()
      h.restore()
    }
  })

  it('worker 在目录但备用模型缺席 → 照常派发 + dispatch_advisory 事件留痕（advisory 不阻断）', async () => {
    const m = await spawnAdminMock({
      'POST /_modeldock/tier-validate': TIER_VALIDATE_OK,
      'GET /_modeldock/model-availability': { ok: true, availability: { 'prov-glm': { ok: true, fetched_at: new Date().toISOString(), model_ids: ['glm-5.3-flash'] } } },
      'POST /_modeldock/service/model-fallback': { ok: true, id: 'prov-glm', model_fallback: { 'glm-5.3-flash': 'glm-gone' } },
    })
    const h = fakeHome()
    try {
      const repo = mkRepo({ extra: REPO_EXTRA })
      try {
        const card = path.join(repo.root, 'card-avail-advisory.md')
        fs.writeFileSync(card, cardText({ id: 'avail-advisory', tier: 'ahead-4' }))
        runOrch(repo.root, `submit "${card}"`)
        const out = runOrch(repo.root, 'run avail-advisory --backend mock', { ...RUN_ENV, ORCH_GATEWAY_BASE: m.url })
        expect(out.status).toBe(0)
        expect(out.stdout).toContain('容灾兜底缺席')
        expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', 'avail-advisory.md'))).toBe(false) // advisory 不拉黑
        const events = eventsOf(repo.root, 'avail-advisory')
        expect(events.find((e) => e.type === 'dispatch_advisory')).toMatchObject({ reason: 'fallback_model_missing', provider: 'prov-glm', model: 'glm-5.3-flash', fallback_missing: ['glm-gone'] })
        expect(events.some((e) => e.type === 'dispatch_held')).toBe(false)
        expect(events.some((e) => e.type === 'worker_spawned')).toBe(true) // 照常派发
      } finally {
        repo.cleanup()
      }
    } finally {
      m.close()
      h.restore()
    }
  })
})

// 开航前海况观测（fleet observe，纯观测零决策）单测 + E2E：
// 管理面解析（gatewayAdmin 门）、快照拉取与压缩、船↔harness 告警判读、observeFleetForRun
// 装配、cmdRun 全链路 fleet_observed 事件（mock 后端 + mock 管理面）。

import { afterAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { AddressInfo } from 'node:net'
import { fakeHome } from '../helpers.js'
import { mkRepo, runOrch, cardText, eventsOf } from './helpers.js'
import {
  SHIP_HARNESS,
  assessFleet,
  fetchFleetState,
  observeFleetForRun,
  renderFleetLine,
} from '../../.agents/scripts/orchestrator/fleet.mjs'
import { resolveGatewayAdmin } from '../../.agents/scripts/orchestrator/tiers.mjs'

// admin 面 mock：/v1/health（免鉴权探活）+ /config（buildConfigView 投影）+ /metrics（providers/meltdown）
async function mockAdmin({ providers, harness, metricsProviders = {}, meltdown = [] } = {}) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url?.split('?')[0] === '/v1/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.headers['x-modeldock-admin'] !== 'mock-admin') {
        res.writeHead(401)
        res.end('{}')
        return
      }
      if (req.url === '/_modeldock/config') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ providers, profiles: [], harness }))
      } else if (req.url === '/_modeldock/metrics') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ event_loop_lag_ms: null, providers: metricsProviders, meltdown }))
      } else {
        res.writeHead(404)
        res.end('{}')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}

const envBackup: Record<string, string | undefined> = {}
afterAll(() => {
  delete process.env.ORCH_GATEWAY_BASE
  delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
  void envBackup
})

function setEnv(base?: string) {
  if (base) process.env.ORCH_GATEWAY_BASE = base
  else delete process.env.ORCH_GATEWAY_BASE
  process.env.ORCH_GATEWAY_ADMIN_TOKEN = 'mock-admin'
}

describe('resolveGatewayAdmin（admin 面地址解析）', () => {
  it('gatewayAdmin 未开 → null 不发请求；开了 + env → base/token', () => {
    expect(resolveGatewayAdmin({})).toBeNull()
    expect(resolveGatewayAdmin(undefined)).toBeNull()
    setEnv('http://127.0.0.1:1')
    try {
      expect(resolveGatewayAdmin({ gatewayAdmin: true })).toEqual({ base: 'http://127.0.0.1:1', adminToken: 'mock-admin' })
      expect(resolveGatewayAdmin({ gatewayAdmin: false })).toBeNull()
    } finally {
      setEnv(undefined)
    }
  })
})

describe('fetchFleetState（快照拉取与压缩）', () => {
  it('config+metrics 合成：providers（含熔断标记）、harnesses 指向、meltdown 清单', async () => {
    // providers 用真实网关形态（overview-view buildConfigView 投影：数组、条目自带 id + protocols）
    const gw = await mockAdmin({
      providers: [
        { id: 'up', protocol: 'openai', protocols: ['openai', 'anthropic'], models: [{ id: 'm1' }, { id: 'm2' }] },
        { id: 'down2', protocol: 'openai', protocols: ['openai'], models: [] },
      ],
      harness: [
        { id: 'zcode', attached: true, pointing: 'gateway', protocols: null },
        { id: 'claude-code', attached: true, pointing: 'other', protocols: ['anthropic'] },
      ],
      metricsProviders: { up: { count: 3, last_ms: 42 } },
      meltdown: [{ provider: 'down2', class: 'quota', remaining_ms: 1000 }],
    })
    setEnv(gw.url)
    try {
      const s = await fetchFleetState({ gatewayAdmin: true })
      expect(s.mode).toBe('ok')
      expect(s.providers).toEqual([
        { id: 'up', models: 2, down: false, lastMs: 42, protocols: ['openai', 'anthropic'] },
        { id: 'down2', models: 0, down: true, lastMs: null, protocols: ['openai'] },
      ])
      expect(s.harnesses).toEqual([
        { id: 'zcode', attached: true, pointing: 'gateway', protocols: null },
        { id: 'claude-code', attached: true, pointing: 'other', protocols: ['anthropic'] },
      ])
      expect(s.meltdown).toEqual([{ provider: 'down2', class: 'quota' }])
    } finally {
      gw.close()
      setEnv(undefined)
    }
  })

  it('providers 兼容 map 形态（防御性兜底）；protocols 缺失/非数组 → null（fail-open 口径）', async () => {
    const gw = await mockAdmin({
      providers: { up: { models: [{ id: 'm1' }] } },
      harness: [{ id: 'zcode', attached: true, pointing: 'gateway' }],
      metricsProviders: {},
      meltdown: [],
    })
    setEnv(gw.url)
    try {
      const s = await fetchFleetState({ gatewayAdmin: true })
      expect(s.mode).toBe('ok')
      expect(s.providers).toEqual([{ id: 'up', models: 1, down: false, lastMs: null, protocols: null }])
      expect(s.harnesses).toEqual([{ id: 'zcode', attached: true, pointing: 'gateway', protocols: null }])
    } finally {
      gw.close()
      setEnv(undefined)
    }
  })

  it('gatewayAdmin 未开 / 网关不可达 → unavailable（不抛出）；不可达文案经探针定责', async () => {
    expect((await fetchFleetState({})).mode).toBe('unavailable')
    setEnv('http://127.0.0.1:1') // 端口 1 无监听 → 连接失败
    try {
      const s = await fetchFleetState({ gatewayAdmin: true }, { timeoutMs: 1500 })
      expect(s.mode).toBe('unavailable')
      expect(s.reason).toContain('网关不可达') // A4：探活失败 → 文案明确「网关不可达」
    } finally {
      setEnv(undefined)
    }
  })

  it('A4 定责探针：探活成功但 admin 拒证 → 「网关在线但 admin 凭据/接口异常」（非「不可达」）', async () => {
    // /v1/health 免鉴权 200，admin 路径一律 401（凭据错误 ≠ 网关挂了）
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (req.url?.split('?')[0] === '/v1/health') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        res.writeHead(401)
        res.end('{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    setEnv(`http://127.0.0.1:${port}`)
    try {
      const s = await fetchFleetState({ gatewayAdmin: true }, { timeoutMs: 1500 })
      expect(s.mode).toBe('unavailable')
      expect(s.reason).toContain('网关在线但 admin 凭据/接口异常')
      expect(s.reason).not.toContain('网关不可达')
    } finally {
      server.close()
      setEnv(undefined)
    }

    // /v1/health 也 401（鉴权覆盖全路径的网关形态）→ 不算「不可达」（有东西在应答），
    // 归因为 admin/接口异常，health 非 200 作为线索附上
    const server2 = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(401)
        res.end('{}')
      })
    })
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve))
    const port2 = (server2.address() as AddressInfo).port
    setEnv(`http://127.0.0.1:${port2}`)
    try {
      const s2 = await fetchFleetState({ gatewayAdmin: true }, { timeoutMs: 1500 })
      expect(s2.mode).toBe('unavailable')
      expect(s2.reason).toContain('网关在线但 admin 凭据/接口异常')
      expect(s2.reason).toContain('/v1/health 返回 401')
    } finally {
      server2.close()
      setEnv(undefined)
    }
  })
})

describe('assessFleet（船↔harness 判读）', () => {
  const state = {
    mode: 'ok' as const,
    observedAt: 't',
    providers: [
      { id: 'up', models: 1, down: false, lastMs: 1 },
      { id: 'down2', models: 0, down: true, lastMs: null },
    ],
    harnesses: [
      { id: 'zcode', attached: true, pointing: 'gateway' as const },
      { id: 'claude-code', attached: true, pointing: 'other' as const },
    ],
    meltdown: [{ provider: 'down2', class: 'quota' }],
  }

  it('zcode 船指向网关 → 无船告警；claude 船 → dogfood_bypass', () => {
    expect(assessFleet(state, { backend: 'zcode-headless' }).map((w) => w.code)).toEqual(['meltdown_active'])
    expect(assessFleet(state, { backend: 'claude-headless' }).map((w) => w.code)).toEqual(['dogfood_bypass', 'meltdown_active'])
  })

  it('未接入的客户端 → not_attached；mock 船无 harness 映射 → 只看熔断', () => {
    const detached = { ...state, harnesses: [{ id: 'zcode', attached: false, pointing: 'unknown' as const }] }
    expect(assessFleet(detached, { backend: 'zcode-headless' }).map((w) => w.code)).toEqual(['not_attached', 'meltdown_active'])
    expect(assessFleet(state, { backend: 'mock' }).map((w) => w.code)).toEqual(['meltdown_active'])
  })

  it('健康海况 → 零告警；unavailable → 零告警', () => {
    const healthy = { ...state, providers: state.providers.filter((p) => p.id === 'up'), meltdown: [] }
    expect(assessFleet(healthy, { backend: 'zcode-headless' })).toEqual([])
    expect(assessFleet({ mode: 'unavailable', reason: 'x' }, { backend: 'zcode-headless' })).toEqual([])
  })

  it('SHIP_HARNESS 映射契约：编排后端 ↔ 交互形态适配器', () => {
    expect(SHIP_HARNESS).toEqual({ 'zcode-headless': 'zcode', 'claude-headless': 'claude-code' })
  })
})

describe('observeFleetForRun（cmdRun 装配）', () => {
  it('gatewayAdmin 未开 → 完全静默（行为与历史一致）', async () => {
    const r = await observeFleetForRun({}, { backend: 'zcode-headless' })
    expect(r).toEqual({ lines: [], event: null, state: null }) // state 供动态选船逐船判读（阶段 3）
  })

  it('开了但网关不可得 → 一行提示不阻断；观测成功 → 摘要 + 告警行 + 紧凑事件', async () => {
    setEnv('http://127.0.0.1:1')
    try {
      const off = await observeFleetForRun({ gatewayAdmin: true }, { backend: 'zcode-headless' })
      expect(off.lines).toHaveLength(1)
      expect(off.lines[0]).toContain('海况观测不可得')
      expect(off.event).toBeNull()
    } finally {
      setEnv(undefined)
    }

    const gw = await mockAdmin({
      providers: { up: { models: [{ id: 'm1' }] } },
      harness: [{ id: 'zcode', attached: true, pointing: 'other' }],
      meltdown: [{ provider: 'up', class: 'quota' }],
    })
    setEnv(gw.url)
    try {
      const r = await observeFleetForRun({ gatewayAdmin: true }, { backend: 'zcode-headless' })
      expect(r.lines[0]).toContain('⚓ 海况')
      expect(r.lines.some((l) => l.includes('直连上游'))).toBe(true)
      expect(r.event).toMatchObject({
        mode: 'ok',
        providers: { up: { down: true } },
        harnesses: { zcode: 'other' },
        meltdown: ['up'],
        warnings: ['dogfood_bypass', 'meltdown_active'],
        dogfood_bypass: true,
      })
      expect(renderFleetLine({ mode: 'ok', observedAt: 't', providers: [], harnesses: [], meltdown: [] })).toContain('服务 0 个')
    } finally {
      gw.close()
      setEnv(undefined)
    }
  })
})

describe('cmdRun E2E：海况观测装配', () => {
  // 说明：ok 路径（真实拉取 + fleet_observed 事件）由上方 observeFleetForRun 单测覆盖事件
  // 装配；此处 E2E 验证 cmdRun 确实调用了观测——用「端口拒连」（无监听，内核秒回 RST，
  // 沙箱/CI 行为一致）走不可得路径：断言告警行出现在 stdout 且不落 fleet_observed 事件。
  it('未开 gatewayAdmin → 完全静默；开了但发现不了网关 → 一行提示、均无 fleet_observed', async () => {
    // 未开（独立 repo，无 gatewayAdmin）：完全静默，行为与历史版本一致
    const repoOff = mkRepo()
    try {
      const card1 = path.join(repoOff.root, 'card.md')
      fs.writeFileSync(card1, cardText({ id: 'fleet-off', gate: 'L1' }))
      runOrch(repoOff.root, `submit "${card1}"`)
      const out = runOrch(repoOff.root, 'run fleet-off --backend mock')
      expect(out.stdout).not.toContain('海况')
      expect(eventsOf(repoOff.root, 'fleet-off').some((e) => e.type === 'fleet_observed')).toBe(false)
    } finally {
      repoOff.cleanup()
    }

    // 开了但无 env 无 gateway.json：不可得路径——一行可操作提示，不落事件不阻断
    const repo = mkRepo({ extra: { gatewayAdmin: true } })
    try {
      const card2 = path.join(repo.root, 'card.md')
      fs.writeFileSync(card2, cardText({ id: 'fleet-down', gate: 'L1' }))
      runOrch(repo.root, `submit "${card2}"`)
      delete process.env.ORCH_GATEWAY_BASE
      delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
      const out = runOrch(repo.root, 'run fleet-down --backend mock', { MODELRDOCK_FAKE_HOME: repo.root })
      expect(out.stdout).toContain('海况观测不可得')
      expect(eventsOf(repo.root, 'fleet-down').some((e) => e.type === 'fleet_observed')).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 120_000) // 两次 runOrch 子进程（Windows 上含 CLI 探测与 git init），20s 默认超时不够（基线实测 ~28s）
})

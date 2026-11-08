// 派发预检②（2026-11-09，协议兼容矩阵）测试：protocolCompatVerdict 纯函数矩阵 +
// precheckProtocolCompat fail-open 矩阵（零网络路径 + tier-validate 回落解析）+
// decideDispatchForRun 接线（真实 fetchFleetState 快照 + stub holdExit：交集空 → 卡
// blocked + dispatch_held 带两侧 protocols；单侧未声明 / 快照缺席 → 放行；预检①
// model-availability 首个命中即滞留、协议预检复用其 provider 解析零重复请求）。
// 网关 mock 形态（availability.test.ts 同款原则，绝不触达 8687/8890）：
//   - 进程内 listen(0)：/v1/health + /config（真实数组形态带 protocols）+ /metrics +
//     /tier-validate + /model-availability，base 经 ORCH_GATEWAY_BASE env 显式注入——
//     杜绝 discoverGatewayState 摸到真实网关；
//   - 不拉起 run 子进程（execSync 阻塞事件循环，进程内 server 无法应答）——run 级
//     滞留落位机制（appendEvent/moveCard）由 availability.test.ts E2E 覆盖同款路径，
//     这里以 stub holdExit 直连 decideDispatchForRun 断言落位产物。

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import {
  decideDispatchForRun,
  precheckProtocolCompat,
  protocolCompatVerdict,
} from '../../.agents/scripts/orchestrator/dispatch.mjs'
import { fetchFleetState } from '../../.agents/scripts/orchestrator/fleet.mjs'
import { resetAvailabilityCache } from '../../.agents/scripts/orchestrator/availability.mjs'
import { resetSeaSnapshotCache } from '../../.agents/scripts/orchestrator/weather.mjs'
import { eventsOf } from './helpers.js'
import { fakeHome } from '../helpers.js'

beforeEach(() => {
  resetAvailabilityCache()
  resetSeaSnapshotCache()
  clearGatewayEnv()
})
afterAll(() => {
  resetAvailabilityCache()
  resetSeaSnapshotCache()
  clearGatewayEnv()
})

const TMP_DIRS: string[] = []
function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  TMP_DIRS.push(d)
  return d
}
afterAll(() => {
  while (TMP_DIRS.length) fs.rmSync(TMP_DIRS.pop()!, { recursive: true, force: true })
})

function setGatewayEnv(url: string, token = 'mock-admin') {
  process.env.ORCH_GATEWAY_BASE = url
  process.env.ORCH_GATEWAY_ADMIN_TOKEN = token
}
function clearGatewayEnv() {
  delete process.env.ORCH_GATEWAY_BASE
  delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
}

/** 进程内 admin mock（多端点 + tier-validate 计数；key 形如 'GET /_modeldock/config'）。 */
async function startAdminMock(payloads: Record<string, unknown>): Promise<{ url: string; tierHits: () => number; close: () => void }> {
  let tierHits = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const url = req.url?.split('?')[0] ?? ''
      if (url === '/v1/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.headers['x-modeldock-admin'] !== 'mock-admin') {
        res.writeHead(401)
        res.end('{}')
        return
      }
      const key = `${req.method} ${url}`
      if (key === 'POST /_modeldock/tier-validate') tierHits += 1
      const p = payloads[key]
      if (p === undefined) {
        res.writeHead(404)
        res.end('{}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(p))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    tierHits: () => tierHits,
    close: () => server.close(),
  }
}

// ---------------------------------------------------------------------------
// protocolCompatVerdict（纯函数矩阵）
// ---------------------------------------------------------------------------

describe('protocol-compat > protocolCompatVerdict（纯函数）', () => {
  it('交集空 → hold + 两侧完整列表；有交集 → compatible 放行', () => {
    const v = protocolCompatVerdict(['openai'], ['anthropic'])
    expect(v).toEqual({ hold: true, reason: 'protocol_incompatible', providerProtocols: ['openai'], harnessProtocols: ['anthropic'] })
    const ok = protocolCompatVerdict(['openai', 'anthropic'], ['anthropic'])
    expect(ok).toEqual({ hold: false, reason: 'compatible', providerProtocols: ['openai', 'anthropic'], harnessProtocols: ['anthropic'] })
    // 多协议交集：部分重叠即放行（网关按别名/端点路由，重叠 = 有可用端点）
    expect(protocolCompatVerdict(['anthropic', 'responses'], ['openai', 'anthropic']).reason).toBe('compatible')
  })

  it('任一侧未声明（null / 缺失 / 空数组）→ 不拦（fail-open，与网关「未声明不校验」同口径）', () => {
    for (const bad of [null, undefined, [], 'openai', {}]) {
      expect(protocolCompatVerdict(['openai'], bad as unknown as string[]).reason).toBe('harness-undeclared')
      expect(protocolCompatVerdict(bad as unknown as string[], ['anthropic']).reason).toBe('provider-undeclared')
    }
    expect(protocolCompatVerdict(null, null).hold).toBe(false)
  })

  it('非字符串项过滤后才判空：全噪声 = 未声明，混合 = 只按有效项求交集', () => {
    expect(protocolCompatVerdict([5, null, {}] as unknown as string[], ['anthropic']).reason).toBe('provider-undeclared')
    expect(protocolCompatVerdict(['openai', 5] as unknown as string[], ['openai', 'x']).reason).toBe('compatible')
  })
})

// ---------------------------------------------------------------------------
// precheckProtocolCompat（fail-open 矩阵 + provider 解析复用/回落）
// ---------------------------------------------------------------------------

// fleet 快照（fetchFleetState 消费 /config 后的产物形态）：claude-code 声明 anthropic，
// zcode 未声明（null），provider prov-glm 只支持 openai——与 claude-code 交集为空。
const FLEET_INCOMPATIBLE = {
  mode: 'ok' as const,
  observedAt: 't',
  providers: [{ id: 'prov-glm', models: 1, down: false, lastMs: null, protocols: ['openai'] }],
  harnesses: [
    { id: 'zcode', attached: true, pointing: 'gateway' as const, protocols: null },
    { id: 'claude-code', attached: true, pointing: 'gateway' as const, protocols: ['anthropic'] },
  ],
  meltdown: [] as Array<{ provider: string; class: string | null }>,
}

describe('protocol-compat > precheckProtocolCompat（fail-open 矩阵，零网络路径）', () => {
  it('交集空 → hold 带两侧 protocols 与 provider/harness/model', async () => {
    const r = await precheckProtocolCompat({
      tier: null,
      backend: 'claude-headless',
      fleetState: FLEET_INCOMPATIBLE,
      resolvedProvider: 'prov-glm',
      model: 'glm-5.3-flash',
    })
    expect(r).toEqual({
      hold: true,
      reason: 'protocol_incompatible',
      providerProtocols: ['openai'],
      harnessProtocols: ['anthropic'],
      provider: 'prov-glm',
      harness: 'claude-code',
      model: 'glm-5.3-flash',
    })
  })

  it('fail-open：未声明 / 条目缺失 / 快照缺席 / 无 harness 映射（mock 测试链路）', async () => {
    const base = { tier: null, resolvedProvider: 'prov-glm' }
    // 双端声明才校验：zcode 未声明天然不受影响；provider 侧同
    expect((await precheckProtocolCompat({ ...base, backend: 'zcode-headless', fleetState: FLEET_INCOMPATIBLE })).reason).toBe('harness-undeclared')
    expect((await precheckProtocolCompat({ ...base, backend: 'claude-headless', fleetState: { ...FLEET_INCOMPATIBLE, providers: [{ id: 'prov-glm', models: 1, down: false, lastMs: null, protocols: null }] } })).reason).toBe('provider-undeclared')
    // 快照里找不到条目 ≠ 协议不兼容
    expect((await precheckProtocolCompat({ ...base, backend: 'claude-headless', fleetState: { ...FLEET_INCOMPATIBLE, providers: [] } })).reason).toBe('provider-row-missing')
    expect((await precheckProtocolCompat({ ...base, backend: 'claude-headless', fleetState: { ...FLEET_INCOMPATIBLE, harnesses: [] } })).reason).toBe('harness-row-missing')
    // 观测缺席（gatewayAdmin 未开 / 网关不可达 → fleetState null/unavailable）→ 不拦
    expect((await precheckProtocolCompat({ backend: 'claude-headless', fleetState: null, resolvedProvider: 'prov-glm' })).reason).toBe('fleet-state-unavailable')
    expect((await precheckProtocolCompat({ backend: 'claude-headless', fleetState: { mode: 'unavailable', reason: 'x' }, resolvedProvider: 'prov-glm' })).reason).toBe('fleet-state-unavailable')
    // mock 等无 harness 映射：测试链路照常可用
    expect((await precheckProtocolCompat({ backend: 'mock', fleetState: FLEET_INCOMPATIBLE, resolvedProvider: 'prov-glm' })).reason).toBe('no-harness-mapping')
  })

  it('provider 解析门（与预检①同口径）：无 token / admin 未配 / gatewayBase 异源 → 零请求放行', async () => {
    // fakeHome 隔离 gateway.json 发现：gatewayAdmin:true 而网关不可得 → admin-unavailable
    // （绝不摸真实 home 的 gateway.json——8687 红线）
    const h = fakeHome()
    try {
      // 无网络环境（未设 ORCH_GATEWAY_*）：这些分支都不触达
      expect((await precheckProtocolCompat({ backend: 'claude-headless', fleetState: FLEET_INCOMPATIBLE, tier: null })).reason).toBe('no-tier-token')
      expect((await precheckProtocolCompat({ backend: 'claude-headless', fleetState: FLEET_INCOMPATIBLE, tier: { name: 'ahead-4' } })).reason).toBe('no-tier-token')
      expect((await precheckProtocolCompat({ cfg: { gatewayAdmin: true }, backend: 'claude-headless', fleetState: FLEET_INCOMPATIBLE, tier: { name: 'ahead-4', token: 'tk' } })).reason).toBe('admin-unavailable')
      // 异源网关：短路不预检（零请求）
      setGatewayEnv('http://127.0.0.1:1')
      const r = await precheckProtocolCompat({ cfg: { gatewayAdmin: true }, backend: 'claude-headless', fleetState: FLEET_INCOMPATIBLE, tier: { name: 'ahead-4', token: 'tk', gatewayBase: 'http://127.0.0.1:9' } })
      expect(r).toMatchObject({ hold: false, reason: 'gateway-base-mismatch' })
    } finally {
      clearGatewayEnv()
      h.restore()
    }
  })

  it('resolvedProvider 复用：预检①已解析 → 零 tier-validate 请求；缺席时回落自行解析一次', async () => {
    const TIER_VALIDATE_OK = { ok: true, harness: 'claude-code', profile: 'p-glm', provider: 'prov-glm', tier: 'ahead-4', models: ['glm-5.3-flash'], tier_profiles: {} }
    const m = await startAdminMock({ 'POST /_modeldock/tier-validate': TIER_VALIDATE_OK })
    const tier = { name: 'ahead-4', token: 'tok-ahead4', gatewayBase: null }
    try {
      setGatewayEnv(m.url)
      // 复用路径：resolvedProvider 已给 → 不打 tier-validate
      const reuse = await precheckProtocolCompat({ cfg: { gatewayAdmin: true }, backend: 'claude-headless', fleetState: FLEET_INCOMPATIBLE, resolvedProvider: 'prov-glm', tier })
      expect(reuse.hold).toBe(true)
      expect(m.tierHits()).toBe(0)
      // 回落路径：预检①缺席（如 worker.model 未配）→ 自行解析一次再判定
      const fallback = await precheckProtocolCompat({ cfg: { gatewayAdmin: true }, backend: 'claude-headless', fleetState: FLEET_INCOMPATIBLE, tier })
      expect(fallback).toMatchObject({ hold: true, reason: 'protocol_incompatible', provider: 'prov-glm' })
      expect(m.tierHits()).toBe(1)
    } finally {
      clearGatewayEnv()
      m.close()
    }
  })
})

// ---------------------------------------------------------------------------
// decideDispatchForRun 接线（真实 fleet 快照 + stub holdExit + 临时队列）
// ---------------------------------------------------------------------------

/** 最小可滞留仓库：queue/pending 放目标卡（moveCard 迁移源），blocked 目录一并建好（迁移目标）；logs 留给 appendEvent 自建。 */
function makeRepo(id: string): { root: string; card: string } {
  const root = tmpDir('orch-proto-repo-')
  for (const state of ['pending', 'blocked']) {
    fs.mkdirSync(path.join(root, '.agents', 'orchestrator', 'queue', state), { recursive: true })
  }
  const card = path.join(root, '.agents', 'orchestrator', 'queue', 'pending', `${id}.md`)
  fs.writeFileSync(card, '---\nid: ' + id + '\n---\n\n# 目标\n测试\n')
  return { root, card }
}

/** CLI 探测桩（decideDispatchForRun 装配两船可用性；桩让探测确定性 exit 0，不摸 PATH）。 */
function writeCliProbeStubs(dir: string) {
  const stub = path.join(dir, 'cli-probe-stub.cjs')
  fs.writeFileSync(stub, "if (process.argv.slice(2).includes('--version')) process.exit(0);\n")
  process.env.ORCH_CLAUDE_CLI = stub
  process.env.ORCH_ZCODE_CLI = stub
}

const TIER = { name: 'ahead-4', token: 'tok-ahead4', tokenEnv: 'MDK_TIER_AHEAD4_TOKEN', workerModel: null, reviewModel: null, provider: null, gatewayBase: null, gatewayAdmin: true, auto: false }

describe('protocol-compat > decideDispatchForRun 接线', () => {
  it('交集空 → 卡 pending→blocked + dispatch_held（reason/两侧 protocols/provider/harness）；provider 解析复用零重复请求', async () => {
    const m = await startAdminMock({
      'GET /_modeldock/config': {
        providers: [{ id: 'prov-glm', name: 'GLM', protocol: 'openai', protocols: ['openai'], models: [] }],
        profiles: [],
        harness: [
          { id: 'zcode', attached: true, pointing: 'gateway', protocols: null },
          { id: 'claude-code', attached: true, pointing: 'gateway', protocols: ['anthropic'] },
        ],
      },
      'GET /_modeldock/metrics': { providers: {}, meltdown: [] },
      'POST /_modeldock/tier-validate': { ok: true, harness: 'claude-code', profile: 'p-glm', provider: 'prov-glm', tier: 'ahead-4', models: ['glm-5.3-flash'], tier_profiles: {} },
      'GET /_modeldock/model-availability': { ok: true, availability: { 'prov-glm': { ok: true, fetched_at: new Date().toISOString(), model_ids: ['glm-5.3-flash'] } } },
    })
    const repo = makeRepo('proto-hold')
    let exitCode: number | null = null
    try {
      setGatewayEnv(m.url)
      writeCliProbeStubs(tmpDir('orch-proto-cli-'))
      const cfg = { gatewayAdmin: true, worker: { backend: 'claude-headless', model: 'glm-5.3-flash' } }
      const fleetState = await fetchFleetState(cfg) // 真实快照消费 /config（协议矩阵经 fleet 投影）
      expect(fleetState.mode).toBe('ok')
      const decision = await decideDispatchForRun({
        repoRoot: repo.root,
        cfg,
        meta: { id: 'proto-hold' },
        defaultBackend: 'claude-headless',
        explicit: false,
        inherited: false,
        tier: TIER,
        fleetState,
        holdExit: (c: number) => {
          exitCode = c
        },
      })
      expect(exitCode).toBe(0) // 干净退出 run 子进程
      expect(decision.backend).toBe('claude-headless') // 决策本身不受预检影响
      expect(fs.existsSync(repo.card)).toBe(false) // pending 卡已迁走
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', 'proto-hold.md'))).toBe(true)
      const events = eventsOf(repo.root, 'proto-hold')
      const held = events.find((e) => e.type === 'dispatch_held')
      expect(held).toMatchObject({
        reason: 'protocol_incompatible',
        provider: 'prov-glm',
        harness: 'claude-code',
        model: 'glm-5.3-flash',
        provider_protocols: ['openai'],
        harness_protocols: ['anthropic'],
      })
      expect(events.some((e) => e.type === 'failed' && String(e.reason).includes('protocol_incompatible'))).toBe(true)
      expect(events.some((e) => e.type === 'worker_spawned')).toBe(false)
      expect(m.tierHits()).toBe(1) // 预检①解析一次，②复用（零重复 tier-validate）
    } finally {
      clearGatewayEnv()
      delete process.env.ORCH_CLAUDE_CLI
      delete process.env.ORCH_ZCODE_CLI
      m.close()
    }
  }, 60_000)

  it('单侧未声明（zcode harness protocols=null）→ 放行：卡留 pending、零 dispatch_held、holdExit 未调', async () => {
    const m = await startAdminMock({
      'GET /_modeldock/config': {
        providers: [{ id: 'prov-glm', name: 'GLM', protocol: 'openai', protocols: ['openai'], models: [] }],
        profiles: [],
        harness: [{ id: 'zcode', attached: true, pointing: 'gateway', protocols: null }],
      },
      'GET /_modeldock/metrics': { providers: {}, meltdown: [] },
      'POST /_modeldock/tier-validate': { ok: true, harness: 'zcode', profile: 'p-glm', provider: 'prov-glm', tier: 'ahead-4', models: ['glm-5.3-flash'], tier_profiles: {} },
      'GET /_modeldock/model-availability': { ok: true, availability: { 'prov-glm': { ok: true, fetched_at: new Date().toISOString(), model_ids: ['glm-5.3-flash'] } } },
    })
    const repo = makeRepo('proto-pass-zcode')
    let exitCode: number | null = null
    try {
      setGatewayEnv(m.url)
      writeCliProbeStubs(tmpDir('orch-proto-cli2-'))
      const cfg = { gatewayAdmin: true, worker: { backend: 'zcode-headless', model: 'glm-5.3-flash' } }
      const fleetState = await fetchFleetState(cfg)
      const decision = await decideDispatchForRun({
        repoRoot: repo.root,
        cfg,
        meta: { id: 'proto-pass-zcode' },
        defaultBackend: 'zcode-headless',
        explicit: false,
        inherited: false,
        tier: TIER,
        fleetState,
        holdExit: (c: number) => {
          exitCode = c
        },
      })
      expect(exitCode).toBeNull()
      expect(decision.backend).toBe('zcode-headless')
      expect(fs.existsSync(repo.card)).toBe(true) // 卡未被动
      expect(eventsOf(repo.root, 'proto-pass-zcode').some((e) => e.type === 'dispatch_held')).toBe(false)
    } finally {
      clearGatewayEnv()
      delete process.env.ORCH_CLAUDE_CLI
      delete process.env.ORCH_ZCODE_CLI
      m.close()
    }
  }, 60_000)

  it('快照缺席（fleetState 不可得）→ 放行（fail-open：观测缺失绝不阻断派发）', async () => {
    const repo = makeRepo('proto-pass-nosnap')
    const h = fakeHome() // 无网关环境（gateway.json 发现隔离，不摸真实 8687）
    let exitCode: number | null = null
    try {
      // 无网关环境：预检① admin-unavailable、② fleet-state-unavailable，双双 fail-open
      const decision = await decideDispatchForRun({
        repoRoot: repo.root,
        cfg: { gatewayAdmin: true, worker: { backend: 'claude-headless', model: 'glm-5.3-flash' } },
        meta: { id: 'proto-pass-nosnap' },
        defaultBackend: 'claude-headless',
        explicit: false,
        inherited: false,
        tier: TIER,
        fleetState: null,
        holdExit: (c: number) => {
          exitCode = c
        },
      })
      expect(exitCode).toBeNull()
      expect(decision.backend).toBe('claude-headless')
      expect(fs.existsSync(repo.card)).toBe(true)
      expect(eventsOf(repo.root, 'proto-pass-nosnap').some((e) => e.type === 'dispatch_held')).toBe(false)
    } finally {
      h.restore()
      fs.rmSync(repo.root, { recursive: true, force: true })
    }
  }, 60_000)

  it('预检①首个命中即滞留：模型缺席 + 协议也不兼容 → model_unavailable 落位（无协议字段叠加）', async () => {
    const m = await startAdminMock({
      'GET /_modeldock/config': {
        providers: [{ id: 'prov-glm', name: 'GLM', protocol: 'openai', protocols: ['openai'], models: [] }],
        profiles: [],
        harness: [{ id: 'claude-code', attached: true, pointing: 'gateway', protocols: ['anthropic'] }],
      },
      'GET /_modeldock/metrics': { providers: {}, meltdown: [] },
      'POST /_modeldock/tier-validate': { ok: true, harness: 'claude-code', profile: 'p-glm', provider: 'prov-glm', tier: 'ahead-4', models: ['glm-5.3-flash'], tier_profiles: {} },
      'GET /_modeldock/model-availability': { ok: true, availability: { 'prov-glm': { ok: true, fetched_at: new Date().toISOString(), model_ids: ['glm-other'] } } },
    })
    const repo = makeRepo('proto-avail-first')
    let exitCode: number | null = null
    try {
      setGatewayEnv(m.url)
      writeCliProbeStubs(tmpDir('orch-proto-cli3-'))
      const cfg = { gatewayAdmin: true, worker: { backend: 'claude-headless', model: 'glm-5.3-flash' } }
      const fleetState = await fetchFleetState(cfg)
      await decideDispatchForRun({
        repoRoot: repo.root,
        cfg,
        meta: { id: 'proto-avail-first' },
        defaultBackend: 'claude-headless',
        explicit: false,
        inherited: false,
        tier: TIER,
        fleetState,
        holdExit: (c: number) => {
          exitCode = c
        },
      })
      expect(exitCode).toBe(0)
      const events = eventsOf(repo.root, 'proto-avail-first')
      const held = events.find((e) => e.type === 'dispatch_held')
      expect(held).toMatchObject({ reason: 'model_unavailable', provider: 'prov-glm', model: 'glm-5.3-flash' })
      expect(held && 'harness' in (held as Record<string, unknown>)).toBe(false) // 首个命中即滞留：②未参与
      expect(m.tierHits()).toBe(1)
    } finally {
      clearGatewayEnv()
      delete process.env.ORCH_CLAUDE_CLI
      delete process.env.ORCH_ZCODE_CLI
      m.close()
    }
  }, 60_000)
})

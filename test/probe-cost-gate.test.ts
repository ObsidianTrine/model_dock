// 成本知情闸验收（provider-probe-suite 任务 6）：
// - 引擎层：未确认 0 上游请求（预估照常返回）；确认后恰好发出预估目标数的请求（N 目标 = 恰 N 次）
// - 计划展开：per-key 探针逐把 key 各一目标，per_probe_cost = 档位上限 × 目标数
// - 端点：POST /_modeldock/probe/run 两段式确认 token 闸（无/错 token 只出预估），GET verdicts/ledger
// - CLI：--json 含 per_probe_cost；--yes 仅单探针单目标放行；FAKE_HOME 沙箱 + mock 上游冒烟
//   （provider test p1 输出 verdict 行且退出码 0）
// 端到端全部走 server.listen(0) 随机端口 / tsx 子进程 + fakeHome 隔离，无模块 mock（isolate:false 雷区规避）。

import { describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { fakeHome, REPO_ROOT, TSX_LOADER } from './helpers.js'
import { buildRuntime } from '../src/gateway/state.js'
import { buildProbePlan, resolveProbeModel, runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeTransport } from '../src/gateway/probe/engine.js'
import { applyVerdictEvidence, getProbeVerdict, keyFingerprint } from '../src/gateway/probe/verdict.js'
import { getProbeRunner } from '../src/gateway/probe/runners/index.js'
import { readProbeLedger } from '../src/gateway/probe/ledger.js'
import { logsDir } from '../src/util/paths.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { mutateConfig } from '../src/config/store.js'
import { setSecret } from '../src/config/secrets.js'
import type { Config } from '../src/config/types.js'

// mock 上游：P1 canary 语义（200 + MODELDOCK-OK 回显 + usage），带命中计数供「0 请求/恰 N 请求」断言
async function startCanaryUpstream(): Promise<{ port: number; hits: () => number; close: () => void }> {
  let hits = 0
  const server = http.createServer((_req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({ model: 'm1', content: [{ type: 'text', text: 'MODELDOCK-OK' }], usage: { input_tokens: 5, output_tokens: 2 } })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  return {
    port,
    hits: () => hits,
    close: () => {
      server.closeAllConnections?.()
      server.close()
    },
  }
}

const canaryTransport: ProbeTransport = async () => ({
  status: 200,
  ms: 2,
  bodyText: JSON.stringify({ content: [{ type: 'text', text: 'MODELDOCK-OK' }], usage: { input_tokens: 5, output_tokens: 2 } }),
  usage: { input_tokens: 5, output_tokens: 2 }, // 生产 transport 会从响应体解析 usage，mock 直供同值
})

describe('probe-cost-gate · 计划展开与预估', () => {
  it('per-key 探针逐把 key 展开，per_probe_cost = 档位上限 × 目标数', async () => {
    const h = fakeHome()
    try {
      const cfg = {
        version: 1,
        providers: {
          a: {
            name: 'A',
            base_url: 'http://upstream.invalid',
            protocol: 'anthropic',
            auth_style: 'bearer',
            key_ref: 'plain:k1',
            keys: ['plain:k1', 'plain:k2', 'plain:k3'],
            models: { m1: { source: 'manual' } },
          },
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRuntime(cfg, 'tok')
      const plan = await buildProbePlan(rt, 'a', ['p1', 'p2'])
      expect(plan.model).toBe('m1')
      expect(plan.keys).toHaveLength(3)
      // P2 per-key：3 把 key 各一目标（keyIndex 保留池位）；P1 只探主 key 一目标
      expect(plan.units.filter((u) => u.probeId === 'p2')).toHaveLength(3)
      expect(plan.units.filter((u) => u.probeId === 'p2').map((u) => u.target.keyIndex)).toEqual([0, 1, 2])
      expect(plan.units.filter((u) => u.probeId === 'p1')).toHaveLength(1)
      expect(plan.planned).toBe(4)
      expect(plan.perProbeCost).toEqual({ p1: 200, p2: 600 })
      expect(plan.estimate).toBe(800)
      // 指纹口径：8 位十六进制、绝不含 key 明文
      for (const k of plan.keys) expect(k.fp).toMatch(/^[0-9a-f]{8}$/)
    } finally {
      h.restore()
    }
  })

  it('换 key 销账：buildProbePlan 计划期清掉孤儿 key 的旧 verdict（存活指纹与「-」占位保留）', async () => {
    const h = fakeHome()
    try {
      const cfg = {
        version: 1,
        providers: {
          a: {
            name: 'A',
            base_url: 'http://upstream.invalid',
            protocol: 'anthropic',
            auth_style: 'bearer',
            key_ref: 'plain:k1',
            keys: ['plain:k1'],
            models: { m1: { source: 'manual' } },
          },
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = buildRuntime(cfg, 'tok')
      const at = Date.now()
      // 旧 key 指纹上的 auth-dead（换 key 前的 401）+ 被动「-」占位
      applyVerdictEvidence(rt, { provider: 'a', keyFp: keyFingerprint('k1'), model: 'm1', source: 'probe:p1', kind: 'canary', state: 'auth-dead', evidence: { at, status: 401 } })
      applyVerdictEvidence(rt, { provider: 'a', keyFp: '-', model: 'm1', source: 'passive:p15', kind: 'passive', state: 'auth-dead', evidence: { at, status: 401 } })
      expect(getProbeVerdict(rt, 'a', keyFingerprint('k1'), 'm1')).toBeDefined()
      // keys 换成 k9 后重新出计划：k1 指纹结论销账，「-」占位保留，新 key 尚无结论
      ;(cfg.providers.a as Record<string, unknown>).keys = ['plain:k9']
      await buildProbePlan(rt, 'a', ['p1'])
      expect(getProbeVerdict(rt, 'a', keyFingerprint('k1'), 'm1')).toBeUndefined()
      expect(getProbeVerdict(rt, 'a', '-', 'm1')).toBeDefined()
      expect(getProbeVerdict(rt, 'a', keyFingerprint('k9'), 'm1')).toBeUndefined()
      expect(rt.probeVerdicts?.size).toBe(1)
    } finally {
      h.restore()
    }
  })
})

describe('probe-cost-gate · 探针模型解析（probe-model-select）', () => {
  const mkCfg = (providerOver: Record<string, unknown>, profiles: Record<string, unknown>): Config =>
    ({
      version: 1,
      providers: {
        a: {
          name: 'A',
          base_url: 'http://upstream.invalid',
          protocol: 'anthropic',
          auth_style: 'bearer',
          key_ref: 'plain:k1',
          models: { m1: { source: 'manual' }, m2: { source: 'manual' } },
          ...providerOver,
        },
      },
      profiles,
      harness: {},
    }) as unknown as Config

  it('无 probe_model：服务默认模型（profile default_model）优先于表首；buildProbePlan 采用之', async () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime(mkCfg({}, { main: { provider: 'a', default_model: 'm2' } }), 'tok')
      rt.config.active_profile = 'main'
      const plan = await buildProbePlan(rt, 'a', ['p1'])
      expect(plan.model).toBe('m2')
    } finally {
      h.restore()
    }
  })

  it('probe_model 显式指定（便宜模型）优先于默认模型；指到表外值回落默认模型', async () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime(mkCfg({ probe_model: 'm1' }, { main: { provider: 'a', default_model: 'm2' } }), 'tok')
      rt.config.active_profile = 'main'
      expect((await buildProbePlan(rt, 'a', ['p1'])).model).toBe('m1')
      // config.toml 手编错值：非法回落，不炸
      rt.config.providers.a.probe_model = 'no-such'
      expect((await buildProbePlan(rt, 'a', ['p1'])).model).toBe('m2')
    } finally {
      h.restore()
    }
  })

  it('无 profile / profile 未设 default_model：回落模型表第一项；resolveProbeModel 对未知服务/空模型表返回空串', async () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime(mkCfg({}, {}), 'tok')
      expect((await buildProbePlan(rt, 'a', ['p1'])).model).toBe('m1') // 表首兜底
      rt.config.profiles.main = { provider: 'a', default_model: 'gone' } // default_model 不在表内 → 仍回落表首
      expect((await buildProbePlan(rt, 'a', ['p1'])).model).toBe('m1')
      expect(resolveProbeModel(rt.config, 'missing')).toBe('')
      const rt2 = buildRuntime(mkCfg({ models: {} }, {}), 'tok')
      expect(resolveProbeModel(rt2.config, 'a')).toBe('')
    } finally {
      h.restore()
    }
  })
})

describe('probe-cost-gate · 引擎确认闸', () => {
  it('未确认：上游请求数为 0，预估照常返回', async () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 'tok')
      let calls = 0
      const transport: ProbeTransport = async () => {
        calls++
        return { status: 200, ms: 1 }
      }
      const targets = [
        { providerId: 'a', model: 'm', keyFp: 'f1' },
        { providerId: 'a', model: 'm', keyFp: 'f2' },
        { providerId: 'a', model: 'm', keyFp: 'f3' },
      ]
      const r = await runProbeSuite(rt, { probeIds: ['p1'], targets, transport, runnerFor: getProbeRunner })
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('unconfirmed')
      expect(r.upstreamRequests).toBe(0)
      expect(calls).toBe(0)
      expect(r.estimate).toBe(600) // S 档 200 × 3 目标
    } finally {
      h.restore()
    }
  })

  it('确认后恰好发出预估目标数的请求（N 目标 = 恰 N 次），账本逐次留痕', async () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 'tok')
      let calls = 0
      const transport: ProbeTransport = async () => {
        calls++
        return canaryTransport({ providerId: 'a', model: 'm' })
      }
      const targets = [
        { providerId: 'a', model: 'm', keyFp: 'f1' },
        { providerId: 'a', model: 'm', keyFp: 'f2' },
        { providerId: 'a', model: 'm', keyFp: 'f3' },
      ]
      const r = await runProbeSuite(rt, { probeIds: ['p1'], targets, transport, runnerFor: getProbeRunner, confirmed: true })
      expect(r.ok).toBe(true)
      expect(r.upstreamRequests).toBe(3)
      expect(calls).toBe(3)
      expect(r.estimate).toBe(600)
      expect(r.verdicts).toHaveLength(3)
      expect(r.verdicts.every((v) => v.state === 'healthy')).toBe(true)
      // 账本逐次留痕：每目标一条八字段条目，实际/预估 tokens 落对
      const entries = await readProbeLedger()
      expect(entries).toHaveLength(3)
      for (const e of entries) {
        expect(e.tag).toBe('probe')
        expect(e.probe_id).toBe('p1')
        expect(e.tokens).toBe(7)
        expect(e.estimated_tokens).toBe(200)
      }
    } finally {
      h.restore()
    }
  })
})

// ===== 端点（POST /_modeldock/probe/run 两段式确认 + GET verdicts/ledger）=====

const ADMIN = 'admin-tok-costgate'

function endpointCfg(upstreamPort: number, probe?: Config['probe']): Config {
  return {
    version: 1,
    active_profile: 'demo',
    security: { store: 'file' },
    providers: {
      pv: {
        name: 'PV',
        base_url: `http://127.0.0.1:${upstreamPort}`,
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'plain:sk-pv-costgate',
        models: { m1: { source: 'manual' } },
      },
    },
    profiles: { demo: { provider: 'pv', default_model: 'm1' } },
    harness: {},
    ...(probe ? { probe } : {}),
  } as never as Config
}

async function setupEndpoint(cfg: Config) {
  const h = fakeHome()
  const rt = buildRuntime(cfg, ADMIN)
  const server = createGatewayServer(rt, { port: 0, autoHolidayRefresh: false, autoCatalogRefresh: false, autoModelProbe: false })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const post = (p: string, body: unknown): Promise<{ status: number; body: string }> =>
    fetch(`http://127.0.0.1:${port}/_modeldock/${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-modeldock-admin': ADMIN },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.text() }))
  const get = (p: string): Promise<{ status: number; body: string }> =>
    fetch(`http://127.0.0.1:${port}/_modeldock/${p}`, { headers: { 'x-modeldock-admin': ADMIN } }).then(async (r) => ({ status: r.status, body: await r.text() }))
  return {
    rt,
    post,
    get,
    close: () => {
      server.closeAllConnections?.()
      server.close()
      h.restore()
    },
  }
}

describe('probe-cost-gate · POST /_modeldock/probe/run 确认 token 闸', () => {
  it('无 token/错 token 只出预估（0 上游请求）；正确 token 执行并落 verdict 与账本', async () => {
    const up = await startCanaryUpstream()
    const t = await setupEndpoint(endpointCfg(up.port))
    try {
      // 第一段：无 confirmToken → needConfirm + 预估 + confirmToken，上游零请求
      const r1 = await t.post('probe/run', { provider: 'pv', probes: ['p1'] })
      expect(r1.status).toBe(200)
      const j1 = JSON.parse(r1.body) as { ok: boolean; needConfirm: boolean; targets: number; estimate: number; per_probe_cost: Record<string, number>; confirmToken: string }
      expect(j1.ok).toBe(false)
      expect(j1.needConfirm).toBe(true)
      expect(j1.targets).toBe(1)
      expect(j1.estimate).toBe(200)
      expect(j1.per_probe_cost).toEqual({ p1: 200 })
      expect(j1.confirmToken).toMatch(/^[0-9a-f]{32}$/)
      expect(up.hits()).toBe(0)
      // 错 token：同样只出预估，不放行
      const r2 = await t.post('probe/run', { provider: 'pv', probes: ['p1'], confirmToken: 'bogus' })
      const j2 = JSON.parse(r2.body) as { needConfirm: boolean }
      expect(j2.needConfirm).toBe(true)
      expect(up.hits()).toBe(0)
      // 第二段：正确 confirmToken → 执行，恰好 1 次上游请求，verdict healthy
      const r3 = await t.post('probe/run', { provider: 'pv', probes: ['p1'], confirmToken: j1.confirmToken })
      expect(r3.status).toBe(200)
      const j3 = JSON.parse(r3.body) as { ok: boolean; upstreamRequests: number; targets: number; verdicts: Array<{ provider: string; state: string; key_fp: string; model: string }> }
      expect(j3.ok).toBe(true)
      expect(j3.upstreamRequests).toBe(1)
      expect(j3.targets).toBe(1)
      expect(j3.verdicts).toHaveLength(1)
      expect(j3.verdicts[0].state).toBe('healthy')
      expect(j3.verdicts[0].provider).toBe('pv')
      expect(j3.verdicts[0].key_fp).toMatch(/^[0-9a-f]{8}$/)
      expect(up.hits()).toBe(1)
      // GET verdicts：三元组视图可读（徽标列数据源）
      const gv = await t.get('probe/verdicts')
      const jv = JSON.parse(gv.body) as { ok: boolean; verdicts: Array<{ provider: string; state: string }> }
      expect(jv.ok).toBe(true)
      expect(jv.verdicts.some((v) => v.provider === 'pv' && v.state === 'healthy')).toBe(true)
      // GET ledger：月度聚合 + 按探针分解 + 展示名映射
      const gl = await t.get('probe/ledger')
      const jl = JSON.parse(gl.body) as { ok: boolean; budget: { budget: number }; breakdown: { total: number; by_probe: Record<string, number>; by_probe_requests: Record<string, number> }; probe_labels: Record<string, string> }
      expect(jl.ok).toBe(true)
      expect(jl.breakdown.total).toBeGreaterThan(0)
      expect(jl.breakdown.by_probe.p1).toBeGreaterThan(0)
      expect(jl.breakdown.by_probe_requests.p1).toBe(1)
      expect(jl.probe_labels.p1).toContain('||')
    } finally {
      t.close()
      up.close()
    }
  })

  it('[probe].enabled=false：400 可操作报错，零上游请求', async () => {
    const up = await startCanaryUpstream()
    const t = await setupEndpoint(endpointCfg(up.port, { enabled: false }))
    try {
      const r = await t.post('probe/run', { provider: 'pv', probes: ['p1'] })
      expect(r.status).toBe(400)
      expect(r.body).toContain('enabled=false')
      expect(up.hits()).toBe(0)
    } finally {
      t.close()
      up.close()
    }
  })

  it('未知探针 / 未知服务 / 缺 provider：400 带可用清单', async () => {
    const up = await startCanaryUpstream()
    const t = await setupEndpoint(endpointCfg(up.port))
    try {
      const r1 = await t.post('probe/run', { provider: 'pv', probes: ['p99'] })
      expect(r1.status).toBe(400)
      expect(r1.body).toContain('p99')
      expect(r1.body).toContain('p1')
      const r2 = await t.post('probe/run', { provider: 'ghost' })
      expect(r2.status).toBe(400)
      expect(r2.body).toContain('ghost')
      const r3 = await t.post('probe/run', {})
      expect(r3.status).toBe(400)
      expect(r3.body).toContain('provider')
    } finally {
      t.close()
      up.close()
    }
  })
})

// ===== CLI（tsx 子进程 + FAKE_HOME 沙箱 + mock 上游）=====

// 子进程必须异步 spawn：mock 上游就在本测试进程里，spawnSync 会阻塞事件循环——
// 子进程的探针请求到达 listen backlog 后无人应答，60s 响应头超时、退出码 1（实测踩中）
function runCli(args: string[], sandbox: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, path.join(REPO_ROOT, 'src', 'cli.ts'), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, MODELRDOCK_FAKE_HOME: sandbox },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += String(c)))
    child.stderr.on('data', (c) => (stderr += String(c)))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('cli subprocess timeout'))
    }, 120_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code ?? -1, stdout, stderr })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

async function seedCliProvider(port: number): Promise<void> {
  await mutateConfig((c) => {
    c.security = { store: 'file' }
    c.providers['pv'] = {
      name: 'PV',
      base_url: `http://127.0.0.1:${port}`,
      protocol: 'anthropic',
      auth_style: 'bearer',
      key_ref: 'file:pv',
      models: { m1: { source: 'manual' } },
    }
  })
  await setSecret('pv', 'sk-pv-costgate', 'file')
}

function parseCliJson(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf('{')
  expect(start).toBeGreaterThanOrEqual(0)
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>
}

describe('probe-cost-gate · CLI provider test 成本闸与冒烟', () => {
  it('--json 未确认：预估（per_probe_cost/needConfirm），上游 0 请求，退出码 0', async () => {
    const up = await startCanaryUpstream()
    const h = fakeHome()
    try {
      await seedCliProvider(up.port)
      const r = await runCli(['provider', 'test', 'pv', '--probe', 'p1', '--json'], h.home)
      expect(r.status).toBe(0)
      const j = parseCliJson(r.stdout) as { needConfirm: boolean; estimate: number; per_probe_cost: Record<string, number>; targets: number }
      expect(j.needConfirm).toBe(true)
      expect(j.targets).toBe(1)
      expect(j.estimate).toBe(200)
      expect(j.per_probe_cost).toEqual({ p1: 200 }) // 验收：CLI --json 输出含 per_probe_cost 字段
      expect(up.hits()).toBe(0) // 未确认 → 上游请求数为 0
    } finally {
      h.restore()
      up.close()
    }
  })

  it('--json --yes 单探针单目标：确认后恰好 1 次上游请求，verdict healthy，账本落盘', async () => {
    const up = await startCanaryUpstream()
    const h = fakeHome()
    try {
      await seedCliProvider(up.port)
      const r = await runCli(['provider', 'test', 'pv', '--probe', 'p1', '--json', '--yes'], h.home)
      expect(r.status).toBe(0)
      const j = parseCliJson(r.stdout) as { ok: boolean; targets: number; upstreamRequests: number; per_probe_cost: Record<string, number>; verdicts: Array<{ state: string }> }
      expect(j.ok).toBe(true)
      expect(j.upstreamRequests).toBe(j.targets)
      expect(j.upstreamRequests).toBe(1) // 确认后恰好发出预估目标数的请求
      expect(j.per_probe_cost).toEqual({ p1: 200 })
      expect(j.verdicts[0].state).toBe('healthy')
      expect(up.hits()).toBe(1)
      // 账本落盘（沙箱 logs/probe-ledger.jsonl）
      const ledgerFile = path.join(logsDir(), 'probe-ledger.jsonl')
      const lines = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter((l) => l.trim())
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ tag: 'probe', probe_id: 'p1', provider: 'pv', model: 'm1' })
    } finally {
      h.restore()
      up.close()
    }
  })

  it('--json --yes 多探针目标（2 单元）：不放行，仍回 needConfirm', async () => {
    const up = await startCanaryUpstream()
    const h = fakeHome()
    try {
      await seedCliProvider(up.port)
      const r = await runCli(['provider', 'test', 'pv', '--probe', 'p1,p12', '--json', '--yes'], h.home)
      expect(r.status).toBe(0)
      const j = parseCliJson(r.stdout) as { needConfirm: boolean; targets: number; per_probe_cost: Record<string, number> }
      expect(j.needConfirm).toBe(true)
      expect(j.targets).toBe(2)
      expect(j.per_probe_cost).toEqual({ p1: 200, p12: 200 })
      expect(up.hits()).toBe(0)
    } finally {
      h.restore()
      up.close()
    }
  })

  it('冒烟：provider test p1 --yes 输出 verdict 行且退出码 0（FAKE_HOME 沙箱 + mock 上游）', async () => {
    const up = await startCanaryUpstream()
    const h = fakeHome()
    try {
      await seedCliProvider(up.port)
      const r = await runCli(['provider', 'test', 'pv', '--probe', 'p1', '--yes'], h.home)
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('pv · m1 · key ')
      expect(r.stdout).toContain('健康')
      expect(r.stdout).toContain('✓')
      expect(up.hits()).toBe(1)
    } finally {
      h.restore()
      up.close()
    }
  })
})

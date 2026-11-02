// 任务等级（tier）→ 凭据/模型：解析规则、目录校验、端到端事件留痕。
// tiers.mjs 纯函数直测 + mkRepo/mock 后端闭环（凭据走环境变量，token 不入库）。

import { describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { validateCard } from '../../.agents/scripts/orchestrator/queue.mjs'
import { normalizeTierName, resolveTier, tierDisplayName, tierEnvPatch, validateTierModel } from '../../.agents/scripts/orchestrator/tiers.mjs'
import { writeWorkerSettings } from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'
import { spawn } from 'node:child_process'
import { cardText, mkRepo, runOrch, tryOrch, eventsOf } from './helpers.js'

const CFG = {
  tiers: {
    'ahead-1': { tokenEnv: 'T_A1' },
    'ahead-2': { tokenEnv: 'T_A2' },
    'ahead-3': { tokenEnv: 'T_A3' },
    'ahead-4': { tokenEnv: 'T_A4', workerModel: 'flagship-x', reviewModel: 'judge-x', provider: 'ark', gatewayBase: 'http://127.0.0.1:1' },
  },
  corePaths: ['src/gateway/server.ts'],
  releasePaths: [],
}

describe('tiers > resolveTier', () => {
  it('未配置 tiers / 无卡 tier 且不命中核心路径 → null（静默默认路由）', () => {
    expect(resolveTier({}, { tiers: {}, corePaths: [] })).toBeNull()
    expect(resolveTier({ files_hint: ['docs/a.md'] }, CFG)).toBeNull()
  })

  it('显式点名 + token 就位 → 全量生效；模型/服务字段透传', () => {
    const t = resolveTier({ tier: 'ahead-4' }, CFG, { T_A4: 'tok-1' })
    expect(t).toMatchObject({ name: 'ahead-4', token: 'tok-1', tokenEnv: 'T_A4', workerModel: 'flagship-x', reviewModel: 'judge-x', provider: 'ark', auto: false })
  })

  it('旧别名 heavy/light 永远兼容：自动映射 前进4/前进2（ahead-4/ahead-2）', () => {
    expect(resolveTier({ tier: 'heavy' }, CFG, { T_A4: 'tok' })).toMatchObject({ name: 'ahead-4', token: 'tok' })
    expect(resolveTier({ tier: 'light' }, CFG, { T_A2: 'tok' })).toMatchObject({ name: 'ahead-2', token: 'tok' })
    expect(resolveTier({ tier: 'heavy' }, CFG, {})).toMatchObject({ inactive: 'token', name: 'ahead-4', tokenEnv: 'T_A4' })
  })

  it('车钟显示名：ahead-N → 前进N；别名一并映射；未知名字原样', () => {
    expect(tierDisplayName('ahead-1')).toBe('前进1')
    expect(tierDisplayName('ahead-4')).toBe('前进4')
    expect(tierDisplayName('heavy')).toBe('前进4')
    expect(tierDisplayName('light')).toBe('前进2')
    expect(tierDisplayName('custom-tier')).toBe('custom-tier')
    expect(normalizeTierName('heavy')).toBe('ahead-4')
    expect(normalizeTierName('ahead-3')).toBe('ahead-3')
  })

  it('显式点名但键未配置 / token 环境变量未设 → inactive（不抛错，调用方决定告警口径）', () => {
    expect(resolveTier({ tier: 'nope' }, CFG, {})).toMatchObject({ inactive: 'unconfigured', name: 'nope' })
    expect(resolveTier({ tier: 'ahead-4' }, CFG, {})).toMatchObject({ inactive: 'token', name: 'ahead-4', tokenEnv: 'T_A4' })
  })

  it('自动升级：files_hint 命中 corePaths → ahead-4（前进4）/auto；未命中不升级；token 未设仍标 inactive', () => {
    const hit = resolveTier({ files_hint: ['src/gateway/other.ts'] }, CFG, { T_A4: 'tok' })
    expect(hit).toMatchObject({ name: 'ahead-4', auto: true, token: 'tok' })
    expect(resolveTier({ files_hint: ['docs/a.md'] }, CFG, { T_A4: 'tok' })).toBeNull()
    expect(resolveTier({ files_hint: ['src/gateway/other.ts'] }, CFG, {})).toMatchObject({ inactive: 'token', auto: true })
  })
})

describe('tiers > tierEnvPatch', () => {
  it('有 token 注入 ANTHROPIC_AUTH_TOKEN；无 token / 无 tier → 空（不覆盖子进程环境）', () => {
    expect(tierEnvPatch({ token: 't' })).toEqual({ ANTHROPIC_AUTH_TOKEN: 't' })
    expect(tierEnvPatch({ inactive: 'token' })).toEqual({})
    expect(tierEnvPatch(null)).toEqual({})
  })
})

describe('tiers > 目录校验 validateTierModel', () => {
  const catalog = JSON.stringify({ data: [{ id: 'flagship-x' }, { id: 'b-model' }] })

  function serve(status: number, body: string): Promise<{ url: string; close: () => void }> {
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(body)
      })
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number }
        resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() })
      })
    })
  }

  it('模型在目录内 → ok；不在 → missing 列出', async () => {
    const s = await serve(200, catalog)
    try {
      expect(await validateTierModel({ gatewayBase: s.url, token: 't', provider: 'ark', models: ['flagship-x'] })).toEqual({ ok: true, missing: [] })
      const miss = await validateTierModel({ gatewayBase: s.url, token: 't', provider: 'ark', models: ['flagship-x', 'ghost-1'] })
      expect(miss.ok).toBe(false)
      expect((miss as { missing: string[] }).missing).toEqual(['ghost-1'])
    } finally {
      s.close()
    }
  })

  it('非 200 / 端口不通 / 未配 gatewayBase → ok:false 可告警，不抛异常', async () => {
    const s = await serve(404, '{}')
    try {
      expect((await validateTierModel({ gatewayBase: s.url, token: 't', provider: 'nope', models: ['m'] })).ok).toBe(false)
    } finally {
      s.close()
    }
    expect((await validateTierModel({ gatewayBase: 'http://127.0.0.1:1', token: 't', provider: 'ark', models: ['m'] })).ok).toBe(false)
    expect((await validateTierModel({ gatewayBase: null as unknown as string, token: 't', provider: 'ark', models: ['m'] })).ok).toBe(false)
    // 无模型可查 → 直接通过（不发起请求）
    expect(await validateTierModel({ gatewayBase: null as unknown as string, token: 't', provider: 'ark', models: [] })).toEqual({ ok: true, missing: [] })
  })
})

describe('tiers > 配置解析与卡校验', () => {
  it('workflow.json tiers 解析：合法保留、坏形状丢弃、缺省空表', () => {
    const repo = mkRepo()
    try {
      const p = path.join(repo.root, '.agents', 'workflow.json')
      fs.writeFileSync(p, JSON.stringify({ baseBranch: 'develop', testCmd: 'x', tiers: { heavy: { tokenEnv: 'T' }, bad: 'nope', 'Bad-Key': {} } }))
      const cfg = loadWorkflowConfig(repo.root)
      expect(cfg.tiers.heavy).toMatchObject({ tokenEnv: 'T' })
      expect(Object.keys(cfg.tiers)).toEqual(['heavy'])
      fs.writeFileSync(p, JSON.stringify({ baseBranch: 'develop', testCmd: 'x' }))
      expect(loadWorkflowConfig(repo.root).tiers).toEqual({})
    } finally {
      repo.cleanup()
    }
  })

  it('任务卡 tier：合法通过；非法形状 fail-fast', () => {
    expect(validateCard({ ...cardBase(), tier: 'heavy' }).tier).toBe('heavy')
    for (const bad of ['Heavy', 'a b', '']) {
      expect(() => validateCard({ ...cardBase(), tier: bad })).toThrow(/tier/)
    }
  })

  function cardBase() {
    return {
      id: 't-tier',
      type: 'bugfix',
      files_hint: ['a.txt'],
      workflows: ['feature-branch'],
      budget: { max_turns: 1, max_tokens: 1000, max_wall_minutes: 1, max_test_iterations: 1, max_review_iterations: 1 },
    }
  }
})

describe('tiers > settings 注入', () => {
  it('writeWorkerSettings 带 envPatch 时写入 settings.env；不带保持仅 hooks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-set-'))
    try {
      const withEnv = JSON.parse(fs.readFileSync(writeWorkerSettings(path.join(dir, 'a.json'), { ANTHROPIC_AUTH_TOKEN: 'tok' }), 'utf8'))
      expect(withEnv.env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'tok' })
      expect(withEnv.hooks.PreToolUse).toBeTruthy()
      const plain = JSON.parse(fs.readFileSync(writeWorkerSettings(path.join(dir, 'b.json')), 'utf8'))
      expect(plain.env).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tiers > run 端到端（mock）', () => {
  it('显式 tier：token 注入生效，tier_resolved / worker_spawned 留痕 tier 模型', () => {
    const repo = mkRepo()
    try {
      fs.writeFileSync(
        path.join(repo.root, '.agents', 'workflow.json'),
        JSON.stringify({
          baseBranch: 'develop',
          testCmd: 'node -e "process.exit(0)"',
          tiers: { 'ahead-4': { tokenEnv: 'MDK_TEST_TIER_TOKEN', workerModel: 'flagship-x' } },
        }),
      )
      // 旧别名卡（tier: heavy）同样解析到 ahead-4——历史卡不返工
      const cardFile = path.join(repo.root, 'c.md')
      fs.writeFileSync(cardFile, cardText({ tier: 'heavy' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run test-task --backend mock', { MDK_TEST_TIER_TOKEN: 'tok-e2e' })
      const ev = eventsOf(repo.root, 'test-task')
      const resolved = ev.find((e) => e.type === 'tier_resolved') as Record<string, unknown> | undefined
      expect(resolved).toMatchObject({ tier: 'ahead-4', worker_model: 'flagship-x' })
      const spawned = ev.find((e) => e.type === 'worker_spawned') as Record<string, unknown> | undefined
      expect(spawned?.model).toBe('flagship-x')
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('zcode 船（默认引擎）卡带 tier：不告警（档位纯留痕，zcode 不支持 tier 是设计）', () => {
    const repo = mkRepo({ workerBackend: 'zcode-headless' })
    try {
      fs.writeFileSync(
        path.join(repo.root, '.agents', 'workflow.json'),
        JSON.stringify({
          baseBranch: 'develop',
          testCmd: 'node -e "process.exit(0)"',
          worker: { backend: 'zcode-headless' },
          tiers: { 'ahead-2': { tokenEnv: 'MDK_TEST_TIER_LIGHT_TOKEN' } },
        }),
      )
      const cardFile = path.join(repo.root, 'c.md')
      fs.writeFileSync(cardFile, cardText({ tier: 'ahead-2' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      // 不带 --backend：走 workflow.json 默认引擎 zcode-headless（静默场景）。
      // ORCH_ZCODE_CLI 指向不存在的桩：tier_resolved 落盘后 worker spawn 即 ENOENT
      // blocked——全机器确定性，不真调 zcode、不依赖本机 CLI。
      const out = tryOrch(repo.root, 'run test-task', { ORCH_ZCODE_CLI: '/nonexistent/zcode-cli' })
      expect(out.stdout + out.stderr).not.toContain('tier "ahead-2" 未生效')
      const resolved = eventsOf(repo.root, 'test-task').find((e) => e.type === 'tier_resolved') as Record<string, unknown> | undefined
      expect(resolved).toMatchObject({ tier: 'ahead-2', inactive: 'token' }) // 事件留痕照旧
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('显式 tier 未配置 → 告警降级不阻断；tier_resolved 记 inactive', () => {
    const repo = mkRepo()
    try {
      fs.writeFileSync(
        path.join(repo.root, '.agents', 'workflow.json'),
        JSON.stringify({
          baseBranch: 'develop',
          testCmd: 'node -e "process.exit(0)"',
          tiers: { 'ahead-2': { tokenEnv: 'MDK_TEST_TIER_LIGHT_TOKEN' } },
        }),
      )
      // 卡点名 ahead-2，token 环境变量未设 → inactive: token
      const cardFile = path.join(repo.root, 'c.md')
      fs.writeFileSync(cardFile, cardText({ tier: 'ahead-2' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      const out = runOrch(repo.root, 'run test-task --backend mock', {})
      expect(out.stdout).toContain('tier "ahead-2" 未生效')
      expect(out.stdout).toContain('MDK_TEST_TIER_LIGHT_TOKEN')
      const resolved = eventsOf(repo.root, 'test-task').find((e) => e.type === 'tier_resolved') as Record<string, unknown> | undefined
      expect(resolved).toMatchObject({ tier: 'ahead-2', inactive: 'token' })
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------
// 网关权威校验（gatewayAdmin；2026-11-02 admin 面授权 .agents 使用）
// ---------------------------------------------------------------------------

import { createGatewayServer } from '../../src/gateway/server.js'
import { buildRuntime } from '../../src/gateway/state.js'
import { discoverGatewayState, tierTagNames, validateTierViaGateway } from '../../.agents/scripts/orchestrator/tiers.mjs'
import { readCard } from './helpers.js'
import { fakeHome } from '../helpers.js'
import type { AddressInfo } from 'node:net'

describe('tiers > 网关权威校验（validateTierViaGateway）', () => {
  function serveVerdict(status: number, body: unknown): Promise<{ url: string; hits: () => number; lastReq: () => { admin?: string; body?: unknown }; close: () => void }> {
    let hits = 0
    let lastReq: { admin?: string; body?: unknown } = {}
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        hits++
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          // 回调内不做断言（脱离测试上下文的抛出会变成 Unhandled Error）：记录、事后核对
          lastReq = { admin: req.headers['x-modeldock-admin'] as string | undefined, body: JSON.parse(raw || '{}') }
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        })
      })
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as AddressInfo
        resolve({ url: `http://127.0.0.1:${port}`, hits: () => hits, lastReq: () => lastReq, close: () => s.close() })
      })
    })
  }

  it('tierTagNames：别名归一同键（ahead-4 ≡ heavy）；显示名不收', () => {
    expect(tierTagNames('ahead-4').sort()).toEqual(['ahead-4', 'heavy'])
    expect(tierTagNames('heavy').sort()).toEqual(['ahead-4', 'heavy'])
    expect(tierTagNames('custom-tier')).toEqual(['custom-tier'])
  })

  it('optIn=false 一律 unavailable 且零请求（可移植工具链不得默认读用户 ModelDock 状态）', async () => {
    const s = await serveVerdict(200, {})
    try {
      const r = await validateTierViaGateway({ token: 'tok-1', tier: 'ahead-4', base: s.url, adminToken: 'adm-tok', optIn: false })
      expect(r).toMatchObject({ mode: 'unavailable' })
      expect(r.reason).toContain('gatewayAdmin')
      expect(s.hits()).toBe(0)
    } finally {
      s.close()
    }
  })

  it('optIn + 显式 base/token：权威 ok 判定回传字段齐全（models/tierProfiles 映射）', async () => {
    const s = await serveVerdict(200, {
      ok: true, harness: 'tier-worker', profile: 'heavy', provider: 'A', tier: 'ahead-4',
      models: ['m1'], tier_profiles: { 'ahead-4': ['heavy'], light: ['light'] },
    })
    try {
      const r = await validateTierViaGateway({ token: 'tok-1', tier: 'ahead-4', base: s.url, adminToken: 'adm-tok', optIn: true })
      expect(s.lastReq()).toEqual({ admin: 'adm-tok', body: { token: 'tok-1', tier: 'ahead-4' } }) // admin 凭据必带；token 只进请求体
      expect(r).toMatchObject({ mode: 'gateway', ok: true, harness: 'tier-worker', profile: 'heavy', provider: 'A', tierTag: 'ahead-4' })
      expect((r as { models: string[] }).models).toEqual(['m1'])
      expect((r as { tierProfiles: Record<string, string[]> }).tierProfiles).toEqual({ 'ahead-4': ['heavy'], light: ['light'] })
    } finally {
      s.close()
    }
  })

  it('权威否定（token 未注册）≠ 观测缺席：mode=gateway ok=false；401/404/端口不通 = unavailable', async () => {
    const s = await serveVerdict(200, { ok: false, reason: 'unknown_token' })
    try {
      expect(await validateTierViaGateway({ token: 'tok-1', tier: 'ahead-4', base: s.url, adminToken: 'adm-tok', optIn: true })).toMatchObject({ mode: 'gateway', ok: false, reason: 'unknown_token' })
    } finally {
      s.close()
    }
    const s401 = await serveVerdict(401, {})
    try {
      expect((await validateTierViaGateway({ token: 't', base: s401.url, adminToken: 'adm-tok', optIn: true })).mode).toBe('unavailable')
    } finally {
      s401.close()
    }
    const s404 = await serveVerdict(404, {})
    try {
      expect((await validateTierViaGateway({ token: 't', base: s404.url, adminToken: 'adm-tok', optIn: true })).mode).toBe('unavailable') // 旧版网关回落 advisory
    } finally {
      s404.close()
    }
    expect((await validateTierViaGateway({ token: 't', base: 'http://127.0.0.1:1', adminToken: 'adm-tok', optIn: true })).mode).toBe('unavailable')
  })

  it('discoverGatewayState：fakeHome 重定向优先；缺失/残缺 → null', () => {
    const h = fakeHome()
    try {
      expect(discoverGatewayState()).toBeNull() // 空 fake home
      const gw = path.join(h.home, '.modeldock', 'gateway.json')
      fs.mkdirSync(path.dirname(gw), { recursive: true })
      fs.writeFileSync(gw, JSON.stringify({ pid: 1, port: 18999, admin_token: 'gw-tok' }))
      expect(discoverGatewayState()).toEqual({ port: 18999, adminToken: 'gw-tok' })
      fs.writeFileSync(gw, '{"broken')
      expect(discoverGatewayState()).toBeNull()
      fs.writeFileSync(gw, JSON.stringify({ pid: 1, port: 18999 })) // 缺 admin_token
      expect(discoverGatewayState()).toBeNull()
    } finally {
      h.restore()
    }
  })
})

describe('tiers > 网关权威校验端到端（gatewayAdmin: true，独立进程 stub 网关）', () => {
  const TIER_TOKEN = 'mdk_tier_tok_e2e'
  const ADMIN = 'orch-admin-tok'

  // stub 网关必须是独立子进程：vitest 套件 isolate:false 单进程，runOrch 的同步 execSync
  // 会阻塞事件循环，进程内 HTTP 服务器在 child fetch 期间无法应答（4s 超时，实测踩中）。
  // 端点的真实行为已由 gateway.test.ts 的 tier-validate 用例覆盖，这里只供编排侧消费。
  function startTierStub(verdict: Record<string, unknown>): Promise<{ base: string; kill: () => void }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-stub-'))
    const script = path.join(dir, 'gw.cjs')
    fs.writeFileSync(
      script,
      `const http = require('node:http')\nconst verdict = ${JSON.stringify(verdict)}\n` +
        `const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(verdict)) })\n` +
        `s.listen(0, '127.0.0.1', () => { console.log('PORT=' + s.address().port); setInterval(() => {}, 1 << 30) })\n`,
    )
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout.on('data', (c) => {
        out += String(c)
        const m = /PORT=(\d+)/.exec(out)
        if (m) resolve({ base: `http://127.0.0.1:${m[1]}`, kill: () => child.kill() })
      })
      child.on('error', reject)
    })
  }

  function submitTierCard(repo: string) {
    const cardFile = path.join(repo, 'c.md')
    fs.writeFileSync(cardFile, cardText({ tier: 'heavy' }))
    runOrch(repo, `submit "${cardFile}"`)
  }

  function tierWorkflow(gatewayAdmin: boolean) {
    return JSON.stringify({
      baseBranch: 'develop',
      testCmd: 'node -e "process.exit(0)"',
      ...(gatewayAdmin ? { gatewayAdmin: true } : {}),
      tiers: { 'ahead-4': { tokenEnv: 'MDK_TEST_TIER_TOKEN' } },
    })
  }

  const RUN_ENV = { MDK_TEST_TIER_TOKEN: TIER_TOKEN, ORCH_GATEWAY_ADMIN_TOKEN: ADMIN }

  it('tier 已打标但 token 指向无标签 profile → 权威校验阻断（exit 1，卡留 pending 零事件）', async () => {
    const gw = await startTierStub({ ok: true, harness: 'tier-worker', profile: 'plain', provider: 'A', tier: null, models: [], tier_profiles: { 'ahead-4': ['heavy'] } })
    const repo = mkRepo()
    try {
      fs.writeFileSync(path.join(repo.root, '.agents', 'workflow.json'), tierWorkflow(true))
      submitTierCard(repo.root)
      const out = tryOrch(repo.root, 'run test-task --backend mock', { ...RUN_ENV, ORCH_GATEWAY_BASE: gw.base })
      expect(out.status).toBe(1)
      expect(out.stdout + out.stderr).toContain('权威校验失败')
      expect(out.stdout + out.stderr).toContain('plain')
      expect(readCard(repo.root, 'pending', 'test-task')).toBeTruthy() // 状态迁移前阻断
      expect(eventsOf(repo.root, 'test-task')).toEqual([]) // die 先于任何事件
    } finally {
      repo.cleanup()
      gw.kill()
    }
  }, 120_000)

  it('token 钉定同 tier profile → 照常派发，tier_resolved 留 gateway 字段', async () => {
    const gw = await startTierStub({ ok: true, harness: 'tier-worker', profile: 'heavy', provider: 'A', tier: 'ahead-4', models: ['flagship-x'], tier_profiles: { 'ahead-4': ['heavy'] } })
    const repo = mkRepo()
    try {
      fs.writeFileSync(path.join(repo.root, '.agents', 'workflow.json'), tierWorkflow(true))
      submitTierCard(repo.root)
      const out = runOrch(repo.root, 'run test-task --backend mock', { ...RUN_ENV, ORCH_GATEWAY_BASE: gw.base })
      expect(out.stdout).toContain('tier 网关校验')
      const resolved = eventsOf(repo.root, 'test-task').find((e) => e.type === 'tier_resolved') as Record<string, unknown> | undefined
      expect(resolved).toMatchObject({ tier: 'ahead-4', gateway_checked: true, gateway_profile: 'heavy', gateway_tier: 'ahead-4' })
    } finally {
      repo.cleanup()
      gw.kill()
    }
  }, 120_000)

  it('未开启 gatewayAdmin（缺省）→ 行为不变：不打网关、advisory only', async () => {
    const gw = await startTierStub({ ok: true, harness: 'tier-worker', profile: 'plain', provider: 'A', tier: null, models: [], tier_profiles: { 'ahead-4': ['heavy'] } })
    const repo = mkRepo()
    try {
      fs.writeFileSync(path.join(repo.root, '.agents', 'workflow.json'), tierWorkflow(false))
      submitTierCard(repo.root)
      const out = runOrch(repo.root, 'run test-task --backend mock', { ...RUN_ENV, ORCH_GATEWAY_BASE: gw.base }) // env 在，但 optIn 关 → 不发请求
      expect(out.stdout + out.stderr).not.toContain('权威校验失败')
      expect(out.stdout).not.toContain('tier 网关校验')
      const resolved = eventsOf(repo.root, 'test-task').find((e) => e.type === 'tier_resolved') as Record<string, unknown> | undefined
      expect(resolved).toMatchObject({ tier: 'ahead-4' })
      expect(resolved?.gateway_checked).toBeUndefined()
    } finally {
      repo.cleanup()
      gw.kill()
    }
  }, 120_000)
})

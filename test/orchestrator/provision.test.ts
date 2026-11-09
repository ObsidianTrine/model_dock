// provision.mjs 测试（B16 每任务一次性凭据 ephemeral harness 接入）：
//   - provisionTaskHarness / revokeTaskHarness 对 mock admin server（listen(0) 随机端口）
//   - fail-open：admin 未配置 / 网关不可达 / 超时 / 非 2xx / 响应缺字段 → { ok:false }（调用方回落 tier token）
//   - 确定性 id（orch-<taskId>）+ 400 冲突自动降级为无 id 重试
//   - revoke 幂等：200 revoked:false 与 404 一律成功；网络失败 ok:false（调用方 best-effort）
//   - findUnrevokedHarnessId / applyEphemeralToken 纯函数（接管找陈账、只注 token 不注 base_url）
//   - claude-headless 双通道：一次性 token 并入 env patch 后 settings.env 与子进程 env 同见
//   - poller 按一次性 harnessId 精确取数（同响应内其他 harness 用量不污染）
//   - E2E（mock 网关子进程 + mkRepo + MODELRDOCK_FAKE_HOME 独立沙箱）：开关开 → provision/revoke
//     事件与网关请求；失败 fail-open；开关关零请求；接管路径吊销上次 run 陈账；zcode env 透传

import http from 'node:http'
import { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { Budget } from '../../.agents/scripts/orchestrator/budget.mjs'
import { startMeasuredFuelPoller } from '../../.agents/scripts/orchestrator/supply.mjs'
import {
  PROVISION_TIMEOUT_MS,
  applyEphemeralToken,
  findUnrevokedHarnessId,
  provisionTaskHarness,
  revokeTaskHarness,
} from '../../.agents/scripts/orchestrator/provision.mjs'
import { claudeSpawnInvocation, newWorkerSettingsPath, writeWorkerSettings } from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'
import { cardText, eventsOf, mkRepo, readCard, runOrch } from './helpers.js'

type Json = Record<string, unknown>
interface Req { url: string; method: string; body: Json; auth: boolean }

/** 进程内 mock admin server：handler 按 url 出 [code, body]，全请求记录进 requests。 */
async function startMockAdmin(
  handler: (url: string, body: Json, req: http.IncomingMessage) => [number, unknown] | Promise<[number, unknown]>,
): Promise<{ port: number; requests: Req[]; close: () => void }> {
  const requests: Req[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      let body: Json = {}
      try { body = JSON.parse(raw || '{}') } catch { /* 空体 */ }
      requests.push({ url: req.url ?? '', method: req.method ?? '', body, auth: req.headers['x-modeldock-admin'] === 'admin-test' })
      const [code, out] = await handler(req.url ?? '', body, req)
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

const PROVISION_OK = (id: string) => ({
  ok: true,
  id,
  token: `eph-tok-${id}`,
  expires_at: '2026-11-09T00:00:00.000Z',
  env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'x', OPENAI_BASE_URL: 'x', OPENAI_API_KEY: 'x' },
})

describe('provision > provisionTaskHarness（mock admin server）', () => {
  it('成功：确定性 id（orch-<taskId>）+ admin 头 + 响应映射（harnessId/token/expiresAt/env）', async () => {
    const gw = await startMockAdmin((url, body) => {
      expect(url).toBe('/_modeldock/harness/provision')
      return [200, PROVISION_OK(String(body.id))]
    })
    try {
      const r = await provisionTaskHarness(GA(gw.port), { taskId: 'fix-presets-merge' })
      expect(r).toMatchObject({ ok: true, harnessId: 'orch-fix-presets-merge', token: 'eph-tok-orch-fix-presets-merge', expiresAt: '2026-11-09T00:00:00.000Z' })
      expect((r as { env: Json }).env).toHaveProperty('ANTHROPIC_AUTH_TOKEN')
      expect(gw.requests).toHaveLength(1)
      expect(gw.requests[0].auth).toBe(true)
      expect(gw.requests[0].body.id).toBe('orch-fix-presets-merge')
    } finally {
      gw.close()
    }
  })

  it('ttlHours/maxDailyTokens 传参：ttl 收敛分钟、>24h 收敛到网关硬顶 1440', async () => {
    const gw = await startMockAdmin(() => [200, PROVISION_OK('orch-t')])
    try {
      await provisionTaskHarness(GA(gw.port), { taskId: 't', ttlHours: 8, maxDailyTokens: 12345.6 })
      expect(gw.requests[0].body.ttl_minutes).toBe(480)
      expect(gw.requests[0].body.max_daily_tokens).toBe(12345)
      await provisionTaskHarness(GA(gw.port), { taskId: 't', ttlHours: 99 })
      expect(gw.requests[1].body.ttl_minutes).toBe(1440)
      await provisionTaskHarness(GA(gw.port), { taskId: 't', ttlHours: -3 }) // 非法不传，走网关缺省
      expect(gw.requests[2].body.ttl_minutes).toBeUndefined()
    } finally {
      gw.close()
    }
  })

  it('400（id 冲突）自动降级为无 id 重试一次，仍成功', async () => {
    const gw = await startMockAdmin((_url, body) => (body.id ? [400, { ok: false, reason: 'harness id 已存在' }] : [200, PROVISION_OK('eph-random')]))
    try {
      const r = await provisionTaskHarness(GA(gw.port), { taskId: 't' })
      expect(r).toMatchObject({ ok: true, harnessId: 'eph-random' })
      expect(gw.requests).toHaveLength(2)
      expect(gw.requests[0].body.id).toBe('orch-t')
      expect(gw.requests[1].body.id).toBeUndefined()
    } finally {
      gw.close()
    }
  })

  it('失败形态全 fail-open：401 / 500 / 响应缺 token / 不可达超时 / admin 未配置，均 { ok:false } 不抛出', async () => {
    const gw401 = await startAdminWithCode(401)
    const gw500 = await startAdminWithCode(500)
    const gwBad = await startMockAdmin(() => [200, { ok: true, id: 'x' }]) // 缺 token
    try {
      expect(await provisionTaskHarness(GA(gw401.port), { taskId: 't' })).toMatchObject({ ok: false })
      expect(await provisionTaskHarness(GA(gw500.port), { taskId: 't' })).toMatchObject({ ok: false })
      expect(await provisionTaskHarness(GA(gwBad.port), { taskId: 't' })).toMatchObject({ ok: false })
      expect((await provisionTaskHarness(GA(gw500.port), { taskId: 't' })).reason).toContain('500')
      const dead = await provisionTaskHarness({ base: 'http://127.0.0.1:1', adminToken: 'x' }, { taskId: 't', timeoutMs: 300 })
      expect(dead.ok).toBe(false)
      expect(String((dead as { reason: string }).reason)).toContain('不可达')
      expect((await provisionTaskHarness(null, { taskId: 't' })).ok).toBe(false)
      expect((await provisionTaskHarness({ base: 'not-a-url', adminToken: 'x' }, { taskId: 't' })).ok).toBe(false)
    } finally {
      for (const g of [gw401, gw500, gwBad]) g.close()
    }
  })

  it('超时上限常量 ≤3s（AGENTS 硬性约束）', () => {
    expect(PROVISION_TIMEOUT_MS).toBeLessThanOrEqual(3000)
  })
})

async function startAdminWithCode(code: number) {
  return startMockAdmin(() => [code, { ok: false }])
}

describe('provision > revokeTaskHarness（幂等）', () => {
  it('200 revoked:true / revoked:false（不在册幂等放行）/ 404（已失效）一律 ok:true', async () => {
    const gw = await startMockAdmin((url) => {
      expect(url).toBe('/_modeldock/harness/revoke')
      return [200, { ok: true, revoked: true }]
    })
    const gwGone = await startMockAdmin(() => [200, { ok: true, revoked: false }])
    const gw404 = await startMockAdmin(() => [404, { ok: false }])
    try {
      expect(await revokeTaskHarness(GA(gw.port), 'orch-t')).toEqual({ ok: true, revoked: true })
      expect(await revokeTaskHarness(GA(gwGone.port), 'orch-t')).toEqual({ ok: true, revoked: false })
      expect(await revokeTaskHarness(GA(gw404.port), 'orch-t')).toEqual({ ok: true, revoked: false })
      expect(gw.requests[0].body).toEqual({ id: 'orch-t' })
    } finally {
      for (const g of [gw, gwGone, gw404]) g.close()
    }
  })

  it('网络失败 / 401 → ok:false（调用方 best-effort 只告警）；无 harnessId / 无 admin → 不发请求', async () => {
    const gw = await startAdminWithCode(500)
    try {
      expect((await revokeTaskHarness(GA(gw.port), 'orch-t')).ok).toBe(false)
      const dead = await revokeTaskHarness({ base: 'http://127.0.0.1:1', adminToken: 'x' }, 'orch-t', { timeoutMs: 300 })
      expect(dead.ok).toBe(false)
      expect(await revokeTaskHarness(GA(gw.port), '')).toEqual({ ok: true, revoked: false })
      expect(await revokeTaskHarness(null, 'orch-t').then((r) => r.ok)).toBe(false)
      expect(gw.requests).toHaveLength(1) // 后两次没发请求
    } finally {
      gw.close()
    }
  })
})

describe('provision > 纯函数', () => {
  it('findUnrevokedHarnessId：最新签发无成功吊销 → 返回 id；吊销失败（ok:false）不算已吊销', () => {
    expect(findUnrevokedHarnessId([])).toBeNull()
    expect(findUnrevokedHarnessId([{ type: 'worker_spawned' }])).toBeNull()
    expect(findUnrevokedHarnessId([{ type: 'harness_provisioned', harness_id: 'a' }])).toBe('a')
    expect(
      findUnrevokedHarnessId([
        { type: 'harness_provisioned', harness_id: 'a' },
        { type: 'harness_revoked', harness_id: 'a', ok: true },
      ]),
    ).toBeNull()
    // 失败的吊销不算：接管路径要再试
    expect(
      findUnrevokedHarnessId([
        { type: 'harness_provisioned', harness_id: 'a' },
        { type: 'harness_revoked', harness_id: 'a', ok: false, reason: '网关返回 500' },
      ]),
    ).toBe('a')
    // 只看最新一条签发：旧凭据的吊销记录不影响新凭据
    expect(
      findUnrevokedHarnessId([
        { type: 'harness_provisioned', harness_id: 'old' },
        { type: 'harness_revoked', harness_id: 'old', ok: true },
        { type: 'harness_provisioned', harness_id: 'new' },
      ]),
    ).toBe('new')
  })

  it('applyEphemeralToken：只注 ANTHROPIC_AUTH_TOKEN（不注 base_url）；失败/无 token 原样返回', () => {
    const pr = { ok: true as const, harnessId: 'h', token: 'eph-x', expiresAt: null, env: null }
    expect(applyEphemeralToken({ FOO: 'bar' }, pr)).toEqual({ FOO: 'bar', ANTHROPIC_AUTH_TOKEN: 'eph-x' })
    expect(applyEphemeralToken({}, pr)).toEqual({ ANTHROPIC_AUTH_TOKEN: 'eph-x' })
    expect(applyEphemeralToken({ A: 1 }, { ok: false, reason: 'x' } as never)).toEqual({ A: 1 })
    expect(applyEphemeralToken({ A: 1 }, null)).toEqual({ A: 1 })
    expect(applyEphemeralToken(undefined, pr)).toEqual({ ANTHROPIC_AUTH_TOKEN: 'eph-x' })
  })
})

describe('provision > claude-headless 双通道（一次性 token）', () => {
  it('并入 env patch 后 settings.env 与子进程 env 同见（token 明文不落 events）', async () => {
    const gw = await startMockAdmin(() => [200, PROVISION_OK('orch-dual')])
    try {
      const pr = (await provisionTaskHarness(GA(gw.port), { taskId: 'dual' })) as { token: string }
      const env = applyEphemeralToken({}, pr)
      // 通道 1：--settings 文件 env（settings.env 优先级高于用户级 settings.json）
      const settingsPath = newWorkerSettingsPath()
      try {
        writeWorkerSettings(settingsPath, env, null)
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
        expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('eph-tok-orch-dual')
        expect(settings.env).not.toHaveProperty('ANTHROPIC_BASE_URL')
      } finally {
        fs.rmSync(path.dirname(settingsPath), { recursive: true, force: true })
      }
      // 通道 2：子进程 env
      for (const platform of ['win32', 'linux'] as const) {
        const inv = claudeSpawnInvocation(platform, ['-p'], { cwd: '.', envPatch: env })
        expect(inv.options.env?.ANTHROPIC_AUTH_TOKEN).toBe('eph-tok-orch-dual')
        expect(inv.options.env).not.toHaveProperty('ANTHROPIC_BASE_URL')
      }
    } finally {
      gw.close()
    }
  })
})

describe('provision > 实测油量按一次性 harnessId 精确取数', () => {
  it('usage 同响应多 harness：poller 只认 ephemeral id，兄弟 harness 流量不污染基线', async () => {
    const gw = await startMockAdmin((url) => {
      expect(url).toBe('/_modeldock/harness-usage')
      return [200, { ok: true, usage: { 'worker-tier': { day_billable_tokens: 9_999_999 }, 'orch-eph-task': { day_billable_tokens: 500 } } }]
    })
    const b = new Budget({ meta: { budget: { max_tokens: 100_000, max_wall_minutes: 10 } } })
    const envKeys = ['ORCH_GATEWAY_BASE', 'ORCH_GATEWAY_ADMIN_TOKEN']
    const saved: Record<string, string | undefined> = {}
    for (const k of envKeys) {
      saved[k] = process.env[k]
      process.env[k] = k === 'ORCH_GATEWAY_BASE' ? `http://127.0.0.1:${gw.port}` : 'admin-test'
    }
    try {
      const p = startMeasuredFuelPoller({ budget: b, cfg: { gatewayAdmin: true }, harness: 'orch-eph-task', intervalMs: 30 })
      expect(p.active).toBe(true)
      await new Promise((r) => setTimeout(r, 400))
      p.stop()
      expect(b.measuredBaseline).toBe(500) // 只取本任务专属 harness 的实测值
      expect(b.measuredBillable).toBe(0)
      expect(b.tripped).toBe(false)
    } finally {
      gw.close()
      for (const k of envKeys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  }, 10_000)
})

// ---------------------------------------------------------------------------
// E2E（mock 网关子进程 + mkRepo）：run 全链路的 provision/revoke 生命周期
// ---------------------------------------------------------------------------

describe('provision > run E2E（mock 网关子进程）', () => {
  // mock 网关必须活在独立子进程里（runOrch 用 execSync 同步阻塞主进程事件循环，同进程
  // http server 无人应答——supply.test.ts 同款教训）。状态文件逐请求读（用例间翻转 flag），
  // 请求流水追加写 requests.jsonl 供断言。
  const MOCK_GW_SCRIPT = `
import http from 'node:http'
import fs from 'node:fs'
const [stateFile, reqFile] = process.argv.slice(2)
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let state = {}
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch {}
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch {}
    const rec = { url: req.url, method: req.method, body, auth: req.headers['x-modeldock-admin'] === 'admin-test' }
    fs.appendFileSync(reqFile, JSON.stringify(rec) + '\\n')
    const finish = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (!rec.auth) return finish(401, { ok: false, reason: 'unauthorized' })
    if (req.url === '/_modeldock/harness/provision') {
      if (state.provisionConflict && body.id) return finish(400, { ok: false, reason: 'id 已存在' })
      const id = body.id || 'eph-random-1'
      return finish(200, { ok: true, id, token: 'eph-tok-' + id, expires_at: '2026-11-09T00:00:00.000Z', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'x', OPENAI_BASE_URL: 'x', OPENAI_API_KEY: 'x' } })
    }
    if (req.url === '/_modeldock/harness/revoke') {
      if (state.failRevoke) return finish(500, { ok: false, reason: 'injected' })
      return finish(200, { ok: true, revoked: true })
    }
    if (req.url === '/_modeldock/harness-usage') return finish(200, { ok: true, usage: {} })
    finish(404, { ok: false })
  })
})
server.listen(0, '127.0.0.1', () => console.log('PORT:' + server.address().port))
`

  async function startMockGatewayProcess(): Promise<{ port: number; requests: () => Req[]; setState: (s: Json) => void; close: () => void }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gwmock-'))
    const stateFile = path.join(dir, 'state.json')
    const reqFile = path.join(dir, 'requests.jsonl')
    const scriptFile = path.join(dir, 'mock-gw.mjs')
    fs.writeFileSync(stateFile, JSON.stringify({}))
    fs.writeFileSync(scriptFile, MOCK_GW_SCRIPT)
    const child = spawn(process.execPath, [scriptFile, stateFile, reqFile], { stdio: ['ignore', 'pipe', 'pipe'] })
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
      requests: () => (fs.existsSync(reqFile) ? fs.readFileSync(reqFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Req) : []),
      setState: (s: Json) => fs.writeFileSync(stateFile, JSON.stringify(s)),
      close: () => {
        child.kill()
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

  function submitCard(repo: string, id: string) {
    const cardFile = path.join(repo, `card-${id}.md`)
    fs.writeFileSync(cardFile, cardText({ id }))
    runOrch(repo, `submit "${cardFile}"`)
  }

  const envFor = (port: number, extra: Record<string, string> = {}) => ({
    ORCH_GATEWAY_BASE: `http://127.0.0.1:${port}`,
    ORCH_GATEWAY_ADMIN_TOKEN: 'admin-test',
    MODELRDOCK_FAKE_HOME: path.join(os.tmpdir(), `orch-prov-fakehome-${process.pid}-${Math.random().toString(36).slice(2, 8)}`),
    ...extra,
  })

  const provReqs = (reqs: Req[]) => reqs.filter((r) => r.url === '/_modeldock/harness/provision')
  const revokeReqs = (reqs: Req[]) => reqs.filter((r) => r.url === '/_modeldock/harness/revoke')

  afterAll(() => {
    // MODELRDOCK_FAKE_HOME 目录在断言后即无价值（仅 discoverGatewayState 的读落点）；
    // mkRepo 各用例自己清理，fakehome 统一惰性——不追杀（os.tmpdir 由系统回收）。
  })

  it('开关开 + 网关在线：spawn 前签发、收尾即吊销（事件 + 网关请求双向对账）', async () => {
    const gw = await startMockGatewayProcess()
    const repo = mkRepo({ extra: { gatewayAdmin: true, gatewayProvision: true } })
    try {
      submitCard(repo.root, 'prov-e2e')
      runOrch(repo.root, 'run prov-e2e --backend mock', envFor(gw.port))
      // 网关侧：1 签发（确定性 id）+ 1 吊销
      const reqs = gw.requests()
      expect(provReqs(reqs)).toHaveLength(1)
      expect(provReqs(reqs)[0].body.id).toBe('orch-prov-e2e')
      expect(provReqs(reqs)[0].auth).toBe(true)
      expect(revokeReqs(reqs)).toHaveLength(1)
      expect(revokeReqs(reqs)[0].body).toEqual({ id: 'orch-prov-e2e' })
      // 事件侧：provisioned（含 expires_at）→ revoked（run_exit，ok）
      const evts = eventsOf(repo.root, 'prov-e2e')
      const prov = evts.find((e) => e.type === 'harness_provisioned')
      expect(prov).toMatchObject({ harness_id: 'orch-prov-e2e', expires_at: '2026-11-09T00:00:00.000Z' })
      const rev = evts.find((e) => e.type === 'harness_revoked')
      expect(rev).toMatchObject({ harness_id: 'orch-prov-e2e', ok: true, trigger: 'run_exit' })
      // 任务照常落位（gate L3 → awaiting-human），无 fail-open 痕迹
      expect(evts.some((e) => e.type === 'harness_provision_failed')).toBe(false)
      expect(readCard(repo.root, 'awaiting-human', 'prov-e2e')).toBeTruthy()
    } finally {
      gw.close()
      repo.cleanup()
    }
  }, 180_000)

  it('网关不可达：harness_provision_failed 留痕 + fail-open 照常派发落位（行为与未开启一致）', async () => {
    const repo = mkRepo({ extra: { gatewayAdmin: true, gatewayProvision: true } })
    try {
      submitCard(repo.root, 'prov-dead')
      // ORCH_GATEWAY_BASE 指死端口（无 mock 网关）：连接拒绝 → fail-open
      runOrch(repo.root, 'run prov-dead --backend mock', envFor(1))
      const evts = eventsOf(repo.root, 'prov-dead')
      const fail = evts.find((e) => e.type === 'harness_provision_failed')
      expect(fail).toBeTruthy()
      expect(String(fail!.reason)).toContain('不可达')
      expect(evts.some((e) => e.type === 'harness_provisioned')).toBe(false)
      expect(evts.some((e) => e.type === 'harness_revoked')).toBe(false)
      // 任务照常跑完（未产出结果块也不因凭据失败而中断——mock worker 正常 done）
      expect(evts.some((e) => e.type === 'worker_spawned')).toBe(true)
      expect(readCard(repo.root, 'awaiting-human', 'prov-dead')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 180_000)

  it('开关关闭（缺省）：全程零 provision/revoke 请求、零 harness 事件（现状不变）', async () => {
    const gw = await startMockGatewayProcess()
    const repo = mkRepo({ extra: { gatewayAdmin: true } }) // 不配 gatewayProvision
    try {
      submitCard(repo.root, 'prov-off')
      runOrch(repo.root, 'run prov-off --backend mock', envFor(gw.port))
      // 零 harness 生命周期请求（fleet 观测的 config/metrics 是 gatewayAdmin 既有行为，不算）
      const reqs = gw.requests()
      expect(provReqs(reqs)).toHaveLength(0)
      expect(revokeReqs(reqs)).toHaveLength(0)
      const evts = eventsOf(repo.root, 'prov-off')
      expect(evts.some((e) => e.type?.toString().startsWith('harness_'))).toBe(false)
      expect(readCard(repo.root, 'awaiting-human', 'prov-off')).toBeTruthy()
    } finally {
      gw.close()
      repo.cleanup()
    }
  }, 180_000)

  it('接管路径：上次 run 吊销失败留下的陈账，下次 run 启动时先吊销（trigger=takeover）再签新', async () => {
    const gw = await startMockGatewayProcess()
    const repo = mkRepo({ extra: { gatewayAdmin: true, gatewayProvision: true } })
    try {
      submitCard(repo.root, 'prov-take')
      // run 1：吊销被注入失败（网关 500）——陈账留在网关
      gw.setState({ failRevoke: true })
      runOrch(repo.root, 'run prov-take --backend mock', envFor(gw.port))
      let evts = eventsOf(repo.root, 'prov-take')
      expect(evts.find((e) => e.type === 'harness_revoked')).toMatchObject({ ok: false, trigger: 'run_exit' })
      // run 2（awaiting-human 直跑）：接管清理吊销陈账 → 重新签发 → 收尾吊销成功
      gw.setState({ failRevoke: false })
      runOrch(repo.root, 'run prov-take --backend mock', envFor(gw.port))
      evts = eventsOf(repo.root, 'prov-take')
      const revokes = evts.filter((e) => e.type === 'harness_revoked')
      expect(revokes).toHaveLength(3) // run1 失败 + run2 接管 + run2 收尾
      expect(revokes[1]).toMatchObject({ harness_id: 'orch-prov-take', ok: true, trigger: 'takeover' })
      expect(revokes[2]).toMatchObject({ ok: true, trigger: 'run_exit' })
      const provisions = evts.filter((e) => e.type === 'harness_provisioned')
      expect(provisions).toHaveLength(2)
      expect(provisions.every((e) => e.harness_id === 'orch-prov-take')).toBe(true)
      const reqs = gw.requests()
      expect(provReqs(reqs)).toHaveLength(2)
      expect(revokeReqs(reqs)).toHaveLength(3)
      expect(readCard(repo.root, 'awaiting-human', 'prov-take')).toBeTruthy()
    } finally {
      gw.close()
      repo.cleanup()
    }
  }, 240_000)

  it('zcode 后端：一次性 token 经既有 env 透传到子进程；不注 base_url', async () => {
    const gw = await startMockGatewayProcess()
    const repo = mkRepo({ extra: { gatewayAdmin: true, gatewayProvision: true } })
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-zstub-'))
    const stub = path.join(stubDir, 'zstub.cjs')
    // stub：--version 探测放行；worker spawn 时 dump 环境再输出无结果块文本（任务落 blocked，
    // 足以证明 token 到达子进程 env——真实链路里 zcode 对 env 的认属是既有 no-op 风险项，照旧注明）
    fs.writeFileSync(
      stub,
      [
        "const fs = require('node:fs')",
        "if (process.argv.includes('--version')) { console.log('zcode-stub 1.0.0'); process.exit(0) }",
        'const dump = process.env.ORCH_STUB_ENV_DUMP',
        'if (dump) fs.writeFileSync(dump, JSON.stringify({ ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? null, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null }))',
        "console.log(JSON.stringify({ response: 'zcode stub：无结果块（只为验证 env 透传）' }))",
      ].join('\n'),
    )
    const dumpFile = path.join(stubDir, 'env-dump.json')
    try {
      submitCard(repo.root, 'zcode-eph')
      runOrch(repo.root, 'run zcode-eph --backend zcode-headless', envFor(gw.port, { ORCH_ZCODE_CLI: stub, ORCH_STUB_ENV_DUMP: dumpFile }))
      const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf8'))
      expect(dump.ANTHROPIC_AUTH_TOKEN).toBe('eph-tok-orch-zcode-eph') // 签发的临时 token（非 tier、非全局）
      expect(dump.ANTHROPIC_BASE_URL).toBeNull() // 编排器不越权注 base_url
      const evts = eventsOf(repo.root, 'zcode-eph')
      expect(evts.find((e) => e.type === 'harness_provisioned')).toMatchObject({ harness_id: 'orch-zcode-eph' })
      expect(evts.some((e) => e.type === 'worker_spawned' && e.backend === 'zcode-headless')).toBe(true)
      expect(evts.find((e) => e.type === 'harness_revoked')).toMatchObject({ ok: true, trigger: 'run_exit' }) // blocked 落位后 finally 吊销
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true })
      gw.close()
      repo.cleanup()
    }
  }, 180_000)
})

// 动态选船（dynamic dispatch，阶段 3）测试：海况信号 + 卡难度在预授权包络内自动选船。
// 纯函数矩阵（decideDispatch / difficultyPref / normalizeEnvelope / shipSeaBad / seaWeather）
// + 配置解析（缺省关）+ E2E（mock / zcode stub CLI，不烧真钱——换船方向一律
// 「默认 claude-headless → 切到 zcode-headless(stub)」，反向会拉起真 claude CLI）。

import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import {
  DYNAMIC_SHIPS,
  decideDispatch,
  difficultyPref,
  normalizeEnvelope,
  seaWeather,
  shipSeaBad,
} from '../../.agents/scripts/orchestrator/dispatch.mjs'
import { toIsoLocal } from '../../.agents/scripts/orchestrator/events.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { cardText, eventsOf, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

const DD_ON = { dynamicDispatch: { enabled: true, envelope: ['zcode-headless', 'claude-headless'] } }

// 海况健康快照：两船 harness 都接入且指向网关、无熔断
const HEALTHY = {
  mode: 'ok' as const,
  observedAt: 't',
  providers: [{ id: 'p1', models: 1, down: false, lastMs: 1 }],
  harnesses: [
    { id: 'zcode', attached: true, pointing: 'gateway' as const },
    { id: 'claude-code', attached: true, pointing: 'gateway' as const },
  ],
  meltdown: [] as Array<{ provider: string; class: string | null }>,
}

describe('dynamic dispatch > normalizeEnvelope（包络规范化）', () => {
  it('只收真实船型；mock/未知剔除并给原因；去重', () => {
    const r = normalizeEnvelope(['zcode-headless', 'mock', 'bogus', 'zcode-headless', 'claude-headless'])
    expect(r.envelope).toEqual(['zcode-headless', 'claude-headless'])
    expect(r.ignored.map((x) => x.entry)).toEqual(['mock', 'bogus'])
    expect(r.ignored[0].reason).toContain('mock 不参与自动选船')
    expect(r.ignored[1].reason).toContain('未知船型')
  })

  it('非数组/空 → 空包络；DYNAMIC_SHIPS 契约不含 mock', () => {
    expect(normalizeEnvelope('zcode-headless').envelope).toEqual([])
    expect(normalizeEnvelope(undefined).envelope).toEqual([])
    expect(DYNAMIC_SHIPS).toEqual(['claude-headless', 'zcode-headless'])
  })
})

describe('dynamic dispatch > difficultyPref（卡难度偏好）', () => {
  it('tier 档位带：ahead-1/2、light → zcode；ahead-3/4、heavy → claude', () => {
    expect(difficultyPref({ meta: { tier: 'ahead-1' } })).toBe('zcode-headless')
    expect(difficultyPref({ meta: { tier: 'ahead-2' } })).toBe('zcode-headless')
    expect(difficultyPref({ meta: { tier: 'light' } })).toBe('zcode-headless')
    expect(difficultyPref({ meta: { tier: 'ahead-3' } })).toBe('claude-headless')
    expect(difficultyPref({ meta: { tier: 'ahead-4' } })).toBe('claude-headless')
    expect(difficultyPref({ meta: { tier: 'heavy' } })).toBe('claude-headless')
  })

  it('tier 生效（token 在）一律 claude——zcode 不支持 tier，不给它派 tier model', () => {
    expect(difficultyPref({ meta: { tier: 'ahead-1' }, tier: { token: 'tk', tokenEnv: 'X' } })).toBe('claude-headless')
  })

  it('files_hint 命中核心/发布路径 → claude；路径表为空 = 航道未设限不判；无信号 → null', () => {
    const cfg = { corePaths: ['src/gateway/**'], releasePaths: [] }
    expect(difficultyPref({ meta: { files_hint: ['src/gateway/server.ts'] }, cfg })).toBe('claude-headless')
    expect(difficultyPref({ meta: { files_hint: ['**'] }, cfg: { corePaths: [], releasePaths: [] } })).toBeNull()
    expect(difficultyPref({ meta: {} })).toBeNull()
  })
})

describe('dynamic dispatch > shipSeaBad（单船海况）', () => {
  it('dogfood_bypass / not_attached → 恶劣附原因；健康/观测缺席 → 不判', () => {
    const bypass = { ...HEALTHY, harnesses: [{ id: 'claude-code', attached: true, pointing: 'other' as const }] }
    expect(shipSeaBad(bypass, 'claude-headless')).toEqual({ bad: true, reasons: [expect.stringContaining('dogfood_bypass')] })
    const detached = { ...HEALTHY, harnesses: [{ id: 'zcode', attached: false, pointing: 'unknown' as const }] }
    expect(shipSeaBad(detached, 'zcode-headless').bad).toBe(true)
    expect(shipSeaBad(HEALTHY, 'zcode-headless')).toEqual({ bad: false, reasons: [] })
    expect(shipSeaBad(null, 'zcode-headless').bad).toBe(false) // 观测缺席 ≠ 风暴
    expect(shipSeaBad({ mode: 'unavailable', reason: 'x' }, 'zcode-headless').bad).toBe(false)
  })
})

describe('dynamic dispatch > decideDispatch（决策纯函数）', () => {
  const base = { cfg: DD_ON, defaultBackend: 'claude-headless' }

  it('缺省关 / enabled:false / 显式 CLI / resume 沿用 / mock 默认 → 决策完全不参与（行为与历史一致）', () => {
    const idle = { backend: 'claude-headless', model: null, switched: false, lines: [], events: [] }
    expect(decideDispatch({ cfg: {}, defaultBackend: 'claude-headless', meta: { tier: 'ahead-3' } })).toEqual(idle)
    expect(decideDispatch({ cfg: { dynamicDispatch: { enabled: false, envelope: ['zcode-headless'] } }, defaultBackend: 'claude-headless', meta: { tier: 'ahead-3' } })).toEqual(idle)
    expect(decideDispatch({ ...base, explicit: true, meta: { tier: 'ahead-1' } })).toEqual(idle)
    expect(decideDispatch({ ...base, inherited: true, meta: { tier: 'ahead-1' } })).toEqual(idle)
    expect(decideDispatch({ cfg: DD_ON, defaultBackend: 'mock', meta: { tier: 'ahead-3' } })).toEqual({ ...idle, backend: 'mock' })
  })

  it('envelope 无有效船型 → 告警一行、按既有规则派发（不落事件）', () => {
    const r = decideDispatch({ cfg: { dynamicDispatch: { enabled: true, envelope: ['mock'] } }, defaultBackend: 'claude-headless' })
    expect(r.switched).toBe(false)
    expect(r.events).toEqual([])
    expect(r.lines.join('\n')).toContain('envelope 无有效船型')
  })

  it('海况健康 + 无难度信号 → 沿用默认船，零事件零换船', () => {
    const r = decideDispatch({ ...base, fleetState: HEALTHY, meta: {} })
    expect(r).toEqual({ backend: 'claude-headless', model: null, switched: false, lines: [], events: [] })
  })

  it('tier 路由：ahead-1 → zcode 换船 + dispatch_selected 留痕 + models 按船注入', () => {
    const cfg = { dynamicDispatch: { enabled: true, envelope: ['zcode-headless', 'claude-headless'], models: { 'zcode-headless': 'glm-x' } } }
    const r = decideDispatch({ cfg, defaultBackend: 'claude-headless', meta: { tier: 'ahead-1' }, fleetState: HEALTHY })
    expect(r.switched).toBe(true)
    expect(r.backend).toBe('zcode-headless')
    expect(r.model).toBe('glm-x')
    expect(r.events).toEqual([
      { type: 'dispatch_selected', from: 'claude-headless', to: 'zcode-headless', switched: true, reason: expect.stringContaining('卡难度偏好') },
    ])
  })

  it('难度偏好不在包络内 → 不自动切（包络外永不自动切），沿用默认', () => {
    const cfg = { dynamicDispatch: { enabled: true, envelope: ['zcode-headless'] } }
    const r = decideDispatch({ cfg, defaultBackend: 'zcode-headless', meta: { tier: 'ahead-3' }, fleetState: HEALTHY })
    expect(r.switched).toBe(false)
    expect(r.events).toEqual([])
    expect(r.lines.join('\n')).toContain('不在 envelope 内')
  })

  it('所选船海况恶劣 → 换包络内下一个健康船，reason 记恶劣签名', () => {
    const bypass = { ...HEALTHY, harnesses: [{ id: 'claude-code', attached: true, pointing: 'other' as const }] }
    const r = decideDispatch({ ...base, fleetState: bypass, meta: {} })
    expect(r.switched).toBe(true)
    expect(r.backend).toBe('zcode-headless')
    expect(r.events[0]).toMatchObject({ type: 'dispatch_selected', from: 'claude-headless', to: 'zcode-headless', switched: true })
    expect(r.events[0].reason).toContain('dogfood_bypass')
  })

  it('难度偏好船 CLI 不可用 → 回落默认船并留一行日志（不落事件）', () => {
    const r = decideDispatch({ ...base, meta: { tier: 'ahead-1' }, fleetState: HEALTHY, availability: { 'zcode-headless': false } })
    expect(r.switched).toBe(false)
    expect(r.events).toEqual([])
    expect(r.lines.join('\n')).toContain('CLI 不可用')
  })

  it('全港风暴（熔断）→ 按难度本应换船也沿用默认，dispatch_selected switched:false 留痕', () => {
    const storm = { ...HEALTHY, meltdown: [{ provider: 'p1', class: 'quota' }] }
    const r = decideDispatch({ ...base, meta: { tier: 'ahead-1' }, fleetState: storm })
    expect(r.backend).toBe('claude-headless')
    expect(r.switched).toBe(false)
    expect(r.events[0]).toMatchObject({ type: 'dispatch_selected', from: 'claude-headless', to: 'claude-headless', switched: false })
    expect(r.events[0].reason).toContain('服务熔断中')
  })

  it('重试密集（seaWeather 阈值）同属风暴；无难度信号时风暴沿用默认且不落事件', () => {
    const weather = { held: false, retryCount: 3, retryThreshold: 3, windowMinutes: 60, upstream: null }
    const r = decideDispatch({ ...base, meta: { tier: 'ahead-1' }, fleetState: HEALTHY, weather })
    expect(r.switched).toBe(false)
    expect(r.events[0].reason).toContain('worker_retry')
    const noPref = decideDispatch({ ...base, meta: {}, fleetState: HEALTHY, weather })
    expect(noPref.events).toEqual([])
  })

  it('全部恶劣（两船都绕狗粮）→ 沿用默认并留痕', () => {
    const allBad = {
      ...HEALTHY,
      harnesses: [
        { id: 'zcode', attached: true, pointing: 'other' as const },
        { id: 'claude-code', attached: true, pointing: 'other' as const },
      ],
    }
    const r = decideDispatch({ ...base, fleetState: allBad, meta: {} })
    expect(r.backend).toBe('claude-headless')
    expect(r.events[0]).toMatchObject({ from: 'claude-headless', to: 'claude-headless', switched: false })
    expect(r.events[0].reason).toContain('均恶劣')
  })
})

describe('dynamic dispatch > seaWeather（海况装配）', () => {
  it('窗口内 worker_retry 合计；weatherHold 配置达阈 → held；旧事件滑出窗口不计', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dispatch-sea-'))
    try {
      const qdir = path.join(root, '.agents', 'orchestrator', 'logs', 'task-a')
      fs.mkdirSync(qdir, { recursive: true })
      const evt = (type: string, ts: string) => JSON.stringify({ ts, seq: 1, type }) + '\n'
      fs.writeFileSync(path.join(qdir, 'events.jsonl'), evt('worker_retry', new Date().toISOString()))
      const fresh = seaWeather(root, {})
      expect(fresh.retryCount).toBe(1)
      expect(fresh.retryThreshold).toBe(3) // 缺省阈值（与 weatherHold 缺省同口径）
      expect(fresh.held).toBe(false) // weatherHold 未配置：计数在，滞留裁决归风暴闸
      const hold = seaWeather(root, { weatherHold: { threshold: 1, windowMinutes: 60 } })
      expect(hold.held).toBe(true)
      // 窗口滑过：把事件时间戳改到 2 小时前
      fs.writeFileSync(path.join(qdir, 'events.jsonl'), evt('worker_retry', new Date(Date.now() - 2 * 3600_000).toISOString()))
      expect(seaWeather(root, { weatherHold: { threshold: 1, windowMinutes: 60 } }).retryCount).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('上游海况：gatewayLogDir（或 FAKE_HOME 重定向）网关日志 429 计数达阈 → held', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dispatch-gw-'))
    try {
      const gwDir = path.join(fakeHome, '.modeldock', 'logs')
      fs.mkdirSync(gwDir, { recursive: true })
      const date = toIsoLocal(new Date()).slice(0, 10)
      fs.writeFileSync(path.join(gwDir, `gateway-${date}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), status: 429 }) + '\n')
      const cfg = { weatherHold: { threshold: 9, windowMinutes: 60, upstream: { threshold: 1, windowMinutes: 15 } } }
      const prev = process.env.MODELRDOCK_FAKE_HOME
      process.env.MODELRDOCK_FAKE_HOME = fakeHome
      try {
        const w = seaWeather('/nonexistent-repo', cfg)
        expect(w.upstream).toMatchObject({ count: 1, threshold: 1, observed: true })
        expect(w.held).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.MODELRDOCK_FAKE_HOME
        else process.env.MODELRDOCK_FAKE_HOME = prev
      }
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})

describe('dynamic dispatch > 权威海况（sea_state 数据面，A2）', () => {
  const base = { cfg: DD_ON, defaultBackend: 'claude-headless' } // 与上方 decideDispatch describe 的 base 同构
  // 模拟 /_modeldock/metrics 提取出的海况快照（weather.mjs seaSnapshotFromMetricsJson 的产物形状）
  const snap = (over: Record<string, unknown> = {}) => ({
    mode: 'ok' as const,
    at: Date.now(),
    storm: true,
    reasons: ['meltdown_majority'],
    meltdown: ['p9'],
    rate429_5m: 0.1,
    total5m: 40,
    count429_5m: 4,
    countQuota_5m: 0,
    count429_60m: 8,
    countQuota_60m: 1,
    ...over,
  })

  it('seaWeather 注入快照：upstream 改走 metrics（60m 429+quota 真实计数），storm 直通滞留', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dd-sea2-'))
    try {
      const cfg = { weatherHold: { threshold: 9, windowMinutes: 60, upstream: { threshold: 8, windowMinutes: 60 } } }
      const w = seaWeather(root, cfg, { seaSnap: snap() })
      expect(w.sea).toMatchObject({ observed: true, storm: true, meltdown: ['p9'], count429_60m: 8, countQuota_60m: 1 })
      expect(w.upstream).toEqual({ source: 'metrics', count: 9, threshold: 8, windowMinutes: 60, observed: true, storm: true })
      expect(w.held).toBe(true) // storm 直通（count 9 ≥ 8 也独立达阈）
      const calm = seaWeather(root, cfg, { seaSnap: snap({ storm: false, count429_60m: 1, countQuota_60m: 0 }) })
      expect(calm.held).toBe(false)
      expect(calm.upstream).toMatchObject({ source: 'metrics', count: 1 })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('5m 429 率补充信号：率 ≥ 50% 且样本 ≥ 10 → 提前滞留；样本不足视为噪声不判', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dd-sea3-'))
    try {
      const cfg = { weatherHold: { threshold: 9, windowMinutes: 60, upstream: { threshold: 50, windowMinutes: 60 } } }
      const w = seaWeather(root, cfg, { seaSnap: snap({ storm: false, count429_60m: 2, countQuota_60m: 0, rate429_5m: 0.6, total5m: 20 }) })
      expect(w.sea.rate429Breach).toBe(true)
      expect(w.held).toBe(true)
      const noisy = seaWeather(root, cfg, { seaSnap: snap({ storm: false, count429_60m: 0, countQuota_60m: 0, rate429_5m: 0.9, total5m: 4 }) })
      expect(noisy.sea.rate429Breach).toBe(false)
      expect(noisy.held).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('decideDispatch：sea_state.storm 优先 → dispatch_selected reason 带 storm_sea_state；熔断位取 sea 清单（覆盖 fleetState 旧观测）', () => {
    const weather = {
      held: true,
      retryCount: 0,
      retryThreshold: 3,
      windowMinutes: 60,
      upstream: null,
      sea: { observed: true, at: 1, storm: true, reasons: ['meltdown_majority'], meltdown: ['p9'], rate429_5m: 0.1, total5m: 40, count429_60m: 0, countQuota_60m: 0, rate429Breach: false },
    }
    const fleetWithMelt = { ...HEALTHY, meltdown: [{ provider: 'p1', class: 'quota' }] }
    const r = decideDispatch({ ...base, meta: { tier: 'ahead-1' }, fleetState: fleetWithMelt, weather })
    expect(r.switched).toBe(false)
    expect(r.events[0].type).toBe('dispatch_selected')
    expect(r.events[0].reason).toContain('storm_sea_state')
    expect(r.events[0].reason).toContain('p9') // 熔断清单来自权威海况
    expect(r.events[0].reason).not.toContain('p1')
  })

  it('sea 缺席 → 熔断回落 fleetState 观测；worker_retry 回落照常计位（无网关时行为不变）', () => {
    const weather = { held: true, retryCount: 5, retryThreshold: 3, windowMinutes: 60, upstream: null, sea: null }
    const storm = { ...HEALTHY, meltdown: [{ provider: 'p1', class: 'quota' }] }
    const r = decideDispatch({ ...base, meta: { tier: 'ahead-1' }, fleetState: storm, weather })
    expect(r.events[0].reason).toContain('服务熔断中')
    expect(r.events[0].reason).toContain('worker_retry')
  })
})

describe('dynamic dispatch > workflow.json 配置解析', () => {
  function tmpCfg(raw: unknown): ReturnType<typeof loadWorkflowConfig> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dd-cfg-'))
    try {
      fs.mkdirSync(path.join(dir, '.agents'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify(raw))
      return loadWorkflowConfig(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('缺省关（行为回归底线）；显式开启生效；非法值回落并告警', () => {
    expect(tmpCfg({}).dynamicDispatch).toEqual({ enabled: false, envelope: [], models: {} })
    const on = tmpCfg({ dynamicDispatch: { enabled: true, envelope: ['zcode-headless'], models: { 'zcode-headless': 'glm-x' } } })
    expect(on.dynamicDispatch).toEqual({ enabled: true, envelope: ['zcode-headless'], models: { 'zcode-headless': 'glm-x' } })
    expect(tmpCfg({ dynamicDispatch: 'yes' }).dynamicDispatch.enabled).toBe(false)
    expect(tmpCfg({ dynamicDispatch: { enabled: 'on' } }).dynamicDispatch).toEqual({ enabled: false, envelope: [], models: {} })
    expect(tmpCfg({ dynamicDispatch: { enabled: true, envelope: 'zcode' } }).dynamicDispatch.envelope).toEqual([])
    expect(tmpCfg({ dynamicDispatch: { enabled: true, models: 'x' } }).dynamicDispatch.models).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// E2E（mock / zcode stub CLI，不烧真钱）
// ---------------------------------------------------------------------------

/** claude CLI 探测桩：--version exit 0（经 ORCH_CLAUDE_CLI 注入；CI 无 claude CLI，探测桩让海况口径可确定——否则「CLI 不可用」抢在 dogfood_bypass 前留痕）。 */
function writeClaudeProbeStub(dir: string): string {
  const stub = path.join(dir, 'claude-probe-stub.cjs')
  fs.writeFileSync(stub, "if (process.argv.slice(2).includes('--version')) process.exit(0);\n")
  return stub
}

/** zcode CLI 桩：--version 探测 exit 0；-p 会话输出合法契约块（无文件改动 → L0 → L3 卡落 awaiting-human）。 */
function writeZcodeStub(dir: string): string {
  const stub = path.join(dir, 'zcode-stub.cjs')
  fs.writeFileSync(
    stub,
    [
      "const args = process.argv.slice(2);",
      "if (args.includes('--version')) process.exit(0);",
      "const out = [",
      "  'stub zcode worker 完成。',",
      "  '',",
      "  '```agents-result',",
      "  'status: done',",
      "  'summary: stub zcode 完成测试任务',",
      "  'files_changed: []',",
      "  'tests: pass',",
      "  'notes_updated: true',",
      "  '```',",
      "].join('\\n');",
      "process.stdout.write(JSON.stringify({ response: out, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }));",
    ].join('\n'),
  )
  return stub
}

/**
 * admin 面 mock——**独立进程**版：runOrch 走 execSync（同步阻塞 vitest 进程的事件循环），
 * 进程内 http server 在阻塞期间无法应答 run 孙进程的请求（fetch 3s 必超时），故服务
 * 必须落在独立进程里，端口经 stdout 回传。
 */
async function mockAdmin(harness: Array<Record<string, unknown>>, tmpDir: string): Promise<{ url: string; close: () => void }> {
  const file = path.join(tmpDir, 'admin-server.mjs')
  fs.writeFileSync(
    file,
    `import http from 'node:http'
const harness = ${JSON.stringify(harness)}
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.headers['x-modeldock-admin'] !== 'mock-admin') { res.writeHead(401); res.end('{}'); return }
    if (req.url === '/_modeldock/config') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ providers: { p1: { models: [] } }, profiles: [], harness })) }
    else if (req.url === '/_modeldock/metrics') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ providers: {}, meltdown: [] })) }
    else { res.writeHead(404); res.end('{}') }
  })
})
server.listen(0, '127.0.0.1', () => { console.log('PORT ' + server.address().port); setInterval(() => {}, 10000) })
`,
  )
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout! })
    rl.on('line', (l) => {
      const m = /^PORT (\d+)$/.exec(l.trim())
      if (m) resolve(Number(m[1]))
    })
    child.on('exit', (code) => reject(new Error(`admin mock server 提前退出（code=${code}）`)))
  })
  return { url: `http://127.0.0.1:${port}`, close: () => child.kill() }
}

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

afterAll(() => {
  delete process.env.ORCH_GATEWAY_BASE
  delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
})

describe('dynamic dispatch > E2E（缺省关闭回归）', () => {
  it('无 dynamicDispatch 键 / enabled:false：tier 卡行为与历史完全一致，零 dispatch_selected', async () => {
    for (const extra of [{}, { dynamicDispatch: { enabled: false, envelope: ['zcode-headless', 'claude-headless'] } }]) {
      const repo = mkRepo({ extra })
      const id = `dd-off-${Object.keys(extra).length}`
      try {
        submitCard(repo.root, id, { tier: 'ahead-3' })
        const out = runOrch(repo.root, `run ${id} --backend mock`)
        expect(out.stdout).not.toContain('动态选船')
        const ev = eventsOf(repo.root, id)
        expect(ev.some((e) => e.type === 'dispatch_selected')).toBe(false)
        expect(ev.find((e) => e.type === 'worker_spawned')?.backend).toBe('mock')
        expect(ev.some((e) => e.type === 'tier_resolved' && e.tier === 'ahead-3')).toBe(true) // tier 解析链不破坏
        expect(readCard(repo.root, 'awaiting-human', id)).toBeTruthy()
      } finally {
        repo.cleanup()
      }
    }
  }, 240_000)

  it('开启但默认船是 mock：mock 测试链路照常可用（动态选船永不碰 mock）', async () => {
    const repo = mkRepo({ workerBackend: 'mock', extra: DD_ON })
    try {
      submitCard(repo.root, 'dd-mock-chain', { tier: 'ahead-3' })
      const out = runOrch(repo.root, 'run dd-mock-chain')
      expect(out.stdout).not.toContain('动态选船')
      expect(eventsOf(repo.root, 'dd-mock-chain').some((e) => e.type === 'dispatch_selected')).toBe(false)
      expect(readCard(repo.root, 'awaiting-human', 'dd-mock-chain')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 240_000)
})

describe('dynamic dispatch > E2E（引擎切换人工闸门整合）', () => {
  it('包络外请求被拒：envelope 不含目标船 → 闸门照旧拒绝，卡留 pending 零消费', async () => {
    const repo = mkRepo({ workerBackend: 'claude-headless', extra: { dynamicDispatch: { enabled: true, envelope: ['claude-headless'] } } })
    try {
      submitCard(repo.root, 'dd-env-outer')
      const r = tryOrch(repo.root, 'run dd-env-outer --backend zcode-headless')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('切换 CLI 需人工审核')
      expect(r.stderr).toContain('--approve-backend-switch')
      expect(readCard(repo.root, 'pending', 'dd-env-outer')).toBeTruthy()
      expect(eventsOf(repo.root, 'dd-env-outer').some((e) => e.type === 'worker_spawned')).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('mock 仍不在包络：dd 开启也不豁免（mock 永不参与自动选船）', async () => {
    const repo = mkRepo({ workerBackend: 'zcode-headless', extra: DD_ON })
    try {
      submitCard(repo.root, 'dd-env-mock')
      const r = tryOrch(repo.root, 'run dd-env-mock --backend mock')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('切换 CLI 需人工审核')
    } finally {
      repo.cleanup()
    }
  })

  it('包络内显式切换 = 持久批准：不再要求每卡 --approve-backend-switch，任务在目标船跑完', async () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dd-stub-'))
    const repo = mkRepo({ workerBackend: 'claude-headless', extra: DD_ON })
    try {
      const stub = writeZcodeStub(stubDir)
      submitCard(repo.root, 'dd-env-inner')
      const out = runOrch(repo.root, 'run dd-env-inner --backend zcode-headless --review-backend mock', { ORCH_ZCODE_CLI: stub })
      expect(out.stdout).not.toContain('切换 CLI 需人工审核')
      const ev = eventsOf(repo.root, 'dd-env-inner')
      expect(ev.find((e) => e.type === 'worker_spawned')?.backend).toBe('zcode-headless')
      expect(ev.some((e) => e.type === 'dispatch_selected')).toBe(false) // 显式 CLI：动态选船不越权、不留痕
      expect(readCard(repo.root, 'awaiting-human', 'dd-env-inner')).toBeTruthy()
    } finally {
      repo.cleanup()
      fs.rmSync(stubDir, { recursive: true, force: true })
    }
  }, 240_000)
})

describe('dynamic dispatch > E2E（tier 路由换船）', () => {
  it('ahead-1 轻卡：默认 claude-headless → 自动换 zcode-headless，dispatch_selected 留痕并跑完', async () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dd-stub-'))
    const repo = mkRepo({ workerBackend: 'claude-headless', extra: DD_ON })
    try {
      const stub = writeZcodeStub(stubDir)
      submitCard(repo.root, 'dd-tier-light', { tier: 'ahead-1' })
      const out = runOrch(repo.root, 'run dd-tier-light --review-backend mock', { ORCH_ZCODE_CLI: stub })
      expect(out.stdout).toContain('动态选船')
      const ev = eventsOf(repo.root, 'dd-tier-light')
      const sel = ev.find((e) => e.type === 'dispatch_selected')
      expect(sel).toMatchObject({ from: 'claude-headless', to: 'zcode-headless', switched: true })
      expect(String(sel?.reason)).toContain('卡难度偏好')
      expect(ev.find((e) => e.type === 'worker_spawned')?.backend).toBe('zcode-headless')
      expect(readCard(repo.root, 'awaiting-human', 'dd-tier-light')).toBeTruthy()
    } finally {
      repo.cleanup()
      fs.rmSync(stubDir, { recursive: true, force: true })
    }
  }, 240_000)
})

describe('dynamic dispatch > E2E（海况恶劣换包络内船）', () => {
  it('默认船 harness 绕开狗粮（dogfood_bypass）→ 换包络内健康船，事件与观测都留痕', async () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dd-stub-'))
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dd-home-'))
    const gw = await mockAdmin(
      [
        { id: 'zcode', attached: true, pointing: 'gateway' },
        { id: 'claude-code', attached: true, pointing: 'other' },
      ],
      stubDir,
    )
    const repo = mkRepo({
      workerBackend: 'claude-headless',
      extra: { ...DD_ON, gatewayAdmin: true },
    })
    try {
      const stub = writeZcodeStub(stubDir)
      const claudeStub = writeClaudeProbeStub(stubDir)
      submitCard(repo.root, 'dd-sea-bypass')
      const out = runOrch(repo.root, 'run dd-sea-bypass --review-backend mock', {
        ORCH_ZCODE_CLI: stub,
        ORCH_CLAUDE_CLI: claudeStub,
        ORCH_GATEWAY_BASE: gw.url,
        ORCH_GATEWAY_ADMIN_TOKEN: 'mock-admin',
        MODELRDOCK_FAKE_HOME: fakeHome, // 防误发现真实 gateway.json（端口红线）
      })
      expect(out.stdout).toContain('动态选船')
      const ev = eventsOf(repo.root, 'dd-sea-bypass')
      expect(ev.some((e) => e.type === 'fleet_observed')).toBe(true)
      const sel = ev.find((e) => e.type === 'dispatch_selected')
      expect(sel).toMatchObject({ from: 'claude-headless', to: 'zcode-headless', switched: true })
      expect(String(sel?.reason)).toContain('dogfood_bypass')
      expect(ev.find((e) => e.type === 'worker_spawned')?.backend).toBe('zcode-headless')
      expect(readCard(repo.root, 'awaiting-human', 'dd-sea-bypass')).toBeTruthy()
    } finally {
      repo.cleanup()
      gw.close()
      fs.rmSync(stubDir, { recursive: true, force: true })
      fs.rmSync(fakeHome, { recursive: true, force: true })
    }
  }, 240_000)
})

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import { buildRuntime, pruneExpiredLogs, readRequestLogDay, usageTodayView } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { PROBE_BUDGET_TOKENS_DEFAULT, PROBE_REGISTRY, PROBE_TIER_TOKENS, getProbeDef, probeEstimateTokens } from '../src/gateway/probe/registry.js'
import { probeBudgetState, probeMonthBreakdown, probeMonthKey, probeMonthSpend, probeSpendSeries, readProbeLedger, recordProbeLedgerEntry } from '../src/gateway/probe/ledger.js'
import { probeVerdictTimeline, probeVerdictTimelinePage } from '../src/gateway/probe/verdict.js'
import { runProbeSuite } from '../src/gateway/probe/engine.js'
import type { ProbeRunner, ProbeTransport } from '../src/gateway/probe/engine.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { localDateStr } from '../src/util/time.js'
import { logsDir } from '../src/util/paths.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'

// 探针独立账本（provider-probe-suite 任务 1）：
// - registry 每项含成本档字段；多请求探针（P2/P10/P14）累计口径 = 单次运行内全部请求
// - 八字段条目（tag=probe：probe_id/provider/key 指纹/model/实际 tokens/预估 tokens/耗时/时间戳）
// - 月度预算 budget_tokens 缺省 50000 硬闸：达额后 run() 返回 budget-exhausted 且上游请求数 0
// - 与真实流量 usageToday/请求日志双向隔离

function mkRt(): GatewayRuntime {
  return buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const okTransport: ProbeTransport = async () => ({ status: 200, ms: 1 })
const okRunner: ProbeRunner = async (ctx) => {
  const resp = await ctx.transport({ providerId: ctx.target.providerId, model: ctx.target.model })
  return { state: 'healthy', status: resp.status, calls: [{ tokens: 10, ms: resp.ms, status: resp.status }] }
}

function ledgerEntry(over: Partial<Parameters<typeof recordProbeLedgerEntry>[0]> = {}): void {
  recordProbeLedgerEntry({
    tag: 'probe',
    probe_id: 'p1',
    provider: 'acme',
    key_fp: 'fp1',
    model: 'm',
    tokens: 200,
    estimated_tokens: 200,
    ms: 10,
    ts: new Date().toISOString(),
    ...over,
  })
}

describe('probe-ledger · registry 成本档', () => {
  it('每项含成本档字段且累计口径=单次运行内全部请求；P2/P10/P14 多请求累计口径落字段', () => {
    expect(PROBE_REGISTRY).toHaveLength(16) // P1–P15 + ctx 预留槽位
    for (const def of PROBE_REGISTRY) {
      expect(['S', 'M', 'L', 'none']).toContain(def.cost)
      expect(def.unitTokens).toBe(PROBE_TIER_TOKENS[def.cost])
      expect(def.cumulative).toBe('run-total')
      expect(def.requests === 'per-key' || typeof def.requests === 'number').toBe(true)
    }
    // 多请求探针的请求基数：P2 逐把 key、P10 逐题 20、P14 五轮 5
    expect(getProbeDef('p2')?.requests).toBe('per-key')
    expect(getProbeDef('p10')?.requests).toBe(20)
    expect(getProbeDef('p14')?.requests).toBe(5)
    // 预估 = Σ(该次运行内全部请求的档位上限)：P10 = 20×S、P14 = 5×M
    expect(probeEstimateTokens(getProbeDef('p10')!)).toBe(20 * PROBE_TIER_TOKENS.S)
    expect(probeEstimateTokens(getProbeDef('p14')!)).toBe(5 * PROBE_TIER_TOKENS.M)
    // ctx 预留槽位 not-implemented；P15 零 token
    expect(getProbeDef('ctx')?.status).toBe('reserved')
    expect(getProbeDef('p15')?.cost).toBe('none')
    expect(probeEstimateTokens(getProbeDef('p15')!)).toBe(0)
    // jittery 名单与 design 一致
    expect(PROBE_REGISTRY.filter((d) => d.kind === 'jittery').map((d) => d.id).sort()).toEqual(['p10', 'p12', 'p13', 'p14'])
  })
})

describe('probe-ledger · 八字段条目', () => {
  it('条目含 tag=probe 与八字段，读回一致', async () => {
    const h = fakeHome()
    try {
      ledgerEntry({ probe_id: 'p3', provider: 'up1', key_fp: 'fpx', model: 'mm', tokens: 123, estimated_tokens: 2000, ms: 45 })
      const entries = await readProbeLedger()
      expect(entries).toHaveLength(1)
      const e = entries[0]
      expect(e.tag).toBe('probe')
      expect(e.probe_id).toBe('p3')
      expect(e.provider).toBe('up1')
      expect(e.key_fp).toBe('fpx')
      expect(e.model).toBe('mm')
      expect(e.tokens).toBe(123)
      expect(e.estimated_tokens).toBe(2000)
      expect(e.ms).toBe(45)
      expect(typeof e.ts).toBe('string')
    } finally {
      h.restore()
    }
  })
})

describe('probe-ledger · 月度预算硬闸', () => {
  it('月度花费达 50000（缺省预算）后 run() 返回 budget-exhausted 且上游请求数 0', async () => {
    const h = fakeHome()
    try {
      const now = new Date()
      for (let i = 0; i < 25; i++) {
        ledgerEntry({ probe_id: 'p3', provider: `up${i}`, tokens: 2000, estimated_tokens: 2000, ts: now.toISOString() })
      } // 25 × 2000 = 50000
      const rt = mkRt()
      const st = await probeBudgetState(rt)
      expect(st.budget).toBe(PROBE_BUDGET_TOKENS_DEFAULT)
      expect(st.spent).toBe(50000)
      expect(st.exhausted).toBe(true)
      let calls = 0
      const transport: ProbeTransport = async () => {
        calls++
        return { status: 200, ms: 1 }
      }
      const r = await runProbeSuite(rt, {
        probeIds: ['p1', 'p3'],
        targets: [{ providerId: 'acme', model: 'm', keyFp: 'fp1' }],
        transport,
        runner: okRunner,
        confirmed: true,
      })
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('budget-exhausted')
      expect(r.upstreamRequests).toBe(0)
      expect(calls).toBe(0)
      expect(r.skipped.map((s) => s.reason)).toEqual(['budget-exhausted', 'budget-exhausted'])
      // 调高预算后：正常派发并在账本留痕
      ;(rt.config as Config & { probe?: { budget_tokens?: number } }).probe = { budget_tokens: 50_100 }
      const r2 = await runProbeSuite(rt, {
        probeIds: ['p1'],
        targets: [{ providerId: 'fresh', model: 'm', keyFp: 'fp2' }],
        transport: okTransport,
        runner: okRunner,
        confirmed: true,
      })
      expect(r2.ok).toBe(true)
      expect(r2.upstreamRequests).toBe(1)
      const entries = await readProbeLedger()
      expect(entries.filter((e) => e.provider === 'fresh')).toHaveLength(1)
    } finally {
      h.restore()
    }
  })

  it('预算按自然月计：上月花费不计入当月', async () => {
    const h = fakeHome()
    try {
      const today = new Date()
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15) // 15 日安全（无月末溢出）
      ledgerEntry({ tokens: 999_999, ts: lastMonth.toISOString() })
      const rt = mkRt()
      const st = await probeBudgetState(rt)
      expect(st.exhausted).toBe(false)
      expect(st.spent).toBe(0)
      let calls = 0
      const transport: ProbeTransport = async () => {
        calls++
        return { status: 200, ms: 1 }
      }
      const r = await runProbeSuite(rt, {
        probeIds: ['p1'],
        targets: [{ providerId: 'acme', model: 'm', keyFp: 'fp1' }],
        transport,
        runner: okRunner,
        confirmed: true,
      })
      expect(r.ok).toBe(true)
      expect(calls).toBe(1)
    } finally {
      h.restore()
    }
  })

  it('budget_tokens 覆盖读数：配置段未落地前按防御式读取生效', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      ;(rt.config as Config & { probe?: { budget_tokens?: number } }).probe = { budget_tokens: 100 }
      ledgerEntry({ tokens: 100 })
      const st = await probeBudgetState(rt)
      expect(st.budget).toBe(100)
      expect(st.exhausted).toBe(true)
    } finally {
      h.restore()
    }
  })
})

describe('probe-ledger · 聚合与隔离', () => {
  it('按自然月聚合、按 probe_id 分解；跨月不计', async () => {
    const h = fakeHome()
    try {
      const today = new Date()
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15)
      ledgerEntry({ probe_id: 'p1', tokens: 100, ts: today.toISOString() })
      ledgerEntry({ probe_id: 'p3', tokens: 300, ts: today.toISOString() })
      ledgerEntry({ probe_id: 'p3', tokens: 500, ts: lastMonth.toISOString() })
      const entries = await readProbeLedger()
      expect(probeMonthSpend(entries)).toBe(400)
      const b = probeMonthBreakdown(entries)
      expect(b.month).toBe(probeMonthKey(today))
      expect(b.total).toBe(400)
      expect(b.requests).toBe(2)
      expect(b.by_probe).toEqual({ p1: 100, p3: 300 })
    } finally {
      h.restore()
    }
  })

  it('探针账本与真实流量今日用量/请求日志双向隔离', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const usageBefore = JSON.stringify(usageTodayView())
      const r = await runProbeSuite(rt, {
        probeIds: ['p1'],
        targets: [{ providerId: 'acme', model: 'm', keyFp: 'fp1' }],
        transport: okTransport,
        runner: okRunner,
        confirmed: true,
      })
      expect(r.upstreamRequests).toBe(1)
      const entries = await readProbeLedger()
      expect(entries).toHaveLength(1)
      expect(entries[0].tokens).toBe(10)
      // usageToday 不因探针花费变化；请求日志零新增
      expect(JSON.stringify(usageTodayView())).toBe(usageBefore)
      expect(readRequestLogDay(localDateStr())).toHaveLength(0)
    } finally {
      h.restore()
    }
  })
})

// ===== 任务 14：probe-<date>.jsonl 保留策略 + 趋势视图 =====

/** 距 now 偏移 offsetDays 天的 probe 日文件名（本地时区，与 verdict.ts 落盘命名同构） */
function probeDayName(offsetDays: number, now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `probe-${d.getFullYear()}-${mm}-${dd}.jsonl`
}

/** verdict JSONL 一行（shape 对齐 verdict.ts appendVerdictJsonl 落盘条目） */
function verdictLine(provider: string, keyFp: string, model: string, state: string, source: string, atMs: number): string {
  const at = new Date(atMs).toISOString()
  return JSON.stringify({ kind: 'probe-verdict', ts: at, provider, key_fp: keyFp, model, state, source, at }) + '\n'
}

describe('probe-ledger · 保留策略（任务 14）', () => {
  it('probe-<date>.jsonl 挂 pruneExpiredLogs 同源策略：retention_days=7 时第 8 天删除、第 7 天保留；账本 probe-ledger.jsonl 无日期后缀不参与清理', async () => {
    const h = fakeHome()
    try {
      const now = new Date()
      fs.mkdirSync(logsDir(), { recursive: true })
      const kept = path.join(logsDir(), probeDayName(7, now))
      const expired = path.join(logsDir(), probeDayName(8, now))
      const ledger = path.join(logsDir(), 'probe-ledger.jsonl')
      fs.writeFileSync(kept, '{"kind":"probe-verdict"}\n')
      fs.writeFileSync(expired, '{"kind":"probe-verdict"}\n')
      fs.writeFileSync(ledger, '{"tag":"probe"}\n')
      expect(await pruneExpiredLogs(7, now)).toBe(1)
      expect(fs.existsSync(expired)).toBe(false)
      expect(fs.existsSync(kept)).toBe(true)
      expect(fs.existsSync(ledger)).toBe(true)
    } finally {
      h.restore()
    }
  })
})

describe('probe-ledger · verdict 时间线（任务 14）', () => {
  it('30 天窗口外条目不返回；同三元组同态刷新折叠、只有翻转出线；输出按 at 升序', async () => {
    const h = fakeHome()
    try {
      const now = Date.now()
      fs.mkdirSync(logsDir(), { recursive: true })
      // 窗口外（40 天前）：oldco 的证据——过滤在读取层，不得出现在任何输出里
      fs.writeFileSync(path.join(logsDir(), probeDayName(40, new Date(now))), verdictLine('oldco', 'fpold', 'm', 'healthy', 'probe:p1', now - 40 * 86_400_000))
      // 窗口内：fp1 degraded(5d) → 同态刷新(3d，折叠) → healthy(1d)；fp2 另一三元组 quota(2d)
      fs.writeFileSync(
        path.join(logsDir(), probeDayName(5, new Date(now))),
        verdictLine('acme', 'fp1', 'm', 'degraded', 'probe:p1', now - 5 * 86_400_000) + verdictLine('acme', 'fp1', 'm', 'degraded', 'probe:p1', now - 3 * 86_400_000)
      )
      fs.writeFileSync(
        path.join(logsDir(), probeDayName(1, new Date(now))),
        verdictLine('acme', 'fp2', 'm', 'quota', 'probe:p3', now - 2 * 86_400_000) + verdictLine('acme', 'fp1', 'm', 'healthy', 'probe:p1', now - 1 * 86_400_000)
      )
      const tl = await probeVerdictTimeline(30 * 86_400_000, now)
      expect(tl).toHaveLength(3)
      // 升序：at 单调不减
      for (let i = 1; i < tl.length; i++) expect(Date.parse(tl[i].at)).toBeGreaterThanOrEqual(Date.parse(tl[i - 1].at))
      // 30 天窗口外数据不返回（oldco 在窗口外；窗口内条目的 at 全部落在窗口内）
      expect(tl.some((x) => x.provider === 'oldco')).toBe(false)
      for (const x of tl) expect(Date.parse(x.at)).toBeGreaterThanOrEqual(now - 30 * 86_400_000)
      // 翻转语义：首现 from=null；同态刷新（3d 前的 degraded）不出线；翻转带 from
      expect(tl[0]).toMatchObject({ provider: 'acme', key_fp: 'fp1', model: 'm', from: null, to: 'degraded', source: 'probe:p1' })
      expect(tl[1]).toMatchObject({ provider: 'acme', key_fp: 'fp2', model: 'm', from: null, to: 'quota', source: 'probe:p3' })
      expect(tl[2]).toMatchObject({ provider: 'acme', key_fp: 'fp1', model: 'm', from: 'degraded', to: 'healthy' })
    } finally {
      h.restore()
    }
  })

  it('窗口非法（非正数）返回空数组不抛错', async () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(logsDir(), { recursive: true })
      fs.writeFileSync(path.join(logsDir(), probeDayName(0, new Date())), verdictLine('acme', 'fp1', 'm', 'healthy', 'probe:p1', Date.now()))
      expect(await probeVerdictTimeline(0)).toEqual([])
      expect(await probeVerdictTimeline(-5)).toEqual([])
      expect(await probeVerdictTimelinePage(0, { provider: 'acme', limit: 10 })).toEqual({ items: [], total: 0 })
    } finally {
      h.restore()
    }
  })

  it('probeVerdictTimelinePage：provider 扫描层过滤 + limit 尾部截取（截断后首条 from 仍是真实前态）+ total 计全量翻转', async () => {
    const h = fakeHome()
    try {
      const now = Date.now()
      fs.mkdirSync(logsDir(), { recursive: true })
      // acme/fp1：degraded(6d) → healthy(4d) → degraded(2d)，3 次翻转；beta：quota(3d)，1 次
      fs.writeFileSync(path.join(logsDir(), probeDayName(6, new Date(now))), verdictLine('acme', 'fp1', 'm', 'degraded', 'probe:p1', now - 6 * 86_400_000))
      fs.writeFileSync(
        path.join(logsDir(), probeDayName(4, new Date(now))),
        verdictLine('acme', 'fp1', 'm', 'healthy', 'probe:p1', now - 4 * 86_400_000) + verdictLine('beta', 'fp2', 'm', 'quota', 'probe:p3', now - 3 * 86_400_000)
      )
      fs.writeFileSync(path.join(logsDir(), probeDayName(2, new Date(now))), verdictLine('acme', 'fp1', 'm', 'degraded', 'probe:p1', now - 2 * 86_400_000))
      const win = 30 * 86_400_000
      // provider 过滤：beta 条目不进 acme 的页；total = 过滤后翻转总数
      const full = await probeVerdictTimelinePage(win, { provider: 'acme' }, now)
      expect(full.total).toBe(3)
      expect(full.items).toHaveLength(3)
      expect(full.items.every((x) => x.provider === 'acme')).toBe(true)
      const beta = await probeVerdictTimelinePage(win, { provider: 'beta' }, now)
      expect(beta.total).toBe(1)
      expect(beta.items[0]).toMatchObject({ provider: 'beta', key_fp: 'fp2', from: null, to: 'quota' })
      // limit 尾部截取：最新 2 条；截断后首条（4d healthy）的 from='degraded' 指向被截掉的
      // 6d 翻转——真实前态保留，与展开态一致；total 不受截断影响
      const paged = await probeVerdictTimelinePage(win, { provider: 'acme', limit: 2 }, now)
      expect(paged.total).toBe(3)
      expect(paged.items).toHaveLength(2)
      expect(paged.items[0]).toMatchObject({ from: 'degraded', to: 'healthy' })
      expect(paged.items[1]).toMatchObject({ from: 'healthy', to: 'degraded' })
      // limit=0 = 不截断；limit 超过总量 = 全量照回
      const zero = await probeVerdictTimelinePage(win, { provider: 'acme', limit: 0 }, now)
      expect(zero.items).toHaveLength(3)
      const over = await probeVerdictTimelinePage(win, { provider: 'acme', limit: 99 }, now)
      expect(over.items).toHaveLength(3)
      expect(over.total).toBe(3)
    } finally {
      h.restore()
    }
  })
})

const ADMIN = 'admin-tok-probe-ledger'

/** 趋势端点测试壳：listen(0) 随机端口 + fakeHome 隔离（探针调度停用，零后台副作用） */
async function setupTrendEndpoint(): Promise<{ get: (p: string) => Promise<{ status: number; body: string }>; close: () => void }> {
  const h = fakeHome()
  const rt = buildRuntime({ version: 1, security: { store: 'file' }, providers: {}, profiles: {}, harness: {} } as unknown as Config, ADMIN)
  const server = createGatewayServer(rt, {
    port: 0,
    autoHolidayRefresh: false,
    autoCatalogRefresh: false,
    autoModelProbe: false,
    autoProbeSchedule: false,
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const get = (p: string): Promise<{ status: number; body: string }> =>
    fetch(`http://127.0.0.1:${port}/_modeldock/${p}`, { headers: { 'x-modeldock-admin': ADMIN } }).then(async (r) => ({ status: r.status, body: await r.text() }))
  return {
    get,
    close: () => {
      server.closeAllConnections?.()
      server.close()
      h.restore()
    },
  }
}

describe('probe-ledger · GET /_modeldock/probe/trend（任务 14）', () => {
  it('30 天窗口外数据不返回、timeline 按 at 升序；spend 只含窗口月（外月不计），days 参数收窄生效', async () => {
    const t = await setupTrendEndpoint()
    try {
      const now = Date.now()
      fs.mkdirSync(logsDir(), { recursive: true })
      // 窗口外（40 天前）+ 窗口内两组证据（同 verdictLine 场景，断言见时间线字段）
      fs.writeFileSync(path.join(logsDir(), probeDayName(40, new Date(now))), verdictLine('oldco', 'fpold', 'm', 'healthy', 'probe:p1', now - 40 * 86_400_000))
      fs.writeFileSync(path.join(logsDir(), probeDayName(5, new Date(now))), verdictLine('acme', 'fp1', 'm', 'degraded', 'probe:p1', now - 5 * 86_400_000))
      fs.writeFileSync(path.join(logsDir(), probeDayName(1, new Date(now))), verdictLine('acme', 'fp1', 'm', 'healthy', 'probe:p1', now - 1 * 86_400_000))
      // 账本：当月 300（p1）+ 上月 700（p3）+ 7 个月前 9999（6 个月窗口外）
      const today = new Date(now)
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15)
      const farMonth = new Date(today.getFullYear(), today.getMonth() - 7, 15)
      recordProbeLedgerEntry({ tag: 'probe', probe_id: 'p1', provider: 'acme', key_fp: 'fp1', model: 'm', tokens: 300, estimated_tokens: 300, ms: 5, ts: today.toISOString() })
      recordProbeLedgerEntry({ tag: 'probe', probe_id: 'p3', provider: 'acme', key_fp: 'fp1', model: 'm', tokens: 700, estimated_tokens: 700, ms: 5, ts: lastMonth.toISOString() })
      recordProbeLedgerEntry({ tag: 'probe', probe_id: 'p1', provider: 'acme', key_fp: 'fp1', model: 'm', tokens: 9999, estimated_tokens: 9999, ms: 5, ts: farMonth.toISOString() })

      const g = await t.get('probe/trend?days=30&months=6')
      expect(g.status).toBe(200)
      const j = JSON.parse(g.body) as {
        ok: boolean
        days: number
        months: number
        timeline: Array<{ at: string; provider: string; key_fp: string; model: string; from: string | null; to: string; source: string }>
        spend: Array<{ month: string; tokens: number; by_probe: Record<string, number> }>
      }
      expect(j.ok).toBe(true)
      expect(j.days).toBe(30)
      expect(j.months).toBe(6)
      // 窗口外数据不返回：oldco（40 天前）不出现在 timeline
      expect(j.timeline.some((x) => x.provider === 'oldco')).toBe(false)
      for (const x of j.timeline) expect(Date.parse(x.at)).toBeGreaterThanOrEqual(now - 30 * 86_400_000)
      // timeline 按 at 升序：degraded(5d) → healthy(1d)
      expect(j.timeline).toHaveLength(2)
      for (let i = 1; i < j.timeline.length; i++) expect(Date.parse(j.timeline[i].at)).toBeGreaterThanOrEqual(Date.parse(j.timeline[i - 1].at))
      expect(j.timeline[0]).toMatchObject({ provider: 'acme', key_fp: 'fp1', from: null, to: 'degraded' })
      expect(j.timeline[1]).toMatchObject({ provider: 'acme', key_fp: 'fp1', from: 'degraded', to: 'healthy' })
      // spend：6 个自然月点（含空月零点），按月升序；窗口外月（7 个月前的 9999）不计入
      expect(j.spend).toHaveLength(6)
      expect(j.spend[5].month).toBe(probeMonthKey(new Date(now)))
      const sum = j.spend.reduce((a, p) => a + p.tokens, 0)
      expect(sum).toBe(1000)
      expect(j.spend[5].tokens).toBe(300)
      expect(j.spend[5].by_probe).toEqual({ p1: 300 })
      expect(j.spend[4].month).toBe(probeMonthKey(lastMonth))
      expect(j.spend[4].tokens).toBe(700)
      expect(j.spend[4].by_probe).toEqual({ p3: 700 })

      // days 收窄：窗口 3 天 → 5 天前的 degraded 出局，只剩 1 天前的 healthy（首现 from=null）
      const g2 = await t.get('probe/trend?days=3')
      const j2 = JSON.parse(g2.body) as { days: number; timeline: Array<{ to: string; from: string | null }> }
      expect(j2.days).toBe(3)
      expect(j2.timeline).toHaveLength(1)
      expect(j2.timeline[0]).toMatchObject({ to: 'healthy', from: null })
    } finally {
      t.close()
    }
  })

  it('非法 days/months 夹紧缺省（30/6），不 400 不抛错', async () => {
    const t = await setupTrendEndpoint()
    try {
      const g = await t.get('probe/trend?days=abc&months=-2')
      expect(g.status).toBe(200)
      const j = JSON.parse(g.body) as { ok: boolean; days: number; months: number; spend: unknown[] }
      expect(j.ok).toBe(true)
      expect(j.days).toBe(30)
      expect(j.months).toBe(6)
      expect(j.spend).toHaveLength(6)
    } finally {
      t.close()
    }
  })

  it('probeSpendSeries：空月出零点、months 缺省 6、非法夹紧', () => {
    const now = new Date(2026, 10, 15) // 2026-11-15 本地
    expect(probeSpendSeries([], 3, now)).toEqual([
      { month: '2026-09', tokens: 0, by_probe: {} },
      { month: '2026-10', tokens: 0, by_probe: {} },
      { month: '2026-11', tokens: 0, by_probe: {} },
    ])
    expect(probeSpendSeries([], NaN, now)).toHaveLength(6)
    expect(probeSpendSeries([], 99, now)).toHaveLength(24)
    expect(probeSpendSeries([], 0, now)).toHaveLength(1)
  })
})

describe('probe-ledger · GET /_modeldock/probe/timeline（svc-timeline-lazy 单服务轻端点）', () => {
  it('provider 服务端裁剪 + limit 尾部截取 + total 计全量；limit 0=全量、缺省/非法夹回 10', async () => {
    const t = await setupTrendEndpoint()
    try {
      const now = Date.now()
      fs.mkdirSync(logsDir(), { recursive: true })
      // acme/fp1：degraded(6d) → healthy(4d) → degraded(2d)；beta：quota(3d)
      fs.writeFileSync(path.join(logsDir(), probeDayName(6, new Date(now))), verdictLine('acme', 'fp1', 'm', 'degraded', 'probe:p1', now - 6 * 86_400_000))
      fs.writeFileSync(
        path.join(logsDir(), probeDayName(4, new Date(now))),
        verdictLine('acme', 'fp1', 'm', 'healthy', 'probe:p1', now - 4 * 86_400_000) + verdictLine('beta', 'fp2', 'm', 'quota', 'probe:p3', now - 3 * 86_400_000)
      )
      fs.writeFileSync(path.join(logsDir(), probeDayName(2, new Date(now))), verdictLine('acme', 'fp1', 'm', 'degraded', 'probe:p1', now - 2 * 86_400_000))
      // limit=2：只回 acme 最新 2 条（beta 被服务端裁掉），total=3 供「展开全部 N 条」
      const g = await t.get('probe/timeline?provider=acme&limit=2')
      expect(g.status).toBe(200)
      const j = JSON.parse(g.body) as {
        ok: boolean
        provider: string
        limit: number
        total: number
        timeline: Array<{ provider: string; from: string | null; to: string }>
      }
      expect(j.ok).toBe(true)
      expect(j.provider).toBe('acme')
      expect(j.limit).toBe(2)
      expect(j.total).toBe(3)
      expect(j.timeline).toHaveLength(2)
      expect(j.timeline.every((x) => x.provider === 'acme')).toBe(true)
      expect(j.timeline[0]).toMatchObject({ from: 'degraded', to: 'healthy' })
      expect(j.timeline[1]).toMatchObject({ from: 'healthy', to: 'degraded' })
      // limit=0 = 全量；缺省与非法值夹回 10
      const j0 = JSON.parse(await t.get('probe/timeline?provider=acme&limit=0').then((r) => r.body)) as { limit: number; total: number; timeline: unknown[] }
      expect(j0.limit).toBe(0)
      expect(j0.total).toBe(3)
      expect(j0.timeline).toHaveLength(3)
      expect((JSON.parse(await t.get('probe/timeline?provider=acme').then((r) => r.body)) as { limit: number }).limit).toBe(10)
      expect((JSON.parse(await t.get('probe/timeline?provider=acme&limit=abc').then((r) => r.body)) as { limit: number }).limit).toBe(10)
      expect((JSON.parse(await t.get('probe/timeline?provider=acme&limit=-3').then((r) => r.body)) as { limit: number }).limit).toBe(10)
    } finally {
      t.close()
    }
  })

  it('缺 provider 400 带示例提示（可操作报错）', async () => {
    const t = await setupTrendEndpoint()
    try {
      const g = await t.get('probe/timeline')
      expect(g.status).toBe(400)
      expect(g.body).toContain('provider')
    } finally {
      t.close()
    }
  })
})

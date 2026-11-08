import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  activeScheduleWindow,
  buildRuntime,
  checkTokenLimits,
  clearGatewayState,
  gatewayLive,
  isMeltdown,
  KEY_COOLDOWN_MS,
  keyPoolHealthView,
  logEntryMatches,
  markKeyCooldown,
  nextRotation,
  parseFallbackEntry,
  pickTarget,
  pushRing,
  readGatewayState,
  readRequestLogDay,
  recordOutcome,
  recordSeaOutcome,
  recordTokenUsage,
  reloadRuntime,
  resetKeyPool,
  resetUsageTodayForTest,
  routeState,
  seaWindowView,
  startEventLoopDelaySampler,
  eventLoopLagMs,
  summarizeUsageDays,
  usageTodayView,
  writeGatewayState,
} from '../src/gateway/state.js'
import { isModelMeltdown, recordModelOutcome } from '../src/gateway/state/routing.js'
import type { GatewayRuntime, LogEntry, ResolvedTarget } from '../src/gateway/state/types.js'
import { loadConfig, mutateConfig } from '../src/config/store.js'
import { logsDir } from '../src/util/paths.js'
import { localIsoTs } from '../src/util/time.js'
import { fakeHome } from './helpers.js'
import type { Config, ProviderConfig } from '../src/config/types.js'

// state/* 域模块缺口补测（卡 test-gap-gateway-util，2026-11-07 coverage 现场）：
// keypool（resetKeyPool 单 provider / 过期条目不投影）、routing（quota 熔断阈值、错误窗口滑出重置、
// 非法 HHmm 窗口、dow 周日、避开全灭补链、fallback 空条目、耗时决胜、无 profile 钉定视图）、
// runtime（reload 清理已删 provider 三域缓存）、state-file（gatewayLive 分支 + clear）、
// logs（pushRing 裁剪、readRequestLogDay 格式闸、logEntryMatches 时间窗、summarizeUsageDays 容错、
// usageTodayView 失败视图、事件循环采样幂等）、sea（惰性 store / 未来桶）、tokenlimits（记账口径）。
// 全部真实入口（不 mock 模块）；rt 级内存态用 buildRuntime 直建。

function providerCfg(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { name: 'p', base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k', ...over }
}

function rt(over: Partial<Config> = {}): GatewayRuntime {
  return buildRuntime({ providers: {}, profiles: {}, harness: {}, ...over } as unknown as Config, 't')
}

function baseOn(r: GatewayRuntime, id: string, profileOver: Record<string, unknown> = {}): ResolvedTarget {
  return {
    harness: 'test',
    profileName: 'pp',
    profile: { name: 'pp', provider: id, ...profileOver },
    provider: (r.config as Config).providers[id],
  }
}

describe('state-gaps · keypool 补充分支', () => {
  it('resetKeyPool 单 provider：只清该服务冷却与轮转游标，其他服务不受影响', () => {
    const r = rt()
    markKeyCooldown(r, 'a', 0)
    markKeyCooldown(r, 'b', 0)
    nextRotation(r, 'a', [0, 1])
    nextRotation(r, 'a', [0, 1])
    nextRotation(r, 'b', [0, 1])
    resetKeyPool(r, 'a')
    expect(keyPoolHealthView(r, 'a', 1).healthy).toBe(1)
    expect(keyPoolHealthView(r, 'b', 1).healthy).toBe(0)
    expect(nextRotation(r, 'a', [0, 1])).toBe(0) // a 游标归零
    expect(nextRotation(r, 'b', [0, 1])).toBe(1) // b 游标保留
  })

  it('keyPoolHealthView：已过期的冷却条目不投影（惰性清理归 keyInCooldown）', () => {
    const r = rt()
    const t0 = 1_700_000_000_000
    markKeyCooldown(r, 'p', 0, t0 - KEY_COOLDOWN_MS - 1000)
    expect(keyPoolHealthView(r, 'p', 2, t0)).toEqual({ healthy: 2, cooldown: [] })
  })
})

describe('state-gaps · routing 熔断与错误窗口', () => {
  it('quota 类 3 次即熔断且冷却档位最长（15min）', () => {
    const r = rt()
    recordOutcome(r, 'p', { ok: false, cls: 'quota' })
    recordOutcome(r, 'p', { ok: false, cls: 'quota' })
    expect(isMeltdown(r, 'p')).toBe(false)
    recordOutcome(r, 'p', { ok: false, cls: 'quota' })
    expect(isMeltdown(r, 'p')).toBe(true)
    expect(r.health.get('p')?.meltdown_cls).toBe('quota')
    // 15 分钟后解封
    expect(isMeltdown(r, 'p', Date.now() + 900_001)).toBe(false)
  })

  it('错误窗口滑出 60s 后重置计数：满阈值不跨窗累积', () => {
    const r = rt()
    recordOutcome(r, 'p', { ok: false, cls: 'connect' })
    recordOutcome(r, 'p', { ok: false, cls: 'connect' })
    const h = r.health.get('p')!
    expect(h.errWindow.count).toBe(2)
    // recordOutcome 内部取 Date.now()（不可注入），手动把窗口起点拨回 61s 前模拟滑出
    h.errWindow.t0 = Date.now() - 61_000
    recordOutcome(r, 'p', { ok: false, cls: 'connect' })
    expect(h.errWindow.count).toBe(1)
    expect(isMeltdown(r, 'p')).toBe(false)
    h.errWindow.t0 = Date.now() - 61_000 // 三次分别在两窗内，永不熔断
    recordOutcome(r, 'p', { ok: false, cls: 'connect' })
    h.errWindow.t0 = Date.now() - 61_000
    recordOutcome(r, 'p', { ok: false, cls: 'connect' })
    expect(isMeltdown(r, 'p')).toBe(false)
  })

  it('recordOutcome modelScoped（模型级容灾接管）：quota 不累计 provider 级窗口，海况照记', () => {
    const r = rt()
    recordOutcome(r, 'p', { ok: false, cls: 'quota', modelScoped: true })
    recordOutcome(r, 'p', { ok: false, cls: 'quota', modelScoped: true })
    const h = r.health.get('p')!
    expect(h.errWindow.count).toBe(0) // provider 级窗口不累计
    expect(isMeltdown(r, 'p')).toBe(false)
    recordOutcome(r, 'p', { ok: false, cls: 'quota', modelScoped: true })
    expect(isMeltdown(r, 'p')).toBe(false) // 3 次 modelScoped quota 也不熔断 provider
    // 海况（provider 级观测面）照记：quota 分桶 3 笔，风暴闸对 402 风暴保持可见
    const sp = r.seaErrors!.get('p')!
    const w = seaWindowView(sp, 60 * 60_000)
    expect(w.quota).toBe(3)
    // 不带 modelScoped 的 quota 仍走 provider 级熔断（现状不变）
    recordOutcome(r, 'p', { ok: false, cls: 'quota' })
    expect(h.errWindow.count).toBe(1)
  })

  it('模型级熔断（model_fallback 域）：quota 3 次熔断 15min，ok 重置并解熔断，其他档忽略不建账', () => {
    const r = rt()
    recordModelOutcome(r, 'p', 'mA', { ok: false, cls: 'quota' })
    recordModelOutcome(r, 'p', 'mA', { ok: false, cls: 'quota' })
    expect(isModelMeltdown(r, 'p', 'mA')).toBe(false)
    recordModelOutcome(r, 'p', 'mA', { ok: false, cls: 'quota' })
    expect(isModelMeltdown(r, 'p', 'mA')).toBe(true)
    expect(r.modelHealth?.get('p\u0000mA')?.meltdown_cls).toBe('quota')
    // TTL 过期自然解封（now 注入）
    expect(isModelMeltdown(r, 'p', 'mA', Date.now() + 900_001)).toBe(false)
    // 其他档忽略不计：connect/429/5xx 打满也不熔断、不建账
    for (const cls of ['connect', '429', '5xx'] as const) {
      recordModelOutcome(r, 'p', 'mB', { ok: false, cls })
      recordModelOutcome(r, 'p', 'mB', { ok: false, cls })
      recordModelOutcome(r, 'p', 'mB', { ok: false, cls })
    }
    expect(isModelMeltdown(r, 'p', 'mB')).toBe(false)
    expect(r.modelHealth?.has('p\u0000mB')).toBe(false)
    // ok 重置窗口并解熔断
    recordModelOutcome(r, 'p', 'mA', { ok: true })
    expect(isModelMeltdown(r, 'p', 'mA')).toBe(false)
    expect(r.modelHealth?.get('p\u0000mA')?.errWindow.count).toBe(0)
    // 窗口滑出 60s 重置（t0 拨回 61s 前），满阈值不跨窗累积
    recordModelOutcome(r, 'p', 'mC', { ok: false, cls: 'quota' })
    recordModelOutcome(r, 'p', 'mC', { ok: false, cls: 'quota' })
    const mch = r.modelHealth!.get('p\u0000mC')!
    mch.errWindow.t0 = Date.now() - 61_000
    recordModelOutcome(r, 'p', 'mC', { ok: false, cls: 'quota' })
    expect(mch.errWindow.count).toBe(1)
    expect(isModelMeltdown(r, 'p', 'mC')).toBe(false)
  })
})

describe('state-gaps · routing 定时窗口求值', () => {
  it('非法 HHmm 与 start===end 的窗口被跳过（不误命中）', () => {
    const r = rt({
      gateway: {
        schedule: {
          windows: [
            { start: '25:00', end: '08:00', target: 'pa' },
            { start: '08:00', end: '08:00', target: 'pa' },
          ],
        },
      },
    } as Partial<Config>)
    expect(activeScheduleWindow(r, new Date(2026, 10, 9, 12, 0))).toBeNull()
  })

  it('days:[7] 仅周日生效（dowOf 周日=7；跨午夜窗口按起始日判星期）', () => {
    const r = rt({
      gateway: { schedule: { windows: [{ start: '00:00', end: '23:59', days: [7], target: 'pa' }] } },
    } as Partial<Config>)
    // 2026-11-08 是周日，2026-11-09 是周一
    expect(activeScheduleWindow(r, new Date(2026, 10, 8, 12, 0))?.target).toBe('pa')
    expect(activeScheduleWindow(r, new Date(2026, 10, 9, 12, 0))).toBeNull()
  })
})

describe('state-gaps · pickTarget 候选链补齐分支', () => {
  it('候选链全被避开且 auto_fallback 关闭：链外其余可用服务补入（extras 兜底）', () => {
    const pa = providerCfg({ name: 'pa' })
    const pb = providerCfg({ name: 'pb', priority: 5 })
    const r = rt({
      providers: { pa, pb },
      gateway: {
        auto_fallback: false,
        schedule: { windows: [{ start: '00:00', end: '23:59', target: 'pa', mode: 'avoid' }] },
      },
    } as Partial<Config>)
    const picked = pickTarget(r, baseOn(r, 'pa'), undefined)
    expect(picked.ok).toBe(true)
    if (picked.ok) {
      expect(picked.ordered.map((c) => c.providerId)).toEqual(['pb'])
      expect(picked.primary.source).toBe('failover')
    }
  })

  it('fallback 空条目被过滤；自动链同 priority 按实测耗时升序、无数据靠后（配置顺序兜底）', () => {
    const pa = providerCfg({ name: 'pa' })
    const pb = providerCfg({ name: 'pb' })
    const pc = providerCfg({ name: 'pc' })
    const pd = providerCfg({ name: 'pd' })
    const r = rt({ providers: { pa, pb, pc, pd } } as Partial<Config>)
    recordOutcome(r, 'pb', { ok: true, ms: 50 }) // pb 有实测耗时
    recordOutcome(r, 'pc', { ok: true, ms: 120 })
    expect(parseFallbackEntry('pa:')).toEqual({ providerId: 'pa' }) // 空模型段 = 纯服务条目
    const picked = pickTarget(r, baseOn(r, 'pa'), [''])
    expect(picked.ok).toBe(true)
    if (picked.ok) expect(picked.ordered.map((c) => c.providerId)).toEqual(['pa', 'pb', 'pc', 'pd'])
  })

  it('无 active_profile 且人工钉定存在：effective 走钉定并带上目标服务自己的 profile 与模型', () => {
    const pb = providerCfg({ name: 'B', models: { m1: { source: 'manual' } } })
    const r = rt({
      providers: { pb },
      profiles: { pbp: { provider: 'pb' } },
      gateway: { auto_route_provider: 'pb' },
    } as Partial<Config>)
    const rs = routeState(r)
    expect(rs.effective.providerId).toBe('pb')
    expect(rs.effective.source).toBe('pinned')
    expect(rs.effective.profileName).toBe('pbp')
    expect(rs.effective.model).toBe('m1')
    expect(rs.default.providerId).toBeNull() // 无 active_profile：default 视图为空
  })
})

describe('state-gaps · reloadRuntime 清理已删 provider 的三域运行态', () => {
  it('health / seaErrors / modelProbe 中已删除条目清掉，幸存者保留', async () => {
    const h = fakeHome()
    try {
      const keepCfg = providerCfg({ name: 'keep', key_ref: 'file:keep' })
      const ghostCfg = providerCfg({ name: 'ghost', key_ref: 'file:ghost' })
      await mutateConfig((c) => {
        c.providers['keep'] = keepCfg
        c.providers['ghost'] = ghostCfg
      })
      const r = buildRuntime(await loadConfig(), 't')
      recordOutcome(r, 'ghost', { ok: true })
      recordOutcome(r, 'keep', { ok: true })
      r.modelProbe?.results.set('ghost', {} as never)
      await mutateConfig((c) => {
        delete c.providers.ghost
      })
      await reloadRuntime(r)
      expect(r.health.has('ghost')).toBe(false)
      expect(r.health.has('keep')).toBe(true)
      expect(r.seaErrors?.has('ghost')).toBe(false)
      expect(r.seaErrors?.has('keep')).toBe(true)
      expect(r.modelProbe?.results.has('ghost')).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('modelHealth：provider 已删或其 model_fallback 已移除该模型键的条目清掉，幸存键保留', async () => {
    const h = fakeHome()
    try {
      await mutateConfig((c) => {
        c.providers['ghost'] = providerCfg({ name: 'ghost', key_ref: 'file:ghost', models: { mA: { source: 'manual' }, mB: { source: 'manual' } }, model_fallback: { mA: 'mB' } })
        c.providers['keep'] = providerCfg({ name: 'keep', key_ref: 'file:keep', models: { mA: { source: 'manual' }, kB: { source: 'manual' }, kC: { source: 'manual' } }, model_fallback: { mA: 'mB', kB: 'kC' } })
      })
      const r = buildRuntime(await loadConfig(), 't')
      recordModelOutcome(r, 'ghost', 'mA', { ok: false, cls: 'quota' })
      recordModelOutcome(r, 'keep', 'mA', { ok: false, cls: 'quota' })
      recordModelOutcome(r, 'keep', 'kB', { ok: false, cls: 'quota' })
      await mutateConfig((c) => {
        delete c.providers.ghost // 分支①：provider 整个删除
        ;(c.providers['keep'] as ProviderConfig).model_fallback = { kB: 'kC' } // 分支②：mA 映射被移除
      })
      await reloadRuntime(r)
      expect(r.modelHealth?.has('ghost\u0000mA')).toBe(false)
      expect(r.modelHealth?.has('keep\u0000mA')).toBe(false)
      expect(r.modelHealth?.has('keep\u0000kB')).toBe(true)
    } finally {
      h.restore()
    }
  })
})

describe('state-gaps · state-file 活性探测分支', () => {
  const STARTED = '2026-11-07T08:00:00'
  interface HealthMock {
    port: number
    close: () => Promise<void>
  }
  async function healthMock(status: number, body: Record<string, unknown>): Promise<HealthMock> {
    const s = http.createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    return { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()) }) }
  }

  function state(port: number, startedAt = STARTED) {
    return { pid: process.pid, port, admin_token: 't', started_at: startedAt }
  }

  it('健康端点验明正身：started_at 一致返回状态', async () => {
    const h = fakeHome()
    const m = await healthMock(200, { started_at: STARTED })
    try {
      await writeGatewayState(state(m.port))
      const live = await gatewayLive()
      expect(live?.port).toBe(m.port)
    } finally {
      await m.close()
      h.restore()
    }
  })

  it('健康端点 500：按陈旧状态返回 null（pid 复用防误杀的一部分）', async () => {
    const h = fakeHome()
    const m = await healthMock(500, {})
    try {
      await writeGatewayState(state(m.port))
      expect(await gatewayLive()).toBeNull()
    } finally {
      await m.close()
      h.restore()
    }
  })

  it('started_at 不一致（pid 被复用的新实例）：返回 null', async () => {
    const h = fakeHome()
    const m = await healthMock(200, { started_at: 'other-instance' })
    try {
      await writeGatewayState(state(m.port))
      expect(await gatewayLive()).toBeNull()
    } finally {
      await m.close()
      h.restore()
    }
  })

  it('进程在但健康端点不通（端口无人监听，fetch 抛错）：返回 null', async () => {
    const h = fakeHome()
    // 先起再关：拿到一个必然无人监听的端口
    const s = http.createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const deadPort = (s.address() as AddressInfo).port
    await new Promise<void>((r) => s.close(() => r()))
    try {
      await writeGatewayState(state(deadPort))
      expect(await gatewayLive()).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('clearGatewayState：读回 null（幂等 rm）', async () => {
    const h = fakeHome()
    try {
      await writeGatewayState(state(1))
      expect(await readGatewayState()).not.toBeNull()
      await clearGatewayState()
      expect(await readGatewayState()).toBeNull()
    } finally {
      h.restore()
    }
  })
})

describe('state-gaps · logs 记账与容错', () => {
  it('pushRing 环形裁剪：超过 500 条挤掉最旧', () => {
    const r = rt()
    for (let i = 0; i < 505; i++) pushRing(r, { ts: `t${i}` } as never)
    expect(r.ring.length).toBe(500)
    expect((r.ring[0] as { ts: string }).ts).toBe('t5')
    expect((r.ring[499] as { ts: string }).ts).toBe('t504')
  })

  it('readRequestLogDay：日期格式严格校验，非法输入返回空数组（防拼接逃逸）', () => {
    const h = fakeHome()
    try {
      expect(readRequestLogDay('2026-11-07')).toEqual([])
      expect(readRequestLogDay('../etc/passwd')).toEqual([])
      expect(readRequestLogDay('2026-1-07')).toEqual([])
    } finally {
      h.restore()
    }
  })

  it('logEntryMatches：时间窗含边界，未设维度不过滤', () => {
    const e = { ts: '2026-11-07T10:00:00', harness: 'h', profile: 'p', provider: 'pv', path: '/v1/messages' } as LogEntry
    const t0 = new Date('2026-11-07T09:00:00').getTime()
    const t1 = new Date('2026-11-07T11:00:00').getTime()
    expect(logEntryMatches(e, { fromMs: t0, toMs: t1 })).toBe(true)
    expect(logEntryMatches(e, { fromMs: t1 })).toBe(false)
    expect(logEntryMatches(e, { toMs: t0 })).toBe(false)
    expect(logEntryMatches(e, { harness: 'h', provider: 'other' })).toBe(false)
    expect(logEntryMatches(e, {})).toBe(true)
  })

  it('summarizeUsageDays：非法日期跳过、缺失文件跳过、崩溃半行容错不抛', async () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(logsDir(), { recursive: true })
      const entry: LogEntry = {
        ts: '2026-11-06T10:00:00',
        harness: 'h',
        profile: 'p',
        provider: 'pv',
        path: '/v1/messages',
        status: 200,
        ms: 12,
      }
      fs.writeFileSync(
        path.join(logsDir(), 'gateway-2026-11-06.jsonl'),
        JSON.stringify(entry) + '\n{"truncated half-line',
      )
      const s = await summarizeUsageDays(['nope', '2026-11-06', '2026-11-05'], {})
      expect(s.requests).toBe(1)
      expect(s.ok).toBe(1)
      expect(s.window.first).toBe(entry.ts)
    } finally {
      h.restore()
    }
  })

  it('usageTodayView：今日仪表不可用（当日日文件异常）时返回零值视图不抛', () => {
    const h = fakeHome()
    try {
      resetUsageTodayForTest()
      // 当日 gateway-YYYY-MM-DD.jsonl 位置是一个目录：readFileSync EISDIR → 走 catch 零值视图
      fs.mkdirSync(logsDir(), { recursive: true })
      fs.mkdirSync(path.join(logsDir(), `gateway-${localIsoTs().slice(0, 10)}.jsonl`))
      const v = usageTodayView()
      expect(v.requests).toBe(0)
      expect(v.cost).toBeNull()
      expect(v.tokens.input).toBe(0)
    } finally {
      resetUsageTodayForTest()
      h.restore()
    }
  })

  it('startEventLoopDelaySampler：缺省参数可调用、重复调用幂等；采样窗口未满时读数为 null', () => {
    startEventLoopDelaySampler()
    startEventLoopDelaySampler(3_600_000)
    expect(eventLoopLagMs()).toBeNull()
  })
})

describe('state-gaps · sea 惰性初始化与未来桶', () => {
  it('rt 未初始化 seaErrors 时惰性建表（嵌入式/兜底直建 rt 场景）', () => {
    const bare = { config: { providers: {} }, health: new Map(), ring: [] } as unknown as GatewayRuntime
    expect(bare.seaErrors).toBeUndefined()
    recordSeaOutcome(bare, 'p', { ok: true }, Date.now())
    expect(bare.seaErrors).toBeInstanceOf(Map)
    expect(bare.seaErrors!.get('p')).toBeDefined()
  })

  it('seaWindowView：墙钟回拨产生的未来桶不计入窗口', () => {
    const bare = { config: { providers: {} }, health: new Map(), ring: [] } as unknown as GatewayRuntime
    const now = 1_700_000_000_000
    recordSeaOutcome(bare, 'p', { ok: false, cls: '429' }, now + 120_000) // 未来 2 分钟的桶
    recordSeaOutcome(bare, 'p', { ok: true }, now)
    const sp = bare.seaErrors!.get('p')!
    const w = seaWindowView(sp, 60 * 60_000, now)
    expect(w.total).toBe(1) // 只算当下这桶
    expect(w['429']).toBe(0)
  })
})

describe('state-gaps · tokenlimits 记账口径', () => {
  it('recordTokenUsage：无 usage 无操作；缺省字段按 0 累加；当日用量超限后 checkTokenLimits 拦下', () => {
    const r = rt({
      harness: { h: { mode: 'gateway', limits: { daily_tokens: 10 } } },
    } as Partial<Config>)
    const id = 'h'
    expect(checkTokenLimits(r, id)).toBeNull() // 建账
    const st = r.tokenUsage.get(id)!
    recordTokenUsage(r, id, undefined)
    expect(st.dayTokens).toBe(0)
    // 缓存字段缺省 → ?? 0 兜底；billable 独立口径
    recordTokenUsage(r, id, { input_tokens: 6, output_tokens: 4, billable_tokens: 7 })
    expect(st.dayTokens).toBe(10)
    expect(st.dayBillableTokens).toBe(7)
    expect(checkTokenLimits(r, id)).toBe('daily_tokens') // dayTokens 10 >= 10 拦下
  })
})

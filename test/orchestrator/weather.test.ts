// B6 风暴闸（weather hold）测试：窗口计数/阈值判定单测（直接 import weather.mjs）+
// 集成（预置窗口内 worker_retry + mock 瞬时故障凑满阈值 → drain 拒绝派发 + fleet 留痕）。
// 上游海况（countUpstreamStorm）：网关日志 429/402 实测信号同样触发滞留（外部风暴）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { appendEvent, toIsoLocal } from '../../.agents/scripts/orchestrator/events.mjs'
import { appendFleetEvent, countRecentTransient, countUpstreamStorm, fleetLogPath, readFleetEvents, shouldHold } from '../../.agents/scripts/orchestrator/weather.mjs'
import { gatewayLogsDir } from '../../.agents/scripts/orchestrator/reconcile.mjs'
import { cardText, eventsOf, mkRepo, readCard, runOrch } from './helpers.js'
import { fakeHome } from '../helpers.js'

const NOW = Date.parse('2026-11-01T12:00:00Z')

function retryEvent(ageMs: number, seq: number) {
  return { ts: new Date(NOW - ageMs).toISOString(), seq, type: 'worker_retry', attempt: 1, max: 3 }
}

describe('weather > 纯逻辑单测', () => {
  it('countRecentTransient：只数窗口内的 worker_retry，跨任务合计，忽略其他类型', () => {
    const allEvents = [
      { id: 'a', events: [retryEvent(0, 1), retryEvent(60_000, 2), { ts: new Date(NOW).toISOString(), seq: 3, type: 'blocked' }] },
      { id: 'b', events: [retryEvent(59_999, 1), retryEvent(61_000, 2), retryEvent(-1000, 3)] }, // 未来 ts 不算
    ]
    expect(countRecentTransient(allEvents, { windowMs: 60_000, now: NOW })).toBe(3)
    // 窗口滑过：同样的事件在更大的 now 下全部出窗
    expect(countRecentTransient(allEvents, { windowMs: 60_000, now: NOW + 120_000 })).toBe(0)
    // 窗口放大后 b 的 61s 事件也进窗
    expect(countRecentTransient(allEvents, { windowMs: 120_000, now: NOW })).toBe(4)
  })

  it('shouldHold：>= 语义（恰达阈值即滞留）；非数不判', () => {
    expect(shouldHold(3, 3)).toBe(true)
    expect(shouldHold(4, 3)).toBe(true)
    expect(shouldHold(2, 3)).toBe(false)
    expect(shouldHold(Number.NaN, 3)).toBe(false)
  })

  it('appendFleetEvent：独立文件、seq 自增、readFleetEvents 可读回', () => {
    const repo = mkRepo()
    try {
      const a = appendFleetEvent(repo.root, 'weather_hold', { count: 3, windowMinutes: 60 })
      const b = appendFleetEvent(repo.root, 'weather_hold', { count: 5, windowMinutes: 60 })
      expect(a.seq).toBe(1)
      expect(b.seq).toBe(2)
      const events = readFleetEvents(repo.root)
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({ type: 'weather_hold', count: 5 })
      expect(fs.existsSync(fleetLogPath(repo.root))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })
})

/** 手工落任务事件线（不经 run）：构造窗口内/外的 worker_retry 现场。 */
function seedRetries(repo: string, id: string, ageOffsetsMs: number[]) {
  const dir = path.join(repo, '.agents', 'orchestrator', 'logs', id)
  fs.mkdirSync(dir, { recursive: true })
  const lines = ageOffsetsMs.map((age, i) =>
    JSON.stringify({ ts: new Date(Date.now() - age).toISOString(), seq: i + 1, type: 'worker_retry', attempt: 1, max: 3 }),
  )
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${lines.join('\n')}\n`)
}

describe('weather > 集成（drain 风暴滞留）', () => {
  it('窗口内重试凑满阈值 → drain 停止派发（无新 worker_spawned）+ fleet 留痕 weather_hold', () => {
    const repo = mkRepo({ extra: { weatherHold: { threshold: 3, windowMinutes: 60 } } })
    try {
      // 预置：a 全在窗口内（2 条）；b 1 条窗口内 + 1 条 2 小时前（窗口外）→ 预置窗口内合计 3 = 凑满阈值
      seedRetries(repo.root, 'weather-a', [0, 60_000])
      seedRetries(repo.root, 'weather-b', [0, 2 * 3600_000])
      // 第三张卡真跑：mock 瞬时故障原地重试 3 次（10ms 退避）→ blocked，窗口内合计涨到 6
      const cardC = path.join(repo.root, 'card-weather-c.md')
      fs.writeFileSync(cardC, cardText({ id: 'weather-c' }))
      runOrch(repo.root, `submit "${cardC}"`)
      runOrch(repo.root, 'run weather-c --backend mock', { ORCH_MOCK_TRANSIENT: '1', ORCH_RETRY_WAIT_MS: '10' })
      expect(readCard(repo.root, 'blocked', 'weather-c')).toBeTruthy()
      expect(eventsOf(repo.root, 'weather-c').filter((e) => e.type === 'worker_retry')).toHaveLength(3)

      // drain：风暴闸在派发前拦下——weather-d 不被 spawn，仍留 pending
      const cardD = path.join(repo.root, 'card-weather-d.md')
      fs.writeFileSync(cardD, cardText({ id: 'weather-d' }))
      runOrch(repo.root, `submit "${cardD}"`)
      const out = runOrch(repo.root, 'drain --backend mock')
      expect(out.stdout).toContain('风暴滞留')
      expect(eventsOf(repo.root, 'weather-d')).toEqual([]) // 无派发 = 零事件（无 worker_spawned）
      expect(readCard(repo.root, 'pending', 'weather-d')).toBeTruthy()

      // fleet 级留痕：weather_hold 事件带 count 与窗口
      const fleet = readFleetEvents(repo.root)
      const holds = fleet.filter((e) => e.type === 'weather_hold')
      expect(holds).toHaveLength(1)
      expect(holds[0]).toMatchObject({ count: 6, windowMinutes: 60 })
    } finally {
      repo.cleanup()
    }
  })

  it('未配 weatherHold 键 = 功能关闭：同样的重试现场 drain 照常派发（行为不变）', () => {
    const repo = mkRepo()
    try {
      seedRetries(repo.root, 'plain-a', [0, 60_000, 120_000])
      const card = path.join(repo.root, 'card-plain-b.md')
      fs.writeFileSync(card, cardText({ id: 'plain-b' }))
      runOrch(repo.root, `submit "${card}"`)
      const out = runOrch(repo.root, 'drain --backend mock')
      expect(out.stdout).not.toContain('风暴滞留')
      expect(eventsOf(repo.root, 'plain-b').some((e) => e.type === 'worker_spawned')).toBe(true)
      expect(fs.existsSync(fleetLogPath(repo.root))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('worker_retry 经 appendEvent 落盘的真实 ts 同样入窗（toIsoLocal 兼容）', () => {
    const repo = mkRepo()
    try {
      const dir = path.join(repo.root, '.agents', 'orchestrator', 'logs', 'iso-a')
      appendEvent(dir, 'worker_retry', { attempt: 1, max: 3 })
      appendEvent(dir, 'worker_retry', { attempt: 2, max: 3 })
      const events = fs
        .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      expect(countRecentTransient([{ id: 'iso-a', events }], { windowMs: 60 * 60_000 })).toBe(2)
    } finally {
      repo.cleanup()
    }
  })
})

describe('weather > 集成（watch 瞭望模式同样受风暴闸约束）', () => {
  it('滞留期 watch 周期不派发：pending 卡零事件留原地，输出含风暴滞留', () => {
    const repo = mkRepo({ extra: { weatherHold: { threshold: 2, windowMinutes: 60 } } })
    try {
      seedRetries(repo.root, 'watch-w', [0, 60_000]) // 窗口内 2 条 = 凑满阈值
      const card = path.join(repo.root, 'card-watch-x.md')
      fs.writeFileSync(card, cardText({ id: 'watch-x' }))
      runOrch(repo.root, `submit "${card}"`)

      const out = runOrch(repo.root, 'watch --max-cycles 1 --interval 0 --backend mock')
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('风暴滞留')
      expect(eventsOf(repo.root, 'watch-x')).toEqual([]) // 滞留期不派发 = 零事件
      expect(readCard(repo.root, 'pending', 'watch-x')).toBeTruthy()
      expect(readFleetEvents(repo.root).some((e) => e.type === 'weather_hold')).toBe(true)
    } finally {
      repo.cleanup()
    }
  })
})

describe('weather > 上游海况（countUpstreamStorm，网关实测外部风暴）', () => {
  /** 往 fakeHome 网关日志写一条请求（ts 用本地 ISO——日文件按本地日期切分）。 */
  function writeGwEntry(ageMs: number, status: number) {
    const dir = gatewayLogsDir()
    if (!dir) throw new Error('fakeHome 未生效')
    fs.mkdirSync(dir, { recursive: true })
    const ts = toIsoLocal(new Date(Date.now() - ageMs))
    fs.appendFileSync(path.join(dir, `gateway-${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ts, harness: 'zcode', profile: 'p', provider: 'up', path: '/v1/messages', status }) + '\n')
  }

  it('窗口内 429/402 计数；500 与窗外不计；gwDir=null 恒 0（观测缺席 ≠ 风暴）', () => {
    const h = fakeHome()
    try {
      writeGwEntry(0, 429)
      writeGwEntry(60_000, 402)
      writeGwEntry(120_000, 429)
      writeGwEntry(60_000, 500) // 非限流/额度类：不计
      writeGwEntry(20 * 60_000, 429) // 窗外（> 15 分钟）：不计
      const dir = gatewayLogsDir()
      expect(countUpstreamStorm(dir, { windowMs: 15 * 60_000 })).toBe(3)
      expect(countUpstreamStorm(null, { windowMs: 15 * 60_000 })).toBe(0)
      // 窗口放大到 30 分钟：窗外那条也入窗
      expect(countUpstreamStorm(dir, { windowMs: 30 * 60_000 })).toBe(4)
    } finally {
      h.restore()
    }
  })

  it('upstream 达阈（worker_retry 未达）→ drain 滞留点名为「上游风暴」，fleet 事件带上游字段', () => {
    const h = fakeHome()
    // worker_retry 阈值给大（0 条也永不触发），只让上游信号触发
    const repo = mkRepo({ extra: { weatherHold: { threshold: 99, windowMinutes: 60, upstream: { threshold: 2, windowMinutes: 15 } } } })
    try {
      writeGwEntry(0, 429)
      writeGwEntry(60_000, 429)
      const card = path.join(repo.root, 'card-sea-x.md')
      fs.writeFileSync(card, cardText({ id: 'sea-x' }))
      runOrch(repo.root, `submit "${card}"`)
      const out = runOrch(repo.root, 'drain --backend mock')
      expect(out.stdout).toContain('风暴滞留')
      expect(out.stdout).toContain('上游风暴')
      expect(eventsOf(repo.root, 'sea-x')).toEqual([]) // 未派发
      expect(readCard(repo.root, 'pending', 'sea-x')).toBeTruthy()
      const hold = readFleetEvents(repo.root).find((e) => e.type === 'weather_hold')
      expect(hold).toBeTruthy()
      expect(hold.upstream).toEqual({ count: 2, threshold: 2, windowMinutes: 15 })
    } finally {
      repo.cleanup()
      h.restore()
    }
  })

  it('配置了 upstream 但网关日志不可得（无 gatewayLogDir）→ 不滞留照常派发', () => {
    const savedFake = process.env.MODELRDOCK_FAKE_HOME
    const savedHome = process.env.MODELRDOCK_HOME
    delete process.env.MODELRDOCK_FAKE_HOME
    delete process.env.MODELRDOCK_HOME
    const repo = mkRepo({ extra: { weatherHold: { threshold: 99, windowMinutes: 60, upstream: { threshold: 1, windowMinutes: 15 } } } })
    try {
      const card = path.join(repo.root, 'card-sea-off.md')
      fs.writeFileSync(card, cardText({ id: 'sea-off' }))
      runOrch(repo.root, `submit "${card}"`)
      const out = runOrch(repo.root, 'drain --backend mock')
      expect(out.stdout).not.toContain('风暴滞留')
      expect(eventsOf(repo.root, 'sea-off').some((e) => e.type === 'worker_spawned')).toBe(true)
    } finally {
      repo.cleanup()
      if (savedFake !== undefined) process.env.MODELRDOCK_FAKE_HOME = savedFake
      else delete process.env.MODELRDOCK_FAKE_HOME
      if (savedHome !== undefined) process.env.MODELRDOCK_HOME = savedHome
      else delete process.env.MODELRDOCK_HOME
    }
  }, 90_000)
})

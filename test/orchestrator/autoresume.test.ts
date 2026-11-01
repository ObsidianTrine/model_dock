// blocked 卡有限自动续跑测试（autoresume.mjs + drain 接线）。
// 设计总纲四条的回归网：只续 transient 类、每卡 24h 冷却最多 1 次、每晚（每次 drain）
// ≤maxPerRun 张、事件留痕可全局关闭。资格判定是纯函数全覆盖；drain 集成走临时仓库
// + mock 后端（与 integration.test.ts 同沙箱），子进程隔离无 mock 注册表污染。

import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardText, mkRepo, readCard, runOrch, eventsOf } from './helpers.js'
import { ensureQueue, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'
import {
  cooldownPassed,
  isTransientBlocked,
  pickAutoResumeCandidates,
  scanBlockedCards,
  withAutoResumedAt,
} from '../../.agents/scripts/orchestrator/autoresume.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-11-02T12:00:00+08:00')

/** 造事件（seq 对纯函数无意义，ts 才参与 blocked 排序）。 */
function ev(type: string, extra: Record<string, unknown> = {}, ts = '2026-11-01T01:00:00.000+08:00') {
  return { ts, seq: 0, type, ...extra }
}

function bcard(id: string, events: Array<Record<string, unknown>>, meta: Record<string, unknown> = {}) {
  return { id, meta, events }
}

describe('orchestrator autoresume > isTransientBlocked 资格定性', () => {
  it('case A：最后 settle 事件 reason/detail 带 429/网络签名 → transient', () => {
    expect(isTransientBlocked([ev('worker_spawned'), ev('blocked', { reason: '未产出结果块：HTTP 429 too many requests' })])).toBe(true)
    expect(isTransientBlocked([ev('worker_spawned'), ev('failed', { reason: '异常中断：fetch failed (ECONNRESET)' })])).toBe(true) // failTaskToBlocked 形态
    expect(isTransientBlocked([ev('worker_spawned'), ev('circuit_breaker', { reason: 'watchdog', detail: '上游 rate limit，判定无进展' })])).toBe(true)
  })

  it('非 transient 一律拒：stuck 自报、预算熔断、空事件链、无 settle 事件', () => {
    expect(isTransientBlocked([ev('worker_spawned'), ev('blocked', { reason: 'worker 自报 stuck' })])).toBe(false)
    expect(isTransientBlocked([ev('worker_spawned'), ev('circuit_breaker', { reason: 'budget:max_tokens', detail: '超限' }), ev('blocked', { reason: 'budget:max_tokens' })])).toBe(false)
    expect(isTransientBlocked([])).toBe(false)
    expect(isTransientBlocked([ev('worker_spawned'), ev('worker_done', { summary: 'ok' })])).toBe(false)
  })

  it('case B：worker_retry 链 + 最终 blocked → transient（429 重试用尽的典型形态）', () => {
    const events = [
      ev('worker_spawned'),
      ev('worker_retry', { attempt: 1, max: 3, wait_s: 60 }, '2026-11-01T01:05:00.000+08:00'),
      ev('worker_retry', { attempt: 2, max: 3, wait_s: 120 }, '2026-11-01T01:15:00.000+08:00'),
      ev('blocked', { reason: '未产出结果块（worker 异常结束）' }, '2026-11-01T01:30:00.000+08:00'),
    ]
    expect(isTransientBlocked(events)).toBe(true)
    // blocked 事件 reason 本身不带签名，纯靠链路定性
    expect(isTransientBlocked([ev('worker_retry'), ev('blocked', { reason: '未产出结果块（worker 异常结束）' })])).toBe(true)
  })

  it('case B 护栏：最后一次 worker_retry 之后出现 circuit_breaker（确定性失败）→ 拒', () => {
    const events = [
      ev('worker_spawned'),
      ev('worker_retry', { attempt: 1, max: 3 }),
      ev('circuit_breaker', { reason: 'budget:max_wall_minutes', detail: '40/30 min' }),
      ev('blocked', { reason: 'budget:max_wall_minutes' }),
    ]
    expect(isTransientBlocked(events)).toBe(false)
  })

  it('看门狗熔断（circuit_breaker 收尾、无 blocked 事件）→ 拒', () => {
    expect(isTransientBlocked([ev('worker_spawned'), ev('circuit_breaker', { reason: 'watchdog', detail: '连续 2 次无实质进展' })])).toBe(false)
  })
})

describe('orchestrator autoresume > cooldownPassed 冷却判定', () => {
  it('无 auto_resumed_at → 合格；24h 内 → 拒；超 24h → 合格；脏值保守拒', () => {
    expect(cooldownPassed({}, NOW, 24 * HOUR)).toBe(true)
    expect(cooldownPassed({ auto_resumed_at: '2026-11-02T00:00:00+08:00' }, NOW, 24 * HOUR)).toBe(false) // 12h 前
    expect(cooldownPassed({ auto_resumed_at: '2026-11-01T00:00:00+08:00' }, NOW, 24 * HOUR)).toBe(true) // 36h 前
    expect(cooldownPassed({ auto_resumed_at: 'not-a-date' }, NOW, 24 * HOUR)).toBe(false)
    expect(cooldownPassed(undefined, NOW, 24 * HOUR)).toBe(true)
  })
})

describe('orchestrator autoresume > pickAutoResumeCandidates 纯函数', () => {
  const transientEvents = () => [
    ev('worker_spawned'),
    ev('worker_retry', { attempt: 1, max: 3 }),
    ev('blocked', { reason: '未产出结果块（worker 异常结束）' }),
  ]

  it('transient 卡入选，attempts 记 worker_retry 次数', () => {
    const picked = pickAutoResumeCandidates([bcard('a', transientEvents())], { now: NOW })
    expect(picked).toEqual([{ id: 'a', attempts: 1, blockedAt: Date.parse('2026-11-01T01:00:00.000+08:00') }])
  })

  it('cooldown 24h 内拒（auto_resumed_at 注入 frontmatter）；超冷却合格；cooldownMs 可注入', () => {
    const cards = [
      bcard('fresh', transientEvents(), { auto_resumed_at: '2026-11-02T00:00:00+08:00' }), // 12h 前
      bcard('stale', transientEvents(), { auto_resumed_at: '2026-11-01T00:00:00+08:00' }), // 36h 前
    ]
    expect(pickAutoResumeCandidates(cards, { now: NOW }).map((c) => c.id)).toEqual(['stale'])
    // cooldownMs=6h：12h 前的标记已过期，fresh 也合格
    expect(pickAutoResumeCandidates(cards, { now: NOW, cooldownMs: 6 * HOUR }).map((c) => c.id)).toEqual(['fresh', 'stale'])
  })

  it('超过 maxPerRun 截断；按 blocked 时间升序（同刻按 id 稳定）', () => {
    const cards = [
      bcard('c-late', [ev('blocked', { reason: 'HTTP 429' }, '2026-11-01T03:00:00.000+08:00')]),
      bcard('a-first', [ev('blocked', { reason: 'HTTP 429' }, '2026-11-01T01:00:00.000+08:00')]),
      bcard('b-mid', [ev('blocked', { reason: 'HTTP 429' }, '2026-11-01T02:00:00.000+08:00')]),
    ]
    expect(pickAutoResumeCandidates(cards, { now: NOW, maxPerRun: 2 }).map((c) => c.id)).toEqual(['a-first', 'b-mid'])
    expect(pickAutoResumeCandidates(cards, { now: NOW, maxPerRun: 10 }).map((c) => c.id)).toEqual(['a-first', 'b-mid', 'c-late'])
  })

  it('blocked 时间缺失按最早处理（先续先解脱，id 兜底稳定排序）', () => {
    const noTsEvents = () => [{ seq: 0, type: 'blocked', reason: 'HTTP 429' }] as Array<Record<string, unknown>>
    const cards = [
      bcard('z-ts', [ev('blocked', { reason: 'HTTP 429' }, '2026-11-01T05:00:00.000+08:00')]),
      bcard('a-nots', noTsEvents()),
      bcard('a-nots2', noTsEvents()),
    ]
    expect(pickAutoResumeCandidates(cards, { now: NOW, maxPerRun: 3 }).map((c) => c.id)).toEqual(['a-nots', 'a-nots2', 'z-ts'])
  })

  it('opts 非法静默回落缺省（maxPerRun=2、cooldownMs=24h；配置层才告警）', () => {
    const cards = [
      bcard('a', transientEvents()),
      bcard('b', transientEvents()),
      bcard('c', transientEvents()),
      bcard('fresh', transientEvents(), { auto_resumed_at: '2026-11-02T00:00:00+08:00' }),
    ]
    // maxPerRun=0 回落 2：只出 a、b（c 被截断）
    expect(pickAutoResumeCandidates(cards, { now: NOW, maxPerRun: 0 }).map((c) => c.id)).toEqual(['a', 'b'])
    // cooldownMs=-1 回落 24h：fresh（12h 前自动续过）仍在冷却，同样截到 2 张
    expect(pickAutoResumeCandidates(cards, { now: NOW, cooldownMs: -1 }).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('混合队列：非 transient / 冷却中 / 熔断收尾的卡全被过滤', () => {
    const cards = [
      bcard('stuck', [ev('blocked', { reason: 'worker 自报 stuck' })]),
      bcard('budget', [ev('worker_retry'), ev('circuit_breaker', { reason: 'budget:max_tokens' }), ev('blocked', { reason: 'budget:max_tokens' })]),
      bcard('cooling', transientEvents(), { auto_resumed_at: '2026-11-02T06:00:00+08:00' }),
      bcard('good', [ev('blocked', { reason: '上游 429 too many requests，未产出结果块' })]),
      bcard('retry-chain', transientEvents()),
    ]
    expect(pickAutoResumeCandidates(cards, { now: NOW, maxPerRun: 5 }).map((c) => c.id)).toEqual(['good', 'retry-chain'])
  })
})

describe('orchestrator autoresume > withAutoResumedAt frontmatter 冷却标记', () => {
  it('无该字段时插入到 frontmatter 末尾（正文不动）', () => {
    const text = cardText({ id: 'tr1' })
    const next = withAutoResumedAt(text, '2026-11-02T12:00:00.000+08:00')
    expect(next).toContain('auto_resumed_at: 2026-11-02T12:00:00.000+08:00')
    expect(next).toContain('# 目标')
    expect(next.startsWith('---\n')).toBe(true)
    // 插入行在 frontmatter 内（第二个 --- 之前）
    expect(next.indexOf('auto_resumed_at')).toBeLessThan(next.indexOf('---\n\n# 目标'))
  })

  it('已有该字段时覆盖旧值（冷却刷新），不重复成两行', () => {
    const once = withAutoResumedAt(cardText({ id: 'tr1' }), '2026-11-01T00:00:00.000+08:00')
    const twice = withAutoResumedAt(once, '2026-11-02T12:00:00.000+08:00')
    expect(twice.match(/auto_resumed_at:/g)).toHaveLength(1)
    expect(twice).toContain('auto_resumed_at: 2026-11-02T12:00:00.000+08:00')
    expect(twice).not.toContain('2026-11-01T00:00:00.000+08:00')
  })

  it('无 frontmatter 原样返回（不炸、不写）', () => {
    expect(withAutoResumedAt('不是任务卡', '2026-11-02T12:00:00.000+08:00')).toBe('不是任务卡')
  })
})

describe('orchestrator autoresume > scanBlockedCards 扫描（读不了跳过并计入 unreadable）', () => {
  it('可解析卡带 meta/events 备齐；损坏卡进 unreadable；total 为全量', () => {
    const repo = mkRepo()
    try {
      const root = queueRoot(repo.root)
      ensureQueue(root)
      fs.writeFileSync(path.join(root, 'blocked', 'good.md'), cardText({ id: 'good' }))
      fs.writeFileSync(path.join(root, 'blocked', 'broken.md'), '不是合法任务卡')
      const dir = path.join(repo.root, '.agents', 'orchestrator', 'logs', 'good')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(ev('blocked', { reason: 'HTTP 429' })) + '\n')
      const { candidates, unreadable, total } = scanBlockedCards(repo.root, root)
      expect(total).toBe(2)
      expect(unreadable).toEqual(['broken'])
      expect(candidates).toHaveLength(1)
      expect(candidates[0].id).toBe('good')
      expect(candidates[0].events).toHaveLength(1)
      expect(candidates[0].meta.id).toBe('good')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator autoresume > workflow.json autoResume 配置解析', () => {
  function fixture(workflow: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcfg-ar-'))
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify(workflow))
    return dir
  }

  it('缺省 enabled=true / maxPerRun=2 / cooldownHours=24', () => {
    const dir = fixture({})
    try {
      expect(loadWorkflowConfig(dir).autoResume).toEqual({ enabled: true, maxPerRun: 2, cooldownHours: 24 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('显式值生效（enabled:false 关闭 / 自定义上界与冷却）', () => {
    const dir = fixture({ autoResume: { enabled: false, maxPerRun: 5, cooldownHours: 48 } })
    try {
      expect(loadWorkflowConfig(dir).autoResume).toEqual({ enabled: false, maxPerRun: 5, cooldownHours: 48 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非法值回落缺省并 console.warn（键缺失不告警）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = fixture({ autoResume: 'banana' })
    const wfPath = path.join(dir, '.agents', 'workflow.json')
    try {
      expect(loadWorkflowConfig(dir).autoResume).toEqual({ enabled: true, maxPerRun: 2, cooldownHours: 24 })
      expect(String(warn.mock.calls[0]?.[0])).toContain('autoResume')
      warn.mockClear()
      for (const bad of [{ enabled: 'no' }, { maxPerRun: 0 }, { maxPerRun: 1.5 }, { cooldownHours: -1 }, ['true']]) {
        fs.writeFileSync(wfPath, JSON.stringify({ autoResume: bad }))
        expect(loadWorkflowConfig(dir).autoResume).toEqual({ enabled: true, maxPerRun: 2, cooldownHours: 24 })
        expect(warn.mock.calls.length).toBeGreaterThan(0)
        warn.mockClear()
      }
      // 键缺失 = 沿用缺省且不告警
      fs.writeFileSync(wfPath, JSON.stringify({ autoResume: { maxPerRun: 3 } }))
      expect(loadWorkflowConfig(dir).autoResume).toEqual({ enabled: true, maxPerRun: 3, cooldownHours: 24 })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      warn.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// drain 集成（临时仓库 + mock 后端，子进程隔离）
// ---------------------------------------------------------------------------

/** 造一张已 blocked 的卡：卡文件进 blocked/，手写 events.jsonl（transient 现场）。 */
function seedBlocked(repo: string, id: string, events: Array<Record<string, unknown>>) {
  ensureQueue(queueRoot(repo))
  fs.writeFileSync(path.join(repo, '.agents', 'orchestrator', 'queue', 'blocked', `${id}.md`), cardText({ id }))
  const dir = path.join(repo, '.agents', 'orchestrator', 'logs', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

const RETRY_EXHAUSTED_EVENTS = [
  { ts: '2026-11-01T01:00:00.000+08:00', seq: 1, type: 'task_accepted', backend: 'mock' },
  { ts: '2026-11-01T01:05:00.000+08:00', seq: 2, type: 'worker_spawned', backend: 'mock', pid: 100 },
  { ts: '2026-11-01T01:10:00.000+08:00', seq: 3, type: 'worker_retry', attempt: 1, max: 3, wait_s: 60 },
  { ts: '2026-11-01T01:20:00.000+08:00', seq: 4, type: 'worker_retry', attempt: 2, max: 3, wait_s: 120 },
  { ts: '2026-11-01T01:30:00.000+08:00', seq: 5, type: 'blocked', reason: '未产出结果块（worker 异常结束）' },
]

describe('orchestrator autoresume > drain 集成（mock 后端）', () => {
  it('transient blocked 卡被自动续（走 resume 闭环到 awaiting-human），非 transient 卡原地不动', () => {
    const repo = mkRepo()
    try {
      seedBlocked(repo.root, 'tr1', RETRY_EXHAUSTED_EVENTS)
      seedBlocked(repo.root, 'st1', [
        { ts: '2026-11-01T02:00:00.000+08:00', seq: 1, type: 'worker_spawned', backend: 'mock', pid: 101 },
        { ts: '2026-11-01T02:05:00.000+08:00', seq: 2, type: 'blocked', reason: 'worker 自报 stuck' },
      ])
      seedBlocked(repo.root, 'cb1', [
        { ts: '2026-11-01T03:00:00.000+08:00', seq: 1, type: 'worker_spawned', backend: 'mock', pid: 102 },
        { ts: '2026-11-01T03:05:00.000+08:00', seq: 2, type: 'worker_retry', attempt: 1, max: 3 },
        { ts: '2026-11-01T03:10:00.000+08:00', seq: 3, type: 'circuit_breaker', reason: 'budget:max_wall_minutes', detail: '40/30 min' },
        { ts: '2026-11-01T03:15:00.000+08:00', seq: 4, type: 'blocked', reason: 'budget:max_wall_minutes' },
      ])
      fs.writeFileSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', 'broken.md'), '不是合法任务卡')

      const run = runOrch(repo.root, 'drain --backend mock')
      expect(run.stdout).toContain('自动续 blocked 卡 tr1')
      expect(run.stdout).toContain('已续 1 张（tr1）')

      // tr1：走既有 resume 闭环跑完 → awaiting-human；事件留痕区别于人工 resume
      expect(readCard(repo.root, 'awaiting-human', 'tr1')).toBeTruthy()
      expect(readCard(repo.root, 'awaiting-human', 'tr1')).toContain('auto_resumed_at:')
      const types = eventsOf(repo.root, 'tr1').map((e) => e.type)
      expect(types).toContain('auto_resume')
      const auto = eventsOf(repo.root, 'tr1').find((e) => e.type === 'auto_resume')
      expect(auto?.card).toBe('tr1')
      expect(auto?.attempts).toBe(2)
      const resumed = eventsOf(repo.root, 'tr1').find((e) => e.type === 'resumed')
      expect(resumed?.by).toBe('auto')
      // auto_resume 先于本轮闭环后续事件（先留痕再派工；running 态续跑无新 task_accepted，以 worker_spawned 为界）
      const autoIdx = types.indexOf('auto_resume')
      expect(autoIdx).toBeGreaterThan(-1)
      expect(types.indexOf('worker_spawned', autoIdx)).toBeGreaterThan(autoIdx)

      // 非 transient：stuck 自报与熔断收尾的卡原地不动
      expect(readCard(repo.root, 'blocked', 'st1')).toBeTruthy()
      expect(readCard(repo.root, 'blocked', 'cb1')).toBeTruthy()
      expect(eventsOf(repo.root, 'st1').map((e) => e.type)).not.toContain('auto_resume')
      expect(eventsOf(repo.root, 'cb1').map((e) => e.type)).not.toContain('auto_resume')
    } finally {
      repo.cleanup()
    }
  })

  it('autoResume.enabled=false 完全不扫：blocked 卡不动、零 auto_resume 事件', () => {
    const repo = mkRepo({ extra: { autoResume: { enabled: false } } })
    try {
      seedBlocked(repo.root, 'tr2', RETRY_EXHAUSTED_EVENTS)
      const run = runOrch(repo.root, 'drain --backend mock')
      expect(run.stdout).not.toContain('自动续')
      expect(readCard(repo.root, 'blocked', 'tr2')).toBeTruthy()
      expect(eventsOf(repo.root, 'tr2').map((e) => e.type)).not.toContain('auto_resume')
    } finally {
      repo.cleanup()
    }
  })

  it('drift 降级期间自动续暂停（降级 = 全人工）', () => {
    const repo = mkRepo()
    try {
      seedBlocked(repo.root, 'tr3', RETRY_EXHAUSTED_EVENTS)
      fs.mkdirSync(path.join(repo.root, '.agents', 'orchestrator'), { recursive: true })
      fs.writeFileSync(
        path.join(repo.root, '.agents', 'orchestrator', 'degraded.json'),
        JSON.stringify({ degraded_at: '2026-11-01T00:00:00.000Z', reason: '测试降级' }),
      )
      const run = runOrch(repo.root, 'drain --backend mock')
      expect(run.stdout).toContain('drift 降级期间自动续暂停')
      expect(readCard(repo.root, 'blocked', 'tr3')).toBeTruthy()
      expect(eventsOf(repo.root, 'tr3').map((e) => e.type)).not.toContain('auto_resume')
    } finally {
      repo.cleanup()
    }
  })
})

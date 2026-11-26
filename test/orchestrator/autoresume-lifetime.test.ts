// autoresume 全生命周期上限 + signal_hashes 写侧归一测试（2026-11-15 质量专项 P1-⑨）。
// ① 生命周期上限：withAutoResumedAt 每次自动续把 auto_resume_count +1（随卡走、blocked
//    与孤儿两通道共享同一累计值）；pick 两通道达上限（缺省 3，workflow.json
//    autoResume.maxPerCard 可调）即拒，lifetimeCapRejections 产出留痕清单（同一上限状态
//    只报一次）。「续→崩→冷却→续」无限循环烧钱在此封顶：模拟 3 轮续→blocked 后第 4 次被拒。
// ② signal_hashes 写侧归一：normalizeSignalHashes 收紧写入口径（非数组/野值 → 空数组 →
//    落卡整行省略），与读侧 collectFilterContext 的守卫同一变换（写进口径 ⊆ 读入口径）；
//    runScan 端到端只落干净哈希行。
// 纯函数全覆盖 + runScan 临时目录集成；零模块 mock（vitest isolate:false 共享注册表雷区规避）。

import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardText } from './helpers.js'
import { parseCard, queueRoot, ensureQueue } from '../../.agents/scripts/orchestrator/queue.mjs'
import {
  AUTO_RESUME_COUNT_KEY,
  DEFAULT_MAX_PER_CARD,
  autoResumeCountOf,
  classifyOrphan,
  lifetimeCapReached,
  lifetimeCapRejections,
  pickAutoResumeCandidates,
  pickOrphanResumeCandidates,
  scanBlockedCards,
  withAutoResumedAt,
} from '../../.agents/scripts/orchestrator/autoresume.mjs'
import { normalizeSignalHashes } from '../../.agents/scripts/orchestrator/eventfilter.mjs'
import { runScan } from '../../.agents/scripts/orchestrator/scan.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-11-02T12:00:00+08:00')

/** 造事件（seq 对纯函数无意义）。 */
function ev(type: string, extra: Record<string, unknown> = {}, ts = '2026-11-01T01:00:00.000+08:00') {
  return { ts, seq: 0, type, ...extra }
}

function bcard(id: string, events: Array<Record<string, unknown>>, meta: Record<string, unknown> = {}) {
  return { id, meta, events }
}

/** transient 现场事件（429 收尾，自动续资格成立的最小形态）。 */
const transientEvents = () => [
  ev('worker_spawned'),
  ev('worker_retry', { attempt: 1, max: 3 }),
  ev('blocked', { reason: 'HTTP 429 too many requests' }),
]

describe('orchestrator autoresume lifetime > autoResumeCountOf 读累计值', () => {
  it('缺字段/空值 = 0（从没自动续过）；非负整数原样透出', () => {
    expect(autoResumeCountOf({})).toBe(0)
    expect(autoResumeCountOf(undefined)).toBe(0)
    expect(autoResumeCountOf({ [AUTO_RESUME_COUNT_KEY]: 0 })).toBe(0)
    expect(autoResumeCountOf({ [AUTO_RESUME_COUNT_KEY]: 3 })).toBe(3)
    expect(autoResumeCountOf({ [AUTO_RESUME_COUNT_KEY]: '' })).toBe(0)
    expect(autoResumeCountOf({ [AUTO_RESUME_COUNT_KEY]: null })).toBe(0)
  })

  it('脏值（负数/小数/字符串）= -1，调用方按已达上限保守处理（宁少勿滥，与冷却脏值口径同哲学）', () => {
    expect(autoResumeCountOf({ [AUTO_RESUME_COUNT_KEY]: -1 })).toBe(-1)
    expect(autoResumeCountOf({ [AUTO_RESUME_COUNT_KEY]: 1.5 })).toBe(-1)
    expect(autoResumeCountOf({ [AUTO_RESUME_COUNT_KEY]: 'abc' })).toBe(-1)
  })
})

describe('orchestrator autoresume lifetime > lifetimeCapReached 上限判定', () => {
  it('缺省上限 3：count 0-2 未达、3 达标；脏值视为达标', () => {
    expect(DEFAULT_MAX_PER_CARD).toBe(3)
    expect(lifetimeCapReached({}, DEFAULT_MAX_PER_CARD)).toBe(false)
    expect(lifetimeCapReached({ [AUTO_RESUME_COUNT_KEY]: 2 }, DEFAULT_MAX_PER_CARD)).toBe(false)
    expect(lifetimeCapReached({ [AUTO_RESUME_COUNT_KEY]: 3 }, DEFAULT_MAX_PER_CARD)).toBe(true)
    expect(lifetimeCapReached({ [AUTO_RESUME_COUNT_KEY]: 'abc' }, DEFAULT_MAX_PER_CARD)).toBe(true)
  })

  it('maxPerCard 注入生效；非法值（0/负数/非整数/undefined）回落缺省 3', () => {
    expect(lifetimeCapReached({ [AUTO_RESUME_COUNT_KEY]: 3 }, 5)).toBe(false)
    expect(lifetimeCapReached({ [AUTO_RESUME_COUNT_KEY]: 3 }, 1)).toBe(true)
    expect(lifetimeCapReached({ [AUTO_RESUME_COUNT_KEY]: 3 }, 0)).toBe(true) // 回落 3
    expect(lifetimeCapReached({ [AUTO_RESUME_COUNT_KEY]: 3 }, undefined)).toBe(true)
    expect(lifetimeCapReached({ [AUTO_RESUME_COUNT_KEY]: 3 }, 2.5)).toBe(true)
  })
})

describe('orchestrator autoresume lifetime > withAutoResumedAt 累计留痕', () => {
  it('首续：auto_resume_count 从无到 1，auto_resumed_at 同步落卡，正文不动', () => {
    const next = withAutoResumedAt(cardText({ id: 't1' }), '2026-11-02T12:00:00.000+08:00')
    expect(next).toContain('auto_resume_count: 1')
    expect(next).toContain('auto_resumed_at: 2026-11-02T12:00:00.000+08:00')
    expect(next).toContain('# 目标')
    expect(next.indexOf('auto_resume_count')).toBeLessThan(next.indexOf('---\n\n# 目标'))
  })

  it('模拟 3 轮「续→blocked」循环：每次 +1 → 累计 3（生命周期留痕随卡走）', () => {
    let text = cardText({ id: 'loop' })
    for (let i = 1; i <= 3; i++) {
      text = withAutoResumedAt(text, `2026-11-0${i}T00:00:00.000+08:00`)
    }
    expect(text.match(/auto_resume_count:/g)).toHaveLength(1)
    expect(text).toContain('auto_resume_count: 3')
    expect(text).toContain('auto_resumed_at: 2026-11-03T00:00:00.000+08:00')
    const { meta } = parseCard(text, 'loop.md')
    expect(meta[AUTO_RESUME_COUNT_KEY]).toBe(3)
  })

  it('旧值非正（负数/脏值）按 1 重计：上限闸拦在 pick 之前，此处只是防御性兜底', () => {
    expect(withAutoResumedAt(cardText({ id: 'd1', auto_resume_count: -2 }), 'X')).toContain('auto_resume_count: 1')
    expect(withAutoResumedAt(cardText({ id: 'd2', auto_resume_count: 'oops' }), 'X')).toContain('auto_resume_count: 1')
  })

  it('无 frontmatter 原样返回（不炸、不写），与冷却标记行为一致', () => {
    expect(withAutoResumedAt('不是任务卡', 'X')).toBe('不是任务卡')
  })
})

describe('orchestrator autoresume lifetime > 3 次循环第 4 次拒（核心验收）', () => {
  it('累计 3 次的 transient 卡不再入选；累计 0-2 照常入选', () => {
    const cards = [
      bcard('n0', transientEvents()),
      bcard('n1', transientEvents(), { [AUTO_RESUME_COUNT_KEY]: 1 }),
      bcard('n2', transientEvents(), { [AUTO_RESUME_COUNT_KEY]: 2 }),
      bcard('n3', transientEvents(), { [AUTO_RESUME_COUNT_KEY]: 3 }),
    ]
    expect(pickAutoResumeCandidates(cards, { now: NOW, maxPerRun: 10 }).map((c: { id: string }) => c.id)).toEqual(['n0', 'n1', 'n2'])
    // 第 4 次（第 3 轮 blocked 后再触发的自动续请求）被拒且注明原因
    expect(lifetimeCapRejections(cards, { maxPerCard: DEFAULT_MAX_PER_CARD })).toEqual([
      { id: 'n3', count: 3, cap: 3 },
    ])
  })

  it('maxPerCard 可调：上限 5 时 count 3 仍可续；上限 1 时 count 1 即拒', () => {
    const c3 = [bcard('c3', transientEvents(), { [AUTO_RESUME_COUNT_KEY]: 3 })]
    expect(pickAutoResumeCandidates(c3, { now: NOW, maxPerCard: 5 }).map((c: { id: string }) => c.id)).toEqual(['c3'])
    expect(lifetimeCapRejections(c3, { maxPerCard: 5 })).toEqual([])
    const c1 = [bcard('c1', transientEvents(), { [AUTO_RESUME_COUNT_KEY]: 1 })]
    expect(pickAutoResumeCandidates(c1, { now: NOW, maxPerCard: 1 }).map((c: { id: string }) => c.id)).toEqual([])
    expect(lifetimeCapRejections(c1, { maxPerCard: 1 })).toEqual([{ id: 'c1', count: 1, cap: 1 }])
  })

  it('脏值累计卡拒续并留痕（count 原样透出便于人工排查）', () => {
    const dirty = [bcard('dirty', transientEvents(), { [AUTO_RESUME_COUNT_KEY]: 'tampered' })]
    expect(pickAutoResumeCandidates(dirty, { now: NOW })).toEqual([])
    expect(lifetimeCapRejections(dirty, {})).toEqual([{ id: 'dirty', count: 'tampered', cap: 3 }])
  })
})

describe('orchestrator autoresume lifetime > 冷却语义不回归（上限与冷却叠加）', () => {
  it('冷却内（count 未达上限）照旧拒续、不误报上限拒绝——既有语义零回归', () => {
    const cooling = [bcard('cooling', transientEvents(), { auto_resumed_at: '2026-11-02T00:00:00+08:00', [AUTO_RESUME_COUNT_KEY]: 1 })]
    expect(pickAutoResumeCandidates(cooling, { now: NOW })).toEqual([])
    expect(lifetimeCapRejections(cooling, {})).toEqual([])
  })

  it('达上限且仍在冷却：上限闸优先（永久性拒绝先于时限性冷却报因），冷却判定本身不受影响', () => {
    const cappedCooling = [bcard('cc', transientEvents(), { auto_resumed_at: '2026-11-02T00:00:00+08:00', [AUTO_RESUME_COUNT_KEY]: 3 })]
    expect(pickAutoResumeCandidates(cappedCooling, { now: NOW })).toEqual([])
    expect(lifetimeCapRejections(cappedCooling, {})).toEqual([{ id: 'cc', count: 3, cap: 3 }])
  })

  it('冷却过期后（count 未达上限）照常入选——24h 冷却判定路径与改造前等价', () => {
    const stale = [bcard('stale', transientEvents(), { auto_resumed_at: '2026-11-01T00:00:00+08:00', [AUTO_RESUME_COUNT_KEY]: 1 })]
    expect(pickAutoResumeCandidates(stale, { now: NOW, cooldownMs: 24 * HOUR }).map((c: { id: string }) => c.id)).toEqual(['stale'])
  })
})

describe('orchestrator autoresume lifetime > 孤儿通道同上限（frontmatter 随卡走，两通道共享）', () => {
  const crashEvents = () => [ev('task_accepted'), ev('worker_spawned', { pid: 1 })]

  it('count 3 的孤儿不入选；count 2 照常入选（孤儿资格口径走 classifyOrphan 谓词，与生产接线一致）', () => {
    const cards = [
      { id: 'o2', meta: { [AUTO_RESUME_COUNT_KEY]: 2 }, events: crashEvents() },
      { id: 'o3', meta: { [AUTO_RESUME_COUNT_KEY]: 3 }, events: crashEvents() },
    ]
    expect(pickOrphanResumeCandidates(cards, { now: NOW, maxPerRun: 5 }).map((c: { id: string }) => c.id)).toEqual(['o2'])
    const orphanEligible = (c: { events: Array<Record<string, unknown>> }) => classifyOrphan(c.events) === 'resume'
    expect(lifetimeCapRejections(cards, { isEligible: orphanEligible })).toEqual([{ id: 'o3', count: 3, cap: 3 }])
  })

  it('孤儿通道上限拒绝去重与资格判定同口径：非 resume 归类（stuck）不算「被上限拒」', () => {
    const stuck = [{ id: 'st', meta: { [AUTO_RESUME_COUNT_KEY]: 3 }, events: [ev('worker_spawned'), ev('blocked', { reason: 'worker 自报 stuck' })] }]
    const orphanEligible = (c: { events: Array<Record<string, unknown>> }) => classifyOrphan(c.events) === 'resume'
    expect(lifetimeCapRejections(stuck, { isEligible: orphanEligible })).toEqual([])
  })
})

describe('orchestrator autoresume lifetime > lifetimeCapRejections 去重口径', () => {
  it('同一上限状态只报一次：事件链末条 auto_resume 系事件已是 lifetime_cap 拒绝 → 不重复报', () => {
    const reported = [
      bcard('dup', [
        ...transientEvents(),
        ev('auto_resume', { card: 'dup', attempts: 1 }, '2026-11-01T02:00:00.000+08:00'),
        ev('auto_resume_rejected', { card: 'dup', reason: 'lifetime_cap', count: 3, max_per_card: 3 }, '2026-11-01T03:00:00.000+08:00'),
      ], { [AUTO_RESUME_COUNT_KEY]: 3 }),
    ]
    expect(lifetimeCapRejections(reported, {})).toEqual([])
  })

  it('拒绝之后又发生过 auto_resume（人工续后自动续通道再评估）→ 重新报一次', () => {
    const reReport = [
      bcard('re', [
        ev('blocked', { reason: 'HTTP 429' }),
        ev('auto_resume_rejected', { card: 're', reason: 'lifetime_cap', count: 3, max_per_card: 3 }, '2026-11-01T03:00:00.000+08:00'),
        ev('auto_resume', { card: 're', attempts: 0 }, '2026-11-01T04:00:00.000+08:00'),
      ], { [AUTO_RESUME_COUNT_KEY]: 3 }),
    ]
    expect(lifetimeCapRejections(reReport, {})).toEqual([{ id: 're', count: 3, cap: 3 }])
  })

  it('零事件链（刚扫到的新现场）照常报；按 id 稳定排序', () => {
    const cards = [
      bcard('z', transientEvents(), { [AUTO_RESUME_COUNT_KEY]: 3 }),
      bcard('a', transientEvents(), { [AUTO_RESUME_COUNT_KEY]: 4 }),
    ]
    expect(lifetimeCapRejections(cards, {}).map((c: { id: string }) => c.id)).toEqual(['a', 'z'])
  })
})

describe('orchestrator autoresume lifetime > workflow.json autoResume.maxPerCard 解析', () => {
  function fixture(workflow: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcfg-arlc-'))
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify(workflow))
    return dir
  }

  it('显式正整数生效（扩键走 resolve，不改 workflow.json 文件本身）', () => {
    const dir = fixture({ autoResume: { maxPerCard: 7 } })
    try {
      expect(loadWorkflowConfig(dir).autoResume).toEqual({ enabled: true, maxPerRun: 2, cooldownHours: 24, maxPerCard: 7 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非法值回落缺省 3 并 console.warn；键缺失静默沿用缺省', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = fixture({ autoResume: { maxPerCard: 0 } })
    const wfPath = path.join(dir, '.agents', 'workflow.json')
    try {
      expect(loadWorkflowConfig(dir).autoResume.maxPerCard).toBe(3)
      expect(warn.mock.calls.some((c) => String(c[0]).includes('maxPerCard'))).toBe(true)
      warn.mockClear()
      fs.writeFileSync(wfPath, JSON.stringify({ autoResume: { cooldownHours: 48 } }))
      expect(loadWorkflowConfig(dir).autoResume.maxPerCard).toBe(3)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      warn.mockRestore()
    }
  })
})

describe('orchestrator autoresume lifetime > signal_hashes 写侧归一', () => {
  it('normalizeSignalHashes：数组元素 String 强转 + trim + 剔空（与读侧 collectFilterContext 同一变换）', () => {
    expect(normalizeSignalHashes([' abc ', 'def'])).toEqual(['abc', 'def'])
    expect(normalizeSignalHashes([42, '', '   ', null, undefined, 'ok'])).toEqual(['42', 'ok'])
  })

  it('非数组（字符串整体/对象/undefined）→ 空数组——野值进不了卡', () => {
    expect(normalizeSignalHashes('deadbeef')).toEqual([])
    expect(normalizeSignalHashes({ h: 1 })).toEqual([])
    expect(normalizeSignalHashes(undefined)).toEqual([])
    expect(normalizeSignalHashes(null)).toEqual([])
    expect(normalizeSignalHashes(3.14)).toEqual([])
  })

  it('runScan 端到端：落卡 frontmatter 只可能是单条干净哈希（write 口径收紧的落盘证据）', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scanhash-'))
    try {
      const src = path.join(repo, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: 归一验证\nexport {}\n')
      const out = await runScan(repo, { todo: true })
      expect(out.created).toHaveLength(1)
      const text = fs.readFileSync(path.join(repo, '.agents', 'orchestrator', 'drafts', `${out.created[0]}.md`), 'utf8')
      const m = /^signal_hashes: \[([^\]]*)\]$/m.exec(text)
      expect(m).not.toBeNull()
      const hashes = String(m?.[1]).split(',').map((h) => h.trim()).filter(Boolean)
      expect(hashes).toHaveLength(1)
      expect(hashes[0]).toMatch(/^[0-9a-f]{8}$/)
      expect(text).not.toContain('proposal:') // 死字段退役后 scan 卡不再出现（P1-⑨）
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('数组分支元素逐个强转（写 ⊆ 读：与读侧 String().trim().filter 同一变换，口径不对称会导致哈希丢失）', () => {
    // 数字/对象等强转结果与读侧完全一致——保证写入的任何值都能被读侧原样读回参与碰撞
    expect(normalizeSignalHashes(['  h1  ', 42, { a: 1 }, ['x']])).toEqual(['h1', '42', '[object Object]', 'x'])
    expect(normalizeSignalHashes(['', '   '])).toEqual([]) // 全空元素 → 空数组 → 落卡整行省略
  })

  it('scanBlockedCards 扫出的卡带 auto_resume_count（累计值随卡走，上限闸按卡上值工作）', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'arlc-fs-'))
    try {
      const root = queueRoot(repo)
      ensureQueue(root)
      fs.writeFileSync(path.join(root, 'blocked', 'cnt.md'), cardText({ id: 'cnt', auto_resume_count: 2 }))
      const { candidates } = scanBlockedCards(repo, root)
      expect(candidates).toHaveLength(1)
      expect(candidates[0].meta[AUTO_RESUME_COUNT_KEY]).toBe(2)
      expect(lifetimeCapReached(candidates[0].meta, DEFAULT_MAX_PER_CARD)).toBe(false)
      // 同一现场把累计值推到上限：扫出即拒
      fs.writeFileSync(path.join(root, 'blocked', 'cnt.md'), cardText({ id: 'cnt', auto_resume_count: 3 }))
      const again = scanBlockedCards(repo, root)
      expect(lifetimeCapReached(again.candidates[0].meta, DEFAULT_MAX_PER_CARD)).toBe(true)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})

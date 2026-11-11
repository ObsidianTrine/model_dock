// 台账降级（research-ledger-downgrade 卡）：researcherStanding 纯函数矩阵 + mock e2e
// （cmdResearch 亮牌 / 通知带标记；sail 跳过闸同一判定函数）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import {
  RESEARCH_STANDING_FAIL_THRESHOLD,
  RESEARCH_STANDING_WINDOW,
  appendResearchLedger,
  readResearchLedger,
  researcherStanding,
} from '../../.agents/scripts/orchestrator/research.mjs'
import { mkRepo, runOrch } from './helpers.js'

const entry = (over: Record<string, unknown> = {}) => ({ kind: 'l1', brief_id: 'b', model: 'ship', researcher_model: 'ship', level: 'pass', ...over })

describe('researcherStanding > 纯函数矩阵', () => {
  it('窗口内 fail 达阈值即降级；不足则否', () => {
    const fails = [entry({ level: 'fail' }), entry({ level: 'fail' }), entry({ level: 'fail' })]
    expect(researcherStanding(fails, 'ship').degraded).toBe(true)
    expect(researcherStanding(fails, 'ship').fails).toBe(3)
    const two = fails.slice(0, 2)
    expect(researcherStanding(two, 'ship').degraded).toBe(false)
  })

  it('只看滚动窗口：窗口外的旧 fail 不计入', () => {
    const entries = [
      entry({ level: 'fail' }),
      entry({ level: 'fail' }),
      entry({ level: 'fail' }),
      entry({ level: 'pass' }),
      entry({ level: 'pass' }),
      entry({ level: 'pass' }),
      entry({ level: 'pass' }),
      entry({ level: 'pass' }),
    ]
    const s = researcherStanding(entries, 'ship', { window: 5 })
    expect(s.judged).toBe(5)
    expect(s.fails).toBe(0) // 3 个旧 fail 已滑出窗口（窗口=最后 5 条全 pass）
    expect(s.degraded).toBe(false)
  })

  it('按调研船模型过滤（researcher_model 优先，旧条目回退 model）；无记录恒不降级', () => {
    const entries = [
      { kind: 'l1', researcher_model: 'ship-a', model: 'reviewer-x', level: 'fail' },
      { kind: 'l1', model: 'ship-b', level: 'fail' }, // 旧条目无 researcher_model
      { kind: 'l1', researcher_model: 'ship-b', model: 'reviewer-x', level: 'fail' },
    ]
    expect(researcherStanding(entries, 'ship-a').fails).toBe(1)
    expect(researcherStanding(entries, 'ship-b').fails).toBe(2)
    expect(researcherStanding(entries, 'ship-b').degraded).toBe(false)
    expect(researcherStanding([], 'ship-a').degraded).toBe(false)
    expect(researcherStanding([], 'ship-a').judged).toBe(0)
  })

  it('pass 不抵 fail（fail 绝对数口径）；阈值常量=3/窗=5', () => {
    const mixed = [entry({ level: 'fail' }), entry({ level: 'pass' }), entry({ level: 'fail' }), entry({ level: 'pass' }), entry({ level: 'fail' })]
    expect(researcherStanding(mixed, 'ship').degraded).toBe(true)
    expect(RESEARCH_STANDING_WINDOW).toBe(5)
    expect(RESEARCH_STANDING_FAIL_THRESHOLD).toBe(3)
  })
})

describe('researcherStanding > e2e（mock 船）', () => {
  it('预置 3 次 fail 台账后 orch research：输出亮降级牌（交互式不拦，brief 照常产出）', () => {
    const repo = mkRepo().root
    try {
      // 预置同模型 3 条 fail（窗口 5 内）——本次 mock run 再记 1 条，fails=3 ≥ 阈值
      for (let i = 0; i < 3; i++) appendResearchLedger(repo, { kind: 'l1', brief_id: `seed-${i}`, model: 'mock-ship', researcher_model: 'mock-ship', level: 'fail' })
      const r = runOrch(repo, 'research "mock websearch fallback" --backend mock --model mock-ship')
      expect(r.stdout).toContain('调研船降级标记')
      expect(r.stdout).toContain('mock-ship')
      expect(r.stdout).toContain('brief 已产出') // 交互式不拦：brief 照常产出
      // 台账已追加本 run 条目（判定链不断）
      expect(readResearchLedger(repo).some((e) => e.brief_id && !String(e.brief_id).startsWith('seed-'))).toBe(true)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})

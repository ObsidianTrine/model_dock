// score.mjs + queue.mjs 评分扩展测试：纯规则评分公式、score/evidence/research 校验、
// pickNextCard 评分定序（带分先于无分、复合分降序；priority 仍是第一位）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computeScore, orderKey, keyLess } from '../../.agents/scripts/orchestrator/score.mjs'
import { validateCard, pickNextCard, ensureQueue, cardPath, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'
import { cardText } from './helpers.js'

describe('orchestrator score > 纯规则评分', () => {
  it('computeScore：(value×confidence)/(effort+risk−1)；无 score 返回 null', () => {
    expect(computeScore({ score: { value: 2, effort: 1, confidence: 3, risk: 1 } })).toBe(6)
    expect(computeScore({ score: { value: 3, effort: 3, confidence: 1, risk: 3 } })).toBe(0.6)
    expect(computeScore({})).toBeNull()
    expect(computeScore({ score: {} })).toBeNull()
    expect(computeScore({ score: 'bad' })).toBeNull()
    // 缺失因子按中性档 2 计：(2×2)/(2+(2−1))=4/3
    expect(computeScore({ score: { value: 2 } })).toBe(4 / 3)
  })

  it('orderKey/keyLess：带分先于无分（同 priority），复合分高者先', () => {
    const high = orderKey({ score: { value: 3, effort: 1, confidence: 3, risk: 1 }, created_at: '2026-01-02T00:00:00Z' })
    const low = orderKey({ score: { value: 1, effort: 3, confidence: 1, risk: 3 }, created_at: '2026-01-01T00:00:00Z' })
    const none = orderKey({ created_at: '2025-01-01T00:00:00Z' })
    expect(high[0]).toBe(0)
    expect(none[0]).toBe(1)
    expect(keyLess(high, low)).toBe(true) // 复合分 9 > 0.75
    expect(keyLess(none, high)).toBe(false) // 无分落后于带分
  })
})

describe('orchestrator queue > score/evidence/research 校验', () => {
  const base = { id: 'x', type: 'docs', files_hint: ['docs/**'], workflows: ['feature-branch'] }

  it('score 非法值拒绝（0/4/小数），合法 1-3 通过', () => {
    expect(() => validateCard({ ...base, score: { value: 0 } })).toThrow(/score\.value/)
    expect(() => validateCard({ ...base, score: { effort: 4 } })).toThrow(/score\.effort/)
    expect(() => validateCard({ ...base, score: { confidence: 1.5 } })).toThrow(/score\.confidence/)
    expect(() => validateCard({ ...base, score: 'high' })).toThrow(/一层嵌套对象/)
    expect(validateCard({ ...base, score: { value: 3, effort: 1, confidence: 2, risk: 1 } }).score.value).toBe(3)
  })

  it('evidence 必须字符串数组；空数组清洗后删除', () => {
    expect(() => validateCard({ ...base, evidence: '证据' })).toThrow(/字符串数组/)
    expect(() => validateCard({ ...base, evidence: [42] })).toThrow(/字符串数组/)
    const meta = validateCard({ ...base, evidence: [' 信号A ', ''] })
    expect(meta.evidence).toEqual(['信号A'])
    expect(validateCard({ ...base }).evidence).toBeUndefined()
  })

  it('research 字段：brief id 或 todo 合法，其它拒绝', () => {
    expect(validateCard({ ...base, research: 'todo' }).research).toBe('todo')
    expect(validateCard({ ...base, research: 'websearch-fallback' }).research).toBe('websearch-fallback')
    expect(() => validateCard({ ...base, research: 'BAD REF' })).toThrow(/research/)
  })
})

describe('orchestrator queue > pickNextCard 评分定序', () => {
  it('同 priority：带分按复合分降序插队，无分按 created_at 垫后；跨 priority 仍以 priority 为先', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'score-queue-'))
    try {
      ensureQueue(queueRoot(path.join(root)))
      const write = (state: string, id: string, text: string) => fs.writeFileSync(cardPath(queueRoot(root), state, id), text)
      // normal 档：无分老卡 / 无分新卡 / 低分卡 / 高分卡
      write('pending', 'a-unscored-old', cardText({ id: 'a-unscored-old', created_at: '2026-01-01T00:00:00Z' }))
      write('pending', 'b-unscored-new', cardText({ id: 'b-unscored-new', created_at: '2026-02-01T00:00:00Z' }))
      write('pending', 'c-scored-low', cardText({ id: 'c-scored-low', created_at: '2026-03-01T00:00:00Z', score: { value: 1, effort: 3, confidence: 1, risk: 3 }, evidence: ['弱证据'] }))
      write('pending', 'd-scored-high', cardText({ id: 'd-scored-high', created_at: '2026-04-01T00:00:00Z', score: { value: 3, effort: 1, confidence: 3, risk: 1 }, evidence: ['强证据'] }))
      // high 档：无分卡——priority 第一位，压过所有 normal
      write('pending', 'e-high-unscored', cardText({ id: 'e-high-unscored', priority: 'high', created_at: '2026-05-01T00:00:00Z' }))
      expect(pickNextCard(queueRoot(root))?.id).toBe('e-high-unscored')
      fs.rmSync(cardPath(queueRoot(root), 'pending', 'e-high-unscored'))
      expect(pickNextCard(queueRoot(root))?.id).toBe('d-scored-high')
      fs.rmSync(cardPath(queueRoot(root), 'pending', 'd-scored-high'))
      expect(pickNextCard(queueRoot(root))?.id).toBe('c-scored-low')
      fs.rmSync(cardPath(queueRoot(root), 'pending', 'c-scored-low'))
      expect(pickNextCard(queueRoot(root))?.id).toBe('a-unscored-old')
      fs.rmSync(cardPath(queueRoot(root), 'pending', 'a-unscored-old'))
      expect(pickNextCard(queueRoot(root))?.id).toBe('b-unscored-new')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

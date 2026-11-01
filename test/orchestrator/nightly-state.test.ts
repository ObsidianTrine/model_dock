// nightly 幂等补跑状态机（nightly-state.mjs）纯逻辑测试：解析 / 20h 判断 / 中断判定。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  decideNightlyStart,
  NIGHTLY_MIN_INTERVAL_MS,
  nightlyStatePath,
  readNightlyState,
  writeNightlyState,
} from '../../.agents/scripts/orchestrator/nightly-state.mjs'

const NOW = Date.parse('2026-11-01T03:00:00Z')
const H = 3_600_000

describe('nightly-state > decideNightlyStart', () => {
  it('状态缺失/损坏 → 首次照常执行', () => {
    expect(decideNightlyStart(null, NOW).action).toBe('run')
    expect(decideNightlyStart(undefined, NOW).action).toBe('run')
    expect(decideNightlyStart('垃圾' as unknown as object, NOW).action).toBe('run')
    expect(decideNightlyStart([1, 2] as unknown as object, NOW).action).toBe('run')
    expect(decideNightlyStart({}, NOW).action).toBe('run') // 空对象 = 时间戳全不可解析
    expect(decideNightlyStart({ startedAt: '不是时间', finishedAt: '也不是' }, NOW).action).toBe('run')
  })

  it('finishedAt 缺失而 startedAt 在 → 上次被中断（recover）', () => {
    const v = decideNightlyStart({ startedAt: new Date(NOW - H).toISOString(), finishedAt: null }, NOW)
    expect(v.action).toBe('recover')
    expect(v.reason).toContain('未正常收尾')
    // finishedAt 为损坏字符串同样按中断处理（startedAt 可解析时）
    const v2 = decideNightlyStart({ startedAt: new Date(NOW - H).toISOString(), finishedAt: 'oops' }, NOW)
    expect(v2.action).toBe('recover')
  })

  it('距上次完成不足 20h 且非人工 → skip（双跑防护）；超 20h → run', () => {
    const recent = { startedAt: new Date(NOW - 2 * H).toISOString(), finishedAt: new Date(NOW - H).toISOString() }
    const skip = decideNightlyStart(recent, NOW)
    expect(skip.action).toBe('skip')
    expect(skip.reason).toContain('20 小时')
    expect(skip.reason).toContain('双跑')

    const old = { startedAt: new Date(NOW - 25 * H).toISOString(), finishedAt: new Date(NOW - 24 * H).toISOString() }
    expect(decideNightlyStart(old, NOW).action).toBe('run')

    // 边界：恰好等于阈值不跳（< 才跳）；阈值常量语义 = 20 小时
    const edge = { startedAt: new Date(NOW - NIGHTLY_MIN_INTERVAL_MS - H).toISOString(), finishedAt: new Date(NOW - NIGHTLY_MIN_INTERVAL_MS).toISOString() }
    expect(decideNightlyStart(edge, NOW).action).toBe('run')
  })

  it('人工触发（manual）不受 20h 限制', () => {
    const recent = { startedAt: new Date(NOW - 2 * H).toISOString(), finishedAt: new Date(NOW - H).toISOString() }
    const v = decideNightlyStart(recent, NOW, { manual: true })
    expect(v.action).toBe('run')
    expect(v.reason).toContain('人工')
  })

  it('时钟偏差（finishedAt 在未来）保守按 skip 处理', () => {
    const future = { startedAt: new Date(NOW - H).toISOString(), finishedAt: new Date(NOW + 5 * H).toISOString() }
    expect(decideNightlyStart(future, NOW).action).toBe('skip')
  })
})

describe('nightly-state > read/write（真实文件）', () => {
  it('写入后可读回；缺失/损坏/非对象 → null（视为首次）', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nstate-'))
    try {
      expect(readNightlyState(repoRoot)).toBeNull() // 缺失

      writeNightlyState(repoRoot, { startedAt: '2026-11-01T02:30:00.000Z', finishedAt: null })
      expect(readNightlyState(repoRoot)).toEqual({ startedAt: '2026-11-01T02:30:00.000Z', finishedAt: null })
      expect(fs.existsSync(nightlyStatePath(repoRoot))).toBe(true)

      fs.writeFileSync(nightlyStatePath(repoRoot), '{截断的JSON')
      expect(readNightlyState(repoRoot)).toBeNull() // 损坏

      fs.writeFileSync(nightlyStatePath(repoRoot), '"一个字符串"')
      expect(readNightlyState(repoRoot)).toBeNull() // 非对象

      fs.writeFileSync(nightlyStatePath(repoRoot), '[1,2]')
      expect(readNightlyState(repoRoot)).toBeNull() // 数组不算状态
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('二次写入原子覆盖（rename 替换，不留 .tmp 残留）', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nstate-'))
    try {
      writeNightlyState(repoRoot, { startedAt: 'a', finishedAt: null })
      writeNightlyState(repoRoot, { startedAt: 'a', finishedAt: 'b', result: { created: 0 } })
      expect(readNightlyState(repoRoot)).toEqual({ startedAt: 'a', finishedAt: 'b', result: { created: 0 } })
      expect(fs.readdirSync(path.dirname(nightlyStatePath(repoRoot))).filter((f) => f.includes('.tmp-'))).toEqual([])
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})

// watchdog maxChecks 按卡轮次预算缩放（2026-11-15 质量专项 P1-⑥）单元测试：
// resolveWatchdogMaxChecks 缩放表（maxTurns 极小 / 缺省 50 / 超大 ≥5 组）与 clamp 两端边界、
// 非法输入回落缺省预算、推导值喂入 createWatchdogState 的 disabled 语义联动、orchestrator.mjs
// 接线源级锚点（mock 后端跳过看门狗，编排接线无集成可达路径，只能靠源级断言钉住防回退）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WATCHDOG_MAX_CHECKS_MAX,
  WATCHDOG_MAX_CHECKS_MIN,
  createWatchdogState,
  resolveWatchdogMaxChecks,
} from '../../.agents/scripts/orchestrator/watchdog.mjs'
import { DEFAULT_BUDGET } from '../../.agents/scripts/orchestrator/queue.mjs'

const ORCH = fileURLToPath(new URL('../../.agents/scripts/orchestrator.mjs', import.meta.url))

describe('watchdog maxChecks 缩放 > resolveWatchdogMaxChecks 缩放表（everyTurns=20）', () => {
  it('极小 / 缺省 50 / 中档 / 超大各档按 ceil(maxTurns/everyTurns) 推导', () => {
    expect(resolveWatchdogMaxChecks({ maxTurns: 10, everyTurns: 20 })).toBe(3) // 极小：ceil(0.5)=1 → 下界 3
    expect(resolveWatchdogMaxChecks({ maxTurns: 50, everyTurns: 20 })).toBe(3) // 缺省预算：ceil(2.5)
    expect(resolveWatchdogMaxChecks({ maxTurns: 100, everyTurns: 20 })).toBe(5)
    expect(resolveWatchdogMaxChecks({ maxTurns: 200, everyTurns: 20 })).toBe(10)
    expect(resolveWatchdogMaxChecks({ maxTurns: 300, everyTurns: 20 })).toBe(15) // 恰好触上界
    expect(resolveWatchdogMaxChecks({ maxTurns: 400, everyTurns: 20 })).toBe(WATCHDOG_MAX_CHECKS_MAX) // 超大：钳在上界
  })

  it('clamp 两端边界：下界之下取 3，上界之上取 15，恰好整除取原值', () => {
    expect(WATCHDOG_MAX_CHECKS_MIN).toBe(3)
    expect(WATCHDOG_MAX_CHECKS_MAX).toBe(15)
    // 下界端：ceil 结果 1/2 都钳到 3
    expect(resolveWatchdogMaxChecks({ maxTurns: 1, everyTurns: 20 })).toBe(3)
    expect(resolveWatchdogMaxChecks({ maxTurns: 40, everyTurns: 20 })).toBe(3)
    // 下界恰好：ceil=3 不变形
    expect(resolveWatchdogMaxChecks({ maxTurns: 60, everyTurns: 20 })).toBe(3)
    // 上界恰好：ceil=15 不变形
    expect(resolveWatchdogMaxChecks({ maxTurns: 300, everyTurns: 20 })).toBe(15)
    // 上界端：ceil=16 起钳到 15
    expect(resolveWatchdogMaxChecks({ maxTurns: 301, everyTurns: 20 })).toBe(15)
    expect(resolveWatchdogMaxChecks({ maxTurns: 10000, everyTurns: 20 })).toBe(15)
  })

  it('everyTurns 参与推导：间隔加密放宽次数、间隔拉大收紧到下界', () => {
    expect(resolveWatchdogMaxChecks({ maxTurns: 100, everyTurns: 10 })).toBe(10)
    expect(resolveWatchdogMaxChecks({ maxTurns: 100, everyTurns: 50 })).toBe(3) // ceil(2)=2 → 下界
    expect(resolveWatchdogMaxChecks({ maxTurns: 1000, everyTurns: 5 })).toBe(15) // ceil(200) → 上界
  })

  it('卡未配 maxTurns / 非法 maxTurns → 缺省预算 50 推导；非法 everyTurns 回落 20', () => {
    const expected = Math.min(15, Math.max(3, Math.ceil(DEFAULT_BUDGET.max_turns / 20)))
    expect(DEFAULT_BUDGET.max_turns).toBe(50) // 缺省预算锚点（queue.mjs 单一事实来源）
    expect(resolveWatchdogMaxChecks({})).toBe(expected)
    expect(resolveWatchdogMaxChecks({ maxTurns: undefined, everyTurns: 20 })).toBe(expected)
    for (const junk of ['abc', 0, -5, NaN, Infinity, null]) {
      expect(resolveWatchdogMaxChecks({ maxTurns: junk, everyTurns: 20 })).toBe(expected)
    }
    for (const et of [0, -1, 2.5, 'x', null, undefined]) {
      expect(resolveWatchdogMaxChecks({ maxTurns: 100, everyTurns: et })).toBe(5) // 回落 20：ceil(100/20)
    }
  })
})

describe('watchdog maxChecks 缩放 > 推导值与状态机联动', () => {
  it('缺省预算卡（推导 3 次）：第 4 个触发窗记 watchdog_disabled，且只报一次', () => {
    const checks = resolveWatchdogMaxChecks({ maxTurns: 50, everyTurns: 20 })
    expect(checks).toBe(3)
    const s = createWatchdogState({ everyTurns: 20, maxChecks: checks })
    const fire = () => {
      // 单会话内走到下一个触发窗（每窗 20 turn），命中即发起并收尾一次检查
      for (;;) {
        const a = s.onTurn()
        if (a === 'check') {
          s.beginCheck()
          s.endCheck()
          return true
        }
        if (a === 'disabled') return false
      }
    }
    expect(fire()).toBe(true) // turn 20：第 1 次
    expect(fire()).toBe(true) // turn 40：第 2 次
    expect(fire()).toBe(true) // turn 60：第 3 次（=推导上界）
    expect(fire()).toBe(false) // turn 80：disabled（只报一次）
    expect(s.snapshot().disabled).toBe(true)
    expect(s.snapshot().checks).toBe(3)
  })

  it('大预算卡（maxTurns=200 → 推导 10 次）：不再在第 6 个窗过早 disabled（旧硬 5 的病灶）', () => {
    const checks = resolveWatchdogMaxChecks({ maxTurns: 200, everyTurns: 20 })
    expect(checks).toBe(10)
    const s = createWatchdogState({ everyTurns: 20, maxChecks: checks })
    const fire = () => {
      for (;;) {
        const a = s.onTurn()
        if (a === 'check') {
          s.beginCheck()
          s.endCheck()
          return true
        }
        if (a === 'disabled') return false
      }
    }
    for (let i = 0; i < 10; i++) expect(fire()).toBe(true) // 10 个窗全部可用
    expect(fire()).toBe(false) // 第 11 窗才 disabled
    expect(s.snapshot().checks).toBe(10)
  })
})

describe('watchdog maxChecks 缩放 > orchestrator.mjs 接线源级锚点', () => {
  it('createWatchdogState 以卡预算推导 maxChecks（meta.budget.max_turns 单一来源）', () => {
    const src = fs.readFileSync(ORCH, 'utf8')
    expect(src).toMatch(/maxChecks:\s*resolveWatchdogMaxChecks\(\{\s*maxTurns:\s*meta\.budget\.max_turns/)
    // 旧口径不得残留：编排侧不再有写死 5 的 maxChecks 传参
    expect(src).not.toMatch(/maxChecks:\s*5\b/)
  })
})

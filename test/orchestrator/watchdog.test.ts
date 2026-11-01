// LLM 进展看门狗测试（watchdog.mjs）：解析容错、输入截断、防重入/次数上界、observe/actuate
// 双档与连续 2 次熔断路径。全部用假 spawnFn 替身，零外部调用；turn 计数纯逻辑在
// createWatchdogState（orchestrator.mjs 挂钩处的可测内核）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  WATCHDOG_MAX_TURNS,
  buildWatchdogPrompt,
  createWatchdogState,
  makeWatchdogSpawnFn,
  parseWatchdogVerdict,
  watchdogCheck,
  watchdogTimelineSummary,
} from '../../.agents/scripts/orchestrator/watchdog.mjs'

describe('watchdog > parseWatchdogVerdict 解析容错', () => {
  it('裸 JSON / fenced block / 前后带解释文字都能解析', () => {
    expect(parseWatchdogVerdict('{"progressing": false, "reason": "循环同一操作"}')).toEqual({
      progressing: false,
      reason: '循环同一操作',
    })
    expect(parseWatchdogVerdict('```json\n{"progressing": true, "reason": "有新产出"}\n```')).toEqual({
      progressing: true,
      reason: '有新产出',
    })
    expect(parseWatchdogVerdict('判断如下：\n{"progressing": false, "reason": "原地打转"}\n以上。')).toEqual({
      progressing: false,
      reason: '原地打转',
    })
  })

  it('非 JSON / 空 / progressing 非布尔 → null（调用方按保守处理）', () => {
    expect(parseWatchdogVerdict('这不是 JSON')).toBeNull()
    expect(parseWatchdogVerdict('')).toBeNull()
    expect(parseWatchdogVerdict(undefined)).toBeNull()
    expect(parseWatchdogVerdict('{"progressing": "yes"}')).toBeNull()
    expect(parseWatchdogVerdict('{"reason": "缺 progressing"}')).toBeNull()
    expect(parseWatchdogVerdict('{ not json }')).toBeNull()
  })
})

describe('watchdog > 输入截断与 prompt 组装', () => {
  it('时间线尾部 ≤20 条、每条 ≤200 字符；ts/seq 噪音剥除', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ ts: `t${i}`, seq: i + 1, type: 'worker_turn', turn: i }))
    const text = watchdogTimelineSummary(events)
    const lines = text.split('\n')
    expect(lines).toHaveLength(20)
    expect(lines[0]).toContain('turn=10') // 尾部 20 条：0-29 → 10..29
    expect(text).not.toContain('ts=')
    expect(text).not.toContain('seq=')
    const long = { type: 'gate_result', detail: 'x'.repeat(500) }
    const [line] = watchdogTimelineSummary([long]).split('\n')
    expect(line.length).toBe(200 + 1) // 200 字符 + 省略号
    expect(line.endsWith('…')).toBe(true)
  })

  it('buildWatchdogPrompt：含目标、时间线与产出契约', () => {
    const p = buildWatchdogPrompt('修好 XX', 'worker_turn  turn=1')
    expect(p).toContain('修好 XX')
    expect(p).toContain('worker_turn  turn=1')
    expect(p).toContain('"progressing"')
    expect(p).toContain('拿不准时按 progressing: true')
  })
})

describe('watchdog > watchdogCheck 保守失败', () => {
  it('spawnFn 正常返回 → 透传结论', async () => {
    const r = await watchdogCheck({ goal: 'g', timeline: 't', spawnFn: async () => '{"progressing":false,"reason":"白转"}' })
    expect(r).toEqual({ progressing: false, reason: '白转' })
  })

  it('spawnFn 抛错 / 输出不可解析 / spawnFn 缺失 → {progressing:true, error}（不打扰）', async () => {
    const boom = await watchdogCheck({
      goal: 'g',
      timeline: 't',
      spawnFn: async () => {
        throw new Error('CLI 起不来')
      },
    })
    expect(boom.progressing).toBe(true)
    expect(boom.error).toContain('CLI 起不来')

    const garbage = await watchdogCheck({ goal: 'g', timeline: 't', spawnFn: async () => '我判断不了' })
    expect(garbage.progressing).toBe(true)
    expect(garbage.error).toContain('无法解析')

    const missing = await watchdogCheck({ goal: 'g', timeline: 't', spawnFn: undefined as unknown as () => Promise<string> })
    expect(missing.progressing).toBe(true)
    expect(missing.error).toContain('spawnFn')
  })

  it('actuate 连续 2 次 suspect → 熔断（watchdogCheck + 状态机组合路径）', async () => {
    const state = createWatchdogState({ mode: 'actuate' })
    const check = () => watchdogCheck({ goal: 'g', timeline: 't', spawnFn: async () => '{"progressing":false,"reason":"空转"}' })
    const first = await check()
    expect(state.report(first.progressing, first.reason)).toBe('suspect')
    const second = await check()
    expect(state.report(second.progressing, second.reason)).toBe('circuit_break')
  })
})

describe('watchdog > createWatchdogState 纯逻辑状态机', () => {
  it('默认 everyTurns=20：第 20 个 turn 触发，其余不触发', () => {
    const s = createWatchdogState()
    for (let i = 1; i <= 19; i++) expect(s.onTurn()).toBeNull()
    expect(s.onTurn()).toBe('check')
  })

  it('防重入：检查未返回前的新触发跳过（计数照走，触发点仍在 N 的整数倍）', () => {
    const s = createWatchdogState({ everyTurns: 2 })
    expect(s.onTurn()).toBeNull() // turn 1
    expect(s.onTurn()).toBe('check') // turn 2
    s.beginCheck()
    expect(s.onTurn()).toBeNull() // turn 3（pending）
    expect(s.onTurn()).toBeNull() // turn 4（本该触发，但 pending → 跳过）
    s.endCheck()
    expect(s.onTurn()).toBeNull() // turn 5
    expect(s.onTurn()).toBe('check') // turn 6：下一个整数倍
  })

  it('次数上界：超过 maxChecks 记一次 disabled 后不再触发', () => {
    const s = createWatchdogState({ everyTurns: 2, maxChecks: 2 })
    expect(s.onTurn()).toBeNull() // turn 1
    expect(s.onTurn()).toBe('check') // turn 2：第 1 次
    s.beginCheck()
    s.endCheck()
    expect(s.onTurn()).toBeNull() // turn 3
    expect(s.onTurn()).toBe('check') // turn 4：第 2 次（=maxChecks）
    s.beginCheck()
    s.endCheck()
    expect(s.onTurn()).toBeNull() // turn 5
    expect(s.onTurn()).toBe('disabled') // turn 6：第 3 次该触发 → 上界（只报一次）
    for (let i = 0; i < 10; i++) expect(s.onTurn()).toBeNull() // 之后永不触发
    expect(s.snapshot().checks).toBe(2)
  })

  it('settle 后不再触发（任务落位/worker 正常结束）', () => {
    const s = createWatchdogState({ everyTurns: 1 })
    s.settle()
    expect(s.onTurn()).toBeNull()
  })

  it('observe：连续 suspect 只记事件不熔断；progressing 清零 streak', () => {
    const s = createWatchdogState({ mode: 'observe' })
    expect(s.report(false, 'a')).toBe('suspect')
    expect(s.report(false, 'b')).toBe('suspect')
    expect(s.report(false, 'c')).toBe('suspect')
    expect(s.report(true, 'd')).toBe('ok')
    expect(s.report(false, 'e')).toBe('suspect') // streak 已清零，从头计
  })

  it('actuate：连续 2 次 suspect → circuit_break；中断一次则重新计数', () => {
    const s = createWatchdogState({ mode: 'actuate' })
    expect(s.report(false, 'a')).toBe('suspect')
    expect(s.report(true, 'b')).toBe('ok')
    expect(s.report(false, 'c')).toBe('suspect')
    expect(s.report(false, 'd')).toBe('circuit_break')
    expect(s.onTurn()).toBeNull() // 熔断后不再触发
  })

  it('错误静默：recordError 前 3 次为 true，之后 false', () => {
    const s = createWatchdogState()
    expect(s.recordError()).toBe(true)
    expect(s.recordError()).toBe(true)
    expect(s.recordError()).toBe(true)
    expect(s.recordError()).toBe(false)
  })
})

describe('watchdog > makeWatchdogSpawnFn（复用 backend.spawn 的只读一次性会话）', () => {
  it('prompt 落临时文件、readonly/maxTurns 收紧、返回 output、临时目录随查随删', async () => {
    const calls: Array<Record<string, unknown>> = []
    const fakeBackend = {
      // spawnFn 的 finally 在 backend.spawn 返回后立刻删临时目录——prompt 内容只能在替身内读
      spawn: async (inv: Record<string, unknown>) => {
        calls.push({ ...inv, promptContent: fs.readFileSync(inv.promptFile as string, 'utf8') })
        return { exitCode: 0, output: '{"progressing":true,"reason":"ok"}', usage: {}, pid: 1 }
      },
    }
    const spawnFn = makeWatchdogSpawnFn(fakeBackend, { cwd: path.join(os.tmpdir(), 'wd-cwd'), model: 'm-1', envPatch: { A: '1' } })
    const out = await spawnFn({ prompt: 'PROMPT-TEXT' })
    expect(out).toBe('{"progressing":true,"reason":"ok"}')
    expect(calls).toHaveLength(1)
    expect(calls[0].readonly).toBe(true)
    expect(calls[0].maxTurns).toBe(WATCHDOG_MAX_TURNS)
    expect(calls[0].model).toBe('m-1')
    expect(calls[0].envPatch).toEqual({ A: '1' })
    expect(calls[0].promptContent).toBe('PROMPT-TEXT')
    expect(fs.existsSync(path.dirname(calls[0].promptFile as string))).toBe(false) // 临时目录已清理
  })

  it('无 model / 空 envPatch 时键缺席；backend 抛错原样上抛（由 watchdogCheck 兜底）', async () => {
    const calls: Array<Record<string, unknown>> = []
    const fakeBackend = {
      spawn: async (inv: Record<string, unknown>) => {
        calls.push(inv)
        throw new Error('起不来')
      },
    }
    const spawnFn = makeWatchdogSpawnFn(fakeBackend, { cwd: os.tmpdir() })
    await expect(spawnFn({ prompt: 'p' })).rejects.toThrow('起不来')
    expect('model' in calls[0]).toBe(false)
    expect('envPatch' in calls[0]).toBe(false)
  })
})

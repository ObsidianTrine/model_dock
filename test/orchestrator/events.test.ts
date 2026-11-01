import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendEvent,
  appendInbox,
  coalesceEvents,
  formatTimeline,
  lastSeq,
  readEvents,
  readInbox,
  toIsoLocal,
} from '../../.agents/scripts/orchestrator/events.mjs'
import { appendFollowUps } from '../../.agents/scripts/orchestrator/prompt.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ev-'))
}

describe('orchestrator events > jsonl 追加与恢复', () => {
  it('seq 单调递增；字段齐全；ts 带本地时区', () => {
    const dir = tmpDir()
    const e1 = appendEvent(dir, 'task_submitted', { card_hash: 'sha256:x' })
    const e2 = appendEvent(dir, 'worker_spawned', { backend: 'mock', pid: 1 })
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(e1.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
    expect(lastSeq(dir)).toBe(2)
    const evts = readEvents(dir)
    expect(evts.map((e) => e.type)).toEqual(['task_submitted', 'worker_spawned'])
  })

  it('崩溃残留半行被容错跳过，不抛错', () => {
    const dir = tmpDir()
    appendEvent(dir, 'task_submitted', {})
    appendEvent(dir, 'worker_spawned', {})
    // 模拟进程被杀时写了一半
    fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"ts":"2026-10-01T10:00:0')
    const evts = readEvents(dir)
    expect(evts).toHaveLength(2)
    // 半行不影响 seq：下一个事件继续单调
    const e3 = appendEvent(dir, 'merged', {})
    expect(e3.seq).toBe(3)
  })

  it('toIsoLocal 与 toISOString 表示同一时刻', () => {
    const d = new Date('2026-10-01T02:00:00.000Z')
    const local = toIsoLocal(d)
    expect(new Date(local).getTime()).toBe(d.getTime())
  })

  it('formatTimeline 可读输出包含 type 与扩展字段', () => {
    const dir = tmpDir()
    appendEvent(dir, 'worker_spawned', { backend: 'mock', pid: 42 })
    const line = formatTimeline(readEvents(dir))
    expect(line).toContain('worker_spawned')
    expect(line).toContain('backend=mock')
    expect(line).toContain('pid=42')
  })
})

describe('orchestrator events > 读侧折叠 coalesceEvents', () => {
  let n = 0
  const mk = (type: string, fields: Record<string, unknown> = {}) => ({
    ts: `2026-11-01T10:00:${String(n++).padStart(2, '0')}.000+08:00`,
    seq: n,
    type,
    ...fields,
  })

  it('连续同型（白名单内）塌缩成一条：count 对齐、ts 取末条、first_ts 记首条', () => {
    n = 0
    const events = [
      mk('task_accepted'),
      mk('worker_turn', { tool: 'read' }),
      mk('worker_turn', { tool: 'edit' }),
      mk('worker_turn', { tool: 'bash' }),
      mk('gate_result', { gate: 'npm_test', result: 'pass' }),
    ]
    const view = coalesceEvents(events) as Array<Record<string, unknown>>
    expect(view).toHaveLength(3)
    expect(view[0]).toMatchObject({ type: 'task_accepted' })
    expect(view[1]).toMatchObject({ type: 'worker_turn', count: 3, first_ts: events[1].ts, ts: events[3].ts, tool: 'bash' })
    expect(view[2]).toMatchObject({ type: 'gate_result' })
  })

  it('间隔的同型事件不跨段合并；非白名单类型原样透传', () => {
    n = 0
    const events = [mk('worker_turn'), mk('gate_result'), mk('worker_turn')]
    const view = coalesceEvents(events)
    expect(view).toHaveLength(3) // worker_turn 被 gate_result 隔开，各自成段
    const same = [mk('gate_result', { gate: 'a' }), mk('gate_result', { gate: 'b' })]
    expect(coalesceEvents(same)).toHaveLength(2) // gate_result 不在白名单，逐条保留
  })

  it('maxEntries 对折叠后视图做尾部截取；formatTimeline 直接可消费视图', () => {
    n = 0
    const events = [mk('task_accepted'), ...Array.from({ length: 30 }, () => mk('worker_turn'))]
    const view = coalesceEvents(events, { maxEntries: 1 }) as Array<Record<string, unknown>>
    expect(view).toHaveLength(1)
    expect(view[0].count).toBe(30)
    const text = formatTimeline(view)
    expect(text).toContain('worker_turn')
    expect(text).toContain('count=30')
  })

  it('空输入与空数组安全', () => {
    expect(coalesceEvents(undefined)).toEqual([])
    expect(coalesceEvents([])).toEqual([])
  })
})

describe('orchestrator events > follow-up inbox（订阅直通）', () => {
  it('appendInbox / readInbox 往返：## 分段解析、条目字段齐全', () => {
    const dir = tmpDir()
    appendInbox(dir, '第一条：优先改适配器层', '2026-11-01T09:00:00.000+08:00')
    appendInbox(dir, '第二条：先跑测试再收尾', '2026-11-01T09:05:00.000+08:00')
    const entries = readInbox(dir)
    expect(entries).toEqual([
      { ts: '2026-11-01T09:00:00.000+08:00', text: '第一条：优先改适配器层' },
      { ts: '2026-11-01T09:05:00.000+08:00', text: '第二条：先跑测试再收尾' },
    ])
  })

  it('无头裸内容视作单条匿名条目（手写 inbox 容错）', () => {
    const dir = tmpDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'inbox.md'), '手写的一句补充\n第二行\n')
    expect(readInbox(dir)).toEqual([{ ts: '', text: '手写的一句补充\n第二行' }])
  })

  it('截断：maxEntries/maxChars 双上限从尾部保留；空文件与缺失文件返回空', () => {
    const dir = tmpDir()
    expect(readInbox(dir)).toEqual([])
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'inbox.md'), '')
    expect(readInbox(dir)).toEqual([])
    for (let i = 0; i < 5; i++) appendInbox(dir, `t${i}`, `2026-11-01T09:0${i}:00.000+08:00`)
    expect(readInbox(dir, { maxEntries: 2 })).toHaveLength(2)
    // maxChars=2 撑不下任何一条完整条目时至少保留最后一条（不出现空截断）
    expect(readInbox(dir, { maxChars: 2 })).toHaveLength(1)
  })

  it('appendFollowUps：空条目原样返回；非空追加在尾部且包含条目全文', () => {
    expect(appendFollowUps('BASE', [])).toBe('BASE')
    const out = appendFollowUps('BASE', [{ ts: '2026-11-01T09:00:00.000+08:00', text: '补充指令 A' }])
    expect(out.startsWith('BASE')).toBe(true)
    expect(out).toContain('# 补充指令')
    expect(out).toContain('2026-11-01T09:00:00.000+08:00')
    expect(out).toContain('补充指令 A')
    // 无 ts 条目有占位
    const out2 = appendFollowUps('BASE', [{ ts: '', text: 'B' }])
    expect(out2).toContain('（未注明时间）')
  })
})

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendEvent, formatTimeline, lastSeq, readEvents, toIsoLocal } from '../../.agents/scripts/orchestrator/events.mjs'

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

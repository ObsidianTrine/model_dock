// LLM 决策留底（trace.mjs）测试：writeDecisionTrace 落盘/截断/滚动保留/写失败不抛，
// watchdog 与 smartFilter 的 trace 接线（假 spawnFn，零外部调用），reviewer 集成 1 例
// （mock 后端跑闭环，与 review-backend.test.ts 同沙箱写法），workflow.json trace 键解析。
// 临时目录一律 os.tmpdir() + path.join()（三平台一致）。

import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readDecisionTraces, writeDecisionTrace } from '../../.agents/scripts/orchestrator/trace.mjs'
import { watchdogCheck } from '../../.agents/scripts/orchestrator/watchdog.mjs'
import { semanticFilter } from '../../.agents/scripts/orchestrator/eventfilter.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { cardText, eventsOf, mkRepo, readCard, runOrch } from './helpers.js'

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function rmTmp(p: string): void {
  fs.rmSync(p, { recursive: true, force: true })
}

/** 列出 <root>/decisions/ 下某 kind 前缀的留底文件（按文件名升序 = 时间旧→新）。 */
function traceFiles(root: string, kind: string): string[] {
  return fs
    .readdirSync(path.join(root, 'decisions'))
    .filter((f) => f.startsWith(`${kind}-`) && f.endsWith('.json'))
    .sort()
}

describe('orchestrator trace > writeDecisionTrace 落盘', () => {
  it('落点 <root>/decisions/<kind>-<时间戳>-<序号>.json，JSON 字段齐备（ts/kind/taskId/input/output/parsed/meta）', () => {
    const root = tmpDir('trace-w-')
    try {
      const file = writeDecisionTrace({
        root,
        taskId: 't1',
        kind: 'watchdog',
        input: 'worker_turn turn=20',
        output: '{"progressing": true, "reason": "有产出"}',
        parsed: { progressing: true, reason: '有产出' },
        meta: { durationMs: 12 },
      })
      expect(file).toBeTruthy()
      expect(path.dirname(path.dirname(file as string))).toBe(root)
      expect(path.basename(file as string)).toMatch(/^watchdog-\d{4}-\d{2}-\d{2}T[\d.-]+-\d{6}\.json$/) // Windows 文件名无冒号
      const doc = JSON.parse(fs.readFileSync(file as string, 'utf8'))
      expect(doc.kind).toBe('watchdog')
      expect(doc.taskId).toBe('t1')
      expect(typeof doc.ts).toBe('string')
      expect(doc.input).toBe('worker_turn turn=20')
      expect(doc.output).toBe('{"progressing": true, "reason": "有产出"}')
      expect(doc.parsed).toEqual({ progressing: true, reason: '有产出' })
      expect(doc.meta).toEqual({ durationMs: 12 })
    } finally {
      rmTmp(root)
    }
  })

  it('meta/parsed/taskId 缺省时不臆造字段；root/kind 缺失返回 null 不抛', () => {
    const root = tmpDir('trace-min-')
    try {
      const file = writeDecisionTrace({ root, kind: 'review', input: 'x' })
      const doc = JSON.parse(fs.readFileSync(file as string, 'utf8'))
      expect(doc.taskId).toBeUndefined()
      expect(doc.meta).toBeUndefined()
      expect(doc.parsed).toBeNull() // 未传 parsed 落 null（字段稳定，排查侧不用判键）
      expect(writeDecisionTrace({ kind: 'review' })).toBeNull()
      expect(writeDecisionTrace({ root, kind: '' })).toBeNull()
    } finally {
      rmTmp(root)
    }
  })
})

describe('orchestrator trace > 截断上界', () => {
  it('input/output 超上界截前缀并标记 {text, truncated, originalBytes}；码点边界不劈中文', () => {
    const root = tmpDir('trace-cut-')
    try {
      const bigInput = 'a'.repeat(3000) // 3000 B > 1KB
      const bigOutput = '中'.repeat(2000) // 6000 B UTF-8 > 1KB
      const file = writeDecisionTrace({ root, kind: 'review', input: bigInput, output: bigOutput }, { maxInputKB: 1, maxOutputKB: 1 })
      const doc = JSON.parse(fs.readFileSync(file as string, 'utf8'))
      expect(doc.input).toEqual({ text: expect.any(String), truncated: true, originalBytes: 3000 })
      const inBytes = Buffer.byteLength(doc.input.text, 'utf8')
      expect(inBytes).toBeLessThanOrEqual(1024)
      expect(doc.input.text).toBe('a'.repeat(inBytes))
      expect(doc.output).toEqual({ text: expect.any(String), truncated: true, originalBytes: 6000 })
      const outBytes = Buffer.byteLength(doc.output.text, 'utf8')
      expect(outBytes).toBeLessThanOrEqual(1024)
      expect(outBytes % 3).toBe(0) // 前缀只含完整「中」字（3 字节/字），无半截码点
      expect(doc.output.text).toBe('中'.repeat(outBytes / 3))
    } finally {
      rmTmp(root)
    }
  })

  it('未超限存原始字符串（不包 {text} 壳）；maxOutputKB 缺省跟随 maxInputKB', () => {
    const root = tmpDir('trace-nocut-')
    try {
      const file = writeDecisionTrace({ root, kind: 'watchdog', input: '小输入', output: '小输出' }, { maxInputKB: 1 })
      const doc = JSON.parse(fs.readFileSync(file as string, 'utf8'))
      expect(doc.input).toBe('小输入')
      expect(doc.output).toBe('小输出')
      // 刚好压线：1024 字节 = 上界内不截
      const edge = 'b'.repeat(1024)
      const f2 = writeDecisionTrace({ root, kind: 'watchdog', input: edge }, { maxInputKB: 1 })
      const d2 = JSON.parse(fs.readFileSync(f2 as string, 'utf8'))
      expect(d2.input).toBe(edge)
      const over = 'b'.repeat(1025)
      const f3 = writeDecisionTrace({ root, kind: 'watchdog', input: over }, { maxInputKB: 1 })
      const d3 = JSON.parse(fs.readFileSync(f3 as string, 'utf8'))
      expect(d3.input.truncated).toBe(true)
      expect(d3.input.originalBytes).toBe(1025)
    } finally {
      rmTmp(root)
    }
  })
})

describe('orchestrator trace > 滚动保留', () => {
  it('同 kind 超 maxPerTask 删最旧（按文件名时间戳序），跨 kind 互不干扰', () => {
    const root = tmpDir('trace-roll-')
    try {
      for (let i = 1; i <= 8; i++) writeDecisionTrace({ root, kind: 'smartfilter', input: `候选-${i}` }, { maxPerTask: 5 })
      writeDecisionTrace({ root, kind: 'watchdog', input: '另一类不占额度' }, { maxPerTask: 5 })
      const files = traceFiles(root, 'smartfilter')
      expect(files).toHaveLength(5)
      const docs = files.map((f) => JSON.parse(fs.readFileSync(path.join(root, 'decisions', f), 'utf8')))
      // 删的是最旧 3 份：留下第 4..8 次写入（留底进程内序号跨用例累加，只看内容不看序号绝对值）
      expect(docs.map((d) => d.input)).toEqual(['候选-4', '候选-5', '候选-6', '候选-7', '候选-8'])
      expect(traceFiles(root, 'watchdog')).toHaveLength(1)
    } finally {
      rmTmp(root)
    }
  })
})

describe('orchestrator trace > 写失败不抛（防刷屏：每进程每 kind 最多一次 stderr 告警）', () => {
  it('root 落点是文件（mkdir 必败）：返回 null、不抛、同 kind 只告警一次、异 kind 各告警一次', () => {
    const outer = tmpDir('trace-fail-')
    const blocker = path.join(outer, 'occupied')
    fs.writeFileSync(blocker, '不是目录——root 被文件占位，decisions/ 建不出来')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(writeDecisionTrace({ root: blocker, kind: 'tracefail', input: 'x' })).toBeNull()
      expect(writeDecisionTrace({ root: blocker, kind: 'tracefail', input: 'y' })).toBeNull()
      expect(writeDecisionTrace({ root: blocker, kind: 'tracefail2', input: 'z' })).toBeNull()
      const mine = err.mock.calls.filter((c) => String(c[0]).includes('[decision-trace]'))
      expect(mine).toHaveLength(2)
      expect(String(mine[0]?.[0])).toContain('tracefail')
      expect(String(mine[0]?.[0])).toContain('不影响主流程')
    } finally {
      err.mockRestore()
      rmTmp(outer)
    }
  })
})

describe('orchestrator trace > readDecisionTraces 只读列出', () => {
  it('repoRoot 口径定位 logs/<id>/decisions，同 kind 新→旧；kind 过滤与 limit 生效；空返回 []', () => {
    const repo = tmpDir('trace-read-')
    try {
      const logRoot = path.join(repo, '.agents', 'orchestrator', 'logs', 't1')
      for (const n of ['n1', 'n2', 'n3']) writeDecisionTrace({ root: logRoot, taskId: 't1', kind: 'watchdog', input: n })
      writeDecisionTrace({ root: logRoot, taskId: 't1', kind: 'review', input: 'n4' })
      expect(readDecisionTraces(repo, 't1', { kind: 'watchdog' }).map((t) => t.doc.input)).toEqual(['n3', 'n2', 'n1'])
      expect(readDecisionTraces(repo, 't1', { kind: 'review' }).map((t) => t.doc.input)).toEqual(['n4'])
      expect(readDecisionTraces(repo, 't1', { kind: 'watchdog', limit: 2 }).map((t) => t.doc.input)).toEqual(['n3', 'n2'])
      expect(readDecisionTraces(repo, 'no-such-task', { kind: 'watchdog', limit: 5 })).toEqual([])
    } finally {
      rmTmp(repo)
    }
  })
})

describe('orchestrator trace > watchdogCheck 接线', () => {
  it('traceDir 有值：判定后落盘 kind=watchdog，input=时间线摘要、output=原始输出、parsed=verdict', async () => {
    const root = tmpDir('trace-wd-')
    try {
      const verdict = await watchdogCheck({
        goal: '修好某 bug',
        timeline: 'worker_turn turn=20',
        spawnFn: async () => '{"progressing": false, "reason": "循环同一操作"}',
        traceDir: root,
      })
      expect(verdict).toEqual({ progressing: false, reason: '循环同一操作' })
      const files = traceFiles(root, 'watchdog')
      expect(files).toHaveLength(1)
      const doc = JSON.parse(fs.readFileSync(path.join(root, 'decisions', files[0]), 'utf8'))
      expect(doc.kind).toBe('watchdog')
      expect(doc.input).toBe('worker_turn turn=20')
      expect(doc.output).toBe('{"progressing": false, "reason": "循环同一操作"}')
      expect(doc.parsed).toEqual({ progressing: false, reason: '循环同一操作' })
      expect(doc.meta.durationMs).toBeGreaterThanOrEqual(0)
    } finally {
      rmTmp(root)
    }
  })

  it('spawnFn 抛错：保守 verdict（progressing=true）不变，留底 parsed=null、meta.error 可复盘', async () => {
    const root = tmpDir('trace-wderr-')
    try {
      const verdict = await watchdogCheck({
        goal: 'G',
        timeline: 'tl',
        spawnFn: async () => {
          throw new Error('CLI 没了')
        },
        traceDir: root,
      })
      expect(verdict.progressing).toBe(true)
      expect(String(verdict.error)).toContain('看门狗进程失败')
      const doc = JSON.parse(fs.readFileSync(path.join(root, 'decisions', traceFiles(root, 'watchdog')[0]), 'utf8'))
      expect(doc.output).toBe('')
      expect(doc.parsed).toBeNull()
      expect(String(doc.meta.error)).toContain('CLI 没了')
    } finally {
      rmTmp(root)
    }
  })

  it('traceDir 缺省：判定行为不变、零落盘（向后兼容）', async () => {
    const root = tmpDir('trace-wdoff-')
    try {
      const verdict = await watchdogCheck({ goal: 'G', timeline: 'tl', spawnFn: async () => '{"progressing": true, "reason": "ok"}' })
      expect(verdict).toEqual({ progressing: true, reason: 'ok' })
      expect(fs.existsSync(path.join(root, 'decisions'))).toBe(false)
    } finally {
      rmTmp(root)
    }
  })
})

describe('orchestrator trace > semanticFilter 接线（smartfilter）', () => {
  const signals = [
    { id: 'scan-todo-aaa', goal: '目标 A', background: '背景 A' },
    { id: 'scan-todo-bbb', goal: '目标 B', background: '背景 B' },
  ]

  it('正常判定：落盘 kind=smartfilter、taskId=scan，input=批量 prompt 全文、parsed=verdict 数组', () => {
    const root = tmpDir('trace-sf-')
    try {
      const r = semanticFilter(signals, {
        spawnFn: () => JSON.stringify([{ id: 'scan-todo-aaa', action: 'drop', reason: '明显噪音' }]),
        traceDir: root,
      })
      expect(r.used_llm).toBe(true)
      expect(r.drops).toHaveLength(1)
      const files = traceFiles(root, 'smartfilter')
      expect(files).toHaveLength(1)
      const doc = JSON.parse(fs.readFileSync(path.join(root, 'decisions', files[0]), 'utf8'))
      expect(doc.kind).toBe('smartfilter')
      expect(doc.taskId).toBe('scan')
      expect(doc.input).toContain('scan-todo-aaa')
      expect(doc.input).toContain('目标 A')
      expect(doc.output).toContain('"action":"drop"')
      expect(doc.parsed).toEqual([{ id: 'scan-todo-aaa', action: 'drop', reason: '明显噪音' }])
      expect(doc.meta.durationMs).toBeGreaterThanOrEqual(0)
    } finally {
      rmTmp(root)
    }
  })

  it('fallback 两形态：spawnFn 抛错 / 输出不可解析 → parsed=null、meta.fallback 留痕，保守回落不变', () => {
    const root = tmpDir('trace-sffall-')
    try {
      const r1 = semanticFilter(signals, {
        spawnFn: () => {
          throw new Error('超时了')
        },
        traceDir: root,
      })
      expect(r1.fallback).toContain('超时了')
      expect(r1.cards).toHaveLength(2)
      const r2 = semanticFilter(signals, { spawnFn: () => '这不是 JSON', traceDir: root })
      expect(r2.fallback).toContain('无法解析')
      const files = traceFiles(root, 'smartfilter')
      expect(files).toHaveLength(2)
      const docs = files.map((f) => JSON.parse(fs.readFileSync(path.join(root, 'decisions', f), 'utf8')))
      for (const doc of docs) {
        expect(doc.parsed).toBeNull()
        expect(String(doc.meta.fallback)).toContain('全部按 card 保守回落')
      }
      expect(String(docs[0].meta.fallback)).toContain('超时了')
    } finally {
      rmTmp(root)
    }
  })

  it('traceDir 缺省：过滤结果不变、零落盘（向后兼容）', () => {
    const root = tmpDir('trace-sfoff-')
    try {
      const r = semanticFilter(signals, { spawnFn: () => JSON.stringify([{ id: 'scan-todo-aaa', action: 'card' }]) })
      expect(r.cards).toHaveLength(2)
      expect(fs.existsSync(path.join(root, 'decisions'))).toBe(false)
    } finally {
      rmTmp(root)
    }
  })
})

describe('orchestrator trace > reviewer 集成（mock 后端闭环）', () => {
  it('run 闭环：review trace 落盘 logs/<id>/decisions/，input=prompt 全文、parsed=verdict、meta.backend 齐备', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-trace.md')
      fs.writeFileSync(cardFile, cardText({ id: 'revtrace' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run revtrace --backend mock --review-backend mock')
      // 闭环照常：审查无阻塞 → awaiting-human（trace 写入不影响审查链路）
      expect(readCard(repo.root, 'awaiting-human', 'revtrace')).toBeTruthy()
      expect(eventsOf(repo.root, 'revtrace').find((e) => e.type === 'review_verdict')?.blockers).toBe(0)
      const traces = readDecisionTraces(repo.root, 'revtrace', { kind: 'review' })
      expect(traces).toHaveLength(1)
      const doc = traces[0].doc
      expect(doc.kind).toBe('review')
      expect(doc.taskId).toBe('revtrace')
      expect(doc.input).toContain('REVIEW_SUMMARY') // reviewer prompt（含产出契约标记）
      expect(doc.output).toContain('REVIEW_SUMMARY: blockers=0') // mock reviewer 原始输出
      expect(doc.parsed).toEqual({ blockers: 0, suggestions: 1, notes: 0 })
      expect(doc.meta.backend).toBe('mock')
      expect(typeof doc.meta.durationMs).toBe('number')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator trace > workflow.json trace 配置解析（resolveTrace）', () => {
  function fixture(workflow: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcfg-trace-'))
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify(workflow))
    return dir
  }

  it('缺省 enabled=true / maxPerTask=20 / maxInputKB=64', () => {
    const dir = fixture({})
    try {
      expect(loadWorkflowConfig(dir).trace).toEqual({ enabled: true, maxPerTask: 20, maxInputKB: 64 })
    } finally {
      rmTmp(dir)
    }
  })

  it('显式值生效（enabled:false 关闭 / 自定义上界与保留份数）', () => {
    const dir = fixture({ trace: { enabled: false, maxPerTask: 3, maxInputKB: 16 } })
    try {
      expect(loadWorkflowConfig(dir).trace).toEqual({ enabled: false, maxPerTask: 3, maxInputKB: 16 })
    } finally {
      rmTmp(dir)
    }
  })

  it('非法值回落缺省并 console.warn（键缺失沿用缺省不告警）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = fixture({ trace: 'banana' })
    const wfPath = path.join(dir, '.agents', 'workflow.json')
    try {
      expect(loadWorkflowConfig(dir).trace).toEqual({ enabled: true, maxPerTask: 20, maxInputKB: 64 })
      expect(String(warn.mock.calls[0]?.[0])).toContain('trace')
      warn.mockClear()
      for (const bad of [{ enabled: 'no' }, { maxPerTask: 0 }, { maxPerTask: 1.5 }, { maxInputKB: -1 }, ['true']]) {
        fs.writeFileSync(wfPath, JSON.stringify({ trace: bad }))
        expect(loadWorkflowConfig(dir).trace).toEqual({ enabled: true, maxPerTask: 20, maxInputKB: 64 })
        expect(warn.mock.calls.length).toBeGreaterThan(0)
        warn.mockClear()
      }
      fs.writeFileSync(wfPath, JSON.stringify({ trace: { maxPerTask: 7 } }))
      expect(loadWorkflowConfig(dir).trace).toEqual({ enabled: true, maxPerTask: 7, maxInputKB: 64 })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      rmTmp(dir)
      warn.mockRestore()
    }
  })
})

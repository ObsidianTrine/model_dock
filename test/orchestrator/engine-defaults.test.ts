// 引擎默认配置增量测试（叠在 626df62 分体异构之上）：workflow.json worker/review 透传、
// buildClaudeArgs 的 --model、配置默认生效（CLI 显式 > resume 沿用 > 配置默认）、
// review_spawned 事件带 model、engineArgs 透传。

import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildClaudeArgs } from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'
import { readDecisionTraces } from '../../.agents/scripts/orchestrator/trace.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { cardText, mkRepo, runOrch } from './helpers.js'

describe('engine defaults > workflow.json worker/review 透传', () => {
  it('配置对象透传；缺省 null；形状坏回落 null', () => {
    const repo = mkRepo()
    try {
      const cfgPath = path.join(repo.root, '.agents', 'workflow.json')
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          baseBranch: 'develop',
          testCmd: 'node -e "process.exit(0)"',
          worker: { backend: 'zcode-headless' },
          review: { backend: 'claude-headless', model: 'opus' },
        }),
      )
      const cfg = loadWorkflowConfig(repo.root)
      expect(cfg.worker).toEqual({ backend: 'zcode-headless', model: null })
      expect(cfg.review).toEqual({ backend: 'claude-headless', model: 'opus' })

      fs.writeFileSync(cfgPath, JSON.stringify({ baseBranch: 'develop', testCmd: 'x', review: 'bad', worker: {} }))
      const cfg2 = loadWorkflowConfig(repo.root)
      expect(cfg2.worker).toBeNull() // 空节 → null（既有缺省行为不变）
      expect(cfg2.review).toBeNull() // 非对象 → null
    } finally {
      repo.cleanup()
    }
  })

  it('model 与 backend 不连坐：只配 model 不配 backend 也生效（引擎走既有缺省链/自动异构）', () => {
    const repo = mkRepo()
    try {
      const cfgPath = path.join(repo.root, '.agents', 'workflow.json')
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ baseBranch: 'develop', testCmd: 'x', worker: { model: 'sonnet' }, review: { model: 'opus' } }),
      )
      const cfg = loadWorkflowConfig(repo.root)
      expect(cfg.worker).toEqual({ backend: null, model: 'sonnet' }) // 此前整节被静默丢弃（0eb29bb 同型）
      expect(cfg.review).toEqual({ backend: null, model: 'opus' }) // backend null = 审查走自动异构链不受影响
    } finally {
      repo.cleanup()
    }
  })

  it('model 非法值告警并忽略（可操作文案点名节名）；backend 正常时其余不受影响', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const repo = mkRepo()
    try {
      const cfgPath = path.join(repo.root, '.agents', 'workflow.json')
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ baseBranch: 'develop', testCmd: 'x', review: { backend: 'mock', model: 42 } }),
      )
      const cfg = loadWorkflowConfig(repo.root)
      expect(cfg.review).toEqual({ backend: 'mock', model: null })
      expect(String(warn.mock.calls[0]?.[0])).toContain('review.model')
    } finally {
      repo.cleanup()
      warn.mockRestore()
    }
  })
})

describe('engine defaults > buildClaudeArgs 的 --model', () => {
  it('model 注入；readonly 与 model 共存（reviewer 分源换模型）；不传不出现', () => {
    const worker = buildClaudeArgs({ maxTurns: 50, model: 'sonnet' })
    const i = worker.indexOf('--model')
    expect(i).toBeGreaterThan(-1)
    expect(worker[i + 1]).toBe('sonnet')
    expect(worker).toContain('acceptEdits')

    const reviewer = buildClaudeArgs({ maxTurns: 30, readonly: true, model: 'opus' })
    expect(reviewer).toContain('--model')
    const j = reviewer.indexOf('--allowedTools')
    expect(reviewer.slice(j + 1, j + 4)).toEqual(['Read', 'Glob', 'Grep'])

    expect(buildClaudeArgs({ maxTurns: 7 })).not.toContain('--model')
  })
})

describe('engine defaults > run 端到端（mock）', () => {
  it('review_spawned 事件带 model；--review-model 单次覆盖经事件留痕', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'c.md')
      fs.writeFileSync(cardFile, cardText({ id: 'engine-default-trace' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run engine-default-trace --backend mock --review-model opus')
      const events = fs
        .readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'engine-default-trace', 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      const spawned = events.find((e: any) => e.type === 'review_spawned')
      expect(spawned?.backend).toBe('mock') // 显式 --backend 整体覆盖（mock 测试语义保留）
      expect(spawned?.model).toBe('opus')
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('workflow.json review.model 默认生效（无 CLI 覆盖时）', () => {
    const repo = mkRepo()
    try {
      fs.writeFileSync(
        path.join(repo.root, '.agents', 'workflow.json'),
        JSON.stringify({
          baseBranch: 'develop',
          testCmd: 'node -e "process.exit(0)"',
          review: { backend: 'mock', model: 'opus' },
        }),
      )
      const cardFile = path.join(repo.root, 'c.md')
      fs.writeFileSync(cardFile, cardText({ id: 'engine-cfg-trace' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run engine-cfg-trace --backend mock')
      const events = fs
        .readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'engine-cfg-trace', 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      const spawned = events.find((e: any) => e.type === 'review_spawned')
      expect(spawned?.backend).toBe('mock') // 配置默认 backend
      expect(spawned?.model).toBe('opus') // 配置默认 model
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('review.model 不配 backend 也透传（自动异构链不受影响）；模型进决策留底 meta', () => {
    const repo = mkRepo()
    try {
      fs.writeFileSync(
        path.join(repo.root, '.agents', 'workflow.json'),
        JSON.stringify({
          baseBranch: 'develop',
          testCmd: 'node -e "process.exit(0)"',
          review: { model: 'opus' }, // 只配模型不配引擎——backend null 走解析链（mock worker → 回落同源 mock）
        }),
      )
      const cardFile = path.join(repo.root, 'c.md')
      fs.writeFileSync(cardFile, cardText({ id: 'engine-model-only' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run engine-model-only --backend mock')
      const events = fs
        .readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'engine-model-only', 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      const spawned = events.find((e: any) => e.type === 'review_spawned')
      expect(spawned?.backend).toBe('mock') // 引擎解析链照常工作（配置无 backend 不影响选链）
      expect(spawned?.model).toBe('opus') // 模型照常透传
      const trace = readDecisionTraces(repo.root, 'engine-model-only', { kind: 'review' })[0]?.doc
      expect(trace?.meta?.model).toBe('opus') // 决策留底带实际使用的模型
      expect(trace?.meta?.backend).toBe('mock')
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('未配置 model → review_spawned 无 model 字段（既有消费者兼容）', () => {
    const repo = mkRepo()
    try {
      fs.writeFileSync(
        path.join(repo.root, '.agents', 'workflow.json'),
        JSON.stringify({
          baseBranch: 'develop',
          testCmd: 'node -e "process.exit(0)"',
          review: { backend: 'mock' }, // 只配引擎不配模型
        }),
      )
      const cardFile = path.join(repo.root, 'c.md')
      fs.writeFileSync(cardFile, cardText({ id: 'engine-no-model' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run engine-no-model --backend mock')
      const spawned = fs
        .readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'engine-no-model', 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l: string) => JSON.parse(l))
        .find((e: any) => e.type === 'review_spawned')
      expect(spawned?.backend).toBe('mock')
      expect('model' in (spawned ?? {})).toBe(false) // 条件展开：未配 = 不新增字段，不是记 null
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

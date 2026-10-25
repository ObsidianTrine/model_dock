// 引擎默认配置增量测试（叠在 626df62 分体异构之上）：workflow.json worker/review 透传、
// buildClaudeArgs 的 --model、配置默认生效（CLI 显式 > resume 沿用 > 配置默认）、
// review_spawned 事件带 model、engineArgs 透传。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildClaudeArgs } from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'
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

      fs.writeFileSync(cfgPath, JSON.stringify({ baseBranch: 'develop', testCmd: 'x', worker: { model: 'opus' }, review: 'bad' }))
      const cfg2 = loadWorkflowConfig(repo.root)
      expect(cfg2.worker).toBeNull() // 无 backend → null
      expect(cfg2.review).toBeNull() // 非对象 → null
    } finally {
      repo.cleanup()
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
})

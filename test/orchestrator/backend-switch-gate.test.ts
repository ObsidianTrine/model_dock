// 后端切换人工闸门（--approve-backend-switch）：worker 引擎 ≠ workflow.json worker.backend 时
// run 必须拒绝启动，显式批准才放行。2026-10-29 夜跑事故回归：ORCH_ZCODE_CLI 未设 →
// zcode-headless ENOENT/GLM 429 → 自治跑静默切 claude-headless 直连 DeepSeek 烧了一夜。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cardText, eventsOf, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

function submitCard(repo: string, id: string) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id }))
  runOrch(repo, `submit "${cardFile}"`)
}

describe('后端切换人工闸门', () => {
  it('worker 引擎 ≠ workflow.json 默认：无批准拒绝启动，卡留 pending、零 worker 事件', () => {
    const repo = mkRepo({ workerBackend: 'zcode-headless' })
    try {
      submitCard(repo.root, 'gate1')
      const r = tryOrch(repo.root, 'run gate1 --backend mock')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('切换 CLI 需人工审核')
      expect(r.stderr).toContain('--approve-backend-switch')
      expect(readCard(repo.root, 'pending', 'gate1')).toBeTruthy()
      expect(eventsOf(repo.root, 'gate1').some((e) => e.type === 'worker_spawned')).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('resume 沿用的后端 ≠ 配置默认同样拦截（沿用不是免检通道）', () => {
    const repo = mkRepo({ workerBackend: 'zcode-headless' })
    try {
      submitCard(repo.root, 'gate2')
      const qdir = path.join(repo.root, '.agents', 'orchestrator', 'logs', 'gate2')
      fs.mkdirSync(qdir, { recursive: true })
      fs.writeFileSync(path.join(qdir, 'events.jsonl'), JSON.stringify({ type: 'worker_spawned', backend: 'claude-headless' }) + '\n')
      const r = tryOrch(repo.root, 'run gate2')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('切换 CLI 需人工审核')
    } finally {
      repo.cleanup()
    }
  })

  it('--approve-backend-switch 显式批准放行（mock 全流程跑通）', () => {
    const repo = mkRepo({ workerBackend: 'zcode-headless' })
    try {
      submitCard(repo.root, 'gate3')
      const r = runOrch(repo.root, 'run gate3 --backend mock --approve-backend-switch')
      expect(r.stdout).toContain('awaiting-human')
      expect(eventsOf(repo.root, 'gate3').some((e) => e.type === 'worker_spawned' && e.backend === 'mock')).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('ORCH_APPROVE_BACKEND_SWITCH=1 环境批准等效放行', () => {
    const repo = mkRepo({ workerBackend: 'zcode-headless' })
    try {
      submitCard(repo.root, 'gate4')
      const r = runOrch(repo.root, 'run gate4 --backend mock', { ORCH_APPROVE_BACKEND_SWITCH: '1' })
      expect(r.stdout).toContain('awaiting-human')
    } finally {
      repo.cleanup()
    }
  })
})

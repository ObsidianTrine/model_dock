// B10 事故调查包（VDR）测试：终态落位自动生成 logs/<id>/incident.md（幂等覆盖），
// 含任务概况（reason）/事件时间线/考题草稿。两个落位路径：worker 自报 stuck、预算熔断。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cardText, eventsOf, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

function incidentPath(repo: string, id: string) {
  return path.join(repo, '.agents', 'orchestrator', 'logs', id, 'incident.md')
}

function ym(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

describe('orchestrator incident > 落位自动归档', () => {
  it('worker 自报 stuck 卡 blocked → incident.md 存在且含时间线/考题草稿/reason', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'vdr-stuck')
      runOrch(repo.root, 'run vdr-stuck --backend mock', { ORCH_MOCK_WORKER_STATUS: 'stuck' })
      expect(readCard(repo.root, 'blocked', 'vdr-stuck')).toBeTruthy()

      const p = incidentPath(repo.root, 'vdr-stuck')
      expect(fs.existsSync(p)).toBe(true)
      const text = fs.readFileSync(p, 'utf8')
      expect(text).toContain('# 事故调查包（VDR）：vdr-stuck')
      expect(text).toContain('worker 自报 stuck')
      expect(text).toContain('## 事件时间线')
      expect(text).toContain('blocked') // 时间线里有 blocked 事件行
      expect(text).toContain('## 考题草稿建议')
      expect(text).toContain(`"id": "${ym()}-vdr-stuck"`) // 对齐 review-evals case schema
      expect(text).toContain('本包不改动题库')
      // 归档动作留痕
      expect(eventsOf(repo.root, 'vdr-stuck').some((e) => e.type === 'incident_archived')).toBe(true)
    } finally {
      repo.cleanup()
    }
  }, 90_000)

  it('预算熔断卡（budget 极小）blocked → incident.md 同样存在，时间线含 circuit_breaker', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'vdr-budget', { budget: { max_tokens: 100 } })
      tryOrch(repo.root, 'run vdr-budget --backend mock') // 熔断 die → exit 1
      expect(readCard(repo.root, 'blocked', 'vdr-budget')).toBeTruthy()

      const text = fs.readFileSync(incidentPath(repo.root, 'vdr-budget'), 'utf8')
      expect(text).toContain('budget:max_tokens') // 原因与 blocked 事件对齐
      expect(text).toContain('circuit_breaker') // 时间线可复诵熔断现场
      expect(text).toContain('budget_snapshot') // mock 记账事件可回放（6000 > 100 触发）
      expect(eventsOf(repo.root, 'vdr-budget').some((e) => e.type === 'incident_archived')).toBe(true)
    } finally {
      repo.cleanup()
    }
  }, 90_000)

  it('重复落位（resume 再 blocked）覆盖刷新不堆文件：incident_archived 可多次、文件单份', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'vdr-twice')
      runOrch(repo.root, 'run vdr-twice --backend mock', { ORCH_MOCK_WORKER_STATUS: 'stuck' })
      runOrch(repo.root, 'resume vdr-twice --backend mock', { ORCH_MOCK_WORKER_STATUS: 'stuck' })
      const archived = eventsOf(repo.root, 'vdr-twice').filter((e) => e.type === 'incident_archived')
      expect(archived.length).toBe(2)
      const logs = fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'vdr-twice')).filter((f) => f.startsWith('incident'))
      expect(logs).toEqual(['incident.md']) // 覆盖刷新，无 incident(1).md 之类残留
      expect(fs.readFileSync(incidentPath(repo.root, 'vdr-twice'), 'utf8')).toContain('resumed')
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

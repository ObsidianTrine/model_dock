// B10 事故调查包（VDR）测试：终态落位自动生成 logs/<id>/incident.md（幂等覆盖），
// 含任务概况（reason）/事件时间线/考题草稿/上游海况（网关日志投影）。两个落位路径：
// worker 自报 stuck、预算熔断。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cardText, eventsOf, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'
import { fakeHome } from '../helpers.js'
import { gatewayLogsDir } from '../../.agents/scripts/orchestrator/reconcile.mjs'
import { toIsoLocal } from '../../.agents/scripts/orchestrator/events.mjs'

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

describe('orchestrator incident > 人工终态也归档（VDR 全覆盖）', () => {
  it('人工驳回（reject）落 failed → incident.md 归档驳回原因', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'vdr-reject')
      runOrch(repo.root, 'run vdr-reject --backend mock') // gate L3 缺省 → awaiting-human
      expect(readCard(repo.root, 'awaiting-human', 'vdr-reject')).toBeTruthy()
      runOrch(repo.root, 'reject vdr-reject --reason "方向不对"')
      expect(readCard(repo.root, 'failed', 'vdr-reject')).toBeTruthy()
      const text = fs.readFileSync(incidentPath(repo.root, 'vdr-reject'), 'utf8')
      expect(text).toContain('# 事故调查包（VDR）：vdr-reject')
      expect(text).toContain('方向不对')
      expect(text).toContain('## 事件时间线')
    } finally {
      repo.cleanup()
    }
  })

  it('abandon 落 failed → incident.md 归档（stuck 卡已有的包被 abandon 现场覆盖刷新）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'vdr-abandon')
      runOrch(repo.root, 'run vdr-abandon --backend mock', { ORCH_MOCK_WORKER_STATUS: 'stuck' })
      expect(readCard(repo.root, 'blocked', 'vdr-abandon')).toBeTruthy()
      runOrch(repo.root, 'abandon vdr-abandon')
      expect(readCard(repo.root, 'failed', 'vdr-abandon')).toBeTruthy()
      const text = fs.readFileSync(incidentPath(repo.root, 'vdr-abandon'), 'utf8')
      expect(text).toContain('人工 abandon')
      expect(text).toContain('## 考题草稿建议')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator incident > 上游海况（网关请求日志投影）', () => {
  /** 往 fakeHome 网关日志写一条请求（字段对齐 src/gateway LogEntry）。 */
  function writeSeaEntry(ts: string, status: number, extra: Record<string, unknown> = {}) {
    const dir = gatewayLogsDir()
    if (!dir) throw new Error('fakeHome 未生效')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, `gateway-${ts.slice(0, 10)}.jsonl`),
      JSON.stringify({ ts, harness: 'zcode', profile: 'orch', provider: 'up', model: 'glm-4.7', path: '/v1/messages', status, ...extra }) + '\n',
    )
  }

  it('resume 再落位时覆盖出带数据的海况段：请求/失败分布/路由痕迹/时延/用量/最近失败', () => {
    const h = fakeHome()
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'vdr-sea')
      runOrch(repo.root, 'run vdr-sea --backend mock', { ORCH_MOCK_WORKER_STATUS: 'stuck' })
      // 第一次归档时还没有网关日志；窗口从首个 worker_spawned 起算（±60s 容差），
      // 落在窗口内的 3 笔在 resume 的第二次归档中被投影进 incident.md。
      const evts = eventsOf(repo.root, 'vdr-sea') as Array<{ type: string; ts: string }>
      const startMs = new Date(evts.find((e) => e.type === 'worker_spawned')!.ts).getTime()
      writeSeaEntry(toIsoLocal(new Date(startMs)), 200, { ms: 1200, usage: { input_tokens: 1500, output_tokens: 200, cache_read_tokens: 900, cache_creation_tokens: 0 } })
      writeSeaEntry(toIsoLocal(new Date(startMs + 1000)), 429, { ms: 30 })
      writeSeaEntry(toIsoLocal(new Date(startMs + 2000)), 500, { ms: 40, reason: 'down_all' })
      runOrch(repo.root, 'resume vdr-sea --backend mock', { ORCH_MOCK_WORKER_STATUS: 'stuck' })

      const text = fs.readFileSync(incidentPath(repo.root, 'vdr-sea'), 'utf8')
      expect(text).toContain('## 上游海况（网关请求日志投影）')
      expect(text).toContain('请求 3 条（成功 1 / 失败 2）')
      expect(text).toContain('429×1')
      expect(text).toContain('down_all×1')
      expect(text).toContain('时延 p50/p95：1.2s / 1.2s')
      expect(text).toContain('输入 2.4k（缓存读 900 / 缓存建 0）/ 输出 200')
      expect(text).toContain('最近失败')
      expect(text).toContain('reason=down_all')
      // 未投影段不该出现在有数据的包里
      expect(text).not.toContain('（跳过：')
    } finally {
      repo.cleanup()
      h.restore()
    }
  }, 120_000)

  it('未启用网关日志（无 gatewayLogDir 且无 env 重定向）→ 跳过并给可操作原因', () => {
    const savedFake = process.env.MODELRDOCK_FAKE_HOME
    const savedHome = process.env.MODELRDOCK_HOME
    delete process.env.MODELRDOCK_FAKE_HOME
    delete process.env.MODELRDOCK_HOME
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'vdr-nosea')
      runOrch(repo.root, 'run vdr-nosea --backend mock', { ORCH_MOCK_WORKER_STATUS: 'stuck' })
      const text = fs.readFileSync(incidentPath(repo.root, 'vdr-nosea'), 'utf8')
      expect(text).toContain('## 上游海况（网关请求日志投影）')
      expect(text).toContain('未启用网关日志')
      expect(text).toContain('gatewayLogDir')
    } finally {
      repo.cleanup()
      if (savedFake !== undefined) process.env.MODELRDOCK_FAKE_HOME = savedFake
      else delete process.env.MODELRDOCK_FAKE_HOME
      if (savedHome !== undefined) process.env.MODELRDOCK_HOME = savedHome
      else delete process.env.MODELRDOCK_HOME
    }
  }, 90_000)
})

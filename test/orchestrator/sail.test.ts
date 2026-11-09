// sail 自由航行测试（mock 后端，零外部调用）：时长解析与提交判定（单测）、停止条件
// （stop 文件 / drift 降级 / max-tasks / 到时收帆）、规划-提交-执行全自治闭环（mock
// planner 产卡 → sail 自动提交 gate=L1 → drain 全链 merged）、航海报告（战果清单 +
// 为什么这么编排）与 voyage.json / fleet 事件留痕。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseDurationMinutes,
  canSailSubmit,
  snapshotQueue,
  snapshotDrafts,
  diffQueueStates,
  buildSailReport,
  DEFAULT_SAIL_SUBMIT_TYPES,
} from '../../.agents/scripts/orchestrator/sail.mjs'
import { queueRoot, listCards } from '../../.agents/scripts/orchestrator/queue.mjs'
import { fleetLogPath } from '../../.agents/scripts/orchestrator/weather.mjs'
import { cardText, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

/** 最近一次航行的报告目录（logs/sail/<ts>/）。 */
function latestSailDir(repo: string): string {
  const dir = path.join(repo, '.agents', 'orchestrator', 'logs', 'sail')
  const entries = fs.readdirSync(dir).sort()
  return path.join(dir, entries[entries.length - 1])
}

function latestReport(repo: string): string {
  return fs.readFileSync(path.join(latestSailDir(repo), 'report.md'), 'utf8')
}

describe('orchestrator sail > 纯逻辑件', () => {
  it('parseDurationMinutes：人话时长解析；非法/缺失返回 null（不允许静默默认）', () => {
    expect(parseDurationMinutes({ minutes: 90 })).toBe(90)
    expect(parseDurationMinutes({ duration: '2h' })).toBe(120)
    expect(parseDurationMinutes({ duration: '90m' })).toBe(90)
    expect(parseDurationMinutes({ duration: '1h30m' })).toBe(90)
    expect(parseDurationMinutes({ duration: '45' })).toBe(45)
    expect(parseDurationMinutes({ duration: ' 45MIN ' })).toBe(45)
    expect(parseDurationMinutes({})).toBeNull()
    expect(parseDurationMinutes({ minutes: 0 })).toBeNull()
    expect(parseDurationMinutes({ minutes: -5 })).toBeNull()
    expect(parseDurationMinutes({ duration: 'abc' })).toBeNull()
    expect(parseDurationMinutes({ duration: '1h' })).toBe(60)
    expect(parseDurationMinutes({ duration: '0h' })).toBeNull()
    // 秒级时长（冒烟/测试短航）：90s → 1.5 分钟；'1m30s' 组合同值；'0s' 非法
    expect(parseDurationMinutes({ duration: '90s' })).toBe(1.5)
    expect(parseDurationMinutes({ duration: '1m30s' })).toBe(1.5)
    expect(parseDurationMinutes({ duration: ' 45SEC ' })).toBe(0.75)
    expect(parseDurationMinutes({ duration: '0s' })).toBeNull()
  })

  it('canSailSubmit：白名单内通过；人工草稿/deps/核心路径/白名单外拒绝', () => {
    const base = { id: 'x', type: 'docs', created_by: 'planner', files_hint: ['docs/**'] }
    expect(canSailSubmit(base, {}).ok).toBe(true)
    expect(canSailSubmit({ ...base, created_by: 'human' }, {}).ok).toBe(false)
    expect(canSailSubmit({ ...base, type: 'deps' }, {}).ok).toBe(false)
    expect(
      canSailSubmit({ ...base, type: 'refactor', files_hint: ['src/gateway/server.ts'] }, { corePaths: ['src/gateway/server.ts'] }).ok,
    ).toBe(false)
    expect(canSailSubmit({ ...base, type: 'refactor' }, { freeSail: { autoSubmitTypes: ['docs'] } }).ok).toBe(false)
    // 缺省白名单覆盖常规维护类型（deps 天然不在列；feature 2026-11 起走上游管线不入白名单）
    for (const t of ['docs', 'bugfix', 'refactor']) expect(DEFAULT_SAIL_SUBMIT_TYPES).toContain(t)
    expect(DEFAULT_SAIL_SUBMIT_TYPES).not.toContain('deps')
    expect(DEFAULT_SAIL_SUBMIT_TYPES).not.toContain('feature')
  })

  it('canSailSubmit：feature 提案永不直接自动提交（上游管线 research → spec → 人工审设计 → spec build）', () => {
    const feature = { id: 'feat-x', type: 'feature', created_by: 'planner', files_hint: ['docs/**'] }
    // 有无 research 字段都拒——拒绝理由指向 spec 管线（引用 brief 只影响管线推进，不影响提交判定）
    const noResearch = canSailSubmit(feature, {})
    expect(noResearch.ok).toBe(false)
    expect(noResearch.reason).toMatch(/上游管线|spec/)
    const withResearch = canSailSubmit({ ...feature, research: 'some-brief' }, {})
    expect(withResearch.ok).toBe(false)
    // 白名单配置强行加回 feature 也不放大授权面（配置只收窄、永不放大）
    expect(canSailSubmit(feature, { freeSail: { autoSubmitTypes: ['docs', 'feature'] } }).ok).toBe(false)
  })

  it('diffQueueStates：状态迁移与新入队', () => {
    const before = { pending: ['a', 'b'], running: [], reviewing: [], 'awaiting-human': [], merged: [], failed: [], blocked: [] }
    const after = { pending: ['c'], running: [], reviewing: [], 'awaiting-human': ['b'], merged: ['a'], failed: [], blocked: [] }
    const d = diffQueueStates(before, after)
    expect(d.changed).toContainEqual({ id: 'a', from: 'pending', to: 'merged' })
    expect(d.changed).toContainEqual({ id: 'b', from: 'pending', to: 'awaiting-human' })
    expect(d.added).toContainEqual({ id: 'c', state: 'pending' })
  })

  it('snapshotQueue/snapshotDrafts：缺失目录容错为空', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-snap-'))
    try {
      const q = path.join(tmp, 'queue')
      fs.mkdirSync(path.join(q, 'pending'), { recursive: true })
      fs.writeFileSync(path.join(q, 'pending', 'a.md'), 'x')
      expect(snapshotQueue(q)).toMatchObject({ pending: ['a'], merged: [] })
      expect(snapshotDrafts(tmp)).toEqual([])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('buildSailReport：战果/编排理由/授权边界确定性组装（不读盘，全走周期快照）', () => {
    const empty = { running: [], reviewing: [], failed: [], blocked: [] }
    const voyage = {
      projectName: 'TestDock',
      root: '/nonexistent-root',
      startedAtISO: '2026-11-02T10:00:00.000Z',
      finishedAtISO: '2026-11-02T11:58:00.000Z',
      minutes: 120,
      actualMinutes: 118,
      stopReason: '到达时长上限',
      dispatchedTotal: 1,
      goalsText: '1. 稳定全绿',
      cycles: [
        { n: 1, kind: 'plan', at: '', dispatched: [], proposals: [{ id: 'fix-a', createdBy: 'planner', type: 'bugfix', priority: 'high', goal: '修复合并去重' }], submitted: ['fix-a'], skipped: [], sleepMin: 0 },
        { n: 2, kind: 'dispatch', at: '', dispatched: ['fix-a'], proposals: [], submitted: [], skipped: [], sleepMin: 0, drainExit: 0 },
        { n: 3, kind: 'plan', at: '', dispatched: [], proposals: [{ id: 'dep-b', createdBy: 'scanner', type: 'deps', priority: 'normal', goal: '升级依赖' }], submitted: [], skipped: [{ id: 'dep-b', reason: 'deps 类型永不自动提交（依赖升级人工裁决）' }], sleepMin: 9 },
        { n: 4, kind: 'plan', at: '', dispatched: [], proposals: [], submitted: [], skipped: [], sleepMin: 10 },
      ],
      baseline: { pending: ['old-card'], 'awaiting-human': [], merged: [], ...empty },
      endState: { pending: ['old-card'], 'awaiting-human': [], merged: ['fix-a', 'ext-card'], ...empty },
      diff: { changed: [{ id: 'fix-a', from: 'pending', to: 'merged' }, { id: 'ext-card', from: 'running', to: 'merged' }], added: [] },
    }
    const report = buildSailReport(voyage)
    expect(report).toContain('已出港（merged，1 张）')
    expect(report).toContain('fix-a（bugfix）：修复合并去重')
    // 外部落位（from ≠ pending，如并行会话 finish 合并）不混入战果，单列披露
    expect(report).toContain('🔄 航期内由其他流程落位（非本航次编排，1 张）')
    expect(report).toContain('ext-card（running → merged）——并行会话/人工操作所为，不计入本航次战果')
    const mergedSection = report.split('### ⏸')[0]
    expect(mergedSection).not.toContain('ext-card（?')
    expect(report).toContain('未提交（deps 类型永不自动提交（依赖升级人工裁决））')
    expect(report).toContain('开航基线：pending 1')
    expect(report).toContain('罗盘（goals.md）：有')
    expect(report).toContain('到达时长上限')
    expect(report).toContain('休眠 10 分钟')
    expect(report).toContain('自动的是「进队列」，不是「进主干」')
  })
})

describe('orchestrator sail > 停止条件与留痕', () => {
  it('缺时长直接拒绝（自由航行烧钱，不允许静默默认时长）', () => {
    const repo = mkRepo()
    try {
      const r = tryOrch(repo.root, 'sail --backend mock')
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('时长必须显式指定')
    } finally {
      repo.cleanup()
    }
  })

  it('stop 文件即停：首周期检测到即收帆出报告并清掉 stop 文件', () => {
    const repo = mkRepo()
    try {
      const stop = path.join(repo.root, '.agents', 'orchestrator', '.sail-stop')
      fs.mkdirSync(path.dirname(stop), { recursive: true })
      fs.writeFileSync(stop, '')
      const out = runOrch(repo.root, 'sail --minutes 5 --interval 0 --backend mock')
      expect(out.stdout).toContain('.sail-stop')
      expect(out.stdout).toContain('自由航行收帆')
      expect(out.stdout).toContain('自由航行航海报告')
      expect(fs.existsSync(stop)).toBe(false)
      const report = latestReport(repo.root)
      expect(report).toContain('stop 文件')
      expect(fs.existsSync(path.join(latestSailDir(repo.root), 'voyage.json'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('drift 降级生效：sail 收帆（保险丝不允许自己插回去）', () => {
    const repo = mkRepo()
    try {
      fs.mkdirSync(path.join(repo.root, '.agents', 'orchestrator'), { recursive: true })
      fs.writeFileSync(path.join(repo.root, '.agents', 'orchestrator', 'degraded.json'), JSON.stringify({ degraded_at: new Date().toISOString(), reason: '测试注入' }))
      const out = runOrch(repo.root, 'sail --minutes 5 --interval 0 --backend mock')
      expect(out.stdout).toContain('drift 降级')
      expect(out.stdout).toContain('自由航行收帆')
      expect(latestReport(repo.root)).toContain('drift 降级')
    } finally {
      repo.cleanup()
    }
  }, 60_000)
})

describe('orchestrator sail > 全自治闭环（mock）', () => {
  it('规划-提交-执行：planner 产卡 → sail 自动提交（gate=L1）→ drain 全链 merged → 报告含战果与编排理由', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'sail --minutes 5 --interval 0 --max-tasks 1 --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(out.stdout).toContain('自由航行已提交提案')
      expect(out.stdout).toContain('gate=L1')
      expect(listCards(queueRoot(repo.root), 'merged')).toEqual(['planner-mock-task'])
      const report = latestReport(repo.root)
      expect(report).toContain('planner-mock-task（docs）：mock planner 目标')
      expect(report).toContain('已提交（gate=L1，进队列待派发）')
      expect(report).toContain('为什么这么编排')
      expect(report).toContain('自动的是「进队列」，不是「进主干」')
      // fleet 留痕
      const fleet = fs.readFileSync(fleetLogPath(repo.root), 'utf8')
      expect(fleet).toContain('sail_started')
      expect(fleet).toContain('sail_finished')
    } finally {
      repo.cleanup()
    }
  }, 150_000)

  it('上游管线（Plan A）：feature 提案 → 派调研出 brief → 自动升级 spec 落盘待人审，不直接进队列', () => {
    const repo = mkRepo()
    try {
      // 秒级时长（同「到时收帆」测试技巧）：feature 不进队列 → max-tasks 永不触达，
      // 周期 1 完成规划+上游管线后睡到 deadline 收帆
      const out = runOrch(repo.root, 'sail --duration 12s --interval 1 --backend mock', { ORCH_MOCK_PLANNER_FEATURE: '1' })
      expect(out.stdout).toContain('到达时长上限')
      // spec 三件套落盘（id=提案 id）+ 调研 brief 落盘 + 提案未进队列
      const specDir = path.join(repo.root, '.agents', 'orchestrator', 'specs', 'planner-mock-task')
      expect(fs.existsSync(path.join(specDir, 'design.md'))).toBe(true)
      expect(fs.existsSync(path.join(specDir, 'requirements.md'))).toBe(true)
      expect(fs.existsSync(path.join(specDir, 'tasks.md'))).toBe(true)
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'research', 'mock-planner', 'brief.md'))).toBe(true)
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'planner-mock-task.md'))).toBe(false)
      // 提案 research 字段被盖成 brief id；brief 引用非空
      const draft = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', 'planner-mock-task.md'), 'utf8')
      expect(draft).toMatch(/research: mock-planner/)
      const brief = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'research', 'mock-planner', 'brief.md'), 'utf8')
      expect(brief).toContain('https://example.com/mock-research')
      // 航海报告如实收录上游管线去向
      const report = latestReport(repo.root)
      expect(report).toContain('上游管线：调研 brief mock-planner')
      expect(report).toContain('上游管线：spec planner-mock-task 已落盘待人审')
      expect(report).toContain('feature 提案走上游管线')
    } finally {
      repo.cleanup()
    }
  }, 150_000)

  it('specAutoBuild 预授权档（on）：spec 落盘即自动拆卡 gate=L1 进 pending（引水闸兜底，不停盘等人审）', () => {
    // corePaths 盖住 mock 规格的文件面（docs/**）：拆出的卡被引水闸拦停派发、稳定留
    // pending——既验证自动拆卡落位，也验证「安全网由引水闸天然兜底，不另造判断」。
    const repo = mkRepo({ extra: { upstream: { specAutoBuild: { enabled: true } }, corePaths: ['docs/**'] } })
    try {
      const out = runOrch(repo.root, 'sail --duration 12s --interval 1 --backend mock', { ORCH_MOCK_PLANNER_FEATURE: '1' })
      expect(out.stdout).toContain('specAutoBuild')
      expect(out.stdout).toContain('自动拆卡 2 张进 pending')
      // 拆出的卡进 pending：gate=L1、type=feature（renderTaskCard 硬编码 type 不变）
      const pending = [...listCards(queueRoot(repo.root), 'pending')].sort()
      expect(pending).toEqual(['planner-mock-task-t1', 'planner-mock-task-t2'])
      for (const id of pending) {
        const card = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', `${id}.md`), 'utf8')
        expect(card).toContain('gate: L1')
        expect(card).toContain('type: feature')
        expect(card).toContain('spec: planner-mock-task')
      }
      // 进度锚与三件套照常落盘
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'specs', 'planner-mock-task', 'progress.json'))).toBe(true)
      // 航海报告如实区分自动拆卡（与「落盘待人审」分叉）
      const report = latestReport(repo.root)
      expect(report).toContain('已自动拆卡进队列')
      expect(report).not.toContain('已落盘待人审')
    } finally {
      repo.cleanup()
    }
  }, 150_000)

  it('执行存量卡：开航前 pending 的卡派发到 awaiting-human，报告收录且基线如实区分', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'pre-card')
      const out = runOrch(repo.root, 'sail --minutes 5 --interval 0 --max-tasks 1 --backend mock')
      expect(readCard(repo.root, 'awaiting-human', 'pre-card')).toBeTruthy()
      const report = latestReport(repo.root)
      expect(report).toContain('pre-card')
      expect(report).toContain('待船东放行')
      expect(report).toContain('开航基线：pending 1')
      expect(report).toContain('派发执行 → pre-card')
    } finally {
      repo.cleanup()
    }
  }, 150_000)

  it('到时收帆：不设 max-tasks 时只能靠 deadline 停（重复提案被队列去重，持续规划循环）', () => {
    const repo = mkRepo()
    try {
      // 秒级时长（90s 特性）压缩墙钟：deadline 机制与分钟航完全同一条路径，61s→~12s
      const out = runOrch(repo.root, 'sail --duration 12s --interval 1 --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(out.stdout).toContain('到达时长上限')
      expect(latestReport(repo.root)).toContain('到达时长上限')
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('存量引水卡不触发无进展熔断：全引水队列走规划轮继续干活，引水卡原地保留', () => {
    const repo = mkRepo({ extra: { corePaths: ['src/gateway/server.ts'] } })
    try {
      submitCard(repo.root, 'pilot-held', { files_hint: ['src/gateway/server.ts'] })
      const out = runOrch(repo.root, 'sail --minutes 5 --interval 0 --max-tasks 1 --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(out.stdout).not.toContain('连续 3 轮派发无进展')
      expect(out.stdout).toContain('自由航行已提交提案')
      expect(listCards(queueRoot(repo.root), 'merged')).toEqual(['planner-mock-task'])
      expect(readCard(repo.root, 'pending', 'pilot-held')).toBeTruthy()
      expect(latestReport(repo.root)).toContain('开航前已在队列')
    } finally {
      repo.cleanup()
    }
  }, 150_000)
})

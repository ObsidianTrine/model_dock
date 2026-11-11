// propose 需求综合测试（mock planner，零外部调用）：目标面/巡检信号进 prompt、
// 提案落 drafts（proposal: true / created_by planner / gate L3）、autopilot 白名单
// 自动提交（gate→L1）与提交后的可合并性（docs 提案 drain 全链到 merged）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildProposePrompt, parseCardBlocks } from '../../.agents/scripts/orchestrator/prompt.mjs'
import { buildFleetFeedback, collectStatsSummary, extractGoalsThemes } from '../../.agents/scripts/orchestrator/stats.mjs'
import { readGoals } from '../../.agents/scripts/orchestrator/goals.mjs'
import { listCards, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'
import { cardText, mkRepo, runOrch, runOrchInproc } from './helpers.js'

describe('orchestrator propose > prompt 构建与解析', () => {
  it('buildProposePrompt：目标面/信号/队列现状/上限注入；无目标面降级提示', () => {
    const p = buildProposePrompt({ goals: '1. 网关 p99 达标', signals: '- scan-ki-perf-15（refactor/normal）：改 key 全表重加密', queueSummary: 'pending=0', maxCards: 2, repoRoot: process.cwd() })
    expect(p).toContain('网关 p99 达标')
    expect(p).toContain('scan-ki-perf-15')
    expect(p).toContain('pending=0')
    expect(p).toContain('至多 2 张')
    expect(p).toContain('proposal: true')
    expect(p).toContain('9. docs/known-issues.md 是已知问题账本')
    expect(p).toContain('一律视为已解决，禁止为其出卡')
    expect(p).toContain('10. 围栏外只允许一句话概述')
    const p2 = buildProposePrompt({ goals: null, signals: '', queueSummary: '', maxCards: 1, repoRoot: process.cwd() })
    expect(p2).toContain('未提供 goals.md')
  })

  it('parseCardBlocks：多卡全部提取；无块返回空数组', () => {
    const two = '前置说明\n```agents-card\n---\nid: a\n---\n卡A\n```\n中缝\n```agents-card\n---\nid: b\n---\n卡B\n```'
    expect(parseCardBlocks(two)).toHaveLength(2)
    expect(parseCardBlocks('没有块')).toEqual([])
  })

  it('readGoals：缺失/空文件 = null（无目标面降级）；有内容原样返回', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-goals-'))
    try {
      expect(readGoals(dir)).toBeNull()
      const ap = path.join(dir, '.agents', 'orchestrator')
      fs.mkdirSync(ap, { recursive: true })
      fs.writeFileSync(path.join(ap, 'goals.md'), '\n')
      expect(readGoals(dir)).toBeNull()
      fs.writeFileSync(path.join(ap, 'goals.md'), '# 目标\n- 稳定全绿\n')
      expect(readGoals(dir)).toContain('稳定全绿')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('buildProposePrompt：传 fleetFeedback 才出现舰队反馈段（队列现状后、产出契约前）；不传 = 无该段且逐字节稳定', () => {
    const base = { goals: 'g', signals: 's', queueSummary: 'pending=0', maxCards: 1, repoRoot: process.cwd() }
    const fb = '- 运行画像：近 7 天启动任务 3 个，合并率 67%'
    const withFb = buildProposePrompt({ ...base, fleetFeedback: fb })
    expect(withFb).toContain('## 舰队反馈')
    expect(withFb).toContain(fb)
    expect(withFb.indexOf('舰队反馈')).toBeGreaterThan(withFb.indexOf('队列现状'))
    expect(withFb.indexOf('舰队反馈')).toBeLessThan(withFb.indexOf('# 产出契约'))
    const without = buildProposePrompt(base)
    expect(without).not.toContain('舰队反馈')
    expect(without).toBe(buildProposePrompt({ ...base, fleetFeedback: undefined })) // 关闭态逐字节稳定
  })

  it('buildFleetFeedback：数据事实行（画像/near-miss/各 type/drift/主题）；空数据与降级态降级输出', () => {
    const fb = buildFleetFeedback({
      summary: { window_days: 7, tasks_started: 4, settled: 3, merged: 2, merge_rate: 0.67, avg_merged_wall_min: 12, near_miss: { watchdog: 1, retries: 4, xte: 0, incidents: 1 } },
      perType: [
        { type: 'bugfix', started: 2, settled: 2, merged: 2, merge_rate: 1, avg_merged_wall_min: 12, avg_merged_tokens_peak: 52300 },
        { type: 'refactor', started: 2, settled: 1, merged: 0, merge_rate: 0, avg_merged_wall_min: null, avg_merged_tokens_peak: null },
      ],
      drift: null,
      goalsThemes: 'stats 反馈进规划',
    })
    expect(fb).toContain('启动任务 4 个')
    expect(fb).toContain('合并率 67%')
    expect(fb).toContain('watchdog suspect 1 / 瞬时重试 4 / 偏航报警 0 / 事故调查包 1')
    expect(fb).toContain('bugfix 100%/12m/52.3k')
    expect(fb).toContain('refactor 0%/-/-')
    expect(fb).toContain('质量漂移：正常')
    expect(fb).toContain('目标面当前主题：stats 反馈进规划')
    const empty = buildFleetFeedback({
      summary: { window_days: 7, tasks_started: 0, settled: 0, merged: 0, merge_rate: null, avg_merged_wall_min: null, near_miss: { watchdog: 0, retries: 0, xte: 0, incidents: 0 } },
      perType: [],
      drift: { reason: '自动合并回溯失败率 50% 超阈值 20%' },
      goalsThemes: null,
    })
    expect(empty).toContain('无任务启动数据')
    expect(empty).toContain('⚠ 降级中——自动合并回溯失败率 50%')
    expect(empty).not.toContain('各类型消化数据')
    expect(empty).not.toContain('目标面当前主题')
  })

  it('extractGoalsThemes：摘「当前主题」段到下一标题前；缺失/空 = null', () => {
    const goals = '# 目标\n\n## 核心目标\n1. A\n\n## 当前主题\n- stats 反馈进规划\n- 修 known-issues\n\n## 明确不做\n- MCP 下发\n'
    const themes = extractGoalsThemes(goals)
    expect(themes).toContain('stats 反馈进规划')
    expect(themes).toContain('修 known-issues')
    expect(themes).not.toContain('MCP 下发')
    expect(themes).not.toContain('核心目标')
    expect(extractGoalsThemes('无段落标题的 goals')).toBeNull()
    expect(extractGoalsThemes(null)).toBeNull()
  })

  it('collectStatsSummary：空仓库 rows 空、summary 全零、drift null（propose 舰队反馈安全降级）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-statsfb-'))
    try {
      const collected = collectStatsSummary(dir, { days: 7 })
      expect(collected.rows).toEqual([])
      expect(collected.summary.tasks_started).toBe(0)
      expect(collected.summary.near_miss).toEqual({ watchdog: 0, retries: 0, xte: 0, incidents: 0 })
      expect(collected.perType).toEqual([])
      expect(collected.drift).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('orchestrator propose > 端到端（mock planner）', () => {
  it('propose：提案落 drafts（proposal/created_by/gate 归一）；autopilot 关闭不提交', async () => {
    const repo = mkRepo()
    try {
      const out = await runOrchInproc(repo.root, 'propose --backend mock')
      expect(out.stdout).toContain('落提案 1 张')
      const draftsDir = path.join(repo.root, '.agents', 'orchestrator', 'drafts')
      const drafts = fs.readdirSync(draftsDir).filter((f) => f.endsWith('.md'))
      expect(drafts).toEqual(['planner-mock-task.md'])
      const text = fs.readFileSync(path.join(draftsDir, 'planner-mock-task.md'), 'utf8')
      expect(text).toContain('proposal: true')
      expect(text).toMatch(/created_by: planner/)
      expect(text).toContain('gate: L3')
      expect(listCards(queueRoot(repo.root), 'pending')).toHaveLength(0) // 未授权：只提案不提交
    } finally {
      repo.cleanup()
    }
  })

  it('autopilot 开启（白名单 docs）：提案自动提交 pending 且 gate→L1；drain 全链 merged', async () => {
    const repo = mkRepo({ extra: { autopilot: { enabled: true, autoSubmitTypes: ['docs'], autoDrainPerCycle: 3 } } })
    try {
      const out = await runOrchInproc(repo.root, 'propose --backend mock')
      expect(out.stdout).toContain('autopilot 已提交提案')
      expect(out.stdout).toContain('gate=L1')
      expect(listCards(queueRoot(repo.root), 'pending')).toEqual(['planner-mock-task'])
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', 'planner-mock-task.md'))).toBe(false)
      const pending = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'planner-mock-task.md'), 'utf8')
      expect(pending).toContain('gate: L1')
      expect(pending).toContain('proposal: true')
      // 提交后可被常规闭环消费：mock worker 写 docs 文件 → 实际分级 L0 → gate L1 自动合并
      const drained = runOrch(repo.root, 'drain --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(drained.stdout).toContain('自动合并')
      expect(listCards(queueRoot(repo.root), 'merged')).toEqual(['planner-mock-task'])
    } finally {
      repo.cleanup()
    }
  }, 90_000)

  it('autopilot 开启但白名单外（refactor 提案）：只落 drafts 不提交', () => {
    // TODO 信号卡 type=refactor；白名单只有 docs → scan 产物不自动提交
    const repo = mkRepo({ extra: { autopilot: { enabled: true, autoSubmitTypes: ['docs'] } } })
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: 保持提案态\nexport {}\n')
      const out = runOrch(repo.root, 'scan --todo')
      expect(out.stdout).toContain('不自动提交')
      expect(out.stdout).toContain('autoSubmitTypes')
      expect(listCards(queueRoot(repo.root), 'pending')).toHaveLength(0)
    } finally {
      repo.cleanup()
    }
  })

  it('goals.md 目标面存在时进 planner prompt（mock 会话照常产出）', async () => {
    const repo = mkRepo()
    try {
      const ap = path.join(repo.root, '.agents', 'orchestrator')
      fs.mkdirSync(ap, { recursive: true })
      fs.writeFileSync(path.join(ap, 'goals.md'), '# 项目目标面\n\n## 核心目标\n1. 文档自动化提案链路稳定\n')
      const out = await runOrchInproc(repo.root, 'propose --backend mock')
      expect(out.status).toBe(0)
      expect(fs.existsSync(path.join(ap, 'drafts', 'planner-mock-task.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('planner 会话留底：无效输出重试耗尽 → decisions/ 每次尝试一份 trace（含原始输出全文与 exitCode），失败日志附 exitCode', async () => {
    const repo = mkRepo()
    try {
      const r = await runOrchInproc(repo.root, 'propose --backend mock', { ORCH_MOCK_PLANNER_INVALID: '1' })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('均未产出提案契约块')
      expect(r.stderr).toContain('exitCode=0') // 失败日志不再只有「N 次均未产出契约块」
      const logsDir = path.join(repo.root, '.agents', 'orchestrator', 'logs')
      const sessions = fs.readdirSync(logsDir).filter((d) => d.startsWith('planner-')).sort()
      expect(sessions).toHaveLength(1)
      const decDir = path.join(logsDir, sessions[0], 'decisions')
      const files = fs.readdirSync(decDir).filter((f) => f.startsWith('planner-') && f.endsWith('.json')).sort()
      expect(files).toHaveLength(3) // 3 次尝试各留一份
      const docs = files.map((f) => JSON.parse(fs.readFileSync(path.join(decDir, f), 'utf8')))
      expect(docs.map((d) => d.meta.attempt)).toEqual([1, 2, 3])
      for (const doc of docs) {
        expect(doc.kind).toBe('planner')
        expect(doc.taskId).toBe(sessions[0])
        expect(doc.output).toContain('没有产出任务卡') // mock planner 原始输出全文（复盘现场）
        expect(doc.meta.command).toBe('propose')
        expect(doc.meta.exitCode).toBe(0)
        expect(doc.meta.durationMs).toBeGreaterThanOrEqual(0)
      }
      expect(docs[0].parsed).toBeNull()
      expect(docs[0].input).not.toContain('重试要求')
      expect(docs[1].input).toContain('重试要求') // 重试追加的要求随 prompt 全文留痕，逐次增长
      expect(docs[1].input.length).toBeGreaterThan(docs[0].input.length)
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator propose > 舰队反馈（propose.feedback，缺省关）', () => {
  /** propose planner 会话 trace 里的 prompt 全文（decisions/planner-*.json 的 input）。 */
  function plannerInputs(repo: string): string[] {
    const logsDir = path.join(repo, '.agents', 'orchestrator', 'logs')
    if (!fs.existsSync(logsDir)) return []
    const out: string[] = []
    for (const s of fs.readdirSync(logsDir).filter((d) => d.startsWith('planner-'))) {
      const decDir = path.join(logsDir, s, 'decisions')
      if (!fs.existsSync(decDir)) continue
      for (const f of fs.readdirSync(decDir).filter((f) => f.startsWith('planner-') && f.endsWith('.json'))) {
        out.push(String(JSON.parse(fs.readFileSync(path.join(decDir, f), 'utf8')).input ?? ''))
      }
    }
    return out
  }

  async function runOneTask(repo: string, id: string): Promise<void> {
    const cardFile = path.join(repo, `card-${id}.md`)
    fs.writeFileSync(cardFile, cardText({ id }))
    await runOrchInproc(repo, `submit "${cardFile}"`)
    runOrch(repo, `run ${id} --backend mock`)
  }

  it('开启（propose.feedback: true）：planner 输入含舰队反馈段（stats 同源数据事实）', async () => {
    const repo = mkRepo({ extra: { propose: { feedback: true } } })
    try {
      await runOneTask(repo.root, 'fb-on')
      const out = await runOrchInproc(repo.root, 'propose --backend mock')
      expect(out.status).toBe(0)
      const inputs = plannerInputs(repo.root)
      expect(inputs.length).toBeGreaterThan(0)
      expect(inputs[0]).toContain('## 舰队反馈')
      expect(inputs[0]).toContain('启动任务 1 个')
      expect(inputs[0]).toContain('质量漂移')
    } finally {
      repo.cleanup()
    }
  }, 90_000)

  it('缺省关闭：planner 输入无舰队反馈段（与历史一致）', async () => {
    const repo = mkRepo()
    try {
      await runOneTask(repo.root, 'fb-off')
      const out = await runOrchInproc(repo.root, 'propose --backend mock')
      expect(out.status).toBe(0)
      const inputs = plannerInputs(repo.root)
      expect(inputs.length).toBeGreaterThan(0)
      expect(inputs[0]).not.toContain('舰队反馈')
      expect(inputs[0]).toContain('队列现状')
    } finally {
      repo.cleanup()
    }
  }, 90_000)
})

describe('orchestrator propose > planner 模型键（propose.model，缺省跟随引擎默认）', () => {
  /** 全部 planner 会话 trace 文档（decisions/planner-*.json）。 */
  function plannerTraces(repo: string): Array<Record<string, unknown>> {
    const logsDir = path.join(repo, '.agents', 'orchestrator', 'logs')
    const out: Array<Record<string, unknown>> = []
    for (const s of fs.readdirSync(logsDir).filter((d) => d.startsWith('planner-'))) {
      const decDir = path.join(logsDir, s, 'decisions')
      if (!fs.existsSync(decDir)) continue
      for (const f of fs.readdirSync(decDir).filter((x) => x.startsWith('planner-') && x.endsWith('.json'))) {
        out.push(JSON.parse(fs.readFileSync(path.join(decDir, f), 'utf8')))
      }
    }
    return out
  }

  it('配置 propose.model：会话留痕 meta.model（intent 命令同键），产出照常落卡', async () => {
    const repo = mkRepo({ extra: { propose: { model: 'glm-5.3-flash' } } })
    try {
      const out = await runOrchInproc(repo.root, 'propose --backend mock')
      expect(out.status).toBe(0)
      const docs = plannerTraces(repo.root)
      expect(docs.length).toBeGreaterThan(0)
      for (const d of docs) expect((d.meta as Record<string, unknown>).model).toBe('glm-5.3-flash')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', 'planner-mock-task.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  }, 90_000)

  it('未配置：trace 无 model 字段（与历史逐字节兼容）', async () => {
    const repo = mkRepo()
    try {
      const out = await runOrchInproc(repo.root, 'propose --backend mock')
      expect(out.status).toBe(0)
      const docs = plannerTraces(repo.root)
      expect(docs.length).toBeGreaterThan(0)
      for (const d of docs) expect('model' in (d.meta as Record<string, unknown>)).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 90_000)
})

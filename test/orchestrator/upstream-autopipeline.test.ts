// 上游管线下沉（P1-8，2026-11）：watch（autopilot 开时）与 nightly --plan 周期推进 feature
// 提案的 research → spec（→ specAutoBuild 拆卡）管线——9h 自主循环的主粮管线不缺位。
// 配置 upstream.autoPipeline（缺省关 = 行为与历史完全一致）；配额随调用方传入
//（upstream.autoPipeline.researchPerCycle / specPerCycle）；复查通道与 sail 同款
//（collectUpstreamRechecks 事件留痕重建）。mock 后端零外部调用；引水闸/L2 分级/硬禁区
// 语义原样兜底（feature 提案照旧不被自动提交，nightly --auto 不受影响由 hardZone 测试覆盖）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { listCards, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'
import { mkRepo, runOrch } from './helpers.js'

const AP_ON = {
  autopilot: { enabled: true, autoSubmitTypes: ['docs', 'bugfix', 'refactor'], autoDrainPerCycle: 3, maxProposalsPerCycle: 3 },
  upstream: { specAutoBuild: { enabled: true }, autoPipeline: { enabled: true } },
}
const AP_OFF = {
  autopilot: { enabled: true, autoSubmitTypes: ['docs', 'bugfix', 'refactor'], autoDrainPerCycle: 3, maxProposalsPerCycle: 3 },
}

/** 预置 brief（meta+brief+可选 verdict）：提案经 ORCH_MOCK_PLANNER_RESEARCH 直接引用，跳过派调研（sail.test 同款）。 */
function plantBrief(repo: string, id: string, verdict: Record<string, unknown> | null): void {
  const dir = path.join(repo, '.agents', 'orchestrator', 'research', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id, title: 'mock 调研标题', question: 'mock 问题', backend: 'mock', created_at: new Date().toISOString() }),
  )
  fs.writeFileSync(
    path.join(dir, 'brief.md'),
    '# 结论\nmock 结论占位。\n\n# 选项对比\n- 方案 A：mock 占位。\n\n# 引用\n\n# 建议\nmock 占位。\n\n# 罗盘对齐\nmock 占位。\n',
  )
  if (verdict) fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify(verdict, null, 2))
}

/** verdict.json 最小形（assessBrief 产出同构；测试只关心 usage.internal_decision 与 claims）。 */
function verdictFixture(internalDecision: string, claims: Array<Record<string, unknown>> = []): Record<string, unknown> {
  return {
    schema: 'modeldock.research.verdict/2',
    advisory: true,
    brief_id: 'mock-planner',
    model: 'mock',
    created_at: new Date().toISOString(),
    scores: { evidence: null, coherence: null, coverage: null, citation: 100, overall: null },
    snapshots: { total: 0, usable: 0, skeleton: 0 },
    claims,
    blockers: [],
    fabricated_claims: 0,
    usage: { browse: 'ok', internal_decision: internalDecision, external_doc: internalDecision },
    level: 'unknown',
    reasons: [],
  }
}

function specDir(repo: string, id = 'planner-mock-task'): string {
  return path.join(repo, '.agents', 'orchestrator', 'specs', id)
}

function researchDir(repo: string): string {
  return path.join(repo, '.agents', 'orchestrator', 'research')
}

describe('orchestrator upstream.autoPipeline > watch（autopilot 开时）', () => {
  it('全链：propose 出 feature 提案 → 派调研出 brief → spec 落盘 → specAutoBuild 拆卡 → 本周期 drain 推进闭环', () => {
    const repo = mkRepo({ extra: AP_ON })
    try {
      // 单周期即全链（drain 在周期 1 内紧跟管线）：多周期时下轮 propose 会同 id 覆盖提案、
      // 把管线盖的 research 戳重置回 todo（sail 规划轮既有同款语义，spec 存在性守卫防重复烧）
      const out = runOrch(repo.root, 'watch --max-cycles 1 --interval 0 --backend mock', { ORCH_MOCK_PLANNER_FEATURE: '1', ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('watch 周期 1 → 上游管线')
      // 调研 brief 落盘 + spec 三件套落盘（id=提案 id）
      expect(fs.existsSync(path.join(researchDir(repo.root), 'mock-planner', 'brief.md'))).toBe(true)
      expect(fs.existsSync(path.join(specDir(repo.root), 'design.md'))).toBe(true)
      expect(fs.existsSync(path.join(specDir(repo.root), 'requirements.md'))).toBe(true)
      expect(fs.existsSync(path.join(specDir(repo.root), 'tasks.md'))).toBe(true)
      // 提案 research 字段被盖成 brief id；提案本体不进队列（feature 永不自动提交）
      const draft = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', 'planner-mock-task.md'), 'utf8')
      expect(draft).toMatch(/research: mock-planner/)
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'planner-mock-task.md'))).toBe(false)
      // specAutoBuild 拆出的卡经同周期 drain 推进（mock worker 附带 spec 进度文件超出
      // files_hint → purityOutside 挡自动合并，落 awaiting-human 等人工——分级闸门兜底语义）
      const awaiting = listCards(queueRoot(repo.root), 'awaiting-human')
      expect(awaiting).toEqual(expect.arrayContaining(['planner-mock-task-t1', 'planner-mock-task-t2']))
      expect(listCards(queueRoot(repo.root), 'pending')).toEqual([])
    } finally {
      repo.cleanup()
    }
  }, 240_000)

  it('enabled=false：行为与历史完全一致——不派调研、不落 spec、不拆卡（提案留 drafts 原地）', () => {
    const repo = mkRepo({ extra: AP_OFF })
    try {
      const out = runOrch(repo.root, 'watch --max-cycles 2 --interval 0 --backend mock', { ORCH_MOCK_PLANNER_FEATURE: '1' })
      expect(out.status).toBe(0)
      expect(out.stdout).not.toContain('watch 周期 1 → 上游管线')
      expect(out.stdout).toContain('已达 --max-cycles 2')
      expect(fs.existsSync(researchDir(repo.root))).toBe(false)
      expect(fs.existsSync(specDir(repo.root))).toBe(false)
      const draft = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', 'planner-mock-task.md'), 'utf8')
      expect(draft).toMatch(/research: todo/)
      for (const s of ['pending', 'merged', 'awaiting-human']) expect(listCards(queueRoot(repo.root), s)).toEqual([])
    } finally {
      repo.cleanup()
    }
  }, 240_000)

  it('复查通道与 sail 同款：verdict 闸门拦下 → 下周期事件留痕重建重进管线，未改判零配额跳过（不重调研、不落 spec）', () => {
    const repo = mkRepo({ extra: AP_ON })
    try {
      plantBrief(repo.root, 'mock-planner', verdictFixture('unsafe', [{ claim: 'mock 结论占位。', status: 'contradicted', note: 'mock 复核矛盾' }]))
      const out = runOrch(repo.root, 'watch --max-cycles 2 --interval 0 --backend mock', { ORCH_MOCK_PLANNER_FEATURE: '1', ORCH_MOCK_PLANNER_RESEARCH: 'mock-planner' })
      expect(out.status).toBe(0)
      // 周期 1 新提案被闸门拦下；周期 2 复查名单重建（新提案 0、复查 1）再次零配额跳过
      expect(out.stdout).toContain('新提案 1 张、复查 0 张')
      expect(out.stdout).toContain('新提案 0 张、复查 1 张')
      const events = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'sail', 'events.jsonl'), 'utf8')
      expect(events.match(/"type":"research_verdict_blocked"/g)?.length).toBe(2)
      // spec 不落盘；调研零配额消耗（research/ 只有预置 brief，无新会话产物）
      expect(fs.existsSync(specDir(repo.root))).toBe(false)
      expect(fs.readdirSync(researchDir(repo.root))).toEqual(['mock-planner'])
      // 单 brief verdict 闸门按事件留痕（不盖 research_status 永久留痕——改判后即可放行）
      const draft = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', 'planner-mock-task.md'), 'utf8')
      expect(draft).not.toMatch(/research_status/)
    } finally {
      repo.cleanup()
    }
  }, 240_000)
})

describe('orchestrator upstream.autoPipeline > nightly --plan', () => {
  it('全链：propose 出 feature 提案 → 管线推进（brief → spec → specAutoBuild 拆卡进 pending），摘要收录', () => {
    const repo = mkRepo({ extra: AP_ON })
    try {
      const out = runOrch(repo.root, 'nightly --plan --backend mock', { ORCH_MOCK_PLANNER_FEATURE: '1' })
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('nightly --plan → 上游管线')
      expect(fs.existsSync(path.join(researchDir(repo.root), 'mock-planner', 'brief.md'))).toBe(true)
      expect(fs.existsSync(path.join(specDir(repo.root), 'design.md'))).toBe(true)
      // 无 --auto 不派发：拆出的卡留 pending（gate=L1），摘要含管线战果行
      const pending = [...listCards(queueRoot(repo.root), 'pending')].sort()
      expect(pending).toEqual(['planner-mock-task-t1', 'planner-mock-task-t2'])
      expect(out.stdout).toContain('上游管线: 调研 1')
      expect(out.stdout).toContain('自动拆卡 2')
      // 提案本体不进队列（feature 永不自动提交，nightly --auto 的 hardZone 过滤不受影响）
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'planner-mock-task.md'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 240_000)

  it('enabled=false：--plan 行为与历史完全一致——只出提案不跑管线', () => {
    const repo = mkRepo({ extra: AP_OFF })
    try {
      const out = runOrch(repo.root, 'nightly --plan --backend mock', { ORCH_MOCK_PLANNER_FEATURE: '1' })
      expect(out.status).toBe(0)
      expect(out.stdout).not.toContain('nightly --plan → 上游管线')
      expect(out.stdout).not.toContain('上游管线:')
      expect(fs.existsSync(researchDir(repo.root))).toBe(false)
      expect(fs.existsSync(specDir(repo.root))).toBe(false)
      expect(listCards(queueRoot(repo.root), 'pending')).toEqual([])
      const draft = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', 'planner-mock-task.md'), 'utf8')
      expect(draft).toMatch(/research: todo/)
    } finally {
      repo.cleanup()
    }
  }, 240_000)
})

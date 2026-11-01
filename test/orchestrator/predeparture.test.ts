// 航前纪律线测试（SOLAS V.34 借鉴）：B1 航次计划段（卡五段化，计划先行）、
// B2 复诵协议（closed-loop repeat-back）、B3 引水闸（compulsory pilotage）、
// B8 交接班单（值班交接四要素）。端到端用例走 mkRepo + mock 后端全链。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardText, eventsOf, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'
import { ensureQueue, parseCard, pickNextCard, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'
import { buildPlannerPrompt, buildProposePrompt, buildWorkerPrompt } from '../../.agents/scripts/orchestrator/prompt.mjs'

const PLAN = '- 检查点 1：先解析任务卡 + parseCard 断言 plan 非空\n- 检查点 2：跑测试 + 全绿\n- 备选路线：若解析失败则按报错手修卡'

function ctx(repoRoot: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prompt-'))
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 测试 AGENTS\n\n端口红线。\n')
  fs.mkdirSync(path.join(dir, 'playbooks'))
  fs.writeFileSync(path.join(dir, 'playbooks', 'feature-branch.md'), '# playbook 全文\n')
  return { repoRoot: dir, worktreePath: path.join(dir, 'worktree'), playbooksDir: path.join(dir, 'playbooks') }
}

/** planner/propose prompt 读 repoRoot 的 AGENTS.md：临时目录先落一份再作 repoRoot 用。 */
function agentsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agents-'))
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 测试 AGENTS\n\n端口红线。\n')
  return dir
}

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}, body = '', plan = '') {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }, body, plan))
  runOrch(repo, `submit "${cardFile}"`)
}

describe('predeparture B1 航次计划段 > parseCard 五段化', () => {
  it('五段卡：plan 段解析进 body.plan，不并入 background', () => {
    const { meta, body } = parseCard(cardText({ id: 'planned' }, '测试目标。', PLAN), 'card.md')
    expect(meta.id).toBe('planned')
    expect(body.goal).toBe('测试目标。')
    expect(body.plan).toBe(PLAN)
    expect(body.background).not.toContain('航次计划')
  })

  it('四段旧卡：plan 为空串（完全兼容），未知段仍并入 background', () => {
    const legacy = cardText().replace('# 验收标准', '# 备注\n历史线索。\n\n# 验收标准')
    const { body } = parseCard(legacy, 'card.md')
    expect(body.plan).toBe('')
    expect(body.background).toContain('# 备注')
    expect(body.goal).toContain('测试任务目标')
  })
})

describe('predeparture B1 航次计划段 > buildWorkerPrompt 渲染', () => {
  it('plan 非空时任务层渲染航次计划段', () => {
    const card = parseCard(cardText({}, '测试目标。', PLAN), 'card.md')
    const p = buildWorkerPrompt(card as never, ctx(os.tmpdir()))
    expect(p).toContain('## 航次计划（按检查点推进；偏离航线时在 NOTES.md 说明原因）')
    expect(p).toContain('备选路线：若解析失败则按报错手修卡')
  })

  it('plan 为空（旧卡）不渲染该段', () => {
    const card = parseCard(cardText(), 'card.md')
    const p = buildWorkerPrompt(card as never, ctx(os.tmpdir()))
    expect(p).not.toContain('## 航次计划')
  })
})

describe('predeparture B1 航次计划段 > planner/propose 产出契约', () => {
  it('planner 契约要求卡含 # 航次计划（3-6 检查点 + 备选路线）', () => {
    const p = buildPlannerPrompt('修一下预预设合并', agentsDir())
    expect(p).toContain('# 航次计划')
    expect(p).toContain('3-6 个检查点')
    expect(p).toContain('备选路线：若 X 不通则 Y')
  })

  it('propose 契约同样要求航次计划段', () => {
    const p = buildProposePrompt({ goals: '', signals: '', queueSummary: '', maxCards: 2, repoRoot: agentsDir() })
    expect(p).toContain('# 航次计划')
    expect(p).toContain('备选路线：若 X 不通则 Y')
  })
})

describe('predeparture B1 航次计划段 > 端到端（mock 全链不受新段影响）', () => {
  it('五段卡 submit → run --backend mock → 照常落 awaiting-human', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'planned-e2e', {}, '测试目标。', PLAN)
      const run = runOrch(repo.root, 'run planned-e2e --backend mock')
      expect(run.stdout).toContain('awaiting-human')
      expect(readCard(repo.root, 'awaiting-human', 'planned-e2e')).toBeTruthy()
      expect(eventsOf(repo.root, 'planned-e2e').map((e) => e.type)).toContain('worker_done')
    } finally {
      repo.cleanup()
    }
  })
})

describe('predeparture B2 复诵协议 > 纪律层第 0 条', () => {
  it('worker prompt 含复诵要求，且位于结束纪律首条（先于第 1 条）', () => {
    const card = parseCard(cardText({}, '测试目标。', PLAN), 'card.md')
    const p = buildWorkerPrompt(card as never, ctx(os.tmpdir()))
    expect(p).toContain('把托运单**复诵**进 NOTES.md')
    expect(p).toContain('复诵即承诺')
    const discipline = p.slice(p.indexOf('# 结束纪律'))
    const repeat = discipline.indexOf('0. 开工第一件事')
    const first = discipline.indexOf('1. 报告 done 之前')
    expect(repeat).toBeGreaterThan(-1)
    expect(first).toBeGreaterThan(repeat) // 第 0 条在最前
  })
})

describe('predeparture B3 引水闸 > run 拦截与放行', () => {
  it('files_hint 命中核心路径：无 flag 拒绝开航，事件 pilotage_required，卡留 pending', () => {
    const repo = mkRepo({ extra: { corePaths: ['src/gateway/server.ts'] } })
    try {
      submitCard(repo.root, 'pilot-hint', { files_hint: ['src/gateway/server.ts'] })
      const r = tryOrch(repo.root, 'run pilot-hint --backend mock')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('--pilot-approved')
      expect(eventsOf(repo.root, 'pilot-hint').map((e) => e.type)).toContain('pilotage_required')
      expect(readCard(repo.root, 'pending', 'pilot-hint')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('type: deps 卡同样拦截', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'dep-voyage', { type: 'deps', files_hint: ['docs/**'] })
      const r = tryOrch(repo.root, 'run dep-voyage --backend mock')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('--pilot-approved')
      expect(eventsOf(repo.root, 'dep-voyage').map((e) => e.type)).toContain('pilotage_required')
    } finally {
      repo.cleanup()
    }
  })

  it('--pilot-approved 放行：正常闭环落 awaiting-human', () => {
    const repo = mkRepo({ extra: { corePaths: ['src/gateway/server.ts'] } })
    try {
      submitCard(repo.root, 'pilot-ok', { files_hint: ['src/gateway/server.ts'] })
      const run = runOrch(repo.root, 'run pilot-ok --pilot-approved --backend mock')
      expect(run.stdout).toContain('awaiting-human')
      expect(readCard(repo.root, 'awaiting-human', 'pilot-ok')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })
})

describe('predeparture B3 引水闸 > drain 跳过不派发', () => {
  it('引水卡被跳过：输出待引水清单，队列不动，无 logs 目录', () => {
    const repo = mkRepo({ extra: { corePaths: ['src/gateway/server.ts'] } })
    try {
      submitCard(repo.root, 'pilot-drain', { files_hint: ['src/gateway/server.ts'] })
      const out = runOrch(repo.root, 'drain --backend mock')
      expect(out.stdout).toContain('待引水')
      expect(out.stdout).toContain('pilot-drain --pilot-approved')
      expect(out.stdout).not.toContain('队列已清空')
      expect(readCard(repo.root, 'pending', 'pilot-drain')).toBeTruthy()
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'pilot-drain'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('普通卡与引水卡混队：普通卡照跑，引水卡列清单', () => {
    const repo = mkRepo({ extra: { corePaths: ['src/gateway/server.ts'] } })
    try {
      submitCard(repo.root, 'plain-run')
      submitCard(repo.root, 'held-pilot', { files_hint: ['src/gateway/server.ts'] })
      const out = runOrch(repo.root, 'drain --backend mock')
      expect(out.stdout).toContain('待引水')
      expect(readCard(repo.root, 'awaiting-human', 'plain-run')).toBeTruthy()
      expect(readCard(repo.root, 'pending', 'held-pilot')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('pickNextCard skipIds：跳过指定 id，全跳返回 null', () => {
    const repo = mkRepo()
    try {
      const root = queueRoot(repo.root)
      ensureQueue(root)
      fs.writeFileSync(path.join(root, 'pending', 'a-low.md'), cardText({ id: 'a-low', priority: 'low' }))
      fs.writeFileSync(path.join(root, 'pending', 'b-high.md'), cardText({ id: 'b-high', priority: 'high' }))
      expect(pickNextCard(root)?.id).toBe('b-high')
      expect(pickNextCard(root, { skipIds: new Set(['b-high']) })?.id).toBe('a-low')
      expect(pickNextCard(root, { skipIds: new Set(['a-low', 'b-high']) })).toBeNull()
    } finally {
      repo.cleanup()
    }
  })
})

describe('predeparture B8 交接班单 > NOTES 模板与 resume 恢复', () => {
  it('feature-branch start 写入的 NOTES.md 含交接班四要素段', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'voyage')
      runOrch(repo.root, 'run voyage --backend mock')
      const notes = fs.readFileSync(path.join(repo.root, '.agents', 'worktrees', 'voyage', 'NOTES.md'), 'utf8')
      expect(notes).toContain('## 交接班（值班交接四要素，中断/交接前必须更新）')
      expect(notes).toContain('- 船位（已完成）：')
      expect(notes).toContain('- 航向（当前步骤）：')
      expect(notes).toContain('- 天气（阻塞点）：')
      expect(notes).toContain('- 油量（预算余量）：')
    } finally {
      repo.cleanup()
    }
  })

  it('stuck 卡 blocked 后 resume --backend mock：闭环照常恢复（交接班单注入不破链）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'relief')
      tryOrch(repo.root, 'run relief --backend mock', { ORCH_MOCK_WORKER_STATUS: 'stuck' })
      expect(readCard(repo.root, 'blocked', 'relief')).toBeTruthy()
      const r2 = runOrch(repo.root, 'resume relief --backend mock')
      expect(r2.stdout).toContain('awaiting-human')
      const types = eventsOf(repo.root, 'relief').map((e) => e.type)
      expect(types).toContain('resumed')
      expect(types).toContain('worker_done')
    } finally {
      repo.cleanup()
    }
  })
})

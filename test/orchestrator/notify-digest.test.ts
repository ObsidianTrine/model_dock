// 任务通报（按任务号为话题）纯函数用例：humanTokens / taskStateTag / buildPhaseLine /
// buildTaskDigest / buildTaskRoster / buildSailSummary 花名册。事件序列取自 2026-11-02
// 首航实卡 docs-nightly-webhook-envs 的真实事件形状（类型与字段名以此为准）。
//
// 第二族（2026-11-10 digest 聚合改造）：notify-digest.mjs 的批量聚合通报——queueDigestItem
// / aggregateDigest（同卡终态合并）/ buildDigestBody（三段式 ≤30 行）/ flushDigest（认领
// 语义 + 本地 http webhook 实发）+ e2e（mock 卡 drain → digest POST）。digest 缺省关，
// e2e 用例经 mkRepo extra 显式开且 quietWindowSec 调小（防 detached flusher 孤儿进程）。

import { describe, expect, it } from 'vitest'
import { spawn as spawnProc } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import {
  buildPhaseLine,
  buildTaskDigest,
  buildTaskRoster,
  humanTokens,
  taskStateTag,
} from '../../.agents/scripts/orchestrator/notify.mjs'
import { buildSailSummary } from '../../.agents/scripts/orchestrator/sail.mjs'
import { cardPath, ensureQueue, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'
import {
  aggregateDigest,
  buildDigestBody,
  digestFlushMarkerPath,
  digestPendingPath,
  digestStateRank,
  digestTitle,
  flushDigest,
  quietWindowSecOf,
  queueDigestItem,
} from '../../.agents/scripts/orchestrator/notify-digest.mjs'
import { cardText, mkRepo } from './helpers.js'

/** 首航实卡 docs-nightly-webhook-envs 的事件序列（省略 worker_turn/budget_snapshot 高频流）。 */
function realVoyageEvents() {
  return [
    { seq: 1, ts: 't1', type: 'budget_profile', backend: 'zcode-headless' },
    { seq: 2, ts: 't2', type: 'tier_resolved', tier: null, worker_model: 'glm-5.3-flash', review_model: 'glm-5.3-flash' },
    { seq: 3, ts: 't3', type: 'task_accepted', backend: 'zcode-headless' },
    { seq: 6, ts: 't6', type: 'worker_spawned', backend: 'zcode-headless', attempt: 0 },
    { seq: 9, ts: 't9', type: 'worker_done', summary: '.agents/docs/ai-pipeline-guide.md 通知段落补齐 AGENTS_NIGHTLY_WEBHOOK / AGENTS_ORCH_WEBHOOK 双变量、旧名兼容说明、飞书自定义关键词提醒与钥匙串防明文命令示例，docs-lint 全绿' },
    { seq: 10, ts: 't10', type: 'gate_result', gate: 'npm_test', result: 'pass', scoped: 'l0' },
    { seq: 11, ts: 't11', type: 'gate_result', gate: 'port_scan', result: 'pass' },
    { seq: 12, ts: 't12', type: 'review_verdict', blockers: 0, suggestions: 1, notes: 0 },
    { seq: 13, ts: 't13', type: 'auto_merge', level: 'L0', gate: 'L1' },
    { seq: 14, ts: 't14', type: 'merged', merge_commit: '407fae32d24c21b697775494feb250bdfa76b44b', auto: true },
    { seq: 15, ts: 't15', type: 'budget_snapshot', tokens_in: 2144339, tokens_out: 3950, elapsed_min: 6 },
  ]
}

describe('orchestrator notify digest > humanTokens', () => {
  it('百万级 M、千级 k、零/负/非数返回空串', () => {
    expect(humanTokens(2144339)).toBe('2.1M')
    expect(humanTokens(1_000_000)).toBe('1M')
    expect(humanTokens(360248)).toBe('360k')
    expect(humanTokens(999)).toBe('999')
    expect(humanTokens(0)).toBe('')
    expect(humanTokens(-5)).toBe('')
    expect(humanTokens(undefined)).toBe('')
  })
})

describe('orchestrator notify digest > taskStateTag', () => {
  it('四种落位状态有中文标签；未知状态原样兜底', () => {
    expect(taskStateTag('merged')).toBe('✅ 已出港')
    expect(taskStateTag('awaiting-human')).toBe('⏸ 待船东放行')
    expect(taskStateTag('failed')).toBe('✗ 退关')
    expect(taskStateTag('blocked')).toBe('⚠ 搁浅')
    expect(taskStateTag('running')).toBe('⚠ running')
    expect(taskStateTag(undefined)).toBe('⚠ ?')
  })
})

describe('orchestrator notify digest > buildPhaseLine', () => {
  it('真实事件序列 → 完整阶段链（派发→执行→门禁→审查→合并）', () => {
    expect(buildPhaseLine(realVoyageEvents())).toBe('zcode → 6m/2.1M tok → 门禁过 → 审查通过/1建议 → 自动合并 407fae3')
  })

  it('档位、重试、引擎升级、门禁失败、人工合并各段如实呈现', () => {
    const events = [
      { seq: 1, ts: 't', type: 'task_accepted', backend: 'zcode-headless' },
      { seq: 2, ts: 't', type: 'tier_resolved', tier: 'ahead-1' },
      { seq: 3, ts: 't', type: 'worker_spawned', attempt: 2 },
      { seq: 4, ts: 't', type: 'engine_escalated', from: 'zcode-headless', to: 'claude-headless', reason: 'prompt_oversize' },
      { seq: 5, ts: 't', type: 'budget_snapshot', tokens_in: 5000, elapsed_min: 2 },
      { seq: 6, ts: 't', type: 'gate_result', gate: 'npm_test', result: 'fail' },
      { seq: 7, ts: 't', type: 'review_verdict', blockers: 2, suggestions: 0 },
      { seq: 8, ts: 't', type: 'merged', merge_commit: 'abc1234def', auto: false },
    ]
    expect(buildPhaseLine(events)).toBe('zcode·ahead-1·重试2次 → ⏫切claude → 2m/5k tok → 门禁✗ → 审查2阻塞 → 人工合并 abc1234')
  })

  it('空事件流与缺段事件不产生空箭头', () => {
    expect(buildPhaseLine([])).toBe('')
    expect(buildPhaseLine(undefined)).toBe('')
    expect(buildPhaseLine([{ seq: 1, ts: 't', type: 'merged', merge_commit: 'abc12345678', auto: true }])).toBe('自动合并 abc1234')
  })
})

describe('orchestrator notify digest > buildTaskDigest', () => {
  it('完整数据 → 为什么/成果/过程/结果四段齐全，主题行为【任务号】+状态', () => {
    const digest = buildTaskDigest({
      taskId: 'docs-nightly-webhook-envs',
      state: 'merged',
      reason: '审查通过，自动出港',
      why: '更新 .agents/docs/ai-pipeline-guide.md「通知」段落，补齐双 webhook 变量',
      events: realVoyageEvents(),
    })
    const lines = digest.split('\n')
    expect(lines[0]).toBe('【docs-nightly-webhook-envs】✅ 已出港')
    expect(digest).toContain('为什么：更新 .agents/docs/ai-pipeline-guide.md「通知」段落')
    expect(digest).toContain('成果：.agents/docs/ai-pipeline-guide.md 通知段落补齐')
    expect(digest).toContain('过程：zcode → 6m/2.1M tok')
    expect(lines[lines.length - 1]).toBe('结果：审查通过，自动出港')
  })

  it('无事件流无目标 → 退化为【id】状态 + 结果两行（旧 buildSettleSummary 等价形态）', () => {
    expect(buildTaskDigest({ taskId: 'x', state: 'blocked', reason: '预算熔断 max_tokens' })).toBe(
      '【x】⚠ 搁浅\n结果：预算熔断 max_tokens',
    )
  })

  it('超长目标/成果按行内上限截断，不撑爆通知', () => {
    const digest = buildTaskDigest({
      taskId: 't',
      state: 'merged',
      why: '长'.repeat(120),
      events: [{ seq: 1, ts: 't', type: 'worker_done', summary: '长'.repeat(150) }],
    })
    const why = digest.split('\n').find((l) => l.startsWith('为什么：'))
    const done = digest.split('\n').find((l) => l.startsWith('成果：'))
    expect(why!.length).toBeLessThanOrEqual('为什么：'.length + 80)
    expect(done!.length).toBeLessThanOrEqual('成果：'.length + 100)
  })
})

describe('orchestrator notify digest > buildTaskRoster', () => {
  it('按任务号逐行列出状态与目标；超 max 截断注总数', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `task-${i}`, state: i % 2 ? 'merged' : 'blocked' }))
    const roster = buildTaskRoster(tasks, { max: 8, infoOf: (t) => ({ goal: `目标-${t.id}` }) })
    const lines = roster.split('\n')
    expect(lines).toHaveLength(9)
    expect(lines[0]).toBe('- 【task-0】⚠ 搁浅：目标-task-0')
    expect(lines[1]).toBe('- 【task-1】✅ 已出港：目标-task-1')
    expect(lines[8]).toBe('…共 10 张（余略）')
  })

  it('空列表返回空串；infoOf 查不到目标只列 id 与状态', () => {
    expect(buildTaskRoster([])).toBe('')
    expect(buildTaskRoster([{ id: 'a', state: 'merged' }])).toBe('- 【a】✅ 已出港')
  })
})

describe('orchestrator notify digest > buildSailSummary 花名册', () => {
  it('收帆摘要在计数行下按任务号列出落位卡与目标首行', () => {
    const repo = mkRepo()
    try {
      const root = queueRoot(repo.root)
      ensureQueue(root)
      fs.writeFileSync(cardPath(root, 'merged', 'docs-a'), cardText({ id: 'docs-a', type: 'docs' }, '补齐夜航通知文档'))
      fs.writeFileSync(cardPath(root, 'blocked', 'feat-b'), cardText({ id: 'feat-b', type: 'feature' }, '扩展 schedule 的 sail 模式'))
      const summary = buildSailSummary({
        root: repo.root,
        minutes: 5,
        actualMinutes: 7,
        dispatchedTotal: 2,
        endState: { merged: ['docs-a'], 'awaiting-human': [], blocked: ['feat-b'], failed: [], pending: [] },
      })
      expect(summary).toContain('✓ 自由航行结束')
      expect(summary).toContain('出港 1、待放行 0、搁浅/退关 1、待调度 0')
      expect(summary).toContain('- 【docs-a】✅ 已出港：补齐夜航通知文档')
      expect(summary).toContain('- 【feat-b】⚠ 搁浅：扩展 schedule 的 sail 模式')
    } finally {
      repo.cleanup()
    }
  })

  it('无落位卡时不含花名册段；root 缺失不抛错（老调用形态兼容）', () => {
    const bare = buildSailSummary({ minutes: 5, actualMinutes: 5, dispatchedTotal: 0, endState: { merged: [], 'awaiting-human': [], blocked: [], failed: [], pending: [] } })
    expect(bare).not.toContain('【')
    const noRoot = buildSailSummary({ minutes: 5, actualMinutes: 5, dispatchedTotal: 1, endState: { merged: ['x'], 'awaiting-human': [], blocked: [], failed: [], pending: [] } })
    expect(noRoot).toContain('- 【x】✅ 已出港')
  })
})

// ---------------------------------------------------------------------------
// digest 聚合通报（notify-digest.mjs，2026-11-10）：批量聚合、同卡终态合并、三段式正文。
// 纯函数单测用独立 tmp 目录（flushDigest 对缺失 workflow.json 回落缺省，无需 mkRepo）；
// e2e 走 runOrch 子进程 + 本地 http webhook（listen(0)，零 vi.mock——singleFork 纪律）。
// ---------------------------------------------------------------------------

function tmpDir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-unit-'))
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

interface WebhookPost {
  title: string
  body: string
  raw: string
}

/** 本地 webhook 收信台（listen(0) 随机端口）：实时收集 POST，127.0.0.1 端点收裸 {title,body,ts}。 */
function startWebhook(): Promise<{ url: string; posts: WebhookPost[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const posts: WebhookPost[] = []
    const srv = http.createServer((req, res) => {
      let data = ''
      req.on('data', (c: Buffer) => (data += c.toString()))
      req.on('end', () => {
        let title = ''
        let body = ''
        try {
          const j = JSON.parse(data)
          title = String(j.title ?? '')
          body = String(j.body ?? '')
        } catch {
          body = data
        }
        posts.push({ title, body, raw: data })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        posts,
        close: () => new Promise((r) => srv.close(() => r())),
      })
    })
  })
}

describe('orchestrator notify digest aggregator > 同卡终态合并', () => {
  const tsA = '2026-11-10T10:00:00.000+08:00'
  const tsB = '2026-11-10T10:06:00.000+08:00'

  it('pending→merged 只留 merged（跳过中间态），队列行注 merged(+本批)', () => {
    const body = buildDigestBody({
      items: [
        { ts: tsA, kind: 'task', taskId: 't1', state: 'pending', title: '卡 t1', lines: ['进入队列'], priority: 'normal' },
        { ts: tsB, kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1 ✅ 已出港', lines: ['审查通过，自动出港'], priority: 'normal' },
      ],
      counts: { pending: 0, running: 0, 'awaiting-human': 0, blocked: 0, merged: 1, failed: 0 },
    })
    expect(body).toContain('· 10:06 卡 t1 ✅ 已出港 审查通过，自动出港')
    expect(body).not.toContain('进入队列')
    expect(body).toContain('merged 1(+1)')
  })

  it('同状态多条（落位 + 超时自动批示）取后到者——动作说明更具体', () => {
    const agg = aggregateDigest([
      { ts: tsA, kind: 'task', taskId: 't2', state: 'merged', title: '卡 t2 ✅ 已出港', lines: ['审查通过，自动出港'], priority: 'normal' },
      { ts: tsB, kind: 'autoapprove', taskId: 't2', state: 'merged', title: '卡 t2 超时自动批示', lines: ['审查 blockers=0 且超时 3 分钟——已按推荐自动合并'], priority: 'normal' },
    ])
    expect(agg).toHaveLength(1)
    expect(agg[0].title).toBe('卡 t2 超时自动批示')
  })

  it('blocked→merged（自动续跑翻盘）只报终态 merged；无 taskId 的事件逐条保留', () => {
    const agg = aggregateDigest([
      { ts: tsA, kind: 'task', taskId: 't3', state: 'blocked', title: '卡 t3 ⚠ 搁浅', lines: ['预算熔断'], priority: 'attention' },
      { ts: tsB, kind: 'task', taskId: 't3', state: 'merged', title: '卡 t3 ✅ 已出港', lines: ['续跑成功'], priority: 'normal' },
      { ts: tsB, kind: 'research', title: '调研 r1 判定 low', lines: ['rollup low'], priority: 'normal' },
    ])
    expect(agg).toHaveLength(2)
    expect(agg.map((x) => x.title)).toEqual(['卡 t3 ✅ 已出港', '调研 r1 判定 low'])
  })

  it('digestStateRank：merged > blocked/failed > awaiting-human > reviewing > running > pending；未知 state 按优先级兜底', () => {
    expect(digestStateRank({ state: 'merged' })).toBe(5)
    expect(digestStateRank({ state: 'blocked' })).toBe(4)
    expect(digestStateRank({ state: 'failed' })).toBe(4)
    expect(digestStateRank({ state: 'awaiting-human' })).toBe(3)
    expect(digestStateRank({ state: 'reviewing' })).toBe(2)
    expect(digestStateRank({ state: 'running' })).toBe(1)
    expect(digestStateRank({ state: 'pending' })).toBe(0)
    expect(digestStateRank({ priority: 'attention' })).toBe(4)
    expect(digestStateRank({})).toBe(1)
  })
})

describe('orchestrator notify digest aggregator > buildDigestBody 三段式', () => {
  const ts = '2026-11-10T14:30:00.000+08:00'

  it('attention 事件进核心段（首条贴标签、余下缩进列出）', () => {
    const body = buildDigestBody({
      items: [
        { ts, kind: 'task', taskId: 't3', state: 'awaiting-human', title: '卡 t3 ⏸ 待船东放行', lines: ['审查返工超限'], priority: 'attention' },
        { ts, kind: 'task', taskId: 't5', state: 'blocked', title: '卡 t5 ⚠ 搁浅', lines: ['预算熔断 max_tokens'], priority: 'attention' },
      ],
      counts: { pending: 0, running: 0, 'awaiting-human': 1, blocked: 1, merged: 2, failed: 0 },
    })
    const lines = body.split('\n')
    expect(lines[0]).toBe('■ 核心：14:30 卡 t3 ⏸ 待船东放行 审查返工超限')
    expect(lines[1]).toBe('  · 14:30 卡 t5 ⚠ 搁浅 预算熔断 max_tokens')
    expect(lines[2]).toBe('■ 事件')
    expect(lines).toContain('■ 流程状态')
  })

  it('无 attention：核心是一句总结，需要动作从队列计数来（待批示/搁浅）', () => {
    const body = buildDigestBody({
      items: [{ ts, kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1 ✅ 已出港', lines: ['ok'], priority: 'normal' }],
      counts: { pending: 1, running: 2, 'awaiting-human': 1, blocked: 2, merged: 4, failed: 0 },
    })
    expect(body.split('\n')[0]).toBe('■ 核心：本批 1 事件，需要动作：待批示 1、搁浅 2')
    const noNeed = buildDigestBody({
      items: [{ ts, kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1 ✅ 已出港', lines: ['ok'], priority: 'normal' }],
      counts: { pending: 0, running: 0, 'awaiting-human': 0, blocked: 0, merged: 5, failed: 0 },
    })
    expect(noNeed.split('\n')[0]).toBe('■ 核心：本批 1 事件，无需动作')
  })

  it('事件描述截 40 字；正文整体 >30 行截 29 行 + 「…」（核心段在最前必保）', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      ts,
      kind: 'task',
      taskId: `t-${i}`,
      state: 'merged',
      title: `卡 t-${i} ✅ 已出港`,
      lines: ['长'.repeat(60)],
      priority: 'normal',
    }))
    const body = buildDigestBody({ items, counts: { pending: 0, running: 0, 'awaiting-human': 0, blocked: 0, merged: 40, failed: 0 } })
    const lines = body.split('\n')
    expect(lines).toHaveLength(30)
    expect(lines[29]).toBe('…')
    expect(lines[0]).toContain('■ 核心：')
    const evLine = lines.find((l) => l.includes('卡 t-0 '))
    expect(evLine!.length).toBeLessThanOrEqual('  · 14:30 卡 t-0 ✅ 已出港 '.length + 40)
  })

  it('规格进度行：t1 ✅merged t2 ⏳awaiting-human 紧凑记号；超 8 任务注总数', () => {
    const body = buildDigestBody({
      items: [],
      counts: { pending: 0, running: 0, 'awaiting-human': 1, blocked: 0, merged: 1, failed: 0 },
      specs: [{ id: 'spec-a', tasks: [{ n: 1, status: 'merged' }, { n: 2, status: 'awaiting-human' }] }],
    })
    expect(body).toContain('■ 流程状态')
    expect(body).toContain('规格 spec-a：t1 ✅merged t2 ⏳awaiting-human')
    const long = buildDigestBody({
      items: [],
      counts: null,
      specs: [{ id: 'spec-b', tasks: Array.from({ length: 10 }, (_, i) => ({ n: i + 1, status: 'pending' })) }],
    })
    expect(long).toContain('…共 10 个')
  })

  it('counts 缺省 null 不出队列行；空 items + 无 specs 无 counts → 只剩核心总结', () => {
    const bare = buildDigestBody({ items: [] })
    expect(bare).toBe('■ 核心：本批 0 事件，无需动作')
    expect(bare).not.toContain('■ 事件')
    expect(bare).not.toContain('■ 流程状态')
  })

  it('digestTitle：【项目名 编排通报】MM-DD HH:mm（本地时间补零）', () => {
    expect(digestTitle('Digest 港', new Date(2026, 10, 10, 14, 30))).toBe('【Digest 港 编排通报】11-10 14:30')
    expect(digestTitle('', new Date(2026, 0, 3, 9, 5))).toBe('【编排 编排通报】01-03 09:05')
  })
})

describe('orchestrator notify digest aggregator > queueDigestItem / flushDigest', () => {
  it('queueDigestItem：追加 JSONL、盖 ts 戳、priority/kind 归一、空 title 兜底', () => {
    const d = tmpDir()
    try {
      const rec = queueDigestItem(d.root, { kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1', lines: ['ok'], priority: 'attention' })
      expect(rec.ts).toBeTruthy()
      expect(rec.priority).toBe('attention')
      const junk = queueDigestItem(d.root, { kind: 42, title: '', lines: 'not-array', priority: 'zzz' } as unknown as Record<string, never>)
      expect(junk.kind).toBe('42')
      expect(junk.title).toBe('未命名事件')
      expect(junk.priority).toBe('normal')
      expect(junk.lines).toEqual([])
      const file = fs.readFileSync(digestPendingPath(d.root), 'utf8').trim().split('\n')
      expect(file).toHaveLength(2)
      expect(() => JSON.parse(file[0])).not.toThrow()
    } finally {
      d.cleanup()
    }
  })

  it('queueDigestItem 真追加：两次连续写不互覆（并发写者各留一行，2026-11-10 read-modify-write 丢事件回归）', () => {
    const d = tmpDir()
    try {
      queueDigestItem(d.root, { kind: 'task', taskId: 't1', state: 'running', title: '卡 t1 进入队列', lines: [], priority: 'normal' })
      queueDigestItem(d.root, { kind: 'task', taskId: 't2', state: 'merged', title: '卡 t2 已出港', lines: ['done'], priority: 'normal' })
      const lines = fs.readFileSync(digestPendingPath(d.root), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2)
      const recs = lines.map((l) => JSON.parse(l))
      expect(recs.map((r) => r.title)).toEqual(['卡 t1 进入队列', '卡 t2 已出港']) // 先写者不被后写者以旧快照覆盖
      expect(recs.map((r) => r.taskId)).toEqual(['t1', 't2'])
    } finally {
      d.cleanup()
    }
  })

  it('quietWindowSecOf 三态：显式 0 = 无静默窗、undefined/非法回落 60、合法域原样', () => {
    expect(quietWindowSecOf(undefined)).toBe(60)
    expect(quietWindowSecOf(0)).toBe(0) // 2026-11-10 修复：0 不再误判缺省 60
    expect(quietWindowSecOf(120)).toBe(120)
    expect(quietWindowSecOf(3600)).toBe(3600)
    expect(quietWindowSecOf(-1)).toBe(60)
    expect(quietWindowSecOf(1.5)).toBe(60)
    expect(quietWindowSecOf('x' as unknown as number)).toBe(60)
    expect(quietWindowSecOf(4000)).toBe(60)
  })

  it('空批次不发：无文件/空文件/全损坏行均 { sent:false }，不碰 webhook', async () => {
    const d = tmpDir()
    try {
      expect(await flushDigest(d.root, { dryRun: true })).toMatchObject({ sent: false, reason: 'empty' })
      fs.mkdirSync(path.dirname(digestPendingPath(d.root)), { recursive: true })
      fs.writeFileSync(digestPendingPath(d.root), '')
      expect(await flushDigest(d.root, { dryRun: true })).toMatchObject({ sent: false, reason: 'empty' })
      fs.writeFileSync(digestPendingPath(d.root), 'not-json\n')
      expect(await flushDigest(d.root, { dryRun: true })).toMatchObject({ sent: false, reason: 'empty' })
    } finally {
      d.cleanup()
    }
  })

  it('flushDigest dryRun：聚合成一条三段式正文（同卡终态合并 + 规格进度 + 队列行），发完队列清空', async () => {
    const d = tmpDir()
    try {
      queueDigestItem(d.root, { kind: 'task', taskId: 't1', state: 'pending', title: '卡 t1', lines: ['进入队列'], priority: 'normal' })
      queueDigestItem(d.root, { kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1 ✅ 已出港', lines: ['审查通过，自动出港'], priority: 'normal' })
      // 规格进度锚（flushDigest 读 specs/<id>/progress.json）
      const specDir = path.join(d.root, '.agents', 'orchestrator', 'specs', 'spec-a')
      fs.mkdirSync(specDir, { recursive: true })
      fs.writeFileSync(path.join(specDir, 'meta.json'), '{"id":"spec-a"}')
      fs.writeFileSync(path.join(specDir, 'progress.json'), JSON.stringify({ id: 'spec-a', tasks: [{ n: 1, status: 'merged' }, { n: 2, status: 'awaiting-human' }] }))
      const r = await flushDigest(d.root, { dryRun: true })
      expect(r.sent).toBe(false) // dryRun 不算实发
      expect(r.title).toContain('编排通报】')
      expect(r.body).toContain('■ 核心：本批 1 事件，无需动作')
      expect(r.body).toMatch(/· \d{2}:\d{2} 卡 t1 ✅ 已出港 审查通过，自动出港/) // HH:mm 来自 queueDigestItem 盖戳时刻
      expect(r.body).not.toContain('进入队列')
      expect(r.body).toContain('规格 spec-a：t1 ✅merged t2 ⏳awaiting-human')
      expect(r.body).toContain('队列：pending 0 · running 0 · awaiting-human 0 · blocked 0 · merged 0(+1)')
      expect(fs.existsSync(digestPendingPath(d.root))).toBe(false) // 认领语义：先清队列再发
    } finally {
      d.cleanup()
    }
  })

  it('在飞 flusher 静默窗内让位（force=false 跳过且不动队列）；force=true 照发', async () => {
    const d = tmpDir()
    try {
      queueDigestItem(d.root, { kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1', lines: [], priority: 'normal' })
      fs.mkdirSync(path.dirname(digestFlushMarkerPath(d.root)), { recursive: true })
      fs.writeFileSync(digestFlushMarkerPath(d.root), 'x')
      expect(await flushDigest(d.root, { dryRun: true, force: false, quietWindowSec: 60 })).toMatchObject({ sent: false, reason: 'inflight' })
      expect(fs.existsSync(digestPendingPath(d.root))).toBe(true) // 让位不清队列
      const r = await flushDigest(d.root, { dryRun: true, force: true })
      expect(r.body).toContain('卡 t1')
      expect(fs.existsSync(digestPendingPath(d.root))).toBe(false)
    } finally {
      d.cleanup()
    }
  })

  it('webhook 实发：本地 http 收到一条 digest POST（标题含编排通报、正文三段式）', async () => {
    const d = tmpDir()
    const hook = await startWebhook()
    const prev = process.env.AGENTS_ORCH_WEBHOOK
    process.env.AGENTS_ORCH_WEBHOOK = hook.url
    try {
      queueDigestItem(d.root, { kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1 ✅ 已出港', lines: ['审查通过，自动出港'], priority: 'normal' })
      const r = await flushDigest(d.root, { force: true })
      expect(r.sent).toBe(true)
      expect(hook.posts).toHaveLength(1)
      expect(hook.posts[0].title).toContain('编排通报】')
      expect(hook.posts[0].body).toContain('■ 事件')
      expect(hook.posts[0].body).toContain('卡 t1 ✅ 已出港')
    } finally {
      if (prev === undefined) delete process.env.AGENTS_ORCH_WEBHOOK
      else process.env.AGENTS_ORCH_WEBHOOK = prev
      await hook.close()
      d.cleanup()
    }
  })

  it('round4：无通道投递失败——事件写回 pending（不丢）+ reason=no-channel；通道恢复后重发不双发', async () => {
    const d = tmpDir()
    const prev = process.env.AGENTS_ORCH_WEBHOOK
    delete process.env.AGENTS_ORCH_WEBHOOK
    try {
      queueDigestItem(d.root, { kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1 ✅ 已出港', lines: ['审查通过，自动出港'], priority: 'normal' })
      const r1 = await flushDigest(d.root, { force: true })
      expect(r1.sent).toBe(false)
      expect(r1.reason).toBe('no-channel')
      expect(r1.count).toBe(1)
      expect(fs.existsSync(digestPendingPath(d.root))).toBe(true) // 事件已还原，不静默丢
      const hook = await startWebhook()
      try {
        process.env.AGENTS_ORCH_WEBHOOK = hook.url
        const r2 = await flushDigest(d.root, { force: true })
        expect(r2.sent).toBe(true)
        expect(hook.posts).toHaveLength(1) // 同批事件只发一次
        expect(fs.existsSync(digestPendingPath(d.root))).toBe(false)
      } finally {
        await hook.close()
      }
    } finally {
      if (prev === undefined) delete process.env.AGENTS_ORCH_WEBHOOK
      else process.env.AGENTS_ORCH_WEBHOOK = prev
      d.cleanup()
    }
  })
})

describe('orchestrator notify digest aggregator > e2e（mock 卡全链）', () => {
  // run/drain 子进程必须异步 spawn：runOrch 的 execSync 会冻结测试进程事件循环，
  // 内嵌 webhook 服务器无法应答——子进程的 notify() fetch 挂到 10s abort，POST 被排队
  // 到 execSync 返回后才处理（实测踩中）。spawn+await 让事件循环保活，webhook 即时应答。
  function runOrchAsync(repo: string, args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const orch = path.join(process.cwd(), '.agents', 'scripts', 'orchestrator.mjs')
    return new Promise((resolve, reject) => {
      const child = spawnProc(process.execPath, [orch, ...args], { cwd: repo, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (c: Buffer) => (out += c.toString()))
      child.stderr.on('data', (c: Buffer) => (err += c.toString()))
      child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }))
      child.on('error', reject)
    })
  }

  it('digest 开 + merged 卡：drain 全链 → 单条三段式 digest POST，pending.jsonl 清空', async () => {
    const hook = await startWebhook()
    const prev = process.env.AGENTS_ORCH_WEBHOOK
    process.env.AGENTS_ORCH_WEBHOOK = hook.url
    const repo = mkRepo({ extra: { projectName: 'digest-e2e', notify: { digest: { enabled: true, quietWindowSec: 1 } } } })
    try {
      const cardFile = path.join(repo.root, 'card-digest-m.md')
      fs.writeFileSync(cardFile, cardText({ id: 'digest-m', gate: 'L0', files_hint: ['docs/**'] }))
      await runOrchAsync(repo.root, ['submit', cardFile])
      // ORCH_MOCK_FILE 让 mock worker 把改动写进 files_hint（docs/**）内——否则 scope_outside
      // 落 awaiting-human（attention 即发），测不到 merged 落位的非 attention 队列路径
      const drain = await runOrchAsync(repo.root, ['drain', '--max', '1', '--backend', 'mock'], { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(drain.status).toBe(0)
      // detached flusher（quietWindowSec=1）可能晚于 drain 收官 flush 醒来：等它退出再对账
      await new Promise((r) => setTimeout(r, 2000))
      const digestPosts = hook.posts.filter((p) => p.title.includes('编排通报】'))
      expect(digestPosts).toHaveLength(1)
      expect(digestPosts[0].title).toContain('DigestE2e')
      expect(digestPosts[0].body).toContain('■ 核心：')
      expect(digestPosts[0].body).toContain('卡 digest-m ✅ 已出港')
      expect(digestPosts[0].body).toContain('■ 流程状态')
      expect(digestPosts[0].body).toContain('队列：')
      expect(fs.existsSync(digestPendingPath(repo.root))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.AGENTS_ORCH_WEBHOOK
      else process.env.AGENTS_ORCH_WEBHOOK = prev
      await hook.close()
      repo.cleanup()
    }
  }, 120_000)

  it('digest 开 + attention 卡（gate L3 → awaiting-human）：立即同步 flush，核心段带待批示', async () => {
    const hook = await startWebhook()
    const prev = process.env.AGENTS_ORCH_WEBHOOK
    process.env.AGENTS_ORCH_WEBHOOK = hook.url
    const repo = mkRepo({ extra: { projectName: 'digest-e2e', notify: { digest: { enabled: true, quietWindowSec: 60 } } } })
    try {
      const cardFile = path.join(repo.root, 'card-digest-ah.md')
      fs.writeFileSync(cardFile, cardText({ id: 'digest-ah' }))
      await runOrchAsync(repo.root, ['submit', cardFile])
      const run = await runOrchAsync(repo.root, ['run', 'digest-ah', '--backend', 'mock']) // run 子进程内 attention 即发
      expect(run.status).toBe(0)
      const digestPosts = hook.posts.filter((p) => p.title.includes('编排通报】'))
      expect(digestPosts).toHaveLength(1)
      expect(digestPosts[0].body).toContain('■ 核心：')
      expect(digestPosts[0].body).toContain('待船东放行')
      expect(fs.existsSync(digestPendingPath(repo.root))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.AGENTS_ORCH_WEBHOOK
      else process.env.AGENTS_ORCH_WEBHOOK = prev
      await hook.close()
      repo.cleanup()
    }
  }, 120_000)

  it('digest 关（缺省）：回落旧直发「任务通报」，无 digest POST、无 pending 文件', async () => {
    const hook = await startWebhook()
    const prev = process.env.AGENTS_ORCH_WEBHOOK
    process.env.AGENTS_ORCH_WEBHOOK = hook.url
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-digest-off.md')
      fs.writeFileSync(cardFile, cardText({ id: 'digest-off' }))
      await runOrchAsync(repo.root, ['submit', cardFile])
      const run = await runOrchAsync(repo.root, ['run', 'digest-off', '--backend', 'mock'])
      expect(run.status).toBe(0)
      expect(hook.posts.some((p) => p.title.includes('任务通报'))).toBe(true)
      expect(hook.posts.some((p) => p.title.includes('编排通报】'))).toBe(false)
      expect(fs.existsSync(digestPendingPath(repo.root))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.AGENTS_ORCH_WEBHOOK
      else process.env.AGENTS_ORCH_WEBHOOK = prev
      await hook.close()
      repo.cleanup()
    }
  }, 120_000)
})

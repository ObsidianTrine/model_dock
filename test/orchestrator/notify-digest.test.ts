// 任务通报（按任务号为话题）纯函数用例：humanTokens / taskStateTag / buildPhaseLine /
// buildTaskDigest / buildTaskRoster / buildSailSummary 花名册。事件序列取自 2026-11-02
// 首航实卡 docs-nightly-webhook-envs 的真实事件形状（类型与字段名以此为准）。
//
// 第二族（2026-11-10 digest 聚合改造）：notify-digest.mjs 的批量聚合通报——queueDigestItem
// / aggregateDigest（同卡终态合并）/ buildDigestBody（扁平事件流 ≤4 行，标题分诊、细节落
// last.txt）/ flushDigest（认领语义 + 本地 http webhook 实发）+ e2e（mock 卡 drain →
// digest POST）。digest 缺省关，e2e 用例经 mkRepo extra 显式开且 quietWindowSec 调小
// （防 detached flusher 孤儿进程）。

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
  digestLastPath,
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
// digest 聚合通报（notify-digest.mjs，2026-11-10）：批量聚合、同卡终态合并、扁平事件流正文。
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

  it('pending→merged 只留 merged（跳过中间态），正文一行合并终态', () => {
    const body = buildDigestBody({
      items: [
        { ts: tsA, kind: 'task', taskId: 't1', state: 'pending', title: '卡 t1', lines: ['进入队列'], priority: 'normal' },
        { ts: tsB, kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1 ✅ 已出港', lines: ['审查通过，自动出港'], priority: 'normal' },
      ],
    })
    expect(body).toBe('✅ t1 合并')
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

describe('orchestrator notify digest aggregator > buildDigestBody 扁平事件流', () => {
  it('四类行格式：attention 在前；merged 带 commit、awaiting 带 3 分钟预告、blocked 带状态标签、其余 📄 标题', () => {
    const reason = '审查返工超限，需要人工拍板是否继续返工重试一轮'
    const body = buildDigestBody({
      items: [
        { ts: '', kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1 ✅ 已出港', lines: ['审查通过，自动出港'], priority: 'normal', commit: '407fae32d24c21b697775494feb250bdfa76b44b' },
        { ts: '', kind: 'task', taskId: 't3', state: 'awaiting-human', title: '卡 t3 ⏸ 待船东放行', lines: [reason], priority: 'attention' },
        { ts: '', kind: 'task', taskId: 't5', state: 'blocked', title: '卡 t5 ⚠ 搁浅', lines: ['预算熔断 max_tokens'], priority: 'attention' },
        { ts: '', kind: 'research', title: '调研 r1 判定 low：结论可信，无需升级', lines: ['rollup low'], priority: 'normal' },
      ],
    })
    expect(body.split('\n')).toEqual([
      `⏸ t3 待批示（${reason.slice(0, 20)}）——3 分钟未批将自动合并`,
      '⛔ t5 ⚠ 搁浅（预算熔断 max_tokens）',
      '✅ t1 合并（407fae3）',
      '📄 调研 r1 判定 low：结论可信，无需升级',
    ])
  })

  it('缺数据兜底：merged 无 commit 不带括号、awaiting 无 reason 无括号；reason 截 20 字、title 截 40 字、单行 ≤50 字', () => {
    const body = buildDigestBody({
      items: [
        { ts: '', kind: 'task', taskId: 't9', state: 'blocked', title: '卡 t9', lines: ['长'.repeat(45)], priority: 'attention' },
        { ts: '', kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1 ✅ 已出港', lines: [], priority: 'normal' },
        { ts: '', kind: 'task', taskId: 't2', state: 'awaiting-human', title: '卡 t2', lines: [], priority: 'attention' },
        { ts: '', kind: 'other', title: '标'.repeat(50), lines: [], priority: 'normal' },
      ],
    })
    const lines = body.split('\n')
    expect(lines).toEqual([
      `⛔ t9 ⚠ 搁浅（${'长'.repeat(20)}）`,
      `⏸ t2 待批示——3 分钟未批将自动合并`,
      '✅ t1 合并',
      `📄 ${'标'.repeat(40)}`,
    ])
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(50)
  })

  it('超 4 行折叠：保留 attention 行 + 前 N 条 normal，余量折叠成一行「…另 N 条见详情」', () => {
    const items = [
      { ts: '', kind: 'task', taskId: 'ta', state: 'blocked', title: '卡 ta', lines: ['x'], priority: 'attention' },
      ...Array.from({ length: 7 }, (_, i) => ({ ts: '', kind: 'task', taskId: `t${i}`, state: 'merged', title: `卡 t${i}`, lines: [], priority: 'normal' })),
    ]
    const body = buildDigestBody({ items })
    const lines = body.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('⛔ ta ⚠ 搁浅（x）')
    expect(lines.slice(1, 3)).toEqual(['✅ t0 合并', '✅ t1 合并'])
    expect(lines[3]).toBe('…另 5 条见详情')
  })

  it('单行宽护栏：超 50 字截断加 …（细节落 last.txt 不丢）', () => {
    const body = buildDigestBody({
      items: [{ ts: '', kind: 'task', taskId: '长'.repeat(60), state: 'merged', title: '卡', lines: [], priority: 'normal' }],
    })
    const line = body.split('\n')[0]
    expect(line.length).toBe(50)
    expect(line.endsWith('…')).toBe(true)
  })

  it('规格尾行：本批 item 带 specId 且 specs 查得到 progress 才出（n/总 ✅）；无 specId 或无 progress 省略', () => {
    const specs = [{ id: 'spec-a', tasks: [{ n: 1, status: 'merged' }, { n: 2, status: 'awaiting-human' }] }]
    const withSpec = buildDigestBody({
      items: [{ ts: '', kind: 'spec', taskId: 's1', specId: 'spec-a', state: 'merged', title: '规格 s1', lines: [], priority: 'normal' }],
      specs,
    })
    expect(withSpec.split('\n')).toEqual(['✅ s1 合并', '📋 规格 spec-a：1/2 ✅'])
    const noSpecId = buildDigestBody({
      items: [{ ts: '', kind: 'spec', taskId: 's1', state: 'merged', title: '规格 s1', lines: [], priority: 'normal' }],
      specs,
    })
    expect(noSpecId).toBe('✅ s1 合并')
    const noProgress = buildDigestBody({ items: [{ ts: '', kind: 'other', specId: 'spec-z', title: 'x', lines: [], priority: 'normal' }], specs })
    expect(noProgress).toBe('📄 x')
  })

  it('详情行：digestDirPath 给出才出，指向 last.txt；空批次正文空串', () => {
    expect(buildDigestBody({ items: [], digestDirPath: '/r/.agents/orchestrator/notify-digest' })).toBe(
      '📄 详情：/r/.agents/orchestrator/notify-digest/last.txt',
    )
    expect(buildDigestBody({ items: [] })).toBe('')
  })
})

describe('orchestrator notify digest aggregator > digestTitle emoji 计数摘要', () => {
  it('只列非零项：✅合并 · ⏸待批 · ⛔阻塞 · 📄事件；纯 normal 批 = 📄N 事件；空批无计数段', () => {
    expect(digestTitle('ModelDock', [{ state: 'merged' }, { state: 'merged' }, { state: 'awaiting-human' }])).toBe('【ModelDock】✅2 · ⏸1')
    expect(digestTitle('M', [{ state: 'blocked' }, { state: 'failed' }, { state: 'merged' }])).toBe('【M】✅1 · ⛔2')
    expect(digestTitle('', [{ kind: 'research' }, { kind: 'spec' }, { kind: 'other' }])).toBe('【编排】📄3 事件')
    expect(digestTitle('M', [])).toBe('【M】')
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

  it('flushDigest dryRun：聚合成一条扁平通报（终态合并 + 规格尾行），队列不消费不归档（round5 修复：写回 pending）', async () => {
    const d = tmpDir()
    try {
      queueDigestItem(d.root, { kind: 'task', taskId: 't1', state: 'pending', title: '卡 t1', lines: ['进入队列'], priority: 'normal' })
      queueDigestItem(d.root, { kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1 ✅ 已出港', lines: ['审查通过，自动出港'], priority: 'normal', specId: 'spec-a' })
      // 规格进度锚（flushDigest 读 specs/<id>/progress.json）
      const specDir = path.join(d.root, '.agents', 'orchestrator', 'specs', 'spec-a')
      fs.mkdirSync(specDir, { recursive: true })
      fs.writeFileSync(path.join(specDir, 'meta.json'), '{"id":"spec-a"}')
      fs.writeFileSync(path.join(specDir, 'progress.json'), JSON.stringify({ id: 'spec-a', tasks: [{ n: 1, status: 'merged' }, { n: 2, status: 'awaiting-human' }] }))
      const r = await flushDigest(d.root, { dryRun: true })
      expect(r.sent).toBe(false) // dryRun 不算实发
      expect(r.title).toMatch(/^【.+】✅1$/) // 项目名回落 tmp 目录名派生（displayProjectName），计数摘要 ✅1
      expect(r.body.split('\n')).toEqual([
        '✅ t1 合并', // 卡事件流不存在 → 无 commit 括号
        '📋 规格 spec-a：1/2 ✅',
        `📄 详情：${path.join(d.root, '.agents', 'orchestrator', 'notify-digest')}/last.txt`,
      ])
      expect(r.body).not.toContain('进入队列')
      expect(fs.existsSync(digestPendingPath(d.root))).toBe(true) // dry-run 不消费队列：事件写回 pending（round5 修复）
      expect(fs.existsSync(digestLastPath(d.root))).toBe(false) // dry-run 不归档：last.txt 是送达通知的详情指针，预览无通知不落档
    } finally {
      d.cleanup()
    }
  })

  it('round5：dry-run 不消费队列——pending 文件仍在，随后实发同批只发一次', async () => {
    const d = tmpDir()
    const hook = await startWebhook()
    const prev = process.env.AGENTS_ORCH_WEBHOOK
    process.env.AGENTS_ORCH_WEBHOOK = hook.url
    try {
      queueDigestItem(d.root, { kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1 ✅ 已出港', lines: ['审查通过，自动出港'], priority: 'normal' })
      const dry = await flushDigest(d.root, { dryRun: true, force: true })
      expect(dry.sent).toBe(false)
      expect(dry.reason).toBe('dry-run')
      expect(fs.existsSync(digestPendingPath(d.root))).toBe(true) // 事件写回 pending，不丢
      const real = await flushDigest(d.root, { force: true }) // 同批实发
      expect(real.sent).toBe(true)
      expect(real.count).toBe(1)
      expect(hook.posts).toHaveLength(1) // 同批事件只发一次
      expect(hook.posts[0].title).toMatch(/^【.+】✅1$/) // 扁平格式：标题 emoji 计数分诊
      expect(hook.posts[0].body).toContain('✅ t1 合并')
      expect(fs.existsSync(digestPendingPath(d.root))).toBe(false) // 实发才消费（并归档 last.txt）
    } finally {
      if (prev === undefined) delete process.env.AGENTS_ORCH_WEBHOOK
      else process.env.AGENTS_ORCH_WEBHOOK = prev
      await hook.close()
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
      expect(r.body).toContain('✅ t1 合并')
      expect(fs.existsSync(digestPendingPath(d.root))).toBe(true) // dry-run 不消费队列（round5 修复：写回 pending）
    } finally {
      d.cleanup()
    }
  })

  it('webhook 实发：本地 http 收到一条 digest POST（标题 emoji 计数、正文扁平事件流）', async () => {
    const d = tmpDir()
    const hook = await startWebhook()
    const prev = process.env.AGENTS_ORCH_WEBHOOK
    process.env.AGENTS_ORCH_WEBHOOK = hook.url
    try {
      queueDigestItem(d.root, { kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1 ✅ 已出港', lines: ['审查通过，自动出港'], priority: 'normal' })
      const r = await flushDigest(d.root, { force: true })
      expect(r.sent).toBe(true)
      expect(hook.posts).toHaveLength(1)
      expect(hook.posts[0].title).toMatch(/^【.+】✅1$/) // 项目名回落 tmp 目录名派生
      expect(hook.posts[0].body.split('\n')).toEqual([
        '✅ t1 合并',
        `📄 详情：${path.join(d.root, '.agents', 'orchestrator', 'notify-digest')}/last.txt`,
      ])
    } finally {
      if (prev === undefined) delete process.env.AGENTS_ORCH_WEBHOOK
      else process.env.AGENTS_ORCH_WEBHOOK = prev
      await hook.close()
      d.cleanup()
    }
  })

  it('flushDigest 为 merged 行补 commit：卡事件流最后一条 merged 事件的 merge_commit 前 7 位', async () => {
    const d = tmpDir()
    try {
      queueDigestItem(d.root, { kind: 'task', taskId: 't1', state: 'merged', title: '卡 t1', lines: [], priority: 'normal' })
      const log = path.join(d.root, '.agents', 'orchestrator', 'logs', 't1')
      fs.mkdirSync(log, { recursive: true })
      fs.writeFileSync(
        path.join(log, 'events.jsonl'),
        `${JSON.stringify({ seq: 1, ts: 't', type: 'merged', merge_commit: '407fae32d24c21b697775494feb250bdfa76b44b' })}\n`,
      )
      const r = await flushDigest(d.root, { dryRun: true })
      expect(r.body).toContain('✅ t1 合并（407fae3）')
    } finally {
      d.cleanup()
    }
  })

  it('round4：无通道投递失败——事件写回 pending（不丢）+ reason=no-channel；通道恢复后重发不双发', async () => {
    const d = tmpDir()
    const prev = process.env.AGENTS_ORCH_WEBHOOK
    const prevPath = process.env.PATH
    delete process.env.AGENTS_ORCH_WEBHOOK
    // 无通道前提要在本机成立：PATH 清空让钥匙串兜底（security）与 macOS osascript 通道
    // 双双 ENOENT——否则登录会话里 osascript 投递成功，delivered 非空（2026-11-10 本机实测踩中）
    process.env.PATH = ''
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
        process.env.PATH = prevPath
        const r2 = await flushDigest(d.root, { force: true })
        expect(r2.sent).toBe(true)
        expect(hook.posts).toHaveLength(1) // 同批事件只发一次
        expect(fs.existsSync(digestPendingPath(d.root))).toBe(false)
      } finally {
        await hook.close()
      }
    } finally {
      process.env.PATH = prevPath
      if (prev === undefined) delete process.env.AGENTS_ORCH_WEBHOOK
      else process.env.AGENTS_ORCH_WEBHOOK = prev
      if (prevPath === undefined) delete process.env.PATH
      else process.env.PATH = prevPath
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

  it('digest 开 + merged 卡：drain 全链 → 单条扁平 digest POST，pending.jsonl 清空、last.txt 归档', async () => {
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
      const digestPosts = hook.posts.filter((p) => p.title.startsWith('【DigestE2e】'))
      expect(digestPosts).toHaveLength(1)
      expect(digestPosts[0].title).toBe('【DigestE2e】✅1')
      expect(digestPosts[0].body).toContain('✅ digest-m 合并')
      expect(digestPosts[0].body).toContain('📄 详情：')
      expect(fs.existsSync(digestPendingPath(repo.root))).toBe(false)
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'notify-digest', 'last.txt'))).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.AGENTS_ORCH_WEBHOOK
      else process.env.AGENTS_ORCH_WEBHOOK = prev
      await hook.close()
      repo.cleanup()
    }
  }, 120_000)

  it('digest 开 + attention 卡（gate L3 → awaiting-human）：立即同步 flush，正文带待批示行', async () => {
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
      const digestPosts = hook.posts.filter((p) => p.title.startsWith('【DigestE2e】'))
      expect(digestPosts).toHaveLength(1)
      expect(digestPosts[0].title).toBe('【DigestE2e】⏸1')
      expect(digestPosts[0].body).toContain('⏸ digest-ah 待批示')
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
      expect(hook.posts.some((p) => p.title.startsWith('【'))).toBe(false) // digest 关：无聚合通报（分诊标题以【项目名】开头）
      expect(fs.existsSync(digestPendingPath(repo.root))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.AGENTS_ORCH_WEBHOOK
      else process.env.AGENTS_ORCH_WEBHOOK = prev
      await hook.close()
      repo.cleanup()
    }
  }, 120_000)
})

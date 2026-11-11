// 双向批示（approval listener）测试：卡片构造纯函数 / 飞书回调处理（challenge、验签、
// 白名单、幂等窗口、approve/reject 落地 mock spawn、审计）/ HTTP 层（随机端口 listen(0)，
// 测完 close）。绝不真发 webhook、绝不真跑 orchestrator 动作（spawnFn mock）、
// 绝不监听写死端口；token 测试 env 用完即还原。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ACTION_WHITELIST,
  DEFAULT_REJECT_REASON,
  IDEMPOTENCY_WINDOW_MS,
  approvalsAuditPath,
  buildActionArgs,
  extractToken,
  makeHandler,
  parseCardAction,
  startApprovalListener,
  verifyToken,
} from '../../.agents/scripts/approval-listener.mjs'
import { notifyActionCard, isFeishuWebhook, buildInteractiveCard } from '../../.agents/scripts/orchestrator/notify.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'

const TOKEN = 'test-verification-token'

function mkRepo(workflow: Record<string, unknown> = {}): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-lsn-'))
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true })
  fs.writeFileSync(path.join(root, '.agents', 'workflow.json'), JSON.stringify(workflow))
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** v2 形态卡片回调体（飞书开放平台现行 schema）。 */
function v2Body(value: Record<string, unknown>, token: string = TOKEN) {
  return { schema: '2.0', header: { event_type: 'card.action.trigger', token }, event: { action: { tag: 'button', value } } }
}

function readAudit(auditPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(auditPath)) return []
  return fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
}

// ---------------------------------------------------------------------------
// 卡片构造（纯函数，不发网）
// ---------------------------------------------------------------------------

describe('approval listener > buildInteractiveCard', () => {
  it('awaiting-human 卡：msg_type interactive + approve/reject 按钮 value 携带 { task, action }', () => {
    const card = JSON.parse(buildInteractiveCard({ title: 'ModelDock 待批示', taskId: 'demo-task', reason: '⏸ 待船东放行：审查通过' })) as any
    expect(card.msg_type).toBe('interactive')
    expect(card.card.header.title.content).toBe('ModelDock 待批示')
    expect(card.card.elements.at(-1).tag).toBe('action')
    const buttons = card.card.elements.at(-1).actions
    expect(buttons.map((b: any) => b.value)).toEqual([
      { task: 'demo-task', action: 'approve' },
      { task: 'demo-task', action: 'reject' },
    ])
    expect(buttons.map((b: any) => b.text.content)).toEqual(['✅ 批准合并', '❌ 驳回'])
  })

  it('fleet 级事件（taskId 缺省）不出按钮行——weather_hold 没有可批示的单卡', () => {
    const card = JSON.parse(buildInteractiveCard({ title: '风暴滞留', taskId: null, reason: '瞬时重试超阈' })) as any
    expect(card.msg_type).toBe('interactive')
    expect(card.card.elements.some((e: any) => e.tag === 'action')).toBe(false)
    expect(card.card.elements[0].text.content).toContain('瞬时重试超阈')
  })

  it('actions 白名单子集：retry 可带出、白名单外被过滤', () => {
    const card = JSON.parse(buildInteractiveCard({ title: 't', taskId: 'x', actions: ['retry', 'deploy'] })) as any
    expect(card.card.elements.at(-1).actions.map((b: any) => b.value.action)).toEqual(['retry'])
  })

  it('reason 超长截断、无 reason 无任务时输出空元素卡（不抛错）', () => {
    const card = JSON.parse(buildInteractiveCard({ title: 't', taskId: '', reason: 'r'.repeat(400) })) as any
    expect(card.card.elements[0].text.content.length).toBeLessThanOrEqual(300)
    const empty = JSON.parse(buildInteractiveCard({ title: 't' })) as any
    expect(empty.card.elements).toEqual([])
  })
})

describe('approval listener > isFeishuWebhook', () => {
  it('飞书 / larksuite 命中；企业微信 / Slack / 自建端点不命中', () => {
    expect(isFeishuWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/xxx')).toBe(true)
    expect(isFeishuWebhook('https://open.larksuite.com/open-apis/bot/v2/hook/xxx')).toBe(true)
    expect(isFeishuWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x')).toBe(false)
    expect(isFeishuWebhook('https://hooks.slack.com/services/x')).toBe(false)
    expect(isFeishuWebhook('https://example.com/hook')).toBe(false)
    expect(isFeishuWebhook(undefined)).toBe(false)
  })
})

describe('approval listener > notifyActionCard（dryRun，不发真网）', () => {
  it('cardWebhook 未开启（缺省）→ 直接短路不构造不发', async () => {
    const repo = mkRepo()
    try {
      process.env.TEST_CARD_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx'
      const r = await notifyActionCard({ repoRoot: repo.root, webhookEnvs: ['TEST_CARD_WEBHOOK'], taskId: 't', title: 'x', dryRun: true })
      expect(r.sent).toBe(false)
      expect((r as any).payload).toBeUndefined()
    } finally {
      delete process.env.TEST_CARD_WEBHOOK
      repo.cleanup()
    }
  })

  it('cardWebhook 开启 + 飞书端点 → dryRun 返回卡片 payload（含按钮 value）', async () => {
    const repo = mkRepo({ notify: { cardWebhook: true } })
    try {
      process.env.TEST_CARD_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx'
      const r = (await notifyActionCard({ repoRoot: repo.root, webhookEnvs: ['TEST_CARD_WEBHOOK'], taskId: 'demo', title: '待批示', reason: '审查通过', dryRun: true })) as any
      expect(r.dryRun).toBe(true)
      const card = JSON.parse(r.payload)
      expect(card.msg_type).toBe('interactive')
      expect(card.card.elements.at(-1).actions.map((b: any) => b.value.action)).toEqual(['approve', 'reject'])
    } finally {
      delete process.env.TEST_CARD_WEBHOOK
      repo.cleanup()
    }
  })

  it('cardWebhook 开启 + 非飞书端点 → 跳过发卡（不发废格式）', async () => {
    const repo = mkRepo({ notify: { cardWebhook: true } })
    try {
      process.env.TEST_CARD_WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'
      const r = await notifyActionCard({ repoRoot: repo.root, webhookEnvs: ['TEST_CARD_WEBHOOK'], taskId: 't', title: 'x', dryRun: true })
      expect(r.sent).toBe(false)
      expect((r as any).payload).toBeUndefined()
    } finally {
      delete process.env.TEST_CARD_WEBHOOK
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 回调解析与验签
// ---------------------------------------------------------------------------

describe('approval listener > parseCardAction / extractToken / verifyToken', () => {
  it('v2 与旧版两种形态都能提取动作；缺字段返回 null', () => {
    expect(parseCardAction(v2Body({ task: 'a', action: 'approve' }))).toEqual({ task: 'a', action: 'approve' })
    expect(parseCardAction({ token: TOKEN, action: { value: { task: 'a', action: 'reject', reason: '不行' } } })).toEqual({ task: 'a', action: 'reject', reason: '不行' })
    expect(parseCardAction({})).toBeNull()
    expect(parseCardAction(v2Body({ task: '', action: 'approve' }))).toBeNull()
    expect(parseCardAction(v2Body({ task: 'a' }))).toBeNull()
    expect(parseCardAction(null as any)).toBeNull()
  })

  it('token 提取：v2 header.token / 旧版顶层 token；verifyToken 三态', () => {
    expect(extractToken(v2Body({}, TOKEN))).toBe(TOKEN)
    expect(extractToken({ token: 'legacy' })).toBe('legacy')
    expect(extractToken({})).toBe('')
    expect(verifyToken(v2Body({}, TOKEN), TOKEN)).toEqual({ ok: true })
    expect(verifyToken(v2Body({}, 'wrong'), TOKEN)).toEqual({ ok: false, code: 'mismatch' })
    expect(verifyToken(v2Body({}, TOKEN), '')).toEqual({ ok: false, code: 'missing_env' })
    expect(verifyToken({ header: {} }, undefined)).toEqual({ ok: false, code: 'missing_env' })
  })
})

describe('approval listener > safeEqual（常数时间比较，C13）', () => {
  it('等值 true（含空串对空串）；不等值 false；长度不等不短路也不抛错', async () => {
    const { safeEqual } = await import('../../.agents/scripts/approval-listener.mjs')
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('', '')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false) // 长度泄漏面已由 sha256 归一化消除
    expect(safeEqual('abc', '')).toBe(false)
    expect(safeEqual(undefined as any, 'x')).toBe(false)
  })
})

describe('approval listener > buildActionArgs', () => {
  it('reject 带 --reason（无 reason 用默认文案）；approve/retry 不带文案参数', () => {
    expect(buildActionArgs('approve', 't')).toEqual(['approve', 't'])
    expect(buildActionArgs('reject', 't', '理由')).toEqual(['reject', 't', '--reason', '理由'])
    expect(buildActionArgs('reject', 't', '')).toEqual(['reject', 't', '--reason', DEFAULT_REJECT_REASON])
    expect(buildActionArgs('retry', 't')).toEqual(['retry', 't'])
  })
})

// ---------------------------------------------------------------------------
// 回调处理器（mock spawn + 临时审计目录）
// ---------------------------------------------------------------------------

function mkHandler(repoRoot: string, opts: { spawnFn?: any; now?: () => number } = {}) {
  const auditPath = path.join(os.tmpdir(), `approval-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  const handle = makeHandler({ repoRoot, spawnFn: opts.spawnFn, auditPath, now: opts.now })
  return { handle, auditPath, cleanup: () => fs.rmSync(auditPath, { force: true }) }
}

describe('approval listener > makeHandler（回调处理）', () => {
  it('url_verification：challenge 直接回显（验签前握手无动作风险）', async () => {
    const repo = mkRepo()
    const h = mkHandler(repo.root)
    try {
      const r = await h.handle({ type: 'url_verification', challenge: 'abc123', token: 'whatever' })
      expect(r.status).toBe(200)
      expect((r.body as any).challenge).toBe('abc123')
    } finally {
      h.cleanup()
      repo.cleanup()
    }
  })

  it('env 未配 token：拒绝所有动作并提示配置（403）', async () => {
    const repo = mkRepo()
    const h = mkHandler(repo.root)
    try {
      const saved = process.env.AGENTS_LARK_VERIFICATION_TOKEN
      delete process.env.AGENTS_LARK_VERIFICATION_TOKEN
      try {
        const r = await h.handle(v2Body({ task: 't', action: 'approve' }))
        expect(r.status).toBe(403)
        expect(JSON.stringify(r.body)).toContain('AGENTS_LARK_VERIFICATION_TOKEN')
      } finally {
        if (saved !== undefined) process.env.AGENTS_LARK_VERIFICATION_TOKEN = saved
      }
    } finally {
      h.cleanup()
      repo.cleanup()
    }
  })

  it('token 不一致：403 + 审计留痕（只记事实不记 token 值）+ 不 spawn', async () => {
    const repo = mkRepo()
    let spawned = 0
    const h = mkHandler(repo.root, { spawnFn: () => { spawned++; return { status: 0 } } })
    try {
      process.env.AGENTS_LARK_VERIFICATION_TOKEN = TOKEN
      const r = await h.handle(v2Body({ task: 't', action: 'approve' }, 'wrong-token'))
      expect(r.status).toBe(403)
      expect(spawned).toBe(0)
      // C13：不匹配拒绝并落审计（审计事实：来源 IP + rejected + 原因），token 值不落盘
      const audit = readAudit(h.auditPath)
      expect(audit).toHaveLength(1)
      expect(audit[0].result).toBe('rejected')
      expect(audit[0].detail).toBe('verification_token_mismatch')
      expect(JSON.stringify(audit)).not.toContain('wrong-token')
      expect(JSON.stringify(audit)).not.toContain(TOKEN)
      // 且回复里绝不回显收到的 token
      expect(JSON.stringify(r.body)).not.toContain('wrong-token')
    } finally {
      delete process.env.AGENTS_LARK_VERIFICATION_TOKEN
      h.cleanup()
      repo.cleanup()
    }
  })

  it('approve 落地：spawn node + orchestrator.mjs + 白名单动作、回复成功文案、审计 ok', async () => {
    const repo = mkRepo()
    const calls: Array<{ script: string; args: string[]; cwd: string }> = []
    const h = mkHandler(repo.root, {
      spawnFn: (scriptSegments: string[], args: string[], opts: { repoRoot: string }) => {
        calls.push({ script: path.join(opts.repoRoot, ...scriptSegments), args, cwd: opts.repoRoot })
        return { status: 0 }
      },
    })
    try {
      process.env.AGENTS_LARK_VERIFICATION_TOKEN = TOKEN
      const r = await h.handle(v2Body({ task: 'fix-gate', action: 'approve' }), '127.0.0.1:9')
      expect(r.status).toBe(200)
      expect((r.body as any).toast.content).toBe('✅ 已批准合并 fix-gate')
      expect(calls).toHaveLength(1)
      expect(calls[0].script).toBe(path.join(repo.root, '.agents', 'scripts', 'orchestrator.mjs'))
      expect(calls[0].args).toEqual(['approve', 'fix-gate'])
      expect(calls[0].cwd).toBe(repo.root)
      const audit = readAudit(h.auditPath)
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ task: 'fix-gate', action: 'approve', ip: '127.0.0.1:9', result: 'ok', exit: 0 })
      expect(typeof audit[0].ts).toBe('string')
    } finally {
      delete process.env.AGENTS_LARK_VERIFICATION_TOKEN
      h.cleanup()
      repo.cleanup()
    }
  })

  it('reject 落地：默认文案进 --reason、回复 ❌ 已驳回；value.reason 存在时透传', async () => {
    const repo = mkRepo()
    const calls: string[][] = []
    const h = mkHandler(repo.root, {
      spawnFn: (_s: string[], args: string[]) => { calls.push(args); return { status: 0 } },
    })
    try {
      process.env.AGENTS_LARK_VERIFICATION_TOKEN = TOKEN
      const r1 = await h.handle(v2Body({ task: 't1', action: 'reject' }))
      expect((r1.body as any).toast.content).toBe(`❌ 已驳回：${DEFAULT_REJECT_REASON}`)
      expect(calls[0]).toEqual(['reject', 't1', '--reason', DEFAULT_REJECT_REASON])
      const r2 = await h.handle(v2Body({ task: 't2', action: 'reject', reason: '验收标准不可测' }))
      expect((r2.body as any).toast.content).toBe('❌ 已驳回：验收标准不可测')
      expect(calls[1]).toEqual(['reject', 't2', '--reason', '验收标准不可测'])
    } finally {
      delete process.env.AGENTS_LARK_VERIFICATION_TOKEN
      h.cleanup()
      repo.cleanup()
    }
  })

  it('白名单外动作：403 + 审计 rejected + 不 spawn', async () => {
    const repo = mkRepo()
    let spawned = 0
    const h = mkHandler(repo.root, { spawnFn: () => { spawned++; return { status: 0 } } })
    try {
      process.env.AGENTS_LARK_VERIFICATION_TOKEN = TOKEN
      const r = await h.handle(v2Body({ task: 't', action: 'deploy' }))
      expect(r.status).toBe(403)
      expect(spawned).toBe(0)
      expect(readAudit(h.auditPath)[0]).toMatchObject({ task: 't', action: 'deploy', result: 'rejected' })
    } finally {
      delete process.env.AGENTS_LARK_VERIFICATION_TOKEN
      h.cleanup()
      repo.cleanup()
    }
  })

  it('幂等窗口：60s 内同 task 同 action 重复请求忽略（spawn 一次、审计 duplicate）', async () => {
    const repo = mkRepo()
    let spawned = 0
    let tick = 1_000_000
    const h = mkHandler(repo.root, { spawnFn: () => { spawned++; return { status: 0 } }, now: () => (tick += 1000) })
    try {
      process.env.AGENTS_LARK_VERIFICATION_TOKEN = TOKEN
      const r1 = await h.handle(v2Body({ task: 't', action: 'approve' }))
      const r2 = await h.handle(v2Body({ task: 't', action: 'approve' }))
      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      expect((r2.body as any).toast.content).toContain('忽略重复点击')
      expect(spawned).toBe(1)
      const audit = readAudit(h.auditPath)
      expect(audit.map((a) => a.result)).toEqual(['ok', 'duplicate'])
      // 不同动作 / 不同任务互不影响窗口
      const r3 = await h.handle(v2Body({ task: 't', action: 'reject' }))
      const r4 = await h.handle(v2Body({ task: 'other', action: 'approve' }))
      expect((r3.body as any).toast.content).toContain('已驳回')
      expect((r4.body as any).toast.content).toContain('已批准')
      expect(spawned).toBe(3)
      // 窗口滑过（+60s）后同 task 同 action 可再次受理
      tick += IDEMPOTENCY_WINDOW_MS
      const r5 = await h.handle(v2Body({ task: 't', action: 'approve' }))
      expect((r5.body as any).toast.content).toContain('已批准')
      expect(spawned).toBe(4)
    } finally {
      delete process.env.AGENTS_LARK_VERIFICATION_TOKEN
      h.cleanup()
      repo.cleanup()
    }
  })

  it('spawn 失败（exit 非 0）：回复可操作错误（附输出尾部与排查指引）、审计 error', async () => {
    const repo = mkRepo()
    const h = mkHandler(repo.root, {
      spawnFn: () => ({ status: 1, stderr: `任务 "t" 状态为 blocked，只有 awaiting-human 可 approve。` }),
    })
    try {
      process.env.AGENTS_LARK_VERIFICATION_TOKEN = TOKEN
      const r = await h.handle(v2Body({ task: 't', action: 'approve' }))
      expect(r.status).toBe(200)
      const content = (r.body as any).toast.content
      expect(content).toContain('失败')
      expect(content).toContain('只有 awaiting-human 可 approve')
      expect(content).toContain(`status t`)
      expect(readAudit(h.auditPath)[0]).toMatchObject({ result: 'error', exit: 1 })
    } finally {
      delete process.env.AGENTS_LARK_VERIFICATION_TOKEN
      h.cleanup()
      repo.cleanup()
    }
  })

  it('spawn 挂死被超时终止（killed）：提示后台可能仍在执行、勿连点', async () => {
    const repo = mkRepo()
    const h = mkHandler(repo.root, {
      spawnFn: () => ({ status: null, killed: true, error: Object.assign(new Error('spawn timed out'), { code: 'ETIMEDOUT' }) }),
    })
    try {
      process.env.AGENTS_LARK_VERIFICATION_TOKEN = TOKEN
      const r = await h.handle(v2Body({ task: 't', action: 'approve' }))
      expect(JSON.stringify(r.body)).toContain('等待超时')
      expect(JSON.stringify(r.body)).toContain('status t')
      expect(readAudit(h.auditPath)[0]).toMatchObject({ result: 'timeout' })
    } finally {
      delete process.env.AGENTS_LARK_VERIFICATION_TOKEN
      h.cleanup()
      repo.cleanup()
    }
  })

  it('解析不出动作（value 结构缺失）：400 + 提示按钮 value 约定', async () => {
    const repo = mkRepo()
    const h = mkHandler(repo.root)
    try {
      process.env.AGENTS_LARK_VERIFICATION_TOKEN = TOKEN
      const r = await h.handle({ schema: '2.0', header: { token: TOKEN }, event: { action: {} } })
      expect(r.status).toBe(400)
      expect(JSON.stringify(r.body)).toContain('task')
    } finally {
      delete process.env.AGENTS_LARK_VERIFICATION_TOKEN
      h.cleanup()
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// HTTP 层（随机端口 listen(0)，只绑 127.0.0.1，测完 close）
// ---------------------------------------------------------------------------

async function listenRandom(server: import('node:http').Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  return typeof addr === 'object' && addr ? addr.port : 0
}

function post(port: number, body: unknown) {
  return fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
}

describe('approval listener > HTTP 层', () => {
  it('challenge 握手、动作回调走 handler、GET 405、坏 JSON 400；只绑回环', async () => {
    const repo = mkRepo()
    let handled = 0
    const handler = async (body: any) => {
      handled++
      if (body?.type === 'url_verification') return { status: 200, body: { challenge: body.challenge } }
      return { status: 200, body: { toast: { type: 'success', content: '✅ 已批准合并 demo' } } }
    }
    const server = startApprovalListener({ repoRoot: repo.root, handler })
    let port = 0
    try {
      process.env.AGENTS_LARK_VERIFICATION_TOKEN = TOKEN
      port = await listenRandom(server)
      // challenge 握手
      const r1 = await post(port, { type: 'url_verification', challenge: 'chtok' })
      expect(r1.status).toBe(200)
      expect(await r1.json()).toEqual({ challenge: 'chtok' })
      // 动作回调（handler mock，不 spawn）
      const r2 = await post(port, v2Body({ task: 'demo', action: 'approve' }))
      expect(r2.status).toBe(200)
      expect(JSON.stringify(await r2.json())).toContain('已批准')
      expect(handled).toBe(2)
      // 非 POST 拒绝
      const r3 = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET', signal: AbortSignal.timeout(5000) })
      expect(r3.status).toBe(405)
      // 坏 JSON
      const r4 = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'not-json', signal: AbortSignal.timeout(5000) })
      expect(r4.status).toBe(400)
      // 地址只绑 127.0.0.1（回环），不是 0.0.0.0
      const addr = server.address()
      expect(typeof addr === 'object' && addr ? addr.address : '').toBe('127.0.0.1')
    } finally {
      delete process.env.AGENTS_LARK_VERIFICATION_TOKEN
      await new Promise<void>((resolve) => server.close(() => resolve()))
      repo.cleanup()
    }
  })

  it('HTTP 全链路（真实 handler + mock spawn）：token 拒绝到审计落盘', async () => {
    const repo = mkRepo()
    // 真实 handler（走验签/白名单/幂等/审计全链路），spawn mock 避免真跑 orchestrator
    const h = mkHandler(repo.root, { spawnFn: () => ({ status: 0 }) })
    const server = startApprovalListener({ repoRoot: repo.root, handler: h.handle })
    let port = 0
    try {
      process.env.AGENTS_LARK_VERIFICATION_TOKEN = TOKEN
      port = await listenRandom(server)
      // token 错 → 403
      const bad = await post(port, v2Body({ task: 't', action: 'approve' }, 'nope'))
      expect(bad.status).toBe(403)
      // token 对 → 落地 + 审计
      const ok = await post(port, v2Body({ task: 'real-task', action: 'approve' }))
      expect(ok.status).toBe(200)
      expect(JSON.stringify(await ok.json())).toContain('✅ 已批准合并 real-task')
      const audit = readAudit(h.auditPath)
      // C13：token 不匹配的未授权访问尝试也落审计（只记事实不记 token 值）——
      // 403 那笔在前（rejected/mismatch），合法批准在后
      expect(audit).toHaveLength(2)
      expect(audit[0]).toMatchObject({ result: 'rejected', detail: 'verification_token_mismatch' })
      expect(JSON.stringify(audit[0])).not.toContain('nope')
      expect(audit[1]).toMatchObject({ task: 'real-task', action: 'approve', result: 'ok' })
    } finally {
      delete process.env.AGENTS_LARK_VERIFICATION_TOKEN
      await new Promise<void>((resolve) => server.close(() => resolve()))
      h.cleanup()
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 配置解析（workflow-config notify 扩展）与审计路径
// ---------------------------------------------------------------------------

describe('approval listener > resolveNotify 扩展', () => {
  it('缺省（无 notify 键）：cardWebhook false、listenerPort null——缺省完全不启用', () => {
    const repo = mkRepo()
    try {
      const cfg = loadWorkflowConfig(repo.root)
      expect(cfg.notify.cardWebhook).toBe(false)
      expect(cfg.notify.listenerPort).toBeNull()
    } finally {
      repo.cleanup()
    }
  })

  it('显式开启与端口配置生效；非法值回落缺省并告警', () => {
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (...a: unknown[]) => { warnings.push(String(a[0])) }
    const repo = mkRepo({ notify: { cardWebhook: true, listenerPort: 18990, keychainService: 'svc' } })
    const bad = mkRepo({ notify: { cardWebhook: 'yes', listenerPort: -1 } })
    try {
      const cfg = loadWorkflowConfig(repo.root)
      expect(cfg.notify).toEqual({ keychainService: 'svc', signSecretService: null, cardWebhook: true, listenerPort: 18990, digest: { enabled: false, quietWindowSec: 60 } })
      const cfgBad = loadWorkflowConfig(bad.root)
      expect(cfgBad.notify).toEqual({ keychainService: null, signSecretService: null, cardWebhook: false, listenerPort: null, digest: { enabled: false, quietWindowSec: 60 } })
      expect(warnings.some((w) => w.includes('notify'))).toBe(true)
    } finally {
      console.warn = warn
      repo.cleanup()
      bad.cleanup()
    }
  })

  it('审计路径锚定仓库根的 .agents/orchestrator/logs/approvals.jsonl', () => {
    const repo = mkRepo()
    try {
      expect(approvalsAuditPath(repo.root)).toBe(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'approvals.jsonl'))
    } finally {
      repo.cleanup()
    }
  })

  it('白名单只含 approve/reject/retry', () => {
    expect(ACTION_WHITELIST).toEqual(['approve', 'reject', 'retry'])
  })
})

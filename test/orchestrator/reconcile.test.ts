// 狗粮对账测试：自报账 vs 网关实测账（docs 10.7）。MODELRDOCK_FAKE_HOME 重定向网关日志目录。
// 状态对账（卡状态 vs git 现实）用 mkRepo 的临时 git 仓造 merge 提交。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUsageTap } from '../../src/gateway/usage.js'
import { gatewayLogsDir, parseMergedBranchIds, readGatewayLog, reconcileAll, reconcileCardStates, reconcileTask } from '../../.agents/scripts/orchestrator/reconcile.mjs'
import { ensureQueue } from '../../.agents/scripts/orchestrator/queue.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { toIsoLocal } from '../../.agents/scripts/orchestrator/events.mjs'
import { cardText, eventsOf, git, mkRepo, runOrch } from './helpers.js'
import { fakeHome } from '../helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }, '对账测试任务'))
  runOrch(repo, `submit "${cardFile}"`)
}

/** 往 fakeHome 网关日志写一条带 usage 的成功转发请求。 */
function writeGatewayEntry(ts: string, usage: Record<string, number> | undefined, status = 200) {
  const dir = gatewayLogsDir()
  const date = ts.slice(0, 10)
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, `gateway-${date}.jsonl`), JSON.stringify({ ts, harness: 'claude-code', profile: 'orchestrator', provider: 'up', path: '/v1/messages', status, ...(usage ? { usage } : {}) }) + '\n')
}

/** 跑一个自动合并任务并返回其事件窗口（起止时间戳）。 */
function autoMergeTask(repo: string, id: string): { start: string; end: string } {
  submitCard(repo, id, { gate: 'L1', files_hint: ['docs/**'] })
  runOrch(repo, `run ${id} --backend mock`, { ORCH_MOCK_FILE: `docs/notes-${id}.md` })
  const eventsOf = (id2: string) =>
    fs
      .readFileSync(path.join(repo, '.agents', 'orchestrator', 'logs', id2, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  const evts = eventsOf(id)
  return {
    start: evts.find((e) => e.type === 'worker_spawned')?.ts,
    end: evts.find((e) => e.type === 'merged')?.ts,
  }
}

describe('gateway usage tap > 透传与兜底（usage 提取断言归 hotpath 套件）', () => {
  it('SSE 流字节原样透传', async () => {
    const { default: assert } = await import('node:assert')
    const tap = createUsageTap('text/event-stream')
    const chunks: Buffer[] = []
    tap.on('data', (c: Buffer) => chunks.push(c))
    const payload = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":2}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n'
    await new Promise<void>((resolve) => {
      tap.on('finish', resolve)
      tap.end(Buffer.from(payload))
    })
    assert.equal(Buffer.concat(chunks).toString(), payload) // 字节零改变
  })

  it('非 JSON 体不炸：usage 保持 0', async () => {
    const textTap = createUsageTap('text/plain')
    textTap.resume()
    await new Promise<void>((resolve) => {
      textTap.on('finish', resolve)
      textTap.end(Buffer.from('plain body'))
    })
    expect(textTap.getUsage().input_tokens).toBe(0)
  })
})

describe('orchestrator reconcile > 狗粮对账', () => {
  it('时间窗内的网关流量汇总 vs 自报；带缓存的合计口径', () => {
    const h = fakeHome() // 隔离真实 ~/.modeldock/logs——机器上有真实网关日志会污染计数
    const repo = mkRepo()
    try {
      const { start, end } = autoMergeTask(repo.root, 'r1')
      // 窗口内两笔：普通 + 缓存读；窗口外一笔（应排除）；失败一笔（应排除）。
      // 计算出的时间戳必须走 toIsoLocal（本地 ISO）——writeGatewayEntry 按 ts 前缀的
      // 本地日期分文件、reconcile 也按本地日期读；用 toISOString（UTC）会在本地午夜后
      // 把「窗口内」条目写进前一天的日期文件，用例只在 0 点后失败（2026-10-02 实测）。
      writeGatewayEntry(start, { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 500, cache_creation_tokens: 50 })
      const mid = toIsoLocal(new Date((new Date(start).getTime() + new Date(end).getTime()) / 2))
      writeGatewayEntry(mid, { input_tokens: 200, output_tokens: 20 })
      writeGatewayEntry(toIsoLocal(new Date(new Date(start).getTime() - 3600_000)), { input_tokens: 999999, output_tokens: 1 })
      writeGatewayEntry(end, undefined, 500)
      const r = reconcileTask(repo.root, 'r1', path.join(repo.root, '.agents', 'orchestrator', 'queue'))
      expect(r.skipped).toBe(false)
      expect(r.gateway.requests).toBe(2)
      expect(r.gateway.tokensIn).toBe(1000 + 500 + 50 + 200) // 缓存读+缓存建都计入输入
      expect(r.gateway.tokensOut).toBe(120)
      expect(r.viaGateway).toBe(true)
      expect(r.selfTotal).toBeGreaterThanOrEqual(0)
    } finally {
      repo.cleanup()
      h.restore()
    }
  })

  it('网关零流量 → viaGateway=false 警示（worker 直连上游，对账无意义）', () => {
    const h = fakeHome()
    const repo = mkRepo()
    try {
      autoMergeTask(repo.root, 'r2')
      const r = reconcileTask(repo.root, 'r2', path.join(repo.root, '.agents', 'orchestrator', 'queue'))
      expect(r.viaGateway).toBe(false)
      expect(r.gateway.requests).toBe(0)
    } finally {
      repo.cleanup()
      h.restore()
    }
  })

  it('reconcile 命令端到端：分歧降序输出；无任务提示', () => {
    const h = fakeHome()
    const repo = mkRepo()
    try {
      const empty = runOrch(repo.root, 'reconcile')
      expect(empty.stdout).toContain('尚无已合并任务可对账')
      const { start } = autoMergeTask(repo.root, 'r3')
      writeGatewayEntry(start, { input_tokens: 1, output_tokens: 1 })
      const out = runOrch(repo.root, 'reconcile')
      expect(out.stdout).toContain('已合并任务对账')
      expect(out.stdout).toContain('r3')
      expect(out.stdout).toContain('分歧')
      const one = runOrch(repo.root, 'reconcile r3')
      expect(one.stdout).toContain('r3')
    } finally {
      repo.cleanup()
      h.restore()
    }
  })
})

describe('orchestrator reconcile > 启用条件（gatewayLogDir 配置化，可移植缺省关闭）', () => {
  /** 清掉重定向 env 模拟「未启用」环境，finally 恢复。 */
  function withoutRedirectEnv<T>(fn: () => T): T {
    const savedFake = process.env.MODELRDOCK_FAKE_HOME
    const savedHome = process.env.MODELRDOCK_HOME
    delete process.env.MODELRDOCK_FAKE_HOME
    delete process.env.MODELRDOCK_HOME
    try {
      return fn()
    } finally {
      if (savedFake !== undefined) process.env.MODELRDOCK_FAKE_HOME = savedFake
      else delete process.env.MODELRDOCK_FAKE_HOME
      if (savedHome !== undefined) process.env.MODELRDOCK_HOME = savedHome
      else delete process.env.MODELRDOCK_HOME
    }
  }

  it('未配置 gatewayLogDir → 对账关闭（gatewayLogsDir null / reconcileTask skipped 可操作原因）', () => {
    const repo = mkRepo() // fixture workflow.json 无 gatewayLogDir
    try {
      withoutRedirectEnv(() => {
        expect(gatewayLogsDir(loadWorkflowConfig(repo.root))).toBeNull()
        submitCard(repo.root, 'r-off')
        runOrch(repo.root, 'run r-off --backend mock', { ORCH_MOCK_FILE: 'docs/notes-r-off.md' })
        const r = reconcileTask(repo.root, 'r-off', path.join(repo.root, '.agents', 'orchestrator', 'queue'))
        expect(r.skipped).toBe(true)
        expect(r.reason).toContain('gatewayLogDir')
        // CLI 全量路径：未启用 → 显式说明（而非误导性的「尚无已合并任务可对账」）
        const cli = runOrch(repo.root, 'reconcile')
        expect(cli.stdout).toContain('未启用网关对账')
        expect(cli.stdout).not.toContain('尚无已合并任务可对账')
      })
    } finally {
      repo.cleanup()
    }
  })

  it('显式 gatewayLogDir → 对账启用（repoRoot 锚定，env 重定向优先级更高）', () => {
    const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-logs-'))
    const repo = mkRepo()
    try {
      const wfPath = path.join(repo.root, '.agents', 'workflow.json')
      const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'))
      wf.gatewayLogDir = logs
      fs.writeFileSync(wfPath, JSON.stringify(wf))
      withoutRedirectEnv(() => {
        expect(gatewayLogsDir(loadWorkflowConfig(repo.root))).toBe(logs)
        // env 重定向永远优先（测试隔离通道不被配置抢走）
        process.env.MODELRDOCK_FAKE_HOME = path.join(os.tmpdir(), 'gw-fake-')
        try {
          expect(gatewayLogsDir(loadWorkflowConfig(repo.root))).toBe(path.join(process.env.MODELRDOCK_FAKE_HOME, '.modeldock', 'logs'))
        } finally {
          delete process.env.MODELRDOCK_FAKE_HOME
        }
      })
    } finally {
      repo.cleanup()
      fs.rmSync(logs, { recursive: true, force: true })
    }
  })
})

describe('gateway log reader > 容错', () => {
  it('崩溃半行跳过；跨日期文件读取', () => {
    const h = fakeHome()
    const repo = mkRepo()
    try {
      const dir = gatewayLogsDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, 'gateway-2026-10-01.jsonl'), '{"ts":"2026-10-01T10:00:00+08:00","status":200}\n{"broken')
      fs.appendFileSync(path.join(dir, 'gateway-2026-10-02.jsonl'), '{"ts":"2026-10-02T10:00:00+08:00","status":200}\n')
      expect(readGatewayLog(dir, '2026-10-01')).toHaveLength(1)
      expect(readGatewayLog(dir, '2026-10-02')).toHaveLength(1)
      expect(readGatewayLog(dir, '2026-10-03')).toHaveLength(0)
    } finally {
      repo.cleanup()
      h.restore()
    }
  })
})

describe('orchestrator reconcile > 状态对账（卡状态 vs git 现实）', () => {
  /** 在临时仓库里造「分支已 git 合并」的现场：feature/<id> 各一笔提交后 --no-ff 合并回 develop。 */
  function mergeFeatureBranch(repo: string, id: string, message?: string) {
    const g = (args: string) => git(repo, args)
    g(`checkout -b feature/${id}`)
    fs.writeFileSync(path.join(repo, `f-${id}.txt`), id)
    g('add -A')
    g(`commit -m "wip ${id}"`)
    g('checkout develop')
    g(`merge --no-ff feature/${id} -m ${JSON.stringify(message ?? `Merge branch 'feature/${id}'`)}`)
  }

  it('parseMergedBranchIds：容忍单双引号 / into 尾巴 / 路径分隔符；非 feature 分支不收', () => {
    const ids = parseMergedBranchIds([
      "Merge branch 'feature/abc'", // finish 默认消息
      'Merge branch "feature/def" into develop', // 双引号 + into 尾巴
      "Merge branch 'feature/spec-x-1' into develop",
      'Merge branch \'feature\\backslash-id\'', // 分隔符差异（防御性）
      "Merge branch 'develop' into feature/abc", // 反向：合并目标不是 feature 开头 → 不收
      'Merge branch ' + "'release/v1'", // 非 feature/ 前缀 → 不收
      'chore: mock worker change', // 普通提交 → 不收
      '',
    ])
    expect([...ids].sort()).toEqual(['abc', 'backslash-id', 'def', 'spec-x-1'])
  })

  it('已合并未落位（running/blocked）+ 账面合并但 git 无实证（squash/改史）双向对账', () => {
    const repo = mkRepo()
    try {
      const root = path.join(repo.root, '.agents', 'orchestrator', 'queue')
      ensureQueue(root)
      const put = (state: string, id: string) => fs.writeFileSync(path.join(root, state, `${id}.md`), cardText({ id }, '状态对账测试'))
      put('running', 'st-merged') // 分支已合并、卡滞留 running/（状态机被人工旁路）
      put('blocked', 'st-blocked') // 白名单不允许 blocked→merged，修复须走兜底 rename
      put('merged', 'st-ghost') // merged/ 但 git 无 merge 提交（squash 或改史）
      mergeFeatureBranch(repo.root, 'st-merged')
      // 双引号/into 形态的解析容错已在 parseMergedBranchIds 单测覆盖；这里用单引号 into 形态
      //（消息内嵌双引号经 cmd/sh 转义不可移植，git 沙箱只造真实会出现的形态）
      mergeFeatureBranch(repo.root, 'st-blocked', `Merge branch 'feature/st-blocked' into develop`)

      const sr = reconcileCardStates(repo.root, root)
      expect(sr.baseBranch).toBe('develop')
      expect(sr.mergedNotSettled).toHaveLength(2)
      expect(sr.mergedNotSettled).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'st-merged', state: 'running' }),
          expect.objectContaining({ id: 'st-blocked', state: 'blocked' }),
        ]),
      )
      expect(sr.settledNotMerged.map((c: { id: string }) => c.id)).toContain('st-ghost')
      // 默认只读：卡原地不动
      expect(fs.existsSync(path.join(root, 'running', 'st-merged.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('--fix-states：落位 merged/ 并写 state_reconciled 事件；白名单外状态走兜底 rename', () => {
    const repo = mkRepo()
    try {
      const root = path.join(repo.root, '.agents', 'orchestrator', 'queue')
      ensureQueue(root)
      fs.writeFileSync(path.join(root, 'running', 'st-fix.md'), cardText({ id: 'st-fix' }, '落位测试'))
      mergeFeatureBranch(repo.root, 'st-fix')

      const sr = reconcileCardStates(repo.root, root, { fix: true })
      expect(sr.fixed).toEqual(['st-fix'])
      expect(fs.existsSync(path.join(root, 'merged', 'st-fix.md'))).toBe(true)
      expect(fs.existsSync(path.join(root, 'running', 'st-fix.md'))).toBe(false)
      const evts = eventsOf(repo.root, 'st-fix')
      expect(evts.some((e) => e.type === 'state_reconciled' && e.from === 'running' && e.to === 'merged' && e.base_branch === 'develop')).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('CLI 端到端：状态对账排在用量对账之后；--fix-states 生效且幂等', () => {
    const repo = mkRepo()
    try {
      const root = path.join(repo.root, '.agents', 'orchestrator', 'queue')
      ensureQueue(root)
      fs.writeFileSync(path.join(root, 'running', 'st-cli.md'), cardText({ id: 'st-cli' }, 'CLI 端到端'))
      mergeFeatureBranch(repo.root, 'st-cli')

      const out1 = runOrch(repo.root, 'reconcile')
      expect(out1.stdout).toContain('状态对账 · 已合并未落位')
      expect(out1.stdout).toContain('st-cli')
      expect(out1.stdout).toContain('当前状态 running')
      expect(out1.stdout).toContain('--fix-states') // 只读报告给出修复指引
      // 排序约束：状态对账在用量对账（未启用说明/对账正文）之后
      expect(out1.stdout.indexOf('网关对账')).toBeLessThan(out1.stdout.indexOf('状态对账'))
      expect(fs.existsSync(path.join(root, 'running', 'st-cli.md'))).toBe(true) // 只读：卡没动

      const out2 = runOrch(repo.root, 'reconcile --fix-states')
      expect(out2.stdout).toContain('已落位')
      expect(fs.existsSync(path.join(root, 'merged', 'st-cli.md'))).toBe(true)

      const out3 = runOrch(repo.root, 'reconcile')
      expect(out3.stdout).toContain('已合并未落位：无')
    } finally {
      repo.cleanup()
    }
  })
})

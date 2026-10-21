// 狗粮对账测试：自报账 vs 网关实测账（docs 10.7）。MODELRDOCK_FAKE_HOME 重定向网关日志目录。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createUsageTap } from '../../src/gateway/usage.js'
import { gatewayLogsDir, readGatewayLog, reconcileAll, reconcileTask } from '../../.agents/scripts/orchestrator/reconcile.mjs'
import { toIsoLocal } from '../../.agents/scripts/orchestrator/events.mjs'
import { cardText, mkRepo, runOrch } from './helpers.js'
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

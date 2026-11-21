// ledger.ts — 探针独立账本（provider-probe-suite 任务 1）。
// 探针的花费绝不进真实流量请求日志/usageToday（引擎不调 logRequest，双向隔离），改记独立
// JSONL（logsDir/probe-ledger.jsonl，tag=probe）：八字段条目（probe_id/provider/key 指纹/model/
// 实际 tokens/预估 tokens/耗时/时间戳），每次上游调用一条。预算闸 = 自然月（本地时间）累计
// 实际 tokens 达 [probe].budget_tokens（缺省 50000）即硬停——读数只有本文件一个来源，与请求
// 日志零耦合，探针花费永远不会污染燃油账，反之亦然。
// 写盘走 state/logs.appendLog（util/fsx 常驻流池）；读侧先关流再读（缓冲未刷盘会漏最后几条，
// 预算闸读数错漏会直接放行超额探针）。

import fs from 'node:fs'
import path from 'node:path'
import { logsDir } from '../../util/paths.js'
import { localDateStr } from '../../util/time.js'
import { appendLog } from '../state/logs.js'
import { closeAppendStream } from '../../util/fsx.js'
import { PROBE_BUDGET_TOKENS_DEFAULT } from './registry.js'
import type { GatewayRuntime } from '../state/types.js'

export const PROBE_LEDGER_FILE = 'probe-ledger.jsonl'

export interface ProbeLedgerEntry {
  /** tag=probe：探针账本条目标记（与请求日志 LogEntry 的判别字段同思路） */
  tag: 'probe'
  probe_id: string
  provider: string
  /** sha256(key) 前 8 位十六进制（绝不含 key 明文） */
  key_fp: string
  model: string
  /** 实际 tokens（本次上游调用 usage 合计；上游未回 usage 时按 0 记——调用发生本身入账） */
  tokens: number
  /** 预估 tokens（该请求的成本档上限，registry unitTokens） */
  estimated_tokens: number
  ms: number
  ts: string
}

export function recordProbeLedgerEntry(entry: ProbeLedgerEntry): void {
  appendLog(PROBE_LEDGER_FILE, JSON.stringify(entry) + '\n')
}

function isLedgerEntry(e: unknown): e is ProbeLedgerEntry {
  const x = e as ProbeLedgerEntry
  return (
    !!x &&
    x.tag === 'probe' &&
    typeof x.probe_id === 'string' &&
    typeof x.provider === 'string' &&
    typeof x.key_fp === 'string' &&
    typeof x.model === 'string' &&
    typeof x.tokens === 'number' &&
    typeof x.estimated_tokens === 'number' &&
    typeof x.ms === 'number' &&
    typeof x.ts === 'string'
  )
}

export async function readProbeLedger(): Promise<ProbeLedgerEntry[]> {
  const full = path.join(logsDir(), PROBE_LEDGER_FILE)
  await closeAppendStream(full)
  let text: string
  try {
    text = fs.readFileSync(full, 'utf8')
  } catch {
    return []
  }
  const out: ProbeLedgerEntry[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const e: unknown = JSON.parse(t)
      if (isLedgerEntry(e)) out.push(e)
    } catch {
      /* 坏行跳过：账本是观测面，单行损坏不致命 */
    }
  }
  return out
}

/** 自然月键（本地时间，对齐日志按天落盘口径）：YYYY-MM */
export function probeMonthKey(d: Date = new Date()): string {
  return localDateStr(d).slice(0, 7)
}

/** 月度累计实际 tokens（缺省当月） */
export function probeMonthSpend(entries: ProbeLedgerEntry[], monthKey = probeMonthKey()): number {
  let sum = 0
  for (const e of entries) {
    if (probeMonthKey(new Date(e.ts)) === monthKey) sum += e.tokens
  }
  return sum
}

export interface ProbeMonthBreakdown {
  month: string
  /** 实际 tokens 合计 */
  total: number
  /** 预估 tokens 合计（与实际的差值供对账视图暴露预估偏差，design「成本失控」缓解节） */
  estimated_total: number
  /** 上游调用条目数 */
  requests: number
  /** 按 probe_id 分解的实际 tokens */
  by_probe: Record<string, number>
}

export function probeMonthBreakdown(entries: ProbeLedgerEntry[], monthKey = probeMonthKey()): ProbeMonthBreakdown {
  const byProbe: Record<string, number> = {}
  let total = 0
  let estimated = 0
  let n = 0
  for (const e of entries) {
    if (probeMonthKey(new Date(e.ts)) !== monthKey) continue
    total += e.tokens
    estimated += e.estimated_tokens
    n++
    byProbe[e.probe_id] = (byProbe[e.probe_id] ?? 0) + e.tokens
  }
  return { month: monthKey, total, estimated_total: estimated, requests: n, by_probe: byProbe }
}

/** [probe].budget_tokens 读取：未配置/非法值（非正数）落缺省（store 校验只拦形状，取值语义在此兜底）。 */
export function probeBudgetTokens(rt: GatewayRuntime): number {
  const n = rt.config.probe?.budget_tokens
  return n != null && Number.isFinite(n) && n > 0 ? n : PROBE_BUDGET_TOKENS_DEFAULT
}

export interface ProbeBudgetState {
  month: string
  budget: number
  spent: number
  remaining: number
  exhausted: boolean
}

/** 月度预算读数（账本全量扫描；探针触发是人工低频动作，不缓存） */
export async function probeBudgetState(rt: GatewayRuntime, now = new Date()): Promise<ProbeBudgetState> {
  const budget = probeBudgetTokens(rt)
  const month = probeMonthKey(now)
  const spent = probeMonthSpend(await readProbeLedger(), month)
  return { month, budget, spent, remaining: Math.max(0, budget - spent), exhausted: spent >= budget }
}

// registry.ts — 探针域声明式目录（provider-probe-suite 任务 1）。
// 15 项探针（P1–P15）+ 预留上下文长度槽位（id=ctx，not-implemented）。本文件只做数据声明与
// 纯函数换算：成本预估、请求基数、共识类别——判定实现（runners/）与执行引擎（engine.ts）按
// 此目录驱动，新增探针先落目录再补 runner，防「实现先行、目录漂移」。
// 成本档口径（design 硬约束）：S/M/L = 单请求 token 上限 200/2000/10000，预估 = Σ(该次运行内
// 全部请求的档位上限)；多请求探针（P2 逐 key / P10 逐题 / P13 双发 / P14 多轮 / P8 双请求 /
// P11 递增）的 requests 字段即请求基数，累计口径一律 run-total（账本按次落条目、预算按月合计）。

import { t } from '../../util/i18n.js'

/** 探针成本档：none = 零 token（P15 被动聚合）。 */
export type ProbeCostTier = 'S' | 'M' | 'L' | 'none'

/** 确定性类别：canary 单次判定；jittery 易抖动（3 取中位共识后才翻 verdict）；passive 只读
 *  既有日志零上游请求。 */
export type ProbeDeterminism = 'canary' | 'jittery' | 'passive'

export interface ProbeDef {
  id: string
  /** 程序短词（英文，非文案；展示名走 title()） */
  name: string
  titleZh: string
  titleEn: string
  cost: ProbeCostTier
  /** 单请求 token 上限（= 档位上限；预估与账本预估字段的基准） */
  unitTokens: number
  /** 单次运行的请求基数：'per-key' = 池内 key 数逐把累计（调用方按 key 枚举 targets，每单元
   *  1 请求）；数字 = 每目标固定请求数（P10 逐题 20、P14 五轮 5、P8/P13 双请求 2、P11 递增 4）。 */
  requests: number | 'per-key'
  kind: ProbeDeterminism
  /** 累计口径：预估与预算扣减一律按「单次运行内全部请求」合计（design registry 表硬约束） */
  cumulative: 'run-total'
  /** reserved = 预留槽位（ctx）：目录占位、引擎拒绝派发（not-implemented） */
  status: 'active' | 'reserved'
}

/** 档位 token 上限（requirements「成本知情」节：S≤200 / M≤2000 / L≤10000） */
export const PROBE_TIER_TOKENS: Record<ProbeCostTier, number> = { S: 200, M: 2000, L: 10000, none: 0 }

/** 月度预算缺省（[probe].budget_tokens；任务 5 落类型化配置段，此前经 probeBudgetTokens 兜底） */
export const PROBE_BUDGET_TOKENS_DEFAULT = 50_000

// 名称/标题为静态数据（中文原文即 key）；t() 只在展示时求值——模块顶层禁直接求值 t()（AGENTS 双语文案约定）
export const PROBE_REGISTRY: readonly ProbeDef[] = [
  { id: 'p1', name: 'auth-echo', titleZh: '鉴权回声', titleEn: 'Auth echo', cost: 'S', unitTokens: PROBE_TIER_TOKENS.S, requests: 1, kind: 'canary', cumulative: 'run-total', status: 'active' },
  { id: 'p2', name: 'keypool-audit', titleZh: '钥匙池审计', titleEn: 'Key pool audit', cost: 'S', unitTokens: PROBE_TIER_TOKENS.S, requests: 'per-key', kind: 'canary', cumulative: 'run-total', status: 'active' },
  { id: 'p3', name: 'stream', titleZh: '流式链路', titleEn: 'Streaming', cost: 'M', unitTokens: PROBE_TIER_TOKENS.M, requests: 1, kind: 'canary', cumulative: 'run-total', status: 'active' },
  { id: 'p4', name: 'vision', titleZh: '视觉实证', titleEn: 'Vision', cost: 'M', unitTokens: PROBE_TIER_TOKENS.M, requests: 1, kind: 'canary', cumulative: 'run-total', status: 'active' },
  { id: 'p5', name: 'tools', titleZh: '工具实证', titleEn: 'Tool calling', cost: 'M', unitTokens: PROBE_TIER_TOKENS.M, requests: 1, kind: 'canary', cumulative: 'run-total', status: 'active' },
  { id: 'p6', name: 'structured', titleZh: '结构化输出', titleEn: 'Structured output', cost: 'M', unitTokens: PROBE_TIER_TOKENS.M, requests: 1, kind: 'canary', cumulative: 'run-total', status: 'active' },
  { id: 'p7', name: 'reasoning', titleZh: '推理识别', titleEn: 'Reasoning', cost: 'M', unitTokens: PROBE_TIER_TOKENS.M, requests: 1, kind: 'canary', cumulative: 'run-total', status: 'active' },
  { id: 'p8', name: 'memory', titleZh: '上下文保持', titleEn: 'Context retention', cost: 'S', unitTokens: PROBE_TIER_TOKENS.S, requests: 2, kind: 'canary', cumulative: 'run-total', status: 'active' },
  { id: 'p9', name: 'system-canary', titleZh: 'system 尊重', titleEn: 'System respect', cost: 'S', unitTokens: PROBE_TIER_TOKENS.S, requests: 1, kind: 'canary', cumulative: 'run-total', status: 'active' },
  { id: 'p10', name: 'math-canary', titleZh: '算术金丝', titleEn: 'Arithmetic canary', cost: 'S', unitTokens: PROBE_TIER_TOKENS.S, requests: 20, kind: 'jittery', cumulative: 'run-total', status: 'active' },
  // 递增探测 4 请求（512/1024/2048/4096），按档位口径预估 4×L；实际合计输出 ≤7680，与预估的差值由账本对账面暴露（design「成本失控」缓解节）
  { id: 'p11', name: 'output-limit', titleZh: '输出上限', titleEn: 'Output limit', cost: 'L', unitTokens: PROBE_TIER_TOKENS.L, requests: 4, kind: 'canary', cumulative: 'run-total', status: 'active' },
  { id: 'p12', name: 'identity', titleZh: '身份核对', titleEn: 'Identity check', cost: 'S', unitTokens: PROBE_TIER_TOKENS.S, requests: 1, kind: 'jittery', cumulative: 'run-total', status: 'active' },
  { id: 'p13', name: 'cache', titleZh: '缓存探测', titleEn: 'Prompt cache', cost: 'M', unitTokens: PROBE_TIER_TOKENS.M, requests: 2, kind: 'jittery', cumulative: 'run-total', status: 'active' },
  { id: 'p14', name: 'perf', titleZh: '性能画像', titleEn: 'Performance profile', cost: 'M', unitTokens: PROBE_TIER_TOKENS.M, requests: 5, kind: 'jittery', cumulative: 'run-total', status: 'active' },
  { id: 'p15', name: 'passive', titleZh: '被动聚合', titleEn: 'Passive signals', cost: 'none', unitTokens: 0, requests: 0, kind: 'passive', cumulative: 'run-total', status: 'active' },
  // 预留槽位：上下文长度实证（成本极高，等任务拆解后再实现；引擎对 reserved 一律拒发）
  { id: 'ctx', name: 'context-length', titleZh: '上下文长度', titleEn: 'Context length', cost: 'L', unitTokens: PROBE_TIER_TOKENS.L, requests: 1, kind: 'canary', cumulative: 'run-total', status: 'reserved' },
]

export function getProbeDef(id: string): ProbeDef | undefined {
  return PROBE_REGISTRY.find((d) => d.id === id)
}

/** 展示名（双语，惰性求值） */
export function probeTitle(def: ProbeDef): string {
  return t(def.titleZh, def.titleEn)
}

/** 该探针单元的上游请求数：'per-key' 探针的请求基数按目标（=每把 key）展开为 1 */
export function probeRequestCount(def: ProbeDef): number {
  return def.requests === 'per-key' ? 1 : def.requests
}

/** 单元预估 tokens = 请求数 × 档位上限（预估闸/账本 estimated_tokens 口径） */
export function probeEstimateTokens(def: ProbeDef): number {
  return probeRequestCount(def) * def.unitTokens
}

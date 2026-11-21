// index.ts — runner 目录（provider-probe-suite 任务 3/7 逐任务补齐）。
// 生产接入点：runProbeSuite 的 runner 参数经 getProbeRunner(id) 取判定实现（任务 6 CLI、
// 任务 13 调度同源）。未实现 id 返回 undefined → 引擎按 not-implemented 跳过、零上游请求。

import type { ProbeRunner } from '../engine.js'
import { runP1 } from './p1.js'
import { runP12 } from './p12.js'
import { runP15 } from './p15.js'
import { runP3 } from './p3.js'
import { runP6 } from './p6.js'
import { runP7 } from './p7.js'

const RUNNERS: Readonly<Record<string, ProbeRunner>> = {
  p1: runP1,
  p12: runP12,
  p15: runP15,
  p3: runP3,
  p6: runP6,
  p7: runP7,
}

export function getProbeRunner(id: string): ProbeRunner | undefined {
  return RUNNERS[id]
}

// goals.mjs — 项目目标面（autopilot 需求综合的北极星）。
// 「自主按核心目标给出需求」的前提是核心目标有机器可读的落点：<repoRoot>/.agents/
// orchestrator/goals.md（入库、用户手编、agent 只读）。propose/watch/nightly --plan
// 把它注入 planner prompt；文件缺失或留空 = 无目标面（只基于巡检信号提案，行为退化
// 但不报错——多数仓库没有这本账，不能阻断巡检主流程）。

import fs from 'node:fs';
import path from 'node:path';

export function goalsPath(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'goals.md');
}

/** 读目标面全文；缺失/空文件返回 null（调用方按「无目标面」降级，不报错）。 */
export function readGoals(repoRoot) {
  const p = goalsPath(repoRoot);
  if (!fs.existsSync(p)) return null;
  try {
    const text = fs.readFileSync(p, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

// config-guard.mjs — workflow.json 自改守卫（config drift guard，B7）。
// 背景（2026-11 实证事故）：sail 派发的卡在 worktree 里自改 workflow.json 的默认引擎并
// 合并——授权配置被**被调度方**改写而编排器无感（autopilot/escalation/dynamicDispatch/
// budgetProfiles 全住这个文件，改它 = 改授权面）。守卫语义：
//   1. run/drain/watch/sail 启动时记 workflow.json 的 sha256 基线（captureConfigBaseline）；
//   2. 每次派发前校验（checkConfigDrift）：当前 hash ≠ 基线 → 漂移；
//   3. 漂移 → 调用方落 fleet 审计事件（config_drift_detected，含前后 hash）+ 暂停新派发
//      （在途任务继续）；
//   4. 恢复 = 重新校验通过：文件改回基线内容（hash 复合）自动恢复；编排器自己 finish
//      合并导致的合法变更，在自己 merge 动作完成后调 resetConfigBaseline 重置基线。
//      人工/外部改 workflow.json 要让编排器接受新配置：重启编排器（重启即重新记基线）。
// 单例状态：基线存模块级变量（同进程所有派发点共享；doApprove 无处传 guard 实例，
// merge 后重置走模块函数）。跨进程不共享——每个编排器进程认自己启动时的基线。
// 零第三方依赖（.agents/ 工具链红线）。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workflowConfigPath } from '../workflow-config.mjs';

/** workflow.json 当前内容的 sha256（十六进制）。文件缺失/读不了返回 null（无法校验 ≠ 漂移：
 *  基线与当前同时不可得时守卫不动作，由 loadWorkflowConfig 自己的「损坏阻断启动」兜底）。 */
export function workflowConfigHash(repoRoot) {
  try {
    const raw = fs.readFileSync(workflowConfigPath(repoRoot));
    return createHash('sha256').update(raw).digest('hex');
  } catch {
    return null;
  }
}

// 模块级单例：{ repoRoot, baselineHash }。多仓库同进程（测试）场景按 repoRoot 区分。
const baselines = new Map(); // repoRoot(abs) → sha256|null

function repoKey(repoRoot) {
  return path.resolve(String(repoRoot ?? '.'));
}

/**
 * 记基线：把当前 workflow.json 的 sha256 记为该仓库的守卫基线（幂等，重复调用刷新）。
 * 返回基线 hash（文件缺失时 null——守卫对「从来无基线」的仓库不动作）。
 */
export function captureConfigBaseline(repoRoot) {
  const hash = workflowConfigHash(repoRoot);
  baselines.set(repoKey(repoRoot), hash);
  return hash;
}

/** 重置基线（合法变更落定后调用——编排器自己 doApprove 的 finish 合并完成后）。 */
export function resetConfigBaseline(repoRoot) {
  return captureConfigBaseline(repoRoot);
}

/** 丢弃基线（run/drain 等进程收尾时不必调——Map 随进程退出；导出仅供测试隔离）。 */
export function clearConfigBaselines() {
  baselines.clear();
}

/**
 * 派发前校验（纯读）：当前 hash vs 基线。
 * @returns {{ ok: boolean, drift: null | { from: string|null, to: string|null } }}
 *   ok=true：基线不存在（从未 capture，未接线场景）、当前与基线一致、或两侧都不可得。
 *   drift：from=基线 hash、to=当前 hash（任一侧缺失记 null，审计照落）。
 */
export function checkConfigDrift(repoRoot) {
  const key = repoKey(repoRoot);
  if (!baselines.has(key)) return { ok: true, drift: null }; // 未记基线 = 守卫未接线，不动作
  const from = baselines.get(key);
  const to = workflowConfigHash(repoRoot);
  if (from === null || to === null) return { ok: true, drift: null }; // 不可得 ≠ 漂移（fail-open，损坏阻断归 loadWorkflowConfig）
  if (from === to) return { ok: true, drift: null };
  return { ok: false, drift: { from, to } };
}

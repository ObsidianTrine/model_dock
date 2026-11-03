// drift.mjs — 质量漂移监控与自动降级（Phase 3，docs 10.5）。
// 自动合并（merged 事件 auto:true）的回溯失败率用 **revert 信号**统计：
// 任务合并后被 `git revert`（commit message 含 Revert ... feature/<id>）即计一次失败。
// 失败率超阈值 → 写降级标记 degraded.json → 期间 run 的自动合并全部回人工（L0/L1 也不放行）。
// 恢复永远人工（--clear）——降级是保险丝，拔保险丝不该是自动的。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { listCards } from './queue.mjs';
import { readEvents } from './events.mjs';
import { loadWorkflowConfig } from '../workflow-config.mjs';

/** 自动合并回溯失败率阈值的缺省值（workflow.json driftThreshold 可调，不可关闭）。 */
export const DRIFT_THRESHOLD = 0.2;

export function degradedFile(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'degraded.json');
}

/** 是否处于降级期。返回 null（未降级）或降级标记内容。 */
export function readDegraded(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(degradedFile(repoRoot), 'utf8'));
  } catch {
    return null;
  }
}

function writeDegraded(repoRoot, data) {
  fs.mkdirSync(path.dirname(degradedFile(repoRoot)), { recursive: true });
  fs.writeFileSync(degradedFile(repoRoot), JSON.stringify(data, null, 2));
}

/** 扫 merged/ 任务的 merged 事件，区分自动/人工合并。 */
export function collectMerges(repoRoot, queueRootDir) {
  const logsRoot = path.join(repoRoot, '.agents', 'orchestrator', 'logs');
  const merges = [];
  for (const id of listCards(queueRootDir, 'merged')) {
    const events = readEvents(path.join(logsRoot, id));
    const merged = events.find((e) => e.type === 'merged');
    if (!merged?.merge_commit) continue;
    merges.push({ id, commit: merged.merge_commit, auto: merged.auto === true });
  }
  return merges;
}

/** 回溯失败检测：合并提交在 baseBranch（workflow.json baseBranch，缺省 develop）上有对应
 *  revert commit（message 形如 Revert "Merge branch 'feature/<id>'"）。
 *  baseBranch 必须透传：写死 develop 时，非 develop 主干的仓库（本工具链宣称零项目专属
 *  假设）git log 直接报错 → catch 返回 false → 回溯率恒 0、永不降级，「漂移监控没有
 *  不监控档」的红线在这类仓库形同虚设且无任何告警。 */
export function detectReverted(repoRoot, taskId, baseBranch = 'develop') {
  try {
    const out = execFileSync('git', ['log', baseBranch, '--format=%s', '--grep', `^Revert .*feature/${taskId}'`], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 评估漂移：统计 + 超阈值自动写降级标记（幂等——已降级不覆盖原标记的降级时间）。
 * 阈值来自 workflow.json driftThreshold（缺省 DRIFT_THRESHOLD）；baseBranch 同源
 * （workflow.json baseBranch ?? 'develop'）。
 * 返回 { autoTotal, autoReverted, humanTotal, rate, threshold, degraded }。
 */
export function evaluateDrift(repoRoot, queueRootDir) {
  const wf = loadWorkflowConfig(repoRoot);
  const threshold = wf.driftThreshold ?? DRIFT_THRESHOLD;
  const baseBranch = wf.baseBranch ?? 'develop';
  const merges = collectMerges(repoRoot, queueRootDir);
  const autoMerges = merges.filter((m) => m.auto);
  const reverted = autoMerges.filter((m) => detectReverted(repoRoot, m.id, baseBranch));
  const rate = autoMerges.length ? reverted.length / autoMerges.length : 0;
  let degraded = readDegraded(repoRoot);
  if (autoMerges.length > 0 && rate > threshold && !degraded) {
    degraded = {
      degraded_at: new Date().toISOString(),
      reason: `自动合并回溯失败率 ${(rate * 100).toFixed(0)}% 超阈值 ${threshold * 100}%（${reverted.length}/${autoMerges.length}）`,
      failed_tasks: reverted.map((m) => m.id),
      auto_total: autoMerges.length,
    };
    writeDegraded(repoRoot, degraded);
  }
  return { autoTotal: autoMerges.length, autoReverted: reverted.length, humanTotal: merges.length - autoMerges.length, rate, threshold, degraded };
}

/** 人工恢复（--clear）：删除降级标记。 */
export function clearDegraded(repoRoot) {
  try {
    fs.rmSync(degradedFile(repoRoot), { force: true });
    return true;
  } catch {
    return false;
  }
}

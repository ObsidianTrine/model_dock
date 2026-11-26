// gate.mjs — 人工/自动闸门动作（approve / reject / retry），从 orchestrator.mjs 纯搬移（S-02）。
// 模块级可变状态：无。任务锁的可变重入表归 task-lock.mjs 所有（唯一写者 = acquireTaskLock /
// releaseTaskLock 的 reentrantDepth），本模块只是锁的消费者：doApprove / doRetry 抢锁，
// doReject 经 guardGateActionLock 查锁；不持有任何进程内状态。
// 回指 orchestrator.mjs 的局部原语（die / log / orchEnv / settleNotify / worktreePath /
// archiveIncident / cmdRun）：循环 import 仅在函数调用期读取，不在模块求值期触碰（见头注约定）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseCard, cardPath, findCard, moveCard } from './queue.mjs';
import { appendEvent, readEvents } from './events.mjs';
import { acquireTaskLock, releaseTaskLock, readTaskLock, taskLockPath, taskLockLooksLive, TASK_LOCK_STALE_MS } from './task-lock.mjs';
import { loadWorkflowConfig } from '../workflow-config.mjs';
import { runArgvTreeSafe } from './gates.mjs';
import { resetConfigBaseline } from './config-guard.mjs';
import { supersedeForMerged } from './drafts-gc.mjs';
import { appendFleetEvent } from './weather.mjs';
import { die, log, orchEnv, settleNotify, worktreePath, archiveIncident, cmdRun } from '../orchestrator.mjs';

// ---------------------------------------------------------------------------
// 闸门操作（交互与非交互共用）
// ---------------------------------------------------------------------------

/**
 * 零提交防假合并门的对账原语：feature 分支相对 base 的提交数。查分支 ref 而非复用
 * worktreeCommitsAhead（worktree HEAD）：worktree 可能已被上次失败的 finish 清掉而卡
 * 仍留 awaiting-human（清理失败退出 1 的重试场景），分支 ref 才是 finish 实际要合并的
 * 对象。null = 不可判定（分支缺失 / git 故障）——不拦截，交给 finish 自己报错：门只拦
 * 「有明确证据的零提交」，不为排查失败扩大拦截面。
 */
function featureBranchCommitsAhead(repoRoot, taskId, baseBranch) {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${baseBranch}..refs/heads/feature/${taskId}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const n = Number.parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * 卡面 scratch_only 声明（doApprove 零提交豁免判据）。闸门时刻卡必在 awaiting-human/
 * （CLI approve / 交互闸门 / run 自动合并 / sweep 四条路径都先落位再进 doApprove）。
 * 读取失败按 false——豁免是优惠面，卡损坏回严管走原拒绝防线（与 parseCard 的
 * scratch_only 非法值回 false 同一取舍）。
 */
function cardScratchOnly(root, taskId) {
  try {
    return parseCard(fs.readFileSync(cardPath(root, 'awaiting-human', taskId), 'utf8'), taskId).meta.scratch_only === true;
  } catch {
    return false;
  }
}

// 任务锁守卫文案（DM-01，2026-11-25 健康审计）：闸门动作的锁被他人持有时点名持有者。
function gateLockBusy(taskId, info, action) {
  return `任务 "${taskId}" 的 ${action} 被拒：另一进程正在驱动这同一个泊位（pid ${info.pid}${info.cmd ? `，${info.cmd}` : ''}${info.acquired_at ? `，始于 ${info.acquired_at}` : ''}）。\n`
    + `  人工批示与自动批示共用任务锁——approve / retry 进行期间（finish 合并通常数分钟）不接受并发批示；交互式闸门（run 在终端等人拍板）在场时请回到该会话内操作。\n`
    + `  等对方结束；持锁进程心跳停止 ${TASK_LOCK_STALE_MS / 1000}s 后陈锁自动接管（无需手动清理或终止进程）。`;
}

/**
 * 闸门动作入口的任务锁守卫（reject 用；approve / retry 走 acquireTaskLock 的重入豁免）：
 * 锁活且持有者不是本进程 → die 并点名持有者。本进程持锁 = 交互式闸门（cmdRun 仍持锁时
 * 人在本会话里选了驳回），不是并发，放行。心跳静默的陈锁不拦人（与 cmdAbandon 同口径）。
 */
function guardGateActionLock(repoRoot, taskId, action) {
  const liveLock = readTaskLock(repoRoot, taskId);
  if (liveLock && Number.isInteger(liveLock.pid) && liveLock.pid !== process.pid && taskLockLooksLive(liveLock)) {
    die(gateLockBusy(taskId, liveLock, action));
  }
}

/**
 * doApprove：闸门放行的锁壳（DM-01）。合并动作全程持任务锁——此前 doApprove 整段不持锁，
 * 自动批示 sweep 判定超时进入 finish 的数分钟里，人工 reject / approve / retry 照常执行：
 * reject 把卡迁 failed/ 而 finish 不知情照常合并；人工 approve 与自动返工撞车后两个进程
 * 同写一个 worktree，随后 finish 还会把它删掉。run 闭环内（自动合并 / 交互闸门）调用时
 * 本进程已持锁，acquireTaskLock 同 pid 重入豁免（深度计数配对，锁文件由最外层释放）。
 * 返回 true = 已落 merged/；false = finish 返回时卡已离开闸门，未记 merged（调用方决定
 * 是否按失败退出——sweep 继续处理余卡，CLI 非零退出）。
 */
export async function doApprove(repoRoot, taskId, root, qdir, source = 'human') {
  const lock = acquireTaskLock(repoRoot, taskId, 'approve');
  if (!lock.held) {
    if (lock.unremovable) {
      die(`任务 "${taskId}" 的任务锁无法接管（陈锁删除失败，可能被其他进程占用）。\n手动删除 ${taskLockPath(repoRoot, taskId)} 后重试。`);
    }
    die(gateLockBusy(taskId, lock.owner, 'approve'));
  }
  try {
    return await doApproveLocked(repoRoot, taskId, root, qdir, source);
  } finally {
    releaseTaskLock(repoRoot, taskId);
  }
}

/** doApprove 的锁内主体（持锁语义见 doApprove 锁壳）。 */
async function doApproveLocked(repoRoot, taskId, root, qdir, source = 'human') {
  // source='human' 记人工闸门；'auto' 记自动合并（裁决依据已由 auto_merge 事件先行记录），
  // merged 事件带 auto 标记——Phase 3 质量漂移统计按此回溯自动合并的回溯失败率。
  if (source === 'auto') appendEvent(qdir, 'auto_merge_decision', { decision: 'merge' });
  else appendEvent(qdir, 'human_gate', { decision: 'approved' });
  // 零提交防假合并门（2026-11-16 夜航四张 perf 卡假 merged 实证）：spawn finish 前先对账
  // 分支产出。零提交分支上 finish 走「nothing to merge」成功路径 exit 0，旧逻辑随后无条件
  // 记 merged 并把当时的 develop HEAD 误记成 merge_commit。拒绝时卡转 failed/（终态：
  // 落 reviewing/ 会被自动批示再次拉回闸门反复重跑审查，failed/ 与人工驳回 doReject 同款
  // 落位）；事件留拒绝理由、不记 merge_commit、不动 develop，worktree 保留供人工核对
  // worker 到底留了什么（多半是漏提交）。
  const baseBranch = loadWorkflowConfig(repoRoot).baseBranch || 'develop';
  const commitsAhead = featureBranchCommitsAhead(repoRoot, taskId, baseBranch);
  // scratch_only 结算豁免（2026-11-23 bench codex 腿实证）：卡面声明产物只落 worktree 非跟踪区
  // （scratch-only-card：门禁 skipped + XTE no_commit 豁免），零提交是卡面声明的合规形态，
  // 防假合并门不适用；finish 对零提交显式失败（37bfdfc），也不 spawn——不合并、develop 不动、
  // 不记 merge_commit，直接落位 merged/。worktree 保留（答卷归档由调度台收尾做），对账锚
  // scratch_only_settle 事件标记（reconcile settledNotMerged 按此豁免）。人工与 auto 两路径
  // 同享；非 scratch_only 卡零提交照旧拒绝，防线零放宽。
  const scratchOnlySettle = commitsAhead === 0 && cardScratchOnly(root, taskId);
  if (commitsAhead === 0 && !scratchOnlySettle) {
    moveCard(root, taskId, 'awaiting-human', 'failed');
    appendEvent(qdir, 'failed', { reason: `分支相对 ${baseBranch} 零提交，无可验收产出（防假合并门拒绝记 merged）`, commits_ahead: commitsAhead });
    die(
      `任务 ${taskId} 拒绝合并：feature 分支相对 ${baseBranch} 零提交，无可验收产出（防假合并门，2026-11-16 假 merged 事故防线）。\n` +
      `任务已转 failed/，未记 merge_commit、develop 未动；worktree 保留在 ${worktreePath(repoRoot, taskId)} 供人工查看。\n` +
      `若工作确已完成，多为 worker 漏提交——进 worktree 核对补提交后按新卡重跑闭环。`,
    );
  }
  if (scratchOnlySettle) {
    moveCard(root, taskId, 'awaiting-human', 'merged');
    appendEvent(qdir, 'merged', { scratch_only_settle: true, ...(source === 'auto' ? { auto: true } : {}) });
    log(`已结算 merged/（scratch_only 零提交，不合并）：worktree 保留在 ${worktreePath(repoRoot, taskId)}，答卷归档由调度台收尾处理。`);
    // 不 resetConfigBaseline（没有合并发生，configGuard 基线不该被无来源重置）、不做 draftsGc
    // 清退（scratch 卡未实现任何 repo 改动面，files_hint 常为 ["**"]，清退会误杀全部提案）。
    await settleNotify(repoRoot, taskId, 'merged', source === 'auto' ? '审查通过，自动出港' : '人工放行出港');
    return true;
  }
  // finish：rebase → testCmd → --no-ff 合并 → 清理分支与 worktree。
  // 门禁快捷路径：npm_test 门禁通过时记录了 worktree HEAD（gate_result.head），
  // approve 给 finish 带 --skip-test + ORCHESTRATOR_GATE_HEAD——finish 内部校验
  // 「develop 未前进 且 HEAD 与 gate 一致」成立才跳过锁内重跑，否则自动回落全量
  // （merge-verify-once：全量测试只跑一次，且不因跳过降低门禁强度）。
  const gateHead = (() => {
    const evts = readEvents(qdir);
    for (let i = evts.length - 1; i >= 0; i--) {
      const e = evts[i];
      if (e.type === 'gate_result' && e.gate === 'npm_test' && e.result === 'pass' && typeof e.head === 'string' && e.head) return e.head;
    }
    return null;
  })();
  const finishArgs = ['finish', taskId];
  const finishEnv = { ...process.env };
  if (gateHead) {
    finishArgs.push('--skip-test');
    finishEnv.ORCHESTRATOR_GATE_HEAD = gateHead;
  }
  // 撞锁有界重试：finish 对 .finish.lock 自带有界等待（FINISH_LOCK_WAIT_SECONDS），
  // 这里兜底等待超时/显式 cap=0 的情形——并发 drain 合并把「立即失败→任务卡滞留
  // awaiting-human 等人工重跑」收敛为自动排队。参数可环境收缩（测试用）：
  // ORCH_FINISH_RETRY_ATTEMPTS（额外重试次数，默认 2）、ORCH_FINISH_RETRY_DELAY_MS（默认 60000）。
  const extraAttempts = Number.parseInt(orchEnv.ORCH_FINISH_RETRY_ATTEMPTS ?? '', 10); // env-snap
  const retryDelayRaw = Number.parseInt(orchEnv.ORCH_FINISH_RETRY_DELAY_MS ?? '', 10); // env-snap
  const maxAttempts = (Number.isInteger(extraAttempts) && extraAttempts >= 0 ? extraAttempts : 2) + 1;
  const retryDelayMs = Number.isInteger(retryDelayRaw) && retryDelayRaw >= 0 ? retryDelayRaw : 60_000;
  const fbScript = path.join(repoRoot, '.agents', 'scripts', 'feature-branch.mjs');
  // 外层超时按 testCmd 数量动态放宽（P0 修复，2026-11）：finish 内每条验证命令上限
  // 20min（runCmd），数组多条时旧外层 30min 固定值先到——整树被杀、任务误判失败。
  // 预算 = N×20min + rebase/merge 余量 15min，下限保留旧 30min。
  const testCmdCount = loadWorkflowConfig(repoRoot).testCmd?.length ?? 0;
  const finishTimeoutMs = Math.max(30 * 60_000, testCmdCount * 20 * 60_000 + 15 * 60_000);
  let r = null;
  let lockConflict = false;
  for (let attempt = 1; ; attempt++) {
    // runArgvTreeSafe：detached（unix 进程组）+ 超时 killTree——spawnSync timeout 只杀
    // 直接子进程，finish 挂死时其内部 testCmd 进程树全部孤儿化（Windows 锁 worktree
    // 句柄致 EBUSY）。finish 挂死（含内部 testCmd）不能陪跑到底：超时按失败走（任务留 awaiting-human 可重试）
    r = await runArgvTreeSafe(['node', fbScript, ...finishArgs], {
      cwd: repoRoot,
      env: finishEnv,
      timeoutMs: finishTimeoutMs,
    });
    // 透传 finish 输出（保持现场可见性）；撞锁凭 stderr 文案识别
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    lockConflict = r.status !== 0 && /another finish is (already running|still running after waiting)/.test(r.stderr ?? '');
    if (r.status === 0 || !lockConflict || attempt >= maxAttempts) break;
    log(`finish 撞合并锁（第 ${attempt}/${maxAttempts} 次尝试），${Math.round(retryDelayMs / 1000)}s 后重试……`);
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  if (r.status !== 0) {
    if (lockConflict) appendEvent(qdir, 'merge_lock_wait', { attempts: maxAttempts });
    die(`feature-branch finish 失败（exit ${r.status ?? '?'}${r.timedOut ? '，超时已按进程树收割' : ''}）。任务留在 awaiting-human/，处理后重新 approve。`, r.status ?? 1);
  }
  // 落位前复查卡位（DM-01）：finish 返回时卡必须仍在 awaiting-human/。锁已挡住并发批示，
  // 这里兜不认锁的外部改动（手工挪卡、陈锁被接管后的并发动作）——旧实现直接 moveCard，
  // 卡不在闸门即抛 QueueError 炸穿本轮 sweep，余卡全部跳过。分支此时可能已被 finish 合并：
  // 不记 merged（不把来路不明的合并记成闸门放行）、不动卡位，交人工核对。
  const after = findCard(root, taskId);
  if (after?.state !== 'awaiting-human') {
    log(`⚠ approve 中止收尾：finish 已返回，但任务卡已不在 awaiting-human/（当前：${after ? `${after.state}/` : '不在队列'}）——未记 merged。`);
    log(`  分支可能已被 finish 合并进基准分支：核对 git log 与卡位后人工处置（node .agents/scripts/orchestrator.mjs logs ${taskId}）。`);
    return false;
  }
  moveCard(root, taskId, 'awaiting-human', 'merged');
  const mergeCommit = execFileSync('git', ['log', '-1', '--format=%H'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  appendEvent(qdir, 'merged', { merge_commit: mergeCommit, ...(source === 'auto' ? { auto: true } : {}) });
  log(`已合并：${mergeCommit.slice(0, 7)}（任务转 merged/${source === 'auto' ? '，自动合并' : ''}）`);
  // 配置守卫（B7）：编排器自己 finish 合并带来的 workflow.json 变更（合并卡改了授权配置、
  // 已过门禁与人审）= 合法变更——merge 动作完成后重置基线，下次派发校验按新基线放行。
  resetConfigBaseline(repoRoot);
  // 提案清退（B9，闭环内动作）：与刚合并卡 files_hint 重叠的 drafts/ 提案自动迁入
  // drafts/superseded/ 并标注合并卡 id——现场已被真实实现覆盖，提案留着会误导 planner
  // 与人工。仅标题相似的不迁（防误杀）。尽力而为，任何失败不影响合并结果。
  if (loadWorkflowConfig(repoRoot).draftsGc?.autoSupersede !== false) {
    let mergedMeta = null;
    try {
      mergedMeta = parseCard(fs.readFileSync(cardPath(root, 'merged', taskId), 'utf8'), taskId).meta;
    } catch { /* 损坏卡：清退跳过，提案留原地 */ }
    if (mergedMeta) {
      const moved = supersedeForMerged(repoRoot, { mergedId: taskId, filesHint: mergedMeta.files_hint });
      if (moved.length) {
        log(`🧹 提案清退：${moved.join(', ')} → drafts/superseded/（改动面与 ${taskId} 重叠）。`);
        try { appendFleetEvent(repoRoot, 'drafts_superseded', { task: taskId, drafts: moved }); } catch { /* 留痕失败不阻断 */ }
      }
    }
  }
  // 成功出港同样通知（此前 merged 静默——失败人人皆知、成功无声，体验反了）
  await settleNotify(repoRoot, taskId, 'merged', source === 'auto' ? '审查通过，自动出港' : '人工放行出港');
  return true;
}

export async function doReject(repoRoot, taskId, root, qdir, reason) {
  // 动作前查任务锁（DM-01，与 cmdAbandon 同款守卫）：approve / retry / run 进行期间不接受驳回
  guardGateActionLock(repoRoot, taskId, 'reject');
  appendEvent(qdir, 'human_gate', { decision: 'rejected', reason });
  moveCard(root, taskId, 'awaiting-human', 'failed');
  appendEvent(qdir, 'failed', { reason: reason || '人工驳回' });
  // 人工驳回同样进调查包（VDR）：船东与验船师的分歧是最有价值的教训来源，回看与出题都要现场
  archiveIncident(repoRoot, taskId, root, qdir, reason || '人工驳回');
  log(`已驳回：任务转 failed/（worktree 保留供人工查看现场：${worktreePath(repoRoot, taskId)}）`);
}

export async function doRetry(repoRoot, taskId, root, qdir, note, opts) {
  // 打回重试同样持任务锁（DM-01）：卡迁 running/ 到 cmdRun 抢锁之间、以及 sweep 自动返工
  // 与人工 approve 撞车时，不许第二个批示动作落在同一泊位。cmdRun 内 acquireTaskLock 对
  // 本进程重入豁免（深度 +1），其 finally 减一层、这里的最外层 finally 才删锁文件。
  const lock = acquireTaskLock(repoRoot, taskId, 'retry');
  if (!lock.held) {
    if (lock.unremovable) {
      die(`任务 "${taskId}" 的任务锁无法接管（陈锁删除失败，可能被其他进程占用）。\n手动删除 ${taskLockPath(repoRoot, taskId)} 后重试。`);
    }
    die(gateLockBusy(taskId, lock.owner, 'retry'));
  }
  try {
    if (findCard(root, taskId)?.state !== 'awaiting-human') {
      die(`任务 "${taskId}" 已不在 awaiting-human/，无法打回重试（动作前已被其他批示处理）。`);
    }
    appendEvent(qdir, 'human_gate', { decision: 'retry', note });
    // 补充指令写回任务卡背景段，worker 续做时可见
    const cardP = cardPath(root, 'awaiting-human', taskId);
    const text = fs.readFileSync(cardP, 'utf8');
    fs.writeFileSync(cardP, `${text.trimEnd()}\n\n# 补充指令（人工打回）\n${note}\n`);
    moveCard(root, taskId, 'awaiting-human', 'running');
    log('已打回 running/，重新启动闭环……');
    await cmdRun(repoRoot, taskId, { ...opts, interactive: false });
  } finally {
    releaseTaskLock(repoRoot, taskId);
  }
}


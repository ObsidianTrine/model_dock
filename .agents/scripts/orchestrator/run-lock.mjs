// run-lock.mjs — 调度器互斥锁：同一时刻最多一个调度器（drain / nightly / scan --run）
// 在跑。防两类真实撞车：① nightly 定时与白天手动 drain 并发，pickNextCard 窗口期
// 同时选中同一张卡 → 两个 worker 写同一个 worktree；② 上一晚 --auto drain 未跑完，
// 次日定时又拉起一个 nightly。手动单卡 run 不加锁（人工明确意图，由状态机拒绝
// 非法启动兜底）。
//
// 语义（与 feature-branch 的 .finish.lock 同款哲学）：
//   - 锁文件 .agents/orchestrator/.scheduler-lock.json 记 { pid, cmd, acquired_at }
//   - 持有进程已死（isAlive 假）= 陈锁，自动接管——崩溃不死锁，无需人工清理
//   - 子进程豁免：父调度器（nightly --auto spawn drain / scan --run spawn run）
//     注入 ORCH_SCHED_LOCK_HELD=1，子进程见到即不再抢锁（否则必然自我死锁）

import fs from 'node:fs';
import path from 'node:path';
import { isAlive } from './kill-tree.mjs';

export const SCHED_LOCK_ENV = 'ORCH_SCHED_LOCK_HELD';

export function schedulerLockPath(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', '.scheduler-lock.json');
}

function readLock(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 抢调度器锁。返回 true（已持有，含接管陈锁）或 false（他人持有且存活）。
 * acquired 回调形式不采用——调用方需要「失败即退出」的同步语义，release 由
 * releaseSchedulerLock 显式调用（进程死亡时陈锁自动被下次接管，不强求 finally）。
 */
export function acquireSchedulerLock(repoRoot, name = 'scheduler') {
  // 父调度器已持锁的子进程（drain/run 被 nightly/scan spawn）：豁免
  if (process.env[SCHED_LOCK_ENV] === '1') return { held: true, inherited: true };
  const p = schedulerLockPath(repoRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cur = readLock(p);
  if (cur && Number.isInteger(cur.pid) && isAlive(cur.pid)) {
    return { held: false, owner: cur };
  }
  if (cur) {
    console.log(`[orchestrator] 接管陈旧调度器锁（pid=${cur.pid} 已退出，${cur.cmd ?? 'unknown'}）`);
  }
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, cmd: name, acquired_at: new Date().toISOString() }, null, 2));
  return { held: true, inherited: false };
}

export function releaseSchedulerLock(repoRoot) {
  const p = schedulerLockPath(repoRoot);
  const cur = readLock(p);
  // 只释放自己持有的锁（陈锁已被别人接管时不误删）
  if (cur?.pid === process.pid) fs.rmSync(p, { force: true });
}

/** spawn 子进程时传播「父已持锁」豁免（drain/nightly 内部 spawn 的 run/drain 子进程用）。 */
export function childEnvForHeldLock() {
  return { [SCHED_LOCK_ENV]: '1' };
}

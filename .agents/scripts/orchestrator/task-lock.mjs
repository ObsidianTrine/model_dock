// task-lock.mjs — 任务级互斥锁：同一任务同一时刻最多一个 run 闭环进程在驱动。
// 防的都是"两个 worker 写同一个 worktree"：① 手动 run/resume/retry 与 drain（或
// 另一次手动操作）并发驱动同一张卡；② 旧实现靠 resume 时的孤儿清理"接管"（杀旧
// worker），但 worker_spawned 事件落盘前存在杀不掉的窄窗口。锁在 cmdRun 入口、
// worker spawn 之前持有，窗口从根上消除——后来者拿到明确报错，而不是悄悄杀掉
// 前者正在做的工作。
// 与 run-lock.mjs（调度器级：drain/nightly/scan --run 全局单实例）分两层：调度器
// 锁防"调度器双开"，任务锁防"同任务双驱动"；并行 drain 的不同任务各持各的任务
// 锁，互不影响。
//
// 语义（与 run-lock.mjs / feature-branch 的 .finish.lock 同款哲学）：
//   - 锁文件 .agents/orchestrator/.run-<task-id>.lock 记 { pid, task, cmd, acquired_at }
//   - 持有进程已死（isAlive 假）= 陈锁，自动接管——崩溃不死锁，无需人工清理
//   - 释放只删自己持有的锁；进程退出（含 die/process.exit、SIGKILL 之外的一切
//     正常退出路径）经 exit handler 兜底；SIGKILL/断电残留的陈锁由下次进入接管
//   - 闭环正常落位（merged/awaiting-human/blocked/failed）由 cmdRun finally 显式释放

import fs from 'node:fs';
import path from 'node:path';

import { isAlive } from './kill-tree.mjs';
import { invalidateSeqCache, logDir } from './events.mjs';
import { TASK_ID_RE } from './queue.mjs';

export function taskLockPath(repoRoot, taskId) {
  if (!TASK_ID_RE.test(String(taskId))) {
    // 锁文件名内嵌 task id：挡住手改队列目录时可能出现的路径注入
    throw new Error(`任务 id "${taskId}" 不合法：只允许小写字母/数字/短横线`);
  }
  return path.join(repoRoot, '.agents', 'orchestrator', `.run-${taskId}.lock`);
}

function readLock(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 读任务锁（abandon 守卫用）：无锁/损坏锁返回 null。 */
export function readTaskLock(repoRoot, taskId) {
  return readLock(taskLockPath(repoRoot, taskId));
}

export function releaseTaskLock(repoRoot, taskId) {
  const cur = readTaskLock(repoRoot, taskId);
  // 只释放自己持有的锁（陈锁已被别人接管时不误删）
  if (cur?.pid === process.pid) fs.rmSync(taskLockPath(repoRoot, taskId), { force: true });
}

/**
 * 抢任务锁。返回 { held: true } 或 { held: false, owner, unremovable? }——
 * 调用方按 held 分流：false 即 die（带 owner pid 的可操作提示）。
 * 陈锁最多重试接管 2 次（与 feature-branch 的 finish 锁同款防抖）；删不掉
 * 返回 unremovable 让调用方提示手动清理，不死循环。
 */
export function acquireTaskLock(repoRoot, taskId, name = 'run') {
  const p = taskLockPath(repoRoot, taskId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  for (let takeovers = 0; ; takeovers++) {
    try {
      fs.writeFileSync(p, JSON.stringify({ pid: process.pid, task: taskId, cmd: name, acquired_at: new Date().toISOString() }, null, 2), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = readLock(p);
      if (cur && Number.isInteger(cur.pid) && isAlive(cur.pid)) {
        return { held: false, owner: cur };
      }
      if (takeovers >= 2) return { held: false, owner: cur ?? { pid: null, task: taskId }, unremovable: true };
      let tookOver = false;
      try { fs.rmSync(p, { force: true }); tookOver = true; } catch { /* 下一轮重查 */ }
      if (tookOver) {
        console.log(`[orchestrator] 接管陈旧任务锁（task=${taskId}，pid=${cur?.pid ?? '?'} 已退出）`);
        // 接管者的下一次 appendEvent 重新从盘上对齐 seq——防同任务跨进程双写 seq 冲突（events.mjs 缓存配套）
        invalidateSeqCache(logDir(repoRoot, taskId));
      }
      continue;
    }
    process.on('exit', () => { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } });
    return { held: true };
  }
}

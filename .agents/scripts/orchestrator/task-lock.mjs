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
//   - 锁文件 .agents/orchestrator/.run-<task-id>.lock 记 { pid, task, cmd, acquired_at, beat }
//   - 判活按心跳 beat（持有进程每 15s 续写）：beat 静默超 60s = 陈锁，自动接管——
//     崩溃不死锁，无需人工清理。pid 仅作诊断记录：纯 isAlive(pid) 判活会被 pid 复用
//     骗过（陈锁属主早已退出、pid 被新进程顶掉 = 假活锁，后来者永远拿不到锁，还会
//     把无辜进程当属主误杀；与 feature-branch finish 锁 2026-10-30 实证同型，故取同款
//     心跳方案）。旧版锁（无 beat 字段）滚动兼容：isAlive + acquired_at 30min 兜底。
//   - 释放只删自己持有的锁；进程退出（含 die/process.exit、SIGKILL 之外的一切
//     正常退出路径）经 exit handler 兜底；SIGKILL/断电残留的陈锁由下次进入接管
//   - 闭环正常落位（merged/awaiting-human/blocked/failed）由 cmdRun finally 显式释放

import fs from 'node:fs';
import path from 'node:path';

import { isAlive } from './kill-tree.mjs';
import { invalidateSeqCache, logDir } from './events.mjs';
import { TASK_ID_RE } from './queue.mjs';

/** 持有期间心跳间隔 / 心跳静默判陈阈值（连续 ~3 个心跳未续；与 finish 锁同数值）。 */
export const TASK_LOCK_BEAT_MS = 15_000;
export const TASK_LOCK_STALE_MS = 60_000;
/** 旧版锁（无 beat 字段，心跳改造前的进程写的）：按 acquired_at 判陈旧，阈值放大到
 *  30min——覆盖最长的合法闭环（worker 会话 + 门禁），又不让旧版崩溃残留的锁永久拒人。 */
const LEGACY_STALE_MS = 30 * 60_000;

/**
 * 锁判活（acquire 与 follow/abandon 守卫共用）：beat 新鲜 = 活；无 beat 的旧版锁按
 * isAlive + acquired_at 30min 兜底；损坏锁 = 陈锁，可接管。
 */
export function taskLockLooksLive(info) {
  if (!info || !Number.isInteger(info.pid)) return false;
  if (Number.isFinite(info.beat)) return Date.now() - info.beat < TASK_LOCK_STALE_MS;
  const at = Date.parse(info.acquired_at ?? '');
  const age = Number.isFinite(at) ? Date.now() - at : 0;
  return isAlive(info.pid) && age < LEGACY_STALE_MS;
}

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

// 心跳定时器（按锁路径）：持有期间每 15s 续写 beat。unref 不拖进程退出——主流程
// 结束后事件循环若被泄漏句柄钉住，心跳停更，下一位等待者 60s 内即可安全接管。
const beatTimers = new Map();

function stopBeat(p) {
  const t = beatTimers.get(p);
  if (t) {
    clearInterval(t);
    beatTimers.delete(p);
  }
}

function startBeat(p) {
  if (beatTimers.has(p)) return; // 重入：外层已在跳
  const t = setInterval(() => {
    try {
      const info = readLock(p);
      if (info?.pid !== process.pid) {
        stopBeat(p); // 锁已易主（防御，理论不可达）
        return;
      }
      fs.writeFileSync(p, JSON.stringify({ ...info, beat: Date.now() }));
    } catch { /* 下一个 tick 重试 */ }
  }, TASK_LOCK_BEAT_MS);
  t.unref();
  beatTimers.set(p, t);
}

export function releaseTaskLock(repoRoot, taskId) {
  const p = taskLockPath(repoRoot, taskId);
  // 重入深度>1：内层（同进程嵌套闭环）释放不动锁文件，只减计数——锁还归外层持有
  const depth = reentrantDepth.get(p) ?? 0;
  if (depth > 1) {
    reentrantDepth.set(p, depth - 1);
    return;
  }
  reentrantDepth.delete(p);
  stopBeat(p); // 最外层释放：心跳一并停（unref 定时器不删也会随进程退出消亡，显式删防泄漏）
  const cur = readTaskLock(repoRoot, taskId);
  // 只释放自己持有的锁（陈锁已被别人接管时不误删）
  if (cur?.pid === process.pid) fs.rmSync(p, { force: true });
}

// 重入深度表（按锁文件路径）：同进程嵌套 acquire/release 的配对计数。
// 场景：交互闸门 [b] 打回重试（humanGateInteractive → doRetry）在外层 cmdRun 仍持锁时
// 再调 cmdRun——同一驱动者嵌套闭环，不是「双开」。此前无豁免：acquire 见到自己的 pid
// 也按「他人持有」die 自指报错，卡滞留 running/、临时目录泄漏。
const reentrantDepth = new Map();
// exit handler 每路径只注册一次：重复注册只是无害累积，没必要堆
const exitHooked = new Set();

/**
 * 抢任务锁。返回 { held: true } 或 { held: false, owner, unremovable? }——
 * 调用方按 held 分流：false 即 die（带 owner pid 的可操作提示）。
 * 本进程已持同把锁 → 重入豁免（held:true，深度计数保护锁文件生命周期）。
 * 陈锁（属主已死，或心跳静默——含 pid 被复用的假活锁）最多重试接管 2 次（与
 * feature-branch 的 finish 锁同款防抖）；删不掉返回 unremovable 让调用方提示
 * 手动清理，不死循环。
 */
export function acquireTaskLock(repoRoot, taskId, name = 'run') {
  const p = taskLockPath(repoRoot, taskId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const self = readLock(p);
  if (self && Number.isInteger(self.pid) && self.pid === process.pid) {
    reentrantDepth.set(p, (reentrantDepth.get(p) ?? 0) + 1);
    return { held: true };
  }
  for (let takeovers = 0; ; takeovers++) {
    try {
      fs.writeFileSync(p, JSON.stringify({ pid: process.pid, task: taskId, cmd: name, acquired_at: new Date().toISOString(), beat: Date.now() }, null, 2), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = readLock(p);
      if (cur && Number.isInteger(cur.pid) && cur.pid === process.pid) {
        // wx 竞态窗口里的自锁（本进程刚 release 又立刻重抢）：同重入豁免
        reentrantDepth.set(p, (reentrantDepth.get(p) ?? 0) + 1);
        return { held: true };
      }
      if (taskLockLooksLive(cur)) {
        return { held: false, owner: cur };
      }
      if (takeovers >= 2) return { held: false, owner: cur ?? { pid: null, task: taskId }, unremovable: true };
      let tookOver = false;
      try { fs.rmSync(p, { force: true }); tookOver = true; } catch { /* 下一轮重查 */ }
      if (tookOver) {
        const why = cur && Number.isFinite(cur.beat) ? '心跳已静默' : '属主已退出';
        console.log(`[orchestrator] 接管陈旧任务锁（task=${taskId}，pid=${cur?.pid ?? '?'} ${why}）`);
        // 接管者的下一次 appendEvent 重新从盘上对齐 seq——防同任务跨进程双写 seq 冲突（events.mjs 缓存配套）
        invalidateSeqCache(logDir(repoRoot, taskId));
      }
      continue;
    }
    startBeat(p);
    if (!exitHooked.has(p)) {
      exitHooked.add(p);
      // 只删自己持有的锁：进程释放锁后到退出的毫秒窗口里锁可能已被他人接管，
      // 无属主校验的 rmSync 会误删对方的活锁、放行第三者同任务双驱动
      process.on('exit', () => {
        try {
          const cur = readLock(p);
          if (cur?.pid === process.pid) fs.rmSync(p, { force: true });
        } catch { /* best effort */ }
      });
    }
    reentrantDepth.set(p, (reentrantDepth.get(p) ?? 0) + 1);
    return { held: true };
  }
}

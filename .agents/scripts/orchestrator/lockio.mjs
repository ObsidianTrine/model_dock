// lockio.mjs — 锁文件读写的原子性小工具（task-lock.mjs 的任务锁与 feature-branch.mjs
// 的 .finish.lock 共用）。此前心跳续写是原地 writeFileSync（截断重写）：读方在毫秒级
// 写窗口撞上半个 JSON 会把活锁误判成陈锁、触发接管 → 同任务/同 base 分支双驱动（2×P2
// 审计项，2026-11）。这里收口两件事：
//   - writeLockAtomic：tmp（同目录唯一名）+ rename 原子落盘。rename 在 win 上撞目标
//     被并发读方占住时报 EPERM/EBUSY——短退避重试一次，仍失败清理 tmp 后静默放弃：
//     心跳是尽力而为，放弃即「这一拍没写」，锁文件仍是上一拍的完整 JSON（60s 陈锁
//     阈值容纳丢一拍），不得让属主因此崩。
//   - readLockJson：JSON.parse 失败短退避重读一次，仍坏才返回 null——写侧原子化之外的
//     双保险（滚动升级窗口里的旧版原地写者、以及 wx 新建与首次写之间的空窗照样兜住），
//     把「读到半个 JSON → 误判陈锁接管」的窗口基本关死。

import fs from 'node:fs';
import path from 'node:path';

/** 读方遇坏 JSON 的退避时长：远大于一次小文件写入（微秒级），远小于心跳陈锁阈值。 */
export const LOCK_READ_RETRY_MS = 80;

// 同线程短睡。Atomics.wait 的语义：仅当 cell 当前值等于期望值才阻塞，否则立即
// "not-equal" 返回——cell 必须预置成与期望值一致（此处恒 1，无人 notify，按超时
// 睡满）。零填充缓冲区配 true/1 期望值的旧写法恒 not-equal 空睡（feature-branch.mjs
// 同款历史病灶，2026-11-15 随锁心跳修复一并纠正）。
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
SLEEP_CELL[0] = 1;

/** 同线程短睡（主线程阻塞期间 libuv 线程池照常转）。 */
export function sleepSyncMs(ms) {
  Atomics.wait(SLEEP_CELL, 0, 1, ms);
}

// tmp 文件名序号（进程内递增）+ 随机段：同目录同刻多写者不互撞。
let tmpSeq = 0;

/**
 * 原子覆盖写（tmp + rename）。tmp 与目标同目录（跨卷 rename 退化为拷贝，失去原子性）；
 * rename 失败退避重试一次，二次失败向外抛，由统一 catch 清理 tmp 后返回 false。
 * @returns {boolean} 是否落盘成功（false = 本次写被丢弃，目标保持上一拍内容）
 */
export function writeLockAtomic(p, data) {
  const tmp = path.join(
    path.dirname(p),
    `.${path.basename(p)}.${process.pid}.${Date.now()}.${++tmpSeq}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  try {
    fs.writeFileSync(tmp, data);
    try {
      fs.renameSync(tmp, p);
    } catch {
      // win：目标被读句柄/杀软占用时 rename 报 EPERM/EBUSY——重试一次
      sleepSyncMs(50);
      fs.renameSync(tmp, p);
    }
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 唯一命名不碍事，残骸等下一位写者 */ }
    return false;
  }
}

/**
 * 读锁 JSON：文件不存在（或读不了）返回 null；内容损坏先按 LOCK_READ_RETRY_MS 退避
 * 重读一次，仍坏才返回 null（调用方按损坏锁 = 陈锁处理）。返回值与旧 readLock 语义
 * 兼容：null = 无锁或损坏。
 */
export function readLockJson(p) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return null; // 无锁 ≠ 损坏：不重读
  }
  try {
    return JSON.parse(text);
  } catch { /* 瞬时坏 JSON（写窗口）：退避后重读再定 */ }
  sleepSyncMs(LOCK_READ_RETRY_MS);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

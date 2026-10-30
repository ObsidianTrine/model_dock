// events.mjs — orchestrator 事件日志（append-only JSONL）。
// 一份 events.jsonl 同时服务三个用途：崩溃恢复（重建上下文）、成本核算
// （budget_snapshot 累计）、Phase 3 质量漂移统计。设计见 docs 5.4。

import fs from 'node:fs';
import path from 'node:path';

/** ISO8601 带本地时区（如 2026-10-01T14:30:00.123+08:00），比 UTC Z 更贴合人读。 */
export function toIsoLocal(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${oh}:${om}`
  );
}

export function logDir(repoRoot, taskId) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'logs', taskId);
}

function eventsFile(dir) {
  return path.join(dir, 'events.jsonl');
}

/** 读取全部事件（容错：进程被杀可能留下最后半行，跳过不完整行不抛错）。 */
export function readEvents(dir) {
  const f = eventsFile(dir);
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 半行/损坏行：只可能是崩溃残留的最后一行，忽略
    }
  }
  return events;
}

export function lastSeq(dir) {
  const evts = readEvents(dir);
  return evts.length ? evts[evts.length - 1].seq : 0;
}

// appendEvent 的 seq 缓存（agents-hygiene-batch）：worker 每 turn 两条事件、长任务累计数百条，
// 逐条经 lastSeq 全文件重读重解析是 O(n²) 写放大。进程内缓存自增，未命中才落盘对齐——
// 读侧 lastSeq/readEvents 保持全量读（崩溃恢复语义不变）；task-lock 接管陈锁时经
// invalidateSeqCache 清一次对应目录的缓存，防同任务跨进程双写 seq 冲突。
const seqCache = new Map();

/** 清除目录的 seq 缓存：下一次 appendEvent 重新从盘上对齐真实 seq（task-lock 接管陈锁时调用）。 */
export function invalidateSeqCache(dir) {
  seqCache.delete(dir);
}

/** 追加一个事件（seq 自动单调递增；同步 append 一整行，避免交错）。 */
export function appendEvent(dir, type, fields = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let seq = seqCache.get(dir);
  if (seq === undefined) seq = lastSeq(dir);
  seq += 1;
  seqCache.set(dir, seq);
  const event = { ts: toIsoLocal(), seq, type, ...fields };
  fs.appendFileSync(eventsFile(dir), JSON.stringify(event) + '\n');
  return event;
}

/** 生成人类可读的时间线（status/logs 命令用）。 */
export function formatTimeline(events) {
  return events
    .map((e) => {
      const extra = Object.entries(e)
        .filter(([k]) => !['ts', 'seq', 'type'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      return `${e.seq}  ${e.ts}  ${e.type}${extra ? '  ' + extra : ''}`;
    })
    .join('\n');
}

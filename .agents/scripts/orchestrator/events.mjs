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

// ---------------------------------------------------------------------------
// 读侧事件折叠（批处理）：events.jsonl 本身 append-only 不动，只折叠读视图
// ---------------------------------------------------------------------------

/** 默认折叠的高频噪音型：逐 turn 两条（流式后端每个工具调用各一条），读侧只需要
 *  「发生过 N 次 + 最后一条长什么样」。其余类型不折叠——attempt/reason 等业务字段
 *  逐条都有信息量，折叠反而丢上下文。 */
export const COALESCE_TYPES = ['worker_turn', 'budget_snapshot'];

/**
 * 连续同型事件折叠成事件形状的视图对象（ts 取末条、附 count / first_ts），供
 * formatTimeline / watchdogTimelineSummary 等既有格式化器直接消费。只折叠 types
 * 白名单内的连续段；非白名单事件原样透传（视图返回原事件对象）。maxEntries 对
 * 折叠后的视图做尾部截取（控制在读侧 prompt 预算内）。
 */
export function coalesceEvents(events, { types = COALESCE_TYPES, maxEntries = Infinity } = {}) {
  const set = new Set(types);
  const groups = [];
  for (const e of events ?? []) {
    const prev = groups[groups.length - 1];
    if (prev && prev.type === e.type && set.has(e.type)) {
      prev.count += 1;
      prev.lastTs = e.ts ?? prev.lastTs;
      prev.sample = e;
    } else {
      groups.push({ type: e?.type ?? 'unknown', count: 1, firstTs: e.ts, lastTs: e.ts, sample: e });
    }
  }
  const view = groups.map((g) => {
    if (g.count === 1) return g.sample;
    const { seq, ...rest } = g.sample ?? {};
    return { ts: g.lastTs, seq, type: g.type, count: g.count, first_ts: g.firstTs, ...rest };
  });
  return view.length > maxEntries ? view.slice(-maxEntries) : view;
}

// ---------------------------------------------------------------------------
// follow-up inbox（订阅直通）：运行中任务的中途补充指令
// ---------------------------------------------------------------------------

function inboxFile(dir) {
  return path.join(dir, 'inbox.md');
}

/** 追加一条补充指令（`## <ts>` 分段；append 单次写，与 events.jsonl 同样的原子性假设）。 */
export function appendInbox(dir, text, ts = toIsoLocal()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(inboxFile(dir), `\n## ${ts}\n${String(text).trimEnd()}\n`);
}

/**
 * 读 inbox 条目（[{ts, text}]），按 `## ` 分段解析；无头的裸内容（手写 inbox）视作
 * 单条匿名条目。尾部截取：条数与总字符双上限——注入段拼在 prompt 尾部，zcode argv
 * 30000 字符上限的预算要留给任务本体。
 */
export function readInbox(dir, { maxEntries = 20, maxChars = 4000 } = {}) {
  const f = inboxFile(dir);
  if (!fs.existsSync(f)) return [];
  const entries = [];
  let cur = null;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (line.startsWith('## ')) {
      if (cur) entries.push(cur);
      cur = { ts: line.slice(3).trim(), text: [] };
    } else if (cur) {
      cur.text.push(line);
    } else if (line.trim()) {
      cur = { ts: '', text: [line] };
    }
  }
  if (cur) entries.push(cur);
  const norm = entries.map((e) => ({ ts: e.ts, text: e.text.join('\n').trim() })).filter((e) => e.text);
  let tail = norm.slice(-maxEntries);
  let total = tail.reduce((n, e) => n + e.text.length, 0);
  while (tail.length > 1 && total > maxChars) {
    total -= tail[0].text.length;
    tail = tail.slice(1);
  }
  return tail;
}

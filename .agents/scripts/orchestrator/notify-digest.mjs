// notify-digest.mjs — 编排通报 digest 聚合器：把逐事件直发收敛成批量聚合通报。
// 动机：逐事件直发是「一堆乱消息」——一次 drain 落位 N 张卡手机收 N 条。digest 把
// 一个时间窗内的事件聚成一条「三段式」通报（核心信息 + 事件 + 流程中间状态）。
//
// 数据流：各通知落点 queueDigestItem() 追加事件到 pending.jsonl → 三个 flush 触发源：
//   1. attention 级事件（awaiting-human 待批示 / blocked 熔断）——调用方立即同步 flush，
//      不进静默窗（需要人看见的信号不等人）
//   2. 落位后的 detached flush 子进程（CLI `notify-digest --flush`）——先睡
//      notify.digest.quietWindowSec 再 flush，天然形成 60s 静默窗：窗内多条落位
//      合并成一条（maybeSpawnDigestFlush 的 marker 去重保证窗口内只睡一个子进程）
//   3. 长跑收口（drain 收官 / sail 收帆 / nightly 收尾）——force flush 兜底，
//      队列里的存量不跨夜
// flush 是「认领」语义：读到非空队列先清文件再发——并发 flusher 只有一家拿到内容，
// 重复 flush 最多空转不发，绝不双发同一条事件。
// 聚合规则：同一 taskId 的多条事件合并为一行终态（pending→merged 只留 merged，
// STATE_RANK 定终态序；同级后到覆盖——终态消息带更具体的动作说明）。
// 纯函数（aggregateDigest / buildDigestBody / digestTitle / digestStateRank）零 IO，
// 单测直接驱动；IO 函数全部尽力而为——digest 任何故障不影响编排本身。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { notify, orchWebhookEnvs, taskStateTag } from './notify.mjs';
import { toIsoLocal } from './events.mjs';
import { listCards, queueRoot, STATES } from './queue.mjs';
import { listSpecs } from './spec.mjs';
import { loadWorkflowConfig, displayProjectName } from '../workflow-config.mjs';

/** digest 工作目录：.agents/orchestrator/notify-digest/（pending.jsonl + flush-inflight marker）。 */
export function digestDir(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'notify-digest');
}

/** 待发事件队列（JSONL，一行一条）。 */
export function digestPendingPath(repoRoot) {
  return path.join(digestDir(repoRoot), 'pending.jsonl');
}

/** 在飞 flusher 标记（maybeSpawnDigestFlush 静默窗去重用；陈标记按 mtime 年龄自然过期）。 */
export function digestFlushMarkerPath(repoRoot) {
  return path.join(digestDir(repoRoot), 'flush-inflight');
}

/** 原子写（tmp + rename）：flush-inflight marker 落盘用，半行/截断文件不可见。 */
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * 追加一条 digest 事件。item = { kind: 'task'|'review'|'autoapprove'|'research'|'spec'|'other',
 * taskId?, state?, title, lines?: string[], priority?: 'normal'|'attention' }。
 * ts 由本函数盖戳（事件行 HH:mm 与终态排序的数据源）；未知 kind/priority 容错归一。
 * 返回归一后的记录（测试断言用）。
 *
 * 并发语义：fs.appendFileSync 真追加（O_APPEND 单行 JSONL）——drain --workers N 下多个 run
 * 子进程同时落位时各自整行追加，不会像「读全文+原子整写」那样以后写者旧快照覆盖前写者丢
 * 事件。这是尽力而为面内的收敛（常规本地文件系统上单行追加行级不可分割，但多行交错/损坏行
 * 由 flush 侧跳过兜底），不承诺强一致。
 */
export function queueDigestItem(repoRoot, item) {
  const rec = {
    ts: toIsoLocal(),
    kind: String(item?.kind ?? 'other'),
    ...(item?.taskId ? { taskId: String(item.taskId) } : {}),
    ...(item?.state ? { state: String(item.state) } : {}),
    title: String(item?.title ?? '').trim() || '未命名事件',
    lines: Array.isArray(item?.lines) ? item.lines.map((l) => String(l)).filter(Boolean) : [],
    priority: item?.priority === 'attention' ? 'attention' : 'normal',
  };
  const file = digestPendingPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
  return rec;
}

/** 卡状态 → 终态序（越大越「终」）：合并终态行时按此留最强者；未知状态按普通事件处理。 */
const STATE_RANK = {
  pending: 0,
  running: 1,
  reviewing: 2,
  'awaiting-human': 3,
  failed: 4,
  blocked: 4,
  merged: 5,
};

/** 事件的终态序：有 state 按 STATE_RANK，无 state 的 attention 视作高优、其余按普通事件。 */
export function digestStateRank(item) {
  if (item?.state && item.state in STATE_RANK) return STATE_RANK[item.state];
  return item?.priority === 'attention' ? 4 : 1;
}

/**
 * 聚合：同一 taskId 的多条事件合并为一行终态（跳过中间态——pending→merged 只留 merged）；
 * 无 taskId 的事件（research/spec/other 各自独立对象）逐条保留。输出顺序按各组首次出现序，
 * 组内代表 = STATE_RANK 最大者、同级后到覆盖（终态消息动作说明更具体）。
 */
export function aggregateDigest(items) {
  const list = Array.isArray(items) ? items : [];
  const groups = new Map();
  const order = [];
  list.forEach((it, i) => {
    const key = it?.taskId ? `t:${it.taskId}` : `s:${i}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(it);
  });
  const out = [];
  for (const key of order) {
    const group = groups.get(key);
    let best = group[0];
    for (const it of group.slice(1)) {
      if (digestStateRank(it) >= digestStateRank(best)) best = it;
    }
    out.push(best);
  }
  return out;
}

/** 队列七目录计数（running 段并入 reviewing——对用户是同一「在跑」概念）。 */
function queueCounts(repoRoot) {
  const root = queueRoot(repoRoot);
  const n = (s) => {
    try {
      return listCards(root, s).length;
    } catch {
      return 0;
    }
  };
  const c = {};
  for (const s of STATES) c[s] = n(s);
  return { ...c, running: c.running + c.reviewing };
}

/** 规格进度行数据：读 specs/<id>/progress.json（无 build 的规格没有 progress，跳过）。 */
function specProgress(repoRoot) {
  const root = queueRoot(repoRoot);
  const out = [];
  for (const id of listSpecs(repoRoot)) {
    const p = path.join(root, '..', 'specs', id, 'progress.json');
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const tasks = Array.isArray(j.tasks) ? j.tasks : [];
      if (tasks.length) out.push({ id, tasks: tasks.map((t) => ({ n: t.n, status: String(t.status ?? 'pending') })) });
    } catch {
      // progress 缺失/损坏：该规格不进流程状态段（尽力而为）
    }
  }
  return out;
}

/** 规格进度行的紧凑状态记号（纯文本、不用飞书 md）：t1 ✅merged t2 ⏳awaiting-human。 */
const PROGRESS_GLYPH = {
  pending: '○',
  running: '▶',
  reviewing: '🔍',
  'awaiting-human': '⏳',
  merged: '✅',
  failed: '✗',
  blocked: '⚠',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** ts → HH:mm。digest 事件的 ts 全部由 queueDigestItem 经 toIsoLocal 盖戳（本地钟面），
 *  直接取字符串的 T 后两位钟——不經 Date 时区换算，跨时区机器上与落位本地钟一致；
 *  非 ISO 形态回退 Date 解析，解析失败回退 '--:--'（坏时间戳不炸通知）。 */
function hhmm(ts) {
  const m = /T(\d{2}:\d{2})/.exec(String(ts ?? ''));
  if (m) return m[1];
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '--:--' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 通知标题：【<项目名> 编排通报】<MM-DD HH:mm>（本地时间）。 */
export function digestTitle(projectName, now = new Date()) {
  return `【${projectName || '编排'} 编排通报】${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/** 单条事件行：「HH:mm <卡/对象> <一句话>」——描述段截 40 字，一行说一件事。 */
function eventLineOf(it) {
  const detail = Array.isArray(it?.lines) && it.lines.length ? ` ${String(it.lines[0]).slice(0, 40)}` : '';
  return `${hhmm(it?.ts)} ${String(it?.title ?? '')}${detail}`;
}

/** 正文行预算：三段式整体 ≤30 行，超出截 29 行 + 「…」（核心段在最前，截断保核心）。 */
const BODY_LINE_BUDGET = 30;

/**
 * 三段式正文（纯函数，固定顺序、每段可空）：
 *   ■ 核心：<attention 项逐条；无则一句总结（本批 N 事件，无需动作/需要动作 X）>
 *   ■ 事件
 *     · HH:mm <卡/对象> <一句话>
 *   ■ 流程状态
 *     规格 <id>：t1 ✅merged t2 ⏳awaiting-human …
 *     队列：pending N · running N · awaiting-human N · blocked N · merged M(+k)
 * counts 缺省 null（无队列可数时核心总结退「无需动作」）；specs 为 specProgress 形状。
 */
export function buildDigestBody({ items, counts = null, specs = [], now = new Date() } = {}) {
  const ev = aggregateDigest(items);
  const attention = ev.filter((it) => it?.priority === 'attention');
  const lines = [];

  // ■ 核心：attention 逐条；无则按队列存量一句总结（要不要人动作一眼可见）
  const attentionText = attention.map((it) => eventLineOf(it));
  if (attentionText.length) {
    lines.push(`■ 核心：${attentionText[0].slice(0, 60)}`);
    for (const t of attentionText.slice(1)) lines.push(`  · ${t.slice(0, 60)}`);
  } else {
    const needs = counts ? ['awaiting-human', 'blocked'].filter((s) => Number(counts[s]) > 0) : [];
    const action = needs.length
      ? needs.map((s) => `${s === 'awaiting-human' ? '待批示' : '搁浅'} ${counts[s]}`).join('、')
      : null;
    lines.push(`■ 核心：本批 ${ev.length} 事件，${action ? `需要动作：${action}` : '无需动作'}`);
  }

  // ■ 事件：每条一行（终态已合并），无事件整段省略
  if (ev.length) {
    lines.push('■ 事件');
    for (const it of ev) lines.push(`  · ${eventLineOf(it)}`);
  }

  // ■ 流程状态：规格进度锚 + 队列计数，两行都无数据整段省略
  const specLines = (Array.isArray(specs) ? specs : []).map((s) => {
    const tasks = s.tasks.slice(0, 8).map((t) => `t${t.n} ${PROGRESS_GLYPH[t.status] ?? '○'}${t.status}`).join(' ');
    return `  规格 ${s.id}：${tasks}${s.tasks.length > 8 ? ` …共 ${s.tasks.length} 个` : ''}`;
  });
  if (specLines.length || counts) {
    lines.push('■ 流程状态');
    lines.push(...specLines);
    if (counts) {
      const mergedBatch = ev.filter((it) => it?.state === 'merged').length;
      const mergedText = `merged ${counts.merged ?? 0}${mergedBatch ? `(+${mergedBatch})` : ''}`;
      lines.push(`  队列：pending ${counts.pending ?? 0} · running ${counts.running ?? 0} · awaiting-human ${counts['awaiting-human'] ?? 0} · blocked ${counts.blocked ?? 0} · ${mergedText}`);
    }
  }

  return lines.length > BODY_LINE_BUDGET ? [...lines.slice(0, BODY_LINE_BUDGET - 1), '…'].join('\n') : lines.join('\n');
}

/**
 * 冲刷待发队列并聚合发送。读到非空队列先清文件（认领语义：并发 flusher 只有一家拿到
 * 内容，重复调用空转不发）→ 聚合（同卡终态合并）→ 组三段式正文 → 经 notify() 发
 * orchWebhookEnvs 通道。force=false 时若在飞 flusher 标记很新（静默窗内），让位给它
 * （窗内事件由它合并发送）；长跑收口与 attention 即发一律 force=true。
 * dryRun 不发网不响系统通知，返回将发送的 title/body（测试用）。
 * @returns { sent, title?, body?, delivered?, reason? }
 */
export async function flushDigest(repoRoot, { force = false, dryRun = false, now = new Date(), quietWindowSec = 60 } = {}) {
  try {
    const file = digestPendingPath(repoRoot);
    if (!fs.existsSync(file)) return { sent: false, reason: 'empty' };
    const items = [];
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        items.push(JSON.parse(l));
      } catch {
        // 损坏行（并发写窗口期残留）：跳过，不影响其余事件
      }
    }
    if (!items.length) return { sent: false, reason: 'empty' };
    if (!force) {
      try {
        const marker = digestFlushMarkerPath(repoRoot);
        if (fs.existsSync(marker) && Date.now() - fs.statSync(marker).mtimeMs < quietWindowSec * 1000) {
          return { sent: false, reason: 'inflight' }; // 在飞 flusher 会把本批一起发
        }
      } catch {
        // marker 判定失败：照发（尽力而为，宁多发不丢发）
      }
    }
    fs.rmSync(file, { force: true }); // 认领：先清队列再发送
    const cfg = loadWorkflowConfig(repoRoot);
    const body = buildDigestBody({ items, counts: queueCounts(repoRoot), specs: specProgress(repoRoot), now });
    const title = digestTitle(displayProjectName(cfg.projectName ?? ''), now);
    const r = await notify({ title, body, dryRun, webhookEnvs: orchWebhookEnvs(repoRoot), repoRoot });
    return { sent: !dryRun && r.delivered.length > 0, title, body, delivered: r.delivered };
  } catch (e) {
    return { sent: false, reason: String(e?.message ?? e) };
  }
}

/**
 * 静默窗秒数（三态口径）：显式 0 = 无静默窗（合法域，窗内不等待立即冲刷）；undefined/非法值
 * 回落缺省 60。2026-11-10 修复——此前消费点 `Number(x) > 0 ? x : 60` 把配置 0 误当缺省，
 * 「配置无静默窗」实际得到 60s。上限 3600 与 workflow-config 解析层一致。
 */
export function quietWindowSecOf(v, fallback = 60) {
  return Number.isInteger(v) && v >= 0 && v <= 3600 ? v : fallback;
}

/**
 * 落位后拉起一次性 detached flush 子进程（60s 静默窗）：睡满 quietWindowSec 再 flush——
 * 窗内后续落位被同一子进程合并发送。静默窗去重：marker mtime 在窗内 = 已有在飞 flusher
 * （它醒来会读到本批），不重复拉起。digest 未启用或队列空 = 零开销直接返回。
 * 与 maybeSpawnAutoApproveSweep 同款 detach + unref：调用方退出不受影响。
 */
export function maybeSpawnDigestFlush(repoRoot, cfg) {
  try {
    const digest = cfg?.notify?.digest;
    if (!digest?.enabled) return false;
    const file = digestPendingPath(repoRoot);
    if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').trim()) return false;
    const windowMs = quietWindowSecOf(digest.quietWindowSec) * 1000;
    const marker = digestFlushMarkerPath(repoRoot);
    try {
      if (fs.existsSync(marker) && Date.now() - fs.statSync(marker).mtimeMs < windowMs) return false;
    } catch { /* marker 判定失败：照拉起（宁多一个空转子进程不丢通知） */ }
    atomicWriteText(marker, `${toIsoLocal()}\n`);
    spawn(process.execPath, [path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs'), 'notify-digest', '--flush'], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    }).unref();
    return true;
  } catch {
    return false; // 尽力而为：拉起失败不影响落位流程（长跑收口 flush 兜底）
  }
}

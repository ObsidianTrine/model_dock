// notify-digest.mjs — 编排通报 digest 聚合器：把逐事件直发收敛成批量聚合通报。
// 动机：逐事件直发是「一堆乱消息」——一次 drain 落位 N 张卡手机收 N 条。digest 把
// 一个时间窗内的事件聚成一条扁平通报（2026-11-10 改版，弃三段式「核心/事件/流程状态」；
// Claude Code hooks 通知哲学：一条通知=事件+一句话，标题分诊，细节落文件）：
//   标题  【<项目名>】<emoji 计数摘要>——✅合并 · ⏸待批 · ⛔阻塞 · 📄事件，只列非零项
//   正文  ≤4 行扁平事件流，每行 `emoji 对象 动作(关键数字)` ≤50 字；超行保 attention 折叠余量
//   尾行  📋 规格进度（本批带 specId 才出）+ 📄 详情文件指针（本批完整 JSON 落 last.txt）
//
// 数据流：各通知落点 queueDigestItem() 追加事件到 pending.jsonl → 三个 flush 触发源：
//   1. attention 级事件（awaiting-human 待批示 / blocked 熔断）——调用方立即同步 flush，
//      不进静默窗（需要人看见的信号不等人）
//   2. 落位后的 detached flush 子进程（CLI `notify-digest --flush`）——先睡
//      notify.digest.quietWindowSec 再 flush，天然形成 60s 静默窗：窗内多条落位
//      合并成一条（maybeSpawnDigestFlush 的 marker 去重保证窗口内只睡一个子进程）
//   3. 长跑收口（drain 收官 / sail 收帆 / nightly 收尾）——force flush 兜底，
//      队列里的存量不跨夜
// flush 是「认领」语义：先把 pending 原子 rename 成 claiming 文件（同目录 rename 原子，
// 并发 flusher 只有认领成功的一家拿到内容；投递失败 rename 回 pending 不丢事件）——
// 重复 flush 最多空转不发，绝不双发同一条事件。
// 聚合规则：同一 taskId 的多条事件合并为一行终态（pending→merged 只留 merged，
// STATE_RANK 定终态序；同级后到覆盖——终态消息带更具体的动作说明）。
// 纯函数（aggregateDigest / buildDigestBody / digestTitle / digestStateRank）零 IO，
// 单测直接驱动；IO 函数全部尽力而为——digest 任何故障不影响编排本身。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { notify, orchWebhookEnvs, taskStateTag } from './notify.mjs';
import { logDir, readEvents, toIsoLocal } from './events.mjs';
import { queueRoot } from './queue.mjs';
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

/** 本批详情档（完整 JSON；flush 时由认领文件原子 rename 归档）——通知「📄 详情」行的落点。 */
export function digestLastPath(repoRoot) {
  return path.join(digestDir(repoRoot), 'last.txt');
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
 * taskId?, state?, specId?, title, lines?: string[], priority?: 'normal'|'attention' }。
 * specId 可选：本批涉及规格时由调用方带上（flush 正文尾行据此读 specs/<id>/progress.json）。
 * ts 由本函数盖戳（终态排序与事件留档的数据源）；未知 kind/priority 容错归一。
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
    ...(item?.specId ? { specId: String(item.specId) } : {}),
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

/** 规格进度数据：读 specs/<id>/progress.json（无 build 的规格没有 progress，跳过）。 */
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
      // progress 缺失/损坏：该规格不进规格尾行（尽力而为）
    }
  }
  return out;
}

/**
 * 通知标题（标题分诊）：【<项目名>】<emoji 计数摘要>——✅合并数 · ⏸待批数 · ⛔阻塞数
 * （blocked 与 failed 都计）· 📄事件数（前三类之外的余量；纯 normal 批即全部事件），
 * 只列非零项，如 【ModelDock】✅2 · ⏸1；纯 normal 无动作批 = 【ModelDock】📄3 事件。
 * ev 为聚合后事件（flushDigest 传 aggregateDigest(items)；无 taskId 的 attention 兜底计
 * 入 📄——标题计数恒非空，真实批次 attention 必带 state，不触发该兜底）。
 */
export function digestTitle(projectName, ev = []) {
  const list = Array.isArray(ev) ? ev : [];
  const merged = list.filter((it) => it?.state === 'merged').length;
  const awaiting = list.filter((it) => it?.state === 'awaiting-human').length;
  const blocked = list.filter((it) => it?.state === 'blocked' || it?.state === 'failed').length;
  const other = list.length - merged - awaiting - blocked;
  const parts = [];
  if (merged) parts.push(`✅${merged}`);
  if (awaiting) parts.push(`⏸${awaiting}`);
  if (blocked) parts.push(`⛔${blocked}`);
  if (other) parts.push(`📄${other} 事件`);
  return `【${projectName || '编排'}】${parts.join(' · ')}`;
}

/** 事件行宽护栏：单行 ≤50 字，超出截断并以 … 收尾（细节落 last.txt 不丢）。 */
const LINE_MAX = 50;
function clip(s) {
  s = String(s);
  return s.length > LINE_MAX ? `${s.slice(0, LINE_MAX - 1)}…` : s;
}

/**
 * 单条事件行（emoji 对象 动作(关键数字)，一行说一件事）：
 *   merged 卡 → ✅ <taskId> 合并（commit 前 7 位；flushDigest 从卡事件流补 commit 字段，无则不带括号）
 *   awaiting-human → ⏸ <taskId> 待批示（reason 前 20 字）——3 分钟未批将自动合并
 *   blocked/failed → ⛔ <taskId> <状态标签>（reason 前 20 字）
 *   其余（research/spec/autoapprove 中态/中间态卡等）→ 📄 <title 前 40 字>
 */
function eventLineOf(it) {
  const id = String(it?.taskId ?? '') || String(it?.title ?? '未命名事件');
  const reason = Array.isArray(it?.lines) && it.lines.length ? String(it.lines[0]) : '';
  if (it?.state === 'merged') {
    const commit = typeof it?.commit === 'string' && it.commit.trim() ? `（${it.commit.trim().slice(0, 7)}）` : '';
    return clip(`✅ ${id} 合并${commit}`);
  }
  if (it?.state === 'awaiting-human') {
    const why = reason ? `（${reason.slice(0, 20)}）` : '';
    return clip(`⏸ ${id} 待批示${why}——3 分钟未批将自动合并`);
  }
  if (it?.state === 'blocked' || it?.state === 'failed') {
    const why = reason ? `（${reason.slice(0, 20)}）` : '';
    return clip(`⛔ ${id} ${taskStateTag(it.state)}${why}`);
  }
  return clip(`📄 ${String(it?.title ?? '未命名事件').slice(0, 40)}`);
}

/** 正文事件流行预算：超过保留 attention 行 + 前 N 条 normal，余量折叠成一行提示。 */
const EVENT_LINE_BUDGET = 4;

/**
 * 扁平事件流正文（纯函数）：≤4 行事件（每行 emoji 对象 动作），超预算保留 attention 行 +
 * 前 N 条 normal，其余折叠一行 `…另 N 条见详情`；尾接规格进度行（本批 items 带 specId 且
 * specs 里查得到 progress 才出，`📋 规格 <id>：<n>/<总> ✅`）与详情文件行（digestDirPath
 * 给出才出，`📄 详情：<digestDir>/last.txt`——本批完整 JSON 由 flushDigest 归档 last.txt）。
 */
export function buildDigestBody({ items, specs = [], digestDirPath = null } = {}) {
  const ev = aggregateDigest(items);
  const attnLines = ev.filter((it) => it?.priority === 'attention').map(eventLineOf);
  const normLines = ev.filter((it) => it?.priority !== 'attention').map(eventLineOf);
  const lines = [];
  if (attnLines.length + normLines.length <= EVENT_LINE_BUDGET) {
    lines.push(...attnLines, ...normLines);
  } else {
    const keep = EVENT_LINE_BUDGET - 1; // 留 1 行折叠提示
    const keptAttn = attnLines.slice(0, keep);
    const keptNorm = normLines.slice(0, Math.max(0, keep - keptAttn.length));
    const folded = attnLines.length - keptAttn.length + (normLines.length - keptNorm.length);
    lines.push(...keptAttn, ...keptNorm, `…另 ${folded} 条见详情`);
  }
  const specId = (Array.isArray(items) ? items : []).find((it) => it?.specId)?.specId;
  if (specId) {
    const sp = (Array.isArray(specs) ? specs : []).find((s) => s?.id === specId);
    if (sp && Array.isArray(sp.tasks) && sp.tasks.length) {
      const done = sp.tasks.filter((t) => t?.status === 'merged').length;
      lines.push(`📋 规格 ${specId}：${done}/${sp.tasks.length} ✅`);
    }
  }
  if (digestDirPath) lines.push(`📄 详情：${digestDirPath}/last.txt`);
  return lines.join('\n');
}

/** 卡 merge_commit（尽力而为）：卡事件流最后一条 merged 事件的 merge_commit 前 7 位；读不到回空串。 */
function mergeCommitOf(repoRoot, taskId) {
  try {
    const evts = readEvents(logDir(repoRoot, String(taskId)));
    for (let i = evts.length - 1; i >= 0; i--) {
      const c = evts[i]?.type === 'merged' ? evts[i]?.merge_commit : undefined;
      if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 7);
    }
  } catch {
    // 事件流缺失/损坏：merged 行尾不带括号（尽力而为）
  }
  return '';
}

/**
 * 冲刷待发队列并聚合发送。pending 先原子 rename 成 claiming 文件（认领语义：并发 flusher
 * 只有一家拿到内容；投递失败 rename 回 pending 不丢事件）→ merged 事件补 commit（读卡
 * 事件流）→ 聚合（同卡终态合并）→ 组扁平通报 → 经 notify() 发 orchWebhookEnvs 通道。
 * force=false 时若在飞 flusher 标记很新（静默窗内），让位给它（窗内事件由它合并发送）；
 * 长跑收口与 attention 即发一律 force=true。送达后认领文件原子 rename 归档为
 * last.txt（通知「📄 详情」指针的落点，本批完整 JSON）。
 * dryRun 不发网不响系统通知，返回将发送的 title/body（测试用）；且不消费队列——事件写回
 * pending 不归档（round5 修复：dry-run 只是预览，实发时同批再发；round4 曾误删 claimed
 * 文件把事件消费掉，与「dry-run 不消费」注释相反）。
 * @returns { sent, title?, body?, delivered?, reason? }
 */
export async function flushDigest(repoRoot, { force = false, dryRun = false, quietWindowSec = 60 } = {}) {
  try {
    const file = digestPendingPath(repoRoot);
    if (!fs.existsSync(file)) {
      // pending 不存在：真空队，或已被并发 flusher 原子认领（claiming 文件在场即证明）
      const dir = path.dirname(file);
      const claimedOut = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.startsWith(`${path.basename(file)}.claiming-`))
        : [];
      if (claimedOut.length) return { sent: false, reason: 'inflight' };
      return { sent: false, reason: 'empty' };
    }
    // 原子认领（round4 P2：此前 read→rm 两步之间并发 flusher 可各自读到同批而双发）——
    // 同目录 rename 原子，认领失败=并发对手拿走了本批
    const claimed = `${file}.claiming-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(file, claimed);
    } catch (e) {
      if (e?.code === 'ENOENT') return { sent: false, reason: 'inflight' };
      return { sent: false, reason: `claim failed: ${e?.message ?? e}` };
    }
    // 投递失败/异常时 rename 回 pending——事件不丢，下次 flush 再试（round4 P2）
    const restore = () => { try { fs.renameSync(claimed, file); } catch { /* 已被并发接走：尽力而为面 */ } };
    // 本批完整 JSON 归档 last.txt：认领文件直接 rename 复用（零拷贝原子覆盖旧档）；
    // rename 失败（如 Windows 下详情档被占用）回退删除——归档是尽力而为面，不影响发送
    const archive = () => {
      try {
        fs.renameSync(claimed, digestLastPath(repoRoot));
      } catch {
        try { fs.rmSync(claimed, { force: true }); } catch { /* 尽力而为 */ }
      }
    };
    let items = [];
    try {
      for (const l of fs.readFileSync(claimed, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try {
          items.push(JSON.parse(l));
        } catch {
          // 损坏行（并发写窗口期残留）：跳过，不影响其余事件
        }
      }
      if (!items.length) {
        fs.rmSync(claimed, { force: true });
        return { sent: false, reason: 'empty' };
      }
      if (!force) {
        try {
          const marker = digestFlushMarkerPath(repoRoot);
          if (fs.existsSync(marker) && Date.now() - fs.statSync(marker).mtimeMs < quietWindowSec * 1000) {
            restore();
            return { sent: false, reason: 'inflight' }; // 在飞 flusher 会把本批一起发
          }
        } catch {
          // marker 判定失败：照发（尽力而为，宁多发不丢发）
        }
      }
      // merged 事件补 commit（聚合代表行由此带 7 位短 commit；同卡对象引用共享，聚合可见）
      for (const it of items) {
        if (it?.state === 'merged' && it?.taskId) it.commit = mergeCommitOf(repoRoot, it.taskId);
      }
      const cfg = loadWorkflowConfig(repoRoot);
      const body = buildDigestBody({ items, specs: specProgress(repoRoot), digestDirPath: digestDir(repoRoot) });
      const title = digestTitle(displayProjectName(cfg.projectName ?? ''), aggregateDigest(items));
      const r = await notify({ title, body, dryRun, webhookEnvs: orchWebhookEnvs(repoRoot), repoRoot });
      const delivered = !dryRun && r.delivered.length > 0;
      if (delivered) archive(); // 送达：认领文件转 last.txt 详情档
      else restore(); // 无通道/投递失败/dry-run：事件写回 pending 不消费不归档——dry-run 只是预览，实发时同批再发（round5 修复）
      return { sent: delivered, title, body, delivered: r.delivered, count: items.length, ...(delivered ? {} : { reason: dryRun ? 'dry-run' : 'no-channel' }) };
    } catch (e) {
      restore();
      return { sent: false, reason: String(e?.message ?? e), count: items.length };
    }
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

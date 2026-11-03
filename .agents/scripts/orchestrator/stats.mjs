// stats.mjs — 运行度量收集（stats 命令与 propose 舰队反馈共用的数据层）。
// collectStatsSummary：从每卡 events.jsonl 聚合 rows + summary（与 stats 命令输出
// 同源同口径），外加舰队反馈用的 perType 分类型消化数据与 drift 降级状态。
// 纯只读：drift 状态用 readDegraded（不碰 evaluateDrift 的写降级标记副作用），
// 收集过程零写盘、零 git 调用。

import fs from 'node:fs';
import path from 'node:path';
import { queueRoot, findCard, listCards, STATES, parseCard } from './queue.mjs';
import { readEvents } from './events.mjs';
import { readDegraded } from './drift.mjs';

// 与 orchestrator.mjs 的 debugIterations/reviewIterations 同口径（那边被 run 循环共用
// 不迁移；此处独立实现，事件名改动须两处同步）。
const debugIterations = (events) => events.filter((e) => e.type === 'debug_iteration').length;
const reviewIterations = (events) => events.filter((e) => e.type === 'review_iteration').length;

/**
 * 收集运行度量（stats 命令与 propose 舰队反馈共用）。
 * 返回 { days, rows, windowsById, summary, perType, drift }：
 * - rows / windowsById / summary：与 cmdStats 现口径逐字段、逐属性序一致（summary 不含
 *   --cost 附加字段，那部分由 cmdStats 自行追加）；--json 输出形态不许变的红线靠这里守住。
 * - perType：各 type 卡的消化数据（merged 率 / merged 平均 wall / merged 平均 token 峰值，
 *   舰队反馈用，不进 stats 输出）。
 * - drift：质量漂移降级标记（readDegraded 只读；null = 未降级）。
 * 调用方负责 ensureQueue（cmdStats / cmdPropose 都已保证）；不保证时 listCards 对缺失
 * 目录返回空、不抛错。
 */
export function collectStatsSummary(repoRoot, { days = 7 } = {}) {
  const root = queueRoot(repoRoot);
  const logsRoot = path.join(repoRoot, '.agents', 'orchestrator', 'logs');
  let taskIds = [];
  try {
    taskIds = fs.readdirSync(logsRoot).filter((id) => fs.existsSync(path.join(logsRoot, id, 'events.jsonl')));
  } catch { /* logs/ 不存在 = 还没跑过任何任务 */ }

  const since = Date.now() - days * 86_400_000;
  const rows = [];
  const windowsById = new Map(); // id → {start, end}（--cost 燃油投影用；不进 --json 行）
  for (const id of taskIds) {
    const events = readEvents(path.join(logsRoot, id));
    if (!events.length) continue;
    const accepted = events.find((e) => e.type === 'task_accepted');
    const start = Date.parse(accepted?.ts ?? events[0].ts);
    if (Number.isFinite(start) && start < since) continue; // 只统计最近 N 天启动的任务
    const found = findCard(root, id);
    let createdBy = '', type = '', gate = '';
    if (found) {
      try {
        const { meta } = parseCard(fs.readFileSync(found.path, 'utf8'), found.path);
        createdBy = meta.created_by ?? '';
        type = meta.type ?? '';
        gate = meta.gate ?? '';
      } catch { /* 损坏卡：度量照出，元信息留空 */ }
    }
    const terminal = [...events].reverse().find((e) => ['merged', 'failed', 'blocked'].includes(e.type));
    const end = Date.parse(terminal?.ts ?? events[events.length - 1].ts);
    const peaks = events.filter((e) => e.type === 'budget_snapshot' && Number.isFinite(e.tokens_in)).map((e) => e.tokens_in);
    const count = (t) => events.filter((e) => e.type === t).length;
    rows.push({
      id,
      state: found?.state ?? '(日志残留)',
      created_by: createdBy,
      type,
      gate,
      outcome: terminal?.type ?? found?.state ?? 'unknown',
      wall_min: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 60000)) : null,
      turns: count('worker_turn'),
      debug_iter: debugIterations(events),
      review_iter: reviewIterations(events),
      retries: count('worker_retry'),
      watchdog_suspect: count('watchdog_suspect'),
      follow_ups: count('follow_up'),
      tokens_peak: peaks.length ? Math.max(...peaks) : 0,
      xte_alarms: count('xte_alarm'),
      incident: fs.existsSync(path.join(logsRoot, id, 'incident.md')) ? 1 : 0,
    });
    if (Number.isFinite(start) && Number.isFinite(end)) windowsById.set(id, { start, end });
  }

  const settled = rows.filter((r) => ['merged', 'failed', 'blocked'].includes(r.outcome));
  const mergedRows = rows.filter((r) => r.outcome === 'merged');
  const sum = (f) => rows.reduce((n, r) => n + (f(r) ?? 0), 0);
  const summary = {
    window_days: days,
    tasks_started: rows.length,
    queue: Object.fromEntries(STATES.map((s) => [s, listCards(root, s).length])),
    settled: settled.length,
    merged: mergedRows.length,
    merge_rate: settled.length ? Math.round((mergedRows.length / settled.length) * 100) / 100 : null,
    avg_merged_wall_min: mergedRows.length ? Math.round(mergedRows.reduce((n, r) => n + (r.wall_min ?? 0), 0) / mergedRows.length) : null,
    total_turns: sum((r) => r.turns),
    total_debug_iter: sum((r) => r.debug_iter),
    total_review_iter: sum((r) => r.review_iter),
    total_retries: sum((r) => r.retries),
    total_watchdog_suspect: sum((r) => r.watchdog_suspect),
    total_follow_ups: sum((r) => r.follow_ups),
    total_tokens_peak: sum((r) => r.tokens_peak),
    // 安全晴雨表（near-miss）：险情比事故多——watchdog suspect / 瞬时重试 / 偏航报警 /
    // 事故调查包四类「差点出事」信号单独成表，供流程调优先于事故发生。
    near_miss: {
      watchdog: sum((r) => r.watchdog_suspect),
      retries: sum((r) => r.retries),
      xte: sum((r) => r.xte_alarms),
      incidents: sum((r) => r.incident),
    },
  };
  return { days, rows, windowsById, summary, perType: perTypeStats(rows), drift: readDegraded(repoRoot) };
}

/** 各 type 卡的消化数据（舰队反馈用）：merged 率 / merged 平均 wall / merged 平均 token 峰值。
 *  wall/token 只在 merged 样本上取平均（与全局 avg_merged_wall_min 同口径）；无 merged 样本为 null。 */
function perTypeStats(rows) {
  const groups = new Map();
  for (const r of rows) {
    const t = r.type || 'unknown';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(r);
  }
  const out = [];
  for (const [type, list] of groups) {
    const settled = list.filter((r) => ['merged', 'failed', 'blocked'].includes(r.outcome));
    const merged = list.filter((r) => r.outcome === 'merged');
    const avg = (f) => (merged.length ? Math.round(merged.reduce((n, r) => n + (f(r) ?? 0), 0) / merged.length) : null);
    out.push({
      type,
      started: list.length,
      settled: settled.length,
      merged: merged.length,
      merge_rate: settled.length ? Math.round((merged.length / settled.length) * 100) / 100 : null,
      avg_merged_wall_min: avg((r) => r.wall_min),
      avg_merged_tokens_peak: avg((r) => r.tokens_peak),
    });
  }
  out.sort((a, b) => b.merged - a.merged || b.started - a.started || (a.type < b.type ? -1 : 1));
  return out;
}

const fmtK = (n) => `${Math.round(n / 100) / 10}k`;

/**
 * 从 goals.md 全文摘「当前主题」段（首个匹配标题到下一个标题之间；去引用符）。
 * 无该段 / 空文本 = null（反馈段相应缺行，不硬凑）。截断 200 字符防 prompt 膨胀。
 */
export function extractGoalsThemes(goalsText) {
  const text = String(goalsText ?? '');
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s*(?:\*\*)?[^#\n]*当前主题/.test(l));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    const t = lines[i].trim().replace(/^>\s?/, '');
    if (t) out.push(t);
  }
  const joined = out.join('；');
  return joined ? joined.slice(0, 200) : null;
}

/**
 * 舰队反馈正文（只放数据事实，不写硬指令——priority 取舍由 planner 按数据自行判断）。
 * @param {object} p { summary, perType, drift, goalsThemes }：collectStatsSummary 的
 *   summary/perType/drift + extractGoalsThemes 的摘录；四项皆可缺（逐行降级）。
 */
export function buildFleetFeedback({ summary, perType, drift, goalsThemes } = {}) {
  const lines = [];
  const nm = summary?.near_miss ?? { watchdog: 0, retries: 0, xte: 0, incidents: 0 };
  if (summary && summary.tasks_started > 0) {
    const rate = summary.merge_rate;
    const wall = summary.avg_merged_wall_min !== null && summary.avg_merged_wall_min !== undefined ? `，merged 平均 wall ${summary.avg_merged_wall_min} 分钟` : '';
    lines.push(
      `- 运行画像：近 ${summary.window_days ?? 7} 天启动任务 ${summary.tasks_started} 个，终态 ${summary.settled}（merged ${summary.merged}），` +
        `合并率 ${rate === null || rate === undefined ? '-' : Math.round(rate * 100) + '%'}${wall}；` +
        `near-miss 四类计数：watchdog suspect ${nm.watchdog} / 瞬时重试 ${nm.retries} / 偏航报警 ${nm.xte} / 事故调查包 ${nm.incidents}。`
    );
  } else {
    lines.push('- 运行画像：近 7 天无任务启动数据（舰队尚无实测消化数据，priority 取舍无历史依据可参考）。');
  }
  if (perType?.length) {
    const parts = perType.map((t) => {
      const rate = t.merge_rate === null ? '无终态样本' : Math.round(t.merge_rate * 100) + '%';
      const wall = t.avg_merged_wall_min === null ? '-' : `${t.avg_merged_wall_min}m`;
      const tok = t.avg_merged_tokens_peak === null ? '-' : fmtK(t.avg_merged_tokens_peak);
      return `${t.type} ${rate}/${wall}/${tok}`;
    });
    lines.push(`- 各类型消化数据（merged 率 / merged 平均 wall / merged 平均 token 峰值）：${parts.join('；')}。`);
  }
  lines.push(drift ? `- 质量漂移：⚠ 降级中——${drift.reason ?? '自动合并回溯失败率超阈值'}（降级期间自动合并全部回人工闸门）。` : '- 质量漂移：正常（未降级）。');
  if (goalsThemes) lines.push(`- 目标面当前主题：${goalsThemes}`);
  return lines.join('\n');
}

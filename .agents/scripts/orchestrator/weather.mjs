// weather.mjs — 风暴闸（weather hold）：窗口期内瞬时故障计数与滞留判定。
// 背景（2026-10-29 夜跑实证）：GLM 并发上限被占满时 worker 连环 429，drain 仍逐卡
// 派发、逐卡烧成 blocked——风暴中应该收帆停派，等窗口滑过再出航。设计取向：
//   - 无状态：每次派发前现算窗口计数，不落 hold 标记文件——窗口滑过自动恢复，
//     不存在「标记忘了清」的次生故障。
//   - fleet 级事件（logs/fleet.jsonl）：跨任务的调度层留痕与任务 events.jsonl
//     分文件（任务线保持单任务语义），格式与任务事件同构（ts/seq/type）。
// 上游海况（countUpstreamStorm）：网关先于 worker 看到上游限流（任何 harness 的流量
// 都经它转发）——窗口内 429/402 合计达阈值同样滞留，风暴中比 worker 重试信号更早收帆。
// 零第三方依赖（.agents/ 工具链红线）。

import fs from 'node:fs';
import path from 'node:path';
import { toIsoLocal } from './events.mjs';
import { readGatewayLog } from './reconcile.mjs';

/**
 * 统计各任务 events 里窗口期内的 worker_retry 事件数合计。
 * @param {Array<{id?: string, events: Array<object>} | Array<object>>} allEvents
 *        每任务一项（{id, events} 或直接事件数组）；事件需含 type 与 ts。
 * @param {{windowMs: number, now?: number}} opts now 显式传入（纯函数，测试可注入时钟）。
 * @returns {number} 窗口内 worker_retry 合计
 */
export function countRecentTransient(allEvents, { windowMs, now = Date.now() } = {}) {
  let count = 0;
  for (const item of allEvents ?? []) {
    const events = Array.isArray(item) ? item : item?.events;
    if (!Array.isArray(events)) continue;
    for (const e of events) {
      if (e?.type !== 'worker_retry') continue;
      const ts = Date.parse(e.ts ?? '');
      if (!Number.isFinite(ts)) continue;
      const age = now - ts;
      if (age >= 0 && age <= windowMs) count += 1;
    }
  }
  return count;
}

/** 滞留判定：窗口内计数达阈值即 true（≥ 语义：恰好等于阈值也算风暴）。 */
export function shouldHold(count, threshold) {
  return Number.isFinite(count) && Number.isFinite(threshold) && count >= threshold;
}

/**
 * 上游海况计数：网关日志窗口期内的限流/额度类请求（status 429/402）合计。
 * 与 countRecentTransient（worker_retry 自报信号）互补——网关侧是实测面，任何 harness
 * 的流量都算，且先于 worker 重试浮现。gwDir=null（未启用网关日志）恒 0：观测随
 * gatewayLogDir 配置开关，缺席不滞留。日文件按本地日期切分，读取范围按窗口跨午夜补足。
 */
export function countUpstreamStorm(gwDir, { windowMs, now = Date.now() } = {}) {
  if (!gwDir) return 0;
  const dayMs = 86_400_000;
  const dayCount = Math.ceil(windowMs / dayMs) + 1; // 跨本地午夜余量
  let count = 0;
  for (let i = 0; i < dayCount; i++) {
    const date = toIsoLocal(new Date(now - i * dayMs)).slice(0, 10);
    for (const entry of readGatewayLog(gwDir, date)) {
      if (entry.status !== 429 && entry.status !== 402) continue;
      const ts = Date.parse(entry.ts ?? '');
      if (!Number.isFinite(ts)) continue;
      const age = now - ts;
      if (age >= 0 && age <= windowMs) count += 1;
    }
  }
  return count;
}

/** fleet 级事件日志路径（跨任务调度层留痕，独立于任务 events.jsonl）。 */
export function fleetLogPath(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'logs', 'fleet.jsonl');
}

/** 读 fleet 事件（容错同 readEvents：半行跳过不抛错）。 */
export function readFleetEvents(repoRoot) {
  const f = fleetLogPath(repoRoot);
  if (!fs.existsSync(f)) return [];
  const events = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch { /* 崩溃残留半行，忽略 */ }
  }
  return events;
}

/**
 * 追加一条 fleet 级事件（与 appendEvent 同格式、独立文件）。fleet 事件极低频
 * （风暴滞留级别），不做进程内 seq 缓存——每次从盘上对齐，跨进程双写也安全。
 */
export function appendFleetEvent(repoRoot, type, fields = {}) {
  const f = fleetLogPath(repoRoot);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let seq = 0;
  try {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        seq = JSON.parse(lines[i]).seq ?? 0;
        break;
      } catch { /* 尾行损坏：继续向前找 */ }
    }
  } catch { /* 文件不存在：首条 */ }
  const event = { ts: toIsoLocal(), seq: seq + 1, type, ...fields };
  fs.appendFileSync(f, JSON.stringify(event) + '\n');
  return event;
}

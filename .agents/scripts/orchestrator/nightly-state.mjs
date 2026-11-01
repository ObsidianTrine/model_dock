// nightly-state.mjs — nightly 幂等补跑的状态机（纯逻辑，可单测）。
// 背景：schedule 用 schtasks/launchd/crontab 定时拉起 nightly，三者都没有可靠的
// 「错过即补跑」语义——Windows 自动更新半夜强制重启后，该晚 nightly 静默缺失，
// 唯一痕迹是「nightly.log 没有新增」。这里用一份轻量状态文件
// （.agents/orchestrator/logs/nightly-state.json）对账两次触发之间发生了什么：
//   { startedAt, finishedAt: null }    nightly 进行中 / 未正常收尾（崩溃、强制重启）
//   { startedAt, finishedAt, result }  正常结束
// 启动自检（decideNightlyStart）三岔：
//   - 状态缺失/损坏 → 视为首次，照常执行；
//   - finishedAt 缺失而 startedAt 在 → 上次被中断 → 本次照常执行，调用方记
//     nightly_recovered 并发通知（调度器没有补跑语义，我们补：中断的巡检在下一个
//     触发点自动接续）；
//   - 距上次 finishedAt 不足 20h 且本次非人工触发 → 疑似调度器补触发双跑 → 跳过
//     （巡检幂等但 scan/audit 有成本，双跑纯浪费；调度器时刻漂移/夏令时由 20h 余量覆盖）。
// 人工触发（终端 TTY / --manual）永不受 20h 限制——launchd/cron/schtasks 语境
// stdin/stdout 均非 TTY，终端手动跑天然区分。

import fs from 'node:fs';
import path from 'node:path';

/** 双跑防护阈值：nightly 每天至多一次，20h 覆盖调度器时刻漂移与夏令时跳变余量。 */
export const NIGHTLY_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

export function nightlyStatePath(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'logs', 'nightly-state.json');
}

/** 读状态；缺失/损坏（非法 JSON、非对象）→ null（调用方按「首次」处理）。 */
export function readNightlyState(repoRoot) {
  try {
    const st = JSON.parse(fs.readFileSync(nightlyStatePath(repoRoot), 'utf8'));
    return st && typeof st === 'object' && !Array.isArray(st) ? st : null;
  } catch {
    return null;
  }
}

/** 写状态（tmp + rename 原子落盘：崩溃不留半截 JSON，避免误判成「损坏」当首次）。 */
export function writeNightlyState(repoRoot, state) {
  const p = nightlyStatePath(repoRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * 启动自检（纯函数；now 与 manual 注入便于单测）。
 * @returns {{ action: 'run'|'recover'|'skip', reason: string }}
 *   run     照常执行（首次 / 状态损坏 / 距上次完成已超 20h / 人工触发）
 *   recover 照常执行 + 上次中断告知（调用方记 nightly_recovered 日志并发 webhook）
 *   skip    跳过本次（调度器补触发双跑嫌疑；state 未动，下次触发照常）
 */
export function decideNightlyStart(state, now = Date.now(), { manual = false } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { action: 'run', reason: '无有效状态记录（视为首次）' };
  }
  const startedAt = Date.parse(state.startedAt ?? '');
  const finishedAt = Date.parse(state.finishedAt ?? '');
  if (Number.isNaN(finishedAt)) {
    if (!Number.isNaN(startedAt)) {
      return { action: 'recover', reason: `上次 nightly 自 ${state.startedAt} 起未正常收尾（崩溃/强制重启）` };
    }
    return { action: 'run', reason: '状态记录不完整（视为首次）' };
  }
  if (!manual && now - finishedAt < NIGHTLY_MIN_INTERVAL_MS) {
    return { action: 'skip', reason: `距上次完成（${state.finishedAt}）不足 20 小时，疑似调度器补触发双跑` };
  }
  return { action: 'run', reason: manual ? '人工触发（不受 20h 双跑防护限制）' : '距上次完成已超 20 小时' };
}

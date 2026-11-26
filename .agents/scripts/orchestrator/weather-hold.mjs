// weather-hold.mjs — 风暴闸（weather hold）计数与宣布，从 orchestrator.mjs 纯搬移（S-02）。
// 模块级可变状态：_weatherSnapshots（Map: repoRoot → { allEvents, at }），本模块是唯一归属方。
//   · 唯一写者 = weatherHoldCount（未命中/TTL 过期时整表重建并 set 快照）；
//   · 唯一清场者 = resetWeatherSnapshotCache（测试收尾）；
//   · 读者仅 weatherHoldCount。
// 按 repoRoot 分键：多仓库（测试/多实例）互不污染；60s TTL 只延迟「窗内新落盘 worker_retry」可见。
// 回指 orchestrator.mjs 的 log：循环 import 仅在函数调用期读取，不在模块求值期触碰。

import fs from 'node:fs';
import path from 'node:path';

import { readEvents } from './events.mjs';
import { countRecentTransient, shouldHold, countUpstreamStorm, appendFleetEvent } from './weather.mjs';
import { gatewayLogsDir } from './reconcile.mjs';
import { notify, notifyActionCard, orchWebhookEnvs } from './notify.mjs';
import { loadWorkflowConfig, displayProjectName } from '../workflow-config.mjs';
import { log } from '../orchestrator.mjs';

/**
 * 风暴闸（weather hold）计数——纯读无副作用：窗口内各任务 worker_retry 合计 vs 阈值；
 * 可选上游海况（hold.upstream 配置）：网关日志窗口内 429/402 合计 vs upstream.threshold，
 * 任一达阈值即滞留。无状态计算（不落 hold 标记文件）：下一次调用窗口滑过即自动恢复。
 * workflow.json 未配 weatherHold 键 = 功能关闭（行为与历史版本一致）。
 */
// 事件快照缓存（perf，2026-11-05 审查项）：每次派发前全量 readdir + 逐任务解析
// events.jsonl，drain 每轮 pump / watch 每周期都重复同一 IO。按 repoRoot 分键的模块级
// 60s TTL 缓存（{allEvents, at}）——命中即复用快照，窗口过滤仍按调用时刻的 now 现算
// （出窗事件即时失效，滞留判定语义不变）；仅「60s 内新落盘的 worker_retry」延迟可见，
// 风暴是分钟级信号，该粒度无判据影响。按 repoRoot 分键：多仓库（测试/多实例）互不污染。
const WEATHER_SNAPSHOT_TTL_MS = 60_000;
const _weatherSnapshots = new Map(); // repoRoot -> { allEvents, at }
/** 测试清场：清空风暴闸事件快照缓存（vitest 单 fork 共享注册表，用例收尾可调用）。 */
export function resetWeatherSnapshotCache() {
  _weatherSnapshots.clear();
}

export function weatherHoldCount(repoRoot, cfg) {
  const hold = cfg?.weatherHold;
  if (!hold) return { held: false, count: 0, upstream: null };
  const now = Date.now();
  const logsRoot = path.join(repoRoot, '.agents', 'orchestrator', 'logs');
  let snap = _weatherSnapshots.get(repoRoot);
  if (!snap || now - snap.at > WEATHER_SNAPSHOT_TTL_MS) {
    const allEvents = [];
    try {
      for (const id of fs.readdirSync(logsRoot)) {
        if (id === 'fleet.jsonl') continue; // fleet 级日志不是任务事件线
        const events = readEvents(path.join(logsRoot, id));
        if (events.length) allEvents.push({ id, events });
      }
    } catch { /* logs/ 不存在 = 还没跑过任务 */ }
    snap = { allEvents, at: now };
    _weatherSnapshots.set(repoRoot, snap);
  }
  const count = countRecentTransient(snap.allEvents, { windowMs: hold.windowMinutes * 60_000, now });
  const result = { held: shouldHold(count, hold.threshold), count, upstream: null };
  // 上游海况（外部风暴）：网关实测先于 worker 重试浮现；未配 upstream 子键 = 关闭，
  // 网关日志不可得（gatewayLogDir 未配）同样不滞留（观测缺席 ≠ 风暴）。
  if (hold.upstream?.threshold != null) {
    const gwDir = gatewayLogsDir(cfg);
    const windowMinutes = hold.upstream.windowMinutes ?? 15;
    const uCount = countUpstreamStorm(gwDir, { windowMs: windowMinutes * 60_000, now });
    result.upstream = { count: uCount, threshold: hold.upstream.threshold, windowMinutes, observed: gwDir != null };
    if (shouldHold(uCount, hold.upstream.threshold)) result.held = true;
  }
  return result;
}

/** 风暴滞留宣布：log + fleet 级事件 + webhook 通知（通知尽力而为，不阻断调度）。
 *  触发源标注：只有上游海况达阈（worker 重试未达）时点名为「上游风暴」。 */
export function announceWeatherHold(repoRoot, cfg, w) {
  const hold = cfg.weatherHold;
  const upstreamTripped = w.upstream?.observed && shouldHold(w.upstream.count, w.upstream.threshold);
  const reason = upstreamTripped && !shouldHold(w.count, hold.threshold)
    ? `上游风暴：最近 ${w.upstream.windowMinutes} 分钟网关限流/额度类请求 ${w.upstream.count} 次 ≥ 阈值 ${w.upstream.threshold}`
    : `最近 ${hold.windowMinutes} 分钟瞬时重试 ${w.count} 次 ≥ 阈值 ${hold.threshold}`;
  log(`⛈ 风暴滞留（weather hold）：${reason}——停止派发，窗口滑过后自动恢复（下次派发前重算）。`);
  try {
    appendFleetEvent(repoRoot, 'weather_hold', {
      count: w.count,
      windowMinutes: hold.windowMinutes,
      ...(w.upstream ? { upstream: { count: w.upstream.count, threshold: w.upstream.threshold, windowMinutes: w.upstream.windowMinutes } } : {}),
    });
  } catch { /* 留痕失败不阻断调度 */ }
  void notify({
    title: `${displayProjectName(loadWorkflowConfig(repoRoot).projectName ?? '')} 风暴滞留`,
    body: `${reason}，已暂停派发任务；窗口滑过后自动恢复。`,
    webhookEnvs: orchWebhookEnvs(repoRoot),
  }).catch(() => { /* 通知失败不阻断 */ });
  // 双向批示叠加卡：weather_hold 是 fleet 级事件，没有可批示的单卡 → 纯信息卡
  // （不出按钮行）；notify.cardWebhook 未开启（缺省）时内部短路，零开销。
  void notifyActionCard({
    repoRoot,
    webhookEnvs: orchWebhookEnvs(repoRoot),
    taskId: null,
    title: `${displayProjectName(loadWorkflowConfig(repoRoot).projectName ?? '')} 风暴滞留`,
    reason: `${reason}，已暂停派发任务；窗口滑过后自动恢复。`,
  }).catch(() => { /* 卡片失败不阻断 */ });
}


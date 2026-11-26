// autoapprove.mjs — 分层审核超时委托 sweep（D6.5），从 orchestrator.mjs 纯搬移（S-02）。
// 模块级可变状态：无。sweep 全程持调度器锁（run-lock.mjs），无进程内缓存；
// AUTOAPPROVE_RETRY_NOTE 是常量文案。
// 回指 orchestrator.mjs 的局部原语（die / log / orchEnv / specIdOfTask / cmdSpecBuild）
// 与 gate.mjs 的 doApprove / doRetry：循环 import 仅在函数调用期读取，不在模块求值期触碰。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { queueRoot, ensureQueue, listCards, findCard } from './queue.mjs';
import { appendEvent, readEvents, logDir } from './events.mjs';
import { loadWorkflowConfig, displayProjectName } from '../workflow-config.mjs';
import { readDegraded } from './drift.mjs';
import { acquireSchedulerLockRetry, releaseSchedulerLock, SCHED_LOCK_ENV } from './run-lock.mjs';
import { listSpecs, specDir } from './spec.mjs';
import { queueDigestItem, maybeSpawnDigestFlush } from './notify-digest.mjs';
import { notify, orchWebhookEnvs } from './notify.mjs';
import { doApprove, doRetry } from './gate.mjs';
import { die, log, orchEnv, specIdOfTask, cmdSpecBuild } from '../orchestrator.mjs';

// ---------------------------------------------------------------------------
// 分层审核超时委托（D6.5，autoapprove sweep，2026-11-10）
// ---------------------------------------------------------------------------
//
// L2/L3 卡落 awaiting-human 后人工有拍板窗口（autoApprove.timeoutMinutes，缺省 3 分钟）；
// 超时未批示的卡由本 sweep 按最后一条 review_verdict 的推荐自动执行：
//   blockers===0 / verdict==='skipped'（fastlane）→ 自动合并（doApprove source='auto'）
//   blockers>0 → 自动返工（doRetry），每卡限 autoApprove.maxAutoRetry 次，超限留人
//   无 review_verdict / 最后是 review_engine_failed / blockers 不可解析 → fail-closed 不动作
// 红线（不可关闭）：① feature 提案的 intake 自动提交拒绝逻辑零改动；② drift 降级期间
// sweep 整体跳过（恢复只能人工 drift --clear）；③ blockers>0 的卡永不自动合并，只返工；
// ④ 没有审查结论的卡超时也绝不合并；⑤ scope_outside（范围失控）落位的卡超时也绝不
// 自动批示——范围失控不该静默合并（与合并闸门同一条不变量），留人工拍板。
// spec 环节 opt-in（2026-11-11 巡航修复：86cb8b3 曾把缺省开等效关掉 D1.5「拆卡人工闸」
// ——拆卡进真实施工，委托必须显式开启）：autoApprove.specBuild.enabled=true 才扫描规格，
// review-verdict.json 结论 approve_to_build 且超时且未 build 过的规格按推荐自动拆卡；
// 缺省关 = 拆卡永远等人拍板；blocked/rework 结论开了也永不自动放行。

/** 自动返工写回卡的补充指令（doRetry note，测试断言锚点）。 */
const AUTOAPPROVE_RETRY_NOTE = '超时自动按审查结论返工（分层审核）';

/**
 * 取卡的最后一条有效 review_verdict：自尾部扫描，先遇到 review_verdict 返回它；
 * 先遇到 review_engine_failed（其后的审查尝试以引擎故障收场）返回 null——fail-closed。
 */
function lastReviewVerdictEvent(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'review_verdict') return events[i];
    if (events[i].type === 'review_engine_failed') return null;
  }
  return null;
}

/** 审查结论 → sweep 推荐动作：'merge' | 'retry' | null（null = fail-closed 不动作）。 */
function recommendFromVerdict(ev) {
  if (!ev) return null;
  if (ev.verdict === 'skipped') return 'merge'; // fastlane 轻卡：审查有意跳过，非缺结论
  if (ev.blockers === 0) return 'merge';
  if (Number.isInteger(ev.blockers) && ev.blockers > 0) return 'retry';
  return null; // blockers 缺失/-1（审查输出无契约块）等同无结论，保守不动作
}

/**
 * sweep 动作的飞书通报（标题带项目名前缀防网关 19024 吞消息；尽力而为不阻断）。
 * notify.digest.enabled=true：动作进 digest 队列（同一 taskId 与落位事件合并成一行终态
 * ——autoapprove 的动作说明比落位行更具体，同级后到覆盖）；关：旧直发（正文逐字节不变）。
 * act = { taskId, state（'merged'=自动合并 / 'pending'=返工或拆卡的中态）, spec?, detail }。
 * spec=true 时 taskId 即规格 id、直接透传 specId；卡动作由 specIdOfTask 从卡 id 派生
 * （2026-11-11 巡航修复：生产调用点此前从不带 specId，flush 的规格尾行管道是死接线）。
 */
async function notifyAutoApproveAction(repoRoot, cfg, { taskId, state = 'pending', spec = false, detail }) {
  const noun = spec ? '规格' : '卡';
  try {
    if (cfg.notify?.digest?.enabled) {
      queueDigestItem(repoRoot, {
        kind: spec ? 'spec' : 'autoapprove',
        taskId,
        state,
        specId: spec ? String(taskId) : specIdOfTask(repoRoot, taskId),
        title: `${noun} ${taskId} 超时自动批示`,
        lines: [String(detail ?? '')],
        priority: 'normal',
      });
      return;
    }
    await notify({
      title: `${displayProjectName(cfg.projectName ?? '')} 超时自动批示`,
      body: `${noun} ${taskId}：${String(detail ?? '')}`,
      webhookEnvs: orchWebhookEnvs(repoRoot),
    });
  } catch { /* 通知失败不阻断 sweep */ }
}

/** 同一卡同一原因的 autoapprove_skipped 已是最后一条事件时不重复写（降级期间周期性 sweep 防刷屏）。 */
function lastEventIs(dir, type, reason) {
  const evts = readEvents(dir);
  const last = evts[evts.length - 1];
  return Boolean(last && last.type === type && (reason === undefined || last.reason === reason));
}

/**
 * autoapprove 一次性 sweep（CLI：`autoapprove [--timeout N] [--dry-run] [--sleep-first]`）。
 * --sleep-first：先睡 timeout+0.5 分钟再扫（drain 落位后拉起的 detached sweep 用——给人工
 * 留满拍板窗口；0.5 分钟余量吸收事件时间戳秒级偏差）。--timeout 覆盖 workflow.json 的
 * timeoutMinutes（测试/临时收紧用，正整数分钟）。
 * 全程持调度器锁；锁被持时有界重试（60s 间隔 ×10 次上限，每轮失败 log 一行、耗尽 log
 * 放弃——2026-11-11 巡航修复：旧实现单次抢锁失败即退出，多卡 drain 期间 detached sweep
 * 的自动批示整体静默落空）。重试参数可注入：opts.lockRetry.{intervalMs,maxAttempts} 或
 * env ORCH_AA_LOCK_RETRY_MS / ORCH_AA_LOCK_RETRY_MAX（测试收紧用，非法值忽略回落缺省）。
 * watch/sail/nightly 的周期 sweep spawnSync 本命令、子进程经 ORCH_SCHED_LOCK_HELD 豁免
 * 直接执行（父已持锁），不受重试逻辑影响。
 */
export async function cmdAutoApprove(repoRoot, opts = {}) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const cfg = loadWorkflowConfig(repoRoot);
  const aa = cfg.autoApprove ?? { enabled: true, timeoutMinutes: 3, maxAutoRetry: 1, specBuild: { enabled: false } };
  let timeoutMinutes = aa.timeoutMinutes;
  if (opts.timeout !== undefined) {
    if (!Number.isInteger(opts.timeout) || opts.timeout <= 0) {
      die('用法：autoapprove [--timeout N] [--dry-run]——--timeout 须为正整数（分钟）。');
    }
    timeoutMinutes = opts.timeout;
  }
  if (opts.flags?.has('--sleep-first')) {
    await new Promise((r) => setTimeout(r, Math.round((timeoutMinutes + 0.5) * 60_000)));
  }
  const lockRetry = { intervalMs: 60_000, maxAttempts: 10, ...(opts.lockRetry ?? {}) };
  const envMs = Number.parseInt(orchEnv.ORCH_AA_LOCK_RETRY_MS ?? '', 10); // env-snap
  if (Number.isInteger(envMs) && envMs > 0) lockRetry.intervalMs = envMs;
  const envMax = Number.parseInt(orchEnv.ORCH_AA_LOCK_RETRY_MAX ?? '', 10); // env-snap
  if (Number.isInteger(envMax) && envMax >= 0) lockRetry.maxAttempts = envMax;
  const lock = await acquireSchedulerLockRetry(repoRoot, 'autoapprove', lockRetry);
  if (!lock.held) return; // 重试耗尽：已 log 放弃原因，交下一轮周期 sweep 兜底
  const dryRun = opts.flags?.has('--dry-run') === true;
  const enabled = aa.enabled === true;
  const degraded = readDegraded(repoRoot);
  // 可执行 = 功能开 && 非 dry-run && 无降级；留痕 = 功能开 && 非 dry-run（降级跳过也留痕）
  const act = enabled && !dryRun && !degraded;
  const trace = enabled && !dryRun;
  const report = { merged: [], retried: [], retryLimit: [], noVerdict: [], waiting: [], scopeOutside: [], specBuilt: [], specWaiting: [] };
  const timeoutMs = timeoutMinutes * 60_000;
  try {
    if (degraded) {
      // 红线②：drift 降级期间 sweep 整体跳过（含 spec 环节），逐卡留痕（gate_result 风格）；
      // 恢复 drift --clear 后下一轮 sweep 再按推荐执行。
      if (trace) {
        for (const taskId of listCards(root, 'awaiting-human')) {
          const qdir = logDir(repoRoot, taskId);
          if (!lastEventIs(qdir, 'autoapprove_skipped', 'drift_degraded')) {
            appendEvent(qdir, 'autoapprove_skipped', { reason: 'drift_degraded', detail: String(degraded.reason ?? '').slice(0, 200) });
          }
        }
      }
    } else {
      for (const taskId of listCards(root, 'awaiting-human')) {
        // 逐卡动作前复查卡位（DM-01）：awaiting-human 清单只在循环入口快照一次，而本轮里
        // 前面的卡可能刚跑完整段 finish / 自动返工——期间这张卡可能已被人工批示。卡不在
        // 闸门 = 已被处理，跳过（不再对它二次批示）。
        if (findCard(root, taskId)?.state !== 'awaiting-human') {
          log(`闸门卡 ${taskId} 在本轮 sweep 轮到它之前已离开 awaiting-human/——跳过。`);
          continue;
        }
        const qdir = logDir(repoRoot, taskId);
        const verdict = lastReviewVerdictEvent(readEvents(qdir));
        const rec = recommendFromVerdict(verdict);
        if (!verdict || !rec) {
          // 红线④：没有可执行的审查结论——超时也绝不自动动作
          report.noVerdict.push(taskId);
          if (act && !lastEventIs(qdir, 'autoapprove_skipped', 'no_verdict')) {
            appendEvent(qdir, 'autoapprove_skipped', { reason: 'no_verdict' });
          }
          continue;
        }
        const ageMs = Date.now() - Date.parse(verdict.ts ?? '');
        if (!Number.isFinite(ageMs) || ageMs < timeoutMs) {
          report.waiting.push(taskId); // 拍板窗口未过：留人
          continue;
        }
        // 红线⑤：scope_outside（范围失控）落位的卡超时也绝不自动批示——范围失控不该
        // 静默合并（与合并闸门 purity.outside 同一条不变量），自动返工同样跳过（重跑
        // 也可能带着失控改动再回来）。只认最后一条 awaiting_human 事件的 reason；
        // drift_degraded 落位由上面的整体跳过覆盖（恢复后按推荐执行是文档化语义）。
        const awaitEv = readEvents(qdir).slice().reverse().find((e) => e.type === 'awaiting_human');
        if (awaitEv?.reason === 'scope_outside') {
          report.scopeOutside.push(taskId);
          if (act && !lastEventIs(qdir, 'autoapprove_skipped', 'scope_outside')) {
            appendEvent(qdir, 'autoapprove_skipped', { reason: 'scope_outside' });
          }
          continue;
        }
        if (rec === 'merge') {
          report.merged.push(taskId);
          if (!act) continue;
          appendEvent(qdir, 'autoapprove_decision', { decision: 'merge', source: 'timeout', verdict_ts: verdict.ts });
          // doApprove 持任务锁返回 false = finish 返回时卡已离开闸门、未记 merged：不通报
          // 「已自动合并」（会撒谎），本轮 sweep 继续处理余卡
          if (!(await doApprove(repoRoot, taskId, root, qdir, 'auto'))) continue;
          await notifyAutoApproveAction(repoRoot, cfg, { taskId, state: 'merged', detail: `审查 blockers=0 且超时 ${timeoutMinutes} 分钟——已按推荐自动合并（merged/）` });
        } else {
          // 红线③：blockers>0 永不自动合并——只自动返工，且每卡限 maxAutoRetry 次
          const retries = readEvents(qdir).filter((e) => e.type === 'autoapprove_decision' && e.decision === 'retry').length;
          if (retries >= aa.maxAutoRetry) {
            report.retryLimit.push(taskId);
            if (act && !lastEventIs(qdir, 'autoapprove_skipped', 'retry_limit')) {
              appendEvent(qdir, 'autoapprove_skipped', { reason: 'retry_limit', retries });
            }
            continue;
          }
          report.retried.push(taskId);
          if (!act) continue;
          appendEvent(qdir, 'autoapprove_decision', { decision: 'retry', source: 'timeout', verdict_ts: verdict.ts });
          await doRetry(repoRoot, taskId, root, qdir, AUTOAPPROVE_RETRY_NOTE, {});
          await notifyAutoApproveAction(repoRoot, cfg, { taskId, state: 'pending', detail: `审查 blockers=${verdict.blockers} 且超时 ${timeoutMinutes} 分钟——已按推荐自动返工（第 ${retries + 1}/${aa.maxAutoRetry} 次）` });
        }
      }
      // ---- spec 分层超时（opt-in：autoApprove.specBuild.enabled 缺省关——拆卡人工闸默认不委托）----
      // 开启后才扫描：审查 approve_to_build 且超时且未 build 过 → 按推荐自动拆卡
      if (aa.specBuild?.enabled === true) {
        for (const id of listSpecs(repoRoot)) {
          const dir = specDir(repoRoot, id);
          if (!fs.existsSync(path.join(dir, 'review-verdict.json'))) continue;
          if (fs.existsSync(path.join(dir, 'progress.json'))) continue; // 已 build 过（幂等锚）
          let v = null;
          try { v = JSON.parse(fs.readFileSync(path.join(dir, 'review-verdict.json'), 'utf8')); } catch { continue; }
          if (v?.usage?.build_ready !== 'approve_to_build') continue; // blocked/rework 永不自动放行
          const ageMs = Date.now() - Date.parse(v.created_at ?? '');
          if (!Number.isFinite(ageMs) || ageMs < timeoutMs) {
            report.specWaiting.push(id);
            continue;
          }
          report.specBuilt.push(id);
          if (!act) continue;
          cmdSpecBuild(repoRoot, id);
          await notifyAutoApproveAction(repoRoot, cfg, { taskId: id, spec: true, state: 'pending', detail: `审查 approve_to_build 且超时 ${timeoutMinutes} 分钟——已按推荐自动拆卡（pending/）` });
        }
      }
    }
  } finally {
    releaseSchedulerLock(repoRoot);
  }
  // 报告（enabled=false / dry-run 同样盘点，只是不动作——动作行加「建议」标记防误读）
  const fmt = (a) => a.join(', ');
  const acted = act ? '' : '（建议，未执行）';
  log(`═══ autoapprove sweep（enabled=${enabled}，timeout=${timeoutMinutes}min${dryRun ? '，dry-run' : ''}${degraded ? '，⚠ drift 降级中——整体跳过' : ''}）═══`);
  if (report.merged.length) log(`  自动合并${acted}：${fmt(report.merged)}`);
  if (report.retried.length) log(`  自动返工${acted}：${fmt(report.retried)}`);
  if (report.retryLimit.length) log(`  返工超限留人：${fmt(report.retryLimit)}`);
  if (report.noVerdict.length) log(`  fail-closed（无审查结论，不动作）：${fmt(report.noVerdict)}`);
  if (report.waiting.length) log(`  拍板窗口未过：${fmt(report.waiting)}`);
  if (report.scopeOutside.length) log(`  范围失控留人（scope_outside 不自动批示）：${fmt(report.scopeOutside)}`);
  if (report.specBuilt.length) log(`  spec 自动拆卡${acted}：${fmt(report.specBuilt)}`);
  if (report.specWaiting.length) log(`  spec 拍板窗口未过：${fmt(report.specWaiting)}`);
  if (!report.merged.length && !report.retried.length && !report.retryLimit.length && !report.noVerdict.length && !report.waiting.length && !report.scopeOutside.length && !report.specBuilt.length && !report.specWaiting.length) {
    log('  无待批示项。');
  }
  if (dryRun) log('  （dry-run：以上为建议动作，未实际执行）');
  // digest 聚合通报：有动作才可能进了队列——sweep 收尾拉起 detached flush（60s 静默窗
  // 内合并发送）。retry/拆卡路径没有落位 settleNotify 兜底拉 flusher，这里统一保证；
  // merge 路径 doApprove→settleNotify 已拉过的由 marker 去重（不双拉）。
  if (act && (report.merged.length || report.retried.length || report.specBuilt.length)) {
    maybeSpawnDigestFlush(repoRoot, cfg);
  }
}

/**
 * drain 落位 awaiting-human 后拉起一次性 detached sweep（D6.5 接线）：先睡
 * timeout+0.5 分钟（人工拍板窗口）再扫，到点仍未批示才按推荐执行。enabled 且确有
 * 待批示卡才拉起；sweep 自己抢调度器锁——drain 未收尾时有界重试等锁（60s×10，
 * 2026-11-11 巡航修复：旧实现单次失败即退出，多卡 drain 期间自动批示静默落空），
 * 重试仍拿不到才放弃，绝不并发批示。
 * 交互式闸门（人工在场）不拉起。detach + unref：run 子进程正常退出不受影响。
 */
export function maybeSpawnAutoApproveSweep(repoRoot, cfg) {
  try {
    if (cfg.autoApprove?.enabled !== true) return;
    if (!listCards(queueRoot(repoRoot), 'awaiting-human').length) return;
    // run 子进程可能带着父调度器的锁豁免 env（drain spawn 时注入）——必须剥掉，
    // 否则 sweep 跳过自己的抢锁检查，与仍在跑的 drain 并发批示
    const sweepEnv = { ...process.env };
    delete sweepEnv[SCHED_LOCK_ENV];
    spawn(process.execPath, [path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs'), 'autoapprove', '--sleep-first'], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      env: sweepEnv,
    }).unref();
    // digest 聚合通报的 detached flush 分支（与 sweep 同款 detach）：attention 落位已
    // 立即同步 flush，这里兜静默窗内可能残留的 normal 事件；队列空/未启用 = 零开销短路
    maybeSpawnDigestFlush(repoRoot, cfg);
  } catch { /* 尽力而为：拉起失败不影响本轮落位（watch/sail/nightly 周期 sweep 兜底） */ }
}


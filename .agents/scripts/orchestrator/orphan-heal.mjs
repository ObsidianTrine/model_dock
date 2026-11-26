// orphan-heal.mjs — blocked 卡有限自动续 + 孤儿 running 卡启动自愈，从 orchestrator.mjs 纯搬移（S-02）。
// 模块级可变状态：无。冷标记（auto_resumed_at / auto_resume_count）写进卡 frontmatter，
// 由 autoresume.mjs 的 withAutoResumedAt / autoResumedAtNow / lifetimeCapRejections 提供并落盘；
// 资格判定纯逻辑在 autoresume.mjs（scanBlockedCards / pickAutoResumeCandidates / scanRunningCards /
// partitionRunningOrphans / classifyOrphan / pickOrphanResumeCandidates）——本模块只做 fs 扫描与
// spawn 既有 resume 子命令的接线。
// 回指 orchestrator.mjs 的局部原语（log / engineArgs / worktreeCommitsAhead / worktreePath）：
// 循环 import 仅在函数调用期读取，不在模块求值期触碰。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { appendEvent, logDir } from './events.mjs';
import { findCard, moveCard } from './queue.mjs';
import { readDegraded } from './drift.mjs';
import { readTaskLock } from './task-lock.mjs';
import { isAlive } from './kill-tree.mjs';
import { appendFleetEvent } from './weather.mjs';
import { childEnvForHeldLock } from './run-lock.mjs';
import { scanBlockedCards, pickAutoResumeCandidates, withAutoResumedAt, autoResumedAtNow, lifetimeCapRejections, scanRunningCards, partitionRunningOrphans, classifyOrphan, pickOrphanResumeCandidates } from './autoresume.mjs';
import { log, engineArgs, worktreeCommitsAhead, worktreePath } from '../orchestrator.mjs';

/**
 * 生命周期上限拒绝留痕（P1-⑨，判定纯逻辑在 lifetimeCapRejections）：落卡事件
 * auto_resume_rejected { reason: 'lifetime_cap', count, max_per_card } + 主日志一行——
 * 超限卡留 blocked 待人工，卡上已有 auto_resume_count 累计值即留痕；同一上限状态
 * 只报一次（去重口径见 lifetimeCapRejections），防 drain 每轮刷屏。
 */
function reportLifetimeCapRejections(repoRoot, rejections) {
  for (const c of rejections) {
    try {
      appendEvent(logDir(repoRoot, c.id), 'auto_resume_rejected', { card: c.id, reason: 'lifetime_cap', count: c.count, max_per_card: c.cap });
    } catch { /* 留痕失败不阻断选卡 */ }
    log(`⛔ 卡 ${c.id} 自动续累计 ${c.count} 次已达上限 ${c.cap}——不再自动续，等人工 resume（判否原因见 logs/${c.id}/ 事件）。`);
  }
}

/**
 * blocked 卡有限自动续跑（长跑自主的关键小件；资格判定纯逻辑在 orchestrator/autoresume.mjs）。
 * drain 选卡前调用：扫 blocked/ → 挑「transient 类失败 + 冷却已过」的卡（≤maxPerRun 张，
 * 按 blocked 时间最早先续）→ 逐张先把 auto_resumed_at 冷却标记 + auto_resume_count 累计
 * 写进卡 frontmatter（自动续后再 blocked 时下轮靠前者判冷却、靠后者判生命周期上限——
 * 连续自动续失败不重试、全生命周期封顶防「续→崩→冷却→续」循环烧钱）→ 记 auto_resume
 * { card, attempts } 事件 → spawn 既有 resume 子命令（闭环复用不复制逻辑；子进程隔离，
 * 熔断 process.exit 不伤 drain 主循环，与派 run 子进程同哲学，--auto-resume 让 resumed
 * 事件标记 by=auto 区别于人工）。上界四重：只续 transient 类、每卡 24h（cooldownHours）
 * 最多 1 次、每次 drain ≤2 张（maxPerRun）、每卡全生命周期 ≤3 次（maxPerCard，超限留
 * blocked 交人工并落 auto_resume_rejected 事件）。drift 降级 = 全人工，整个通道暂停；
 * autoResume.enabled=false 完全不扫。
 * @returns {string[]} 本轮自动续的卡 id（drain 汇总口径）
 */
export function autoResumePass(repoRoot, root, cfg, opts) {
  const ar = cfg.autoResume;
  if (!ar?.enabled) return [];
  if (readDegraded(repoRoot)) {
    log('⏸ drift 降级期间自动续暂停（降级 = 全人工）——blocked 卡等人工 resume。');
    return [];
  }
  const { candidates, unreadable, total } = scanBlockedCards(repoRoot, root);
  if (total === 0) return [];
  if (unreadable.length) {
    console.warn(`[orchestrator] 自动续资格判定：${unreadable.length} 张 blocked 卡读不了（frontmatter 解析失败，人工检查）——已跳过：${unreadable.join(', ')}`);
  }
  const picked = pickAutoResumeCandidates(candidates, {
    maxPerRun: ar.maxPerRun,
    cooldownMs: ar.cooldownHours * 60 * 60 * 1000,
    maxPerCard: ar.maxPerCard,
  });
  reportLifetimeCapRejections(repoRoot, lifetimeCapRejections(candidates, { maxPerCard: ar.maxPerCard }));
  const resumed = [];
  for (const c of picked) {
    const card = candidates.find((x) => x.id === c.id);
    try {
      fs.writeFileSync(card.path, withAutoResumedAt(card.text, autoResumedAtNow()));
    } catch (e) {
      // Windows EBUSY 等写失败：卡可能被编辑器占用——宁可不续也不无冷却地续（防反复烧钱）
      console.warn(`[orchestrator] 卡 ${c.id} 写 auto_resumed_at 失败（${e?.message ?? e}）——本轮跳过自动续。`);
      continue;
    }
    appendEvent(logDir(repoRoot, c.id), 'auto_resume', { card: c.id, attempts: c.attempts });
    log(`⟳ 自动续 blocked 卡 ${c.id}（transient 类失败，worker_retry ${c.attempts} 次用尽；冷却期内至多此一次）`);
    const r = spawnSync('node', [path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs'), 'resume', c.id, '--auto-resume',
      ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, ...childEnvForHeldLock() },
    });
    resumed.push(c.id);
    if (r.status !== 0) log(`任务 ${c.id} 自动续退出码 ${r.status}（已落 blocked/failed/或等待人工——冷却期内不再自动续）。`);
  }
  log(`自动续检查：blocked ${total} 张，候选 ${picked.length} 张，已续 ${resumed.length} 张${resumed.length ? `（${resumed.join(', ')}）` : ''}。`);
  return resumed;
}

/**
 * 孤儿 running 卡启动自愈（2026-11 长跑自治；归类纯逻辑在 orchestrator/autoresume.mjs
 * 的 classifyOrphan / pickOrphanResumeCandidates）。blocked 通道覆盖不到的形态：sail/drain
 * 单进程被硬杀后卡还挂在 running/——状态「在跑」而实际无进程，等下一个调度入口接管。
 * drain / watch / nightly / sail 入口（获得调度器锁后）调用，任务锁判活分三类处置：
 *   ① 锁活（readTaskLock + taskLockLooksLive，同进程嵌套闭环或并行实例在驱动）→ 跳过；
 *   ①' beat 静默但属主 pid 探活仍活（spawnSync npm ci/ensureWorktree 冻结事件循环的活
 *      run，P1-a）→ 只落观测（fleet 事件 orphan_heal_beat_silent + log）不动卡；
 *   ② 孤儿 + classifyOrphan='resume'（崩溃族 / 上会话 transient 签名 / retry 链）→
 *      有限自动续：沿用 24h 冷却（cooldownHours）、每次 ≤maxPerRun 张与每卡生命周期上限
 *      （maxPerCard，auto_resume_count 随卡累计），与 blocked 通道同参；
 *   ③ 孤儿 + 其余（'breaker' 熔断卡永不续 / 'stuck' 非 transient）→ 落 blocked/
 *      （failTaskToBlocked 同款：failed 事件 + 迁移，附不可续原因），交人工。
 * 护栏：仅在实际获得调度器锁的进程执行（调用方守卫——watch/nightly 派生的 drain 子进程
 * 走 ORCH_SCHED_LOCK_HELD 豁免路径跳过，父调度器本周期已扫，与并行驾驶实例互斥）；
 * drift 降级 = 全人工，整通道暂停；autoResume.enabled=false 完全不扫。
 * 永不静默：自动续记 auto_resume { card, attempts, source: 'orphan_running' }，落 blocked
 * 记 failed 事件（孤儿现场写不进通知回调，落卡事件即对账凭据）。
 * @returns {{ resumed: string[], blocked: string[] }} 本轮自动续与落 blocked 的卡 id
 */
export function orphanHealPass(repoRoot, root, cfg, opts) {
  const empty = { resumed: [], blocked: [] };
  const ar = cfg.autoResume;
  if (!ar?.enabled) return empty;
  if (readDegraded(repoRoot)) return empty; // 降级 = 全人工：状态归位也一并等人工（现场保持原样）
  const { candidates, unreadable, total } = scanRunningCards(repoRoot, root);
  if (total === 0) return empty;
  if (unreadable.length) {
    console.warn(`[orchestrator] 孤儿自愈资格判定：${unreadable.length} 张 running 卡读不了（frontmatter 解析失败，人工检查）——已跳过：${unreadable.join(', ')}`);
  }
  // 判活备料（P1-a 双条件）：锁活（心跳 15s 内新鲜）= 有驱动者；beat 静默且属主 pid
  // 已死（或锁缺失/pid 不可探测，回退旧口径）= 孤儿。beat 静默但 pid 仍活——spawnSync
  // （npm ci / ensureWorktree）冻结事件循环停更心跳 >60s 的活 run——只落观测不动卡：
  // 此前只看 beat 会把它误判孤儿自动续/落 blocked，双 worker 同 worktree。
  const { orphans, silentLive } = partitionRunningOrphans(candidates, {
    lockOf: (id) => readTaskLock(repoRoot, id),
    pidAlive: (pid) => isAlive(pid),
  });
  if (silentLive.length) {
    log(`👀 孤儿自愈：${silentLive.length} 张 running 卡任务锁心跳静默但属主进程仍存活（pid 探活确认）：${silentLive.join(', ')}——大概率 spawnSync 装依赖冻结事件循环，只观测不动卡（防误杀活 run 致双 worker 同 worktree）。`);
    // 观测事件落 fleet 不落卡 events.jsonl：属主进程还在写同文件，跨进程双写会撞 seq
    try { appendFleetEvent(repoRoot, 'orphan_heal_beat_silent', { cards: silentLive }); } catch { /* 留痕失败不阻断 */ }
  }
  if (!orphans.length) return empty;
  log(`🔍 孤儿自愈：running ${total} 张，其中 ${orphans.length} 张无人驱动（任务锁缺失，或心跳静默且属主进程已退出）：${orphans.map((c) => c.id).join(', ')}`);
  // 人工认领观察（DM-02）：feature-branch start 认领卡只短暂持任务锁，进程退出即释放；
  // 持久认领记录是事件链里的 manual_claimed。这类卡属主是人工 agent——自动续会双写同一
  // worktree、落 blocked 会撤销人工现场，两者都不做，只落 fleet 观测事件（不写卡
  // events.jsonl：属主可能正在写同一个文件，跨进程双写会撞 seq）。
  const manualOrphans = orphans.filter((c) => classifyOrphan(c.events) === 'manual');
  if (manualOrphans.length) {
    const ids = manualOrphans.map((c) => c.id);
    log(`👀 孤儿自愈：${ids.length} 张 running 卡由人工认领（manual_claimed，属主在岗）——跳过自动续与落 blocked，只观测不动卡：${ids.join(', ')}`);
    try { appendFleetEvent(repoRoot, 'orphan_heal_manual_claimed', { cards: ids }); } catch { /* 留痕失败不阻断 */ }
  }
  // stuck 终态对冲备料（2026-11-17）：'stuck' 孤儿（非 transient settle 收尾）先对账
  // worktree 提交——相对 base 已有非空提交 = 可验收产出在库，走续用路径（resume 原地
  // 续做）而非落 blocked 清空重做。breaker 熔断卡不受对冲（确定性失败永不自动续）；
  // resume 族无需对账。对账不可得（worktree 缺失/git 故障）按 0 处理，照旧交人工。
  for (const c of orphans) {
    if (classifyOrphan(c.events) === 'stuck') {
      c.commitsAhead = worktreeCommitsAhead(worktreePath(repoRoot, c.id), cfg.baseBranch || 'develop') ?? 0;
    }
  }
  const picked = pickOrphanResumeCandidates(orphans, {
    maxPerRun: ar.maxPerRun,
    cooldownMs: ar.cooldownHours * 60 * 60 * 1000,
    maxPerCard: ar.maxPerCard,
  });
  // 生命周期上限拒绝留痕（与 blocked 通道同口径）：capped 孤儿不进候选，随后在下方
  // 落 blocked 循环里按 cap 专属原因归位——failed 事件的 reason 面向人工与未来
  // isTransientBlocked 匹配写，上限拒绝不匹配任何可续签名，卡留在 blocked 交人工。
  const capRejections = lifetimeCapRejections(orphans, {
    maxPerCard: ar.maxPerCard,
    isEligible: (c) => { const k = classifyOrphan(c.events); if (k === 'manual') return false; return k === 'resume' || (k === 'stuck' && (c.commitsAhead ?? 0) > 0); }, // 孤儿通道资格口径与 pickOrphanResumeCandidates 一致（stuck 对冲续用同资格；manual 人工属主不续）
  });
  reportLifetimeCapRejections(repoRoot, capRejections);
  const resumed = [];
  const cappedIds = new Set(capRejections.map((c) => c.id));
  for (const c of picked) {
    const card = orphans.find((x) => x.id === c.id);
    try {
      fs.writeFileSync(card.path, withAutoResumedAt(card.text, autoResumedAtNow()));
    } catch (e) {
      // Windows EBUSY 等写失败：宁可不续也不无冷却地续（防反复烧钱），与 blocked 通道同款
      console.warn(`[orchestrator] 卡 ${c.id} 写 auto_resumed_at 失败（${e?.message ?? e}）——本轮跳过自动续。`);
      continue;
    }
    appendEvent(logDir(repoRoot, c.id), 'auto_resume', {
      card: c.id,
      attempts: c.attempts,
      source: 'orphan_running',
      ...(c.rescue === 'stuck_with_commits' ? { commits_ahead: c.commitsAhead, rescue: c.rescue } : {}),
    });
    log(`⟳ 自动续孤儿卡 ${c.id}（闭环进程已退出，崩溃/transient 族${c.rescue === 'stuck_with_commits' ? `；stuck 但 worktree 已有 ${c.commitsAhead} 个提交——原地续用半成品` : ''}；冷却期内至多此一次）`);
    const r = spawnSync('node', [path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs'), 'resume', c.id, '--auto-resume',
      ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, ...childEnvForHeldLock() },
    });
    resumed.push(c.id);
    if (r.status !== 0) log(`任务 ${c.id} 自动续退出码 ${r.status}（已落 blocked/failed/或等待人工——冷却期内不再自动续）。`);
  }
  // 其余孤儿落 blocked（failTaskToBlocked 同款语义）：熔断卡（'breaker'）只做状态归位
  // 永不续；'stuck'（最后会话以 failed/非签名 settle 收尾）交人工定性。先重查现状——
  // 上方自动续的子进程可能已把同 id 卡迁走（同步 spawn，此处必已收敛）。
  const pickedIds = new Set(picked.map((p) => p.id));
  const blocked = [];
  for (const c of orphans) {
    if (pickedIds.has(c.id)) continue;
    const cur = findCard(root, c.id);
    if (!cur || !['running', 'reviewing'].includes(cur.state)) continue; // 已被自动续子进程迁移/落位
    const kind = classifyOrphan(c.events);
    // 人工认领（DM-02）：属主在岗，落 blocked 会撤销人工现场——只观测（fleet 事件已在
    // 上方统一留痕），不写 failed 事件、不迁卡。
    if (kind === 'manual') continue;
    const breakerEv = [...c.events].reverse().find((e) => e?.type === 'circuit_breaker');
    // reason 面向 isTransientBlocked 的签名匹配写（只引程序写入的枚举 reason，不引自由文本
    // detail）——落 blocked 后不允许被下一轮 blocked 通道按字面误判成 transient 再续。
    // capped（P1-⑨ 生命周期上限）：本是 transient 族但自动续次数已封顶，专属原因交人工。
    const reason = cappedIds.has(c.id)
      ? '孤儿 running 卡自愈：闭环进程已退出（任务锁陈旧/缺失），自动续次数已达生命周期上限——不再自动续，交人工 resume'
      : kind === 'breaker'
        ? `孤儿 running 卡自愈：闭环进程已退出（任务锁陈旧/缺失），事件链有熔断（${breakerEv?.reason ?? '未知'}）——熔断卡永不自动续`
        : '孤儿 running 卡自愈：闭环进程已退出（任务锁陈旧/缺失），最后会话无 transient 签名——交人工定性';
    // stuck 终态对冲证据（2026-11-17）：落 blocked 的 stuck 卡 commits_ahead 恒 0（>0 已走
    // 续用路径）——字段留痕对账结论，人工核实零提交后才值得清空重做。
    appendEvent(logDir(repoRoot, c.id), 'failed', { reason, ...(kind === 'stuck' ? { commits_ahead: c.commitsAhead ?? 0 } : {}) });
    moveCard(root, c.id, cur.state, 'blocked');
    blocked.push(c.id);
    log(`⚠ 孤儿卡 ${c.id} 落 blocked（${reason}）——人工 resume 前请先看 logs/${c.id}/ 事件时间线。`);
  }
  log(`孤儿自愈检查：running ${total} 张，孤儿 ${orphans.length} 张，人工认领跳过 ${manualOrphans.length} 张${manualOrphans.length ? `（${manualOrphans.map((c) => c.id).join(', ')}）` : ''}，自动续 ${resumed.length} 张${resumed.length ? `（${resumed.join(', ')}）` : ''}，落 blocked ${blocked.length} 张${blocked.length ? `（${blocked.join(', ')}）` : ''}。`);
  return { resumed, blocked };
}


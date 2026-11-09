#!/usr/bin/env node
// orchestrator.mjs — 自治编排服务（Phase 1：单任务闭环）。
// "任务卡进、合并出"：submit 任务卡 → run 自动跑 worker→静态门禁→调试子循环
// →LLM 独立审查→审查返工子循环→人工合并闸门。设计文档：.agents/docs/design-orchestrator.md。
//
// 零第三方依赖（.agents/ 工具链红线）；复用 feature-branch.mjs 做隔离与合并，
// 不另起分支体系。从主仓库根目录运行（队列/日志落在 <repoRoot>/.agents/orchestrator/）。
//
// 红线（docs 第 8 章，硬编码不可关闭）：发布动作（push/tag/publish）永远人工；
// 端口红线按 workflow.json protectedPorts 配置（缺省不启用）；worker 编辑限定在
// worktree 内；熔断超限永不静默重试烧钱。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  STATES,
  loadCard,
  parseCard,
  validateCard,
  queueRoot,
  ensureQueue,
  cardPath,
  findCard,
  moveCard,
  listCards,
  pickNextCard,
  TASK_ID_RE,
} from './orchestrator/queue.mjs';
import { appendEvent, readEvents, logDir, formatTimeline, coalesceEvents, appendInbox, readInbox, toIsoLocal } from './orchestrator/events.mjs';
import { Budget } from './orchestrator/budget.mjs';
import { countRecentTransient, countUpstreamStorm, shouldHold, appendFleetEvent } from './orchestrator/weather.mjs';
import { buildWorkerPrompt, buildReviewerPrompt, buildFixupPrompt, buildPromptFileRefBody, parseResultBlock, parseReviewVerdict, buildPlannerPrompt, parseCardBlock, parseCardBlocks, buildProposePrompt, buildSpecPrompt, parseSpecBlocks, buildResearchPrompt, buildVerifierPrompt, buildArbitrationPrompt, sanitizeIntent, appendFollowUps, CARD_MARKER, BRIEF_MARKER } from './orchestrator/prompt.mjs';
import { parseBriefBlock, validateBriefBody, extractCitations, extractDatedCitations, extractClaimTokens, citationDepthStats, crossCheckClaims, writeBriefAuto, readBrief, listBriefs, snapshotCitations, researchDir, assessBrief, loadSnapshots, parseVerdictBlock, parseArbitrationBlock, arbitrateClaims, verifyClaimVerbatim, normalizeClaimStatuses, scoreVerdict, scoreCitation, buildResearchNotifyBody, buildResearchMultiNotifyBody, appendResearchLedger, readLedgerStats, slugifyTopic, deriveTopicId, readTopic, writeTopic, topicPath, rollupTopicVerdict, VERDICT_SCHEMA } from './orchestrator/research.mjs';
import { readGoals } from './orchestrator/goals.mjs';
import { collectStatsSummary, buildFleetFeedback, extractGoalsThemes } from './orchestrator/stats.mjs';
import { canAutoSubmit, AUTO_SUBMIT_GATE } from './orchestrator/autopilot.mjs';
import { gateNpmTest, gateTscBuild, gateLint, gateTypecheck, gatePortScan, gateNativeScan, gateScopePurity, gateCliEntry, gateUiCheck, changedFiles, runArgvTreeSafe, GateError } from './orchestrator/gates.mjs';
import { getBackend, resolveBackendName, resolveReviewBackendName, writeWorkerSettings, claudeAvailable } from './orchestrator/backends/claude-headless.mjs';
import { zcodeAvailable } from './orchestrator/backends/zcode-headless.mjs';
import { codexAvailable } from './orchestrator/backends/codex-headless.mjs';
import { isTransientWorkerFailure, classifyWorkerCrashFromDisk } from './orchestrator/transient.mjs';
import { shouldEscalatePrompt } from './orchestrator/escalation.mjs';
import { pickAutoResumeCandidates, scanBlockedCards, withAutoResumedAt, autoResumedAtNow } from './orchestrator/autoresume.mjs';
import { captureConfigBaseline, checkConfigDrift, resetConfigBaseline } from './orchestrator/config-guard.mjs';
import { listDrafts, planGc, applyGc, supersedeForMerged, draftsRoot, DEFAULT_ARCHIVE_DAYS } from './orchestrator/drafts-gc.mjs';
import { scanAutoFixAfterFailure, isScanCardId } from './orchestrator/scanfix.mjs';
import { isAlive, killTree, orphanOwnership, processElapsedMs } from './orchestrator/kill-tree.mjs';
import { classifyChange, hintsOverlap } from './policy.mjs';
import { loadWorkflowConfig, displayProjectName, PROMPT_FILE_THRESHOLD_CHARS } from './workflow-config.mjs';
import { probeProviderCapacity, startMeasuredFuelPoller } from './orchestrator/supply.mjs';
import { runScan } from './orchestrator/scan.mjs';
import { installWorkspaceDeps as installWorkspaceDepsImpl } from './orchestrator/deps.mjs';
import { readDegraded, evaluateDrift, clearDegraded } from './orchestrator/drift.mjs';
import { gatewayLogsDir, reconcileTask, reconcileAll, reconcileCardStates, upstreamSeaState } from './orchestrator/reconcile.mjs';
import { attachCost, measureFuel, measureFuelBatch, fmtUsd } from './orchestrator/cost.mjs';
import { observeFleetForRun } from './orchestrator/fleet.mjs';
import { decideDispatchForRun, normalizeEnvelope } from './orchestrator/dispatch.mjs';
import { watchdogCheck, createWatchdogState, makeWatchdogSpawnFn, watchdogTimelineSummary } from './orchestrator/watchdog.mjs';
import { writeDecisionTrace } from './orchestrator/trace.mjs';
import { proposeRelease } from './orchestrator/release-propose.mjs';
import { installSchedule, uninstallSchedule, scheduleStatus, nightlyLogPath } from './orchestrator/schedule.mjs';
import { readNightlyState, writeNightlyState, decideNightlyStart } from './orchestrator/nightly-state.mjs';
import { writeSpec, readSpec, listSpecs, buildSpecCards, parseTasksDoc, readProgress } from './orchestrator/spec.mjs';
import { acquireSchedulerLock, releaseSchedulerLock, childEnvForHeldLock } from './orchestrator/run-lock.mjs';
import { acquireTaskLock, releaseTaskLock, readTaskLock, taskLockPath, taskLockLooksLive, TASK_LOCK_STALE_MS } from './orchestrator/task-lock.mjs';
import { notify, buildNightlySummary, buildTaskDigest, buildTaskRoster, taskStateTag, nightlyWebhookEnvs, orchWebhookEnvs, notifyActionCard } from './orchestrator/notify.mjs';
import { resolveTier, tierEnvPatch, resolveGatewayAdmin, validateTierModel, validateTierViaGateway, tierTagNames, tierDisplayName } from './orchestrator/tiers.mjs';
import { applyEphemeralToken, findUnrevokedHarnessId, provisionTaskHarness, revokeTaskHarness } from './orchestrator/provision.mjs';
import { shellSpawnOptions } from './orchestrator/spawn-shell.mjs';
import { runDrill } from './orchestrator/drill.mjs';
import { parseDurationMinutes, canSailSubmit, snapshotQueue, snapshotDrafts, diffQueueStates, buildSailReport, buildSailSummary, SAIL_STOP_FILE } from './orchestrator/sail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_VERSION = 'phase1';

/** worker 瞬时故障（429 限流/网络抖动）原地重试上限；退避基值×attempt（与 dockmaster
 *  技能「429 退避 60s」口径一致）。基值解析序：ORCH_RETRY_WAIT_MS env（测试收缩到 10ms
 *  级，生产行为不变；storm-gate 集成测试依赖毫秒级退避）> workflow.json retryWaitBaseMs
 *  （B11 常量收口）> 缺省 60s。 */
const MAX_WORKER_RETRIES = 3;
function retryWaitBaseMs(cfg) {
  const n = Number.parseInt(process.env.ORCH_RETRY_WAIT_MS ?? '', 10);
  if (Number.isInteger(n) && n >= 0) return n;
  return cfg?.retryWaitBaseMs ?? 60_000;
}

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

function findRepoRoot() {
  // 与 feature-branch.mjs 同款（--git-common-dir）：linked worktree 内它指向主仓库的
  // .git，据此推出主仓库根——--show-toplevel 会返回 worktree 自身，把 queue/ 锚进
  // worktree，与「finish 需主仓库检出」矛盾（两处实现曾语义相反，统一到前者）。
  // git 不可用时回退向上找 .git。
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (common) {
      const dotGit = path.resolve(process.cwd(), common);
      if (fs.existsSync(dotGit)) return path.dirname(dotGit);
    }
  } catch { /* not inside a repo (or git missing) — fall through to the walk-up */ }
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) die('无法定位仓库根（当前目录不在 git 仓库内）。请从主仓库根目录运行 orchestrator。');
    dir = parent;
  }
}

function die(msg, code = 1) {
  console.error(`[orchestrator] ${msg}`);
  process.exit(code);
}

const log = (msg) => console.log(msg);

/** 卡目标首行（任务通报/花名册的「为什么」原料）：查不到卡或解析失败返回空串。 */
function cardGoalLine(repoRoot, taskId) {
  try {
    const card = findCard(queueRoot(repoRoot), taskId);
    if (!card) return '';
    const parsed = parseCard(fs.readFileSync(card.path, 'utf8'), taskId);
    return String(parsed.body?.goal ?? '').replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

/**
 * 卡片落位通知（merged/awaiting-human/blocked/failed）：按任务号为话题的任务通报——
 * 为什么（卡目标）/ 成果（worker 交付摘要）/ 过程（事件流阶段链）/ 结果（落位理由），
 * 夜跑无人值守时手机可扫读。尽力而为——webhook 未配置时零开销，通道失败静默，
 * 绝不影响编排本身。
 * 双向批示：需要人工动作的落位（awaiting-human=人工合并闸门；blocked 含预算熔断/
 * 看门狗等 circuit_breaker 落位）在文本通知外叠加一张飞书交互卡片（approve/reject
 * 按钮，回调 approval-listener）——notify.cardWebhook 未开启（缺省）时 notifyActionCard
 * 内部直接短路，零开销零行为变化。
 */
async function settleNotify(repoRoot, taskId, state, reason) {
  try {
    const cfg = loadWorkflowConfig(repoRoot);
    let events = [];
    try { events = readEvents(logDir(repoRoot, taskId)); } catch { /* 无事件流照发（手工场景退化为一行） */ }
    await notify({
      title: `${displayProjectName(cfg.projectName ?? '')} 任务通报`,
      body: buildTaskDigest({ taskId, state, reason, why: cardGoalLine(repoRoot, taskId), events }),
      webhookEnvs: orchWebhookEnvs(repoRoot),
    });
    if (state === 'awaiting-human' || state === 'blocked') {
      await notifyActionCard({
        repoRoot,
        webhookEnvs: orchWebhookEnvs(repoRoot),
        taskId,
        title: `${displayProjectName(cfg.projectName ?? '')} 待批示`,
        reason: `${taskStateTag(state)}${reason ? `：${String(reason).slice(0, 200)}` : ''}`,
      });
    }
  } catch { /* 通知失败不阻断编排 */ }
}

// ---------------------------------------------------------------------------
// 事件与预算
// ---------------------------------------------------------------------------

// Budget 类已迁至 orchestrator/budget.mjs（含低油量软告警；单测直接 import 驱动）。

function cleanupOrphanWorker(repoRoot, taskId) {
  // 崩溃恢复：running/ 卡片若记录的 worker PID 仍存活（孤儿），先杀整棵进程树。
  // 不做 role 过滤：最后一条 spawn 可能是 reviewer 的（崩溃在审查段），孤儿 reviewer 同样要杀——
  // 与 resolveBackendName 只认 worker 侧的口径差异是有意的
  const events = readEvents(logDir(repoRoot, taskId));
  const spawned = [...events].reverse().find((e) => e.type === 'worker_spawned');
  if (!spawned?.pid || !isAlive(spawned.pid)) return false;
  // 杀树前校验属主（P0）：isAlive 会被 pid 复用骗过——陈锁属主早已退出、pid 被无辜新进程
  // 顶掉时，旧实现直接 taskkill /T /F 误杀。worker 是先 spawn 后落事件，真实孤儿的运行
  // 时长 ≈ 事件距今；进程显著比事件「年轻」= pid 已被复用，跳过。elapsed 不可测（ps/
  // PowerShell 失败等）保持旧语义照杀——孤儿泄漏比误杀可自愈性更差的方向维持原样。
  const ownership = orphanOwnership(spawned.ts, processElapsedMs(spawned.pid));
  if (ownership === 'recycled') {
    log(`pid=${spawned.pid} 已被其他进程复用（启动时间晚于 spawn 事件，非本任务 worker），跳过终止。`);
    return false;
  }
  log(`发现孤儿 worker（pid=${spawned.pid}）仍在运行，先终止进程树再恢复。`);
  killTree(spawned.pid);
  return true;
}

function debugIterations(events) {
  return events.filter((e) => e.type === 'debug_iteration').length;
}
function reviewIterations(events) {
  return events.filter((e) => e.type === 'review_iteration').length;
}

// ---------------------------------------------------------------------------
// worktree 准备（复用 feature-branch.mjs，不另起分支体系）
// ---------------------------------------------------------------------------

function worktreePath(repoRoot, taskId) {
  return path.join(repoRoot, '.agents', 'worktrees', taskId);
}

function ensureWorktree(repoRoot, taskId) {
  const wt = worktreePath(repoRoot, taskId);
  if (fs.existsSync(wt)) {
    // 恢复/重试场景：worktree 已在，校验它确实注册在 git worktree 列表里。
    // 路径必须归一化后再比：Windows 上 git porcelain 输出正斜杠（C:/a/b），
    // path.join 生成反斜杠（C:\a\b），且 NTFS 大小写不敏感——精确比对永远失配
    //（曾致 Windows CI 上 retry/resume 误报"残留壳"）。
    const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
    const registered = out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .some((l) => norm(l.slice('worktree '.length)) === norm(wt));
    if (!registered) {
      die(`目录 ${wt} 已存在但未注册为 git worktree（疑似残留壳）。\n请按 .agents/workflows/worktree-rescue.md 处理后重试。`);
    }
    return wt;
  }
  const r = spawnSync('node', [path.join(repoRoot, '.agents', 'scripts', 'feature-branch.mjs'), 'start', taskId], {
    cwd: repoRoot,
    stdio: 'inherit',
    // 闭环上下文标记：cmdRun 已抢任务锁并把卡迁 running/，start 的认领逻辑见到
    // 它必须整体跳过——否则闭环会被自己拉起的 start 拒在门外（锁持有者就是闭环）。
    env: { ...process.env, ORCHESTRATOR_CLOSURE: '1' },
  });
  if (r.status !== 0) die(`feature-branch start 失败（exit ${r.status}）`, r.status ?? 1);
  if (!fs.existsSync(wt)) die(`feature-branch start 声称成功但未找到 worktree：${wt}`);
  return wt;
}

/**
 * worktree 依赖准备：见 orchestrator/deps.mjs（可注入 spawnFn 供单测）。
 */
function installWorkspaceDeps(worktree, taskId) {
  return installWorkspaceDepsImpl(worktree, taskId, { log, die });
}

// ---------------------------------------------------------------------------
// run 主流程
// ---------------------------------------------------------------------------

/**
 * 引水闸判定（compulsory pilotage）：受限航道 = deps 类型卡，或 files_hint 与
 * 核心/发布路径相交。这类改动影响面大、回归代价高，未经人工确认不得自动开航
 * （cmdRun 开航前拦截；drain 侧跳过并列「待引水」清单）。
 */
function pilotageRequired(meta, cfg) {
  return pilotageReason(meta, cfg) !== null;
}

/** 命中受限航道的具体原因；不在受限航道返回 null（cmdRun 报错与 drain 日志共用文案）。
 *  核心/发布路径都未配置时 hintsOverlap 与空集相交恒真（「完全通配=独占」语义），
 *  会把所有卡误判成引水卡——路径表为空 = 航道未设限，直接放行。 */
function pilotageReason(meta, cfg) {
  if (meta.type === 'deps') return 'type: deps（依赖变更）';
  const restricted = [...(cfg.corePaths ?? []), ...(cfg.releasePaths ?? [])];
  if (restricted.length && hintsOverlap(meta.files_hint, restricted)) return 'files_hint 命中核心/发布路径';
  return null;
}

async function cmdRun(repoRoot, taskId, opts) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const cfg = runConfig(repoRoot); // repoRoot 锚定：临时仓库（集成测试）用它们自己的 workflow.json
  const baseBranch = cfg.baseBranch || 'develop';
  // 配置守卫（B7）：run 启动即记 workflow.json 基线；此后每个 worker 会话派发前校验
  // （漂移 = 授权配置被外部改写 → 停止派发新会话，在途会话照常收尾）。
  if (cfg.configGuard?.enabled !== false) captureConfigBaseline(repoRoot);
  const found = findCard(root, taskId);
  if (!found) die(`任务 "${taskId}" 不在队列中（任何状态目录都没找到）。先用 submit 提交任务卡。`);
  if (!['pending', 'running', 'awaiting-human', 'reviewing'].includes(found.state)) {
    die(`任务 "${taskId}" 当前状态为 ${found.state}，只能从 pending/running/awaiting-human(retry)/reviewing 启动。`);
  }
  const { meta, body } = parseCard(fs.readFileSync(found.path, 'utf8'), found.path);
  validateCard(meta); // budget 缺失字段回落默认值（熔断不可关闭）
  const card = { meta, body };
  const qdir = logDir(repoRoot, taskId);

  // 任务级互斥（task-lock.mjs）：同一任务同一时刻只允许一个闭环进程驱动——手动
  // run/resume/retry 撞上 drain、双重手动操作等所有"两个 worker 写同一个 worktree"
  // 的路径都在这里被拒。持有进程死亡 = 陈锁自动接管，崩溃恢复语义不变（下方的
  // cleanupOrphanWorker 因此只会在接管后遇到活孤儿）。
  const taskLock = acquireTaskLock(repoRoot, taskId);
  if (!taskLock.held) {
    if (taskLock.unremovable) {
      die(`任务 "${taskId}" 的任务锁无法接管（陈锁删除失败，可能被其他进程占用）。\n手动删除 ${taskLockPath(repoRoot, taskId)} 后重试。`);
    }
    const owner = taskLock.owner;
    die(`任务 "${taskId}" 已有进行中的闭环（pid ${owner.pid}${owner.cmd ? `，${owner.cmd}` : ''}${owner.acquired_at ? `，始于 ${owner.acquired_at}` : ''}）——同一任务不允许两个进程同时驱动（两个 worker 会写同一个 worktree）。\n`
      + `  等当前 run 结束后再操作；持锁进程心跳停止 ${TASK_LOCK_STALE_MS / 1000}s 后陈锁自动接管（无需手动清理或终止进程，陈锁接管与孤儿清理各自带属主校验）。`);
  }

  // 引水闸（compulsory pilotage）：受限航道卡（deps 类型 / files_hint 命中核心·发布路径）
  // 未经人工确认不得开航——这类改动影响面大、回归风险高，先由人过目再放行。卡留在
  // pending/ 原地不动（die 在 moveCard 之前）；确认后带 --pilot-approved 重跑（未知
  // --flag 由 main 收进 opts.flags，无需改参数解析）。锁的释放沿用陈锁自动接管语义，
  // 与下方 ui_check die 路径一致。
  if (found.state === 'pending' && pilotageRequired(meta, cfg) && !opts.flags?.has('--pilot-approved')) {
    appendEvent(qdir, 'pilotage_required', { reason: pilotageReason(meta, cfg) });
    die(`本卡属于受限航道（${pilotageReason(meta, cfg)}），开航前需人工引水确认。\n`
      + `  确认后放行：node .agents/scripts/orchestrator.mjs run ${taskId} --pilot-approved\n`
      + `  （drain 不会派发未确认的引水卡；确认过的卡请逐张显式 run。）`);
  }

  // ui_check 预校验：卡要求 UI 冒烟但仓库没配 uiCheckCmd → 快速失败，卡留 pending 不动
  if (meta.ui_check && !runConfig(repoRoot).uiCheckCmd) {
    die('任务卡声明 ui_check: true，但 .agents/workflow.json 未配置 uiCheckCmd（Web 控制台沙箱冒烟命令）。\n补配置（如 "node scripts/ui-smoke.mjs"）或去掉该字段后重试。');
  }

  // backend 持久化：retry/resume 续跑沿用上次会话的后端（显式 --backend 可覆盖）
  const backendExplicit = opts.backend; // undefined 或用户显式 --backend（覆写前捕获，配置默认判定用）
  const resolved = resolveBackendName(opts, qdir, readEvents);
  opts.backend = resolved.name;
  if (resolved.inherited) log(`沿用上次会话后端：${opts.backend}`);

  // 执行引擎：显式 --worker-backend > 显式 --backend（整体指定，mock 测试路径依赖此语义）
  // > resume 沿用（resolved.inherited，任务连续性优先）> workflow.json worker.backend 默认 > 缺省。
  if (opts.workerBackend) opts.backend = opts.workerBackend;
  else if (!backendExplicit && !resolved.inherited && cfg.worker?.backend && cfg.worker.backend !== opts.backend) {
    opts.backend = cfg.worker.backend;
    log(`执行引擎（workflow.json worker 默认）：${opts.backend}`);
  }
  // 后端切换人工闸门：最终 worker 引擎 ≠ workflow.json worker.backend（配置默认）即视为「切换 CLI」，
  // 必须显式批准才放行——自治跑在引擎起不来时静默换引擎，会把任务烧到非预期的模型与账单上
  // （2026-10-29 夜跑事故：ORCH_ZCODE_CLI 未设 → zcode ENOENT/GLM 429 → 全量静默切 claude-headless 直连 DeepSeek）。
  // 包络豁免（动态选船，阶段 3）：dynamicDispatch.enabled = 船东对「包络内互切」的持久批准
  // （写进配置即授权，同 escalation.fallbackBackend 哲学）——起止两船都在 envelope 内的切换
  // 不再要求每卡 --approve-backend-switch；包络外照旧拒绝（envelope 规范化把 mock/未知船剔除）。
  const ddEnvelope = cfg.dynamicDispatch?.enabled ? normalizeEnvelope(cfg.dynamicDispatch.envelope).envelope : [];
  const envelopeAuthorized = ddEnvelope.includes(opts.backend) && ddEnvelope.includes(cfg.worker?.backend);
  if (cfg.worker?.backend && opts.backend !== cfg.worker.backend && !envelopeAuthorized
      && !opts.flags?.has('--approve-backend-switch') && process.env.ORCH_APPROVE_BACKEND_SWITCH !== '1') {
    die(`执行引擎 ${opts.backend} ≠ workflow.json worker.backend（${cfg.worker.backend}）：切换 CLI 需人工审核。\n`
      + `确认切换：本命令追加 --approve-backend-switch（或设环境 ORCH_APPROVE_BACKEND_SWITCH=1）；\n`
      + `不切换：修复原引擎的启动环境（如设 ORCH_ZCODE_CLI、GLM 429 退避并降并发）后重跑；任务卡未动。`);
  }

  // ---- 开航前海况观测（fleet observe，纯观测零决策，2026-11-03 船东定案阶段 1）----
  // 拉网关接入态/熔断写事件线并告警（船绕狗粮、服务熔断在起跑前可见）。只观测不决策：
  // 观测缺席绝不阻断派发（gatewayAdmin 未开 = 完全静默，行为不变）。位置在引擎闸门之后、
  // 预算校准之前：阶段 3 动态选船可能据此换船，换船后的 budget profile / 审查异构解析 /
  // tier 告警口径都按最终船计算（事件时间线上 fleet_observed 因此先于 budget_profile/tier_resolved）。
  const fleet = await observeFleetForRun(cfg, { backend: opts.backend });
  for (const line of fleet.lines) log(line);
  if (fleet.event) appendEvent(qdir, 'fleet_observed', fleet.event);

  // ---- 动态选船（dynamic dispatch，阶段 3）：海况 + 卡难度在预授权包络内自动选船 ----
  // 缺省关（workflow.json 无 dynamicDispatch 键 = 决策完全不参与，行为与历史一致）；
  // 显式 CLI 引擎与 resume 沿用不越权；换船记 dispatch_selected 事件（永不静默红线）。
  // 决策纯逻辑在 orchestrator/dispatch.mjs（难度路由不需要网关；逐船海况判读用上面的观测快照）。
  const dispatch = await decideDispatchForRun({
    repoRoot,
    cfg,
    meta,
    defaultBackend: opts.backend,
    explicit: Boolean(backendExplicit || opts.workerBackend),
    inherited: resolved.inherited,
    tier: resolveTier(meta, cfg), // 与下方 tier 段同源重算（纯函数）：难度信号在这里就要用
    fleetState: fleet.state,
  });
  for (const line of dispatch.lines) log(line);
  for (const ev of dispatch.events) appendEvent(qdir, ev.type, ev);
  if (dispatch.switched) {
    log(`动态选船生效：执行引擎 ${opts.backend} → ${dispatch.backend}（envelope 持久授权）`);
    opts.backend = dispatch.backend;
  }
  const dispatchModel = dispatch.switched ? dispatch.model : null; // 换船按船注入的可选模型（优先级低于 CLI/tier）
  const workerModel = opts.workerModel ?? cfg.worker?.model ?? undefined; // 仅 claude 系 CLI 生效（--model）

  // 按引擎校准预算（workflow.json budgetProfiles，调大不关闭，不破「熔断不可关闭」红线）：
  // zcode headless 无逐 turn usage（会话结束才回填）+ GLM 缓存读口径失真，默认 token
  // 预算对 zcode 形同虚设（夜跑 8 次 max_tokens 误熔断实证）——放宽后 wall-clock 才是真熔断。
  const budgetProfile = cfg.budgetProfiles?.[opts.backend];
  if (budgetProfile && Object.keys(budgetProfile).length) {
    Object.assign(meta.budget, budgetProfile);
    appendEvent(qdir, 'budget_profile', { backend: opts.backend, overrides: budgetProfile });
    log(`预算按引擎校准（${opts.backend}）：${Object.entries(budgetProfile).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  // 审查后端（异构审查）：执行与审查分体。显式 --review-backend / workflow.json review >
  // 上次会话 > 自动异构（真实后端互审，mock 永不异构）> 回落同源。未知名字在这里快速失败。
  const resolvedReview = resolveReviewBackendName({
    worker: opts.backend,
    explicit: opts.reviewBackend ?? cfg.review?.backend ?? undefined,
    prior: readEvents(qdir).find((e) => e.type === 'review_spawned')?.backend,
  });
  opts.reviewBackend = resolvedReview.name;
  const reviewModel = opts.reviewModel ?? cfg.review?.model ?? undefined;
  const reviewBackend = await getBackend(opts.reviewBackend); // 校验存在性并复用（未知后端统一在此报错，不进 worker 循环）
  if (resolvedReview.mode === 'heterogeneous') {
    log(`审查后端（异构）：${opts.reviewBackend}（worker=${opts.backend}，引擎异源互审，避免同源自审盲区）`);
  } else if (resolvedReview.mode === 'explicit' && opts.reviewBackend !== opts.backend) {
    log(`审查后端（显式）：${opts.reviewBackend}`);
  } else if (resolvedReview.mode === 'fallback' && opts.backend !== 'mock') {
    log(`⚠ 异构审查候选 CLI 不可用——审查回落 worker 同源（${opts.backend}）。安装另一引擎（claude / zcode）后可恢复互审。`);
  }
  if (workerModel || reviewModel) {
    log(`引擎模型：执行 ${workerModel ?? '（默认）'} / 审查 ${reviewModel ?? '（默认）'}（model 仅 claude 系生效，zcode 跟随其默认）`);
  }

  // ---- 任务等级（tier）：按难度选服务与模型 ----
  // 车钟四档 ahead-1..4（显示「前进1-4」）；卡显式 tier（heavy/light 为兼容别名）
  // > files_hint 命中核心/发布路径自动升 ahead-4 > 无（保持全局默认路由）。
  // 凭据经 tokenEnv 环境变量注入（token 不入库）；显式点名但未配置 → 告警降级，
  // 自动升级但 token 未设 → 静默跳过（高频路径，告警会淹日志）。
  const tier = resolveTier(meta, cfg);
  // zcode 船不支持 tier（不认 ANTHROPIC_* 注入，见 orchestrator.md A4）是文档化设计：
  // 其卡上的 tier 只作档位留痕（tier_resolved 事件），未设 tokenEnv 不算异常——不告警
  // （2026-11-02 四档实测发现：前进1/2 每卡一行 ⚠ 告警属噪音，已静默）。
  const tierWarnable = opts.backend !== 'zcode-headless';
  if (meta.tier && tier?.inactive === 'unconfigured') {
    if (tierWarnable) log(`⚠ tier "${meta.tier}" 未生效：workflow.json 未配置该 tiers 键——按全局默认路由执行`);
  } else if (meta.tier && tier?.inactive === 'token') {
    if (tierWarnable) log(`⚠ tier "${meta.tier}" 未生效：环境变量 ${tier.tokenEnv} 未设——按全局默认路由执行`);
  } else if (tier?.token) {
    log(`任务等级：${tierDisplayName(tier.name)}（${tier.name}${tier.auto ? '，files_hint 命中核心/发布路径自动升档' : ''}，token 来自 ${tier.tokenEnv}）`);
  }
  // 模型生效优先级：CLI 单次覆盖 > tier 配置 > 动态选船按船注入（仅换船时）> workflow.json 全局默认
  const effWorkerModel = opts.workerModel ?? tier?.workerModel ?? dispatchModel ?? workerModel;
  const effReviewModel = opts.reviewModel ?? tier?.reviewModel ?? reviewModel;
  if (tier?.token && (effWorkerModel !== workerModel || effReviewModel !== reviewModel)) {
    log(`tier 模型：执行 ${effWorkerModel ?? '（默认）'} / 审查 ${effReviewModel ?? '（默认）'}`);
  }
  // 网关权威校验（gatewayAdmin: true 开启，2026-11-02 船东授权 admin 面）：token 现在真实
  // 解析到哪个 profile、带什么 tier 标签，网关说了算。分级处置：
  //   tier 已打标（存在同标签 profile）但 token 指向别档/无标签 profile → 阻断（重活静默
  //   落到别档服务正是 tier 隔离要防的事，派发前拦下；发生在任何状态迁移之前）；
  //   token 网关解析失败（未注册/悬空路由）→ 阻断（tier 流量每一笔都会 401，派发必烧）；
  //   tier 未打标（网关无同标签 profile）→ 告警不阻断（tier 标签未采纳，向后兼容）；
  //   网关不可得（未开启/不可达/旧版无端点）→ 回落 advisory 目录校验，行为不变。
  let gatewayVerdict = null;
  // A4 预算实测账的 harness↔task 映射：tier token 经网关解析到的 harness id（无 tier 卡为
  // null——实测轮询不启动，自报账兜底）。实测油量与离线对账靠它定位「这个 worker 的实测账」。
  let measuredHarness = null;
  if (tier?.token) {
    gatewayVerdict = await validateTierViaGateway({ token: tier.token, tier: tier.name, base: tier.gatewayBase, optIn: tier.gatewayAdmin });
    if (gatewayVerdict.mode === 'gateway' && gatewayVerdict.ok) measuredHarness = gatewayVerdict.harness ?? null;
    if (gatewayVerdict.mode === 'gateway' && gatewayVerdict.ok) {
      const tagged = tierTagNames(tier.name).flatMap((n) => gatewayVerdict.tierProfiles?.[n] ?? []);
      if (tagged.length && !tagged.includes(gatewayVerdict.profile)) {
        die(`tier "${tier.name}" 权威校验失败：token（${tier.tokenEnv}）经网关解析到 profile "${gatewayVerdict.profile}"（tier=${gatewayVerdict.tierTag ?? '无标签'}），而 ${tierTagNames(tier.name).join('/')} 打标在 ${tagged.join(', ')}——重活会静默落到别档服务。\n修复：在 ModelDock 把该 token 所属 harness（${gatewayVerdict.harness}）钉定（route）到同 tier profile，或给当前 profile 补 tier 标签并热加载；确认无误可改卡去掉 tier 字段。`, 1);
      }
      log(`tier 网关校验：token → ${gatewayVerdict.harness} → profile "${gatewayVerdict.profile}"（provider=${gatewayVerdict.provider}，tier=${gatewayVerdict.tierTag ?? '无标签'}${tagged.length ? '' : '；该 tier 尚未在网关打标，跳过匹配判定'}）`);
      if (gatewayVerdict.provider && (effWorkerModel || effReviewModel)) {
        const missing = [effWorkerModel, effReviewModel].filter(Boolean).filter((m) => !gatewayVerdict.models.includes(m));
        if (missing.length) log(`⚠ tier 模型校验：${missing.join(', ')} 不在服务 ${gatewayVerdict.provider} 目录——继续派发，留意网关模型报错`);
      }
    } else if (gatewayVerdict.mode === 'gateway') {
      die(`tier "${tier.name}" 权威校验失败：tier token 未能在网关解析到路由（${gatewayVerdict.reason}）——tier 流量每笔请求都会 401，派发必烧。\n修复：核对 ${tier.tokenEnv} 指向的 token 是否仍存在于 ModelDock（harness 未删/未轮换），或改卡去掉 tier 字段走全局默认。`, 1);
    }
  }
  appendEvent(qdir, 'tier_resolved', {
    tier: tier?.name ?? (meta.tier ?? null),
    ...(tier?.auto ? { auto: true } : {}),
    ...(tier?.inactive ? { inactive: tier.inactive } : {}),
    ...(tier?.token && tier.provider ? { provider: tier.provider } : {}),
    ...(effWorkerModel ? { worker_model: effWorkerModel } : {}),
    ...(effReviewModel ? { review_model: effReviewModel } : {}),
    ...(gatewayVerdict?.mode === 'gateway' && gatewayVerdict.ok
      ? { gateway_checked: true, gateway_profile: gatewayVerdict.profile, gateway_provider: gatewayVerdict.provider, gateway_tier: gatewayVerdict.tierTag ?? null, gateway_harness: gatewayVerdict.harness ?? null }
      : {}),
  });
  // 目录校验（advisory）：网关权威校验不可得时的回落路径；模型名不在服务目录 → 告警不阻断
  if (tier?.token && gatewayVerdict?.mode !== 'gateway' && tier.provider && (effWorkerModel || effReviewModel)) {
    const v = await validateTierModel({
      gatewayBase: tier.gatewayBase,
      token: tier.token,
      provider: tier.provider,
      models: [effWorkerModel, effReviewModel],
    });
    if (!v.ok) log(`⚠ tier 目录校验：${v.reason}${v.missing?.length ? `（${v.missing.join(', ')}）` : ''}——继续派发，留意网关模型报错`);
  }
  let tierEnv = tierEnvPatch(tier); // gatewayProvision 生效时 ephemeral token 会并入（下方 applyEphemeralToken）

  // reviewing 也算恢复场景（2026-10-31 卡 19）：审查阶段硬崩的卡，此前唯一程序化
  // 出口是 abandon 强制落 failed；TRANSITIONS 本就允许 reviewing→running，run/resume
  // 白名单放行后归位 running，复用下方 resuming 分支注入恢复上下文。
  const resuming = ['running', 'reviewing'].includes(found.state);
  if (resuming) cleanupOrphanWorker(repoRoot, taskId);
  if (found.state === 'pending') {
    moveCard(root, taskId, 'pending', 'running');
    appendEvent(qdir, 'task_accepted', { backend: opts.backend });
  } else if (found.state === 'awaiting-human') {
    // CLI 直跑形态：状态检查放行 awaiting-human，但卡不先迁移就进闭环的话，第一个
    // 终态迁移 moveCard('running', …) 会因源目录无卡抛 QueueError——兜底 failTaskToBlocked
    // 只认 running/reviewing，异常裸栈崩出。走 retry 同款合法迁移先进 running/，再进状态机。
    moveCard(root, taskId, 'awaiting-human', 'running');
    appendEvent(qdir, 'task_accepted', { backend: opts.backend, from_state: 'awaiting-human' });
    log('awaiting-human 卡直跑：先迁移回 running/（无 retry 补充指令，仅重启闭环）');
  } else if (found.state === 'reviewing') {
    moveCard(root, taskId, 'reviewing', 'running');
    appendEvent(qdir, 'task_accepted', { backend: opts.backend, from_state: 'reviewing' });
    log('reviewing 卡直跑：先迁移回 running/（审查中断恢复，注入恢复上下文）');
  }

  const worktree = ensureWorktree(repoRoot, taskId);
  installWorkspaceDeps(worktree, taskId);
  copySpecArtifacts(repoRoot, worktree, meta);
  appendEvent(qdir, 'worktree_ready', { path: worktree, branch: `feature/${taskId}` });

  // ---- fastlane（轻卡快速通道）：声明即请求跳过 LLM 审查子循环，门禁/红线/调试子循环/
  // 分级闸门一个不省。跑前已知的前提在这里结清（fastlane_skipped 事件留痕，永不静默）；
  // 跑后才知道的实际改动分级在门禁后的决策点再判。一旦失效本次 run 不复活——fixup 只会
  // 让改动面更复杂，「同一张卡时快时慢」无法解释。
  let fastlaneWanted = meta.fastlane === true;
  if (fastlaneWanted && cfg.fastlaneAllowed === false) {
    // 团队级总开关关闭（workflow.json fastlaneAllowed: false）：声明被忽略，照跑审查
    appendEvent(qdir, 'fastlane_skipped', { reason: 'disabled_by_config' });
    fastlaneWanted = false;
  } else if (fastlaneWanted && meta.gate === 'L3') {
    // gate=L3（发布类/全人工）：L3 本就永不自动合并，审查保护的仍是人审质量——不省
    appendEvent(qdir, 'fastlane_skipped', { reason: 'gate_l3' });
    fastlaneWanted = false;
  } else if (fastlaneWanted && readDegraded(repoRoot)) {
    // drift 降级期间：自动合并信任已被打破的保险丝期，恰恰不能省审查
    appendEvent(qdir, 'fastlane_skipped', { reason: 'drift_degraded' });
    fastlaneWanted = false;
  }

  let backend = await getBackend(opts.backend); // 升级链第 1 档可能自动换船（prompt 超限切 fallback）
  const ctx = {
    repoRoot,
    worktreePath: worktree,
    playbooksDir: path.join(repoRoot, '.agents', 'workflows'),
  };

  // ---- 确定性偏航报警（xte = cross track error，observe-only）：纯规则检查，只留痕
  // 不动作（kill/熔断仍归预算与看门狗）。三条规则：no_commit（连续 2 个 worker 会话零
  // 新提交）、test_loop（npm_test 连续 2 轮 fail）、scope_drift（越界文件数达阈值）。
  const xte = createXteAlarm(qdir, worktree);

  const events = readEvents(qdir);
  let debugIter = debugIterations(events);
  let reviewIter = reviewIterations(events);
  // 燃油软告警接线（B5）：低油量事件留痕 + 引水传令注入船长收尾令。收尾令每 run 只注入
  // 一次（tokens/wall 两路各触发一次事件，同一命令重复注入只会堆噪音）；硬熔断阈值不受
  // 影响——软告警是「提醒收尾」，不是「提前停车」。
  let lowFuelOrdered = false;
  const budget = new Budget(card, (e) => {
    appendEvent(qdir, 'budget_low_fuel', e);
    if (!lowFuelOrdered) {
      lowFuelOrdered = true;
      appendInbox(qdir, '【船长收尾令】燃油余量不足 20%：完成手头工作、跑测试、在 worktree 提交，按契约层输出结果块；不要再开新战线、不要重构、不要修与验收无关的问题。');
      log('⛽ 燃油低水位（80%）：budget_low_fuel 已留痕，收尾令已写 inbox（下次会话边界送达 worker；硬熔断阈值不变）');
    }
  });
  // 进程级看门狗接线：熔断触发时杀当前在跑的 spawn（worker 或 reviewer），
  // spawn 因 close 事件 resolve 后，下方 budget.tripped 检查接手落 blocked/
  let livePid = null;
  budget.onTrip = () => {
    if (livePid) {
      log(`⏱ 熔断触发，终止在跑进程树（pid=${livePid}）……`);
      killTree(livePid);
    }
  };
  const trackPid = (e) => {
    if (e.type === 'worker_spawned') livePid = e.pid;
  };

  // ---- 每任务一次性凭据（ephemeral harness，provision.mjs，B16）：gatewayProvision: true
  // 且 admin 可得 → spawn 前向网关签发临时 harness，worker/reviewer 的 env patch 只换
  // ANTHROPIC_AUTH_TOKEN（base_url 仍由 ModelDock attach 写好的客户端配置决定，不越权）。
  // 所有失败形态 fail-open：回落 tier token / 全局默认，行为与未接入完全一致，仅留
  // harness_provision_failed 事件。凭据生命周期 = 本 run 进程的活跃会话窗口：
  //   ① 接管路径——上次 run（崩溃/被杀）签发未吊销的先 best-effort 吊销再签新的（幂等）；
  //   ② 终态落位（blocked/failed 经 exitRun，merged / awaiting-human 经 finally）——退出前吊销；
  //   ③ kill-tree/熔断终归收敛到 ①②（die 语义 = process.exit，finally 不跑，故 exitRun 显式吊销）。
  // 吊销失败只告警不阻断、不重试（重试风暴红线），漏网凭据由 TTL（≤24h）自然过期兜底。
  const provGa = cfg.gatewayProvision === true ? resolveGatewayAdmin(cfg) : null;
  let taskHarness = null; // { id, expiresAt, revoked }；签发失败/未启用保持 null（fail-open 走旧路径）
  if (cfg.gatewayProvision === true && !provGa) {
    appendEvent(qdir, 'harness_provision_failed', { reason: 'admin 未配置（gatewayAdmin 未开启或未发现网关）——回落既有凭据路径' });
    log('⚠ 一次性凭据：gatewayProvision 已开但 admin 不可得（需 gatewayAdmin: true + 网关可发现）——回落既有凭据路径');
  }
  if (provGa) {
    const stale = findUnrevokedHarnessId(readEvents(qdir));
    if (stale) {
      const rv = await revokeTaskHarness(provGa, stale);
      appendEvent(qdir, 'harness_revoked', { harness_id: stale, ok: rv.ok, existed: rv.revoked === true, trigger: 'takeover', ...(rv.reason ? { reason: rv.reason } : {}) });
      if (rv.ok) log(`🔑 接管清理：上次 run 的一次性凭据已吊销（harness=${stale}）`);
      else log(`⚠ 上次 run 的一次性凭据吊销失败（${rv.reason}）——harness=${stale} 留待 TTL 自然过期，不重试`);
    }
    const pr = await provisionTaskHarness(provGa, { taskId });
    if (pr.ok) {
      taskHarness = { id: pr.harnessId, expiresAt: pr.expiresAt, revoked: false };
      tierEnv = applyEphemeralToken(tierEnv, pr); // 同形通道只换 token；claude 双通道与 zcode env 透传照旧
      measuredHarness = pr.harnessId; // 实测账按一次性 harness 精确取数（专属凭据无兄弟流量，基线污染消失）
      appendEvent(qdir, 'harness_provisioned', { harness_id: pr.harnessId, expires_at: pr.expiresAt ?? null });
      log(`🔑 一次性凭据已签发：harness=${pr.harnessId}（有效期至 ${pr.expiresAt ?? 'TTL 上限'}；收尾即吊销）`);
    } else {
      appendEvent(qdir, 'harness_provision_failed', { reason: pr.reason });
      log(`⚠ 一次性凭据签发失败（${pr.reason}）——fail-open 回落既有凭据路径（行为不变）`);
    }
  }
  // 吊销本 run 已签发的凭据（幂等防重入）：exitRun（die 路径）与 finally（return 路径）共用
  const revokeRunHarness = async (trigger) => {
    if (!taskHarness || taskHarness.revoked || !provGa) return;
    taskHarness.revoked = true;
    const rv = await revokeTaskHarness(provGa, taskHarness.id);
    appendEvent(qdir, 'harness_revoked', { harness_id: taskHarness.id, ok: rv.ok, existed: rv.revoked === true, trigger, ...(rv.reason ? { reason: rv.reason } : {}) });
    if (!rv.ok) log(`⚠ 一次性凭据吊销失败（${rv.reason}）——harness=${taskHarness.id} 留待 TTL 自然过期，不重试`);
  };
  // 终态落位出口：die = process.exit（finally 不跑），先 best-effort 吊销再退出
  const exitRun = async (msg, code = 1) => {
    await revokeRunHarness('terminal');
    die(msg, code);
  };

  // ---- 预算实测账（A4，supply.mjs）：worker 运行中每 60s 轮询 harness-usage 的
  // day_billable_tokens（网关实测可计费口径）喂 budget.accountMeasured——zcode 无逐 turn
  // 自报（结束才一次性回填），实测账让它获得真实逐时段 token 预算；字段缺失（旧网关）/
  // 观测不可达 → null → 自报账兜底，行为不回退。reconcile 离线对账逻辑不动。
  // gatewayProvision 生效时 harness = 本任务专属 ephemeral id（上方签发），精确取数；
  // 未启用/签发失败回落 tier token 经 tier-validate 解析的 harness id（基线法照旧）。
  const measuredFuel = startMeasuredFuelPoller({ budget, cfg, harness: measuredHarness, log });

  // ---- 进展看门狗（watchdog.mjs）：worker 每 N 个 turn 由一次性 headless LLM 判断是否有
  // 实质进展。observe（缺省）只记 watchdog_suspect 事件；actuate 连续 2 次 suspect 走既有
  // stuck 熔断路径 kill→blocked。检查会话与 worker/reviewer 完全隔离（只读、不记账、无
  // 事件）；防重入/次数上界/错误静默的纯逻辑在 createWatchdogState。mock 后端跳过（mock
  // spawn 会写文件——判定无意义还污染 worktree 与门禁）。
  // LLM 决策留底（trace.mjs）：workflow.json trace 键控制（缺省开启），watchdog/reviewer
  // 的模型输入与原始输出落盘 logs/<taskId>/decisions/ 供复盘；enabled=false 不传 traceDir。
  const traceCfg = cfg.trace;
  const watchdogState = createWatchdogState(cfg.watchdog);
  let workerSessionSeq = 0; // 每次 worker spawn 递增：在途检查的结论只对本会话生效
  let workerInFlight = false; // worker spawn 在跑标记（收尾即清，防陈旧结论动作）
  let escalatedThisRun = false; // 升级链：每 run 至多自动升档一次（engine_escalated 防刷屏）
  let watchdogHalted = false; // 看门狗 actuate 已落位：主循环收敛标志（见 runWatchdogCheck circuit_break 分支）
  const watchdogSpawn = opts.backend === 'mock' ? null : makeWatchdogSpawnFn(backend, { cwd: worktree, model: effWorkerModel, envPatch: tierEnv });
  const runWatchdogCheck = async (session) => {
    try {
      const verdict = await watchdogCheck({ goal: card.body.goal, timeline: watchdogTimelineSummary(readEvents(qdir)), spawnFn: watchdogSpawn, traceDir: traceCfg.enabled ? qdir : null, traceOpts: traceCfg });
      if (session !== workerSessionSeq || !workerInFlight) return; // 会话已翻篇/已收尾：结论作废（任务落位后不再触发）
      const live = findCard(root, taskId);
      if (!live || live.state !== 'running') return; // 卡已落位：不动作
      if (verdict.error) {
        // 永不静默，但防刷屏：watchdog_error 每任务最多记 3 条，之后静默
        if (watchdogState.recordError()) appendEvent(qdir, 'watchdog_error', { error: String(verdict.error).slice(0, 300) });
        return;
      }
      const action = watchdogState.report(verdict.progressing, verdict.reason);
      if (action === 'suspect') {
        appendEvent(qdir, 'watchdog_suspect', { turn: watchdogState.snapshot().turns, reason: String(verdict.reason).slice(0, 300) });
        log(`⚠ 进展看门狗（observe）：worker 疑似空转——${verdict.reason}`);
      } else if (action === 'circuit_break') {
        log(`⛔ 进展看门狗（actuate）：连续 2 次判定无实质进展——${verdict.reason}`);
        appendEvent(qdir, 'circuit_breaker', { reason: 'watchdog', detail: String(verdict.reason).slice(0, 300) });
        if (livePid) {
          log(`⏱ 看门狗熔断，终止在跑 worker 进程树（pid=${livePid}）……`);
          killTree(livePid);
        }
        moveCard(root, taskId, 'running', 'blocked');
        archiveIncident(repoRoot, taskId, root, qdir, '看门狗判定任务空转（actuate 连续 2 次）');
        await settleNotify(repoRoot, taskId, 'blocked', '看门狗判定任务空转（actuate 连续 2 次）');
        // 置停止标志而非 die()（process.exit）：本回调是 fire-and-forget 的异步续体，die
        // 直接退出进程会跳过 cmdRun 的 finally——orch-prompt-* / orch-settings-* mkdtemp
        // 目录与 reviewer 各轮临时目录每轮熔断泄漏一次（2026-11-05 审查项）。killTree 后
        // spawn close 收敛，主循环见标志即正常 return 走 finally（临时目录清理/任务锁释放/
        // 油量轮询停止）；落位语义（blocked + circuit_breaker 事件 + 事故归档 + 通报）不变。
        watchdogHalted = true;
      }
    } catch {
      // 看门狗自身异常绝不影响编排；「永不静默」由上面的 watchdog_error 事件承担
    } finally {
      watchdogState.endCheck();
    }
  };
  const onWatchdogTurn = () => {
    const action = watchdogState.onTurn();
    if (action === 'disabled') {
      appendEvent(qdir, 'watchdog_disabled', { checks: watchdogState.snapshot().checks });
      return;
    }
    if (action !== 'check' || !watchdogSpawn) return;
    watchdogState.beginCheck();
    const session = workerSessionSeq;
    void runWatchdogCheck(session); // fire-and-forget：流消费不等待 LLM 判断
  };
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prompt-')), 'prompt.md');
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-settings-')), 'settings.json');
  // reviewer 临时目录（orch-review-* / orch-review-settings-*）：审查阶段每轮新建一个，
  // 旧实现从不清理（每轮泄漏 1-2 个）——统一登记，finally 清单兜底（2026-10-31 卡 19）
  const reviewTempDirs = [];

  const runStarted = Date.now();

  try {
    let promptText = buildWorkerPrompt(card, ctx);
    if (resuming) {
      // 崩溃恢复 = 接班：现场重组成「交接班单」（值班交接四要素）注入——船位（事件
      // 时间线折叠尾部）、航向与天气（NOTES.md 全文，start 模板已含四要素段）、油量
      // （最后一条 budget_snapshot 对 max_tokens 的占比；接棒预算已重置须明说，防
      // worker 误以为余量紧张提前收工）。worker 按单续航，不重做已完成的工作。
      // 时间线先折叠（coalesceEvents）：逐 turn 高频事件塌缩成 ×N 一行，同样 60 条
      // 原始事件的预算能覆盖比裸截 12 条长得多的中断前窗口。
      const notes = safeRead(path.join(worktree, 'NOTES.md'));
      const snap = [...events].reverse().find((e) => e.type === 'budget_snapshot' && Number.isFinite(e.tokens_in));
      const maxTokens = meta.budget?.max_tokens;
      // 油量口径与 max_tokens 熔断一致（可计费，剔除缓存读）：新事件带 tokens_billable
      // 用之；旧事件回落 tokens_in（缓存读计入，读数偏保守）并如实标注口径
      const oilVal = snap ? (Number.isFinite(snap.tokens_billable) ? snap.tokens_billable : snap.tokens_in) : 0;
      const oilScope = snap && Number.isFinite(snap.tokens_billable) ? '可计费口径' : '旧口径（含缓存读）';
      const oil = snap && maxTokens
        ? `油量：已耗 ${Math.round((oilVal / maxTokens) * 100)}%（${oilVal} / ${maxTokens} tokens，${oilScope}）；本次接棒预算已重置`
        : '油量：尚无用量快照（上次中断在首次记账之前）；本次接棒预算已重置';
      promptText +=
        `\n\n---\n\n# 交接班单（上次值班留下的现场）\n\n` +
        `上次值班在中途被中断。按四要素核对现场：先核对船位（已完成部分，不要重做），再沿航向继续未完成的部分；NOTES.md 里有上次值班自己留的四要素记录。\n\n` +
        `## 船位（事件时间线尾部）\n${formatTimeline(coalesceEvents(events.slice(-60)))}\n\n` +
        `## 航向与天气（worktree NOTES.md 全文）\n${notes || '（空——请先按模板补全 NOTES.md 的交接班四要素再继续）'}\n\n` +
        `## 油量\n${oil}\n`;
    }
    // 会话边界送达 follow-up（订阅直通，cmdFollow 写 inbox）：初始 spawn / fixup /
    // 审查返工 / resume 是运行中会话唯一的注入窗口，一律追加在 prompt 尾部。
    promptText = injectFollowUps(qdir, promptText);

    for (;;) {
      // ---- 熔断收敛闸（循环顶）：wall/token 熔断若在审查段触发，trip() 一次性清掉
      // wallTimer 不再重挂，而既有 tripped 检查只在 worker spawn close 之后——审查返工
      // continue 回到这里会 spawn 一个**完全无 wall 限制**的 worker 会话，跑到
      // max_turns/token 上限才落 blocked（熔断后白烧一整轮）。任何 continue/重试路径
      // 都先过这里，按既有 blocked 落位口径收敛（此时卡必在 running/：唯一 continue
      // 是审查返工 moveCard('reviewing','running') 之后）。
      if (budget.tripped) {
        appendEvent(qdir, 'circuit_breaker', { reason: budget.tripReason.reason, detail: budget.tripReason.detail });
        moveCard(root, taskId, 'running', 'blocked');
        appendEvent(qdir, 'blocked', { reason: `budget:${budget.tripReason.reason}` });
        archiveIncident(repoRoot, taskId, root, qdir, `budget:${budget.tripReason.reason}`);
        await settleNotify(repoRoot, taskId, 'blocked', `预算熔断 ${budget.tripReason.reason}`);
        await exitRun(`预算熔断：${budget.tripReason.reason}（${budget.tripReason.detail}）。任务已转 blocked/，人工决策后再继续。`);
      }
      // ---- 配置守卫派发闸（B7）：workflow.json 漂移即停止派发新 worker 会话 ----
      // 在途会话已收尾、下一个会话（初始/fixup 返工）尚未开始 = 派发点。漂移说明授权
      // 配置被外部改写（被调度方自改合并、人工误改、另一 agent 的合并）——继续用被改
      // 的授权面派发等于盲飞。卡转 blocked 交人工核实（改回基线自动恢复派发是 drain/
      // watch 侧语义；run 进程内直接落 blocked 最收敛），编排器自己的合并会在 doApprove
      // 重置基线，不会走到这里。
      if (cfg.configGuard?.enabled !== false) {
        const drift = checkConfigDrift(repoRoot);
        if (!drift.ok) {
          const detail = `workflow.json 配置漂移（基线 ${String(drift.drift.from).slice(0, 12)} → 当前 ${String(drift.drift.to).slice(0, 12)}）`;
          appendEvent(qdir, 'config_drift_detected', { from: drift.drift.from, to: drift.drift.to });
          try { appendFleetEvent(repoRoot, 'config_drift_detected', { task: taskId, from: drift.drift.from, to: drift.drift.to }); } catch { /* 留痕失败不阻断 */ }
          moveCard(root, taskId, 'running', 'blocked');
          appendEvent(qdir, 'blocked', { reason: 'config_drift' });
          archiveIncident(repoRoot, taskId, root, qdir, detail);
          await settleNotify(repoRoot, taskId, 'blocked', detail);
          await exitRun(`⛔ ${detail}——配置守卫停止派发（授权配置被外部改写，继续派发 = 盲飞）。任务转 blocked/。\n`
            + `  人工核实改动：合法变更直接改回或重启编排器接受新基线；来历不明按事故处理。`);
        }
      }
      // ---- worker 会话（含 fixup 返工循环；瞬时故障原地退避重试，见 retry 处注释）----
      let result;
      let workerOutput = '';
      let transientAttempt = 0;
      let crash = null; // 结构化故障定性（B6/A1 cause 精读）：最后一次会话的分类结果，blocked 理由消费
      let promptFileRefLogged = false; // D17 留痕防刷屏：每 run 记一次 prompt_file_ref
      for (;;) {
        const sessionStartMs = Date.now(); // 本会话起点：结构化故障识别（B6）的日志查询窗口左界
        budget.beginSession(); // 上会话用量入账 committed，本会话从零峰值起算
        xte.beforeWorkerSession(); // 偏航 no_commit：记会话起点 HEAD（连续 2 会话零提交报警）
        appendEvent(qdir, 'budget_baseline', { tokens_in: budget.tokens, tokens_billable: budget.billable });
        workerSessionSeq += 1; // 看门狗：会话代次（重试/fixup 均翻篇，在途结论随之作废）
        workerInFlight = true; // 看门狗：spawn 在跑标记
        {
          // 大 prompt 落文件（D17）：超过阈值先把全文落 logs/<taskId>/prompt-full.md
          // （.agents/orchestrator/logs 已 gitignore——不进 worktree、不污染 diff/审查面），
          // 正文收缩为「文件引用 + 要点摘要」，worker 开工先读全文。zcode argv 30k 上限
          // 因此在常规路径不再触达；escalation 换船保留为最后兜底（阈值 20k < 30k，
          // 正常不再触发；fixup/resume 追加的交接班单/失败输出同样被本收缩覆盖）。
          let spawnPrompt = promptText;
          if (promptText.length > PROMPT_FILE_THRESHOLD_CHARS) {
            const full = path.join(logDir(repoRoot, taskId), 'prompt-full.md');
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, promptText);
            spawnPrompt = buildPromptFileRefBody({ promptPath: full, card, ctx, originalChars: promptText.length });
            if (!promptFileRefLogged) {
              promptFileRefLogged = true;
              appendEvent(qdir, 'prompt_file_ref', { chars: promptText.length, threshold: PROMPT_FILE_THRESHOLD_CHARS, path: full });
              log(`📄 prompt 过大（${promptText.length} > ${PROMPT_FILE_THRESHOLD_CHARS} 字符）：全文已落 ${full}，worker prompt 收缩为文件引用 + 要点摘要（escalation 兜底保留）`);
            }
          }
          // 升级链第 1 档（escalation.mjs）：zcode 船 prompt 超限自动切 fallback 船——
          // escalation 配置即持久授权（同 autopilot），engine_escalated 事件留痕；
          // 预算延续不重置（Budget 实例不变，已耗口径延续）；每 run 至多升档一次。
          // D17 落文件后 spawnPrompt 恒小于阈值，此分支仅为兜底（如阈值被调大过 30k）。
          const esc = shouldEscalatePrompt({ backend: opts.backend, promptLen: spawnPrompt.length, cfg });
          if (esc.escalate && !escalatedThisRun) {
            escalatedThisRun = true;
            appendEvent(qdir, 'engine_escalated', { reason: 'prompt_oversize', from: opts.backend, to: esc.to, prompt_chars: spawnPrompt.length });
            log(`⏫ 升级链：${esc.reason}——自动切 fallback 船 ${esc.to}（engine_escalated 已留痕；预算延续不重置）`);
            opts.backend = esc.to;
            backend = await getBackend(esc.to);
          }
          fs.writeFileSync(promptFile, spawnPrompt);
          if (opts.backend === 'claude-headless') writeWorkerSettings(settingsFile, tierEnv, worktree);
          appendEvent(qdir, 'worker_spawned', { role: 'worker', backend: opts.backend, attempt: debugIter + reviewIter, ...(effWorkerModel ? { model: effWorkerModel } : {}) });
          if (fastlaneWanted) appendEvent(qdir, 'fastlane_active', { gate: meta.gate });
          result = await backend.spawn({
            promptFile,
            cwd: worktree,
            maxTurns: meta.budget.max_turns,
            onEvent: (e) => {
              appendEvent(qdir, e.type, e);
              trackPid(e);
              if (e.type === 'budget_snapshot') budget.account(e.tokens_in, e.tokens_out, e.tokens_cache_read); // 第三参缺省（旧事件/mock）= 旧口径
              if (e.type === 'worker_turn' && watchdogSpawn) onWatchdogTurn(); // 看门狗钩子行（observe/actuate 见 watchdog.mjs）
            },
            settingsFile,
            model: effWorkerModel, // 仅 claude 系生效（--model）；zcode-headless 忽略（模型跟随 ZCode 默认）
            envPatch: tierEnv, // tier 凭据注入（claude：settings.env + 子进程 env；zcode：子进程 env）
          });
          livePid = null;
          workerInFlight = false; // 看门狗：worker 会话收尾（在途结论回报时作废）
          workerOutput = result.output ?? '';
          if (result.stderrTail) appendEvent(qdir, 'worker_stderr_tail', { text: result.stderrTail.slice(-500) });
          if (watchdogHalted) {
            // 看门狗 actuate 已完成落位（blocked/ + circuit_breaker 事件 + 事故归档 + 通报）：
            // 主循环在此收敛退出、走 cmdRun 的 finally 清理。必须拦在瞬时故障重试判定之前——
            // killTree 的 stderr 尾巴可能撞上 transient 签名，误触发原地重试再派新会话。
            log('进展看门狗（actuate）连续 2 次判定无实质进展，任务转 blocked/，人工决策后再继续。');
            return;
          }
          if (budget.tripped) {
            killTree(result.pid);
            appendEvent(qdir, 'circuit_breaker', { reason: budget.tripReason.reason, detail: budget.tripReason.detail });
            moveCard(root, taskId, 'running', 'blocked');
            appendEvent(qdir, 'blocked', { reason: `budget:${budget.tripReason.reason}` });
            archiveIncident(repoRoot, taskId, root, qdir, `budget:${budget.tripReason.reason}`);
            await settleNotify(repoRoot, taskId, 'blocked', `预算熔断 ${budget.tripReason.reason}`);
            await exitRun(`预算熔断：${budget.tripReason.reason}（${budget.tripReason.detail}）。任务已转 blocked/，人工决策后再继续。`);
          }
        }
        // 自报不可信：先解析契约块。异常结束（无结果块）→ 结构化信号优先定性（B6 +
        // 2026-11 A1 cause 精读）：查网关日志会话窗口内本 harness 的崩溃记录——状态码
        // 429/5xx/quota 命中 = 结构化 transient（上游改错误文案不再致盲）；cause 精读
        // （proto_endpoint_missing/unauthorized = 判定性失败、quota = 建议换 provider、
        // key_cooldown/key_pool_empty = 带 keypool 重试窗口）。未命中/无网关数据
        // （gatewayLogDir 未配、读取失败 fail-open、worker 绕行网关）→ 落回既有 stderr
        // 正则兜底。定性为 transient 且重试配额未尽 → 原地退避重试同一 prompt（重试窗口
        // 优先用 crash.retryMs，否则 60s×attempt，≤3 次，事件留痕带识别来源），worktree
        // 半成品改动就地续用；否则或自报 stuck → 走既有 blocked 路径（decisive 时理由带
        // 可操作报错）。重试配额耗尽也照常分类——决定性归因要点名给人工。
        const preClaimed = parseResultBlock(workerOutput);
        if (!preClaimed) {
          crash = await classifyWorkerCrashFromDisk({
            gwDir: gatewayLogsDir(cfg),
            cfg,
            output: workerOutput,
            stderrTail: result.stderrTail,
            window: { startMs: sessionStartMs, endMs: Date.now() },
            backend: opts.backend,
          });
          if (crash.transient && transientAttempt < MAX_WORKER_RETRIES) {
            transientAttempt += 1;
            const waitMs = crash.retryMs ?? retryWaitBaseMs(cfg) * transientAttempt;
            appendEvent(qdir, 'worker_retry', {
              attempt: transientAttempt,
              max: MAX_WORKER_RETRIES,
              wait_ms: waitMs,
              source: crash.source,
              ...(crash.source === 'gateway' ? { gateway_hits: crash.hits, signature: crash.reason } : {}),
              ...(crash.switchProvider ? { switch_provider: true } : {}),
              ...(crash.retryMs ? { retry_ms_source: 'keypool' } : {}),
            });
            const how = crash.source === 'gateway' ? `网关日志 ${crash.hits} 条崩溃记录（${crash.reason}）` : 'stderr 瞬时签名';
            log(`⚠ worker 疑似瞬时故障（${how}）——${waitMs >= 1000 ? `${Math.round(waitMs / 1000)}s` : `${waitMs}ms`} 后原地重试（${transientAttempt}/${MAX_WORKER_RETRIES}）`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
        }
        break;
      }
      xte.afterWorkerSession(); // 偏航 no_commit：会话收尾对账 HEAD（observe-only，只留痕）

      // ---- 自报不可信：先解析契约块，再亲自跑门禁 ----
      const claimed = parseResultBlock(workerOutput);
      if (!claimed || claimed.status !== 'done') {
        // cause 精读（A1）：决定性归因（proto_endpoint_missing / unauthorized）→ blocked
        // 理由带可操作报错（cause + hint/tokenHint 点名），替代千篇一律的「未产出结果块」
        // ——人工拿到理由即可动手修，不用再翻网关日志。
        const blockedReason = claimed?.status === 'stuck'
          ? 'worker 自报 stuck'
          : crash?.decisive
            ? crash.reason
            : '未产出结果块（worker 异常结束）';
        appendEvent(qdir, 'blocked', {
          reason: blockedReason,
          ...(crash?.decisive
            ? {
                cause: crash.cause,
                ...(crash.hint ? { hint: crash.hint } : {}),
                ...(crash.tokenHint ? { token_hint: crash.tokenHint } : {}),
              }
            : {}),
        });
        moveCard(root, taskId, 'running', 'blocked');
        archiveIncident(repoRoot, taskId, root, qdir, blockedReason);
        await settleNotify(repoRoot, taskId, 'blocked', blockedReason);
        log(`worker 未报告完成（${claimed?.status ?? '无结果块'}）。任务转 blocked/，NOTES.md 已留现场，人工决策：`);
        log(`  node .agents/scripts/orchestrator.mjs resume ${taskId}   # 带恢复上下文续做`);
        log(`  node .agents/scripts/orchestrator.mjs abandon ${taskId}   # 按 Rescue 流程清理`);
        return;
      }
      appendEvent(qdir, 'worker_done', { summary: String(claimed.summary ?? '').slice(0, 200) });

      // ---- 静态门禁（数据表驱动，agents-hygiene-batch）----
      // 五段同构 try/catch（npm_test/tsc_build/lint/typecheck/ui_check）收敛为数据表 +
      // 单个执行函数 runGates：run → pass 记 gate_result → GateError 时 debug_iteration 计数、
      // 超限熔断、否则返回 fixup 由调用方返工。ui_check 在红线段之后执行（事件顺序与原实现
      // 一致），故分 STATIC_GATES / UI_GATES 两批经同一 runGates 执行。数据差异全在表：
      // passExtra 定制 pass 事件附加字段（npm_test 的 duration_ms/head 供 approve 的 finish
      // 快捷路径，其余的 skipped）。红线段（port_scan/native_scan）直接 failed 不可调试，不在此表。
      const runGates = async (gates) => {
        for (const g of gates) {
          try {
            const r = await g.run(); // 门禁已异步化（runCmd 拿 pid 做超时树杀）
            appendEvent(qdir, 'gate_result', { gate: g.gate, result: 'pass', ...(g.passExtra ? g.passExtra(r) : {}) });
          } catch (e) {
            if (!(e instanceof GateError)) throw e;
            appendEvent(qdir, 'gate_result', { gate: g.gate, result: 'fail' });
            debugIter += 1;
            appendEvent(qdir, 'debug_iteration', { attempt: debugIter, trigger: g.trigger, max: meta.budget.max_test_iterations });
            if (debugIter > meta.budget.max_test_iterations) {
              appendEvent(qdir, 'circuit_breaker', { reason: 'max_test_iterations', detail: `${debugIter}/${meta.budget.max_test_iterations}` });
              moveCard(root, taskId, 'running', 'blocked');
              archiveIncident(repoRoot, taskId, root, qdir, `调试子循环超限（${debugIter} 次${g.dieLabel ? `，${g.dieLabel}` : ''}）`);
              await settleNotify(repoRoot, taskId, 'blocked', `调试子循环超限（${debugIter} 次${g.dieLabel ? `，${g.dieLabel}` : ''}）`);
              await exitRun(`调试子循环超限（${debugIter} 次${g.dieLabel ? `，${g.dieLabel}` : ''}）。${g.dieTail}`);
            }
            return { trigger: g.trigger, output: e.output };
          }
        }
        return null;
      };
      // 改动分级前置（原在门禁后）：门禁按实际改动面自适应选测试面——L0 纯文档卡跑
      // testCmdL0 轻量门禁（不烧全量回归），代码卡照旧全量；fastlane 与合并决策复用
      // 同一份结论（审查只读，改动面前后不变）。
      const changed = changedFiles(worktree, baseBranch);
      const classification = classifyChange(changed, cfg);
      const docsOnly = changed.length > 0 && changed.every((f) => /\.md$/i.test(f.replace(/\\/g, '/')));
      const STATIC_GATES = [
        {
          gate: 'npm_test',
          run: () => gateNpmTest(worktree, docsOnly && cfg.testCmdL0 ? cfg.testCmdL0.join(' && ') : cfg.testCmd.join(' && ')),
          trigger: 'test_failure',
          dieLabel: '',
          dieTail: '任务转 blocked/——测试仍不绿，人工接手。',
          passExtra: (r) => {
            // 记 worktree HEAD：approve 的 finish 快捷路径（--skip-test）靠它判断
            // 「gate 验证的就是当前树」——develop 未前进且 HEAD 一致才允许锁内跳过重跑
            let gateHead;
            try {
              gateHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
            } catch { /* 取不到 HEAD 就不记：approve 回落全量测试，语义安全 */ }
            return {
              duration_ms: r.durationMs,
              ...(gateHead ? { head: gateHead } : {}),
              ...(docsOnly && cfg.testCmdL0 ? { scoped: 'l0' } : {}),
            };
          },
        },
        {
          gate: 'tsc_build',
          // 纯文档卡跳过 build（.md 不进构建产物）——与 npm_test 的 L0 轻量门禁同档
          run: docsOnly ? () => ({ ok: true, skipped: true, reason: 'docs_only' }) : () => gateTscBuild(worktree, cfg.buildCmd),
          trigger: 'build_failure',
          dieLabel: 'build 不过',
          dieTail: '任务转 blocked/，人工接手。',
          passExtra: (r) => (r.skipped ? { skipped: true, ...(r.reason ? { reason: r.reason } : {}) } : {}),
        },
        {
          gate: 'lint',
          run: () => gateLint(worktree, cfg.lintCmd), // cmd 未配置 → 直接 skipped 返回
          trigger: 'lint_failure',
          dieLabel: 'lint 不过',
          dieTail: '任务转 blocked/，人工接手。',
          passExtra: (r) => (r.skipped ? { skipped: true } : {}),
        },
        {
          gate: 'typecheck',
          run: () => gateTypecheck(worktree, cfg.typecheckCmd),
          trigger: 'typecheck_failure',
          dieLabel: 'typecheck 不过',
          dieTail: '任务转 blocked/，人工接手。',
          passExtra: (r) => (r.skipped ? { skipped: true } : {}),
        },
      ];
      const fixup = await runGates(STATIC_GATES);
      xte.testLoop(); // 偏航 test_loop：npm_test 连续 2 轮 fail（从 gate_result 事件判定，observe-only）
      if (fixup) {
        promptText = injectFollowUps(qdir, buildFixupPrompt(card, ctx, fixup.trigger, fixup.output, debugIter));
        continue;
      }

      // 红线门禁：直接 failed，不可调试（未配置的红线在门禁内 skipped 返回，仍记 pass 事件）
      try {
        const portResult = gatePortScan(worktree, baseBranch, cfg.protectedPorts);
        appendEvent(qdir, 'gate_result', { gate: 'port_scan', result: 'pass', ...(portResult.skipped ? { skipped: true } : {}) });
      } catch (e) {
        if (!(e instanceof GateError)) throw e;
        appendEvent(qdir, 'gate_result', { gate: 'port_scan', result: 'fail', detail: e.message });
        moveCard(root, taskId, 'running', 'failed');
        appendEvent(qdir, 'failed', { reason: `红线门禁 port_scan：${e.message}` });
        archiveIncident(repoRoot, taskId, root, qdir, `红线门禁 port_scan：${e.message}`);
        await settleNotify(repoRoot, taskId, 'failed', '红线门禁 port_scan 未通过（不可调试）');
        await exitRun(`红线门禁 port_scan 未通过：${e.message}\n红线不可调试，任务转 failed/。`);
      }
      try {
        const nativeResult = gateNativeScan(worktree, baseBranch, cfg.packageManager);
        appendEvent(qdir, 'gate_result', { gate: 'native_scan', result: 'pass', ...(nativeResult.skipped ? { skipped: true } : {}) });
      } catch (e) {
        if (!(e instanceof GateError)) throw e;
        appendEvent(qdir, 'gate_result', { gate: 'native_scan', result: 'fail', detail: e.message });
        moveCard(root, taskId, 'running', 'failed');
        appendEvent(qdir, 'failed', { reason: `红线门禁 native_scan：${e.message}` });
        archiveIncident(repoRoot, taskId, root, qdir, `红线门禁 native_scan：${e.message}`);
        await settleNotify(repoRoot, taskId, 'failed', '红线门禁 native_scan 未通过（不可调试）');
        await exitRun(`红线门禁 native_scan 未通过：${e.message}\n红线不可调试，任务转 failed/。`);
      }

      // UI 冒烟门禁（任务卡 ui_check: true 才跑）：与静态段同经 runGates 执行（UI_GATES 单段表，
      // 位置在红线段之后——事件顺序与原实现一致）。失败进调试子循环（与 build 同级），不是红线。
      if (meta.ui_check) {
        const uiFixup = await runGates([
          {
            gate: 'ui_check',
            run: () => gateUiCheck(worktree, cfg.uiCheckCmd),
            trigger: 'ui_check_failure',
            dieLabel: 'ui_check 不过',
            dieTail: '任务转 blocked/，人工接手。',
            passExtra: (r) => (r.skipped ? { skipped: true } : {}),
          },
        ]);
        if (uiFixup) {
          promptText = injectFollowUps(qdir, buildFixupPrompt(card, ctx, uiFixup.trigger, uiFixup.output, debugIter));
          continue;
        }
      }

      const purity = gateScopePurity(worktree, meta.files_hint, baseBranch);
      xte.scopeDrift(purity.outside.length, (meta.files_hint ?? []).length); // 偏航 scope_drift（observe-only）
      appendEvent(qdir, 'gate_result', {
        gate: 'scope_purity',
        result: 'pass',
        outside: purity.outside.length ? purity.outside : undefined,
      });
      const cliTouched = gateCliEntry(worktree, baseBranch, cfg.corePaths); // 返回被触及的核心路径列表

      // ---- fastlane 决策点：实际改动面说了算（跑前只看声明，这里按真实分级复判）----
      // 分级计算自合并闸门段上移：fastlane 失效判定与合并决策共用同一份结论（reviewer
      // 只读，审查前后改动面不变）。
      appendEvent(qdir, 'gate_result', { gate: 'change_classification', result: classification.level, detail: classification.reasons.join('; ') });
      const rankOf = (l) => ['L0', 'L1', 'L2', 'L3'].indexOf(l);
      if (fastlaneWanted) {
        const degradedNow = readDegraded(repoRoot);
        if (degradedNow) {
          // drift 降级标记在跑动期间出现（并发任务的自动合并触发评估）：同样失效回常规链路
          appendEvent(qdir, 'fastlane_skipped', { reason: 'drift_degraded' });
          fastlaneWanted = false;
        } else if (['L2', 'L3'].includes(classification.level)) {
          // 实际改动分级 L2/L3（核心路径/发布流水线/未识别文件）：恰恰最需要审查——失效回常规链路
          appendEvent(qdir, 'fastlane_skipped', { reason: `actual_level_${classification.level.toLowerCase()}`, level: classification.level });
          fastlaneWanted = false;
        }
      }

      if (fastlaneWanted) {
        // ---- fastlane：跳过 LLM 审查子循环（不 spawn reviewer、不进 reviewing 状态），
        // review_verdict 记 skipped 留痕，直接进入合并闸门。自动合并四前提原样生效——
        // fastlane 只是少了一个审查阻塞来源，不降任何闸门。
        appendEvent(qdir, 'review_verdict', { verdict: 'skipped', reason: 'fastlane' });
      } else {
        // ---- LLM 独立审查（全新上下文；权限层强制只读，不靠 prompt 自觉）----
        // 审查用独立后端（reviewBackend ≠ worker backend 时为异构互审）：review_spawned
        // 记录审查引擎，retry/resume 沿用；fallback 回落同源时留痕供 drift 分析。
        const diff = execFileSync('git', ['diff', `${baseBranch}...HEAD`], { cwd: worktree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        moveCard(root, taskId, 'running', 'reviewing');
        if (resolvedReview.mode === 'fallback' && opts.backend !== 'mock') {
          appendEvent(qdir, 'review_backend_fallback', { worker: opts.backend, detail: '异构候选 CLI 不可用，审查回落 worker 同源' });
        }
        const reviewPromptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-review-'));
        reviewTempDirs.push(reviewPromptDir);
        const reviewPromptFile = path.join(reviewPromptDir, 'review-prompt.md');
        const reviewPromptText = buildReviewerPrompt(card, purity.outside.length ? diff + `\n\n# 范围警告\n以下改动超出 files_hint（${meta.files_hint.join(', ')}）：\n${purity.outside.join('\n')}` : diff, cfg.reviewNotes, reviewDiscipline(repoRoot));
        fs.writeFileSync(reviewPromptFile, reviewPromptText);
        const reviewStartedAt = Date.now();
        // review_spawned 在 spawn 成功返回后才落——spawn 失败（CLI 临时不可用）不写事件，
        // resume 的 prior 解析就不会钉死在坏后端上（自动异构会重新选）
        // reviewer 仅在 tier 生效时才拿专属 settings（注入 token）；平时保持无 settings 文件的旧行为
        const reviewWantsSettings = opts.reviewBackend === 'claude-headless' && Object.keys(tierEnv).length > 0;
        let reviewSettingsFile;
        if (reviewWantsSettings) {
          const reviewSettingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-review-settings-'));
          reviewTempDirs.push(reviewSettingsDir);
          reviewSettingsFile = path.join(reviewSettingsDir, 'review-settings.json');
          writeWorkerSettings(reviewSettingsFile, tierEnv, worktree);
        }
        // 审查会话独立记账：beginSession 把 worker 会话峰值入账 committed，审查用量从零峰值起算，
        // 下一次 beginSession（下轮 worker）把审查峰值入账——reviewer 的 budget_snapshot 此前只落
        // 盘不记账，max_tokens 硬熔断与低油量告警对审查段完全失明
        budget.beginSession();
        const review = await reviewBackend.spawn({
          promptFile: reviewPromptFile,
          cwd: worktree, // reviewer 只读，cwd 无关紧要但保持同环境
          maxTurns: cfg.reviewMaxTurns, // workflow.json 可调（缺省 30）
          onEvent: (e) => {
            appendEvent(qdir, e.type, e);
            trackPid(e);
            if (e.type === 'budget_snapshot') budget.account(e.tokens_in, e.tokens_out, e.tokens_cache_read); // 审查计入同一预算口径（第三参缺省 = 旧口径）
          },
          readonly: true, // 策略守护完整版：allowedTools 收敛为只读（fail-closed）
          model: effReviewModel, // 仅 claude 系生效（--model，分源换模型防同底座共因盲区）
          settingsFile: reviewWantsSettings ? reviewSettingsFile : undefined,
          envPatch: tierEnv,
        });
        livePid = null;
        appendEvent(qdir, 'review_spawned', { backend: opts.reviewBackend, ...(effReviewModel ? { model: effReviewModel } : {}) });
        const verdict = parseReviewVerdict(review.output ?? '');
        // 审查引擎故障快速落 blocked（exitCode≠0 且无契约块）：引擎死了不是审查意见，
        // 烧满返工轮只会把错误文本当 reviewer 意见反复注入（2026-11-03 夜航实证：claude
        // CLI 凭据失效时 result 事件携带 "Not logged in" 错误文本）。与 worker stuck 同等
        // 处置：可操作报错 + 留痕 + 通知，修复引擎后 resume。
        if (!verdict && (review.exitCode ?? 0) !== 0) {
          const stderrTail = String(review.stderrTail ?? '').trim().slice(-400);
          const detail = `审查引擎故障（${opts.reviewBackend} exit ${review.exitCode}）：${stderrTail || String(review.output ?? '').trim().slice(-200) || '无输出'}`;
          appendEvent(qdir, 'review_engine_failed', { backend: opts.reviewBackend, exitCode: review.exitCode, stderr_tail: stderrTail.slice(-400) });
          moveCard(root, taskId, 'reviewing', 'blocked');
          archiveIncident(repoRoot, taskId, root, qdir, detail);
          await settleNotify(repoRoot, taskId, 'blocked', detail);
          await exitRun(`${detail}\n任务转 blocked/，人工接手（修复审查引擎后 resume）。`, 1);
        }
        // 决策留底（kind=review）：reviewer prompt 全文（可能大，靠 trace 截断上界兜住）+
        // 模型原始输出落盘，审查误判可复盘；写失败内部消化（trace.mjs），不动审查链路
        writeDecisionTrace({ root: qdir, taskId, kind: 'review', input: reviewPromptText, output: String(review.output ?? ''), parsed: verdict, meta: { backend: opts.reviewBackend, ...(effReviewModel ? { model: effReviewModel } : {}), durationMs: Date.now() - reviewStartedAt } }, traceCfg);
        appendEvent(qdir, 'review_verdict', {
          blockers: verdict?.blockers ?? -1,
          suggestions: verdict?.suggestions ?? 0,
          notes: verdict?.notes ?? 0,
        });

        const blockers = verdict?.blockers ?? 1; // 解析不到按有阻塞保守处理
        if (blockers > 0) {
          reviewIter += 1;
          appendEvent(qdir, 'review_iteration', { attempt: reviewIter, max: meta.budget.max_review_iterations });
          if (reviewIter > meta.budget.max_review_iterations) {
            appendEvent(qdir, 'circuit_breaker', { reason: 'max_review_iterations', detail: `${reviewIter}/${meta.budget.max_review_iterations}` });
            moveCard(root, taskId, 'reviewing', 'blocked');
            archiveIncident(repoRoot, taskId, root, qdir, `审查返工超限（${reviewIter} 轮仍有阻塞项）`);
            await settleNotify(repoRoot, taskId, 'blocked', `审查返工超限（${reviewIter} 轮仍有阻塞项）`);
            await exitRun(`审查返工超限（${reviewIter} 轮仍有阻塞项）。任务转 blocked/，人工接手。`);
          }
          promptText = injectFollowUps(qdir, buildFixupPrompt(card, ctx, 'review_blockers', review.output ?? '', reviewIter));
          moveCard(root, taskId, 'reviewing', 'running');
          continue;
        }
      }

      // ---- 合并闸门：L0/L1 自动合并（Phase 2），L2/L3 人工 ----
      // 漂移降级（Phase 3）：自动合并回溯失败率超阈值期间，一切自动合并回人工——
      // 恢复只能人工 --clear，保险丝不自己插回去
      const degraded = readDegraded(repoRoot);
      if (degraded) {
        appendEvent(qdir, 'gate_result', { gate: 'auto_merge_degraded', result: 'skipped', detail: degraded.reason });
        log(`⚠ 质量降级生效中（${degraded.reason}）——本任务转人工闸门。恢复：drift --clear（人工确认漂移已消除后）。`);
      }
      // 自动合并前提（缺一不可）：无降级标记、任务卡显式声明允许自动（gate=L0/L1；L3=全人工永不自动）、
      // 实际改动分级可自动（L0/L1）且不超声明上限、无范围越界（scope_purity 有 outside
      // 一律回人工——范围失控不该静默合并）。fastlane 不参与判定：它只省审查，不降闸门。
      const autoEligible =
        !degraded &&
        ['L0', 'L1'].includes(meta.gate) &&
        ['L0', 'L1'].includes(classification.level) &&
        rankOf(classification.level) <= rankOf(meta.gate) &&
        purity.outside.length === 0;
      const gateFrom = fastlaneWanted ? 'running' : 'reviewing'; // fastlane 跳过 reviewing 状态：卡仍在 running/
      if (autoEligible) {
        appendEvent(qdir, 'auto_merge', { level: classification.level, gate: meta.gate, debugIter, reviewIter });
        moveCard(root, taskId, gateFrom, 'awaiting-human'); // 落位到闸门目录（不写 awaiting_human 事件，不等人）
        await doApprove(repoRoot, taskId, root, qdir, 'auto');
        appendEvent(qdir, 'budget_snapshot', { tokens_in: budget.tokens, tokens_billable: budget.billable, tokens_cache_read: budget.cacheRead, elapsed_min: Math.round((Date.now() - runStarted) / 60000) });
        return;
      }

      moveCard(root, taskId, gateFrom, 'awaiting-human');
      const awaitReason = degraded ? 'drift_degraded' : purity.outside.length ? 'scope_outside' : `level ${classification.level} 超出 gate ${meta.gate} 上限或 gate=L3`;
      appendEvent(qdir, 'awaiting_human', { reason: awaitReason });
      await settleNotify(repoRoot, taskId, 'awaiting-human', awaitReason);
      const summary = {
        files: changedFiles(worktree, baseBranch).length,
        debugIter,
        reviewIter,
        tokens: budget.tokens,
        coreTouched: cliTouched,
        purityOutside: purity.outside,
        classification,
      };
      if (opts.interactive && process.stdin.isTTY) {
        await humanGateInteractive(repoRoot, taskId, root, qdir, summary, { backend: opts.backend, reviewBackend: opts.reviewBackend });
      } else {
        log(fastlaneWanted ? 'fastlane 轻卡（跳过 LLM 审查），任务已进入 awaiting-human/（人工合并闸门）。' : '审查通过，任务已进入 awaiting-human/（L3 人工合并闸门）。');
        printGateSummary(taskId, summary);
        log(`人工操作：node .agents/scripts/orchestrator.mjs approve|reject|retry ${taskId}`);
      }
      appendEvent(qdir, 'budget_snapshot', { tokens_in: budget.tokens, tokens_billable: budget.billable, tokens_cache_read: budget.cacheRead, elapsed_min: Math.round((Date.now() - runStarted) / 60000) });
      return;
    }
  } catch (e) {
    // 异步异常兜底：backend spawn 失败等——卡不得悬在 running/（见 failTaskToBlocked 注释）
    const reason = await failTaskToBlocked(repoRoot, root, qdir, taskId, e);
    if (reason) await exitRun(`${reason}\n任务已转 blocked/——修好环境后 resume ${taskId} 续做（events.jsonl 有完整时间线）。`);
    throw e;
  } finally {
    await revokeRunHarness('run_exit'); // 一次性凭据（B16）：run 进程收尾即吊销（die 路径已先走 exitRun，此处幂等防重入）
    measuredFuel.stop(); // 实测油量轮询（A4）：任务收尾即停，不留跨任务定时器
    clearTimeout(budget.wallTimer);
    releaseTaskLock(repoRoot, taskId);
    try {
      fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
      fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
      for (const d of reviewTempDirs) fs.rmSync(d, { recursive: true, force: true }); // reviewer 各轮临时目录
    } catch {}
  }
}

/**
 * cmdRun 异常兜底（工业级恢复性）：backend 启动失败（claude CLI 缺失/未登录）、
 * 内部未知错误等异步异常若不处理，任务卡会悬在 running/——状态机显示在跑、
 * 实际无进程，只能人工发现后 resume。这里统一落 blocked/ 附原因，resume 可续。
 * （业务性失败各环节已自行 die/迁移，不经过这里。）
 */
async function failTaskToBlocked(repoRoot, root, qdir, taskId, err) {
  const found = findCard(root, taskId);
  if (found && ['running', 'reviewing'].includes(found.state)) {
    const reason = `异常中断：${String(err?.message ?? err).slice(0, 300)}`;
    appendEvent(qdir, 'failed', { reason });
    moveCard(root, taskId, found.state, 'blocked');
    archiveIncident(repoRoot, taskId, root, qdir, reason);
    await settleNotify(repoRoot, taskId, 'blocked', reason);
    return reason;
  }
  return null;
}

/**
 * 偏航报警（xte = cross track error 航向偏差角，observe-only）：确定性规则检查，
 * 与 LLM 看门狗互补——看门狗靠模型判断「有没有实质进展」，这里只认机器可复核的
 * 硬信号。三条规则：
 *   no_commit   连续 2 个 worker 会话零新提交（HEAD 计数会话首尾对账）
 *   test_loop   npm_test 门禁连续 2 轮 fail（从 gate_result 事件判定）
 *   scope_drift scope_purity 越界文件数 ≥ max(3, files_hint 长度)
 * 每规则每任务至多报一次：内存 Set + 事件播种（resume 跨进程也不重报）。
 * 只留痕不动作——kill/熔断仍归预算与看门狗，报警是给人和夜跑摘要看的信号。
 */
function createXteAlarm(qdir, worktree) {
  const fired = new Set(readEvents(qdir).filter((e) => e.type === 'xte_alarm').map((e) => e.rule));
  const report = (rule, detail) => {
    if (fired.has(rule)) return;
    fired.add(rule);
    appendEvent(qdir, 'xte_alarm', { rule, detail });
    log(`⚠ 偏航报警（${rule}，只留痕不动作）：${detail}`);
  };
  const headCount = () => {
    try {
      return Number.parseInt(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), 10);
    } catch {
      return null; // git 异常不判（缺数据宁可漏报不误报）
    }
  };
  let sessionStart = null; // 本会话起点的 HEAD 提交数
  let zeroStreak = 0; // 连续零新提交的会话数
  return {
    beforeWorkerSession() {
      sessionStart = headCount();
    },
    afterWorkerSession() {
      if (sessionStart === null) return;
      const end = headCount();
      if (end === null) return;
      zeroStreak = end === sessionStart ? zeroStreak + 1 : 0;
      sessionStart = null;
      if (zeroStreak >= 2) report('no_commit', `连续 ${zeroStreak} 个 worker 会话零新提交（HEAD 停在 ${end}）——worker 可能空转`);
    },
    testLoop() {
      const results = readEvents(qdir).filter((e) => e.type === 'gate_result' && e.gate === 'npm_test').map((e) => e.result);
      if (results.length >= 2 && results[results.length - 1] === 'fail' && results[results.length - 2] === 'fail') {
        report('test_loop', 'npm_test 门禁连续 2 轮 fail——修复可能在同一处打转');
      }
    },
    scopeDrift(outsideCount, hintLen) {
      const threshold = Math.max(3, hintLen);
      if (outsideCount >= threshold) {
        report('scope_drift', `scope_purity 越界文件 ${outsideCount} 个 ≥ 阈值 ${threshold}——改动面可能失控`);
      }
    },
  };
}

/** 海况数字人性化：≥1e6 → M、≥1e3 → k；时延 ms → s。 */
function fmtSeaNum(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
function fmtSeaMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
function fmtSeaCounts(m, n = 3) {
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}×${v}`)
    .join(', ');
}

/**
 * 「上游海况」段渲染（数据来自 reconcile.mjs upstreamSeaState）：时间窗内网关请求的
 * 失败分布/路由痕迹/时延/实测用量 + 最近失败现场。跳过（未配置/无记录）时给可操作
 * 原因——调查包是附赠观测，缺数据不影响其他段。
 */
function renderSeaState(sea) {
  if (sea.skipped) return `- （跳过：${sea.reason}）`;
  const lines = [`- 请求 ${sea.requests} 条（成功 ${sea.ok} / 失败 ${sea.failed}）`];
  if (sea.failed) lines.push(`- 失败状态分布：${fmtSeaCounts(sea.failStatus)}`);
  const prov = fmtSeaCounts(sea.providers);
  if (prov) lines.push(`- 上游分布（前 3）：${prov}`);
  const models = fmtSeaCounts(sea.models);
  if (models) lines.push(`- 模型分布（前 3）：${models}`);
  if (Object.keys(sea.routeEvents).length) lines.push(`- 路由事件痕迹：${fmtSeaCounts(sea.routeEvents)}`);
  if (sea.latency.p50 !== undefined) lines.push(`- 时延 p50/p95：${fmtSeaMs(sea.latency.p50)} / ${fmtSeaMs(sea.latency.p95)}`);
  if (sea.tokens.in || sea.tokens.out) {
    lines.push(`- 实测用量：输入 ${fmtSeaNum(sea.tokens.in)}（缓存读 ${fmtSeaNum(sea.tokens.cacheRead)} / 缓存建 ${fmtSeaNum(sea.tokens.cacheCreate)}）/ 输出 ${fmtSeaNum(sea.tokens.out)}`);
  }
  if (sea.lastFailure) {
    const f = sea.lastFailure;
    lines.push(
      `- 最近失败：${f.ts}  status=${f.status ?? 'n/a'}  provider=${f.provider ?? '-'}${f.model ? `  model=${f.model}` : ''}${f.reason ? `  reason=${f.reason}` : ''}${f.err ? `  err=${f.err}` : ''}`,
    );
  }
  return lines.join('\n');
}

/**
 * 事故调查包（VDR，voyage data recorder 航行数据记录仪）：任务落 blocked/failed
 * 终态时刷新 logs/<id>/incident.md——概况/复诵现场/事件时间线/stderr 尾/上游海况
 * （网关请求日志投影）/改动概要/审查结论 + 考题草稿建议。每次终态整文件覆盖（幂等，
 * 重复落位不堆文件）；只读现场还原，绝不改动队列状态、worktree 与题库。生成失败只
 * 告警——调查包是附赠观测，不能影响落位流程本身。
 */
function archiveIncident(repoRoot, taskId, root, qdir, reason) {
  try {
    const events = readEvents(qdir);
    const found = findCard(root, taskId);
    let goal = '';
    let filesHint = [];
    if (found) {
      try {
        const { meta, body } = parseCard(fs.readFileSync(found.path, 'utf8'), found.path);
        goal = String(body.goal ?? '');
        filesHint = meta.files_hint ?? [];
      } catch { /* 损坏卡：调查包照出，字段留空 */ }
    }
    const state = found?.state ?? 'unknown';
    const notes = safeRead(path.join(worktreePath(repoRoot, taskId), 'NOTES.md')).trim();
    const stderrTail = [...events].reverse().find((e) => e.type === 'worker_stderr_tail')?.text ?? '';
    let diffStat = '';
    try {
      const base = loadWorkflowConfig(repoRoot).baseBranch || 'develop';
      diffStat = execFileSync('git', ['diff', '--stat', `${base}...HEAD`], { cwd: worktreePath(repoRoot, taskId), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
      diffStat = '（无法获取：worktree 缺失或 git 异常）';
    }
    const verdicts = events.filter((e) => e.type === 'review_verdict');
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    // 考题草稿：对齐 .agents/review-evals/cases/*.json schema；expect 留空由人工补——
    // 草稿只冻结客观现场（goal/files/reason），审查考点是人的判断。
    const exam = {
      id: `${ym}-${taskId}`,
      title: (goal || taskId).replace(/\s+/g, ' ').slice(0, 80),
      files: filesHint,
      expect: [],
      note: String(reason ?? '').slice(0, 300),
    };
    const text = [
      `# 事故调查包（VDR）：${taskId}`,
      '',
      `> 终态落位时自动生成（每次覆盖刷新，幂等）；只读现场还原，不改动队列状态。生成于 ${toIsoLocal(now)}。`,
      '',
      '## 任务概况',
      '',
      `- 目标: ${goal || '（未知）'}`,
      `- 终态: ${state}`,
      `- 原因: ${reason || '（未记录）'}`,
      '',
      '## 复诵现场（worktree NOTES.md，截 800 字）',
      '',
      notes ? notes.slice(0, 800) : '（worktree 无 NOTES.md）',
      '',
      '## 事件时间线（尾部 100 条，同型折叠）',
      '',
      '```',
      formatTimeline(coalesceEvents(events, { maxEntries: 100 })) || '（无事件）',
      '```',
      '',
      '## worker stderr 尾',
      '',
      '```',
      stderrTail || '（无 stderr 留痕）',
      '```',
      '',
      '## 上游海况（网关请求日志投影）',
      '',
      renderSeaState(upstreamSeaState(repoRoot, events)),
      '',
      '## 改动概要（worktree git diff --stat，相对基准分支）',
      '',
      '```',
      diffStat || '（无改动）',
      '```',
      '',
      '## 审查结论（review_verdict 事件）',
      '',
      verdicts.length
        ? verdicts
            .map((v) => `- ${v.ts}  ${v.verdict ? `verdict=${v.verdict}` : `blockers=${v.blockers ?? '?'}`}${v.reason ? ` reason=${v.reason}` : ''}${v.verdict ? '' : ` suggestions=${v.suggestions ?? '-'} notes=${v.notes ?? '-'}`}`)
            .join('\n')
        : '（无审查记录）',
      '',
      '## 考题草稿建议',
      '',
      '```json',
      JSON.stringify(exam, null, 2),
      '```',
      '',
      '人工按 .agents/review-evals/README.md 决定是否入库，本包不改动题库。',
      '',
    ].join('\n');
    const p = path.join(qdir, 'incident.md');
    fs.writeFileSync(p, text);
    appendEvent(qdir, 'incident_archived', { path: p });
    log(`📋 事故调查包已归档：${p}`);
    return p;
  } catch (e) {
    log(`⚠ 事故调查包生成失败（${taskId}）：${String(e?.message ?? e).slice(0, 160)}`);
    return null;
  }
}

function safeRead(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 审查纪律文本（REVIEW.md 摘要注入 reviewer prompt）：与人工/PR 审查同一套
 * 失败形态与红线标准——异构引擎 + 同一纪律才是完整去相关。截 8000 字符防
 * prompt 膨胀；文件缺失（可移植场景）返回空串不注入。
 */
function reviewDiscipline(repoRoot) {
  const text = safeRead(path.join(repoRoot, 'REVIEW.md'));
  if (!text.trim()) return '';
  const cap = 8000;
  return text.length > cap ? `${text.slice(0, cap)}\n…（REVIEW.md 超 ${cap} 字符已截断，全文见仓库根）` : text;
}

/**
 * spec 卡的设计/需求随 worktree 携带：specs/ 不入库（.gitignore 整目录忽略），
 * worktree checkout 看不到主仓库的 specs，而卡正文只写文件引用（防 zcode headless
 * 30k argv 上限被 design 全文爆掉）——prepare 阶段把 design.md / requirements.md
 * 拷进 worktree 同路径。目标路径在 .gitignore 内，不污染改动面与门禁。
 */
function copySpecArtifacts(repoRoot, worktree, meta) {
  if (!meta.spec) return;
  const src = path.join(repoRoot, '.agents', 'orchestrator', 'specs', meta.spec);
  const dst = path.join(worktree, '.agents', 'orchestrator', 'specs', meta.spec);
  if (!fs.existsSync(path.join(src, 'design.md'))) {
    log(`⚠ 规格 ${meta.spec} 的 design.md 缺失（${src}）——卡内文件引用将落空，worker 会自报 stuck；请补齐后 resume。`);
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ['design.md', 'requirements.md']) {
    if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
}

/**
 * run 场景的 workflow 配置（repoRoot 锚定——orchestrator 操作的仓库可能是集成测试
 * 的临时仓库，绝不许回落到脚本自身所在仓库的配置）。
 */
function runConfig(repoRoot) {
  const cfg = loadWorkflowConfig(repoRoot);
  if (!cfg.testCmd) die('.agents/workflow.json 缺少 testCmd——orchestrator 依赖它做验证门禁');
  return cfg;
}

function printGateSummary(taskId, s) {
  log(`════════ 任务 ${taskId} 待审 ════════`);
  log(`改动: ${s.files} 个文件        调试迭代: ${s.debugIter}  审查返工: ${s.reviewIter}`);
  log(`分级: ${s.classification.level}${s.classification.reasons.length ? `（${s.classification.reasons.join('；')}）` : ''}`);
  log(`预算: ${Math.round(s.tokens / 1000)}k tokens${s.coreTouched.length ? `        ⚠ 核心路径被触及（标红）：${s.coreTouched.join(', ')}` : ''}`);
  if (s.purityOutside.length) log(`⚠ 超出 files_hint 的改动：${s.purityOutside.join(', ')}`);
}

async function humanGateInteractive(repoRoot, taskId, root, qdir, summary, runOpts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));
  for (;;) {
    printGateSummary(taskId, summary);
    const ans = await ask('[a] 批准合并   [v] 查看 diff   [r] 驳回(附原因)   [b] 打回重试   [q] 搁置 > ');
    if (ans.trim() === 'a') {
      rl.close();
      await doApprove(repoRoot, taskId, root, qdir);
      return;
    }
    if (ans.trim() === 'v') {
      const hb = loadWorkflowConfig(repoRoot).baseBranch || 'develop';
      console.log(execFileSync('git', ['diff', `${hb}...HEAD`, '--stat'], { cwd: worktreePath(repoRoot, taskId), encoding: 'utf8' }));
      continue;
    }
    if (ans.startsWith('r')) {
      const reason = ans.slice(1).trim() || (await ask('驳回原因: '));
      rl.close();
      await doReject(repoRoot, taskId, root, qdir, reason);
      return;
    }
    if (ans.startsWith('b')) {
      const note = ans.slice(1).trim() || (await ask('补充指令: '));
      rl.close();
      await doRetry(repoRoot, taskId, root, qdir, note, runOpts);
      return;
    }
    if (ans.trim() === 'q') {
      rl.close();
      log('已搁置：任务留在 awaiting-human/，稍后用 approve/reject/retry 处理。');
      return;
    }
    log('无效输入，请选 a/v/r/b/q。');
  }
}

// ---------------------------------------------------------------------------
// 闸门操作（交互与非交互共用）
// ---------------------------------------------------------------------------

async function doApprove(repoRoot, taskId, root, qdir, source = 'human') {
  // source='human' 记人工闸门；'auto' 记自动合并（裁决依据已由 auto_merge 事件先行记录），
  // merged 事件带 auto 标记——Phase 3 质量漂移统计按此回溯自动合并的回溯失败率。
  if (source === 'auto') appendEvent(qdir, 'auto_merge_decision', { decision: 'merge' });
  else appendEvent(qdir, 'human_gate', { decision: 'approved' });
  // finish：rebase → testCmd → --no-ff 合并 → 清理分支与 worktree。
  // 门禁快捷路径：npm_test 门禁通过时记录了 worktree HEAD（gate_result.head），
  // approve 给 finish 带 --skip-test + ORCHESTRATOR_GATE_HEAD——finish 内部校验
  // 「develop 未前进 且 HEAD 与 gate 一致」成立才跳过锁内重跑，否则自动回落全量
  // （merge-verify-once：全量测试只跑一次，且不因跳过降低门禁强度）。
  const gateHead = (() => {
    const evts = readEvents(qdir);
    for (let i = evts.length - 1; i >= 0; i--) {
      const e = evts[i];
      if (e.type === 'gate_result' && e.gate === 'npm_test' && e.result === 'pass' && typeof e.head === 'string' && e.head) return e.head;
    }
    return null;
  })();
  const finishArgs = ['finish', taskId];
  const finishEnv = { ...process.env };
  if (gateHead) {
    finishArgs.push('--skip-test');
    finishEnv.ORCHESTRATOR_GATE_HEAD = gateHead;
  }
  // 撞锁有界重试：finish 对 .finish.lock 自带有界等待（FINISH_LOCK_WAIT_SECONDS），
  // 这里兜底等待超时/显式 cap=0 的情形——并发 drain 合并把「立即失败→任务卡滞留
  // awaiting-human 等人工重跑」收敛为自动排队。参数可环境收缩（测试用）：
  // ORCH_FINISH_RETRY_ATTEMPTS（额外重试次数，默认 2）、ORCH_FINISH_RETRY_DELAY_MS（默认 60000）。
  const extraAttempts = Number.parseInt(process.env.ORCH_FINISH_RETRY_ATTEMPTS ?? '', 10);
  const retryDelayRaw = Number.parseInt(process.env.ORCH_FINISH_RETRY_DELAY_MS ?? '', 10);
  const maxAttempts = (Number.isInteger(extraAttempts) && extraAttempts >= 0 ? extraAttempts : 2) + 1;
  const retryDelayMs = Number.isInteger(retryDelayRaw) && retryDelayRaw >= 0 ? retryDelayRaw : 60_000;
  const fbScript = path.join(repoRoot, '.agents', 'scripts', 'feature-branch.mjs');
  // 外层超时按 testCmd 数量动态放宽（P0 修复，2026-11）：finish 内每条验证命令上限
  // 20min（runCmd），数组多条时旧外层 30min 固定值先到——整树被杀、任务误判失败。
  // 预算 = N×20min + rebase/merge 余量 15min，下限保留旧 30min。
  const testCmdCount = loadWorkflowConfig(repoRoot).testCmd?.length ?? 0;
  const finishTimeoutMs = Math.max(30 * 60_000, testCmdCount * 20 * 60_000 + 15 * 60_000);
  let r = null;
  let lockConflict = false;
  for (let attempt = 1; ; attempt++) {
    // runArgvTreeSafe：detached（unix 进程组）+ 超时 killTree——spawnSync timeout 只杀
    // 直接子进程，finish 挂死时其内部 testCmd 进程树全部孤儿化（Windows 锁 worktree
    // 句柄致 EBUSY）。finish 挂死（含内部 testCmd）不能陪跑到底：超时按失败走（任务留 awaiting-human 可重试）
    r = await runArgvTreeSafe(['node', fbScript, ...finishArgs], {
      cwd: repoRoot,
      env: finishEnv,
      timeoutMs: finishTimeoutMs,
    });
    // 透传 finish 输出（保持现场可见性）；撞锁凭 stderr 文案识别
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    lockConflict = r.status !== 0 && /another finish is (already running|still running after waiting)/.test(r.stderr ?? '');
    if (r.status === 0 || !lockConflict || attempt >= maxAttempts) break;
    log(`finish 撞合并锁（第 ${attempt}/${maxAttempts} 次尝试），${Math.round(retryDelayMs / 1000)}s 后重试……`);
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  if (r.status !== 0) {
    if (lockConflict) appendEvent(qdir, 'merge_lock_wait', { attempts: maxAttempts });
    die(`feature-branch finish 失败（exit ${r.status ?? '?'}${r.timedOut ? '，超时已按进程树收割' : ''}）。任务留在 awaiting-human/，处理后重新 approve。`, r.status ?? 1);
  }
  moveCard(root, taskId, 'awaiting-human', 'merged');
  const mergeCommit = execFileSync('git', ['log', '-1', '--format=%H'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  appendEvent(qdir, 'merged', { merge_commit: mergeCommit, ...(source === 'auto' ? { auto: true } : {}) });
  log(`已合并：${mergeCommit.slice(0, 7)}（任务转 merged/${source === 'auto' ? '，自动合并' : ''}）`);
  // 配置守卫（B7）：编排器自己 finish 合并带来的 workflow.json 变更（合并卡改了授权配置、
  // 已过门禁与人审）= 合法变更——merge 动作完成后重置基线，下次派发校验按新基线放行。
  resetConfigBaseline(repoRoot);
  // 提案清退（B9，闭环内动作）：与刚合并卡 files_hint 重叠的 drafts/ 提案自动迁入
  // drafts/superseded/ 并标注合并卡 id——现场已被真实实现覆盖，提案留着会误导 planner
  // 与人工。仅标题相似的不迁（防误杀）。尽力而为，任何失败不影响合并结果。
  if (loadWorkflowConfig(repoRoot).draftsGc?.autoSupersede !== false) {
    let mergedMeta = null;
    try {
      mergedMeta = parseCard(fs.readFileSync(cardPath(root, 'merged', taskId), 'utf8'), taskId).meta;
    } catch { /* 损坏卡：清退跳过，提案留原地 */ }
    if (mergedMeta) {
      const moved = supersedeForMerged(repoRoot, { mergedId: taskId, filesHint: mergedMeta.files_hint });
      if (moved.length) {
        log(`🧹 提案清退：${moved.join(', ')} → drafts/superseded/（改动面与 ${taskId} 重叠）。`);
        try { appendFleetEvent(repoRoot, 'drafts_superseded', { task: taskId, drafts: moved }); } catch { /* 留痕失败不阻断 */ }
      }
    }
  }
  // 成功出港同样通知（此前 merged 静默——失败人人皆知、成功无声，体验反了）
  await settleNotify(repoRoot, taskId, 'merged', source === 'auto' ? '审查通过，自动出港' : '人工放行出港');
}

async function doReject(repoRoot, taskId, root, qdir, reason) {
  appendEvent(qdir, 'human_gate', { decision: 'rejected', reason });
  moveCard(root, taskId, 'awaiting-human', 'failed');
  appendEvent(qdir, 'failed', { reason: reason || '人工驳回' });
  // 人工驳回同样进调查包（VDR）：船东与验船师的分歧是最有价值的教训来源，回看与出题都要现场
  archiveIncident(repoRoot, taskId, root, qdir, reason || '人工驳回');
  log(`已驳回：任务转 failed/（worktree 保留供人工查看现场：${worktreePath(repoRoot, taskId)}）`);
}

async function doRetry(repoRoot, taskId, root, qdir, note, opts) {
  appendEvent(qdir, 'human_gate', { decision: 'retry', note });
  // 补充指令写回任务卡背景段，worker 续做时可见
  const cardP = cardPath(root, 'awaiting-human', taskId);
  const text = fs.readFileSync(cardP, 'utf8');
  fs.writeFileSync(cardP, `${text.trimEnd()}\n\n# 补充指令（人工打回）\n${note}\n`);
  moveCard(root, taskId, 'awaiting-human', 'running');
  log('已打回 running/，重新启动闭环……');
  await cmdRun(repoRoot, taskId, { ...opts, interactive: false });
}

// ---------------------------------------------------------------------------
// submit / status / resume / abandon / logs
// ---------------------------------------------------------------------------

/**
 * follow——运行中任务的直通信息通道（订阅直通）：补充指令追加进 logs/<id>/inbox.md
 * 并记 follow_up 事件。运行中的 worker 会话无法注入（claude stdin 已关闭 / zcode
 * argv 单发），送达点在会话边界（injectFollowUps：初始 spawn / fixup / 审查返工 /
 * resume）。只对 running/ 卡开放：pending 直接改卡，awaiting-human 用 retry --note
 * （写回卡正文，重启闭环时生效）。
 */
function cmdFollow(repoRoot, taskId, text) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const clean = String(text ?? '').trim();
  if (!clean) die('用法：follow <task-id> <补充指令文本>');
  const found = findCard(root, taskId);
  if (!found) die(`任务 "${taskId}" 不在队列中。`);
  if (found.state !== 'running') {
    die(`任务 "${taskId}" 状态为 ${found.state}，只有 running/ 中的任务可 follow（只有运行中的闭环有注入点）。\n`
      + `awaiting-human 的任务用 retry --note 把补充指令写回卡正文；blocked 的任务先 resume 再 follow。`);
  }
  const qdir = logDir(repoRoot, taskId);
  appendInbox(qdir, clean);
  appendEvent(qdir, 'follow_up', { chars: clean.length, preview: clean.slice(0, 120) });
  const liveLock = readTaskLock(repoRoot, taskId);
  const closureAlive = liveLock && taskLockLooksLive(liveLock);
  log(`补充指令已写入 ${taskId} 的 inbox（${clean.length} 字符），将在下次会话边界送达：fixup / 审查返工 / resume / 新 spawn。`);
  if (!closureAlive) log('⚠ 未检测到存活的闭环进程——指令会在下次 run/resume 时随恢复上下文一起送达。');
}

/** 会话边界注入 follow-up：读 inbox → prompt 尾部追加 → 留痕。无条目时零改动
 *  （不写事件、不动 prompt 字节序列——前缀缓存不受影响）。 */
function injectFollowUps(qdir, promptText) {
  const entries = readInbox(qdir);
  if (!entries.length) return promptText;
  appendEvent(qdir, 'follow_up_delivered', { count: entries.length });
  return appendFollowUps(promptText, entries);
}

function cmdSubmit(repoRoot, cardFile) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const text = safeRead(path.resolve(cardFile));
  if (!text) die(`任务卡文件不存在或为空：${cardFile}`);
  const { meta } = loadCard(text, path.basename(cardFile));
  const existing = findCard(root, meta.id);
  if (existing) die(`任务 id "${meta.id}" 已存在于 ${existing.state}/（同 id 不允许重复提交）。`);
  fs.copyFileSync(path.resolve(cardFile), cardPath(root, 'pending', meta.id));
  // 提交的是 drafts/ 提案 → 草稿同步清掉（提案态终结：队列接管，drafts 只留未处理项）。
  // 前缀比对必须走 realpath：macOS 的 tmpdir 是符号链接（/var/folders→/private/var/folders），
  // argv 侧（调用方传入）与 cwd 侧（findRepoRoot 经 process.cwd()）解析不一致会误判前缀，
  // 导致草稿清不掉（scan.test『提案提交』用例实证）。
  try {
    const cardReal = fs.realpathSync(path.resolve(cardFile));
    const draftsReal = fs.realpathSync(draftsDir(repoRoot));
    if (cardReal.startsWith(draftsReal + path.sep)) {
      try { fs.rmSync(path.resolve(cardFile), { force: true }); } catch { /* 清理失败不阻断 */ }
    }
  } catch { /* realpath 失败（路径不存在等）跳过清理 */ }
  log(`任务卡已提交：pending/${meta.id}.md（type=${meta.type} priority=${meta.priority} gate=${meta.gate}）`);
  log(`启动闭环：node .agents/scripts/orchestrator.mjs run ${meta.id}`);
}

function cmdStatus(repoRoot, taskId) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  if (!taskId) {
    log('任务队列：');
    for (const s of STATES) {
      const ids = listCards(root, s);
      if (ids.length) log(`  ${s.padEnd(15)} ${ids.join(', ')}`);
    }
    const active = ['pending', 'running', 'reviewing', 'awaiting-human', 'blocked'].flatMap((s) => listCards(root, s));
    if (!active.length) log('  （无活跃任务）');
    return;
  }
  const found = findCard(root, taskId);
  if (!found) die(`任务 "${taskId}" 不在队列中。`);
  log(`任务 ${taskId}：状态 ${found.state}（${found.path}）`);
  const inbox = readInbox(logDir(repoRoot, taskId));
  if (inbox.length) log(`待送达 follow-up：${inbox.length} 条（logs/${taskId}/inbox.md，下次会话边界送达 worker）`);
  const events = readEvents(logDir(repoRoot, taskId));
  if (events.length) log('事件时间线：');
  if (events.length) log(formatTimeline(events));
  else log('（尚无事件——还没 run 过）');
}

function cmdResume(repoRoot, taskId, opts) {
  const root = queueRoot(repoRoot);
  const found = findCard(root, taskId);
  if (!found) die(`任务 "${taskId}" 不在队列中。`);
  // reviewing 也放行（2026-10-31 卡 19）：审查中硬崩的卡直接在这里续做，
  // 归位 running 与恢复上下文注入由 cmdRun 的 reviewing 分支统一处理
  if (!['running', 'blocked', 'reviewing'].includes(found.state)) {
    die(`任务 "${taskId}" 状态为 ${found.state}，只有 running/blocked/reviewing 可 resume。`);
  }
  if (found.state === 'blocked') moveCard(root, taskId, 'blocked', 'running');
  // --auto-resume：drain 自动续通道专用标记（orchestrator.mjs autoResumePass），事件留痕区别于人工 resume
  appendEvent(logDir(repoRoot, taskId), 'resumed', { by: opts.flags?.has('--auto-resume') ? 'auto' : 'human' });
  log(`恢复任务 ${taskId}（带事件时间线与 NOTES.md 现场）……`);
  return cmdRun(repoRoot, taskId, { ...opts, interactive: false });
}

function cmdAbandon(repoRoot, taskId) {
  const root = queueRoot(repoRoot);
  const found = findCard(root, taskId);
  if (!found) die(`任务 "${taskId}" 不在队列中。`);
  // 闭环进程还活着时不许 abandon：它会杀掉在跑的 worker 并把卡落 failed/。
  // 判活按锁心跳（taskLockLooksLive）：心跳静默即视为陈锁自动放行——pid 复用的
  // 假活锁不再拦人，也不再给「终止 pid X」的误杀指引（陈锁接管与孤儿清理各自带属主校验）。
  const liveLock = readTaskLock(repoRoot, taskId);
  if (liveLock && taskLockLooksLive(liveLock)) {
    die(`任务 "${taskId}" 的闭环仍在运行（pid ${liveLock.pid}${liveLock.cmd ? `，${liveLock.cmd}` : ''}）——abandon 会终止在跑的 worker，先确认它真的卡死。\n`
      + `  持锁进程心跳停止 ${TASK_LOCK_STALE_MS / 1000}s 后陈锁自动接管（无需手动清理），届时可直接 abandon；孤儿 worker 清理自带属主校验。`);
  }
  cleanupOrphanWorker(repoRoot, taskId);
  const qdir = logDir(repoRoot, taskId);
  if (found.state !== 'failed' && found.state !== 'merged') {
    const reason = '人工 abandon（按 worktree-rescue 流程处理）';
    appendEvent(qdir, 'failed', { reason });
    // abandon 是人工兜底动作：直接落 failed/，不走常规迁移白名单
    fs.renameSync(found.path, cardPath(root, 'failed', taskId));
    archiveIncident(repoRoot, taskId, root, qdir, reason); // 兜底放弃也归档：现场值得回看与出题
  }
  log(`任务已放弃并转 failed/。worktree 与分支清理请按 .agents/workflows/worktree-rescue.md 人工执行：`);
  log(`  git -C ${repoRoot} worktree remove .agents/worktrees/${taskId}`);
  log(`  git -C ${repoRoot} branch -D feature/${taskId}`);
}

function cmdLogs(repoRoot, taskId) {
  const events = readEvents(logDir(repoRoot, taskId));
  if (!events.length) die(`任务 "${taskId}" 尚无事件日志。`);
  console.log(formatTimeline(events));
}

/** 引擎选择透传：drain/nightly/scan--run spawn 的 run/drain 子进程继承本次引擎参数
 *  （workflow.json 的默认不用传——子进程自己会读同一份配置）。 */
function engineArgs(opts) {
  const args = [];
  if (opts.workerBackend) args.push('--worker-backend', opts.workerBackend);
  if (opts.workerModel) args.push('--worker-model', opts.workerModel);
  if (opts.reviewBackend) args.push('--review-backend', opts.reviewBackend);
  if (opts.reviewModel) args.push('--review-model', opts.reviewModel);
  return args;
}

/**
 * drain——队列自动调度（Phase 2，docs 10.3）：循环把 pending/ 跑到空。
 * 父进程 pickNextCard 选好 id 后**显式传给子进程**跑 `run <id>`（子进程内再调 --next
 * 反而有窗口期竞态）：cmdRun 的熔断走 process.exit，同进程循环会整批退出；子进程
 * 隔离后单任务 blocked/failed 不阻塞后续。队列空 / 只剩损坏卡 / 达到 --max 轮数即停。
 */
/** drain 预检：worker 引擎起不来时逐卡 spawn 失败烧成 blocked（2026-10-29 夜跑 8 卡
 *  ENOENT 实证）——起跑前探测一次，不可用直接拒绝启动（给可操作修复指引，卡零消费）。 */
function preflightWorkerBackend(backend) {
  if (backend === 'zcode-headless' && !zcodeAvailable()) {
    die('预检失败：zcode CLI 不可用（ORCH_ZCODE_CLI 未设 / PATH 无 zcode / --version 探测失败）。\n'
      + 'drain 拒绝启动，避免逐卡烧成 blocked。修复（设 ORCH_ZCODE_CLI=<zcode.cjs 绝对路径> 或安装 PATH 版 zcode）后重跑。', 1);
  }
  if (backend === 'codex-headless' && !codexAvailable()) {
    die('预检失败：codex CLI 不可用（ORCH_CODEX_CLI 未设 / PATH 无 codex / --version 探测失败）。\n'
      + 'drain 拒绝启动，避免逐卡烧成 blocked。修复（设 ORCH_CODEX_CLI=<codex 绝对路径> 或安装 PATH 版 codex）后重跑。', 1);
  }
  if (backend === 'claude-headless' && !claudeAvailable()) {
    die('预检失败：claude CLI 不可用（PATH 无 claude / 未登录 / --version 探测失败）。\n'
      + 'drain 拒绝启动。修复后重跑；切换引擎须过人工闸门（--approve-backend-switch）。', 1);
  }
}

function drainTallyLine(tally) {
  return Object.entries(tally).map(([s, n]) => `${s} ${n}`).join('、') || '无';
}

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

function weatherHoldCount(repoRoot, cfg) {
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
function announceWeatherHold(repoRoot, cfg, w) {
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

/**
 * 配置守卫派发闸（B7）——drain/watch/sail 共用的「派发前校验」步进：
 * workflow.json 当前 hash ≠ 启动基线 → 宣布（log + fleet 级事件 config_drift_detected
 * 含前后 hash + webhook 通知，通知尽力而为）并返回 false（调用方暂停新派发，在途任务继续）。
 * 恢复 = 文件改回基线（hash 复合）或编排器自己 merge 后的 resetConfigBaseline；
 * 人工/外部改配置要生效须重启编排器（重启即重新记基线）。
 * configGuard.enabled=false（不推荐）→ 恒放行，行为与无守卫版本一致。
 */
function configGuardPass(repoRoot, cfg) {
  if (cfg.configGuard?.enabled === false) return true;
  const v = checkConfigDrift(repoRoot);
  if (v.ok) {
    configDriftAnnouncedKey = null; // 漂移解除（文件改回基线 / merge 后重置）：复位宣布去重
    return true;
  }
  const detail = `workflow.json 配置漂移（基线 ${String(v.drift.from).slice(0, 12)} → 当前 ${String(v.drift.to).slice(0, 12)}）`;
  // 宣布去重：并发 pump/循环轮会反复进闸——同一漂移 episode（前后 hash 相同）只宣布一次
  const key = `${v.drift.from}->${v.drift.to}`;
  if (configDriftAnnouncedKey !== key) {
    configDriftAnnouncedKey = key;
    log(`⛔ 配置守卫：${detail}——暂停新派发（在途任务继续）。恢复：文件改回基线，或核实合法后重启编排器接受新配置。`);
    try {
      appendFleetEvent(repoRoot, 'config_drift_detected', { from: v.drift.from, to: v.drift.to });
    } catch { /* 留痕失败不阻断调度 */ }
    void notify({
      title: `${displayProjectName(loadWorkflowConfig(repoRoot).projectName ?? '')} 配置守卫`,
      body: `${detail}——已暂停新派发（在途任务继续）。核实改动：合法则重启编排器接受新基线；来历不明按事故处理。`,
      webhookEnvs: orchWebhookEnvs(repoRoot),
    }).catch(() => { /* 通知失败不阻断 */ });
    void notifyActionCard({
      repoRoot,
      webhookEnvs: orchWebhookEnvs(repoRoot),
      taskId: null,
      title: `${displayProjectName(loadWorkflowConfig(repoRoot).projectName ?? '')} 配置守卫`,
      reason: `${detail}——已暂停新派发。核实后重启编排器接受新基线，或按事故处理。`,
    }).catch(() => { /* 卡片失败不阻断 */ });
  }
  return false;
}

/** 配置守卫宣布去重键（同一漂移 episode 只 announce 一次；复位见 configGuardPass）。 */
let configDriftAnnouncedKey = null;

/** drain 收官摘要通知（尽力而为）：夜里 drain 跑完手机可收「N 卡：merged x、awaiting y」
 *  + 任务花名册（按任务号列本次做了什么、目标是什么）。 */
async function drainSummaryNotify(repoRoot, done, tally, note, tasks = []) {
  if (!done) return; // 零消费不吵
  try {
    const cfg = loadWorkflowConfig(repoRoot);
    const roster = buildTaskRoster(tasks, { max: 8, infoOf: (t) => ({ goal: cardGoalLine(repoRoot, t.id) }) });
    await notify({
      title: `${displayProjectName(cfg.projectName ?? '')} drain 收官`,
      body: [`共 ${done} 卡（${drainTallyLine(tally)}）——${note}`, roster].filter(Boolean).join('\n'),
      webhookEnvs: orchWebhookEnvs(repoRoot),
    });
  } catch { /* 通知失败不阻断编排 */ }
}

/**
 * blocked 卡有限自动续跑（长跑自主的关键小件；资格判定纯逻辑在 orchestrator/autoresume.mjs）。
 * drain 选卡前调用：扫 blocked/ → 挑「transient 类失败 + 冷却已过」的卡（≤maxPerRun 张，
 * 按 blocked 时间最早先续）→ 逐张先把 auto_resumed_at 冷却标记写进卡 frontmatter
 * （自动续后再 blocked 时下轮靠它判冷却——连续自动续失败不重试）→ 记 auto_resume
 * { card, attempts } 事件 → spawn 既有 resume 子命令（闭环复用不复制逻辑；子进程隔离，
 * 熔断 process.exit 不伤 drain 主循环，与派 run 子进程同哲学，--auto-resume 让 resumed
 * 事件标记 by=auto 区别于人工）。上界三重：只续 transient 类、每卡 24h（cooldownHours）
 * 最多 1 次、每次 drain ≤2 张（maxPerRun）。drift 降级 = 全人工，整个通道暂停；
 * autoResume.enabled=false 完全不扫。
 * @returns {string[]} 本轮自动续的卡 id（drain 汇总口径）
 */
function autoResumePass(repoRoot, root, cfg, opts) {
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
  });
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
 * scan 卡自动转修复卡（B10）：drain 落位点调用——failed 的是 scan 型卡（id scan- 前缀，
 * 见 scanfix.mjs）且 scanAutoFix.enabled（缺省 true）时，自动补一张 pending 修复卡
 * （id fix-<原名>，正文引用 incident.md 与失败摘要，files_hint/门禁继承原卡）。修复卡
 * 是普通卡照走全部门禁（引水闸/L2L3 人审不绕过）；同名修复卡任一状态已存在即跳过；
 * 修复卡自身 failed 不再繁殖新卡（id 无 scan- 前缀，防循环）。尽力而为，不阻断调度。
 */
function scanAutoFixPass(repoRoot, root, scanId, cfg) {
  if (cfg?.scanAutoFix?.enabled === false) return;
  const r = scanAutoFixAfterFailure(repoRoot, root, scanId, { enabled: true });
  if (!r) return; // 非 scan 卡：静默（判定在 scanfix.mjs，id 前缀不匹配）
  if (r.created) {
    log(`🛠 scan 卡 ${scanId} 已 failed——自动生成修复卡 pending/${r.id}.md（引用 incident.md 与失败摘要；普通卡照走全部门禁）。`);
  } else {
    console.warn(`[orchestrator] scan 卡 ${scanId} 自动转修复卡未执行：${r.reason}`);
  }
}

async function cmdDrain(repoRoot, opts) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const cfg = runConfig(repoRoot);
  // 配置守卫（B7）：调度进程启动即记 workflow.json 基线（run 子进程各自记自己的，跨进程不共享）
  if (cfg.configGuard?.enabled !== false) captureConfigBaseline(repoRoot);
  // 调度器互斥：drain / nightly / scan --run 同刻只允许一个在跑（run-lock.mjs）。
  // 子进程经 childEnvForHeldLock 豁免（run 不抢锁；被 spawn 的 drain 继承父锁语义）。
  const lock = acquireSchedulerLock(repoRoot, 'drain');
  if (!lock.held) {
    log(`⏸ 调度器已在运行（pid=${lock.owner.pid}，${lock.owner.cmd ?? ''}）——本次退出，不并发调度。`);
    return;
  }
  try {
    // 有效并发 = min(请求并发, 供给闸)（A3 有闸门的扩容）：请求并发 = CLI --workers（显式
    // 单次意图，最高优先）> workflow.json scheduling.maxWorkers（缺省 1 = 现状不变）。
    // 供给闸只在请求并发 > 1 时探测（默认单 worker 路径零网络开销）：gatewayAdmin 未开
    // → 完全不设闸不触达（可移植红线）；已开则经 tier token → provider 容量（config 的
    // max_concurrency + metrics 的 keypool，见 supply.mjs），任一环节不可达/字段缺失 →
    // 容量 1——回落单 worker 现状（只是不扩容，派发照常，绝不因观测失败中断 drain）。
    const requested = Number.isInteger(opts.workers) && opts.workers > 1 ? opts.workers : (cfg.scheduling?.maxWorkers ?? 1);
    let workers = requested;
    if (requested > 1) {
      const supply = await drainSupplyProbe(repoRoot, root, cfg);
      workers = Math.min(requested, supply.capacity);
      if (workers < requested) {
        appendFleetEvent(repoRoot, 'workers_scaled', { from: requested, to: workers, ...(supply.provider ? { provider: supply.provider } : {}), reason: supply.reason });
        log(`⚠ 供给闸：请求并发 ${requested}，provider 容量 ${supply.capacity === Infinity ? '∞（观测缺席）' : supply.capacity}（${supply.reason}）——按 ${workers} 并发执行`);
      } else if (!opts.workers) {
        // 配置驱动的自动扩容（无显式 --workers）：留痕解锁链（网关 max_concurrency/key 池
        // 解锁 → workflow.json scheduling.maxWorkers → drain 自动生效），永不静默红线
        appendFleetEvent(repoRoot, 'workers_scaled', { from: 1, to: workers, ...(supply.provider ? { provider: supply.provider } : {}), reason: supply.reason });
        log(`⛵ 供给闸：provider 容量 ${workers}（${supply.reason}）——按 scheduling.maxWorkers=${requested} 并发执行`);
      }
    }
    preflightWorkerBackend(opts.backend ?? cfg.worker?.backend); // mock/未配置引擎跳过（探测函数只认真实 CLI）
    // 选卡前先过一遍 blocked 自动续通道（串行/并发路径共用；引擎预检通过才续，防止坏引擎把卡反复烧）
    autoResumePass(repoRoot, root, cfg, opts);
    if (workers > 1) return await cmdDrainParallel(repoRoot, root, opts, workers, cfg);
    const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : Infinity;
    let done = 0;
    const tryCount = new Map(); // id -> 被选中次数（死循环防护：对齐并行路径的每任务重试计数）
    const tally = {};
    const tasks = []; // 本轮落位花名册（收官摘要按任务号列「做了哪些任务」）
    // 引水闸跳过清单：受限航道卡（deps/核心·发布路径）不派发，留在 pending/ 等人工
    // 逐张确认——drain 不因引水卡 die，也不烧它的预算（skipIds 让 pickNextCard 绕开重选）。
    const skipIds = new Set();
    const awaitingPilotage = [];
    for (;;) {
      if (done >= max) {
        log(`已达 --max ${max} 轮上限，停止调度（队列中可能还有任务）。本轮落位：${drainTallyLine(tally)}。`);
        await drainSummaryNotify(repoRoot, done, tally, `已达 --max ${max} 轮上限`, tasks);
        return;
      }
      // 风暴闸：每次派发前现算（无状态）——命中即停，下一次 drain 窗口滑过自动恢复
      if (cfg.weatherHold) {
        const w = weatherHoldCount(repoRoot, cfg);
        if (w.held) {
          announceWeatherHold(repoRoot, cfg, w);
          await drainSummaryNotify(repoRoot, done, tally, '风暴滞留（weather hold），暂停派发', tasks);
          return;
        }
      }
      // 配置守卫（B7）：派发前校验——workflow.json 漂移即停止本轮派发（在途 run 子进程
      // 天然继续）；文件改回基线后下一轮 drain 自动恢复。
      if (!configGuardPass(repoRoot, cfg)) {
        await drainSummaryNotify(repoRoot, done, tally, '配置守卫：workflow.json 漂移，暂停派发', tasks);
        return;
      }

      const next = pickNextCard(root, { skipIds });
      if (!next) {
        // 引水卡也在 pending/：从「解析失败」清单里排除（它们不是坏卡，是待确认）
        const stuck = listCards(root, 'pending').filter((id) => !skipIds.has(id));
        if (awaitingPilotage.length) {
          log(`⏸ 待引水清单：${awaitingPilotage.length} 张卡属受限航道，开航前需人工引水确认（队列保留不动）：`);
          for (const id of awaitingPilotage) log(`  node .agents/scripts/orchestrator.mjs run ${id} --pilot-approved`);
        }
        if (stuck.length) log(`无可调度任务；pending/ 中还有解析失败的卡：${stuck.join(', ')}（请修复 frontmatter 或 abandon）。`);
        else if (!awaitingPilotage.length) log(`队列已清空：本次 drain 共跑完 ${done} 个任务（${drainTallyLine(tally)}）。`);
        await drainSummaryNotify(repoRoot, done, tally, stuck.length ? '有解析失败的卡待人工修' : awaitingPilotage.length ? '有待引水确认的卡' : '队列已清空', tasks);
        return;
      }
      // 引水闸：核心路径/deps 卡未经人工确认不派发——记入清单继续下一张（不改队列）
      if (pilotageRequired(next.meta, cfg)) {
        skipIds.add(next.id);
        if (!awaitingPilotage.includes(next.id)) awaitingPilotage.push(next.id);
        log(`⏸ 任务 ${next.id} 属受限航道（${pilotageReason(next.meta, cfg)}）——待引水确认，本轮跳过。`);
        continue;
      }
      // 死循环防护（每任务计数，对齐并行路径的拉黑语义）：run 子进程正常时任务必离开
      // pending（merged/awaiting-human/blocked/failed）。同一任务第二次被选中且仍在 pending
      // = 子进程确定性失败（ui_check 未配、引擎切换未批准、脚本损坏等）——转 blocked/ 附原因
      // 后继续调度剩余卡。旧实现 die 整批：一张配错 ui_check 的卡让当晚 drain/nightly 整批
      // 中断，剩余合法 pending 全部不跑，且 die 文案（「检查 scripts 是否完整」）误导排查方向。
      tryCount.set(next.id, (tryCount.get(next.id) ?? 0) + 1);
      if (tryCount.get(next.id) >= 2) {
        const reason = 'drain 连续 2 轮选中仍在 pending——run 子进程未能处理它（常见：卡声明 ui_check 但 workflow.json 未配 uiCheckCmd、执行引擎切换未获批准；可用 resume 带上修复指令续做）';
        log(`⛔ 任务 ${next.id} 拉黑：${reason.split('——')[0]}——转 blocked/，继续调度剩余卡。`);
        appendEvent(logDir(repoRoot, next.id), 'failed', { reason });
        moveCard(root, next.id, 'pending', 'blocked');
        tally.blocked = (tally.blocked ?? 0) + 1;
        tasks.push({ id: next.id, state: 'blocked' });
        await settleNotify(repoRoot, next.id, 'blocked', reason);
        continue;
      }
      log(`\n═══ drain [${done + 1}] → ${next.id}（priority=${next.meta.priority}）═══`);
      // 父进程选好 id 显式传给子进程（确定性）；子进程内再调 --next 反而有窗口期竞态
      const r = spawnSync('node', [path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs'), 'run', next.id, ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { ...process.env, ...childEnvForHeldLock() },
      });
      done += 1;
      // spawn 失败（ENOENT 等）容错——与并行路径（cmdDrainParallel 挂 error 处理）同款。
      // 引擎预检只探 worker CLI，防不住「预检过后 run 子进程的 node 本身起不来」的窄窗口：
      // spawnSync 失败时 status 为 null、卡留在 pending，按「退出码」走会误报已落
      // blocked/failed/，下轮再选中同一卡 → 死循环防护 die 整批中断（2026-10-29 夜跑
      // 8 卡烧毁事故的串行路径残留面，2026-11-01 Windows 本机实证）。这里识别 r.error：
      // 卡显式转 blocked/ 附原因（可 resume，不悬 pending、不 die 空转），继续调度。
      if (r.error) {
        const note = String(r.error.code ?? r.error.message ?? r.error);
        const reason = `run 子进程启动失败：${note}`;
        log(`任务 ${next.id} 的 run 子进程启动失败（${note}）——卡转 blocked 待人工 resume，继续调度。`);
        const cur = findCard(root, next.id);
        if (cur?.state === 'pending') {
          appendEvent(logDir(repoRoot, next.id), 'failed', { reason });
          moveCard(root, next.id, 'pending', 'blocked');
          tally.blocked = (tally.blocked ?? 0) + 1;
          tasks.push({ id: next.id, state: 'blocked' });
          await settleNotify(repoRoot, next.id, 'blocked', reason);
        }
        continue;
      }
      if (r.status !== 0) log(`任务 ${next.id} 退出码 ${r.status}（已落 blocked/failed/，继续调度下一个）。`);
      const settled = findCard(root, next.id)?.state;
      if (settled) {
        tally[settled] = (tally[settled] ?? 0) + 1;
        tasks.push({ id: next.id, state: settled });
        if (settled === 'failed') scanAutoFixPass(repoRoot, root, next.id, cfg); // scan 卡断链自愈（B10）
      }
    }
  } finally {
    releaseSchedulerLock(repoRoot);
  }
}

/**
 * drain 供给闸探测（A3，supply.mjs）：扫 pending 卡取第一张带有效 tier token 的卡，以其
 * tier token 作为 worker 流量的代表路由做容量观测（同 tier 的卡共享同一 provider 容量池；
 * 全部卡无 tier token → probe 内按「字段缺失」回落单 worker，fail-open 口径见 supply.mjs）。
 * 解析失败卡跳过（由调度循环另行处理）；每 drain 只探一次，不随 pump 重复触达网关。
 */
async function drainSupplyProbe(repoRoot, root, cfg) {
  let token = null;
  let tierName = null;
  for (const id of listCards(root, 'pending')) {
    try {
      const card = loadCard(fs.readFileSync(cardPath(root, 'pending', id), 'utf8'), `${id}.md`);
      const t = resolveTier(card.meta, cfg);
      if (t?.token) {
        token = t.token;
        tierName = t.name;
        break;
      }
    } catch { /* 解析失败卡由调度循环处理 */ }
  }
  return probeProviderCapacity({ token, tier: tierName, optIn: cfg.gatewayAdmin === true });
}

/**
 * 并发调度（Phase 3，docs 10.6）：--workers N 时最多 N 个 run 子进程同时跑。
 * 分区互斥：新任务与任一在跑任务的 files_hint 相交（hintsOverlap）则跳过，
 * 等占位释放后再试——按文件归属分区派任务的自动化（AGENTS.md 已有人工约定）。
 * 死循环防护改为**每任务重试计数**：同一任务被调度 2 次仍留在 pending 即拉黑转 blocked/
 * 并告警（并发下"连续两轮"不再等价于上一次尝试；落位语义与串行路径同款——failed 事件 +
 * moveCard + tally/tasks 记账 + settleNotify）。
 * 结束条件：无活跃子进程 且 无可调度任务。
 */
function cmdDrainParallel(repoRoot, root, opts, workers, cfg) {
  const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : Infinity;
  const active = new Map(); // pid -> { id, hint }
  const retryCount = new Map(); // id -> 调度次数
  const blacklisted = new Set();
  // 引水闸跳过清单（与串行 drain 同语义）：受限航道卡跳过不派发，留 pending/ 等人工确认
  const pilotageSkip = new Set();
  const awaitingPilotage = [];
  const pilotCfg = loadWorkflowConfig(repoRoot);
  const tally = {};
  const tasks = []; // 本轮落位花名册（收官摘要按任务号列「做了哪些任务」）
  let launched = 0;
  let finished = 0;
  let warnedStuck = false;
  let summarySent = false;
  let pilotageListed = false; // 待引水清单只打一次（pump 每轮收尾都会重入，防刷屏）
  let weatherAnnounced = false; // 滞留宣布只一次（pump 会被 exit 回调反复进入）

  const launch = (card) => {
    retryCount.set(card.id, (retryCount.get(card.id) ?? 0) + 1);
    log(`\n═══ drain [${launched + 1}/${workers} 并发] → ${card.id}（priority=${card.meta.priority}，active=${active.size + 1}）═══`);
    const child = spawn('node', [path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs'), 'run', card.id, ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, ...childEnvForHeldLock() },
    });
    launched += 1;
    active.set(child.pid, { id: card.id, hint: card.meta.files_hint });
    // settled 防双触发：spawn 'error'（ENOENT 等）时 exit 永不触发，不挂 error 处理则
    // active 条目永不清除 → pump 停摆、drain 挂起不退出（agents-hygiene-batch）
    let settled = false;
    const onDone = (code, errNote) => {
      if (settled) return;
      settled = true;
      active.delete(child.pid);
      finished += 1;
      if (errNote) log(`任务 ${card.id} 的 run 子进程启动失败（${errNote}）——继续调度。`);
      else if (code !== 0) log(`任务 ${card.id} 退出码 ${code}（已落 blocked/failed/或等待人工，继续调度）。`);
      const state = findCard(root, card.id)?.state;
      if (state) {
        tally[state] = (tally[state] ?? 0) + 1;
        tasks.push({ id: card.id, state });
        if (state === 'failed') scanAutoFixPass(repoRoot, root, card.id, pilotCfg); // scan 卡断链自愈（B10）
      }
      // 终局摘要（尽力而为）：全部发射的子进程已收尾且无后续可调度（或已达 --max 上限）。
      // 引水跳过卡与拉黑卡同等对待：不算「可调度」，否则摘要把它们误报成未跑任务。
      const noMore = launched >= max || !listCards(root, 'pending').some((id) => !blacklisted.has(id) && !pilotageSkip.has(id));
      if (!summarySent && active.size === 0 && finished === launched && noMore) {
        summarySent = true;
        void drainSummaryNotify(repoRoot, finished, tally, launched >= max ? `已达 --max ${max} 轮上限` : awaitingPilotage.length ? '有待引水确认的卡' : '队列已清空', tasks);
      }
      pump();
    };
    child.on('exit', (code) => onDone(code));
    child.on('error', (e) => onDone(undefined, e.message));
  };

  const pump = () => {
    // 从 pending 找一个与所有在跑任务分区不相交的卡
    for (;;) {
      if (active.size >= workers) return;
      // --max 是烧钱上限：内层循环每次发射前必须同查（串行路径逐次发射前都查 done >= max，
      // 并发路径漏了同款）——只查 pump 入口挡不住首轮 workers > max 的连发（launch 是同步
      // 循环，child exit 异步事件插不进来）。有活跃子进程时先返回，等 exit 回调收尾再打日志。
      if (launched >= max) {
        if (active.size === 0) log(`已达 --max ${max} 轮上限，停止调度。`);
        return;
      }
      // 风暴闸：发射前现算（无状态）——滞留期间不再发射，等 exit 回调收尾在跑任务
      if (cfg?.weatherHold) {
        const w = weatherHoldCount(repoRoot, cfg);
        if (w.held) {
          if (!weatherAnnounced) {
            weatherAnnounced = true;
            announceWeatherHold(repoRoot, cfg, w);
          }
          if (active.size === 0) {
            log('风暴滞留（weather hold）：无在跑任务，本次 drain 结束。');
            if (!summarySent && finished > 0) {
              summarySent = true;
              void drainSummaryNotify(repoRoot, finished, tally, '风暴滞留（weather hold），暂停派发');
            }
          }
          return;
        }
      }
      // 配置守卫（B7）：发射前校验——漂移即停止调度新任务（在途子进程照常收尾，exit
      // 回调里的收官摘要照发）；同一漂移 episode 只宣布一次（configGuardPass 内去重）。
      if (!configGuardPass(repoRoot, cfg)) {
        if (active.size === 0) log('配置守卫：workflow.json 漂移，无在跑任务，本次 drain 结束。');
        return;
      }
      const candidates = listCards(root, 'pending').filter((id) => !blacklisted.has(id) && !pilotageSkip.has(id));
      let picked = null;
      for (const id of candidates) {
        if ((retryCount.get(id) ?? 0) >= 2) {
          // 拉黑对齐串行 drain 完整语义（2026-11-05 审查项）：旧实现只 blacklisted.add——
          // 卡悬在 pending/、无 failed 事件、无通报、tally/tasks 不记账，与串行路径
          // （appendEvent failed + moveCard blocked + 记账 + settleNotify）分叉。这里补齐：
          // 卡显式转 blocked/（可 resume，不悬 pending），reason 与串行同款可操作口径。
          const reason = 'drain 两次调度仍在 pending——run 子进程未能处理它（常见：卡声明 ui_check 但 workflow.json 未配 uiCheckCmd、执行引擎切换未获批准；可用 resume 带上修复指令续做）';
          log(`⛔ 任务 ${id} 拉黑：${reason.split('——')[0]}——转 blocked/，继续调度剩余卡。`);
          appendEvent(logDir(repoRoot, id), 'failed', { reason });
          moveCard(root, id, 'pending', 'blocked');
          blacklisted.add(id); // 搬离 pending 后本不会再入选，双保险防 moveCard 异常时旧选路复现
          tally.blocked = (tally.blocked ?? 0) + 1;
          tasks.push({ id, state: 'blocked' });
          void settleNotify(repoRoot, id, 'blocked', reason); // 尽力而为通报（与收官摘要同款 fire-and-forget）
          continue;
        }
        try {
          const card = loadCard(fs.readFileSync(cardPath(root, 'pending', id), 'utf8'), `${id}.md`);
          // 引水闸：受限航道卡不派发（记清单跳过，drain 不因引水卡中断）
          if (pilotageRequired(card.meta, pilotCfg)) {
            pilotageSkip.add(id);
            if (!awaitingPilotage.includes(id)) awaitingPilotage.push(id);
            log(`⏸ 任务 ${id} 属受限航道（${pilotageReason(card.meta, pilotCfg)}）——待引水确认，不派发。`);
            continue;
          }
          const conflicts = [...active.values()].some((a) => hintsOverlap(a.hint, card.meta.files_hint));
          if (!conflicts) {
            // loadCard 返回 {meta, body}，id 在 meta 里——调度内部统一为 {id, meta} 形状
            picked = { id: card.meta.id, meta: card.meta };
            break;
          }
        } catch {
          continue; // 解析失败卡：人工修（status 可见）
        }
      }
      if (!picked) {
        if (active.size === 0) {
          const stuck = listCards(root, 'pending').filter((id) => !blacklisted.has(id) && !pilotageSkip.has(id));
          if (awaitingPilotage.length && !pilotageListed) {
            pilotageListed = true;
            log(`⏸ 待引水清单：${awaitingPilotage.length} 张卡属受限航道，开航前需人工引水确认（队列保留不动）：`);
            for (const id of awaitingPilotage) log(`  node .agents/scripts/orchestrator.mjs run ${id} --pilot-approved`);
          }
          if (stuck.length && !warnedStuck) {
            warnedStuck = true;
            log(`无可并行调度的任务（其余卡与在跑任务分区冲突、已拉黑或解析失败）。本次 drain 结束：完成 ${finished} 个。`);
          } else if (!stuck.length && !awaitingPilotage.length) {
            log(`队列已清空：本次 drain 共跑完 ${finished} 个任务（并发 ${workers}）。`);
          }
          if (active.size === 0) return;
        }
        return; // 有 active 在跑，等 exit 回调再 pump
      }
      launch(picked);
    }
  };

  pump();
}

/**
 * drift——质量漂移监控（Phase 3，docs 10.5）：统计自动合并的回溯失败率（revert 信号），
 * 超阈值（20%）自动降级全人工；--clear 人工恢复。
 */
function cmdDrift(repoRoot, opts) {
  const flags = opts.flags ?? new Set();
  if (flags.has('--clear')) {
    const was = readDegraded(repoRoot);
    if (clearDegraded(repoRoot)) {
      log(was ? `已恢复自动合并（降级原因曾是：${was.reason}）。请确认漂移根因已消除。` : '当前未处于降级状态。');
    }
    return;
  }
  printDriftReport(repoRoot);
}

function printDriftReport(repoRoot) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const { autoTotal, autoReverted, humanTotal, rate, threshold, degraded } = evaluateDrift(repoRoot, root);
  log(`════════ 质量漂移报告 ════════`);
  log(`自动合并: ${autoTotal}（其中被 revert: ${autoReverted}）    人工合并: ${humanTotal}`);
  log(`自动合并回溯失败率: ${(rate * 100).toFixed(0)}%（阈值 ${threshold * 100}%，workflow.json driftThreshold 可调）`);
  if (degraded) {
    log(`⚠ 当前处于降级状态：自动合并已全部回人工（${degraded.reason}）`);
    log(`  恢复方式：人工确认漂移根因消除后 node .agents/scripts/orchestrator.mjs drift --clear`);
  } else if (autoTotal === 0) {
    log('尚无自动合并样本——漂移率不适用。');
  } else {
    log('状态正常：自动合并按 gate 声明继续生效。');
  }
}

/**
 * reconcile——狗粮对账（Phase 2 展望项落地，docs 10.7）：worker 自报账（events
 * budget_snapshot）vs 网关实测账（转发日志 usage 字段）。worker 流量走本机网关时
 * 两本账应贴近；分歧大 = 上游漏报/网关漏解析/直连绕过网关。只读报告，不做任何动作。
 * 成本账（cost.mjs）：实测 token × 模型单价 = USD（价目走网关 admin 面，gatewayAdmin
 * 未开启或网关不可达时只出 token 账，不打断对账主体）。
 * 状态对账（reconcileCardStates）：卡状态 vs git 现实——「已合并未落位」默认只读列出，
 * --fix-states 落位 merged/（状态机被人工旁路的修复）。两节独立，用量对账未启用也照跑。
 */
async function cmdReconcile(repoRoot, taskId, opts = {}) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const flags = opts.flags ?? new Set();
  const cfg = loadWorkflowConfig(repoRoot);
  const fmtK = (n) => `${Math.round(n / 100) / 10}k`;
  // 用量对账未启用（workflow.json gatewayLogDir 未配置且无 env 重定向）→ 显式说明，不落到
  // 「尚无已合并任务可对账」的误导输出（任务明明有，是对账没开）
  if (!gatewayLogsDir(cfg)) {
    log('未启用网关对账：.agents/workflow.json 未配置 gatewayLogDir（网关请求日志目录，支持 ~/ 展开）。配置后重新运行本命令。');
  } else if (taskId) {
    const found = findCard(root, taskId);
    if (!found) die(`任务 "${taskId}" 不在队列中。`);
    const r = await reconcileTask(repoRoot, taskId, root);
    await attachCost(repoRoot, cfg, [r]);
    log(`任务 ${taskId} 对账（时间窗内经网关转发的成功请求）：`);
    show(r);
  } else {
    const all = await reconcileAll(repoRoot, root);
    if (!all.length) {
      log('尚无已合并任务可对账。');
    } else {
      await attachCost(repoRoot, cfg, all); // 一张价目表服务全部任务（并集查一次）
      log(`已合并任务对账（${all.length} 个，按分歧降序；分母取两账中较大者）：`);
      for (const r of all) show(r);
    }
  }
  // ---- 状态对账（排在用量对账之后）：卡状态 vs git 现实 ----
  let sr;
  try {
    sr = reconcileCardStates(repoRoot, root, { fix: flags.has('--fix-states') });
  } catch (e) {
    log(`⚠ 状态对账跳过：${e?.message ?? e}`);
    return;
  }
  if (sr.mergedNotSettled.length) {
    log(`状态对账 · 已合并未落位（分支已 git 合并但卡不在 merged/，共 ${sr.mergedNotSettled.length} 张）：`);
    for (const c of sr.mergedNotSettled) log(`  ${c.id.padEnd(24)} 当前状态 ${c.state}`);
    if (flags.has('--fix-states')) {
      for (const id of sr.fixed) log(`  已落位：${id}（→ merged/，事件 state_reconciled）`);
    } else {
      log('  修复：node .agents/scripts/orchestrator.mjs reconcile --fix-states');
    }
  } else {
    log('状态对账 · 已合并未落位：无');
  }
  if (sr.settledNotMerged.length) {
    log(`⚠ 状态对账 · 账面合并但 git 无实证（可能是 squash 合并或改史，共 ${sr.settledNotMerged.length} 张）：`);
    for (const c of sr.settledNotMerged) log(`  ${c.id}`);
  } else {
    log('状态对账 · 账面合并但 git 无实证：无');
  }

  function show(r) {
    if (r.skipped) return log(`  ${r.reason}`);
    let costPart = '';
    if (r.cost) {
      costPart = `  燃油 ${fmtUsd(r.cost.usd)}（${r.cost.source === 'cache' ? '陈价目' : '实测价目'}）`;
      if (r.cost.unpriced?.length) costPart += `（${r.cost.unpriced.length} 模型未匹配单价按 $0 计：${r.cost.unpriced.slice(0, 3).join(', ')}${r.cost.unpriced.length > 3 ? '…' : ''}）`;
    } else if (r.costReason) {
      costPart = `  燃油账不可用（${r.costReason}）`;
    }
    // 分歧率口径（2026-11 usage-cache-read-scope）：两本账都有可计费字段按 billable 对
    // billable（与 max_tokens 熔断同口径）；缺新字段回落旧口径并标注。燃油账始终总口径（美元）。
    const billable = r.scope === 'billable';
    const selfPart = billable
      ? `自报 ${fmtK(r.selfBillable)}（可计费；总 ${fmtK(r.selfTotal)}，in ${fmtK(r.selfReported.tokensIn)} / out ${fmtK(r.selfReported.tokensOut)}）`
      : `自报 ${fmtK(r.selfTotal)}（in ${fmtK(r.selfReported.tokensIn)} / out ${fmtK(r.selfReported.tokensOut)}）`;
    const gwPart = billable
      ? `网关实测 ${fmtK(r.gatewayBillable)}（可计费；总 ${fmtK(r.gateway.total)}，${r.gateway.requests} 次转发，缓存读 ${fmtK(r.gateway.cacheRead)}）`
      : `网关实测 ${fmtK(r.gateway.total)}（${r.gateway.requests} 次转发，缓存读 ${fmtK(r.gateway.cacheRead)}）`;
    const scopeTag = billable ? '' : '  旧口径（事件/日志缺可计费字段，缓存读计入）';
    log(
      `  ${r.taskId.padEnd(24)} ${selfPart}` +
        `  ${gwPart}` +
        `  分歧 ${(r.divergence * 100).toFixed(0)}%${r.viaGateway ? '' : '  ⚠ 网关零流量——worker 未走狗粮'}${scopeTag}${costPart}`
    );
  }
}

/**
 * stats——编排运行度量：从每卡 events.jsonl 聚合每卡与全局运行画像（wall / turns /
 * 调试与审查迭代 / token / watchdog / follow-up），为预算校准与流程调优提供基线。
 * 只读报告。token 口径 = budget_snapshot 的会话累计峰值（与 Budget.tokens 同源）；
 * 跨引擎精确对账走 reconcile（网关实测账）。--json 输出机器可读全量。
 * --cost 加燃油账（网关实测 token × 价目 → USD；走 measureFuelBatch，一次日志扫描 +
 * 一次价目请求服务全部任务；价目不可得时列原因不阻断主报告）。
 */
async function cmdStats(repoRoot, opts = {}) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const days = Number.isInteger(opts.days) && opts.days > 0 ? opts.days : 7;
  // 行收集与基础 summary 聚合抽至 orchestrator/stats.mjs（propose 舰队反馈共用同一数据层）；
  // 输出形态与历史逐字节一致——rows/summary 口径原样保留，--cost 附加字段仍在此追加。
  const { rows, windowsById, summary } = collectStatsSummary(repoRoot, { days });

  // 燃油账（--cost）：网关实测 token × 价目。放在 summary 前——summary.total_cost_usd 一并出。
  let fuelReason = null;
  if (opts.flags?.has('--cost') && windowsById.size) {
    const cfg = loadWorkflowConfig(repoRoot);
    const windows = [...windowsById.entries()].map(([key, w]) => ({ key, start: w.start, end: w.end }));
    const batch = await measureFuelBatch(repoRoot, cfg, windows);
    fuelReason = batch.reason ?? null;
    for (const [id, r] of batch.results) {
      const row = rows.find((x) => x.id === id);
      if (!row) continue;
      if (r.measured) {
        row.cost_usd = r.usd;
        if (r.unpriced?.length) row.cost_unpriced = r.unpriced;
      } else if (r.reason) {
        row.cost_unavailable = r.reason;
      }
    }
  }

  const costRows = rows.filter((r) => r.cost_usd != null);
  if (opts.flags?.has('--cost')) {
    summary.total_cost_usd = costRows.length ? costRows.reduce((n, r) => n + r.cost_usd, 0) : 0;
    if (fuelReason) summary.cost_reason = fuelReason;
  }

  if (opts.flags?.has('--json')) {
    console.log(JSON.stringify({ generated_at: toIsoLocal(), summary, rows }, null, 2));
    return;
  }
  if (!rows.length) {
    log(`最近 ${days} 天没有任务启动（按 task_accepted 时间过滤；全量对账跑 reconcile，--days N 调窗口）。`);
    return;
  }
  const fmtK = (n) => `${Math.round(n / 100) / 10}k`;
  log(`编排运行度量（最近 ${days} 天启动的 ${rows.length} 个任务；token=会话峰值口径，精确对账跑 reconcile）：`);
  const withCost = opts.flags?.has('--cost');
  for (const r of rows) {
    let costPart = '';
    if (withCost) {
      if (r.cost_usd != null) {
        costPart = ` 燃油=${fmtUsd(r.cost_usd)}`;
        if (r.cost_unpriced?.length) costPart += `（${r.cost_unpriced.length} 模型未配价）`;
      } else if (r.cost_unavailable) {
        costPart = ` 燃油=-`;
      }
    }
    log(
      `  ${r.id.padEnd(26)} ${r.state.padEnd(15)} wall=${r.wall_min ?? '-'}m turns=${r.turns} 调试=${r.debug_iter} 审查=${r.review_iter} ` +
        `重试=${r.retries} wd=${r.watchdog_suspect} follow=${r.follow_ups} tokens=${fmtK(r.tokens_peak)}${costPart}`
    );
  }
  log('汇总：');
  log(
    `  终态 ${summary.settled}（merged ${summary.merged} / failed+blocked ${summary.settled - summary.merged}），合并率 ` +
      `${summary.merge_rate === null ? '-' : Math.round(summary.merge_rate * 100) + '%'}；队列现况 pending ${summary.queue.pending} / running ${summary.queue.running}` +
      ` / awaiting-human ${summary.queue['awaiting-human']} / blocked ${summary.queue.blocked}`
  );
  if (summary.avg_merged_wall_min !== null) log(`  merged 平均 wall ${summary.avg_merged_wall_min} 分钟`);
  log(
    `  累计 turns ${summary.total_turns}，调试 ${summary.total_debug_iter} / 审查 ${summary.total_review_iter} 轮，瞬时重试 ${summary.total_retries}，` +
      `watchdog suspect ${summary.total_watchdog_suspect}，follow-up ${summary.total_follow_ups}，token 峰值合计 ${fmtK(summary.total_tokens_peak)}`
  );
  const nm = summary.near_miss;
  log(`  安全晴雨表：近乎事故 ${nm.watchdog + nm.retries + nm.xte + nm.incidents} 次（watchdog ${nm.watchdog} / 重试 ${nm.retries} / 偏航 ${nm.xte} / 调查包 ${nm.incidents}）`);
  if (withCost) {
    if (summary.total_cost_usd != null) {
      log(`  燃油合计：${fmtUsd(summary.total_cost_usd)}（${costRows.length}/${rows.length} 任务可测；单价=网关价目，USD）${summary.cost_reason ? `——${summary.cost_reason}` : ''}`);
    } else {
      log('  燃油合计：-（无任务有可用时间窗或价目不可得）');
    }
  }
}

// ---------------------------------------------------------------------------
// 提案（drafts/）与 autopilot 自动提交
// ---------------------------------------------------------------------------

function draftsDir(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'drafts');
}

/** 提案卡 frontmatter 文本级归一：created_by / gate 覆写、proposal: true 补齐
 *  （保留 planner/scanner 正文全部段落——与 intent 的文本覆写同款手法）。 */
function normalizeProposalText(text, { createdBy, gate } = {}) {
  let out = String(text ?? '');
  if (createdBy) out = out.replace(/^created_by:.*$/m, `created_by: ${createdBy}`);
  if (gate) out = out.replace(/^gate:.*$/m, `gate: ${gate}`);
  if (!/^proposal:\s*true$/m.test(out)) out = out.replace(/^gate:.*$/m, (g) => `${g}\nproposal: true`);
  return out;
}

/**
 * 把 drafts/<id>.md 提交进 pending/（人工 submit 的单卡路径，autopilot 批量提交也走这里）。
 * 去重：队列任一状态已有同 id → 视为已处理，清掉草稿；校验失败 → 留在 drafts 等人工修。
 * opts.gate：autopilot 提交时覆写 L1（预授权，实际合并仍由改动分级裁决）。
 */
function submitDraft(repoRoot, root, id, { gate } = {}) {
  const p = path.join(draftsDir(repoRoot), `${id}.md`);
  const text = safeRead(p);
  if (!text) return { skipped: `提案文件不存在：${id}` };
  const existing = findCard(root, id);
  if (existing) {
    try { fs.rmSync(p, { force: true }); } catch { /* 清理失败不阻断 */ }
    return { skipped: `${id} 已在队列（${existing.state}/），草稿已清` };
  }
  try {
    const finalText = normalizeProposalText(text, { gate });
    const { meta } = loadCard(finalText, `${id}.md`);
    fs.writeFileSync(cardPath(root, 'pending', meta.id), finalText);
    fs.rmSync(p, { force: true });
    return { submitted: meta.id, gate: meta.gate };
  } catch (e) {
    return { skipped: `${id} 校验未过（${String(e.message).slice(0, 120)}），留在 drafts 等人工修` };
  }
}

/** autopilot 批量自动提交：扫 drafts/ 全部提案，白名单卡提交进 pending（gate→L1）。
 *  返回提交 id 列表。cfg.autopilot.enabled=false 时零动作（含不读目录）。 */
function autoSubmitProposals(repoRoot, root) {
  const cfg = loadWorkflowConfig(repoRoot);
  if (!cfg.autopilot?.enabled) return [];
  const submitted = [];
  let files = [];
  try {
    files = fs.readdirSync(draftsDir(repoRoot)).filter((f) => f.endsWith('.md'));
  } catch { /* drafts/ 不存在 */ }
  for (const f of files) {
    const id = f.replace(/\.md$/, '');
    const text = safeRead(path.join(draftsDir(repoRoot), f));
    if (!text) continue;
    let meta;
    try {
      meta = parseCard(text, f).meta;
    } catch { continue; } // 损坏提案不碰，等人工修
    const verdict = canAutoSubmit(meta, cfg);
    if (!verdict.ok) {
      log(`⏸ 提案 ${id} 不自动提交：${verdict.reason}`);
      continue;
    }
    const r = submitDraft(repoRoot, root, id, { gate: AUTO_SUBMIT_GATE });
    if (r.submitted) {
      submitted.push(r.submitted);
      log(`🤖 autopilot 已提交提案：pending/${r.submitted}.md（gate=${r.gate}，白名单类型 ${meta.type}；实际合并仍由门禁分级裁决）`);
    } else if (r.skipped) {
      log(`⏸ 提案 ${id} 未提交：${r.skipped}`);
    }
  }
  return submitted;
}

/** drafts/ 里 high 优先级提案的 id 列表（scan --run / nightly --auto 的候选）。 */
function highPriorityDraftIds(repoRoot) {
  let files = [];
  try {
    files = fs.readdirSync(draftsDir(repoRoot)).filter((f) => f.endsWith('.md'));
  } catch { /* drafts/ 不存在 */ }
  const high = [];
  for (const f of files) {
    const text = safeRead(path.join(draftsDir(repoRoot), f));
    if (text && /priority:\s*high/.test(text)) high.push(f.replace(/\.md$/, ''));
  }
  return high;
}

/**
 * drafts gc——提案生命周期清退（B9）：扫 drafts/ 顶层提案，产出两份迁移清单——
 *   superseded：files_hint 与 merged/ 卡重叠（真实实现已覆盖提案现场）；
 *   aged：超 draftsGc.archiveDays（缺省 30 天，created_at 优先、mtime 兜底）。
 * 缺省 dry-run 只列清单；--apply 才迁移（superseded/ 带标注、archived/ 原文）。
 * 永不删除文件；仅标题相似（goal Jaccard ≥ 0.6）的不迁，只在报告中提示（防误杀）。
 */
function cmdDraftsGc(repoRoot, opts) {
  const cfg = loadWorkflowConfig(repoRoot);
  const apply = opts.flags?.has('--apply') ?? false;
  const archiveDays = cfg.draftsGc?.archiveDays ?? DEFAULT_ARCHIVE_DAYS;
  const { drafts, unreadable } = listDrafts(repoRoot);
  // merged/ 卡摘要（清退对照面）：损坏卡跳过
  const root = queueRoot(repoRoot);
  const mergedCards = [];
  for (const id of listCards(root, 'merged')) {
    try {
      const { meta, body } = parseCard(fs.readFileSync(cardPath(root, 'merged', id), 'utf8'), `${id}.md`);
      mergedCards.push({ id, filesHint: meta.files_hint ?? [], goal: body.goal ?? '' });
    } catch { /* 损坏卡不进对照面 */ }
  }
  const plan = planGc(drafts, mergedCards, { now: Date.now(), archiveDays });
  log(`drafts gc${apply ? '（--apply 执行迁移）' : '（dry-run，加 --apply 才动文件）'}：提案 ${drafts.length} 张、merged 对照 ${mergedCards.length} 张${unreadable.length ? `、解析失败 ${unreadable.length} 张（${unreadable.join(', ')}）` : ''}。`);
  if (plan.superseded.length) {
    log(`\n【superseded 候选】改动面已被 merged 卡覆盖（${plan.superseded.length} 张）：`);
    for (const { draft, mergedId } of plan.superseded) log(`  - ${draft.file} ← ${mergedId}`);
  } else {
    log('\n【superseded 候选】无（没有与 merged 卡改动面重叠的提案）。');
  }
  if (plan.aged.length) {
    log(`\n【aged 候选】超 ${archiveDays} 天（${plan.aged.length} 张）：`);
    for (const { draft, ageDays } of plan.aged) log(`  - ${draft.file}（${ageDays} 天）`);
  } else {
    log(`\n【aged 候选】无（没有超 ${archiveDays} 天的提案）。`);
  }
  if (plan.titleSimilar.length) {
    log(`\n【仅标题相似，不迁（防误杀）】${plan.titleSimilar.length} 张：`);
    for (const { draft, mergedId } of plan.titleSimilar) log(`  - ${draft.file} ≈ ${mergedId}（目标相似但 files_hint 不重叠——人工判断是否废弃）`);
  }
  if (!apply) {
    if (plan.superseded.length || plan.aged.length) log(`\ndry-run 结束：加 --apply 迁移 ${plan.superseded.length + plan.aged.length} 张（superseded/ ${plan.superseded.length}、archived/ ${plan.aged.length}）。`);
    return;
  }
  const r = applyGc(repoRoot, plan, { now: Date.now() });
  for (const m of r.movedSuperseded) log(`  迁移 ${m.file} → drafts/superseded/`);
  for (const m of r.movedAged) log(`  迁移 ${m.file} → drafts/archived/`);
  for (const f of r.failed) console.warn(`[orchestrator] 迁移失败 ${f.file}：${f.reason}（留原地，绝不删除）`);
  log(`\n--apply 完成：superseded ${r.movedSuperseded.length} 张、archived ${r.movedAged.length} 张${r.failed.length ? `、失败 ${r.failed.length} 张` : ''}。`);
}

/**
 * scan——nightly 巡检信号源（Phase 2，docs 10.4）：TODO/FIXME、npm audit、测试失败、
 * GitHub issues、已知问题账本、主干 CI 失败 → 消毒后生成**提案**落 drafts/（不直接进
 * 队列）。注入面双闸：sanitize 消毒 + 人工批量 submit（或 autopilot 白名单，授权矩阵
 * 见 autopilot.mjs——deps/核心路径/人工草稿永不自动）。
 * --run：对本次 high 优先级提案立即提交并发起闭环（gate=L3 兜底——合并仍人工）。
 * nightly 触发由 cron/调度系统调用本命令；watch 周期也调用它。
 */
async function cmdScan(repoRoot, opts) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const flags = opts.flags ?? new Set();
  const anySignal = ['--todo', '--audit', '--tests', '--issues', '--ki', '--ci'].some((f) => flags.has(f));
  const runOpts = {
    todo: !anySignal || flags.has('--todo'),
    audit: !anySignal || flags.has('--audit'),
    tests: flags.has('--tests'), // 要跑测试套件，慢——显式开启
    issues: !anySignal || flags.has('--issues'), // gh best-effort：未安装/非 GitHub 远端 → 警告跳过
    ki: !anySignal || flags.has('--ki'), // 已知问题账本：文件缺失静默跳过
    ci: !anySignal || flags.has('--ci'), // 主干 CI 失败：gh best-effort
    baseBranch: runConfig(repoRoot).baseBranch ?? 'main',
    dryRun: flags.has('--dry-run'),
    testCmd: runConfig(repoRoot).testCmd.join(' && '),
  };
  const { created, skipped, warnings } = await runScan(repoRoot, runOpts);
  for (const w of warnings) log(`⚠ ${w}`);
  if (runOpts.dryRun) {
    log(created.length ? `将生成 ${created.length} 张提案（dry-run 未写入）：` : '无新信号，不生成提案。');
    for (const c of created) log(`  ${c}`);
    for (const s of skipped) log(`  [已存在，跳过] ${s}`);
    return;
  }
  for (const c of created) log(`已生成提案：drafts/${c}.md（等人工 submit 或 autopilot 白名单自动提交）`);
  for (const s of skipped) log(`已存在，跳过：${s}`);
  if (!created.length && !skipped.length && !warnings.length) log('巡检完成：无新信号。');
  // autopilot 白名单自动提交（enabled 才生效；提交的卡 gate→L1，实际合并仍由分级裁决）
  const submitted = autoSubmitProposals(repoRoot, root);

  // --run：本次生成的 high 优先级提案立即提交并逐卡发起闭环
  if (flags.has('--run') && created.length) {
    const lock = acquireSchedulerLock(repoRoot, 'scan --run');
    if (!lock.held) {
      log(`⏸ 调度器已在运行（pid=${lock.owner.pid}，${lock.owner.cmd ?? ''}）——提案已生成，本次不自动 run；稍后手动 run/drain。`);
      return;
    }
    try {
      const createdIds = created.map((c) => c.replace(/^\[dry-run\] /, ''));
      const high = createdIds.filter((id) => highPriorityDraftIds(repoRoot).includes(id));
      for (const id of high) {
        const r = submitDraft(repoRoot, root, id);
        if (!r.submitted) {
          log(`提案 ${id} 未提交：${r.skipped}`);
          continue;
        }
        log(`\n═══ scan --run → ${id}（priority=high）═══`);
        const rr = spawnSync('node', [path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs'), 'run', id, ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
          cwd: repoRoot,
          stdio: 'inherit',
          env: { ...process.env, ...childEnvForHeldLock() },
        });
        if (rr.status !== 0) log(`任务 ${id} 退出码 ${rr.status}（已落 blocked/failed/，继续）。`);
      }
    } finally {
      releaseSchedulerLock(repoRoot);
    }
  }
}

// ---------------------------------------------------------------------------
// planner 会话决策留底（kind=planner，watchdog/smartfilter/review 三类之外新增）
// ---------------------------------------------------------------------------

/** 本次 planner 会话的留底主体 id（logs/planner-<时间戳>，sail 报告目录同款时间戳口径——
 *  Windows 文件名安全、字典序即时间序；同秒并发撞名由 trace.mjs 的文件名存在性检查兜底）。 */
function plannerTraceTaskId() {
  const pad2 = (n) => String(n).padStart(2, '0');
  const d = new Date();
  return `planner-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/**
 * propose/intent 每次 planner spawn 的结果落 decision trace（成功与重试失败都落）。
 * 背景（2026-11-02 自由航行实证）：planner 会话「未产出契约块」时原始输出与 exitCode/
 * stderrTail 全部丢弃——探针复现又正常，瞬时 429 还是格式漂移无法定位。留底后可复盘
 * 「模型当时输出了什么」。复用 trace.mjs 滚动/截断（写失败内部消化，绝不影响主流程）；
 * trace.enabled=false 整体关闭。parsed 传提取结果摘要（{ blocks: n } 或 null）。
 */
function tracePlannerSpawn({ repoRoot, session, traceCfg, command, backend, attempt, promptText, result, parsed, startedAt }) {
  if (!traceCfg?.enabled) return;
  const stderrTail = String(result?.stderrTail ?? '').trim();
  writeDecisionTrace(
    {
      root: logDir(repoRoot, session),
      taskId: session,
      kind: 'planner',
      input: promptText, // 本次尝试的 planner prompt 全文（重试追加的要求随之留痕）
      output: String(result?.output ?? ''), // 模型原始输出全文（超上界截前缀，trace.mjs 兜底）
      parsed: parsed ?? null,
      meta: {
        command,
        backend,
        attempt,
        exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
        ...(stderrTail ? { stderrTail: stderrTail.slice(-200) } : {}), // 尾部 ≤200 字符
        durationMs: Date.now() - startedAt,
        ...(result?.usage && typeof result.usage === 'object' && !Array.isArray(result.usage) ? { usage: result.usage } : {}),
      },
    },
    traceCfg,
  );
}

/** 重试失败日志的现场摘要：exitCode + stderrTail 尾部（≤200 字符），不再只有「N 次均未产出契约块」。 */
function plannerSpawnDetail(result) {
  const parts = [`exitCode=${Number.isInteger(result?.exitCode) ? result.exitCode : '?'}`];
  const tail = String(result?.stderrTail ?? '').trim();
  if (tail) parts.push(`stderrTail=${tail.slice(-200)}`);
  return parts.join('，');
}

/**
 * intent——Planner 环节（Phase 2 展望项落地，docs 10.8）：人给一句话意图，
 * readonly planner 会话探索仓库并编译任务卡（验收标准可机器检查化），
 * 校验重试后自动 submit。人的参与从此收敛为：给意图 + L2/L3 审核。
 * --draft 只落草稿不进队列（确认路径）；默认直接 submit（信任路径）。
 */
async function cmdIntent(repoRoot, opts) {
  const intentText = (opts.intent ?? []).join(' ').trim();
  if (!intentText) die('用法：intent "<一句话描述任务>" [--draft] [--backend mock]');
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  opts.backend = resolveBackendName(opts, null).name; // 规划会话不记账：缺省回落，防 undefined 直喂 getBackend
  const backend = await getBackend(opts.backend);
  const traceCfg = loadWorkflowConfig(repoRoot).trace;
  const session = plannerTraceTaskId();
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-planner-')), 'settings.json');
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-intent-')), 'planner-prompt.md');

  try {
    let promptText = buildPlannerPrompt(sanitizeIntent(intentText), repoRoot);
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      fs.writeFileSync(promptFile, promptText);
      if (opts.backend === 'claude-headless') writeWorkerSettings(settingsFile, {}, repoRoot);
      const startedAt = Date.now();
      const result = await backend.spawn({
        promptFile,
        cwd: repoRoot, // planner 只读探索主仓库（Read/Glob/Grep 白名单，fail-closed）
        maxTurns: 25,
        onEvent: () => {}, // 无任务事件线；planner 用量不记账
        readonly: true,
        settingsFile,
      });
      const cardText = parseCardBlock(result.output ?? '');
      tracePlannerSpawn({ repoRoot, session, traceCfg, command: 'intent', backend: opts.backend, attempt, promptText, result, parsed: cardText ? { blocks: 1 } : null, startedAt });
      if (!cardText) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（第 ${attempt} 次输出不含 ${'```'}${CARD_MARKER}${'```'} 契约块）\n请严格按产出契约重新输出：单个 fenced 契约块内含完整任务卡。`;
          continue;
        }
        die(`Planner ${MAX_ATTEMPTS} 次均未产出任务卡契约块（最后一次：${plannerSpawnDetail(result)}）。请改用手写任务卡 + submit。`);
      }
      try {
        const { meta } = loadCard(cardText, 'planner-draft');
        if (meta.gate !== 'L3') {
          meta.gate = 'L3';
          log(`⚠ Planner 卡 gate=${meta.gate || '(空)'} 已强制覆写为 L3（Planner 卡固定人工合并闸门，docs 10.8）。`);
        }
        const existing = findCard(root, meta.id);
        if (existing) throw new Error(`任务 id "${meta.id}" 已存在于 ${existing.state}/，请换 id`);
        // 文本级覆写 created_by/gate（保留 Planner 写的全部正文段落）
        const finalText = cardText
          .replace(/^created_by:.*$/m, 'created_by: planner')
          .replace(/^gate:.*$/m, 'gate: L3');
        if (opts.flags?.has('--draft')) {
          const draftsDir = path.join(repoRoot, '.agents', 'orchestrator', 'drafts');
          fs.mkdirSync(draftsDir, { recursive: true });
          const draftPath = path.join(draftsDir, `${meta.id}.md`);
          fs.writeFileSync(draftPath, finalText);
          log(`草稿已生成（确认路径，未进队列）：${draftPath}`);
          log(`人工审阅后提交：node .agents/scripts/orchestrator.mjs submit "${draftPath}"`);
        } else {
          fs.writeFileSync(cardPath(root, 'pending', meta.id), finalText);
          log(`意图已编译为任务卡：pending/${meta.id}.md（gate=L3，合并前会经人工审核）`);
          log(`启动闭环：node .agents/scripts/orchestrator.mjs run ${meta.id}`);
          log(`批量推进：node .agents/scripts/orchestrator.mjs drain`);
        }
        return;
      } catch (e) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（第 ${attempt} 次产出的任务卡未通过校验）\n校验错误：${String(e.message).slice(0, 500)}\n请修正后重新输出完整契约块。`;
          continue;
        }
        die(`Planner ${MAX_ATTEMPTS} 次产出的任务卡均未通过校验（最后一次：${String(e.message).slice(0, 200)}）。请改用手写任务卡 + submit。`);
      }
    }
  } finally {
    try {
      fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
      fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
    } catch {}
  }
}

/**
 * propose——autopilot 需求综合（DeepSeek Super-agent「主动给需求」的落地）：目标面
 * （goals.md）+ drafts 巡检提案 + 队列现状 → planner 只读会话产出至多
 * maxProposalsPerCycle 张高质量任务卡，落 drafts/ 提案（不直接进队列）。
 * 进队列两条路：人工批量 submit，或 autopilot 白名单自动提交（本命令尾部即做——
 * nightly --plan / watch 周期调用它时自动衔接）。烧钱动作（planner 会话）只在此发生。
 */
async function cmdPropose(repoRoot, opts) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const cfg = loadWorkflowConfig(repoRoot);
  const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : cfg.autopilot.maxProposalsPerCycle;
  opts.backend = resolveBackendName(opts, null).name; // 规划会话不记账：缺省回落，防 undefined 直喂 getBackend
  const backend = await getBackend(opts.backend);
  const session = plannerTraceTaskId();
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-propose-settings-')), 'settings.json');
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-propose-')), 'propose-prompt.md');
  try {
    // 信号输入：drafts/ 现有提案（scan 产物为主）的 id/type/goal 摘要——planner 深化它们而非另起炉灶
    let files = [];
    try {
      files = fs.readdirSync(draftsDir(repoRoot)).filter((f) => f.endsWith('.md'));
    } catch { /* drafts/ 不存在 */ }
    const signals = files
      .map((f) => {
        try {
          const { meta, body } = parseCard(fs.readFileSync(path.join(draftsDir(repoRoot), f), 'utf8'), f);
          return `- ${meta.id}（${meta.type}/${meta.priority ?? 'normal'}，by ${meta.created_by ?? '?'}）：${String(body.goal ?? '').replace(/\s+/g, ' ').slice(0, 120)}`;
        } catch {
          return null; // 损坏提案跳过，不进 prompt
        }
      })
      .filter(Boolean)
      .join('\n');
    const queueSummary = STATES.map((s) => `${s}=${listCards(root, s).length}`).join(' ');
    // 舰队反馈（可选，workflow.json propose.feedback 缺省关）：stats 同源的运行度量数据事实
    // 注入 planner prompt（近 7 天 near-miss 分布 / 各 type 消化数据 / drift 状态 / goals 当前
    // 主题摘录）。只放数据不写硬指令——priority 取舍由 planner 按数据自行判断。
    // 关闭时 fleetFeedback 为 null，prompt 与历史逐字节一致（回归红线）。
    const goals = readGoals(repoRoot);
    let fleetFeedback = null;
    if (cfg.propose?.feedback) {
      const fb = collectStatsSummary(repoRoot, { days: 7 }); // 数据窗口与 stats --days 缺省一致（近 7 天）
      fleetFeedback = buildFleetFeedback({ summary: fb.summary, perType: fb.perType, drift: fb.drift, goalsThemes: extractGoalsThemes(goals) });
    }
    let promptText = buildProposePrompt({ goals, signals, queueSummary, maxCards: max, repoRoot, fleetFeedback });
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      fs.writeFileSync(promptFile, promptText);
      if (opts.backend === 'claude-headless') writeWorkerSettings(settingsFile, {}, repoRoot);
      const startedAt = Date.now();
      const result = await backend.spawn({
        promptFile,
        cwd: repoRoot, // planner 只读探索主仓库（Read/Glob/Grep 白名单，fail-closed）
        maxTurns: 25,
        onEvent: () => {}, // 无任务事件线；planner 用量不记账
        readonly: true,
        settingsFile,
      });
      const blocks = parseCardBlocks(result.output ?? '');
      tracePlannerSpawn({ repoRoot, session, traceCfg: cfg.trace, command: 'propose', backend: opts.backend, attempt, promptText, result, parsed: blocks.length ? { blocks: blocks.length } : null, startedAt });
      if (!blocks.length) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（第 ${attempt} 次输出不含 ${'```'}${CARD_MARKER}${'```'} 契约块）\n请按产出契约重新输出：每张任务卡一个独立 fenced 契约块（没有值得做的就一张都不出）。`;
          continue;
        }
        die(`Planner ${MAX_ATTEMPTS} 次均未产出提案契约块（最后一次：${plannerSpawnDetail(result)}）。`);
      }
      const created = [];
      const rejected = [];
      fs.mkdirSync(draftsDir(repoRoot), { recursive: true }); // 首轮提案前 drafts/ 可能还不存在
      for (const block of blocks) {
        try {
          const { meta } = loadCard(block, 'propose-draft');
          if (findCard(root, meta.id)) {
            rejected.push(`${meta.id} 已在队列（不覆盖）`);
            continue;
          }
          fs.writeFileSync(path.join(draftsDir(repoRoot), `${meta.id}.md`), normalizeProposalText(block, { createdBy: 'planner', gate: 'L3' }));
          if (!created.includes(meta.id)) created.push(meta.id);
        } catch (e) {
          rejected.push(`一张卡校验未过（${String(e.message).slice(0, 120)}）`);
        }
      }
      log(`propose：planner 产出 ${blocks.length} 张 → 落提案 ${created.length} 张${rejected.length ? `，否决 ${rejected.length} 张` : ''}（上限 ${max}）。`);
      for (const c of created) log(`  提案：drafts/${c}.md`);
      for (const r of rejected) log(`  ✗ ${r}`);
      // feature 提案提示（上游管线，2026-11 Plan A）：feature 不自动进队列——需调研 brief
      // + spec 人工审设计；sail 航次会在规划轮自动补齐 research → spec 两步，交互场景给提示
      const featureDrafts = created.filter((id) => {
        try { return parseCard(fs.readFileSync(path.join(draftsDir(repoRoot), `${id}.md`), 'utf8'), id).meta.type === 'feature'; } catch { return false; }
      });
      if (featureDrafts.length) {
        log(`  ⛵ feature 提案 ${featureDrafts.join(', ')} 走上游管线：research brief → spec → 人工审设计 → spec build（sail 规划轮自动补齐；交互场景可先跑 research "<问题>" 再 spec "<意图>" --from-brief <id>）。`);
      }
      // autopilot 白名单自动提交（提交后纳入本周期/下一次 drain）
      const submitted = autoSubmitProposals(repoRoot, root);
      return { created, submitted };
    }
  } finally {
    try {
      fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
      fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// spec —— 规格驱动（Spec Kit/Kiro 式三件套，Phase 2 展望项落地，docs 10.9）
// ---------------------------------------------------------------------------

/**
 * spec start：Planner 只读会话把意图编译成 requirements/design/tasks 三件套，落盘
 * specs/<id>/ 等人工审阅（可手改文件），不进队列。与 intent 的分工：intent = 小改动
 * 一句话直达任务卡；spec = 需要「先设计后施工」的特性，人审设计后再拆卡。
 */
async function cmdSpecStart(repoRoot, opts) {
  const intentText = (opts.intent ?? []).join(' ').trim();
  if (!intentText) die('用法：spec "<一句话描述特性>" [--from-brief <brief-id[,id2…]>] [--backend mock]');
  opts.backend = resolveBackendName(opts, null).name; // 同 intent：缺省回落，防 undefined 直喂 getBackend
  const backend = await getBackend(opts.backend);
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-spec-')), 'settings.json');
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-spec-prompt-')), 'spec-prompt.md');

  try {
    // --from-brief <id[,id2…]>：调研结论（research 命令产出的 brief）注入 spec prompt——上游管线
    // 的 glue（brief → spec），spec 三件套/人工审设计/spec build 全流程零改动复用。
    // 值支持英文逗号分隔多个 brief id（容忍逗号两侧空格），multi-dim 调研的多份结论一次注入
    let briefBody = '';
    if (opts.fromBrief) {
      const briefIds = String(opts.fromBrief).split(',').map((s) => s.trim()).filter(Boolean);
      if (!briefIds.length) die(`--from-brief "${opts.fromBrief}" 未解析出任何 brief id。用法：--from-brief <brief-id[,id2…]>，research list 查看已有 brief。`);
      const missing = [];
      const briefs = [];
      for (const id of briefIds) {
        const brief = readBrief(repoRoot, id);
        if (!brief) missing.push(id);
        else briefs.push({ id, body: brief.body });
      }
      if (missing.length) die(`调研 brief 不存在：${missing.map((id) => `"${id}"`).join('、')}（目录 ${researchDir(repoRoot)}）。research list 查看已有 brief。`);
      // 单 id 保持 body 原文不包装：向后兼容（既有注入格式与测试断言依赖原文）；多 id 才拼分节
      briefBody = briefs.length === 1
        ? briefs[0].body
        : briefs.map((b) => `# 调研结论（brief：${b.id}）\n\n${String(b.body).trim()}`).join('\n\n---\n\n');
    }
    let promptText = buildSpecPrompt(sanitizeIntent(intentText), repoRoot, loadWorkflowConfig(repoRoot).reviewNotes, briefBody);
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      fs.writeFileSync(promptFile, promptText);
      if (opts.backend === 'claude-headless') writeWorkerSettings(settingsFile, {}, repoRoot);
      const result = await backend.spawn({
        promptFile,
        cwd: repoRoot, // spec planner 只读探索主仓库（Read/Glob/Grep 白名单，fail-closed）
        maxTurns: 30,
        onEvent: () => {},
        readonly: true,
        settingsFile,
      });
      const parsed = parseSpecBlocks(result.output ?? '');
      if (!parsed) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（第 ${attempt} 次输出缺少规格契约块）\n请严格按产出契约重新输出：agents-spec / agents-requirements / agents-design / agents-tasks 四个 fenced block 齐全。`;
          continue;
        }
        die(`Spec Planner ${MAX_ATTEMPTS} 次均未产出三件套契约块。请改用 intent（小改动）或手写 specs/ 文档。`);
      }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(parsed.id)) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（id "${parsed.id}" 不合法）\nid 只允许小写字母/数字/短横线，请修正 agents-spec 块后重新输出。`;
          continue;
        }
        die(`Spec Planner 产出的 id "${parsed.id}" 不合法（只允许小写字母/数字/短横线）。`);
      }
      if (!parseTasksDoc(parsed.tasks).length) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（tasks 未解析到任务段）\ntasks 块必须含「## 任务 N:标题」段（每段带 目标/文件/完成条件/依赖 四行），请修正后重新输出。`;
          continue;
        }
        die('Spec Planner 产出的 tasks 未解析到任何「## 任务 N:」段。');
      }
      if (fs.existsSync(path.join(repoRoot, '.agents', 'orchestrator', 'specs', parsed.id))) {
        die(`规格 id "${parsed.id}" 已存在（specs/${parsed.id}/）。换个意图措辞重试，或手改既有规格后直接 spec build。`);
      }
      const dir = writeSpec(repoRoot, parsed);
      log(`规格三件套已生成（人工审阅/手改后再拆卡）：${dir}`);
      log(`  requirements.md（需求：用户故事 + EARS 验收标准）`);
      log(`  design.md（技术设计：现状/方案/取舍/风险）`);
      log(`  tasks.md（任务分解：可独立合并的工作段）`);
      log(`确认设计后拆卡进队列：node .agents/scripts/orchestrator.mjs spec build ${parsed.id}`);
      return;
    }
  } finally {
    try {
      fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
      fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
    } catch {}
  }
}

/** spec build：把已审阅规格的 tasks 拆成任务卡进 pending/（幂等，同 id 跳过）。 */
function cmdSpecBuild(repoRoot, id) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  if (!listSpecs(repoRoot).includes(id)) {
    die(`规格 "${id}" 不存在。spec list 查看已有规格；spec "<意图>" 生成新的。`);
  }
  const { created, skipped, warnings } = buildSpecCards(repoRoot, root, id);
  for (const w of warnings) log(`⚠ ${w}`);
  for (const c of created) log(`已生成任务卡：pending/${c}.md（gate=L3，design 全文已注入卡背景）`);
  for (const s of skipped) log(`已存在，跳过：${s}`);
  if (!created.length && !skipped.length) return;
  log(`推进：node .agents/scripts/orchestrator.mjs drain（卡按任务序先后调度，合并逐张等人工 approve）`);
}

/** spec list/show：浏览规格目录与单规格概要。 */
function cmdSpecList(repoRoot) {
  const ids = listSpecs(repoRoot);
  if (!ids.length) {
    log('尚无规格。生成：node .agents/scripts/orchestrator.mjs spec "<一句话描述特性>"');
    return;
  }
  for (const id of ids) {
    const s = readSpec(repoRoot, id);
    const tasks = parseTasksDoc(s.tasks);
    log(`${id.padEnd(28)} ${s.meta.title}（${tasks.length} 个任务，${s.dir}）`);
  }
}

function cmdSpecShow(repoRoot, id) {
  if (!listSpecs(repoRoot).includes(id)) die(`规格 "${id}" 不存在。spec list 查看。`);
  const s = readSpec(repoRoot, id);
  log(`════════ 规格 ${id}：${s.meta.title} ════════`);
  log(`目录: ${s.dir}`);
  const tasks = parseTasksDoc(s.tasks);
  for (const t of tasks) log(`  任务 ${t.n}: ${t.title}（文件: ${t.files.join(', ')}；${t.deps}）`);
  log(`拆卡进队列：node .agents/scripts/orchestrator.mjs spec build ${id}`);
}

/** spec status <id>：全局进度锚（progress.json）——跨夜 drain / 断点续跑的全局完成度视图。 */
function cmdSpecStatus(repoRoot, id) {
  if (!listSpecs(repoRoot).includes(id)) die(`规格 "${id}" 不存在。spec list 查看。`);
  let progress;
  try {
    progress = readProgress(queueRoot(repoRoot), id);
  } catch {
    die(`规格 "${id}" 尚无 progress.json（早于进度锚机制的规格或未 build 过）。\n重跑 spec build ${id} 即可生成（幂等，不重复拆卡）。`);
  }
  const counts = {};
  for (const t of progress.tasks ?? []) counts[t.status] = (counts[t.status] ?? 0) + 1;
  log(`════════ 规格 ${id} 进度：${progress.title} ════════`);
  for (const t of progress.tasks ?? []) {
    log(`  [${String(t.status).padEnd(14)}] 任务 ${t.n}: ${t.title}（卡 ${t.card_id}）`);
  }
  log(`落位：${Object.entries(counts).map(([s, n]) => `${s} ${n}`).join('、') || '无'}（更新于 ${progress.updated_at}）`);
}

// ---------------------------------------------------------------------------
// Researcher（上游管线第一环，docs 10.12）：Deep Research 式外部调研。产物 = 带引用
// 的 brief（research/<id>/brief.md），供 feature 提案 research 字段与 spec --from-brief
// 消费。调研不是任务卡：无 diff、不进施工队列。会话工具面 = 只读文件 + WebFetch/
// WebSearch（backends RESEARCH_TOOLS；无 Bash 无写，fail-closed 同 reviewer）。
// ---------------------------------------------------------------------------

/** 3 次重试全败的会话返回值：真值对象（区别于成功的 { id, dir, … }），带最后一跳现场——
 *  2026-11-08 P1-⑤：此前失败只返回 null，claude CLI 把「模型不存在/无权」「tool_call 被当
 *  纯文本」这类死因写在 stderr，全部丢弃后 die 文案只剩「N 次均未产出」，无法定位。 */
function researchFailure(result) {
  return {
    failed: true,
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    stderrTail: String(result?.stderrTail ?? '').trim(),
  };
}

/** 单次调研会话核心（cmdResearch / cmdResearchMulti 与 sail 上游管线共用）：3 次重试 → brief 落盘，
 *  失败返回 { failed: true, exitCode, stderrTail }（researchFailure，带最后一跳现场供 die 文案）。
 *  model：调研船模型（--model 显式 > workflow.json research.model > claude CLI 全局默认）——
 *  2026-11-08 实证：researcher 吃全局默认 glm-4.5-air 时检索接地失效产出旧世界内容，
 *  换 glm-5.3-flash 后恢复正常——调研船必须与执行船解耦选型。
 *  briefId/topicId/dim（可选，research multi 专用）：briefId 显式指定时忽略模型自报 id，
 *  强制以 <topic-slug>-d<N> 落盘（topic 的并行/连跑 brief 从命名空间上隔离，TOCTOU 消灭在
 *  落盘层）；topicId/dim 透传进 meta.json 溯源。缺省 null = 行为与从前逐字节一致。 */
async function runResearchSession(repoRoot, { question, backendName, minCitations = 1, model, traceCommand = 'research', briefId = null, topicId = null, dim = null }) {
  const backend = await getBackend(backendName);
  const traceCfg = loadWorkflowConfig(repoRoot).trace;
  const session = plannerTraceTaskId();
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-research-')), 'settings.json');
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-research-prompt-')), 'research-prompt.md');
  try {
    let promptText = buildResearchPrompt(sanitizeIntent(question), repoRoot, { goalsText: readGoals(repoRoot), minCitations });
    const MAX_ATTEMPTS = 3;
    let lastResult = null; // 最后一跳 spawn 结果：失败时透出 stderrTail/exitCode（P1-⑤）
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      fs.writeFileSync(promptFile, promptText);
      if (backendName === 'claude-headless') writeWorkerSettings(settingsFile, {}, repoRoot);
      const startedAt = Date.now();
      const result = await backend.spawn({
        promptFile,
        cwd: repoRoot, // researcher 只读探索仓库（Read/Glob/Grep）+ 联网检索（WebFetch/WebSearch），无 Bash 无写
        maxTurns: 25,
        onEvent: () => {}, // 无任务事件线；researcher 用量不记账（同 planner 家族）
        web: true,
        model,
        settingsFile,
      });
      lastResult = result;
      const parsed = parseBriefBlock(result.output ?? '');
      tracePlannerSpawn({ repoRoot, session, traceCfg, command: traceCommand, backend: backendName, attempt, promptText, result, parsed: parsed ? { blocks: 1 } : null, startedAt });
      if (!parsed) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（第 ${attempt} 次输出不含 ${'```'}${BRIEF_MARKER}${'```'} 契约块）\n请严格按产出契约重新输出：单个 agents-brief fenced block（id/title + 五段齐全）。`;
          continue;
        }
        return researchFailure(lastResult);
      }
      if (!briefId && !TASK_ID_RE.test(parsed.id)) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（id "${parsed.id}" 不合法）\nid 只允许小写字母/数字/短横线，请修正 agents-brief 块后重新输出。`;
          continue;
        }
        return researchFailure(lastResult);
      }
      try {
        validateBriefBody(parsed.body, { minCitations });
      } catch (e) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（第 ${attempt} 次 brief 未通过校验）\n校验错误：${String(e.message).slice(0, 400)}\n请修正后重新输出完整契约块。`;
          continue;
        }
        return researchFailure(lastResult);
      }
      // 同 id 已存在时自动派生 <id>-2…-9 落盘（P1-④，同题重跑不再裸崩）；回执用实际落盘 id。
      // briefId 显式指定（research multi）时忽略模型自报 id，强制 <topic>-d<N> 命名空间
      const { dir, id } = writeBriefAuto(repoRoot, { id: briefId ?? parsed.id, title: parsed.title, question, backend: backendName, body: parsed.body, topicId, dim });
      return { id, dir, body: parsed.body, citations: extractCitations(parsed.body) };
    }
    return researchFailure(lastResult);
  } finally {
    try {
      fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
      fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
    } catch {}
  }
}

/**
 * 仲裁轮会话（research verify 的 contradicted 外部取证，2026-11-09 实测驱动）：
 * 复核船无联网、只拿快照裁断——快照自身误导（published_time 语义、骨架截断）时矛盾
 * 可能是误报（今日实测：公告页 published_time=2025-06 被当事件日期，四来源证实 1 月
 * 正确）。仲裁会话带 researcher 同款联网工具面，对每条 contradicted claim 检索 ≥2 个
 * 独立带日期来源（优先官方），产出 agents-arbitration 契约块。模型用 research.model
 * （检索接地强者），2 连败返回 { failed, stderrTail }，调用方 fail-closed 维持否决。
 */
async function runArbitrationSession(repoRoot, { claims, snapshots, backendName, model }) {
  const backend = await getBackend(backendName);
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-arbit-')), 'settings.json');
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-arbit-prompt-')), 'arbitration-prompt.md');
  const sourcesBlocks = snapshots
    .map((s, i) => `### 快照 ${i + 1}：${s.url}\n${s.text.slice(0, 12_000)}`)
    .join('\n\n');
  try {
    let promptText = buildArbitrationPrompt(claims, sourcesBlocks, repoRoot);
    const MAX_ATTEMPTS = 2;
    let lastResult = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      fs.writeFileSync(promptFile, promptText);
      if (backendName === 'claude-headless') writeWorkerSettings(settingsFile, {}, repoRoot);
      const result = await backend.spawn({
        promptFile,
        cwd: repoRoot, // 仲裁只读仓库 + 联网检索（researcher 同款工具白名单，无 Bash 无写）
        maxTurns: 20,
        onEvent: () => {},
        web: true,
        model,
        settingsFile,
      });
      lastResult = result;
      const parsed = parseArbitrationBlock(result.output ?? '');
      if (!parsed) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（第 ${attempt} 次输出不含合规 ${'```'}agents-arbitration${'```'} 契约块）\n请严格按产出契约重新输出：rulings 每条含逐字 claim + ruling 三枚举 + 带日期 sources。`;
          continue;
        }
        return { failed: true, stderrTail: String(lastResult?.stderr ?? '') };
      }
      return parsed;
    }
    return { failed: true, stderrTail: '' };
  } finally {
    try {
      fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
      fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
    } catch {}
  }
}

/**
 * 调研收尾流水线（cmdResearch 与 cmdResearchMulti 共用，2026-11-09 从 cmdResearch 抽出）：
 * 引用快照落盘 → L1 可信度初判（assessBrief 落 verdict.json）→ logVerdict 播报。
 * ledgerExtra（可选）：非空时追加一条 l1 台账（multi 每维一条，附 topic_id/dim 溯源）——
 * 单 brief research 命令不记账（历史行为保持不变）。返回 L1 verdict（level/usage 等）。
 */
async function researchFinalize(repoRoot, r, { model, ledgerExtra = null } = {}) {
  log(`调研 brief 已产出：${r.dir}/brief.md（引用 ${r.citations.length} 条）`);
  log('引用快照落盘（尽力而为，单条失败不影响 brief）…');
  const snap = await snapshotCitations(repoRoot, r.id);
  if (snap.failed.length) {
    log(`  ⚠ ${snap.failed.length} 条快照失败（引用仍在 brief.md 可人工核）：${snap.failed.map((f) => f.url).slice(0, 3).join(', ')}${snap.failed.length > 3 ? '…' : ''}`);
  } else {
    log(`  ✓ ${snap.ok.length} 条引用已快照到 sources/（对账材料）`);
  }
  // L1 可信度初判（report-only）：数字/专名回查所引快照 + 引用深度比，落 verdict.json
  const verdict = assessBrief(repoRoot, r.id, { model });
  logVerdict(r.id, verdict, 'L1 快照回查');
  if (ledgerExtra) {
    appendResearchLedger(repoRoot, {
      kind: 'l1',
      brief_id: r.id,
      model: model ?? null,
      researcher_model: model ?? null,
      level: verdict?.level ?? 'unknown',
      hit_rate: verdict?.scores?.evidence != null ? verdict.scores.evidence / 100 : null,
      decision: verdict?.usage?.internal_decision ?? null,
      ...ledgerExtra,
    });
  }
  return verdict;
}

/**
 * research——外部调研命令。产物：research/<id>/brief.md（五段契约 + 引用）+ sources/
 * 引用快照（尽力而为）。--selftest 实测后端 WebFetch/WebSearch 可用性（非 Anthropic
 * 网关上 WebSearch 常不可用；不可用时调研退化 WebFetch-only，引用不足的 brief 被拒收）。
 */
async function cmdResearch(repoRoot, opts) {
  if (opts.flags?.has('--selftest')) return researchSelftest(repoRoot, opts);
  const question = (opts.intent ?? []).join(' ').trim();
  if (!question) die('用法：research "<调研问题>" [--min-citations N] [--model <模型名>] [--backend mock]\n       research --selftest（实测当前后端联网工具可用性，烧少量 token）');
  const minCitations = Number.isInteger(opts.minCitations) && opts.minCitations > 0 ? opts.minCitations : 1;
  opts.backend = resolveBackendName(opts, null).name; // 规划家族不记账：缺省回落，防 undefined 直喂 getBackend
  // 调研船模型解耦选型：--model 显式 > workflow.json research.model > claude CLI 全局默认
  //（2026-11-08 实证：全局默认 glm-4.5-air 检索接地失效，brief 全是 2024 旧世界内容）
  const cfg = loadWorkflowConfig(repoRoot);
  const model = opts.model || cfg.research?.model || undefined;
  log(`调研问题：${sanitizeIntent(question)}${model ? `\n调研船模型：${model}` : '\n调研船模型：（未指定——用 claude CLI 全局默认，建议 workflow.json research.model 显式配置）'}`);
  const r = await runResearchSession(repoRoot, { question, backendName: opts.backend, minCitations, model });
  if (!r || r.failed) {
    // 2026-11-08 P1-⑤：die 文案带最后一跳 stderr 摘要 + 两个实测死因的处置建议
    //（unrecognized_model = 服务商对该模型 tool-call 支持不完整；</tool_call> = 模型把
    // tool_call 输出成纯文本 XML）。stderrTail 本身已是 stderr 末尾 4000 字，致命错误在最末，
    // 取尾 200 字（与 tracePlannerSpawn/plannerSpawnDetail 口径一致）。
    const tail = String(r?.stderrTail ?? '').trim().slice(-200);
    die(
      `Researcher 会话 3 次均未产出合规 brief（五段契约 + ≥${minCitations} 条当日引用）。\n` +
      `最后一跳 stderr：${tail || '（无 stderr 留痕）'}\n` +
      `若报 unrecognized_model 或输出含 </tool_call>，说明该服务商对此模型的 tool-call 支持不完整——换 --model 或检查服务商模型接入。\n` +
      `可用 --backend mock 验证管线；用真实后端时先 research --selftest 实测联网工具。`,
    );
  }
  const verdict = await researchFinalize(repoRoot, r, { model });
  // 完成事件飞书通知（缩范围：只推不做按钮——research 决策不是卡片 approve 能表达的动作）
  // 标题带项目名：飞书自定义关键词过滤按消息文本命中——标题不含项目名会被 19024 静默丢弃
  //（2026-11-09 实测：关键词=ModelDock 的机器人把无关键词的调研通知整条吞掉）
  try {
    if (cfg.research?.notify !== false) {
      const proj = displayProjectName(cfg.projectName ?? '');
      await notify({ title: `${proj} 调研判定 ${r.id}（${verdict?.level ?? '?'}）`, body: buildResearchNotifyBody(verdict), webhookEnvs: orchWebhookEnvs(repoRoot) });
    }
  } catch { /* 通知失败不阻断 */ }
  log(`research list 查看；把结论带进规格：spec "<意图>" --from-brief ${r.id}\n深度复核（L2 异构）：research verify ${r.id}`);
}

/**
 * research multi——多维度调研（2026-11-09，multi-dim 方案 P1 机制化，串行执行；并发池属 P2）：
 * 一个主题 × N 个维度（--dim 逐个给，≥2 才算 multi，上限 research.maxDims 缺省 4）。
 * 每维问题 = `主题——维度`，喂 runResearchSession（三连败重试自带）；brief id 强制
 * <topic-slug>-d<N>（忽略模型自报 id——并行/连跑的 TOCTOU 竞态从命名空间上消灭）。
 * 产物：每维一份 brief（同单 brief 契约）+ research/topics/<topic-id>.json 复合清单
 * （dims 留痕 + rollup 最差档聚合）；单维失败隔离（记 failed 继续跑），全维失败才 die。
 * 消费方契约：.agents/docs/research-verdict.md 的 topic 节（读 rollup.internal_decision 决策）。
 */
async function cmdResearchMulti(repoRoot, topic, opts) {
  const cleanTopic = sanitizeIntent(topic);
  if (!cleanTopic) die('用法：research multi "<主题>" --dim "<维度1>" --dim "<维度2>" … [--model <模型名>] [--backend mock]\n       维度 ≥2 才算 multi（单维问题直接用 research "<问题>"）');
  const dims = (opts.dims ?? []).map((d) => sanitizeIntent(d)).filter(Boolean);
  if (dims.length < 2) {
    die(`multi 调研至少 2 个维度（收到 ${dims.length} 个）——单维问题直接用 research "<问题>"；多维用 --dim 逐个给（如 --dim 技术选型 --dim 成本 --dim 风险）。`);
  }
  const cfg = loadWorkflowConfig(repoRoot);
  const maxDims = cfg.research?.maxDims ?? 4;
  if (dims.length > maxDims) {
    die(`维度数 ${dims.length} 超过上限 research.maxDims=${maxDims}——拆成多个 topic 分批跑，或在 .agents/workflow.json 的 research.maxDims 调大（正整数）。`);
  }
  opts.backend = resolveBackendName(opts, null).name; // 规划家族不记账：缺省回落，防 undefined 直喂 getBackend
  const model = opts.model || cfg.research?.model || undefined;
  const topicId = deriveTopicId(repoRoot, slugifyTopic(cleanTopic));
  log(`多维调研：${cleanTopic}（${dims.length} 维，topic-id ${topicId}${model ? `，调研船 ${model}` : ''}）——串行执行，单维失败隔离`);
  const dimResults = [];
  for (const [i, dim] of dims.entries()) {
    const forcedId = `${topicId}-d${i + 1}`;
    log(`── 维度 ${i + 1}/${dims.length}：${dim}（brief ${forcedId}）──`);
    const r = await runResearchSession(repoRoot, { question: `${cleanTopic}——${dim}`, backendName: opts.backend, model, briefId: forcedId, topicId, dim });
    if (!r || r.failed) {
      // 失败隔离：该维记 failed（留最后一跳 stderr 尾摘要），批次继续——部分成功仍有价值
      const tail = String(r?.stderrTail ?? '').trim().slice(-200);
      log(`  ✗ 维度「${dim}」未产出 brief——已隔离，继续下一维`);
      dimResults.push({ dim, brief_id: null, status: 'failed', reason: tail || '（无 stderr 留痕）', verdict_level: null, internal_decision: null });
      continue;
    }
    const verdict = await researchFinalize(repoRoot, r, { model, ledgerExtra: { topic_id: topicId, dim } });
    dimResults.push({ dim, brief_id: r.id, status: 'ok', reason: null, verdict_level: verdict?.level ?? 'unknown', internal_decision: verdict?.usage?.internal_decision ?? 'undetermined' });
  }
  if (!dimResults.some((d) => d.status === 'ok')) {
    die(
      `多维调研全部 ${dimResults.length} 个维度失败（无一产出 brief）——逐维最后一跳 stderr：\n` +
      dimResults.map((d) => `- ${d.dim}：${d.reason}`).join('\n') +
      `\n可用 --backend mock 验证管线；用真实后端时先 research --selftest 实测联网工具。`,
    );
  }
  const rollup = rollupTopicVerdict(dimResults);
  const topicObj = { id: topicId, topic: cleanTopic, created_at: toIsoLocal(), dims: dimResults, rollup };
  const file = writeTopic(repoRoot, topicObj);
  log(`topic 汇总已落盘：${file}（rollup ${rollup.level} / ${rollup.internal_decision}${rollup.partial ? '，partial：有失败维' : ''}）`);
  // 汇总飞书通知（整批一条，不带按钮）：标题必须含项目名——飞书自定义关键词过滤按消息
  // 文本命中，无关键词整条静默丢弃（HTTP 200 + code 19024，2026-11-09 实测）
  try {
    if (cfg.research?.notify !== false) {
      const proj = displayProjectName(cfg.projectName ?? '');
      await notify({ title: `${proj} 调研判定 ${topicId}（${rollup.level}）`, body: buildResearchMultiNotifyBody(topicObj), webhookEnvs: orchWebhookEnvs(repoRoot) });
    }
  } catch { /* 通知失败不阻断 */ }
  log(`逐维 L2 复核（复核后 rollup 重算）：research verify ${topicId}\n单维结论进规格：spec "<意图>" --from-brief <brief-id>（如 ${dimResults.find((d) => d.status === 'ok')?.brief_id}）`);
}

/** L1 判级结果统一播报（cmdResearch / 上游管线共用）——v2 verdict：维度分 + usage 决策。 */
function logVerdict(id, verdict, tag) {
  if (!verdict) return;
  const ev = verdict.scores?.evidence;
  const icon = verdict.level === 'pass' ? '✓' : verdict.level === 'warn' ? '⚠' : verdict.level === 'fail' ? '⛔' : '·';
  log(`${icon} 可信度初判（${tag}）：${verdict.level}${ev != null ? `——数字回查核实率 ${ev}%` : ''}（internal_decision=${verdict.usage?.internal_decision ?? '?'}）`);
  for (const line of verdict.reasons ?? []) log(`  · ${line}`);
  if (verdict.level === 'fail') log(`  ⛔ 该 brief 建议作废重跑（可归档到 .agents/orchestrator/research-void/）`);
}

/** research --selftest：一次 6 轮会话实测 WebFetch/WebSearch，输出可用性结论与建议。 */
async function researchSelftest(repoRoot, opts) {
  opts.backend = resolveBackendName(opts, null).name;
  const backend = await getBackend(opts.backend);
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-selftest-')), 'settings.json');
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-selftest-prompt-')), 'selftest-prompt.md');
  try {
    fs.writeFileSync(promptFile, [
      '# 联网工具可用性自检',
      '',
      '依次执行（各自最多尝试一次，失败就如实报 fail）：',
      '1. 用 WebFetch 抓取 https://example.com ，确认拿到页面内容；',
      '2. 用 WebSearch 搜索 modeldock gateway ，确认拿到搜索结果。',
      '',
      '最后只输出以下三行，不要输出其他内容：',
      'WEBFETCH: ok 或 WEBFETCH: fail（附一句话原因）',
      'WEBSEARCH: ok 或 WEBSEARCH: fail（附一句话原因）',
      'SELFTEST-DONE',
    ].join('\n'));
    if (opts.backend === 'claude-headless') writeWorkerSettings(settingsFile, {}, repoRoot);
    const result = await backend.spawn({ promptFile, cwd: repoRoot, maxTurns: 6, onEvent: () => {}, web: true, model: opts.model || loadWorkflowConfig(repoRoot).research?.model || undefined, settingsFile });
    const out = String(result.output ?? '');
    log(`═══ 联网工具自检（后端 ${opts.backend}）═══`);
    const wf = /WEBFETCH:\s*(ok|fail)(.*)/i.exec(out);
    const ws = /WEBSEARCH:\s*(ok|fail)(.*)/i.exec(out);
    log(`- WebFetch: ${wf ? wf[1] + (wf[2]?.trim() ? `（${wf[2].trim()}）` : '') : '未报告（会话未按契约输出）'}`);
    log(`- WebSearch: ${ws ? ws[1] + (ws[2]?.trim() ? `（${ws[2].trim()}）` : '') : '未报告（会话未按契约输出）'}`);
    if (!ws || ws[1].toLowerCase() === 'fail') {
      log('  → WebSearch 不可用（非 Anthropic 后端常态）：调研自动退化为 WebFetch-only（直取已知来源），引用不足的 brief 会被拒收重试。');
    }
    if (!wf || wf[1].toLowerCase() === 'fail') {
      log('  → WebFetch 不可用：先查本机网络与网关连通性，再决定是否启用调研管线。');
    }
    log('提示：本轮自检经网关烧了少量 token（maxTurns=6）。');
  } finally {
    try {
      fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
      fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
    } catch {}
  }
}

/**
 * research verify <brief-id|topic-id>——L2 异构复核（按需，落 spec/对外文档前跑）：
 * readonly 复核会话拿 brief + 快照文本判内部一致性（结论是否被引用支撑），产出
 * agents-verdict 契约块；与 L1 判级合并落 verdict.json 并记台账（L3）。判出 contradicted
 * 时自动追加一轮联网仲裁（≥2 独立带日期来源，upheld 翻案解除否决；research.arbitration=false 关）。
 * 复核船解耦：backend 缺省 review.backend（异构互审同语义），model 缺省 review.model；
 * 仲裁船模型缺省 research.model（检索接地强者）。
 * id 命中 research/topics/<id>.json 时走 topic 模式（cmdResearchVerifyTopic：逐维复核 +
 * rollup 重算）；单 brief id 路径行为不变。
 */
async function cmdResearchVerify(repoRoot, id, opts) {
  const topic = readTopic(repoRoot, id);
  if (topic) return cmdResearchVerifyTopic(repoRoot, topic, opts);
  return verifyBriefOnce(repoRoot, id, opts);
}

/**
 * 单 brief L2 复核核心（cmdResearchVerify 与 topic 模式逐维共用，2026-11-09 从
 * cmdResearchVerify 抽出——单 brief 路径行为逐字节不变）。silent=true（topic 模式逐维跑）
 * 时跳过本 brief 的飞书通知（由 topic 汇总通知一条代替）；topicId/dim 透传进 l2 台账条目
 * 溯源（topic 模式专用）。返回落盘的 verdict 对象（level/usage 供 topic rollup 重算）。
 */
async function verifyBriefOnce(repoRoot, id, opts, { silent = false, topicId = null, dim = null } = {}) {
  const brief = readBrief(repoRoot, id);
  if (!brief) die(`brief "${id}" 不存在（${researchDir(repoRoot)}）。research list 查看已有 brief。`);
  // 对既有 brief（早于 L1 机制产出、无 verdict.json）先补算 L1——verify 输出永远带 L1 回查面
  if (!fs.existsSync(path.join(brief.dir, 'verdict.json'))) {
    const l1 = assessBrief(repoRoot, id, { model: opts.model || loadWorkflowConfig(repoRoot).review?.model });
    logVerdict(id, l1, 'L1 快照回查（补算）');
  }
  const snapshots = loadSnapshots(repoRoot, id);
  const cfg = loadWorkflowConfig(repoRoot);
  const backendName = opts.backend || cfg.review?.backend || 'claude-headless';
  const model = opts.model || cfg.review?.model || undefined;
  const backend = await getBackend(backendName);
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-verify-')), 'settings.json');
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-verify-prompt-')), 'verify-prompt.md');
  try {
    const sourcesBlocks = snapshots
      .map((s, i) => `### 快照 ${i + 1}：${s.url}\n${s.text.slice(0, 12_000)}`)
      .join('\n\n');
    let promptText = buildVerifierPrompt(brief.body, sourcesBlocks, repoRoot);
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      fs.writeFileSync(promptFile, promptText);
      if (backendName === 'claude-headless') writeWorkerSettings(settingsFile, {}, repoRoot);
      const result = await backend.spawn({
        promptFile,
        cwd: repoRoot,
        maxTurns: 15,
        onEvent: () => {},
        readonly: true, // 复核只读：判一致性不需要联网（快照已在材料里）
        settingsFile,
      });
      const parsed = parseVerdictBlock(result.output ?? '');
      if (!parsed) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（第 ${attempt} 次输出不含合规 ${'```'}agents-verdict${'```'} JSON 契约块）\n请严格按产出契约重新输出：claims（逐字摘录 + 五枚举状态）与 blockers。`;
          continue;
        }
        die(`复核会话 3 次均未产出合规 verdict 契约块（--backend mock 可验证管线）。`);
      }
      // v3 管线：逐字校验（防编造 claim）→ note-status 一致性降级 → L1 自动标注（确定性优先，L2 contradicted 一票优先）
      // → scoreVerdict 聚合（null 传染 + 否决权 + usage 矩阵）→ verdict/2 落盘 + L3 台账
      let { valid, fabricated } = verifyClaimVerbatim(parsed.claims, brief.body);
      valid = normalizeClaimStatuses(valid); // supported 却自认无快照/无直据 → unsupported（L1 回查仍可翻回）
      for (const c of valid) {
        if (c.status === 'contradicted') { c.by = 'l2'; continue; } // L2 矛盾判定一票优先
        const toks = extractClaimTokens(c.claim);
        if (!snapshots.length || !toks.length) { c.by = c.by ?? 'l2'; continue; } // 无快照/纯定性：维持 L2 判（缺省 unverifiable 已在契约）
        const r = crossCheckClaims(c.claim, snapshots);
        if (r.checked && r.hits === r.checked) { c.status = 'supported'; c.by = 'l1'; }
        else if (r.checked && r.hits === 0) { c.status = 'unsupported'; c.by = 'l1'; }
        else if (r.checked) { c.status = 'partial'; c.by = 'l1'; }
        // r.checked === 0（claim 无数字 token）：维持 L2 判
      }
      // 仲裁轮（2026-11-09 实测驱动）：L2 contradicted 且配置未关 → 派一次联网取证会话
      //（≥2 独立带日期来源，优先官方）。upheld 翻案为 partial 解除一票否决；overturned/
      // undetermined 维持（保守）。复核船只读无联网——快照误导类误报在这里获得二次裁决。
      let arbitration = null;
      const contradictedClaims = valid.filter((c) => c.status === 'contradicted');
      if (contradictedClaims.length && cfg.research?.arbitration !== false) {
        const arbModel = cfg.research?.model || model;
        log(`  ⚖ ${contradictedClaims.length} 条 claim 被判矛盾——派仲裁轮外部取证（${arbModel ?? '缺省模型'}）…`);
        const arb = await runArbitrationSession(repoRoot, { claims: contradictedClaims, snapshots, backendName, model: arbModel });
        if (arb && !arb.failed && Array.isArray(arb.rulings)) {
          const merged = arbitrateClaims(valid, arb.rulings);
          arbitration = { ran: true, ...merged.stats, veto_cleared: !merged.claims.some((c) => c.status === 'contradicted'), model: arbModel ?? null, backend: backendName };
          valid = merged.claims;
          log(`  ⚖ 仲裁轮：${arbitration.upheld} upheld / ${arbitration.overturned} overturned / ${arbitration.undetermined} undetermined${arbitration.unmatched ? ` / ${arbitration.unmatched} unmatched` : ''}${arbitration.veto_cleared ? '——一票否决解除' : '——否决维持'}`);
        } else {
          arbitration = { ran: true, failed: true, error: '仲裁会话 2 次均未产出合规契约块——维持原否决（fail-closed）', model: arbModel ?? null, backend: backendName };
          log(`  ⚠ 仲裁轮失败——维持原否决（fail-closed）。`);
        }
      }
      const claimCheck = crossCheckClaims(brief.body, snapshots);
      const depth = citationDepthStats(brief.body);
      const citation = scoreCitation({
        datedCount: extractDatedCitations(brief.body).length,
        totalCitations: extractCitations(brief.body).length,
        deep: depth.deep,
        totalUrls: depth.total,
        snapOk: snapshots.length,
        snapTotal: brief.citations.length,
      });
      const evidence = claimCheck.checked ? Math.round(claimCheck.hit_rate * 100) : null;
      const v = scoreVerdict({ claims: valid, fabricatedCount: fabricated.length, citation, evidence, gates: cfg.research?.usageGates });
      const skeleton = snapshots.filter((s) => s.usable === false).length;
      const reasons = [
        ...valid.filter((c) => c.note).map((c) => `[${c.status}] ${c.claim.slice(0, 60)}——${c.note}`),
        ...(fabricated.length ? [`⚠ ${fabricated.length} 条 claim 非逐字摘录被丢弃（编造红旗）：${fabricated.slice(0, 3).join(' / ')}`] : []),
        ...(arbitration?.ran && !arbitration.failed ? [`⚖ 仲裁轮：${arbitration.upheld} upheld / ${arbitration.overturned} overturned / ${arbitration.undetermined} undetermined——${arbitration.veto_cleared ? '一票否决解除' : '否决维持'}`] : []),
        ...(arbitration?.failed ? [`⚠ 仲裁轮失败——维持原否决（fail-closed）`] : []),
        ...(parsed.blockers ?? []),
        ...(skeleton ? [`⚠ ${skeleton}/${snapshots.length} 份快照为骨架页（正文未渲染/被拦）——数字类结论可核性受限`] : []),
      ];
      // verdict.model=调研船（既有 verdict.json 由 L1 assessBrief 写入、model 即调研船），非复核船——复核船在 verifier 字段
      let prevModel = null;
      try { prevModel = JSON.parse(fs.readFileSync(path.join(brief.dir, 'verdict.json'), 'utf8'))?.model ?? null; } catch {}
      const verdict = {
        schema: VERDICT_SCHEMA,
        advisory: true,
        brief_id: id,
        model: prevModel,
        verifier: { backend: backendName, model: model ?? null },
        created_at: new Date().toISOString(),
        scores: v.scores,
        snapshots: { total: snapshots.length, usable: snapshots.length - skeleton, skeleton },
        claims: valid,
        blockers: parsed.blockers ?? [],
        fabricated_claims: fabricated.length,
        arbitration: arbitration ?? null,
        usage: v.usage,
        level: v.level,
        reasons,
      };
      fs.writeFileSync(path.join(brief.dir, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
      appendResearchLedger(repoRoot, { kind: 'l2', brief_id: id, model: model ?? null, researcher_model: prevModel, level: v.level, overall: v.scores.overall, hit_rate: claimCheck.checked ? claimCheck.hit_rate : null, decision: v.usage.internal_decision, ...(topicId ? { topic_id: topicId } : {}), ...(dim ? { dim } : {}) });
      if (arbitration?.ran) appendResearchLedger(repoRoot, { kind: 'l2-arbitration', brief_id: id, model: arbitration.model, researcher_model: prevModel, upheld: arbitration.upheld ?? 0, overturned: arbitration.overturned ?? 0, undetermined: arbitration.undetermined ?? 0, veto_cleared: arbitration.veto_cleared ?? false, failed: arbitration.failed ?? false, decision: v.usage.internal_decision, ...(topicId ? { topic_id: topicId } : {}), ...(dim ? { dim } : {}) });
      log(`═══ L2 复核（${id}，复核船 ${backendName}${model ? `/${model}` : ''}）═══`);
      for (const c of valid) log(`  [${c.status}] ${c.claim.slice(0, 60)}${c.note ? `——${c.note}` : ''}`);
      if (fabricated.length) log(`  ⚠ ${fabricated.length} 条 claim 非逐字摘录已丢弃（编造红旗）`);
      log(`- 维度分：evidence=${v.scores.evidence} coherence=${v.scores.coherence} coverage=${v.scores.coverage}% citation=${v.scores.citation} → overall=${v.scores.overall}（${v.level}）`);
      log(`- 用途判定：browse=${v.usage.browse} internal_decision=${v.usage.internal_decision} external_doc=${v.usage.external_doc}${v.veto ? '（contradicted 一票否决）' : ''}`);
      log(`结果落 ${brief.dir}/verdict.json（schema/2，消费方契约见 .agents/docs/research-verdict.md）；L3 台账已记`);
      // 完成事件飞书通知（缩范围：只推不做按钮——research 决策不是卡片 approve 能表达的动作）
      // 标题带项目名：飞书自定义关键词过滤按消息文本命中——无关键词整条静默丢弃（19024）
      // silent（topic 模式逐维跑）：跳过单维通知，由 topic 汇总一条代替
      try {
        if (!silent && cfg.research?.notify !== false) {
          const proj = displayProjectName(cfg.projectName ?? '');
          await notify({ title: `${proj} 复核判定 ${id}（${v.level}）`, body: buildResearchNotifyBody(verdict), webhookEnvs: orchWebhookEnvs(repoRoot) });
        }
      } catch { /* 通知失败不阻断 */ }
      return verdict;
    }
  } finally {
    try {
      fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
      fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
    } catch {}
  }
}

/**
 * research verify <topic-id> 的 topic 模式（2026-11-09 multi P1）：逐维复用既有 L2 复核
 * 核心（verifyBriefOnce，单维行为与单 brief verify 完全一致），全维完成后重算 rollup、
 * 更新 topic.json、补一条 topic 级台账；飞书通知整批一条（标题含项目名，19024 教训）。
 * failed 维无复核产物——保留原状不参与聚合；ok 维的 brief 已被人工删除时保留原判定并告警。
 */
async function cmdResearchVerifyTopic(repoRoot, topic, opts) {
  const cfg = loadWorkflowConfig(repoRoot);
  log(`═══ topic 复核：${topic.id}（${(topic.dims ?? []).length} 维，逐维 L2，复核船 ${opts.backend || cfg.review?.backend || 'claude-headless'}）═══`);
  const dims = [];
  for (const d of topic.dims ?? []) {
    if (d?.status !== 'ok' || !d.brief_id) {
      log(`  – 维度「${d?.dim}」原为 failed（无 brief 产物）——保留原状，不参与 rollup`);
      dims.push({ ...d });
      continue;
    }
    if (!readBrief(repoRoot, d.brief_id)) {
      log(`  ⚠ 维度「${d.dim}」的 brief ${d.brief_id} 已不存在——保留原判定（人工删除的产物不做复核）`);
      dims.push({ ...d });
      continue;
    }
    const verdict = await verifyBriefOnce(repoRoot, d.brief_id, opts, { silent: true, topicId: topic.id, dim: d.dim });
    log(`  ✓ 维度「${d.dim}」（${d.brief_id}）→ ${verdict.level} / ${verdict.usage.internal_decision}`);
    dims.push({ ...d, verdict_level: verdict.level, internal_decision: verdict.usage.internal_decision });
  }
  const rollup = rollupTopicVerdict(dims);
  const updated = { ...topic, dims, rollup };
  writeTopic(repoRoot, updated);
  appendResearchLedger(repoRoot, { kind: 'topic-verify', topic_id: topic.id, level: rollup.level, decision: rollup.internal_decision, partial: rollup.partial === true });
  log(`rollup 重算：${rollup.level} / ${rollup.internal_decision}${rollup.partial ? '（partial：有失败维，仅成功维参与聚合）' : ''}——topic.json 已更新`);
  // 整批一条飞书通知（缩范围只推不做按钮；标题含项目名——关键词过滤 19024 静默吞消息的教训）
  try {
    if (cfg.research?.notify !== false) {
      const proj = displayProjectName(cfg.projectName ?? '');
      await notify({ title: `${proj} 复核判定 ${topic.id}（${rollup.level}）`, body: buildResearchMultiNotifyBody(updated), webhookEnvs: orchWebhookEnvs(repoRoot) });
    }
  } catch { /* 通知失败不阻断 */ }
}

/** research stats——L3 台账聚合：按调研船模型看核实率与判级分布（信任=统计量）。 */
function cmdResearchStats(repoRoot) {
  const rows = readLedgerStats(repoRoot);
  if (!rows.length) {
    log('台账为空——research / research verify 跑过判定后按模型聚合（信任=统计量，drift 保险丝同哲学）。');
    return;
  }
  log('═══ 调研可信度台账（按调研船模型）═══');
  for (const r of rows) {
    const hr = r.avg_hit_rate == null ? '-' : `${Math.round(r.avg_hit_rate * 100)}%`;
    const levels = Object.entries(r.levels).map(([k, n]) => `${k}:${n}`).join(' ');
    log(`- ${r.model}：${r.runs} 次判定，L1 平均核实率 ${hr}，判级分布 {${levels}}`);
  }
  log('低核实率模型的调研应强制人工复核（自动降级为后续演进项）。');
}

/**
 * 提案 → 规格升级（上游管线 glue）：以提案目标为意图、brief 全文注入，spec planner
 * 会话产出三件套落 specs/<draftId>/。与 cmdSpecStart 的差异：id 固定为提案 id（spec
 * build 拆卡 id 与进度锚对齐）、无人值守（失败返回 false，由调用方记原因下周期重试）。
 */
async function specFromDraft(repoRoot, { draftId, goal, briefBody, backendName }) {
  if (listSpecs(repoRoot).includes(draftId)) return true; // 幂等：上周期已升级，等人审
  const backend = await getBackend(backendName);
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-specup-')), 'settings.json');
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-specup-prompt-')), 'spec-prompt.md');
  try {
    let promptText = buildSpecPrompt(sanitizeIntent(goal || draftId), repoRoot, loadWorkflowConfig(repoRoot).reviewNotes, briefBody);
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      fs.writeFileSync(promptFile, promptText);
      if (backendName === 'claude-headless') writeWorkerSettings(settingsFile, {}, repoRoot);
      const result = await backend.spawn({
        promptFile,
        cwd: repoRoot, // spec planner 只读探索主仓库（Read/Glob/Grep 白名单，fail-closed）
        maxTurns: 30,
        onEvent: () => {},
        readonly: true,
        settingsFile,
      });
      const parsed = parseSpecBlocks(result.output ?? '');
      if (!parsed || !parseTasksDoc(parsed.tasks).length) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（第 ${attempt} 次输出缺规格契约块或无任务段）\n请严格按产出契约重新输出：四个 fenced block 齐全，tasks 含「## 任务 N:」段（每段带 目标/文件/完成条件/依赖 四行）。`;
          continue;
        }
        return false;
      }
      parsed.id = draftId; // 规格与提案同 id：spec build 拆出的卡 id（<id>-t<n>）与提案对齐
      writeSpec(repoRoot, parsed);
      return true;
    }
    return false;
  } finally {
    try {
      fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
      fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
    } catch {}
  }
}

/** 把调研 brief id 盖进提案卡 frontmatter（research: todo/缺失 → research: <id>）。 */
function stampResearchIntoDraft(repoRoot, draftId, briefId) {
  const p = path.join(draftsDir(repoRoot), `${draftId}.md`);
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, 'utf8');
  const stamped = /^research:.*$/m.test(text)
    ? text.replace(/^research:.*$/m, `research: ${briefId}`)
    : text.replace(/^gate:.*$/m, `gate: L3\nresearch: ${briefId}`);
  fs.writeFileSync(p, stamped);
}

/**
 * sail 规划轮的上游管线（2026-11 Plan A）：新提案里的 feature 卡不直接进队列——先派
 * 调研（缺 brief 的），brief 到手后自动升级 spec 三件套落盘**待人审**；人工审完设计
 * spec build 拆卡才回队列。bugfix/refactor/docs 照旧 sailAutoSubmit。
 * 每周期上限：research 2 次、spec 1 次（workflow.json freeSail.researchPerCycle/
 * specPerCycle 可调）——规划轮烧钱动作封顶，未完成的下一周期重试（提案同 id 覆盖=升级）。
 */
async function sailUpstreamPipeline(repoRoot, cfg, proposals, backendName) {
  const out = { researched: [], speced: [], failed: [], verdicts: [] };
  if (!proposals.length) return out;
  const caps = {
    research: Number.isInteger(cfg.freeSail?.researchPerCycle) && cfg.freeSail.researchPerCycle > 0 ? cfg.freeSail.researchPerCycle : 2,
    spec: Number.isInteger(cfg.freeSail?.specPerCycle) && cfg.freeSail.specPerCycle > 0 ? cfg.freeSail.specPerCycle : 1,
  };
  for (const p of proposals) {
    if (p.type !== 'feature') continue;
    let meta = null;
    try {
      meta = parseCard(fs.readFileSync(path.join(draftsDir(repoRoot), `${p.id}.md`), 'utf8'), p.id).meta;
    } catch { continue; } // 损坏提案跳过（propose/drafts gc 自有生命周期管它）
    if (listSpecs(repoRoot).includes(p.id)) continue; // 已升级过规格：等人审/build，不重复烧
    let briefBody = null;
    const briefId = meta.research && meta.research !== 'todo' ? meta.research : null;
    if (briefId) {
      briefBody = readBrief(repoRoot, briefId)?.body ?? null;
      if (!briefBody) out.failed.push({ id: p.id, reason: `research 引用的 brief "${briefId}" 不存在——补跑 research 或改卡` });
    } else if (out.researched.length < caps.research) {
      log(`  ⛵ 上游管线：${p.id} 缺调研——派 researcher（问题取提案目标）`);
      const r = await runResearchSession(repoRoot, { question: p.goal || p.id, backendName, model: cfg.research?.model });
      if (r && !r.failed) { // 失败返回真值对象 { failed, … }（P1-⑤），别当成功消费
        out.researched.push(r.id);
        briefBody = r.body;
        stampResearchIntoDraft(repoRoot, p.id, r.id);
        log(`  ✓ 调研 brief ${r.id}（${r.citations.length} 条引用）→ 已盖进提案 research 字段`);
        // L1 可信度初判（report-only）：快照 + 数字回查，落 verdict.json + 台账；fail 会亮牌但不阻断
        //（管线是否消费 verdict 升级为 gate 属后续演进，先攒 near-miss 分布——晴雨表哲学）
        await snapshotCitations(repoRoot, r.id);
        const verdict = assessBrief(repoRoot, r.id, { model: cfg.research?.model });
        out.verdicts.push({ id: r.id, level: verdict?.level ?? 'unknown' });
        logVerdict(r.id, verdict, 'L1 快照回查');
        if (verdict?.level === 'fail') appendResearchLedger(repoRoot, { kind: 'l1', brief_id: r.id, model: cfg.research?.model ?? null, researcher_model: cfg.research?.model ?? null, level: verdict.level, hit_rate: verdict.l1?.claim_check?.hit_rate ?? null });
      }
    }
    if (!briefBody) {
      if (!out.failed.some((f) => f.id === p.id)) out.failed.push({ id: p.id, reason: '缺调研 brief（派发失败或超本周期上限）——下一周期重试' });
      continue;
    }
    if (out.speced.length < caps.spec) {
      log(`  ⛵ 上游管线：${p.id} → spec 三件套（brief 注入，落盘待人审）`);
      const ok = await specFromDraft(repoRoot, { draftId: p.id, goal: p.goal, briefBody, backendName });
      if (ok) {
        out.speced.push(p.id);
        log(`  ✓ spec ${p.id} 已落盘——人工审阅设计后：spec build ${p.id}`);
      } else {
        out.failed.push({ id: p.id, reason: 'spec 升级失败（planner 未产出合规三件套）——下一周期重试' });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// nightly / schedule —— 定时巡检编排与三平台调度（release-please 式触发层，Phase 2 展望项落地）
// ---------------------------------------------------------------------------

const NIGHTLY_LOG_MAX = 5 * 1024 * 1024;

/** 调度日志滚动：nightly.log 超 5MB 轮转成 .old（wrapper 只会追加，不自增清理）。 */
function rotateNightlyLog(repoRoot) {
  const p = nightlyLogPath(repoRoot);
  try {
    const st = fs.statSync(p);
    if (st.size > NIGHTLY_LOG_MAX) fs.renameSync(p, `${p}.old`);
  } catch {
    // 不存在/被占：首次运行或 Windows 句柄占用，跳过轮转不阻断
  }
}

/**
 * nightly——一次完整巡检编排：scan（生成任务卡，绝不自动 run）+ drift 报告；
 * --auto N 追加：对本次生成的 high 卡发起闭环（gate=L3 兜底，合并仍人工）后
 * drain --max N 清一部分队列。给 cron/launchd/schtasks 定时拉起用（schedule install），
 * 手动跑同效。烧钱动作（worker）只发生在 --auto 下，默认零成本巡检。
 * 结束（含异常）发通知（webhook / macOS，见 notify.mjs）——巡检无人看等于白跑。
 * 幂等补跑（nightly-state.mjs）：启动时对账 logs/nightly-state.json——上次未正常收尾
 * （崩溃/强制重启）记 nightly_recovered + webhook 后照常执行；距上次完成不足 20h 且
 * 非人工触发判为调度器补触发双跑，跳过本次（人工 TTY / --manual 不受限）。
 */
async function cmdNightly(repoRoot, opts) {
  rotateNightlyLog(repoRoot);
  const lock = acquireSchedulerLock(repoRoot, 'nightly');
  if (!lock.held) {
    log(`⏸ 调度器已在运行（pid=${lock.owner.pid}，${lock.owner.cmd ?? ''}）——本次退出，不并发调度。`);
    return;
  }
  const flags = opts.flags ?? new Set();
  // 人工 vs 调度器触发：launchd/cron/schtasks 语境 stdin 非 TTY；终端手动跑天然 TTY
  //（与 opts.interactive 同款判定）。--manual 是脚本/agent 手动触发时的显式逃生口。
  // 二者都不受 20h 双跑防护限制。
  const manual = flags.has('--manual') || Boolean(process.stdin.isTTY && !process.env.CI);
  // 幂等补跑自检（nightly-state.mjs）：先判定、后写 startedAt——skip 路径不得覆写
  // 上次的完成态，否则完成记录会被改成「未收尾」，20h 双跑防护随即失明。
  const prevState = readNightlyState(repoRoot);
  const verdict = decideNightlyStart(prevState, Date.now(), { manual });
  if (verdict.action === 'skip') {
    log(`⏸ nightly 跳过：${verdict.reason}——本次退出（状态未动，下次触发照常）。手动强跑：node .agents/scripts/orchestrator.mjs nightly --manual`);
    releaseSchedulerLock(repoRoot);
    return;
  }
  if (verdict.action === 'recover') {
    log(`⟳ nightly_recovered：${verdict.reason}——本次照常执行接续。`);
    try {
      const recCfg = loadWorkflowConfig(repoRoot);
      await notify({
        title: `${displayProjectName(recCfg.projectName)} nightly`,
        body: 'nightly_recovered：上次巡检未正常收尾（崩溃/强制重启），本次已自动接续。',
        webhookEnvs: nightlyWebhookEnvs(repoRoot),
      });
    } catch { /* 通知失败不阻断编排 */ }
  }
  const nightlyStartedAt = new Date().toISOString();
  // 人工触发（--manual / TTY）不参与调度器状态机：manual 完成态若覆盖 finishedAt，
  // 当晚的 02:30 调度触发会因「距上次完成 <20h 且非人工」被双跑防护误挡——人工跑
  // 不该占用调度的运行记录（副作用：若上次调度 run 被中断，manual 跑后下次调度会
  // 多报一次 nightly_recovered，无害）。
  if (!manual) writeNightlyState(repoRoot, { startedAt: nightlyStartedAt, finishedAt: null });
  log(`════════ nightly 巡检 ${new Date().toISOString()} ════════`);
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const ncfg = runConfig(repoRoot); // repoRoot 锚定（风暴闸/巡检信号共用；勿与收尾处的 loadWorkflowConfig 混名）
  const childEnv = { ...process.env, ...childEnvForHeldLock() };
  let created = [];
  let skipped = [];
  let warnings = [];
  let planned = 0;
  let errMsg = null;

  try {
    // 1) 巡检落提案（信号源与 scan 命令默认一致；--tests 显式开启慢路径；issues/ci 为 gh best-effort）
    ({ created, skipped, warnings } = await runScan(repoRoot, {
      todo: true,
      audit: true,
      issues: true,
      ki: true,
      ci: true,
      tests: flags.has('--tests'),
      baseBranch: ncfg.baseBranch ?? 'main',
      testCmd: ncfg.testCmd.join(' && '),
    }));
    for (const w of warnings) log(`⚠ ${w}`);
    for (const c of created) log(`已生成提案：drafts/${c}.md`);
    for (const s of skipped) log(`已存在，跳过：${s}`);
    if (!created.length && !skipped.length && !warnings.length) log('巡检完成：无新信号。');

    // 1.1) autopilot 白名单自动提交（enabled 才生效；提交的卡进 pending，纳入下方 --auto 的 drain）
    autoSubmitProposals(repoRoot, root);

    // 1.2) --plan：planner 需求综合（autopilot 提案，烧钱动作——显式开启才跑）
    if (flags.has('--plan')) {
      log(`\n═══ nightly --plan → propose（autopilot 需求综合）═══`);
      const r = spawnSync('node', [path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs'), 'propose', ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
        cwd: repoRoot,
        stdio: 'inherit',
        env: childEnv,
      });
      if (r.status !== 0) log(`propose 退出码 ${r.status}（继续巡检后续步骤）。`);
      try {
        planned = fs.readdirSync(draftsDir(repoRoot)).filter((f) => f.endsWith('.md')).length;
      } catch { /* drafts/ 不存在 */ }
    }

    // 2) 质量漂移报告
    printDriftReport(repoRoot);

    // 3) --auto N：high 优先级提案先提交再跑（gate=L3 兜底——合并仍人工，自动 run 的
    //    风险被分级闸门完整兜住），再 drain --max N 推进队列；
    //    worker 由子进程跑（熔断 process.exit 不影响编排进程），单任务 blocked 不阻塞后续。
    //    风暴闸：派发前检查，滞留则整段跳过（high 卡不提交、drain 不启动）——风暴中出航
    //    只会把 high 卡逐张烧成 blocked；窗口滑过后的下一轮 nightly 照常。
    if (opts.auto) {
      let autoHeld = false;
      if (ncfg.weatherHold) {
        const w = weatherHoldCount(repoRoot, ncfg);
        if (w.held) {
          autoHeld = true;
          announceWeatherHold(repoRoot, ncfg, w);
          log('风暴滞留（weather hold）：nightly --auto 本轮跳过派发（high 卡与 drain 均不启动）。');
        }
      }
      if (!autoHeld) {
        const high = highPriorityDraftIds(repoRoot);
        for (const id of high) {
          const r = submitDraft(repoRoot, root, id);
          if (!r.submitted) {
            log(`提案 ${id} 未提交：${r.skipped}`);
            continue;
          }
          log(`\n═══ nightly --auto → ${id}（priority=high）═══`);
          const rr = spawnSync('node', [path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs'), 'run', id, ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
            cwd: repoRoot,
            stdio: 'inherit',
            env: childEnv,
          });
          if (rr.status !== 0) log(`任务 ${id} 退出码 ${rr.status}（已落 blocked/failed/，继续）。`);
        }
        log(`\n═══ nightly --auto → drain --max ${opts.auto} ═══`);
        const r = spawnSync('node', [path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs'), 'drain', '--max', String(opts.auto), ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
          cwd: repoRoot,
          stdio: 'inherit',
          env: childEnv,
        });
        if (r.status !== 0) log(`drain 退出码 ${r.status}。`);
      }
    }
  } catch (e) {
    errMsg = String(e?.message ?? e);
    log(`✗ nightly 异常中断：${errMsg}`);
  } finally {
    releaseSchedulerLock(repoRoot);
  }

  // 4) 收尾摘要 + 早上的人工操作指引
  const awaiting = listCards(root, 'awaiting-human');
  const pending = listCards(root, 'pending');
  // 正常结束才落 finishedAt：异常中断保持「未收尾」态——下次触发按 nightly_recovered
  // 接续重试，不会被 20h 双跑防护误挡（失败的那一晚不该被当成「已经跑过了」）。
  // manual 同样不写（见上方 manual 状态机说明）。
  if (!errMsg && !manual) {
    writeNightlyState(repoRoot, {
      startedAt: nightlyStartedAt,
      finishedAt: new Date().toISOString(),
      result: { created: created.length, awaiting: awaiting.length, pending: pending.length, autoRan: opts.auto ?? 0 },
    });
  }
  log(`\n════════ nightly 摘要 ════════`);
  log(`新提案: ${created.length}${flags.has('--plan') ? `    规划后 drafts 存量: ${planned}` : ''}    待审（awaiting-human）: ${awaiting.length}${awaiting.length ? `（${awaiting.join(', ')}）` : ''}    待调度（pending）: ${pending.length}`);
  if (awaiting.length) log(`人工放行：node .agents/scripts/orchestrator.mjs approve <task-id>`);
  if (pending.length && !opts.auto) log(`推进队列：node .agents/scripts/orchestrator.mjs drain（或下次 nightly --auto）`);
  log(`人工审阅提案：drafts/ 下批量 submit——node .agents/scripts/orchestrator.mjs submit .agents/orchestrator/drafts/<id>.md`);

  // 通知先于退出投递（die 是 process.exit，会截断未决 promise）
  const cfg = loadWorkflowConfig(repoRoot);
  await notify({
    title: `${displayProjectName(cfg.projectName)} nightly`,
    webhookEnvs: nightlyWebhookEnvs(repoRoot),
    body: buildNightlySummary({
      created: created.length,
      proposals: flags.has('--plan') ? planned : 0,
      awaiting: awaiting.length,
      pending: pending.length,
      degraded: Boolean(readDegraded(repoRoot)),
      autoRan: opts.auto ?? 0,
      error: errMsg,
    }),
  });
  if (errMsg) die(`nightly 异常中断：${errMsg}`, 1);
}

/**
 * 瞬时故障 blocked 卡的一次性有痕重探（watch 周期内投机执行）。
 * 资格（缺一不可，全部从事件流判定）：blocked 原因是「worker 异常结束/未产出结果块」型、
 * 最后一条 worker_stderr_tail 命中瞬时故障签名（429/网络，transient.mjs）、本卡从未
 * speculative_resume 过、无 circuit_breaker 事件（熔断卡永不静默重试——红线不变）。
 * 重探是显式动作：speculative_resume 事件先落盘再 spawn resume 子进程。
 */
function speculativeResumes(repoRoot, root, childEnv, opts) {
  const orch = path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs');
  for (const id of listCards(root, 'blocked')) {
    const qdir = logDir(repoRoot, id);
    const events = readEvents(qdir);
    if (!events.length) continue;
    if (events.some((e) => e.type === 'speculative_resume')) continue; // 每卡终身一次
    if (events.some((e) => e.type === 'circuit_breaker')) continue; // 熔断卡永不静默重试
    const lastBlocked = [...events].reverse().find((e) => e.type === 'blocked');
    if (!lastBlocked || !/worker 异常结束|未产出结果块/.test(String(lastBlocked.reason ?? ''))) continue;
    const stderrTail = [...events].reverse().find((e) => e.type === 'worker_stderr_tail')?.text ?? '';
    if (!isTransientWorkerFailure('', stderrTail)) continue; // 非瞬时签名（真 bug/环境缺配置）不碰
    appendEvent(qdir, 'speculative_resume', { reason: 'blocked 疑似瞬时故障（限流/网络），watch 有痕重探一次' });
    log(`↻ ${id}：blocked 疑似瞬时故障——有痕重探一次（speculative_resume 已留痕）。`);
    const r = spawnSync('node', [orch, 'resume', id, ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: childEnv,
    });
    if (r.status !== 0) log(`重探 ${id} 退出码 ${r.status}（仍 blocked 则不再重探）。`);
  }
}

/**
 * watch——连续自治运行（DeepSeek Super-agent「连续/主动」的落地形态）：drain →
 * 队列空时 scan +（autopilot 开时）propose → 休眠 interval → 循环。
 * 停止条件（任一）：stop 文件（touch .agents/orchestrator/.watch-stop）、--max-cycles、
 * drift 降级生效（保险丝不允许自己插回去，恢复后人工重启 watch）、SIGINT。
 * 护栏：调度器锁互斥（与 drain/nightly 同一套）；每周期重读 workflow.json（改配置
 * 即时生效，不用重启 watch）；autopilot 关闭时只 drain 人工提交的卡 + scan 出提案，
 * 不跑 planner 会话、不自动提交——烧钱动作全部需要显式授权。
 */
async function cmdWatch(repoRoot, opts) {
  rotateNightlyLog(repoRoot);
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const lock = acquireSchedulerLock(repoRoot, 'watch');
  if (!lock.held) {
    log(`⏸ 调度器已在运行（pid=${lock.owner.pid}，${lock.owner.cmd ?? ''}）——watch 不并发调度。`);
    return;
  }
  // 配置守卫（B7）：瞭望进程启动即记 workflow.json 基线（每周期派发前校验，见下）
  if (loadWorkflowConfig(repoRoot).configGuard?.enabled !== false) captureConfigBaseline(repoRoot);
  const intervalMin = opts.interval === 0 ? 0 : Number.isInteger(opts.interval) && opts.interval > 0 ? opts.interval : 30; // 0 = 不休眠（仅测试/调试用）
  const maxCycles = Number.isInteger(opts.maxCycles) && opts.maxCycles > 0 ? opts.maxCycles : Infinity;
  const stopFile = path.join(repoRoot, '.agents', 'orchestrator', '.watch-stop');
  const childEnv = { ...process.env, ...childEnvForHeldLock() };
  const orch = path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs');
  let weatherAnnounced = false; // 风暴滞留宣布去重（跨周期只 announce 一次，复位见周期内逻辑）
  log(`════════ watch 开始（interval ${intervalMin} 分钟/周期，max-cycles ${maxCycles === Infinity ? '∞' : maxCycles}）════════`);
  log(`停止：touch .agents/orchestrator/.watch-stop（或 Ctrl-C）；drift 降级自动退出；workflow.json 改动下周期即生效。`);
  let cycle = 0;
  try {
    for (;;) {
      cycle += 1;
      log(`\n──── watch 周期 ${cycle}/${maxCycles === Infinity ? '∞' : maxCycles}  ${new Date().toISOString()} ────`);
      if (fs.existsSync(stopFile)) {
        fs.rmSync(stopFile, { force: true });
        log('检测到 .watch-stop——watch 退出。');
        break;
      }
      const degraded = readDegraded(repoRoot);
      if (degraded) {
        log(`⚠ drift 降级生效（${degraded.reason}）——watch 退出（人工确认后 drift --clear，再重启 watch）。`);
        break;
      }
      // 1) pending 非空 → drain（autopilot.autoDrainPerCycle > 0 时按它设每周期上限）
      const cfg = loadWorkflowConfig(repoRoot); // 每周期重读：改配置即时生效
      // 配置守卫（B7）：workflow.json 漂移期间跳过派发/重探（改配置即时生效的老语义让位
      // 给守卫——被改的授权面不再静默生效；文件改回基线或重启编排器后恢复）
      const configPaused = !configGuardPass(repoRoot, cfg);
      let pending = listCards(root, 'pending');
      const cap = Number.isInteger(cfg.autopilot?.autoDrainPerCycle) && cfg.autopilot.autoDrainPerCycle > 0 ? cfg.autopilot.autoDrainPerCycle : Infinity;
      // 风暴闸（瞭望位先看天）：滞留则本周期不派发（drain/投机重探全跳过），scan/propose
      // 照跑（它们不派 worker）。滞留宣布只一次；某周期窗口滑过即复位，再滞留会重新宣布。
      const weather = cfg.weatherHold ? weatherHoldCount(repoRoot, cfg) : { held: false, count: 0 };
      if (weather.held) {
        if (!weatherAnnounced) {
          weatherAnnounced = true;
          announceWeatherHold(repoRoot, cfg, weather);
        }
        log('风暴滞留生效中：本周期跳过派发（窗口滑过后自动恢复）。');
      } else {
        weatherAnnounced = false;
      }
      if (pending.length) {
        if (!weather.held && !configPaused) {
          const n = Math.min(pending.length, cap);
          log(`pending ${pending.length} 张 → drain --max ${n === Infinity ? '∞' : n}`);
          spawnSync('node', [orch, 'drain', ...(n === Infinity ? [] : ['--max', String(n)]), ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
            cwd: repoRoot,
            stdio: 'inherit',
            env: childEnv,
          });
        }
      } else {
        // 2) 队列空 → 巡检出提案；autopilot 开时再跑 planner 需求综合（白名单卡自动提交）
        spawnSync('node', [orch, 'scan', ...(opts.backend ? ['--backend', opts.backend] : [])], { cwd: repoRoot, stdio: 'inherit', env: childEnv });
        if (cfg.autopilot?.enabled) {
          log(`\n──── watch 周期 ${cycle} → propose（autopilot 需求综合）────`);
          spawnSync('node', [orch, 'propose', ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], { cwd: repoRoot, stdio: 'inherit', env: childEnv });
          // 提案被白名单自动提交后队列非空 → 本周期内立即推进，不等到下一周期
          const submitted = listCards(root, 'pending');
          if (submitted.length && !weather.held && !configPaused) {
            const n = Math.min(submitted.length, cap);
            log(`autopilot 提交 ${submitted.length} 张 → drain --max ${n === Infinity ? '∞' : n}`);
            spawnSync('node', [orch, 'drain', ...(n === Infinity ? [] : ['--max', String(n)]), ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
              cwd: repoRoot,
              stdio: 'inherit',
              env: childEnv,
            });
          }
        }
      }
      // 3) 瞬时故障 blocked 卡的一次性有痕重探（投机执行，资格判定见 speculativeResumes）；
      //    风暴滞留 / 配置守卫漂移期间跳过——重探也是派发
      if (!weather.held && !configPaused) speculativeResumes(repoRoot, root, childEnv, opts);
      if (cycle >= maxCycles) {
        log(`已达 --max-cycles ${maxCycles}，watch 退出。`);
        break;
      }
      // 4) 休眠（分片睡：stop 文件放下周期能及时响应，不必等满 interval；interval=0 跳过）
      if (intervalMin > 0) {
        const deadline = Date.now() + intervalMin * 60_000;
        while (Date.now() < deadline) {
          if (fs.existsSync(stopFile)) break;
          await new Promise((r) => setTimeout(r, Math.min(5000, deadline - Date.now())));
        }
      }
    }
  } finally {
    releaseSchedulerLock(repoRoot);
    log('════════ watch 结束 ════════');
  }
}

/** 自由航行自动提交：对本航次产出的提案逐张过 canSailSubmit 白名单后提交（gate→L1，
 *  实际合并仍由门禁分级裁决）。只碰本航次快照里的新提案——存量 drafts 等人工 submit。 */
function sailAutoSubmit(repoRoot, root, cfg, ids) {
  const submitted = [];
  const skipped = [];
  for (const id of ids) {
    const text = safeRead(path.join(draftsDir(repoRoot), `${id}.md`));
    if (!text) {
      skipped.push({ id, reason: '提案文件不存在' });
      continue;
    }
    let meta;
    try {
      meta = parseCard(text, `${id}.md`).meta;
    } catch (e) {
      skipped.push({ id, reason: `校验未过（${String(e.message).slice(0, 120)}）` });
      continue;
    }
    const verdict = canSailSubmit(meta, cfg);
    if (!verdict.ok) {
      skipped.push({ id, reason: verdict.reason });
      log(`⏸ 自由航行不自动提交 ${id}：${verdict.reason}`);
      continue;
    }
    const r = submitDraft(repoRoot, root, id, { gate: AUTO_SUBMIT_GATE });
    if (r.submitted) {
      submitted.push(r.submitted);
      log(`⛵ 自由航行已提交提案：pending/${r.submitted}.md（gate=${r.gate}，类型 ${meta.type}；实际合并仍由门禁分级裁决）`);
    } else {
      skipped.push({ id, reason: r.skipped ?? '提交失败' });
    }
  }
  return { submitted, skipped };
}

/**
 * sail——自由航行（时间盒完全自治）：船长自勘海况（scan 巡检）→ 自绘航线（propose
 * 产卡，编排理由写在卡上）→ 自航自泊（drain 全门禁闭环）→ 到点收帆交航海报告
 * （logs/sail/<ts>/report.md：完成了什么、为什么这么编排、燃油账几何）。与 watch 的差别：
 * 有硬时长预算、报告收口、自动提交不依赖 autopilot 配置（开 sail 即本航次授权，硬禁区不变：
 * deps/人工草稿/核心·发布路径永不自动；类型白名单 freeSail.autoSubmitTypes）。
 * 停止条件（任一）：到达 --minutes/--duration、.sail-stop 文件、drift 降级、--max-tasks
 * 上限、--max-cost-usd 燃油上限（网关实测价 ≥ 上限即收帆——只停不换引擎，换计费方必须人批）、
 * 连续 3 轮派发无进展。软截止：跑着的任务让它跑完，不在剩余不足时开新派发。
 */
async function cmdSail(repoRoot, opts) {
  const cfg0 = loadWorkflowConfig(repoRoot);
  const minutes = parseDurationMinutes({ minutes: opts.minutes, duration: opts.duration });
  if (!minutes) die('用法：sail --minutes <N>（或 --duration 2h|90m|1h30m|90s）[--max-tasks N] [--max-cost-usd N] [--interval 10]——自由航行时长必须显式指定（分钟或秒级如 90s，>0）。');
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  preflightWorkerBackend(opts.backend ?? cfg0.worker?.backend); // 起航前引擎预检：CLI 不在就别烧规划钱
  const lock = acquireSchedulerLock(repoRoot, 'sail');
  if (!lock.held) {
    log(`⏸ 调度器已在运行（pid=${lock.owner.pid}，${lock.owner.cmd ?? ''}）——sail 不并发调度。`);
    return;
  }
  // 配置守卫（B7）：航程启动即记 workflow.json 基线（每周期派发前校验，见下）。
  // 2026-11 实证动机：sail 派发的卡自改 workflow.json 默认引擎——授权面被被调度方改写。
  if (cfg0.configGuard?.enabled !== false) captureConfigBaseline(repoRoot);
  const startedAt = Date.now();
  const deadline = startedAt + minutes * 60_000;
  const maxTasks = Number.isInteger(opts.maxTasks) && opts.maxTasks > 0 ? opts.maxTasks : Infinity;
  const maxCostUsd = Number.isFinite(opts.maxCostUsd) && opts.maxCostUsd > 0 ? opts.maxCostUsd : null;
  const intervalMin = Number.isInteger(opts.interval) && opts.interval >= 0 ? opts.interval : 10;
  const orch = path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs');
  const childEnv = { ...process.env, ...childEnvForHeldLock() };
  const stopFile = path.join(repoRoot, '.agents', 'orchestrator', SAIL_STOP_FILE);
  const pad2 = (n) => String(n).padStart(2, '0');
  const d0 = new Date(startedAt);
  const tsDir = `${d0.getFullYear()}${pad2(d0.getMonth() + 1)}${pad2(d0.getDate())}-${pad2(d0.getHours())}${pad2(d0.getMinutes())}${pad2(d0.getSeconds())}`;
  const sailDir = path.join(repoRoot, '.agents', 'orchestrator', 'logs', 'sail', tsDir);
  fs.mkdirSync(sailDir, { recursive: true });
  const voyage = {
    projectName: displayProjectName(cfg0.projectName ?? ''),
    root: repoRoot,
    startedAtISO: new Date(startedAt).toISOString(),
    deadlineISO: new Date(deadline).toISOString(),
    minutes,
    maxTasks: maxTasks === Infinity ? null : maxTasks,
    maxCostUsd: maxCostUsd ?? null,
    baseline: snapshotQueue(root),
    cycles: [],
    dispatchedTotal: 0,
  };
  let stopReason = null;
  let noProgress = 0;
  let weatherAnnounced = false;
  let lastCostCheckAt = 0;
  let sigint = false;
  const onSigint = () => { sigint = true; };
  const writeVoyage = () => {
    try { fs.writeFileSync(path.join(sailDir, 'voyage.json'), JSON.stringify(voyage, null, 2)); } catch { /* 留痕失败不阻断航行 */ }
  };
  const remainingMin = () => Math.max(0, Math.round((deadline - Date.now()) / 60_000));
  log(`════════ 自由航行开始（计划 ${minutes} 分钟，至 ${voyage.deadlineISO}；max-tasks ${maxTasks === Infinity ? '∞' : maxTasks}）════════`);
  log(`停止：touch .agents/orchestrator/.sail-stop（或 Ctrl-C）；drift 降级自动退出；报告在 logs/sail/ 下。`);
  appendFleetEvent(repoRoot, 'sail_started', { minutes, deadline: voyage.deadlineISO, maxTasks: voyage.maxTasks });
  process.on('SIGINT', onSigint);
  try {
    for (;;) {
      const cycleNo = voyage.cycles.length + 1;
      if (fs.existsSync(stopFile)) {
        fs.rmSync(stopFile, { force: true });
        stopReason = 'stop 文件（.sail-stop）';
        log('检测到 .sail-stop——自由航行收帆。');
        break;
      }
      if (sigint) {
        stopReason = 'SIGINT（Ctrl-C）';
        log('收到 Ctrl-C——自由航行收帆。');
        break;
      }
      const degraded = readDegraded(repoRoot);
      if (degraded) {
        stopReason = `drift 降级（${degraded.reason}）`;
        log('⚠ drift 降级生效——自由航行收帆（人工 drift --clear 后再启）。');
        break;
      }
      if (Date.now() >= deadline) {
        stopReason = '到达时长上限';
        break;
      }
      if (voyage.dispatchedTotal >= maxTasks) {
        stopReason = `已达 --max-tasks ${maxTasks}`;
        break;
      }
      if (noProgress >= 3) {
        stopReason = `连续 ${noProgress} 轮派发无进展`;
        log(`✗ ${stopReason}（队列可能卡在待引水/解析失败）——收帆。`);
        break;
      }
      const cfg = loadWorkflowConfig(repoRoot); // 每周期重读（watch 同款：改配置即时生效）
      const weather = cfg.weatherHold ? weatherHoldCount(repoRoot, cfg) : { held: false, count: 0 };
      // 配置守卫（B7）：workflow.json 漂移期间跳过派发与规划（同风暴闸语义；改回基线或
      // 重启后恢复）
      const configPaused = !configGuardPass(repoRoot, cfg);
      if (weather.held && !weatherAnnounced) {
        weatherAnnounced = true;
        announceWeatherHold(repoRoot, cfg, weather);
      }
      if (!weather.held) weatherAnnounced = false;
      // 燃油上限（--max-cost-usd）：网关实测价 ≥ 上限即收帆。只停不换引擎——换计费方必须人批
      // （红线）。检查节流 60s（实测要扫网关日志，派发轮高频进圈不能每次全量读盘）。
      if (maxCostUsd != null && Date.now() - lastCostCheckAt >= 60_000) {
        lastCostCheckAt = Date.now();
        const fuelNow = await measureFuel(repoRoot, cfg, { start: startedAt }).catch((e) => ({ measured: false, reason: String(e?.message ?? e) }));
        voyage.fuel = fuelNow;
        writeVoyage();
        if (fuelNow.measured && fuelNow.usd >= maxCostUsd) {
          stopReason = `成本上限 --max-cost-usd ${maxCostUsd}（实测 ${fmtUsd(fuelNow.usd)}）`;
          log(`⛽ ${stopReason}——收帆（只停不换引擎；想继续请人工评估后重开或上调上限）。`);
          try {
            appendFleetEvent(repoRoot, 'sail_cost_cap', { limit_usd: maxCostUsd, usd: fuelNow.usd });
          } catch { /* 留痕失败不阻断收帆 */ }
          break;
        }
      }
      const pending = listCards(root, 'pending');
      // 派发资格：pending 里存在「真正可派发」的卡才进派发轮——引水卡（deps/核心·发布
      // 路径，drain 会跳过等人工确认）与解析失败卡都不算可派发。全不可派时走规划轮，
      // 否则每轮派发空转、触发「连续无进展」熔断提前收帆（首航 2026-11-02 实证：
      // 存量引水卡让 30 分钟航程 12 秒收帆）。逐张判定而非只看最高优先级——drain
      // 单轮内能跳过引水卡继续派后面的卡，混合队列仍有活可干。
      let hasDispatchable = false;
      for (const id of pending) {
        const card = findCard(root, id);
        if (!card) continue;
        try {
          const meta = parseCard(fs.readFileSync(card.path, 'utf8'), id).meta;
          if (!pilotageRequired(meta, cfg)) {
            hasDispatchable = true;
            break;
          }
        } catch { continue; } // 解析失败卡不可派发（drain 同样跳过）
      }
      const cycle = { n: cycleNo, at: new Date().toISOString(), kind: null, dispatched: [], proposals: [], submitted: [], skipped: [], sleepMin: 0 };
      if (hasDispatchable && !weather.held && !configPaused) {
        // 派发轮：一次只派一张——每张之间重新看表（截止/风暴/降级/stop 文件）
        cycle.kind = 'dispatch';
        log(`\n──── sail 周期 ${cycleNo} → drain --max 1（已派 ${voyage.dispatchedTotal}${maxTasks === Infinity ? '' : `/${maxTasks}`}，剩余 ${remainingMin()} 分钟）────`);
        const r = spawnSync('node', [orch, 'drain', '--max', '1', ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
          cwd: repoRoot,
          stdio: 'inherit',
          env: childEnv,
        });
        cycle.drainExit = r.status;
        const after = listCards(root, 'pending');
        cycle.dispatched = pending.filter((id) => !after.includes(id));
        voyage.dispatchedTotal += cycle.dispatched.length;
        noProgress = cycle.dispatched.length ? 0 : noProgress + 1;
        voyage.cycles.push(cycle);
        writeVoyage();
        continue; // 不休眠：立即看表再决定
      }
      // 规划轮：队列空（或风暴滞留/配置守卫漂移）→ 巡检出提案；propose 烧钱——风暴中跳过
      cycle.kind = 'plan';
      const draftsBefore = snapshotDrafts(repoRoot);
      spawnSync('node', [orch, 'scan', ...(opts.backend ? ['--backend', opts.backend] : [])], { cwd: repoRoot, stdio: 'inherit', env: childEnv });
      if (!weather.held && !configPaused) {
        log(`\n──── sail 周期 ${cycleNo} → propose（自由航行规划，剩余 ${remainingMin()} 分钟）────`);
        spawnSync('node', [orch, 'propose', ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], { cwd: repoRoot, stdio: 'inherit', env: childEnv });
        const draftsAfter = snapshotDrafts(repoRoot);
        const known = new Set(draftsBefore.map((d) => d.id));
        cycle.proposals = draftsAfter.filter((d) => !known.has(d.id));
        // 上游管线（2026-11 Plan A）：feature 提案 → 派调研 → spec 落盘待人审；不进队列
        //（bugfix/refactor/docs 照旧 sailAutoSubmit；feature 的提交拒绝理由见 canSailSubmit）
        cycle.upstream = await sailUpstreamPipeline(repoRoot, cfg, cycle.proposals, opts.backend ?? cfg.worker?.backend);
        const sub = sailAutoSubmit(repoRoot, root, cfg, cycle.proposals.map((p) => p.id));
        cycle.submitted = sub.submitted;
        cycle.skipped = sub.skipped;
      } else {
        log(weather.held
          ? '风暴滞留生效中：本周期跳过规划与派发（窗口滑过后自动恢复）。'
          : '配置守卫生效中：本周期跳过规划与派发（文件改回基线或重启编排器后恢复）。');
      }
      voyage.cycles.push(cycle);
      // 休眠：本轮无新卡可派才睡（有提交 → 下一轮直接派发）；分片睡，stop 文件/Ctrl-C/到点即醒
      if (!cycle.submitted.length && Date.now() < deadline && intervalMin > 0) {
        const sleepStart = Date.now();
        const sliceEnd = Math.min(deadline, sleepStart + intervalMin * 60_000);
        while (Date.now() < sliceEnd) {
          if (fs.existsSync(stopFile) || sigint) break;
          await new Promise((r) => setTimeout(r, Math.min(5000, sliceEnd - Date.now())));
        }
        cycle.sleepMin = Math.max(0, Math.round((Math.min(sliceEnd, Date.now()) - sleepStart) / 60_000));
      }
      writeVoyage();
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    releaseSchedulerLock(repoRoot);
    // 收帆：快照差分 → 航海报告（stdout + report.md）→ webhook 通知 → fleet 留痕
    const finishedAt = Date.now();
    voyage.finishedAtISO = new Date(finishedAt).toISOString();
    voyage.actualMinutes = Math.max(0, Math.round((finishedAt - startedAt) / 60_000));
    voyage.stopReason = stopReason;
    voyage.endState = snapshotQueue(root);
    voyage.diff = diffQueueStates(voyage.baseline, voyage.endState);
    voyage.goalsText = readGoals(repoRoot);
    // 燃油账收口：本航次 [startedAt, finishedAt] 网关实测 × 价目（含逐卡拆账）。此前循环内
    // 若成本上限已触发，voyage.fuel 是触达时刻的快照——此处按完整航程重算覆盖（报告口径）。
    try {
      const dispatchedIds = [...new Set((voyage.cycles ?? []).flatMap((c) => c.dispatched ?? []))];
      voyage.fuel = await measureFuel(repoRoot, loadWorkflowConfig(repoRoot), { start: startedAt, end: finishedAt, cardIds: dispatchedIds });
    } catch (e) {
      voyage.fuel = { measured: false, reason: String(e?.message ?? e) };
    }
    const reportPath = path.join(sailDir, 'report.md');
    voyage.reportPath = reportPath;
    writeVoyage();
    const report = buildSailReport(voyage);
    try { fs.writeFileSync(reportPath, report); } catch { /* 报告写盘失败不影响 stdout 投递 */ }
    log(`\n${report}`);
    log(`════════ 自由航行结束（报告：${reportPath}）════════`);
    appendFleetEvent(repoRoot, 'sail_finished', {
      merged: voyage.endState.merged.length,
      awaiting: voyage.endState['awaiting-human'].length,
      blocked: voyage.endState.blocked.length + voyage.endState.failed.length,
      pending: voyage.endState.pending.length,
      dispatched: voyage.dispatchedTotal,
      stopReason,
      report: path.relative(repoRoot, reportPath),
    });
    try {
      await notify({
        title: `${voyage.projectName} 自由航行`,
        body: buildSailSummary(voyage),
        webhookEnvs: nightlyWebhookEnvs(repoRoot),
      });
    } catch { /* 通知失败不阻断收帆 */ }
  }
}

/**
 * release-propose——发版提案（release-please 形态）：自动盘点上个 tag..develop、
 * conventional 前缀推 semver、核对 CHANGELOG 未发布段，产出提案文件。
 * 纯只读仓库；版本号是建议，确认权在人（用户说「发布 vX.Y.Z」后才走 release.md 代理发布）。
 */
function cmdReleasePropose(repoRoot, versionHint) {
  const p = proposeRelease(repoRoot, versionHint ? { versionHint } : {});
  if (p.nothingToRelease) {
    log(`上个 tag ${p.base} 以来无产品侧内容提交（基建不计）、CHANGELOG 也无「未发布」段——没有可发布内容。`);
    return;
  }
  log(`════════ 发版提案 v${p.suggested} ════════`);
  log(`上个已发布 tag: ${p.base}    建议档位: ${p.level}`);
  log(`产品侧信号: feat ${p.counts.feat} / fix ${p.counts.fix} / breaking ${p.counts.breaking}    盘点提交: ${p.product.length + p.infra.length} 条（产品 ${p.product.length} + 基建 ${p.infra.length}）`);
  if (p.counts.breaking > 0 && p.level === 'minor') log('⚠ 存在 breaking 提交，0.x 惯例走 minor——升 1.0 前请人工确认');
  if (p.counts.feat + p.counts.fix === 0) log('⚠ 产品侧无 feat/fix 提交（其余为基建/文档/杂务），是否值得发版请人工裁决');
  if (p.localTaken) log(`✗ v${p.suggested} 本地 tag 已占用——请换版本号`);
  else if (p.remoteTaken === true) log(`✗ v${p.suggested} 远端 tag 已占用——请换版本号`);
  else if (p.remoteTaken === null) log('⚠ 远端 tag 查询失败（离线？）——release-check 会复核');
  log(`提案文件: ${p.proposalPath}`);
  log(`确认后对 agent 说「发布 v${p.suggested}」→ .agents/workflows/release.md 代理发布执行序`);
}

/**
 * schedule——nightly 定时调度注册（macOS launchd / Linux crontab / Windows schtasks，
 * 经 nightly-runner wrapper 绝对路径启动）。install --dry-run 只写 runner 打印计划。
 */
function cmdSchedule(repoRoot, sub, opts) {
  if (sub === 'install') {
    const mode = opts.mode === 'watch' ? 'watch' : opts.mode === 'sail' ? 'sail' : 'nightly';
    if (opts.mode && opts.mode !== mode) die(`未知调度模式：--mode ${opts.mode}（可选 nightly | watch | sail）`);
    const r = installSchedule(repoRoot, {
      mode,
      interval: opts.interval,
      hour: opts.hour,
      minute: opts.minute,
      minutes: opts.minutes,
      duration: opts.duration,
      maxCostUsd: opts.maxCostUsd,
      tests: opts.flags?.has('--tests'),
      auto: opts.auto,
      backend: opts.backend,
      reviewBackend: opts.reviewBackend,
      dryRun: opts.flags?.has('--dry-run'),
    });
    if (r.dryRun) {
      log(`[dry-run] 未触碰系统调度、未写任何文件。计划：`);
      log(`  ${r.plan}`);
      log(`  wrapper 将写入（dry-run 未落盘）: ${r.runner}`);
      for (const line of (r.wrapper ?? '').split('\n')) log(`  | ${line}`);
      return;
    }
    log(
      mode === 'watch'
        ? `watch 调度已安装（每天 ${r.when} 拉起 watch 常驻循环，interval 见 wrapper）。停止：touch .agents/orchestrator/.watch-stop；卸载: node .agents/scripts/orchestrator.mjs schedule uninstall`
        : mode === 'sail'
          ? `sail 调度已安装（每天 ${r.when} 拉起定时自由航行，时长见 wrapper）。停止：touch .agents/orchestrator/.sail-stop；卸载: node .agents/scripts/orchestrator.mjs schedule uninstall`
          : `nightly 调度已安装（每天 ${r.when} 拉起 ${r.runner}）。`
    );
    log(`日志: ${nightlyLogPath(repoRoot)}    卸载: node .agents/scripts/orchestrator.mjs schedule uninstall`);
    return;
  }
  if (sub === 'uninstall') {
    const r = uninstallSchedule(repoRoot);
    log(r.removed ? 'nightly 调度已卸载。' : '未发现已安装的 nightly 调度（无需卸载）。');
    return;
  }
  if (sub === 'status') {
    const s = scheduleStatus(repoRoot);
    log(`nightly 调度: ${s.installed ? `已安装${s.when ? `（${s.when.trim()}）` : ''}` : '未安装'}`);
    log(`wrapper: ${s.runner}${s.runnerReady ? '' : '（缺失——schedule install 生成）'}`);
    if (!s.installed) log('安装: node .agents/scripts/orchestrator.mjs schedule install [--hour 2] [--auto 3]');
    return;
  }
  die('用法：schedule install|uninstall|status [--mode nightly|watch|sail] [--hour 0-23] [--minute 0-59] [--interval 30] [--tests] [--auto N] [--minutes N|--duration 2h] [--dry-run]');
}

/**
 * drill——弃船演习（借鉴清单 B9）：临时港 mock 跑一张合成托运单走完全链，
 * 验证港口闭环自身健康（worktree 创建→门禁→审查→闸门落位）。不烧真钱、不碰真队列。
 * 引擎预检只探 CLI 在场；环境漂移（node 版本、权限墙、脚本残缺）夜里才炸不如演习先炸。
 */
function cmdDrill(repoRoot, opts) {
  if (opts.backend && opts.backend !== 'mock') {
    die('drill 仅用 mock（演习不烧真钱）；真实引擎的健康由 nightly 引擎预检与真实任务把守。');
  }
  log('════════ 弃船演习（drill）：mock 跑一张合成托运单，验证港口闭环自身健康 ════════');
  const r = runDrill(repoRoot, { log });
  log(r.ok ? '════════ 演习通过：港口闭环健康 ════════' : '════════ 演习未通过：闭环有环节失灵，见上方 ✗ 项 ════════');
  if (!r.ok) die('演习未通过', 1);
}

// ---------------------------------------------------------------------------
// CLI 分发
// ---------------------------------------------------------------------------

function usage() {
  console.log(`orchestrator.mjs ${SCRIPT_VERSION} — 自治编排（任务卡进、合并出）
用法：node .agents/scripts/orchestrator.mjs <cmd> [args]

  submit <card.md>                        校验任务卡并提交到 pending/
  run <task-id|—next> [--backend mock] [--review-backend <name|same>]
                                          启动单任务闭环（--next 自动取最高优先级 pending；审查后端缺省自动异构互审）
  drain [--max N] [--workers N] [--backend mock] [--review-backend …]
                                          清空 pending 队列（--workers N 并发跑，按 files_hint 分区互斥）
  status [task-id]                        队列全貌 / 单任务事件时间线
  intent "<一句话描述>" [--draft] [--backend mock]  Planner 把意图编译成任务卡（--draft 只出草稿不进队列）
  spec "<一句话描述特性>" [--from-brief <brief-id[,id2…]>] [--backend mock]
                                          规格驱动（Spec Kit/Kiro 式）：Planner 出 requirements/design/tasks 三件套，人工审阅后再拆卡；--from-brief 把调研 brief 结论注入设计
  spec build <id>                           把已审阅规格的 tasks 拆成任务卡进 pending/（design 全文注入卡背景；幂等）
  spec list / spec show <id>                浏览规格目录 / 单规格任务概要
  spec status <id>                          规格全局进度锚（progress.json，跨夜断点视图）
  research "<调研问题>" [--min-citations N] [--model <模型名>] [--backend mock]
                                          上游调研：researcher 只读+联网会话产出带引用 brief（research/<id>/brief.md + sources/ 快照）——feature 提案与 spec --from-brief 消费；无引用即拒收
  research --selftest                     实测当前后端 WebFetch/WebSearch 可用性（非 Anthropic 网关换源后先跑一次；烧少量 token）
  research multi "<主题>" --dim "<维度1>" --dim "<维度2>" … [--model <模型名>] [--backend mock]
                                          多维调研（维度 ≥2，上限 research.maxDims 缺省 4）：每维派一次 researcher（维度问题 = 主题——维度），brief id 强制 <topic>-d<N>；单维失败隔离不炸批次；落 research/topics/<topic-id>.json（dims 明细 + rollup 最差档聚合，消费方契约见 .agents/docs/research-verdict.md topic 节）
  research verify <brief-id|topic-id> [--backend …] [--model m]
                                          L2 可信度复核：readonly 会话拿 brief+快照判内部一致性（结论是否被引用支撑），合并 L1 落 verdict.json + L3 台账；判出矛盾自动跑联网仲裁轮（upheld 翻案解除否决；research.arbitration=false 关）——落 spec/对外文档前建议跑；topic-id 走逐维复核并重算 topic rollup
  research stats                          L3 可信度台账：按调研船模型聚合核实率与判级分布（信任=统计量）
  scan [--todo] [--audit] [--tests] [--issues] [--ki] [--ci] [--dry-run] [--run]
                                          巡检出提案落 drafts/（人工批量 submit 或 autopilot 白名单自动提交；--run 对 high 提案立即提交并闭环）
  propose [--max N] [--backend mock]      autopilot 需求综合：goals.md + 巡检提案 → planner 高质量提案落 drafts/（白名单卡自动提交）
  drafts gc [--apply]                     提案生命周期清退（dry-run 只列清单；--apply 迁移文件，永不删除）：与 merged 卡 files_hint 重叠的提案迁 drafts/superseded/（带标注），超 draftsGc.archiveDays（缺省 30 天）迁 drafts/archived/
  nightly [--tests] [--plan] [--auto N] [--backend …] [--review-backend …] [--manual]
                                          一次完整巡检编排（scan + drift 报告；--plan 加跑 planner 提案；--auto N 顺带跑 high 提案并 drain——worker 烧钱仅在此档）。--manual 显式人工触发（终端 TTY 跑自动识别），不受 20h 双跑防护限制
  watch [--interval 30] [--max-cycles N] [--backend …] [--review-backend …]
                                          连续自治运行：drain → 队列空时 scan+propose → 休眠循环；stop 文件 .agents/orchestrator/.watch-stop；drift 降级自动退出
  sail --minutes N（或 --duration 2h|90m|1h30m|90s）[--max-tasks N] [--max-cost-usd N] [--interval 10] [--backend …] [--review-backend …]
                                          自由航行：时间盒完全自治——scan 勘察 → propose 规划+自动提交 → drain 执行循环，到点收帆交航海报告（logs/sail/<ts>/report.md：完成了什么、为什么这么编排、燃油账几何）。停止：.sail-stop / drift 降级 / --max-tasks / --max-cost-usd（网关实测价达上限即收帆，只停不换引擎）；开 sail 即本航次自动提交授权（deps/人工草稿/核心·发布路径永不自动）
  schedule install|uninstall|status [--mode nightly|watch|sail] [--hour 0-23] [--minute 0-59] [--interval 30] [--tests] [--auto N] [--minutes N|--duration 2h] [--dry-run]
                                          定时调度注册（launchd/crontab/schtasks 经 wrapper 绝对路径启动；--mode watch 注册常驻循环，--mode sail 注册每日定时自由航行）
  release-propose [X.Y.Z]                  发版提案：盘点提交 + semver 定档 + CHANGELOG 草稿（只读仓库；确认后说「发布 vX.Y.Z」）
  drift [--clear]                          质量漂移报告：自动合并回溯失败率超 20% 自动降级全人工（--clear 人工恢复）
  reconcile [task-id] [--fix-states]      用量对账（自报 token vs 网关实测）+ 燃油账（实测 token × 价目 = USD，需 gatewayAdmin）+ 卡状态对账（git 合并现实 vs 队列落位；--fix-states 把「已合并未落位」的卡落位 merged/）
  resume <task-id> [--backend mock]       崩溃任务带恢复上下文续做
  abandon <task-id>                       放弃任务（worktree 清理按 Rescue 手册人工做）
  approve <task-id>                       人工闸门：批准合并（调 feature-branch finish）
  reject <task-id> --reason "..."         人工闸门：驳回（附原因，转 failed/）
  retry <task-id> --note "..."            人工闸门：打回重试（附补充指令）
  logs <task-id>                          打印事件时间线
  follow <task-id> <补充指令>             运行中任务的直通信息通道（写 inbox，会话边界送达 worker；awaiting-human 用 retry --note）
  stats [--days N] [--json] [--cost]      运行度量：每卡 wall/turns/迭代/token 峰值/watchdog/follow-up 聚合（只读）；--cost 加燃油账（网关实测 × 价目，USD）
  drill [--backend mock]                  弃船演习：临时港 mock 跑一张合成托运单，验证闭环自身健康（不烧真钱、不碰真队列）

后端：worker claude-headless | zcode-headless | codex-headless | mock（zcode 桌面版设 ORCH_ZCODE_CLI=<zcode.cjs 绝对路径>；codex 设 ORCH_CODEX_CLI=<codex 绝对路径>，worker 走 workspace-write 沙箱默认禁网——push/publish 物理不可达）。
闸门：worker 引擎 ≠ workflow.json worker.backend 视为切换 CLI，须人工批准（--approve-backend-switch 或 ORCH_APPROVE_BACKEND_SWITCH=1）。
审查：--review-backend 显式指定；缺省自动异构互审（候选 CLI 不可用回落同源并记 review_backend_fallback 事件）。
互斥：调度器级（drain/nightly/scan --run 全局单实例）+ 任务级（同任务同时只允许一个 run 闭环，陈锁自动接管）。
红线：发布动作永远人工；端口红线按 workflow.json protectedPorts（配置即生效）；熔断不可关闭。`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opts = {
    backend: undefined, // 缺省沿用上次会话后端；首次运行回落 claude-headless
    interactive: process.stdin.isTTY && !process.env.CI,
  };
  const args = [];
  const flags = new Set();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--backend') opts.backend = argv[++i];
    else if (a === '--worker-backend') opts.workerBackend = argv[++i]; // 显式 worker 引擎（优先于 --backend 的整体指定）
    else if (a === '--worker-model') opts.workerModel = argv[++i];
    else if (a === '--review-backend') opts.reviewBackend = argv[++i];
    else if (a === '--review-model') opts.reviewModel = argv[++i];
    else if (a === '--reason' || a === '--note') opts[a.slice(2)] = argv[++i];
    else if (a === '--max') opts.max = parseInt(argv[++i], 10);
    else if (a === '--workers') opts.workers = parseInt(argv[++i], 10);
    else if (a === '--hour') opts.hour = parseInt(argv[++i], 10);
    else if (a === '--minute') opts.minute = parseInt(argv[++i], 10);
    else if (a === '--auto') opts.auto = parseInt(argv[++i], 10);
    else if (a === '--days') opts.days = parseInt(argv[++i], 10);
    else if (a === '--interval') opts.interval = parseInt(argv[++i], 10);
    else if (a === '--max-cycles') opts.maxCycles = parseInt(argv[++i], 10);
    else if (a === '--minutes') opts.minutes = parseInt(argv[++i], 10);
    else if (a === '--duration') opts.duration = argv[++i];
    else if (a === '--max-tasks') opts.maxTasks = parseInt(argv[++i], 10);
    else if (a === '--max-cost-usd') opts.maxCostUsd = parseFloat(argv[++i]);
    else if (a === '--from-brief') opts.fromBrief = argv[++i];
    else if (a === '--min-citations') opts.minCitations = parseInt(argv[++i], 10);
    else if (a === '--dim') (opts.dims ??= []).push(argv[++i]); // research multi：可重复，每维一项
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a.startsWith('--')) flags.add(a);
    else args.push(a);
  }
  opts.flags = flags;

  if (cmd === '--help' || cmd === 'help' || !cmd) {
    usage();
    return;
  }
  const repoRoot = findRepoRoot();
  switch (cmd) {
    case 'submit':
      if (!args[0]) die('用法：submit <card.md>');
      return cmdSubmit(repoRoot, args[0]);
    case 'run':
      if (!args[0] && !flags.has('--next')) die('用法：run <task-id|--next> [--backend mock]');
      if (flags.has('--next')) {
        // 自动调度：取最高优先级 pending 任务（docs 10.3）；一次仍只跑一个（多 worker 并行是 Phase 3）
        const root = queueRoot(repoRoot);
        ensureQueue(root);
        const next = pickNextCard(root);
        if (!next) {
          log('队列空：pending/ 中没有可调度的任务。');
          return;
        }
        log(`调度下一个任务：${next.id}（priority=${next.meta.priority}）`);
        return cmdRun(repoRoot, next.id, opts);
      }
      return cmdRun(repoRoot, args[0], opts);
    case 'drain':
      return cmdDrain(repoRoot, opts);
    case 'intent':
      opts.intent = args;
      return cmdIntent(repoRoot, opts);
    case 'spec': {
      const sub = args[0];
      if (sub === 'build') {
        if (!args[1]) die('用法：spec build <spec-id>');
        return cmdSpecBuild(repoRoot, args[1]);
      }
      if (sub === 'list') return cmdSpecList(repoRoot);
      if (sub === 'show') {
        if (!args[1]) die('用法：spec show <spec-id>');
        return cmdSpecShow(repoRoot, args[1]);
      }
      if (sub === 'status') {
        if (!args[1]) die('用法：spec status <spec-id>');
        return cmdSpecStatus(repoRoot, args[1]);
      }
      opts.intent = args;
      return cmdSpecStart(repoRoot, opts);
    }
    case 'propose':
      return cmdPropose(repoRoot, opts);
    case 'research':
      if (args[0] === 'multi') return cmdResearchMulti(repoRoot, args.slice(1).join(' ').trim(), opts);
      if (args[0] === 'verify') {
        if (!args[1]) die('用法：research verify <brief-id|topic-id> [--backend <复核船>] [--model <名>]——L2 异构复核（readonly，落 verdict.json + 台账；topic-id 走逐维复核 + rollup 重算）');
        return cmdResearchVerify(repoRoot, args[1], opts);
      }
      if (args[0] === 'stats') return cmdResearchStats(repoRoot);
      opts.intent = args;
      return cmdResearch(repoRoot, opts);
    case 'drafts':
      if (args[0] !== 'gc') die('用法：drafts gc [--apply]（dry-run 缺省只列清单）');
      return cmdDraftsGc(repoRoot, opts);
    case 'scan':
      return cmdScan(repoRoot, opts);
    case 'nightly':
      return cmdNightly(repoRoot, opts);
    case 'watch':
      return cmdWatch(repoRoot, opts);
    case 'sail':
      return cmdSail(repoRoot, opts);
    case 'schedule':
      return cmdSchedule(repoRoot, args[0], opts);
    case 'release-propose':
      return cmdReleasePropose(repoRoot, args[0]);
    case 'drift':
      return cmdDrift(repoRoot, opts);
    case 'reconcile':
      return cmdReconcile(repoRoot, args[0], opts);
    case 'status':
      return cmdStatus(repoRoot, args[0]);
    case 'resume':
      if (!args[0]) die('用法：resume <task-id>');
      return cmdResume(repoRoot, args[0], opts);
    case 'abandon':
      if (!args[0]) die('用法：abandon <task-id>');
      return cmdAbandon(repoRoot, args[0]);
    case 'approve':
      if (!args[0]) die('用法：approve <task-id>');
      {
        ensureQueue(queueRoot(repoRoot));
        const found = findCard(queueRoot(repoRoot), args[0]);
        if (!found) die(`任务 "${args[0]}" 不在队列中。`);
        if (found.state !== 'awaiting-human') die(`任务 "${args[0]}" 状态为 ${found.state}，只有 awaiting-human 可 approve。`);
        await doApprove(repoRoot, args[0], queueRoot(repoRoot), logDir(repoRoot, args[0]));
      }
      return;
    case 'reject':
      if (!args[0]) die('用法：reject <task-id> --reason "..."');
      {
        ensureQueue(queueRoot(repoRoot));
        const root = queueRoot(repoRoot);
        const found = findCard(root, args[0]);
        if (!found) die(`任务 "${args[0]}" 不在队列中。`);
        if (found.state !== 'awaiting-human') die(`任务 "${args[0]}" 状态为 ${found.state}，只有 awaiting-human 可 reject。`);
        await doReject(repoRoot, args[0], root, logDir(repoRoot, args[0]), opts.reason ?? '');
      }
      return;
    case 'retry':
      if (!args[0]) die('用法：retry <task-id> --note "..."');
      {
        ensureQueue(queueRoot(repoRoot));
        const root = queueRoot(repoRoot);
        const found = findCard(root, args[0]);
        if (!found) die(`任务 "${args[0]}" 不在队列中。`);
        if (found.state !== 'awaiting-human') die(`任务 "${args[0]}" 状态为 ${found.state}，只有 awaiting-human 可 retry。`);
        await doRetry(repoRoot, args[0], root, logDir(repoRoot, args[0]), opts.note ?? '', { backend: opts.backend, reviewBackend: opts.reviewBackend });
      }
      return;
    case 'logs':
      if (!args[0]) die('用法：logs <task-id>');
      return cmdLogs(repoRoot, args[0]);
    case 'follow':
      if (!args[0]) die('用法：follow <task-id> <补充指令文本>');
      return cmdFollow(repoRoot, args[0], args.slice(1).join(' '));
    case 'stats':
      return cmdStats(repoRoot, opts);
    case 'drill':
      return cmdDrill(repoRoot, opts);
    default:
      usage();
      die(`未知命令 "${cmd}"`, 1);
  }
}

main().catch((e) => {
  die(e?.stack ?? String(e));
});

#!/usr/bin/env node
// orchestrator.mjs — 自治编排服务（Phase 1：单任务闭环）。
// "任务卡进、合并出"：submit 任务卡 → run 自动跑 worker→静态门禁→调试子循环
// →LLM 独立审查→审查返工子循环→人工合并闸门。设计文档：docs/design-orchestrator.md。
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
} from './orchestrator/queue.mjs';
import { appendEvent, readEvents, logDir, formatTimeline } from './orchestrator/events.mjs';
import { buildWorkerPrompt, buildReviewerPrompt, buildFixupPrompt, parseResultBlock, parseReviewVerdict, buildPlannerPrompt, parseCardBlock, buildSpecPrompt, parseSpecBlocks, sanitizeIntent, CARD_MARKER } from './orchestrator/prompt.mjs';
import { gateNpmTest, gateTscBuild, gateLint, gateTypecheck, gatePortScan, gateNativeScan, gateScopePurity, gateCliEntry, gateUiCheck, changedFiles, GateError } from './orchestrator/gates.mjs';
import { getBackend, resolveBackendName, resolveReviewBackendName, writeWorkerSettings, claudeAvailable } from './orchestrator/backends/claude-headless.mjs';
import { zcodeAvailable } from './orchestrator/backends/zcode-headless.mjs';
import { isTransientWorkerFailure } from './orchestrator/transient.mjs';
import { pickAutoResumeCandidates, scanBlockedCards, withAutoResumedAt, autoResumedAtNow } from './orchestrator/autoresume.mjs';
import { isAlive, killTree } from './orchestrator/kill-tree.mjs';
import { classifyChange, hintsOverlap } from './policy.mjs';
import { loadWorkflowConfig, displayProjectName } from './workflow-config.mjs';
import { runScan } from './orchestrator/scan.mjs';
import { installWorkspaceDeps as installWorkspaceDepsImpl } from './orchestrator/deps.mjs';
import { readDegraded, evaluateDrift, clearDegraded } from './orchestrator/drift.mjs';
import { gatewayLogsDir, reconcileTask, reconcileAll, reconcileCardStates } from './orchestrator/reconcile.mjs';
import { watchdogCheck, createWatchdogState, makeWatchdogSpawnFn, watchdogTimelineSummary } from './orchestrator/watchdog.mjs';
import { writeDecisionTrace } from './orchestrator/trace.mjs';
import { proposeRelease } from './orchestrator/release-propose.mjs';
import { installSchedule, uninstallSchedule, scheduleStatus, nightlyLogPath } from './orchestrator/schedule.mjs';
import { readNightlyState, writeNightlyState, decideNightlyStart } from './orchestrator/nightly-state.mjs';
import { writeSpec, readSpec, listSpecs, buildSpecCards, parseTasksDoc, readProgress } from './orchestrator/spec.mjs';
import { acquireSchedulerLock, releaseSchedulerLock, childEnvForHeldLock } from './orchestrator/run-lock.mjs';
import { acquireTaskLock, releaseTaskLock, readTaskLock, taskLockPath } from './orchestrator/task-lock.mjs';
import { notify, buildNightlySummary, buildSettleSummary, nightlyWebhookEnvs, orchWebhookEnvs } from './orchestrator/notify.mjs';
import { resolveTier, tierEnvPatch, validateTierModel } from './orchestrator/tiers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_VERSION = 'phase1';

/** worker 瞬时故障（429 限流/网络抖动）原地重试上限；退避 60s×attempt（与 orchestrate 技能「429 退避 60s」口径一致）。 */
const MAX_WORKER_RETRIES = 3;

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

/**
 * 卡片落位通知（awaiting-human/blocked/failed）：夜跑无人值守时手机可收。
 * 尽力而为——webhook 未配置时零开销，通道失败静默，绝不影响编排本身。
 */
async function settleNotify(repoRoot, taskId, state, reason) {
  try {
    const cfg = loadWorkflowConfig(repoRoot);
    await notify({
      title: `${displayProjectName(cfg.projectName ?? '')} 编排任务`,
      body: buildSettleSummary({ taskId, state, reason }),
      webhookEnvs: orchWebhookEnvs(repoRoot),
    });
  } catch { /* 通知失败不阻断编排 */ }
}

// ---------------------------------------------------------------------------
// 事件与预算
// ---------------------------------------------------------------------------

class Budget {
  constructor(card, emit) {
    this.maxTokens = card.meta.budget.max_tokens;
    this.maxWallMs = card.meta.budget.max_wall_minutes * 60_000;
    this.emit = emit;
    this.committed = 0; // 已完结 worker 会话的用量合计
    this.sessionMax = 0; // 当前会话内峰值（stream-json 的 usage 是会话累计值）
    this.tokens = 0; // committed + sessionMax，只读视图
    this.started = Date.now();
    this.tripReason = null;
    this.wallTimer = setTimeout(() => this.trip('max_wall_minutes', `${card.meta.budget.max_wall_minutes} 分钟 wall-clock 到期`), this.maxWallMs);
    this.wallTimer.unref?.();
  }

  /** 新 worker 会话开始：上一会话用量入账 committed（原实现用全局 Math.max，
   *  fixup 多会话互相覆盖漏计——实测 300k+100k 两会话只记 300k）。 */
  beginSession() {
    this.committed += this.sessionMax;
    this.sessionMax = 0;
    this.tokens = this.committed;
  }

  account(tokensIn, tokensOut) {
    this.sessionMax = Math.max(this.sessionMax, tokensIn + tokensOut);
    this.tokens = this.committed + this.sessionMax;
    if (this.tokens > this.maxTokens) this.trip('max_tokens', `累计 ${this.tokens} / 上限 ${this.maxTokens} tokens`);
  }

  trip(reason, detail) {
    if (!this.tripReason) {
      this.tripReason = { reason, detail };
      clearTimeout(this.wallTimer);
      // 看门狗：trip 即杀当前在跑的 worker/reviewer 进程树——熔断只在 spawn
      // 返回后检查，而 spawn 只有进程退出才 resolve（zcode 无 max-turns、网络
      // 挂死时 claude 也可能长时间不返回）；不主动杀，wall-clock 熔断形同虚设。
      this.onTrip?.();
    }
  }

  get tripped() {
    return this.tripReason !== null;
  }
}

function cleanupOrphanWorker(repoRoot, taskId) {
  // 崩溃恢复：running/ 卡片若记录的 worker PID 仍存活（孤儿），先杀整棵进程树
  const events = readEvents(logDir(repoRoot, taskId));
  const spawned = [...events].reverse().find((e) => e.type === 'worker_spawned');
  if (spawned?.pid && isAlive(spawned.pid)) {
    log(`发现孤儿 worker（pid=${spawned.pid}）仍在运行，先终止进程树再恢复。`);
    killTree(spawned.pid);
    return true;
  }
  return false;
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

async function cmdRun(repoRoot, taskId, opts) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const cfg = runConfig(repoRoot); // repoRoot 锚定：临时仓库（集成测试）用它们自己的 workflow.json
  const baseBranch = cfg.baseBranch || 'develop';
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
      + `  等当前 run 结束后再操作；确认进程已卡死时，终止 pid ${owner.pid} 后重试（陈锁自动接管）。`);
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
  if (cfg.worker?.backend && opts.backend !== cfg.worker.backend
      && !opts.flags?.has('--approve-backend-switch') && process.env.ORCH_APPROVE_BACKEND_SWITCH !== '1') {
    die(`执行引擎 ${opts.backend} ≠ workflow.json worker.backend（${cfg.worker.backend}）：切换 CLI 需人工审核。\n`
      + `确认切换：本命令追加 --approve-backend-switch（或设环境 ORCH_APPROVE_BACKEND_SWITCH=1）；\n`
      + `不切换：修复原引擎的启动环境（如设 ORCH_ZCODE_CLI、GLM 429 退避并降并发）后重跑；任务卡未动。`);
  }
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
  // 卡显式 tier > files_hint 命中核心/发布路径自动升 heavy > 无（保持全局默认路由）。
  // 凭据经 tokenEnv 环境变量注入（token 不入库）；显式点名但未配置 → 告警降级，
  // 自动升级但 token 未设 → 静默跳过（高频路径，告警会淹日志）。
  const tier = resolveTier(meta, cfg);
  if (meta.tier && tier?.inactive === 'unconfigured') {
    log(`⚠ tier "${meta.tier}" 未生效：workflow.json 未配置该 tiers 键——按全局默认路由执行`);
  } else if (meta.tier && tier?.inactive === 'token') {
    log(`⚠ tier "${meta.tier}" 未生效：环境变量 ${tier.tokenEnv} 未设——按全局默认路由执行`);
  } else if (tier?.token) {
    log(`任务等级：${tier.name}${tier.auto ? '（files_hint 命中核心/发布路径自动升级）' : ''}（token 来自 ${tier.tokenEnv}）`);
  }
  // 模型生效优先级：CLI 单次覆盖 > tier 配置 > workflow.json 全局默认
  const effWorkerModel = opts.workerModel ?? tier?.workerModel ?? workerModel;
  const effReviewModel = opts.reviewModel ?? tier?.reviewModel ?? reviewModel;
  if (tier?.token && (effWorkerModel !== workerModel || effReviewModel !== reviewModel)) {
    log(`tier 模型：执行 ${effWorkerModel ?? '（默认）'} / 审查 ${effReviewModel ?? '（默认）'}`);
  }
  appendEvent(qdir, 'tier_resolved', {
    tier: tier?.name ?? (meta.tier ?? null),
    ...(tier?.auto ? { auto: true } : {}),
    ...(tier?.inactive ? { inactive: tier.inactive } : {}),
    ...(tier?.token && tier.provider ? { provider: tier.provider } : {}),
    ...(effWorkerModel ? { worker_model: effWorkerModel } : {}),
    ...(effReviewModel ? { review_model: effReviewModel } : {}),
  });
  // 目录校验（advisory）：模型名不在服务目录 → 告警不阻断，上游/网关报错为准
  if (tier?.token && tier.provider && (effWorkerModel || effReviewModel)) {
    const v = await validateTierModel({
      gatewayBase: tier.gatewayBase,
      token: tier.token,
      provider: tier.provider,
      models: [effWorkerModel, effReviewModel],
    });
    if (!v.ok) log(`⚠ tier 目录校验：${v.reason}${v.missing?.length ? `（${v.missing.join(', ')}）` : ''}——继续派发，留意网关模型报错`);
  }
  const tierEnv = tierEnvPatch(tier);

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

  const backend = await getBackend(opts.backend);
  const ctx = {
    repoRoot,
    worktreePath: worktree,
    playbooksDir: path.join(repoRoot, '.agents', 'workflows'),
  };

  const events = readEvents(qdir);
  let debugIter = debugIterations(events);
  let reviewIter = reviewIterations(events);
  const budget = new Budget(card, () => {});
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
        await settleNotify(repoRoot, taskId, 'blocked', '看门狗判定任务空转（actuate 连续 2 次）');
        die('进展看门狗（actuate）连续 2 次判定无实质进展，任务转 blocked/，人工决策后再继续。');
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
      // 崩溃恢复：把 events 时间线摘要 + NOTES.md 现场注入，worker 从断点续起
      const notes = safeRead(path.join(worktree, 'NOTES.md'));
      promptText +=
        `\n\n---\n\n# 恢复上下文（上次运行中断）\n\n` +
        `上次运行在中途被中断。以下是事件时间线与 worktree 现场笔记，请先核对已完成部分，再继续未完成的部分（不要重做已完成的工作）：\n\n` +
        `## 事件时间线（尾部）\n${formatTimeline(events.slice(-12))}\n\n` +
        `## worktree NOTES.md 现场\n${notes || '（空——请先补全 NOTES.md 再继续）'}\n`;
    }

    for (;;) {
      // ---- worker 会话（含 fixup 返工循环；瞬时故障原地退避重试，见 retry 处注释）----
      let result;
      let workerOutput = '';
      let transientAttempt = 0;
      for (;;) {
        budget.beginSession(); // 上会话用量入账 committed，本会话从零峰值起算
        appendEvent(qdir, 'budget_baseline', { tokens_in: budget.tokens });
        workerSessionSeq += 1; // 看门狗：会话代次（重试/fixup 均翻篇，在途结论随之作废）
        workerInFlight = true; // 看门狗：spawn 在跑标记
        {
          fs.writeFileSync(promptFile, promptText);
          if (opts.backend === 'claude-headless') writeWorkerSettings(settingsFile, tierEnv);
          appendEvent(qdir, 'worker_spawned', { backend: opts.backend, attempt: debugIter + reviewIter, ...(effWorkerModel ? { model: effWorkerModel } : {}) });
          if (fastlaneWanted) appendEvent(qdir, 'fastlane_active', { gate: meta.gate });
          result = await backend.spawn({
            promptFile,
            cwd: worktree,
            maxTurns: meta.budget.max_turns,
            onEvent: (e) => {
              appendEvent(qdir, e.type, e);
              trackPid(e);
              if (e.type === 'budget_snapshot') budget.account(e.tokens_in, e.tokens_out);
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
          if (budget.tripped) {
            killTree(result.pid);
            appendEvent(qdir, 'circuit_breaker', { reason: budget.tripReason.reason, detail: budget.tripReason.detail });
            moveCard(root, taskId, 'running', 'blocked');
            appendEvent(qdir, 'blocked', { reason: `budget:${budget.tripReason.reason}` });
            await settleNotify(repoRoot, taskId, 'blocked', `预算熔断 ${budget.tripReason.reason}`);
            die(`预算熔断：${budget.tripReason.reason}（${budget.tripReason.detail}）。任务已转 blocked/，人工决策后再继续。`);
          }
        }
        // 自报不可信：先解析契约块。异常结束（无结果块）且输出带瞬时故障签名
        // （429 限流/网络抖动——headless 引擎与交互会话共享配额，夜跑 16 次「未产出
        // 结果块」大头是它）→ 原地退避重试同一 prompt（60s×attempt，≤3 次，事件留痕），
        // worktree 半成品改动就地续用；签名不匹配或自报 stuck → 走既有 blocked 路径。
        const preClaimed = parseResultBlock(workerOutput);
        if (!preClaimed && isTransientWorkerFailure(workerOutput, result.stderrTail) && transientAttempt < MAX_WORKER_RETRIES) {
          transientAttempt += 1;
          const waitS = 60 * transientAttempt;
          appendEvent(qdir, 'worker_retry', { attempt: transientAttempt, max: MAX_WORKER_RETRIES, wait_s: waitS });
          log(`⚠ worker 疑似瞬时故障（限流/网络）——${waitS}s 后原地重试（${transientAttempt}/${MAX_WORKER_RETRIES}）`);
          await new Promise((r) => setTimeout(r, waitS * 1000));
          continue;
        }
        break;
      }

      // ---- 自报不可信：先解析契约块，再亲自跑门禁 ----
      const claimed = parseResultBlock(workerOutput);
      if (!claimed || claimed.status !== 'done') {
        appendEvent(qdir, 'blocked', { reason: claimed?.status === 'stuck' ? 'worker 自报 stuck' : '未产出结果块（worker 异常结束）' });
        moveCard(root, taskId, 'running', 'blocked');
        await settleNotify(repoRoot, taskId, 'blocked', claimed?.status === 'stuck' ? 'worker 自报 stuck' : 'worker 异常结束（无结果块）');
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
            const r = g.run();
            appendEvent(qdir, 'gate_result', { gate: g.gate, result: 'pass', ...(g.passExtra ? g.passExtra(r) : {}) });
          } catch (e) {
            if (!(e instanceof GateError)) throw e;
            appendEvent(qdir, 'gate_result', { gate: g.gate, result: 'fail' });
            debugIter += 1;
            appendEvent(qdir, 'debug_iteration', { attempt: debugIter, trigger: g.trigger, max: meta.budget.max_test_iterations });
            if (debugIter > meta.budget.max_test_iterations) {
              appendEvent(qdir, 'circuit_breaker', { reason: 'max_test_iterations', detail: `${debugIter}/${meta.budget.max_test_iterations}` });
              moveCard(root, taskId, 'running', 'blocked');
              await settleNotify(repoRoot, taskId, 'blocked', `调试子循环超限（${debugIter} 次${g.dieLabel ? `，${g.dieLabel}` : ''}）`);
              die(`调试子循环超限（${debugIter} 次${g.dieLabel ? `，${g.dieLabel}` : ''}）。${g.dieTail}`);
            }
            return { trigger: g.trigger, output: e.output };
          }
        }
        return null;
      };
      const STATIC_GATES = [
        {
          gate: 'npm_test',
          run: () => gateNpmTest(worktree, cfg.testCmd.join(' && ')),
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
            return { duration_ms: r.durationMs, ...(gateHead ? { head: gateHead } : {}) };
          },
        },
        {
          gate: 'tsc_build',
          run: () => gateTscBuild(worktree, cfg.buildCmd), // buildCmd 未配置 → 直接 skipped 返回，不进调试循环
          trigger: 'build_failure',
          dieLabel: 'build 不过',
          dieTail: '任务转 blocked/，人工接手。',
          passExtra: (r) => (r.skipped ? { skipped: true } : {}),
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
      if (fixup) {
        promptText = buildFixupPrompt(card, ctx, fixup.trigger, fixup.output, debugIter);
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
        await settleNotify(repoRoot, taskId, 'failed', '红线门禁 port_scan 未通过（不可调试）');
        die(`红线门禁 port_scan 未通过：${e.message}\n红线不可调试，任务转 failed/。`);
      }
      try {
        const nativeResult = gateNativeScan(worktree, baseBranch, cfg.packageManager);
        appendEvent(qdir, 'gate_result', { gate: 'native_scan', result: 'pass', ...(nativeResult.skipped ? { skipped: true } : {}) });
      } catch (e) {
        if (!(e instanceof GateError)) throw e;
        appendEvent(qdir, 'gate_result', { gate: 'native_scan', result: 'fail', detail: e.message });
        moveCard(root, taskId, 'running', 'failed');
        appendEvent(qdir, 'failed', { reason: `红线门禁 native_scan：${e.message}` });
        await settleNotify(repoRoot, taskId, 'failed', '红线门禁 native_scan 未通过（不可调试）');
        die(`红线门禁 native_scan 未通过：${e.message}\n红线不可调试，任务转 failed/。`);
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
          promptText = buildFixupPrompt(card, ctx, uiFixup.trigger, uiFixup.output, debugIter);
          continue;
        }
      }

      const purity = gateScopePurity(worktree, meta.files_hint, baseBranch);
      appendEvent(qdir, 'gate_result', {
        gate: 'scope_purity',
        result: 'pass',
        outside: purity.outside.length ? purity.outside : undefined,
      });
      const cliTouched = gateCliEntry(worktree, baseBranch, cfg.corePaths); // 返回被触及的核心路径列表

      // ---- fastlane 决策点：实际改动面说了算（跑前只看声明，这里按真实分级复判）----
      // 分级计算自合并闸门段上移：fastlane 失效判定与合并决策共用同一份结论（reviewer
      // 只读，审查前后改动面不变）。
      const classification = classifyChange(changedFiles(worktree, baseBranch), cfg);
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
          writeWorkerSettings(reviewSettingsFile, tierEnv);
        }
        const review = await reviewBackend.spawn({
          promptFile: reviewPromptFile,
          cwd: worktree, // reviewer 只读，cwd 无关紧要但保持同环境
          maxTurns: cfg.reviewMaxTurns, // workflow.json 可调（缺省 30）
          onEvent: (e) => {
            appendEvent(qdir, e.type, e);
            trackPid(e);
          },
          readonly: true, // 策略守护完整版：allowedTools 收敛为只读（fail-closed）
          model: effReviewModel, // 仅 claude 系生效（--model，分源换模型防同底座共因盲区）
          settingsFile: reviewWantsSettings ? reviewSettingsFile : undefined,
          envPatch: tierEnv,
        });
        livePid = null;
        appendEvent(qdir, 'review_spawned', { backend: opts.reviewBackend, ...(effReviewModel ? { model: effReviewModel } : {}) });
        const verdict = parseReviewVerdict(review.output ?? '');
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
            await settleNotify(repoRoot, taskId, 'blocked', `审查返工超限（${reviewIter} 轮仍有阻塞项）`);
            die(`审查返工超限（${reviewIter} 轮仍有阻塞项）。任务转 blocked/，人工接手。`);
          }
          promptText = buildFixupPrompt(card, ctx, 'review_blockers', review.output ?? '', reviewIter);
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
        appendEvent(qdir, 'budget_snapshot', { tokens_in: budget.tokens, elapsed_min: Math.round((Date.now() - runStarted) / 60000) });
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
      appendEvent(qdir, 'budget_snapshot', { tokens_in: budget.tokens, elapsed_min: Math.round((Date.now() - runStarted) / 60000) });
      return;
    }
  } catch (e) {
    // 异步异常兜底：backend spawn 失败等——卡不得悬在 running/（见 failTaskToBlocked 注释）
    const reason = await failTaskToBlocked(repoRoot, root, qdir, taskId, e);
    if (reason) die(`${reason}\n任务已转 blocked/——修好环境后 resume ${taskId} 续做（events.jsonl 有完整时间线）。`);
    throw e;
  } finally {
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
    await settleNotify(repoRoot, taskId, 'blocked', reason);
    return reason;
  }
  return null;
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
  let r = null;
  let lockConflict = false;
  for (let attempt = 1; ; attempt++) {
    r = spawnSync('node', [fbScript, ...finishArgs], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: finishEnv,
      maxBuffer: 32 * 1024 * 1024,
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
    die(`feature-branch finish 失败（exit ${r.status}）。任务留在 awaiting-human/，处理后重新 approve。`, r.status ?? 1);
  }
  moveCard(root, taskId, 'awaiting-human', 'merged');
  const mergeCommit = execFileSync('git', ['log', '-1', '--format=%H'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  appendEvent(qdir, 'merged', { merge_commit: mergeCommit, ...(source === 'auto' ? { auto: true } : {}) });
  log(`已合并：${mergeCommit.slice(0, 7)}（任务转 merged/${source === 'auto' ? '，自动合并' : ''}）`);
}

async function doReject(repoRoot, taskId, root, qdir, reason) {
  appendEvent(qdir, 'human_gate', { decision: 'rejected', reason });
  moveCard(root, taskId, 'awaiting-human', 'failed');
  appendEvent(qdir, 'failed', { reason: reason || '人工驳回' });
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

function cmdSubmit(repoRoot, cardFile) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const text = safeRead(path.resolve(cardFile));
  if (!text) die(`任务卡文件不存在或为空：${cardFile}`);
  const { meta } = loadCard(text, path.basename(cardFile));
  const existing = findCard(root, meta.id);
  if (existing) die(`任务 id "${meta.id}" 已存在于 ${existing.state}/（同 id 不允许重复提交）。`);
  fs.copyFileSync(path.resolve(cardFile), cardPath(root, 'pending', meta.id));
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
  // 确认卡死时先终止该进程再 abandon（陈锁自动接管，下方的孤儿清理照常生效）。
  const liveLock = readTaskLock(repoRoot, taskId);
  if (liveLock && Number.isInteger(liveLock.pid) && isAlive(liveLock.pid)) {
    die(`任务 "${taskId}" 的闭环仍在运行（pid ${liveLock.pid}${liveLock.cmd ? `，${liveLock.cmd}` : ''}）——abandon 会终止在跑的 worker，先确认它真的卡死。\n`
      + `  终止 pid ${liveLock.pid} 后再 abandon（陈锁自动接管，孤儿 worker 会被清理）。`);
  }
  cleanupOrphanWorker(repoRoot, taskId);
  const qdir = logDir(repoRoot, taskId);
  if (found.state !== 'failed' && found.state !== 'merged') {
    appendEvent(qdir, 'failed', { reason: '人工 abandon（按 worktree-rescue 流程处理）' });
    // abandon 是人工兜底动作：直接落 failed/，不走常规迁移白名单
    fs.renameSync(found.path, cardPath(root, 'failed', taskId));
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
  if (backend === 'claude-headless' && !claudeAvailable()) {
    die('预检失败：claude CLI 不可用（PATH 无 claude / 未登录 / --version 探测失败）。\n'
      + 'drain 拒绝启动。修复后重跑；切换引擎须过人工闸门（--approve-backend-switch）。', 1);
  }
}

function drainTallyLine(tally) {
  return Object.entries(tally).map(([s, n]) => `${s} ${n}`).join('、') || '无';
}

/** drain 收官摘要通知（尽力而为）：夜里 drain 跑完手机可收「N 卡：merged x、awaiting y」。 */
async function drainSummaryNotify(repoRoot, done, tally, note) {
  if (!done) return; // 零消费不吵
  try {
    const cfg = loadWorkflowConfig(repoRoot);
    await notify({
      title: `${displayProjectName(cfg.projectName ?? '')} drain 收官`,
      body: `共 ${done} 卡（${drainTallyLine(tally)}）——${note}`,
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

async function cmdDrain(repoRoot, opts) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const cfg = runConfig(repoRoot);
  // 调度器互斥：drain / nightly / scan --run 同刻只允许一个在跑（run-lock.mjs）。
  // 子进程经 childEnvForHeldLock 豁免（run 不抢锁；被 spawn 的 drain 继承父锁语义）。
  const lock = acquireSchedulerLock(repoRoot, 'drain');
  if (!lock.held) {
    log(`⏸ 调度器已在运行（pid=${lock.owner.pid}，${lock.owner.cmd ?? ''}）——本次退出，不并发调度。`);
    return;
  }
  try {
    const workers = Number.isInteger(opts.workers) && opts.workers > 1 ? opts.workers : 1;
    preflightWorkerBackend(opts.backend ?? cfg.worker?.backend); // mock/未配置引擎跳过（探测函数只认真实 CLI）
    // 选卡前先过一遍 blocked 自动续通道（串行/并发路径共用；引擎预检通过才续，防止坏引擎把卡反复烧）
    autoResumePass(repoRoot, root, cfg, opts);
    if (workers > 1) return await cmdDrainParallel(repoRoot, root, opts, workers);
    const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : Infinity;
    let done = 0;
    let lastTried = null;
    const tally = {};
    for (;;) {
      if (done >= max) {
        log(`已达 --max ${max} 轮上限，停止调度（队列中可能还有任务）。本轮落位：${drainTallyLine(tally)}。`);
        await drainSummaryNotify(repoRoot, done, tally, `已达 --max ${max} 轮上限`);
        return;
      }
      const next = pickNextCard(root);
      if (!next) {
        const stuck = listCards(root, 'pending');
        if (stuck.length) log(`无可调度任务；pending/ 中还有解析失败的卡：${stuck.join(', ')}（请修复 frontmatter 或 abandon）。`);
        else log(`队列已清空：本次 drain 共跑完 ${done} 个任务（${drainTallyLine(tally)}）。`);
        await drainSummaryNotify(repoRoot, done, tally, stuck.length ? '有解析失败的卡待人工修' : '队列已清空');
        return;
      }
      // 死循环防护：run 子进程正常时任务必离开 pending（merged/awaiting-human/blocked/failed）。
      // 连续两轮选中同一任务 = 子进程根本没能处理它（执行环境损坏/脚本缺失），立即停止而不是烧下去。
      if (next.id === lastTried) {
        die(`任务 "${next.id}" 连续两轮仍在 pending——run 子进程未能处理它（检查 repoRoot/.agents/scripts 是否完整、node 是否可用）。已停止 drain 以防空转。`, 1);
      }
      lastTried = next.id;
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
          await settleNotify(repoRoot, next.id, 'blocked', reason);
        }
        continue;
      }
      if (r.status !== 0) log(`任务 ${next.id} 退出码 ${r.status}（已落 blocked/failed/，继续调度下一个）。`);
      const settled = findCard(root, next.id)?.state;
      if (settled) tally[settled] = (tally[settled] ?? 0) + 1;
    }
  } finally {
    releaseSchedulerLock(repoRoot);
  }
}

/**
 * 并发调度（Phase 3，docs 10.6）：--workers N 时最多 N 个 run 子进程同时跑。
 * 分区互斥：新任务与任一在跑任务的 files_hint 相交（hintsOverlap）则跳过，
 * 等占位释放后再试——按文件归属分区派任务的自动化（AGENTS.md 已有人工约定）。
 * 死循环防护改为**每任务重试计数**：同一任务被调度 2 次仍留在 pending 即拉黑并告警
 * （并发下"连续两轮"不再等价于上一次尝试）。
 * 结束条件：无活跃子进程 且 无可调度任务。
 */
function cmdDrainParallel(repoRoot, root, opts, workers) {
  const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : Infinity;
  const active = new Map(); // pid -> { id, hint }
  const retryCount = new Map(); // id -> 调度次数
  const blacklisted = new Set();
  const tally = {};
  let launched = 0;
  let finished = 0;
  let warnedStuck = false;
  let summarySent = false;

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
      if (state) tally[state] = (tally[state] ?? 0) + 1;
      // 终局摘要（尽力而为）：全部发射的子进程已收尾且无后续可调度（或已达 --max 上限）
      const noMore = launched >= max || !listCards(root, 'pending').some((id) => !blacklisted.has(id));
      if (!summarySent && active.size === 0 && finished === launched && noMore) {
        summarySent = true;
        void drainSummaryNotify(repoRoot, finished, tally, launched >= max ? `已达 --max ${max} 轮上限` : '队列已清空');
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
      const candidates = listCards(root, 'pending').filter((id) => !blacklisted.has(id));
      let picked = null;
      for (const id of candidates) {
        if ((retryCount.get(id) ?? 0) >= 2) {
          blacklisted.add(id);
          log(`⚠ 任务 ${id} 两次被调度仍在 pending——run 子进程未能处理它，已跳过（人工检查执行环境后 resume）。`);
          continue;
        }
        try {
          const card = loadCard(fs.readFileSync(cardPath(root, 'pending', id), 'utf8'), `${id}.md`);
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
          const stuck = listCards(root, 'pending');
          if (stuck.length && !warnedStuck) {
            warnedStuck = true;
            log(`无可并行调度的任务（其余卡与在跑任务分区冲突、已拉黑或解析失败）。本次 drain 结束：完成 ${finished} 个。`);
          } else if (!stuck.length) {
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
 * 状态对账（reconcileCardStates）：卡状态 vs git 现实——「已合并未落位」默认只读列出，
 * --fix-states 落位 merged/（状态机被人工旁路的修复）。两节独立，用量对账未启用也照跑。
 */
function cmdReconcile(repoRoot, taskId, opts = {}) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const flags = opts.flags ?? new Set();
  const fmtK = (n) => `${Math.round(n / 100) / 10}k`;
  // 用量对账未启用（workflow.json gatewayLogDir 未配置且无 env 重定向）→ 显式说明，不落到
  // 「尚无已合并任务可对账」的误导输出（任务明明有，是对账没开）
  if (!gatewayLogsDir(loadWorkflowConfig(repoRoot))) {
    log('未启用网关对账：.agents/workflow.json 未配置 gatewayLogDir（网关请求日志目录，支持 ~/ 展开）。配置后重新运行本命令。');
  } else if (taskId) {
    const found = findCard(root, taskId);
    if (!found) die(`任务 "${taskId}" 不在队列中。`);
    log(`任务 ${taskId} 对账（时间窗内经网关转发的成功请求）：`);
    show(reconcileTask(repoRoot, taskId, root));
  } else {
    const all = reconcileAll(repoRoot, root);
    if (!all.length) {
      log('尚无已合并任务可对账。');
    } else {
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
    log(
      `  ${r.taskId.padEnd(24)} 自报 ${fmtK(r.selfTotal)}（in ${fmtK(r.selfReported.tokensIn)} / out ${fmtK(r.selfReported.tokensOut)}）` +
        `  网关实测 ${fmtK(r.gateway.total)}（${r.gateway.requests} 次转发，缓存读 ${fmtK(r.gateway.cacheRead)}）` +
        `  分歧 ${(r.divergence * 100).toFixed(0)}%${r.viaGateway ? '' : '  ⚠ 网关零流量——worker 未走狗粮'}`
    );
  }
}

/**
 * scan——nightly 巡检信号源（Phase 2，docs 10.4）：TODO/FIXME、npm audit、
 * 测试失败 → 消毒后生成任务卡进 pending/。**只生成卡、绝不自动 run**——
 * created_by: scanner 的卡等人工决定（人工闸门是扫描内容注入面的最后一道闸）。
 * nightly 触发由 cron/调度系统调用本命令，不引入常驻进程。
 */
function cmdScan(repoRoot, opts) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const flags = opts.flags ?? new Set();
  const anySignal = ['--todo', '--audit', '--tests', '--issues'].some((f) => flags.has(f));
  const runOpts = {
    todo: !anySignal || flags.has('--todo'),
    audit: !anySignal || flags.has('--audit'),
    tests: flags.has('--tests'), // 要跑测试套件，慢——显式开启
    issues: !anySignal || flags.has('--issues'), // gh best-effort：未安装/非 GitHub 远端 → 警告跳过
    dryRun: flags.has('--dry-run'),
    testCmd: runConfig(repoRoot).testCmd.join(' && '),
  };
  const { created, skipped, warnings } = runScan(repoRoot, runOpts);
  for (const w of warnings) log(`⚠ ${w}`);
  if (runOpts.dryRun) {
    log(created.length ? `将生成 ${created.length} 张任务卡（dry-run 未写入）：` : '无新信号，不生成任务卡。');
    for (const c of created) log(`  ${c}`);
    for (const s of skipped) log(`  [已存在，跳过] ${s}`);
    return;
  }
  for (const c of created) log(`已生成任务卡：pending/${c}.md（等人工决定是否 run）`);
  for (const s of skipped) log(`已存在，跳过：${s}`);
  if (!created.length && !skipped.length && !warnings.length) log('巡检完成：无新信号。');

  // --run：对本次生成的 high 优先级卡立即发起闭环（gate=L3 兜底——合并仍人工，
  // 自动 run 的风险被分级闸门完整兜住）。仅机器信号类（audit/testfail）是 high。
  // 调度器互斥（run-lock.mjs）：抢不到锁只落卡不自动跑，提示人工推进。
  if (flags.has('--run') && created.length) {
    const lock = acquireSchedulerLock(repoRoot, 'scan --run');
    if (!lock.held) {
      log(`⏸ 调度器已在运行（pid=${lock.owner.pid}，${lock.owner.cmd ?? ''}）——卡已生成，本次不自动 run；稍后手动 run/drain。`);
      return;
    }
    try {
      const high = created.filter((c) => !c.startsWith('[dry-run]')).map((c) => c.replace(/^pending\//, ''));
      for (const id of high) {
        const text = safeRead(cardPath(root, 'pending', id));
        if (!/priority:\s*high/.test(text)) continue;
        log(`\n═══ scan --run → ${id}（priority=high）═══`);
        const r = spawnSync('node', [path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs'), 'run', id, ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
          cwd: repoRoot,
          stdio: 'inherit',
          env: { ...process.env, ...childEnvForHeldLock() },
        });
        if (r.status !== 0) log(`任务 ${id} 退出码 ${r.status}（已落 blocked/failed/，继续）。`);
      }
    } finally {
      releaseSchedulerLock(repoRoot);
    }
  }
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
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-planner-')), 'settings.json');
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-intent-')), 'planner-prompt.md');

  try {
    let promptText = buildPlannerPrompt(sanitizeIntent(intentText), repoRoot);
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      fs.writeFileSync(promptFile, promptText);
      if (opts.backend === 'claude-headless') writeWorkerSettings(settingsFile);
      const result = await backend.spawn({
        promptFile,
        cwd: repoRoot, // planner 只读探索主仓库（Read/Glob/Grep 白名单，fail-closed）
        maxTurns: 25,
        onEvent: () => {}, // 无任务事件线；planner 用量不记账
        readonly: true,
        settingsFile,
      });
      const cardText = parseCardBlock(result.output ?? '');
      if (!cardText) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（第 ${attempt} 次输出不含 ${'```'}${CARD_MARKER}${'```'} 契约块）\n请严格按产出契约重新输出：单个 fenced 契约块内含完整任务卡。`;
          continue;
        }
        die(`Planner ${MAX_ATTEMPTS} 次均未产出任务卡契约块。请改用手写任务卡 + submit。`);
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
  if (!intentText) die('用法：spec "<一句话描述特性>" [--backend mock]');
  opts.backend = resolveBackendName(opts, null).name; // 同 intent：缺省回落，防 undefined 直喂 getBackend
  const backend = await getBackend(opts.backend);
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-spec-')), 'settings.json');
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-spec-prompt-')), 'spec-prompt.md');

  try {
    let promptText = buildSpecPrompt(sanitizeIntent(intentText), repoRoot, loadWorkflowConfig(repoRoot).reviewNotes);
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      fs.writeFileSync(promptFile, promptText);
      if (opts.backend === 'claude-headless') writeWorkerSettings(settingsFile);
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
  writeNightlyState(repoRoot, { startedAt: nightlyStartedAt, finishedAt: null });
  log(`════════ nightly 巡检 ${new Date().toISOString()} ════════`);
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const childEnv = { ...process.env, ...childEnvForHeldLock() };
  let created = [];
  let skipped = [];
  let warnings = [];
  let errMsg = null;

  try {
    // 1) 巡检落卡（信号源与 scan 命令默认一致；--tests 显式开启慢路径；issues 为 gh best-effort）
    ({ created, skipped, warnings } = runScan(repoRoot, {
      todo: true,
      audit: true,
      issues: true,
      tests: flags.has('--tests'),
      testCmd: runConfig(repoRoot).testCmd.join(' && '),
    }));
    for (const w of warnings) log(`⚠ ${w}`);
    for (const c of created) log(`已生成任务卡：pending/${c}.md`);
    for (const s of skipped) log(`已存在，跳过：${s}`);
    if (!created.length && !skipped.length && !warnings.length) log('巡检完成：无新信号。');

    // 2) 质量漂移报告
    printDriftReport(repoRoot);

    // 3) --auto N：high 卡先跑（安全信号类），再 drain --max N 推进队列；
    //    worker 由子进程跑（熔断 process.exit 不影响编排进程），单任务 blocked 不阻塞后续
    if (opts.auto) {
      for (const id of created) {
        const text = safeRead(cardPath(root, 'pending', id));
        if (!/priority:\s*high/.test(text)) continue;
        log(`\n═══ nightly --auto → ${id}（priority=high）═══`);
        const r = spawnSync('node', [path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs'), 'run', id, ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
          cwd: repoRoot,
          stdio: 'inherit',
          env: childEnv,
        });
        if (r.status !== 0) log(`任务 ${id} 退出码 ${r.status}（已落 blocked/failed/，继续）。`);
      }
      log(`\n═══ nightly --auto → drain --max ${opts.auto} ═══`);
      const r = spawnSync('node', [path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs'), 'drain', '--max', String(opts.auto), ...(opts.backend ? ['--backend', opts.backend] : []), ...engineArgs(opts)], {
        cwd: repoRoot,
        stdio: 'inherit',
        env: childEnv,
      });
      if (r.status !== 0) log(`drain 退出码 ${r.status}。`);
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
  if (!errMsg) {
    writeNightlyState(repoRoot, {
      startedAt: nightlyStartedAt,
      finishedAt: new Date().toISOString(),
      result: { created: created.length, awaiting: awaiting.length, pending: pending.length, autoRan: opts.auto ?? 0 },
    });
  }
  log(`\n════════ nightly 摘要 ════════`);
  log(`新生成任务卡: ${created.length}    待审（awaiting-human）: ${awaiting.length}${awaiting.length ? `（${awaiting.join(', ')}）` : ''}    待调度（pending）: ${pending.length}`);
  if (awaiting.length) log(`人工放行：node .agents/scripts/orchestrator.mjs approve <task-id>`);
  if (pending.length && !opts.auto) log(`推进队列：node .agents/scripts/orchestrator.mjs drain（或下次 nightly --auto）`);

  // 通知先于退出投递（die 是 process.exit，会截断未决 promise）
  const cfg = loadWorkflowConfig(repoRoot);
  await notify({
    title: `${displayProjectName(cfg.projectName)} nightly`,
    webhookEnvs: nightlyWebhookEnvs(repoRoot),
    body: buildNightlySummary({
      created: created.length,
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
    const r = installSchedule(repoRoot, {
      hour: opts.hour,
      minute: opts.minute,
      tests: opts.flags?.has('--tests'),
      auto: opts.auto,
      backend: opts.backend,
      reviewBackend: opts.reviewBackend,
      dryRun: opts.flags?.has('--dry-run'),
    });
    if (r.dryRun) {
      log(`[dry-run] 未触碰系统调度。计划：`);
      log(`  ${r.plan}`);
      log(`  wrapper 已写入: ${r.runner}`);
      return;
    }
    log(`nightly 调度已安装（每天 ${r.when} 拉起 ${r.runner}）。`);
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
  die('用法：schedule install|uninstall|status [--hour 0-23] [--minute 0-59] [--tests] [--auto N] [--dry-run]');
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
  spec "<一句话描述特性>" [--backend mock]      规格驱动（Spec Kit/Kiro 式）：Planner 出 requirements/design/tasks 三件套，人工审阅后再拆卡
  spec build <id>                           把已审阅规格的 tasks 拆成任务卡进 pending/（design 全文注入卡背景；幂等）
  spec list / spec show <id>                浏览规格目录 / 单规格任务概要
  spec status <id>                          规格全局进度锚（progress.json，跨夜断点视图）
  scan [--todo] [--audit] [--tests] [--issues] [--dry-run] [--run]   巡检生成任务卡（--run 对 high 卡立即发起闭环，合并仍人工）
  nightly [--tests] [--auto N] [--backend …] [--review-backend …] [--manual]
                                          一次完整巡检编排（scan + drift 报告；--auto N 顺带跑 high 卡并 drain——worker 烧钱仅在此档）。
                                          --manual 显式人工触发（终端 TTY 跑自动识别），不受 20h 双跑防护限制
  schedule install|uninstall|status [--hour 0-23] [--minute 0-59] [--tests] [--auto N] [--backend …] [--review-backend …] [--dry-run]
                                          nightly 定时调度注册（launchd/crontab/schtasks 经 wrapper 绝对路径启动）
  release-propose [X.Y.Z]                  发版提案：盘点提交 + semver 定档 + CHANGELOG 草稿（只读仓库；确认后说「发布 vX.Y.Z」）
  drift [--clear]                          质量漂移报告：自动合并回溯失败率超 20% 自动降级全人工（--clear 人工恢复）
  reconcile [task-id] [--fix-states]      用量对账（自报 token vs 网关实测）+ 卡状态对账（git 合并现实 vs 队列落位；--fix-states 把「已合并未落位」的卡落位 merged/）
  resume <task-id> [--backend mock]       崩溃任务带恢复上下文续做
  abandon <task-id>                       放弃任务（worktree 清理按 Rescue 手册人工做）
  approve <task-id>                       人工闸门：批准合并（调 feature-branch finish）
  reject <task-id> --reason "..."         人工闸门：驳回（附原因，转 failed/）
  retry <task-id> --note "..."            人工闸门：打回重试（附补充指令）
  logs <task-id>                          打印事件时间线

后端：worker claude-headless | zcode-headless | mock（zcode 桌面版设 ORCH_ZCODE_CLI=<zcode.cjs 绝对路径>）。
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
    case 'scan':
      return cmdScan(repoRoot, opts);
    case 'nightly':
      return cmdNightly(repoRoot, opts);
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
    default:
      usage();
      die(`未知命令 "${cmd}"`, 1);
  }
}

main().catch((e) => {
  die(e?.stack ?? String(e));
});

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
import { gateNpmTest, gateTscBuild, gatePortScan, gateNativeScan, gateScopePurity, gateCliEntry, gateUiCheck, changedFiles, GateError } from './orchestrator/gates.mjs';
import { getBackend, resolveBackendName, resolveReviewBackendName, writeWorkerSettings } from './orchestrator/backends/claude-headless.mjs';
import { isAlive, killTree } from './orchestrator/kill-tree.mjs';
import { classifyChange, hintsOverlap } from './policy.mjs';
import { loadWorkflowConfig } from './workflow-config.mjs';
import { runScan } from './orchestrator/scan.mjs';
import { readDegraded, evaluateDrift, clearDegraded, DRIFT_THRESHOLD } from './orchestrator/drift.mjs';
import { reconcileTask, reconcileAll } from './orchestrator/reconcile.mjs';
import { proposeRelease } from './orchestrator/release-propose.mjs';
import { installSchedule, uninstallSchedule, scheduleStatus, nightlyLogPath } from './orchestrator/schedule.mjs';
import { writeSpec, readSpec, listSpecs, buildSpecCards, parseTasksDoc } from './orchestrator/spec.mjs';
import { acquireSchedulerLock, releaseSchedulerLock, childEnvForHeldLock } from './orchestrator/run-lock.mjs';
import { notify, buildNightlySummary } from './orchestrator/notify.mjs';
import { resolveTier, tierEnvPatch, validateTierModel } from './orchestrator/tiers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_VERSION = 'phase1';

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

function findRepoRoot() {
  // 与 feature-branch.mjs 同款：git 优先（兼容从 worktree 内调用），回退向上找 .git
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', cwd: process.cwd() }).trim();
  } catch {
    let dir = process.cwd();
    for (;;) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) die('无法定位仓库根（当前目录不在 git 仓库内）。请从主仓库根目录运行 orchestrator。');
      dir = parent;
    }
  }
}

function die(msg, code = 1) {
  console.error(`[orchestrator] ${msg}`);
  process.exit(code);
}

const log = (msg) => console.log(msg);

// ---------------------------------------------------------------------------
// 事件与预算
// ---------------------------------------------------------------------------

class Budget {
  constructor(card, emit) {
    this.maxTokens = card.meta.budget.max_tokens;
    this.maxWallMs = card.meta.budget.max_wall_minutes * 60_000;
    this.emit = emit;
    this.tokens = 0;
    this.started = Date.now();
    this.tripReason = null;
    this.wallTimer = setTimeout(() => this.trip('max_wall_minutes', `${card.meta.budget.max_wall_minutes} 分钟 wall-clock 到期`), this.maxWallMs);
    this.wallTimer.unref?.();
  }

  account(tokensIn, tokensOut) {
    this.tokens = Math.max(this.tokens, tokensIn + tokensOut);
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
  });
  if (r.status !== 0) die(`feature-branch start 失败（exit ${r.status}）`, r.status ?? 1);
  if (!fs.existsSync(wt)) die(`feature-branch start 声称成功但未找到 worktree：${wt}`);
  return wt;
}

/**
 * worktree 依赖准备：全新 checkout 没有 node_modules，worker 的 npm test/build
 * 门禁第一步就会失败，而 npm install 不在 worker 白名单里——环境准备是
 * orchestrator 的职责，不是 worker 的。仅当存在 package-lock.json（可复现的
 * 真实 npm 项目）且缺 node_modules 时才安装；集成测试的轻量临时仓库无 lock，
 * 自动跳过、保持秒级。
 */
function installWorkspaceDeps(worktree, taskId) {
  const pkg = path.join(worktree, 'package.json');
  const lock = path.join(worktree, 'package-lock.json');
  const modules = path.join(worktree, 'node_modules');
  if (!fs.existsSync(pkg) || !fs.existsSync(lock) || fs.existsSync(modules)) return;
  log(`worktree ${taskId} 缺少 node_modules，先安装依赖（package-lock.json 锁定）……`);
  const r = spawnSync('npm', ['ci', '--no-fund', '--no-audit'], { cwd: worktree, stdio: 'inherit' });
  if (r.status !== 0) die(`worktree 依赖安装失败（exit ${r.status}）。请在该 worktree 内手动 npm ci 后重跑 run/resume。`, r.status ?? 1);
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
  if (!['pending', 'running', 'awaiting-human'].includes(found.state)) {
    die(`任务 "${taskId}" 当前状态为 ${found.state}，只能从 pending/running/awaiting-human(retry) 启动。`);
  }
  const { meta, body } = parseCard(fs.readFileSync(found.path, 'utf8'), found.path);
  validateCard(meta); // budget 缺失字段回落默认值（熔断不可关闭）
  const card = { meta, body };
  const qdir = logDir(repoRoot, taskId);

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
  const workerModel = opts.workerModel ?? cfg.worker?.model ?? undefined; // 仅 claude 系 CLI 生效（--model）

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

  const resuming = found.state === 'running';
  if (resuming) cleanupOrphanWorker(repoRoot, taskId);
  if (found.state === 'pending') {
    moveCard(root, taskId, 'pending', 'running');
    appendEvent(qdir, 'task_accepted', { backend: opts.backend });
  }

  const worktree = ensureWorktree(repoRoot, taskId);
  installWorkspaceDeps(worktree, taskId);
  appendEvent(qdir, 'worktree_ready', { path: worktree, branch: `feature/${taskId}` });

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
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prompt-')), 'prompt.md');
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-settings-')), 'settings.json');

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
      // ---- worker 会话（含 fixup 返工循环）----
      let result;
      let workerOutput = '';
      {
        fs.writeFileSync(promptFile, promptText);
        if (opts.backend === 'claude-headless') writeWorkerSettings(settingsFile, tierEnv);
        appendEvent(qdir, 'worker_spawned', { backend: opts.backend, attempt: debugIter + reviewIter, ...(effWorkerModel ? { model: effWorkerModel } : {}) });
        result = await backend.spawn({
          promptFile,
          cwd: worktree,
          maxTurns: meta.budget.max_turns,
          onEvent: (e) => {
            appendEvent(qdir, e.type, e);
            trackPid(e);
            if (e.type === 'budget_snapshot') budget.account(e.tokens_in, e.tokens_out);
          },
          settingsFile,
          model: effWorkerModel, // 仅 claude 系生效（--model）；zcode-headless 忽略（模型跟随 ZCode 默认）
          envPatch: tierEnv, // tier 凭据注入（claude：settings.env + 子进程 env；zcode：子进程 env）
        });
        livePid = null;
        workerOutput = result.output ?? '';
        if (result.stderrTail) appendEvent(qdir, 'worker_stderr_tail', { text: result.stderrTail.slice(-500) });
        if (budget.tripped) {
          killTree(result.pid);
          appendEvent(qdir, 'circuit_breaker', { reason: budget.tripReason.reason, detail: budget.tripReason.detail });
          moveCard(root, taskId, 'running', 'blocked');
          appendEvent(qdir, 'blocked', { reason: `budget:${budget.tripReason.reason}` });
          die(`预算熔断：${budget.tripReason.reason}（${budget.tripReason.detail}）。任务已转 blocked/，人工决策后再继续。`);
        }
      }

      // ---- 自报不可信：先解析契约块，再亲自跑门禁 ----
      const claimed = parseResultBlock(workerOutput);
      if (!claimed || claimed.status !== 'done') {
        appendEvent(qdir, 'blocked', { reason: claimed?.status === 'stuck' ? 'worker 自报 stuck' : '未产出结果块（worker 异常结束）' });
        moveCard(root, taskId, 'running', 'blocked');
        log(`worker 未报告完成（${claimed?.status ?? '无结果块'}）。任务转 blocked/，NOTES.md 已留现场，人工决策：`);
        log(`  node .agents/scripts/orchestrator.mjs resume ${taskId}   # 带恢复上下文续做`);
        log(`  node .agents/scripts/orchestrator.mjs abandon ${taskId}   # 按 Rescue 流程清理`);
        return;
      }
      appendEvent(qdir, 'worker_done', { summary: String(claimed.summary ?? '').slice(0, 200) });

      // ---- 静态门禁 ----
      try {
        const testResult = gateNpmTest(worktree, cfg.testCmd.join(' && '));
        appendEvent(qdir, 'gate_result', { gate: 'npm_test', result: 'pass', duration_ms: testResult.durationMs });
      } catch (e) {
        if (!(e instanceof GateError)) throw e;
        appendEvent(qdir, 'gate_result', { gate: 'npm_test', result: 'fail' });
        debugIter += 1;
        appendEvent(qdir, 'debug_iteration', { attempt: debugIter, trigger: 'test_failure', max: meta.budget.max_test_iterations });
        if (debugIter > meta.budget.max_test_iterations) {
          appendEvent(qdir, 'circuit_breaker', { reason: 'max_test_iterations', detail: `${debugIter}/${meta.budget.max_test_iterations}` });
          moveCard(root, taskId, 'running', 'blocked');
          die(`调试子循环超限（${debugIter} 次）。任务转 blocked/——测试仍不绿，人工接手。`);
        }
        promptText = buildFixupPrompt(card, ctx, 'test_failure', e.output, debugIter);
        continue;
      }

      try {
        const buildResult = gateTscBuild(worktree, cfg.buildCmd); // buildCmd 未配置 → 直接 skipped 返回，不进调试循环
        appendEvent(qdir, 'gate_result', { gate: 'tsc_build', result: 'pass', ...(buildResult.skipped ? { skipped: true } : {}) });
      } catch (e) {
        if (!(e instanceof GateError)) throw e;
        appendEvent(qdir, 'gate_result', { gate: 'tsc_build', result: 'fail' });
        debugIter += 1;
        appendEvent(qdir, 'debug_iteration', { attempt: debugIter, trigger: 'build_failure', max: meta.budget.max_test_iterations });
        if (debugIter > meta.budget.max_test_iterations) {
          appendEvent(qdir, 'circuit_breaker', { reason: 'max_test_iterations', detail: `${debugIter}/${meta.budget.max_test_iterations}` });
          moveCard(root, taskId, 'running', 'blocked');
          die(`调试子循环超限（${debugIter} 次，build 不过）。任务转 blocked/，人工接手。`);
        }
        promptText = buildFixupPrompt(card, ctx, 'build_failure', e.output, debugIter);
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
        die(`红线门禁 native_scan 未通过：${e.message}\n红线不可调试，任务转 failed/。`);
      }

      // UI 冒烟门禁（任务卡 ui_check: true 才跑）：跑 workflow.json uiCheckCmd
      // （脚本自备沙箱/端口/清理，orchestrator 不感知细节）。失败进调试子循环（与 build 同级），不是红线。
      if (meta.ui_check) {
        try {
          const uiResult = gateUiCheck(worktree, cfg.uiCheckCmd);
          appendEvent(qdir, 'gate_result', { gate: 'ui_check', result: 'pass', ...(uiResult.skipped ? { skipped: true } : {}) });
        } catch (e) {
          if (!(e instanceof GateError)) throw e;
          appendEvent(qdir, 'gate_result', { gate: 'ui_check', result: 'fail' });
          debugIter += 1;
          appendEvent(qdir, 'debug_iteration', { attempt: debugIter, trigger: 'ui_check_failure', max: meta.budget.max_test_iterations });
          if (debugIter > meta.budget.max_test_iterations) {
            appendEvent(qdir, 'circuit_breaker', { reason: 'max_test_iterations', detail: `${debugIter}/${meta.budget.max_test_iterations}` });
            moveCard(root, taskId, 'running', 'blocked');
            die(`调试子循环超限（${debugIter} 次，ui_check 不过）。任务转 blocked/，人工接手。`);
          }
          promptText = buildFixupPrompt(card, ctx, 'ui_check_failure', e.output, debugIter);
          continue;
        }
      }

      const purity = gateScopePurity(worktree, meta.files_hint);
      appendEvent(qdir, 'gate_result', {
        gate: 'scope_purity',
        result: 'pass',
        outside: purity.outside.length ? purity.outside : undefined,
      });
      const cliTouched = gateCliEntry(worktree, baseBranch, cfg.corePaths); // 返回被触及的核心路径列表

      // ---- LLM 独立审查（全新上下文；权限层强制只读，不靠 prompt 自觉）----
      // 审查用独立后端（reviewBackend ≠ worker backend 时为异构互审）：review_spawned
      // 记录审查引擎，retry/resume 沿用；fallback 回落同源时留痕供 drift 分析。
      const diff = execFileSync('git', ['diff', `${baseBranch}...HEAD`], { cwd: worktree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      moveCard(root, taskId, 'running', 'reviewing');
      if (resolvedReview.mode === 'fallback' && opts.backend !== 'mock') {
        appendEvent(qdir, 'review_backend_fallback', { worker: opts.backend, detail: '异构候选 CLI 不可用，审查回落 worker 同源' });
      }
      const reviewPromptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-review-')), 'review-prompt.md');
      fs.writeFileSync(reviewPromptFile, buildReviewerPrompt(card, purity.outside.length ? diff + `\n\n# 范围警告\n以下改动超出 files_hint（${meta.files_hint.join(', ')}）：\n${purity.outside.join('\n')}` : diff, cfg.reviewNotes));
      // review_spawned 在 spawn 成功返回后才落——spawn 失败（CLI 临时不可用）不写事件，
      // resume 的 prior 解析就不会钉死在坏后端上（自动异构会重新选）
      // reviewer 仅在 tier 生效时才拿专属 settings（注入 token）；平时保持无 settings 文件的旧行为
      const reviewWantsSettings = opts.reviewBackend === 'claude-headless' && Object.keys(tierEnv).length > 0;
      let reviewSettingsFile;
      if (reviewWantsSettings) {
        reviewSettingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-review-settings-')), 'review-settings.json');
        writeWorkerSettings(reviewSettingsFile, tierEnv);
      }
      const review = await reviewBackend.spawn({
        promptFile: reviewPromptFile,
        cwd: worktree, // reviewer 只读，cwd 无关紧要但保持同环境
        maxTurns: 30,
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
          die(`审查返工超限（${reviewIter} 轮仍有阻塞项）。任务转 blocked/，人工接手。`);
        }
        promptText = buildFixupPrompt(card, ctx, 'review_blockers', review.output ?? '', reviewIter);
        moveCard(root, taskId, 'reviewing', 'running');
        continue;
      }

      // ---- 合并闸门：L0/L1 自动合并（Phase 2），L2/L3 人工 ----
      const classification = classifyChange(changedFiles(worktree), cfg);
      appendEvent(qdir, 'gate_result', { gate: 'change_classification', result: classification.level, detail: classification.reasons.join('; ') });
      const rankOf = (l) => ['L0', 'L1', 'L2', 'L3'].indexOf(l);
      // 漂移降级（Phase 3）：自动合并回溯失败率超阈值期间，一切自动合并回人工——
      // 恢复只能人工 --clear，保险丝不自己插回去
      const degraded = readDegraded(repoRoot);
      if (degraded) {
        appendEvent(qdir, 'gate_result', { gate: 'auto_merge_degraded', result: 'skipped', detail: degraded.reason });
        log(`⚠ 质量降级生效中（${degraded.reason}）——本任务转人工闸门。恢复：drift --clear（人工确认漂移已消除后）。`);
      }
      // 自动合并前提（缺一不可）：无降级标记、任务卡显式声明允许自动（gate=L0/L1；L3=全人工永不自动）、
      // 实际改动分级可自动（L0/L1）且不超声明上限、无范围越界（scope_purity 有 outside
      // 一律回人工——范围失控不该静默合并）
      const autoEligible =
        !degraded &&
        ['L0', 'L1'].includes(meta.gate) &&
        ['L0', 'L1'].includes(classification.level) &&
        rankOf(classification.level) <= rankOf(meta.gate) &&
        purity.outside.length === 0;
      if (autoEligible) {
        appendEvent(qdir, 'auto_merge', { level: classification.level, gate: meta.gate, debugIter, reviewIter });
        moveCard(root, taskId, 'reviewing', 'awaiting-human'); // 落位到闸门目录（不写 awaiting_human 事件，不等人）
        await doApprove(repoRoot, taskId, root, qdir, 'auto');
        appendEvent(qdir, 'budget_snapshot', { tokens_in: budget.tokens, elapsed_min: Math.round((Date.now() - runStarted) / 60000) });
        return;
      }

      moveCard(root, taskId, 'reviewing', 'awaiting-human');
      appendEvent(qdir, 'awaiting_human', { reason: degraded ? 'drift_degraded' : purity.outside.length ? 'scope_outside' : `level ${classification.level} 超出 gate ${meta.gate} 上限或 gate=L3` });
      const summary = {
        files: changedFiles(worktree).length,
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
        log('审查通过，任务已进入 awaiting-human/（L3 人工合并闸门）。');
        printGateSummary(taskId, summary);
        log(`人工操作：node .agents/scripts/orchestrator.mjs approve|reject|retry ${taskId}`);
      }
      appendEvent(qdir, 'budget_snapshot', { tokens_in: budget.tokens, elapsed_min: Math.round((Date.now() - runStarted) / 60000) });
      return;
    }
  } catch (e) {
    // 异步异常兜底：backend spawn 失败等——卡不得悬在 running/（见 failTaskToBlocked 注释）
    const reason = failTaskToBlocked(root, qdir, taskId, e);
    if (reason) die(`${reason}\n任务已转 blocked/——修好环境后 resume ${taskId} 续做（events.jsonl 有完整时间线）。`);
    throw e;
  } finally {
    clearTimeout(budget.wallTimer);
    try {
      fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
      fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
    } catch {}
  }
}

/**
 * cmdRun 异常兜底（工业级恢复性）：backend 启动失败（claude CLI 缺失/未登录）、
 * 内部未知错误等异步异常若不处理，任务卡会悬在 running/——状态机显示在跑、
 * 实际无进程，只能人工发现后 resume。这里统一落 blocked/ 附原因，resume 可续。
 * （业务性失败各环节已自行 die/迁移，不经过这里。）
 */
function failTaskToBlocked(root, qdir, taskId, err) {
  const found = findCard(root, taskId);
  if (found && ['running', 'reviewing'].includes(found.state)) {
    const reason = `异常中断：${String(err?.message ?? err).slice(0, 300)}`;
    appendEvent(qdir, 'failed', { reason });
    moveCard(root, taskId, found.state, 'blocked');
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
  // finish：rebase → testCmd → --no-ff 合并 → 清理分支与 worktree
  const r = spawnSync('node', [path.join(repoRoot, '.agents', 'scripts', 'feature-branch.mjs'), 'finish', taskId], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
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
  if (found.state !== 'running' && found.state !== 'blocked') {
    die(`任务 "${taskId}" 状态为 ${found.state}，只有 running/blocked 可 resume。`);
  }
  if (found.state === 'blocked') moveCard(root, taskId, 'blocked', 'running');
  appendEvent(logDir(repoRoot, taskId), 'resumed', { by: 'human' });
  log(`恢复任务 ${taskId}（带事件时间线与 NOTES.md 现场）……`);
  return cmdRun(repoRoot, taskId, { ...opts, interactive: false });
}

function cmdAbandon(repoRoot, taskId) {
  const root = queueRoot(repoRoot);
  const found = findCard(root, taskId);
  if (!found) die(`任务 "${taskId}" 不在队列中。`);
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
 * 每个任务用**子进程**跑 `run --next`：cmdRun 的熔断走 process.exit，
 * 同进程循环会整批退出；子进程隔离后单任务 blocked/failed 不阻塞后续。
 * 队列空 / 只剩损坏卡 / 达到 --max 轮数即停。
 */
function cmdDrain(repoRoot, opts) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  // 调度器互斥：drain / nightly / scan --run 同刻只允许一个在跑（run-lock.mjs）。
  // 子进程经 childEnvForHeldLock 豁免（run 不抢锁；被 spawn 的 drain 继承父锁语义）。
  const lock = acquireSchedulerLock(repoRoot, 'drain');
  if (!lock.held) {
    log(`⏸ 调度器已在运行（pid=${lock.owner.pid}，${lock.owner.cmd ?? ''}）——本次退出，不并发调度。`);
    return;
  }
  try {
    const workers = Number.isInteger(opts.workers) && opts.workers > 1 ? opts.workers : 1;
    if (workers > 1) return cmdDrainParallel(repoRoot, root, opts, workers);
    const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : Infinity;
    let done = 0;
    let lastTried = null;
    for (;;) {
      if (done >= max) {
        log(`已达 --max ${max} 轮上限，停止调度（队列中可能还有任务）。`);
        return;
      }
      const next = pickNextCard(root);
      if (!next) {
        const stuck = listCards(root, 'pending');
        if (stuck.length) log(`无可调度任务；pending/ 中还有解析失败的卡：${stuck.join(', ')}（请修复 frontmatter 或 abandon）。`);
        else log(`队列已清空：本次 drain 共跑完 ${done} 个任务。`);
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
      if (r.status !== 0) log(`任务 ${next.id} 退出码 ${r.status}（已落 blocked/failed/，继续调度下一个）。`);
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
  let launched = 0;
  let finished = 0;
  let warnedStuck = false;

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
    child.on('exit', (code) => {
      active.delete(child.pid);
      finished += 1;
      if (code !== 0) log(`任务 ${card.id} 退出码 ${code}（已落 blocked/failed/或等待人工，继续调度）。`);
      pump();
    });
  };

  const pump = () => {
    if (launched >= max) {
      if (active.size === 0) log(`已达 --max ${max} 轮上限，停止调度。`);
      return;
    }
    // 从 pending 找一个与所有在跑任务分区不相交的卡
    for (;;) {
      if (active.size >= workers) return;
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
  const { autoTotal, autoReverted, humanTotal, rate, degraded } = evaluateDrift(repoRoot, root);
  log(`════════ 质量漂移报告 ════════`);
  log(`自动合并: ${autoTotal}（其中被 revert: ${autoReverted}）    人工合并: ${humanTotal}`);
  log(`自动合并回溯失败率: ${(rate * 100).toFixed(0)}%（阈值 ${DRIFT_THRESHOLD * 100}%）`);
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
 */
function cmdReconcile(repoRoot, taskId) {
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const fmtK = (n) => `${Math.round(n / 100) / 10}k`;
  const show = (r) => {
    if (r.skipped) return log(`  ${r.reason}`);
    log(
      `  ${r.taskId.padEnd(24)} 自报 ${fmtK(r.selfTotal)}（in ${fmtK(r.selfReported.tokensIn)} / out ${fmtK(r.selfReported.tokensOut)}）` +
        `  网关实测 ${fmtK(r.gateway.total)}（${r.gateway.requests} 次转发，缓存读 ${fmtK(r.gateway.cacheRead)}）` +
        `  分歧 ${(r.divergence * 100).toFixed(0)}%${r.viaGateway ? '' : '  ⚠ 网关零流量——worker 未走狗粮'}`
    );
  };
  if (taskId) {
    const found = findCard(root, taskId);
    if (!found) die(`任务 "${taskId}" 不在队列中。`);
    log(`任务 ${taskId} 对账（时间窗内经网关转发的成功请求）：`);
    show(reconcileTask(repoRoot, taskId, root));
    return;
  }
  const all = reconcileAll(repoRoot, root);
  if (!all.length) {
    log('尚无已合并任务可对账。');
    return;
  }
  log(`已合并任务对账（${all.length} 个，按分歧降序；分母取两账中较大者）：`);
  for (const r of all) show(r);
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
  const anySignal = ['--todo', '--audit', '--tests'].some((f) => flags.has(f));
  const runOpts = {
    todo: !anySignal || flags.has('--todo'),
    audit: !anySignal || flags.has('--audit'),
    tests: flags.has('--tests'), // 要跑测试套件，慢——显式开启
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
    let promptText = buildSpecPrompt(sanitizeIntent(intentText), repoRoot);
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
 */
async function cmdNightly(repoRoot, opts) {
  rotateNightlyLog(repoRoot);
  const lock = acquireSchedulerLock(repoRoot, 'nightly');
  if (!lock.held) {
    log(`⏸ 调度器已在运行（pid=${lock.owner.pid}，${lock.owner.cmd ?? ''}）——本次退出，不并发调度。`);
    return;
  }
  const flags = opts.flags ?? new Set();
  log(`════════ nightly 巡检 ${new Date().toISOString()} ════════`);
  const root = queueRoot(repoRoot);
  ensureQueue(root);
  const childEnv = { ...process.env, ...childEnvForHeldLock() };
  let created = [];
  let skipped = [];
  let warnings = [];
  let errMsg = null;

  try {
    // 1) 巡检落卡（信号源与 scan 命令默认一致；--tests 显式开启慢路径）
    ({ created, skipped, warnings } = runScan(repoRoot, {
      todo: true,
      audit: true,
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
  log(`\n════════ nightly 摘要 ════════`);
  log(`新生成任务卡: ${created.length}    待审（awaiting-human）: ${awaiting.length}${awaiting.length ? `（${awaiting.join(', ')}）` : ''}    待调度（pending）: ${pending.length}`);
  if (awaiting.length) log(`人工放行：node .agents/scripts/orchestrator.mjs approve <task-id>`);
  if (pending.length && !opts.auto) log(`推进队列：node .agents/scripts/orchestrator.mjs drain（或下次 nightly --auto）`);

  // 通知先于退出投递（die 是 process.exit，会截断未决 promise）
  await notify({
    title: 'ModelDock nightly',
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
    log(`上个 tag ${p.base} 以来无内容提交、CHANGELOG 也无「未发布」段——没有可发布内容。`);
    return;
  }
  log(`════════ 发版提案 v${p.suggested} ════════`);
  log(`上个已发布 tag: ${p.base}    建议档位: ${p.level}`);
  log(`信号: feat ${p.counts.feat} / fix ${p.counts.fix} / breaking ${p.counts.breaking}    盘点提交: ${p.commits.length} 条`);
  if (p.counts.breaking > 0 && p.level === 'minor') log('⚠ 存在 breaking 提交，0.x 惯例走 minor——升 1.0 前请人工确认');
  if (p.counts.feat + p.counts.fix === 0) log('⚠ 无 feat/fix 提交（内容偏文档/杂务），是否值得发版请人工裁决');
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
    const r = uninstallSchedule();
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
  scan [--todo] [--audit] [--tests] [--dry-run] [--run]   巡检生成任务卡（--run 对 high 卡立即发起闭环，合并仍人工）
  nightly [--tests] [--auto N] [--backend …] [--review-backend …]
                                          一次完整巡检编排（scan + drift 报告；--auto N 顺带跑 high 卡并 drain——worker 烧钱仅在此档）
  schedule install|uninstall|status [--hour 0-23] [--minute 0-59] [--tests] [--auto N] [--backend …] [--review-backend …] [--dry-run]
                                          nightly 定时调度注册（launchd/crontab/schtasks 经 wrapper 绝对路径启动）
  release-propose [X.Y.Z]                  发版提案：盘点提交 + semver 定档 + CHANGELOG 草稿（只读仓库；确认后说「发布 vX.Y.Z」）
  drift [--clear]                          质量漂移报告：自动合并回溯失败率超 20% 自动降级全人工（--clear 人工恢复）
  reconcile [task-id]                      用量对账：worker 自报 token vs 网关实测（merged 任务，分歧降序；需项目网关支持）
  resume <task-id> [--backend mock]       崩溃任务带恢复上下文续做
  abandon <task-id>                       放弃任务（worktree 清理按 Rescue 手册人工做）
  approve <task-id>                       人工闸门：批准合并（调 feature-branch finish）
  reject <task-id> --reason "..."         人工闸门：驳回（附原因，转 failed/）
  retry <task-id> --note "..."            人工闸门：打回重试（附补充指令）
  logs <task-id>                          打印事件时间线

后端：worker claude-headless | zcode-headless | mock（zcode 桌面版设 ORCH_ZCODE_CLI=<zcode.cjs 绝对路径>）。
审查：--review-backend 显式指定；缺省自动异构互审（候选 CLI 不可用回落同源并记 review_backend_fallback 事件）。
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
      return cmdReconcile(repoRoot, args[0]);
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

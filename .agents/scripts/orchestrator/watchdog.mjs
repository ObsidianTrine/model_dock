// watchdog.mjs — LLM 进展看门狗（外部 Control Loop，参考 DeepSeek《Super-agent 设计探索》第 6 节）。
// 背景：编排器闭环里 worker 异常空转（无效循环、方向偏离、权限墙半成品）此前只能靠预算
// 上限兜底熔断——真实运行数据里 29 张 blocked 有 16 张是「未产出结果块」白烧到上限。
// 本模块在 worker 流上挂一个轻量进展检查器：每 N 个 worker_turn 组装短 prompt（卡目标 +
// 事件时间线尾部），调用一次性 headless LLM 判断「是否有实质进展」，期望输出
// JSON {progressing, reason}。双档模式：observe（缺省，只记 watchdog_suspect 事件）|
// actuate（连续 2 次 suspect → 既有 stuck 熔断路径 kill→blocked）。
// 防烧钱上界：每任务检查总次数 ≤5（超限记 watchdog_disabled 后不再触发）；输入截断
// （时间线尾部 ≤20 条、每条 ≤200 字符）；自身错误记 watchdog_error（每任务 ≤3 条后静默）。
// 保守原则：解析失败/进程失败一律按 progressing=true 处理——看门狗误报的代价必须小于
// 打扰正常任务，绝不因看门狗自身故障杀掉在跑的 worker。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDecisionTrace } from './trace.mjs';

/** 看门狗单次检查的 worker 会话轮次上限（只读判断，1-2 轮足够；收紧防跑飞）。 */
export const WATCHDOG_MAX_TURNS = 4;
/** 时间线截断：尾部 ≤20 条、每条 ≤200 字符。 */
export const WATCHDOG_TIMELINE_MAX_ENTRIES = 20;
export const WATCHDOG_TIMELINE_ENTRY_MAX_CHARS = 200;

/** 从 LLM 输出解析 {progressing, reason}；解析不到返回 null（调用方按保守处理）。
 *  容忍三种形态：裸 JSON、```json fenced block、JSON 前后带解释文字。 */
export function parseWatchdogVerdict(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  const tryParse = (s) => {
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.progressing === 'boolean') {
        return { progressing: j.progressing, reason: String(j.reason ?? '') };
      }
    } catch {
      /* 不是 JSON */
    }
    return null;
  };
  const direct = tryParse(raw.trim());
  if (direct) return direct;
  for (const m of raw.matchAll(/```[a-zA-Z]*\s*([\s\S]*?)```/g)) {
    const v = tryParse(m[1].trim());
    if (v) return v;
  }
  const i = raw.indexOf('{');
  const j = raw.lastIndexOf('}');
  if (i >= 0 && j > i) {
    const v = tryParse(raw.slice(i, j + 1));
    if (v) return v;
  }
  return null;
}

/** 事件时间线尾部摘要（喂给看门狗 judge 的输入）：尾部 ≤WATCHDOG_TIMELINE_MAX_ENTRIES 条、
 *  每条截断到 WATCHDOG_TIMELINE_ENTRY_MAX_CHARS 字符。只留 type + 业务字段（ts/seq 是
 *  噪音），格式与 formatTimeline 同风格但不带时间戳。 */
export function watchdogTimelineSummary(events) {
  const lines = (events ?? [])
    .slice(-WATCHDOG_TIMELINE_MAX_ENTRIES)
    .map((e) => {
      const extra = Object.entries(e)
        .filter(([k]) => !['ts', 'seq', 'type'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      const line = `${e?.type ?? 'unknown'}${extra ? '  ' + extra : ''}`;
      return line.length > WATCHDOG_TIMELINE_ENTRY_MAX_CHARS ? `${line.slice(0, WATCHDOG_TIMELINE_ENTRY_MAX_CHARS)}…` : line;
    });
  return lines.join('\n');
}

/** 组装看门狗短 prompt：卡目标 + 事件时间线尾部 + 产出契约。 */
export function buildWatchdogPrompt(goal, timelineText) {
  return [
    '你在判断一个长时间运行的编码 agent 是否在取得实质进展。只判断，不执行任何操作。',
    '',
    '# 任务目标',
    String(goal ?? '（未提供）').trim(),
    '',
    '# 最近事件时间线（尾部）',
    String(timelineText ?? '').trim() || '（空）',
    '',
    '# 产出契约',
    '只输出一个 JSON 对象，不要输出其他文字：',
    '{"progressing": true|false, "reason": "一句话依据"}',
    '判断标准：时间线是否显示新的产出或新的尝试方向；重复同类失败、循环同一操作、长时间无新事件 = 无实质进展。',
    '拿不准时按 progressing: true（保守，不打扰）。',
  ].join('\n');
}

/**
 * 一次性 LLM 进展检查。spawnFn({prompt}) → Promise<string>（headless LLM 输出）；
 * 由调用方注入（orchestrator.mjs 用 makeWatchdogSpawnFn 复用现有 backend 基建，测试用假替身）。
 * 保守失败：进程失败/输出解析失败一律返回 {progressing: true, error}——不打扰正常任务。
 * 决策留底：traceDir 有值时把本次判断落盘（kind=watchdog，input=时间线摘要全文、
 * output=模型原始输出、parsed=verdict；写失败内部消化不影响判定，见 trace.mjs）。
 * traceOpts 透传 workflow.json trace 键的上界/滚动参数（{maxInputKB, maxPerTask}）。
 */
export async function watchdogCheck({ goal, timeline, spawnFn, traceDir, traceOpts } = {}) {
  const startedAt = Date.now();
  try {
    if (typeof spawnFn !== 'function') throw new Error('spawnFn 不是函数');
    const output = await spawnFn({ prompt: buildWatchdogPrompt(goal, timeline) });
    const verdict = parseWatchdogVerdict(output);
    if (traceDir) {
      writeDecisionTrace(
        { root: traceDir, kind: 'watchdog', input: timeline, output: String(output ?? ''), parsed: verdict, meta: { durationMs: Date.now() - startedAt } },
        traceOpts,
      );
    }
    if (!verdict) return { progressing: true, error: '输出无法解析为 {progressing, reason} JSON' };
    return verdict;
  } catch (e) {
    const error = `看门狗进程失败：${String(e?.message ?? e).slice(0, 300)}`;
    if (traceDir) {
      writeDecisionTrace(
        { root: traceDir, kind: 'watchdog', input: timeline, output: '', parsed: null, meta: { durationMs: Date.now() - startedAt, error } },
        traceOpts,
      );
    }
    return { progressing: true, error };
  }
}

/**
 * 一次性 headless 会话的 spawnFn 工厂：复用现有 backend.spawn（reviewer 同款只读形态，
 * claude 系 --allowedTools 收敛为 Read/Glob/Grep、zcode 系 --mode plan）。与 worker/
 * reviewer 会话完全隔离：无事件记账（onEvent 空）、maxTurns 收紧到 WATCHDOG_MAX_TURNS、
 * 临时 prompt 目录随查随删。mock 后端不适用（会写文件污染 worktree），调用方负责跳过。
 */
export function makeWatchdogSpawnFn(backend, { cwd, model, envPatch } = {}) {
  return async ({ prompt }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-watchdog-'));
    try {
      const promptFile = path.join(dir, 'watchdog-prompt.md');
      fs.writeFileSync(promptFile, prompt);
      const r = await backend.spawn({
        promptFile,
        cwd,
        maxTurns: WATCHDOG_MAX_TURNS,
        onEvent: () => {}, // 判断会话不记账、不留事件——worker 流时间线只属于 worker
        readonly: true,
        ...(model ? { model } : {}),
        ...(envPatch && Object.keys(envPatch).length ? { envPatch } : {}),
      });
      return r.output ?? '';
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不阻断 */
      }
    }
  };
}

/**
 * worker_turn 计数 / 防重入 / 上限 / actuate 熔断判定的纯逻辑状态机（orchestrator.mjs
 * 挂钩处的可测内核；事件落盘由调用方按返回值执行）。
 * 约定：onTurn() 在 worker 每个 worker_turn 事件时调一次（含 pending 期间的 turn——
 * 防重入跳过的是「触发」，不是计数，触发点始终落在 N 的整数倍上）。
 */
export function createWatchdogState({ mode = 'observe', everyTurns = 20, maxChecks = 5, maxErrors = 3 } = {}) {
  const s = {
    turns: 0, // worker_turn 计数（跨 fixup 会话累计，按任务口径）
    checks: 0, // 已发起的 watchdogCheck 次数
    errors: 0, // 已记录的 watchdog_error 条数
    suspectStreak: 0, // 连续 suspect 次数（progressing 结论清零）
    pending: false, // 防重入：上一次检查未返回
    disabled: false, // 检查次数达上限后不再触发
  };
  return {
    /** 只读快照（事件字段用）。 */
    snapshot() {
      return { ...s };
    },
    /** 任务落位/worker 正常结束后调用：此后不再触发（一次性，不可逆）。 */
    settle() {
      s.disabled = true;
    },
    /**
     * worker 每 turn 调用。返回：
     *   'check'    —— 该发起一次看门狗检查（调用方随后必须 beginCheck()）
     *   'disabled' —— 检查次数达上限（只返回一次，调用方记 watchdog_disabled 事件）
     *   null       —— 不触发
     */
    onTurn() {
      if (s.disabled) return null;
      s.turns += 1;
      if (s.pending) return null; // 防重入：检查未返回前的新触发直接跳过（不推迟）
      if (s.turns % everyTurns !== 0) return null;
      if (s.checks >= maxChecks) {
        s.disabled = true;
        return 'disabled';
      }
      return 'check';
    },
    /** 发起检查前调：置防重入并计数。 */
    beginCheck() {
      s.pending = true;
      s.checks += 1;
    },
    /** 检查收尾（finally 调）：解除防重入。 */
    endCheck() {
      s.pending = false;
    },
    /** 记一次看门狗自身错误；超过 maxErrors 后返回 false（调用方停止记录，防错误刷屏）。 */
    recordError() {
      s.errors += 1;
      return s.errors <= maxErrors;
    },
    /**
     * 提交一次检查结论。返回：
     *   'circuit_break' —— actuate 且连续 2 次 suspect（调用方走既有 stuck 熔断路径）
     *   'suspect'       —— 调用方记 watchdog_suspect 事件
     *   'ok'            —— 无动作（progressing 或 observe 下无需处理）
     * 结论提交本身解除防重入（endCheck 仍应照常调，幂等）。
     */
    report(progressing, _reason) {
      s.pending = false;
      if (progressing) {
        s.suspectStreak = 0;
        return 'ok';
      }
      s.suspectStreak += 1;
      if (mode === 'actuate' && s.suspectStreak >= 2) {
        s.disabled = true; // 熔断后不再触发（任务随之 blocked）
        return 'circuit_break';
      }
      return 'suspect';
    },
  };
}

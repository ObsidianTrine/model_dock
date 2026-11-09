// sail.mjs — 自由航行（时间盒完全自治）的纯逻辑件，全部可单测：
//   parseDurationMinutes  --minutes / --duration 的人话时长解析（45 | 90m | 2h | 1h30m | 90s）
//   canSailSubmit         自由航行自动提交判定（开 sail 即本航次授权；硬禁区沿用 autopilot 哲学）
//   snapshotQueue         队列状态快照（开航基线与收帆快照——战果清单的原料）
//   snapshotDrafts        drafts/ 提案快照（每周期规划产出的 id/类型/目标句——「为什么这么编排」的原料）
//   diffQueueStates       前后两次队列快照的差分
//   buildSailReport       航海报告确定性组装（不烧 LLM、理由引卡片原文，防幻觉）
//   buildSailSummary      通知用单行摘要
// 接口契约（永不改名）：命令名 sail、stop 文件 .sail-stop、报告目录 logs/sail/<ts>/。

import fs from 'node:fs';
import path from 'node:path';
import { parseCard, STATES, cardPath, listCards, queueRoot } from './queue.mjs';
import { hintsOverlap } from '../policy.mjs';
import { readGoals } from './goals.mjs';
import { buildTaskRoster } from './notify.mjs';
import { fmtUsd } from './cost.mjs';

/** 自由航行 stop 文件名（.agents/orchestrator/ 下，与 .watch-stop 同款语义）。 */
export const SAIL_STOP_FILE = '.sail-stop';

/** 自由航行自动提交的类型白名单缺省值（workflow.json freeSail.autoSubmitTypes 可收窄）。
 *  feature 不在列（2026-11 Plan A）：feature 提案走上游管线（research → spec → 人工审
 *  设计 → spec build），canSailSubmit 在白名单判定前就硬拒——白名单配置加回 feature 也
 *  不会放大授权面（配置只收窄、永不放大）。 */
export const DEFAULT_SAIL_SUBMIT_TYPES = ['docs', 'bugfix', 'refactor'];

/**
 * 解析自由航行时长。opts.minutes：正数分钟；opts.duration：人话规格
 * （'45' | '90m' | '2h' | '1h30m' | '90s' | '1m30s'，大小写不敏感、容忍空格；
 * 秒级时长用于冒烟/测试短航——deadline 是分钟的小数表示）。两者都缺或非法 → null
 * （调用方 die 提示必须显式指定——自由航行烧钱，不允许静默默认时长）。
 */
export function parseDurationMinutes(opts = {}) {
  if (opts.minutes != null) {
    const n = Number(opts.minutes);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }
  const spec = String(opts.duration ?? '').trim().toLowerCase();
  if (!spec) return null;
  const combined = /^(\d+)\s*h\s*(\d+)\s*m?$/.exec(spec);
  if (combined) return (Number(combined[1]) * 60 + Number(combined[2])) || null;
  const hours = /^(\d+)\s*h$/.exec(spec);
  if (hours) return Number(hours[1]) * 60 || null;
  const minSec = /^(\d+)\s*m\s*(\d+)\s*s(?:ec|econds?)?$/.exec(spec);
  if (minSec) return (Number(minSec[1]) + Number(minSec[2]) / 60) || null;
  const mins = /^(\d+)\s*(?:m|min|minutes?)?$/.exec(spec);
  if (mins) return Number(mins[1]) || null;
  const secs = /^(\d+)\s*s(?:ec|econds?)?$/.exec(spec);
  if (secs) return Number(secs[1]) / 60 || null;
  return null;
}

/**
 * 判定一张提案卡能否被自由航行自动提交进队列。
 * 与 autopilot（canAutoSubmit）同款哲学，授权来源不同：autopilot 是 workflow.json 的
 * 持久授权，sail 是「人显式敲下带时长的 sail 命令」这一动作本身即本航次授权。
 * 硬禁区不变（配置只收窄、永不放大）：
 *   - created_by: human 的人工草稿永不自动（等人工 submit）；
 *   - deps 类型永不自动（依赖升级牵一发动全身，人工裁决）；
 *   - feature 类型永不直接自动——走上游管线：research brief → spec 三件套 → 人工审设计
 *     → spec build 拆卡进队列（sail 在规划轮自动跑到「spec 落盘待人审」为止，2026-11
 *     Plan A 收紧：此前 feature 提案直接进队列，设计无人看过）；
 *   - files_hint 命中 corePaths/releasePaths 永不自动（分级闸门兜底前先省一轮 worker）。
 * 注意：自动提交 ≠ 自动合并——提交的卡 gate 覆写 L1，实际合并仍由门禁对真实改动分级裁决。
 */
export function canSailSubmit(meta, cfg) {
  if (meta.created_by === 'human') return { ok: false, reason: '人工草稿（created_by: human）永不自动提交' };
  if (meta.type === 'deps') return { ok: false, reason: 'deps 类型永不自动提交（依赖升级人工裁决）' };
  if (meta.type === 'feature') return { ok: false, reason: 'feature 提案走上游管线（research → spec → 人工审设计 → spec build），不直接自动提交——审完设计后跑 spec build 拆卡' };
  const whitelist = Array.isArray(cfg?.freeSail?.autoSubmitTypes) && cfg.freeSail.autoSubmitTypes.length
    ? cfg.freeSail.autoSubmitTypes
    : DEFAULT_SAIL_SUBMIT_TYPES;
  if (!whitelist.includes(meta.type)) {
    return { ok: false, reason: `type "${meta.type}" 不在 freeSail.autoSubmitTypes [${whitelist.join(', ')}]` };
  }
  const guarded = [...(cfg.corePaths ?? []), ...(cfg.releasePaths ?? [])];
  // 空守卫清单 = 无守卫面（与 canAutoSubmit 同款：未配置时不把所有卡拒掉）
  if (guarded.length && hintsOverlap(meta.files_hint, guarded)) {
    return { ok: false, reason: 'files_hint 命中核心/发布路径（永不自动提交）' };
  }
  return { ok: true };
}

/** 队列快照：{ state: [id...] }。开航基线与收帆快照共用（差分 = 本次航行的活动面）。 */
export function snapshotQueue(root) {
  const snap = {};
  for (const s of STATES) snap[s] = listCards(root, s);
  return snap;
}

/** drafts/ 路径（与 orchestrator.mjs draftsDir 同一落点；独立定义避免回环依赖）。 */
export function draftsPath(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'drafts');
}

/**
 * drafts/ 提案快照：[{ id, createdBy, type, priority, goal }]。
 * goal 取卡「# 目标」段摘要（160 字符）——planner 写卡时的编排理由原文，
 * 航海报告「为什么这么编排」直接引用（提交后草稿即删，必须在做卡时快照留存）。
 */
export function snapshotDrafts(repoRoot) {
  const dir = draftsPath(repoRoot);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return []; // drafts/ 不存在 = 无提案
  }
  const out = [];
  for (const f of files) {
    try {
      const { meta, body } = parseCard(fs.readFileSync(path.join(dir, f), 'utf8'), f);
      out.push({
        id: meta.id,
        createdBy: meta.created_by ?? '?',
        type: meta.type ?? '?',
        priority: meta.priority ?? 'normal',
        goal: String(body?.goal ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      });
    } catch {
      out.push({ id: f.replace(/\.md$/, ''), createdBy: '?', type: '?', priority: '?', goal: '（提案卡解析失败）' });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 两次队列快照差分：{ changed: [{id, from, to}], added: [{id, state}] }（卡只迁移不删除，无「消失」态）。 */
export function diffQueueStates(before, after) {
  const changed = [];
  const added = [];
  for (const s of STATES) {
    for (const id of after[s] ?? []) {
      const from = STATES.find((st) => (before[st] ?? []).includes(id));
      if (!from) added.push({ id, state: s });
      else if (from !== s) changed.push({ id, from, to: s });
    }
  }
  return { changed, added };
}

/** 单卡信息（报告用）：优先用周期内提案快照，否则从队列现存卡文件现读。返回 { state?, type, goal } 或 null。 */
export function cardReportInfo(root, id, lookup) {
  const hit = lookup?.[id];
  if (hit) return hit;
  for (const s of STATES) {
    const p = cardPath(root, s, id);
    if (!fs.existsSync(p)) continue;
    try {
      const { meta, body } = parseCard(fs.readFileSync(p, 'utf8'), id);
      return { state: s, type: meta.type ?? '?', goal: String(body?.goal ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) };
    } catch {
      return { state: s, type: '?', goal: '（卡解析失败）' };
    }
  }
  return null;
}

function goalLine(info) {
  return info?.goal ? `：${info.goal}` : '';
}

function typeOf(info) {
  return info?.type ?? '?';
}

/**
 * 航海报告（确定性组装，不烧 LLM）。
 * voyage 字段：{ projectName, root, startedAtISO, finishedAtISO, minutes, actualMinutes,
 *   stopReason, cycles[], baseline, endState, diff, dispatchedTotal, goalsText, reportPath }
 * cycles 元素：{ n, kind: dispatch|plan|idle, dispatched[], proposals[], submitted[], skipped[], sleepMin, drainExit }
 * proposals 元素：{ id, createdBy, type, priority, goal }；skipped 元素：{ id, reason }。
 */
export function buildSailReport(voyage) {
  const { baseline, endState, diff, root } = voyage;
  // voyage.root 是仓库根，cardReportInfo 按队列根找卡——换算一次（缺失则手工卡目标全查不到，
  // 报告里显示（?），2026-11-02 首航报告实证）。
  const qroot = queueRoot(root);
  // 本航次提案的 id → 信息（含「由本航次产出」标记，用于区分存量与新增）
  const lookup = {};
  for (const c of voyage.cycles ?? []) {
    for (const p of c.proposals ?? []) {
      lookup[p.id] = { type: p.type, goal: p.goal, fromSail: true };
    }
  }
  // 「本航次编排的卡」：sail 派发离港（from pending）、本航次新增入队、本航次提案。
  // changed 里 from ≠ pending 的（running→merged 等）是并行会话/人工操作所致——如实
  // 单列，不计入本航次战果（实航实证：并行 finish 落位的卡曾被误标「已出港」）。
  const touched = (id) =>
    (diff.changed ?? []).some((c) => c.id === id && c.from === 'pending') ||
    (diff.added ?? []).some((a) => a.id === id) ||
    Boolean(lookup[id]);
  const foreignSettled = (diff.changed ?? []).filter((c) => c.from !== 'pending');
  const lines = [];
  lines.push(`# 自由航行航海报告${voyage.projectName ? ` · ${voyage.projectName}` : ''}`);
  lines.push('');
  lines.push(`- 航程：${voyage.startedAtISO} → ${voyage.finishedAtISO}（实际 ${voyage.actualMinutes} 分钟 / 计划 ${voyage.minutes} 分钟）`);
  lines.push(`- 结束原因：${voyage.stopReason ?? '异常中断（SIGINT/崩溃——逐周期 voyage.json 已留痕可续查）'}`);
  lines.push(`- 周期 ${voyage.cycles?.length ?? 0} 个，派发任务 ${voyage.dispatchedTotal ?? 0} 张`);
  lines.push(`- 罗盘（goals.md）：${voyage.goalsText ? `有——提案须对齐：${String(voyage.goalsText).replace(/\s+/g, ' ').slice(0, 200)}` : '无（仅凭巡检信号提案）'}`);
  lines.push('');
  // 燃油账（确定性组装）：网关实测 token × 价目（cost.mjs measureFuel）；不可测时如实给原因
  if (voyage.fuel) {
    const f = voyage.fuel;
    lines.push('## 燃油账');
    lines.push('');
    if (f.measured) {
      lines.push(`- 本航次实测 ${fmtUsd(f.usd)}（${f.requests} 次经网关转发；单价 = 网关价目，USD）${f.source === 'cache' ? '——网关不可达，按陈价目估算' : ''}`);
      for (const c of f.byCard ?? []) {
        const info = cardReportInfo(qroot, c.id, lookup);
        lines.push(`  - ${c.id}（${typeOf(info)}）：${fmtUsd(c.usd)}`);
      }
      if (f.unpriced?.length) lines.push(`- ⚠ ${f.unpriced.length} 个模型未匹配单价（按 $0 计）：${f.unpriced.slice(0, 5).join(', ')}${f.unpriced.length > 5 ? '…' : ''}——在 ~/.modeldock/pricing.json 补价后口径更准`);
    } else {
      lines.push(`- 不可测：${f.reason ?? '原因未知'}`);
    }
    lines.push('');
  }
  lines.push('## 战果清单');
  lines.push('');
  const merged = (endState.merged ?? []).filter(touched);
  lines.push(`### ✅ 已出港（merged，${merged.length} 张）`);
  for (const id of merged) {
    const info = cardReportInfo(qroot, id, lookup);
    lines.push(`- ${id}（${typeOf(info)}）${goalLine(info)}`);
  }
  if (!merged.length) lines.push('（无）');
  const awaiting = (endState['awaiting-human'] ?? []).filter(touched);
  lines.push(`### ⏸ 待船东放行（awaiting-human，${awaiting.length} 张）`);
  for (const id of awaiting) {
    const info = cardReportInfo(qroot, id, lookup);
    lines.push(`- ${id}（${typeOf(info)}）${goalLine(info)}——合并闸门未自动放行（gate 声明 / 实际分级 / drift / scope 之一），人工审 diff 后 approve/retry/reject`);
  }
  if (!awaiting.length) lines.push('（无）');
  const troubled = [...(endState.blocked ?? []), ...(endState.failed ?? [])].filter(touched);
  lines.push(`### ⚠ 搁浅 / 退关（blocked+failed，${troubled.length} 张）`);
  for (const id of troubled) {
    const info = cardReportInfo(qroot, id, lookup);
    lines.push(`- ${id}（${typeOf(info)}，现处 ${info?.state ?? '?'}）${goalLine(info)}——logs/<id>/ 事件时间线查原因，resume/abandon 人工处置`);
  }
  if (!troubled.length) lines.push('（无）');
  const pendingNow = endState.pending ?? [];
  lines.push(`### 📋 仍在队列（pending，${pendingNow.length} 张）`);
  for (const id of pendingNow) {
    const isNew = (diff.added ?? []).some((a) => a.id === id);
    lines.push(`- ${id}${isNew ? '（本航次新增，未及派发）' : '（开航前已在队列）'}${goalLine(cardReportInfo(qroot, id, lookup))}`);
  }
  if (!pendingNow.length) lines.push('（无）');
  const untouched = (voyage.cycles ?? []).flatMap((c) => c.proposals ?? []).filter((p) => !c_submitted(voyage, p.id));
  lines.push(`### 📝 未提交提案（drafts，${untouched.length} 张）`);
  for (const p of untouched) {
    const reason = voyageSkippedReason(voyage, p.id);
    lines.push(`- ${p.id}（${p.type}，by ${p.createdBy}）${p.goal ? `：${p.goal}` : ''}${reason ? `——${reason}` : ''}`);
  }
  if (!untouched.length) lines.push('（无）');
  if (foreignSettled.length) {
    lines.push(`### 🔄 航期内由其他流程落位（非本航次编排，${foreignSettled.length} 张）`);
    for (const c of foreignSettled) {
      lines.push(`- ${c.id}（${c.from} → ${c.to}）——并行会话/人工操作所为，不计入本航次战果`);
    }
    lines.push('');
  }
  lines.push('');
  lines.push('## 为什么这么编排');
  lines.push('');
  lines.push(`- 开航基线：pending ${(baseline.pending ?? []).length}、awaiting-human ${(baseline['awaiting-human'] ?? []).length}、blocked ${(baseline.blocked ?? []).length}、drafts ${(baseline.drafts ?? []).length}——这些是开航前已有的存量，不是本次编排的产物。`);
  for (const c of voyage.cycles ?? []) {
    if (c.kind === 'dispatch') {
      const names = (c.dispatched ?? []).join(', ') || '（无卡离开 pending——卡在待引水/解析失败，见上方战果清单）';
      lines.push(`- 周期 ${c.n}：派发执行 → ${names}${c.drainExit != null && c.drainExit !== 0 ? `（drain 退出码 ${c.drainExit}）` : ''}`);
    } else if (c.kind === 'plan') {
      if (!c.proposals?.length) {
        lines.push(`- 周期 ${c.n}：巡检+规划：无新提案（信号已处理过 / planner 判定无值得做的）——休眠 ${c.sleepMin ?? 0} 分钟后再看海况。`);
        continue;
      }
      lines.push(`- 周期 ${c.n}：巡检+规划，产出 ${c.proposals.length} 张提案：`);
      for (const p of c.proposals) {
        if (c.submitted?.includes(p.id)) lines.push(`  - ${p.id}（${p.type}/${p.priority}，by ${p.createdBy}）「${p.goal}」→ 已提交（gate=L1，进队列待派发）`);
        else lines.push(`  - ${p.id}（${p.type}/${p.priority}，by ${p.createdBy}）「${p.goal}」→ 未提交（${c.skipped?.find((s) => s.id === p.id)?.reason ?? '未提交'}）`);
      }
      // 上游管线（2026-11 Plan A）：feature 提案的去向——调研/spec/失败原因如实入报告
      for (const id of c.upstream?.researched ?? []) {
        const v = c.upstream?.verdicts?.find((x) => x.id === id)?.level;
        lines.push(`  - ⛵ 上游管线：调研 brief ${id} 已产出（research/<id>/brief.md，带引用与快照）${v ? `——可信度初判 ${v}` : ''}`);
      }
      // 多维调研 topic（researchAutoDim，2026-11-10 P3）：复合清单 + rollup 如实入报告
      for (const t of c.upstream?.researchedTopics ?? []) {
        lines.push(`  - ⛵ 上游管线：多维调研 topic ${t.id} 已落盘（${t.dims} 维，rollup ${t.rollup}）——spec 按维注入待人审`);
      }
      for (const id of c.upstream?.speced ?? []) lines.push(`  - ⛵ 上游管线：spec ${id} 已落盘待人审——审完设计后跑 spec build ${id} 拆卡进队列`);
      for (const u of c.upstream?.unsafe ?? []) {
        lines.push(`  - ⛔ 上游管线：${u.id}——调研 ${u.topic ? `topic ${u.topic}` : `brief ${u.brief}`} 判 unsafe（决策契约一票否决），spec 不升级，已留痕跳过（后续周期不再调研）`);
      }
      for (const f of c.upstream?.failed ?? []) lines.push(`  - ⚠ 上游管线：${f.id}——${f.reason}`);
    } else if (c.kind === 'idle') {
      lines.push(`- 周期 ${c.n}：队列空、无新提案——休眠 ${c.sleepMin ?? 0} 分钟。`);
    }
  }
  lines.push('- 授权边界：开 sail 即授权本航次自动提交（类型白名单 workflow.json freeSail.autoSubmitTypes，缺省 docs/bugfix/refactor；feature 永不直接提交——走上游管线 research → spec → 人工审设计 → spec build）；deps、人工草稿、核心/发布路径永不自动；提交 gate=L1 而实际合并由分级裁决 + drift 保险丝兜底——自动的是「进队列」，不是「进主干」。');
  lines.push('');
  return lines.join('\n');
}

function c_submitted(voyage, id) {
  return (voyage.cycles ?? []).some((c) => c.submitted?.includes(id));
}

function voyageSkippedReason(voyage, id) {
  for (const c of voyage.cycles ?? []) {
    const hit = c.skipped?.find((s) => s.id === id);
    if (hit) return hit.reason;
  }
  return '';
}

/** 通知用单行摘要（短、可扫读；与 buildNightlySummary 同款风格）。 */
export function buildSailSummary(voyage) {
  const s = voyage.endState ?? {};
  const parts = [];
  if (voyage.stopReason && voyage.stopReason !== '到达时长上限') parts.push(`⏸ ${voyage.stopReason}`);
  else parts.push('✓ 自由航行结束');
  parts.push(`实际 ${voyage.actualMinutes ?? '?'}/${voyage.minutes} 分钟、派发 ${voyage.dispatchedTotal ?? 0}`);
  if (voyage.fuel?.measured) parts.push(`燃油 ${fmtUsd(voyage.fuel.usd)}`);
  parts.push(`出港 ${(s.merged ?? []).length}、待放行 ${(s['awaiting-human'] ?? []).length}、搁浅/退关 ${((s.blocked ?? []).length + (s.failed ?? []).length)}、待调度 ${(s.pending ?? []).length}`);
  if (voyage.reportPath) parts.push(`报告 ${voyage.reportPath}`);
  // 任务花名册：按任务号列本航次落位的卡与目标首行（「做了哪些任务、为什么」一眼可读；
  // 卡读取失败只列 id 与状态，不影响摘要本身）。
  const rosterTasks = [
    ...(s.merged ?? []).map((id) => ({ id, state: 'merged' })),
    ...(s['awaiting-human'] ?? []).map((id) => ({ id, state: 'awaiting-human' })),
    ...(s.blocked ?? []).map((id) => ({ id, state: 'blocked' })),
    ...(s.failed ?? []).map((id) => ({ id, state: 'failed' })),
  ];
  const roster = voyage.root
    ? buildTaskRoster(rosterTasks, {
        max: 8,
        infoOf: (t) => {
          try { return cardReportInfo(queueRoot(voyage.root), t.id); } catch { return null; }
        },
      })
    : buildTaskRoster(rosterTasks, { max: 8 });
  return roster ? `${parts.join('；')}\n${roster}` : parts.join('；');
}

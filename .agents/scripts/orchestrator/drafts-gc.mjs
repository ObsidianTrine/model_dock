// drafts-gc.mjs — drafts/ 提案生命周期（B9，2026-11 定）：提案落盘后没有清退机制，
// drafts/ 只进不出（16 张积压实证，其中 ≥3 张已被 merged 工作覆盖）。生命周期三条：
//   1. 自动 superseded（闭环内动作，merge 即触发）：卡落 merged/ 时，drafts/ 里
//      files_hint 路径与刚合并卡重叠的提案自动迁入 drafts/superseded/ 并在文件头标注
//      合并卡 id——提案所针对的现场已被真实合并实现覆盖，继续留着会误导 planner 与
//      人工（「深化既有提案」会去深化一件已完成的事）。仅标题相似不迁（防误杀），
//      只在 drafts gc 报告中提示。
//   2. 老化自动档（nightly 清退，2026-11-10 老化自动档卡）：drafts/ 中超 maxAgeDays
//      （缺省 14 天）且队列 7 状态零痕迹、机器来源（created_by ∈ planner/scanner）的
//      提案由 nightly 周期自动迁入 drafts/superseded/（aged-out 标注）——无人值守场景
//      提案积压只靠手动 --apply 清不动。三重保守闸：队列有同名卡（提案已提交/已被
//      真实工作吸收）不动、人工草稿不动、痕迹面不可知整档关闭。
//   3. 老化手动档（drafts gc）：drafts/ 中超 archiveDays（缺省 30 天）的提案在
//      `drafts gc --apply` 时迁入 drafts/archived/（与 2 独占：进了自动清退清单的不再
//      进归档清单，同一文件不会被两个清单重复迁移）。
// 铁律：**不删任何文件，只迁移目录**；写不进/迁不动（目标已存在等）跳过并告警，
// 绝不阻断 merge/nightly 主流程。年龄口径：frontmatter created_at 解析优先，失败回落
// 文件 mtime，两者都不可得按「不老化」保守处理（宁少勿滥，与 autoresume cooldownPassed 同哲学）。

import fs from 'node:fs';
import path from 'node:path';
import { loadWorkflowConfig } from '../workflow-config.mjs';
import { toIsoLocal } from './events.mjs';
import { STATES, cardPath, listCards, parseCard, queueRoot } from './queue.mjs';

/** 提案迁移目标目录名（drafts/ 的子目录，listDrafts 只扫顶层 .md，不会重复收割）。 */
export const SUPERSEDED_DIR = 'superseded';
export const ARCHIVED_DIR = 'archived';
/** 归档阈值缺省（天）：workflow.json draftsGc.archiveDays 可调。 */
export const DEFAULT_ARCHIVE_DAYS = 30;
/** 老化自动档阈值缺省（天）：workflow.json draftsGc.maxAgeDays 可调。 */
export const DEFAULT_MAX_AGE_DAYS = 14;
/** 超龄自动清退标注用的伪 id（superseded_by 值）：区别于「被某合并卡覆盖」的真实 id。 */
export const AGED_OUT_BY = 'aged-out';
/** 机器来源提案白名单（老化自动档只清这两类；人工草稿与 created_by 缺失一律不动）。 */
export const AUTO_SOURCES = new Set(['planner', 'scanner']);
/** 「标题相似」判定阈值（goal 首行分词 Jaccard 相似度）：仅报告提示，永不据此迁移。 */
export const TITLE_SIMILAR_THRESHOLD = 0.6;

export function draftsRoot(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'drafts');
}

/**
 * files_hint 路径重叠（**路径前缀精确口径**，比 policy.hintsOverlap 的顶层段口径更细）：
 * 每条 hint 截断到第一个通配段之前的固定前缀（src/gateway/relay.ts → src/gateway/relay；
 * src/** → src），任一前缀对相等或互为路径前缀即重叠；完全通配（**、*）→ 独占（与一切
 * 重叠）；空清单建立不了重叠 → 一律不重叠（防误杀：清退是动作，宁漏勿杀）。选细口径的动机（防误杀）：superseded 是「提案已被真实实现覆盖」的定性——
 * 顶层段口径会把 src/config 的提案被 src/gateway 的合并误杀；前缀口径只在路径真重叠
 * （同文件/同目录）时定性。
 */
function hintPrefixes(hints) {
  const set = new Set();
  for (const h of (hints ?? []).map((x) => String(x).replace(/\\/g, '/'))) {
    const fixed = [];
    for (const seg of h.split('/')) {
      if (seg.includes('*') || seg.includes('?')) break;
      if (seg) fixed.push(seg);
    }
    if (!fixed.length) return null; // 完全通配 → 独占
    set.add(fixed.join('/'));
  }
  return set;
}

export function pathsOverlap(a, b) {
  const A = hintPrefixes(a);
  const B = hintPrefixes(b);
  if (!A || !B) return true;
  if (!A.size || !B.size) return false; // 空清单建立不了重叠 → 不迁（防误杀：宁漏勿杀）
  for (const x of A) {
    for (const y of B) {
      if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
    }
  }
  return false;
}

/**
 * 扫 drafts/ 顶层提案（子目录 superseded/ archived/ 不扫——已处置的不回锅）。
 * 解析失败的文件进 unreadable（永不静默：调用方告警），照常留在原地。
 * @returns {{ drafts: Array<{id, file, path, meta, body, mtimeMs, text}>, unreadable: string[] }}
 */
export function listDrafts(repoRoot) {
  const dir = draftsRoot(repoRoot);
  const drafts = [];
  const unreadable = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return { drafts, unreadable }; // drafts/ 不存在 = 无提案
  }
  for (const file of names) {
    const p = path.join(dir, file);
    try {
      const text = fs.readFileSync(p, 'utf8');
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(p).mtimeMs; } catch { /* 无 mtime 按不可老化处理 */ }
      const { meta, body } = parseCard(text, file);
      drafts.push({ id: typeof meta.id === 'string' ? meta.id : file.replace(/\.md$/, ''), file, path: p, meta, body, mtimeMs, text });
    } catch {
      unreadable.push(file);
    }
  }
  return { drafts, unreadable };
}

/**
 * goal 首行的分词 Jaccard 相似度（「标题相似」提示用）：标点/空白归一后按词集合算
 * 交并比。空集返回 0（不相似）。
 */
export function goalSimilarity(a, b) {
  const tokens = (s) =>
    new Set(
      String(s ?? '')
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, ' ')
        .trim()
        .split(' ')
        .filter(Boolean),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/**
 * 提案年龄（ms）：frontmatter created_at 优先，解析失败回落文件 mtime；两者都不可得
 * 返回 NaN（调用方按「不老化」保守处理）。
 */
export function draftAgeMs(draft, now) {
  const t = Date.parse(String(draft?.meta?.created_at ?? ''));
  if (Number.isFinite(t)) return now - t;
  if (Number.isFinite(draft?.mtimeMs) && draft.mtimeMs > 0) return now - draft.mtimeMs;
  return NaN;
}

/** frontmatter 注入 + 正文顶部说明行（annotateSuperseded / annotateAgedOut 共用手法）。
 *  无 frontmatter 的残缺文件原样返回（调用方不迁移不标注）。 */
function annotateCard(cardText, fmLines, note) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(cardText);
  if (!m) return cardText;
  const kept = m[1].split(/\r?\n/).filter((l) => !/^\s*superseded_(by|at)\s*:/.test(l));
  const fm = ['---', ...kept, ...fmLines, '---'].join('\n');
  return `${fm}\n\n${note}\n${m[2].replace(/^\r?\n+/, '')}`;
}

/** 在提案卡上标注合并卡：frontmatter 加 superseded_by/superseded_at 两键 + 正文顶部
 *  加说明行（人读）。 */
export function annotateSuperseded(cardText, mergedId, iso) {
  return annotateCard(
    cardText,
    [`superseded_by: ${mergedId}`, `superseded_at: ${iso}`],
    `> ⚠ 本提案已被合并任务 ${mergedId} 覆盖（${iso} 自动迁入 ${SUPERSEDED_DIR}/，以合并实现为准）。`,
  );
}

/** 超龄自动清退标注：superseded_by 用伪 id aged-out（区别于「被某合并卡覆盖」），
 *  说明行写明清退原因与恢复路径——人读第一眼能分辨这两种清退。 */
export function annotateAgedOut(cardText, iso) {
  return annotateCard(
    cardText,
    [`superseded_by: ${AGED_OUT_BY}`, `superseded_at: ${iso}`],
    `> ⏳ 本提案超龄未提交（${iso} 自动清退迁入 ${SUPERSEDED_DIR}/：队列无同名卡、非人工草稿；如需继续请移回 drafts/ 重新 submit）。`,
  );
}

/** 迁移单个提案到目标子目录（标注可选）：目标同名文件已存在 → 跳过（绝不覆盖，
 *  Windows rename 不越已有文件）。返回 { moved: true, to } 或 { moved: false, reason }。 */
function moveDraft(repoRoot, draft, subdir, { mergedId = null, agedOut = false, iso } = {}) {
  const dstDir = path.join(draftsRoot(repoRoot), subdir);
  const dst = path.join(dstDir, draft.file);
  try {
    if (fs.existsSync(dst)) return { moved: false, reason: `目标已存在：${dst}` };
    fs.mkdirSync(dstDir, { recursive: true });
    const text = mergedId
      ? annotateSuperseded(draft.text, mergedId, iso)
      : agedOut
        ? annotateAgedOut(draft.text, iso)
        : draft.text;
    fs.writeFileSync(dst, text);
    fs.rmSync(draft.path, { force: true });
    return { moved: true, to: dst };
  } catch (e) {
    return { moved: false, reason: String(e?.message ?? e) };
  }
}

/**
 * 生成 gc 清单（纯函数，不动文件）。
 * @param {Array<object>} drafts listDrafts().drafts
 * @param {Array<{id: string, filesHint: string[], goal: string}>} mergedCards merged/ 卡摘要
 * @param {{ now: number, archiveDays?: number, maxAgeDays?: number,
 *           queueTraced?: Set<string>|string[]|null }} opts
 *   queueTraced：队列全部状态已有痕迹的卡 id 集（老化自动档的保护闸）。null/缺省 =
 *   痕迹面不可知 → 超龄自动档整档关闭（清退是动作，宁少勿滥——调用方必须显式给痕迹集）。
 * @returns {{ superseded: Array<{draft, mergedId}>, agedUnsubmitted: Array<{draft, ageDays}>,
 *             aged: Array<{draft, ageDays}>, titleSimilar: Array<{draft, mergedId}> }}
 */
export function planGc(drafts, mergedCards, { now = Date.now(), archiveDays = DEFAULT_ARCHIVE_DAYS, maxAgeDays = DEFAULT_MAX_AGE_DAYS, queueTraced = null } = {}) {
  const list = Array.isArray(drafts) ? drafts : [];
  const merged = Array.isArray(mergedCards) ? mergedCards.filter((c) => c && typeof c.id === 'string') : [];
  const superseded = [];
  const agedUnsubmitted = [];
  const aged = [];
  const titleSimilar = [];
  const inSupersede = new Set();
  for (const d of list) {
    if (d?.meta?.superseded_by) continue; // 已标注的不回锅
    const hit = merged.find((c) => Array.isArray(c.filesHint) && pathsOverlap(c.filesHint, d.meta?.files_hint));
    if (hit) {
      superseded.push({ draft: d, mergedId: hit.id });
      inSupersede.add(d.file);
    }
  }
  // 老化自动档清单（nightly 清退的第二类）：超 maxAgeDays 且队列零痕迹的机器来源提案。
  // 与 superseded 独占（有明确合并卡定性的走定性标注），与 aged 独占（同一文件绝不进
  // 两个迁移清单——applyGc 顺序执行会把它同时写进 superseded/ 与 archived/）。
  const traced = queueTraced instanceof Set ? queueTraced : Array.isArray(queueTraced) ? new Set(queueTraced) : null;
  const maxMs = (Number.isInteger(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : DEFAULT_MAX_AGE_DAYS) * 86_400_000;
  const inAgedOut = new Set();
  if (traced) {
    for (const d of list) {
      if (inSupersede.has(d.file) || d?.meta?.superseded_by) continue;
      const age = draftAgeMs(d, now);
      if (!Number.isFinite(age) || age <= maxMs) continue;
      if (traced.has(d.id)) continue; // 队列任一状态有同名卡 → 提案已被提交/吸收，不动
      if (!isAutoProposal(d.meta)) continue; // 人工草稿（含 created_by 缺失/未知）不动
      agedUnsubmitted.push({ draft: d, ageDays: Math.floor(age / 86_400_000) });
      inAgedOut.add(d.file);
    }
  }
  const archiveMs = (Number.isInteger(archiveDays) && archiveDays > 0 ? archiveDays : DEFAULT_ARCHIVE_DAYS) * 86_400_000;
  for (const d of list) {
    if (inSupersede.has(d.file) || inAgedOut.has(d.file)) continue;
    const age = draftAgeMs(d, now);
    if (Number.isFinite(age) && age > archiveMs) aged.push({ draft: d, ageDays: Math.floor(age / 86_400_000) });
  }
  for (const d of list) {
    if (inSupersede.has(d.file) || d?.meta?.superseded_by) continue;
    for (const c of merged) {
      if (goalSimilarity(d.body?.goal, c.goal) >= TITLE_SIMILAR_THRESHOLD) {
        titleSimilar.push({ draft: d, mergedId: c.id });
        break; // 一条提案报一次足够
      }
    }
  }
  return { superseded, agedUnsubmitted, aged, titleSimilar };
}

/** 机器来源提案判定（老化自动档保护闸）：created_by ∈ planner/scanner；缺失/未知值
 *  按人工草稿处理（宁少勿滥）。 */
export function isAutoProposal(meta) {
  return AUTO_SOURCES.has(String(meta?.created_by ?? ''));
}

/** 队列痕迹面：7 个状态目录全部卡 id 集合 + specs/<id>/ 目录存在性。reviewing 也在内——
 *  「无任何队列痕迹」按全集保守判定（多查一个状态只会少清退，不会误杀）。specs 目录单独
 *  查：spec 拆出的卡 id 是 <specId>-tN，不在队列痕迹面与草稿 id 同名——specs/<specId>/
 *  存在即该草稿已被拆卡（设计/施工期间），不补这条 aged-out 会把活 spec 的草稿误清退。 */
export function collectTracedIds(root) {
  const ids = new Set();
  for (const s of STATES) {
    for (const id of listCards(root, s)) ids.add(id);
  }
  const specsDir = path.join(root, '.agents', 'orchestrator', 'specs');
  try {
    for (const e of fs.readdirSync(specsDir, { withFileTypes: true })) {
      if (e.isDirectory()) ids.add(e.name);
    }
  } catch { /* specs/ 不存在 = 从未拆过卡 */ }
  return ids;
}

/** merged/ 卡摘要（清退对照面）：损坏卡跳过。 */
export function mergedSummaries(root) {
  const out = [];
  for (const id of listCards(root, 'merged')) {
    try {
      const { meta, body } = parseCard(fs.readFileSync(cardPath(root, 'merged', id), 'utf8'), `${id}.md`);
      out.push({ id, filesHint: meta.files_hint ?? [], goal: body.goal ?? '' });
    } catch { /* 损坏卡不进对照面 */ }
  }
  return out;
}

/**
 * merge 时的自动 superseded（闭环内动作，无需 --apply）：与刚合并卡 files_hint 重叠的
 * 顶层提案迁入 drafts/superseded/ 并标注。尽力而为：任何失败只告警，绝不影响合并主流程。
 * @returns {Array<string>} 已迁移的提案文件名（调用方留痕/汇报）
 */
export function supersedeForMerged(repoRoot, { mergedId, filesHint, goal = '', now = Date.now() } = {}) {
  const iso = toIsoLocal(new Date(now));
  const moved = [];
  try {
    const { drafts } = listDrafts(repoRoot);
    const plan = planGc(drafts, [{ id: mergedId, filesHint: Array.isArray(filesHint) ? filesHint : [], goal }], { now });
    for (const { draft } of plan.superseded) {
      const r = moveDraft(repoRoot, draft, SUPERSEDED_DIR, { mergedId, iso });
      if (r.moved) moved.push(draft.file);
      else console.warn(`[orchestrator] 提案 ${draft.file} 迁入 ${SUPERSEDED_DIR}/ 失败（${r.reason}）——留原地待人工处理。`);
    }
  } catch (e) {
    console.warn(`[orchestrator] merge 后提案清退失败（不影响合并）：${String(e?.message ?? e)}`);
  }
  return moved;
}

/**
 * drafts gc 的 --apply 执行段：按 planGc 清单迁移（superseded 带合并卡标注、
 * agedUnsubmitted 带超龄清退标注——两者都进 superseded/，aged 原文迁移）。
 * @returns {{ movedSuperseded: Array<{file, to}>, movedAgedUnsubmitted: Array<{file, to}>,
 *             movedAged: Array<{file, to}>, failed: Array<{file, reason}> }}
 */
export function applyGc(repoRoot, plan, { now = Date.now() } = {}) {
  const iso = toIsoLocal(new Date(now));
  const movedSuperseded = [];
  const movedAgedUnsubmitted = [];
  const movedAged = [];
  const failed = [];
  for (const { draft, mergedId } of plan.superseded ?? []) {
    const r = moveDraft(repoRoot, draft, SUPERSEDED_DIR, { mergedId, iso });
    if (r.moved) movedSuperseded.push({ file: draft.file, to: r.to });
    else failed.push({ file: draft.file, reason: r.reason });
  }
  for (const { draft } of plan.agedUnsubmitted ?? []) {
    const r = moveDraft(repoRoot, draft, SUPERSEDED_DIR, { agedOut: true, iso });
    if (r.moved) movedAgedUnsubmitted.push({ file: draft.file, to: r.to });
    else failed.push({ file: draft.file, reason: r.reason });
  }
  for (const { draft } of plan.aged ?? []) {
    const r = moveDraft(repoRoot, draft, ARCHIVED_DIR, { iso });
    if (r.moved) movedAged.push({ file: draft.file, to: r.to });
    else failed.push({ file: draft.file, reason: r.reason });
  }
  return { movedSuperseded, movedAgedUnsubmitted, movedAged, failed };
}

/**
 * nightly 自动清退（老化自动档接线）：一个 nightly 周期执行一次保守两类清退——
 * superseded（files_hint 与 merged/ 卡重叠，真实实现已覆盖现场）+ 超龄未提交
 * （超 draftsGc.maxAgeDays 缺省 14 天、队列 7 状态零痕迹、机器来源）→ 都迁
 * drafts/superseded/。其余清单（aged → archived、titleSimilar）维持 report-only，
 * 只在 drafts gc 报告出现。draftsGc.autoSupersede=false 与合并时自动 supersede 同一
 * 总闸整体关闭。尽力而为：任何失败只告警，绝不影响 nightly 主流程。
 * @returns {{ superseded: string[], agedUnsubmitted: string[], failed: Array<{file, reason}> }}
 */
export function autoCleanDrafts(repoRoot, { now = Date.now() } = {}) {
  const done = { superseded: [], agedUnsubmitted: [], failed: [] };
  try {
    const gcCfg = loadWorkflowConfig(repoRoot).draftsGc ?? {};
    if (gcCfg.autoSupersede === false) return done;
    const { drafts } = listDrafts(repoRoot);
    if (!drafts.length) return done;
    const root = queueRoot(repoRoot);
    const plan = planGc(drafts, mergedSummaries(root), {
      now,
      maxAgeDays: gcCfg.maxAgeDays,
      queueTraced: collectTracedIds(root),
    });
    // 只放行两类保守清退；aged/titleSimilar 置空 = applyGc 对它们零动作（report-only）
    const r = applyGc(repoRoot, { ...plan, aged: [], titleSimilar: [] }, { now });
    return {
      superseded: r.movedSuperseded.map((m) => m.file),
      agedUnsubmitted: r.movedAgedUnsubmitted.map((m) => m.file),
      failed: r.failed,
    };
  } catch (e) {
    console.warn(`[orchestrator] drafts gc 自动清退失败（不影响巡检）：${String(e?.message ?? e)}`);
    return done;
  }
}

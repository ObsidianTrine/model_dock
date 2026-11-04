// drafts-gc.mjs — drafts/ 提案生命周期（B9，2026-11 定）：提案落盘后没有清退机制，
// drafts/ 只进不出（16 张积压实证，其中 ≥3 张已被 merged 工作覆盖）。生命周期两条：
//   1. 自动 superseded（闭环内动作，merge 即触发）：卡落 merged/ 时，drafts/ 里
//      files_hint 路径与刚合并卡重叠的提案自动迁入 drafts/superseded/ 并在文件头标注
//      合并卡 id——提案所针对的现场已被真实合并实现覆盖，继续留着会误导 planner 与
//      人工（「深化既有提案」会去深化一件已完成的事）。仅标题相似不迁（防误杀），
//      只在 drafts gc 报告中提示。
//   2. 老化（drafts gc 手动档）：drafts/ 中超 archiveDays（缺省 30 天）的提案在
//      `drafts gc --apply` 时迁入 drafts/archived/。
// 铁律：**不删任何文件，只迁移目录**；写不进/迁不动（目标已存在等）跳过并告警，
// 绝不阻断 merge 主流程。年龄口径：frontmatter created_at 解析优先，失败回落文件
// mtime，两者都不可得按「不老化」保守处理（宁少勿滥，与 autoresume cooldownPassed 同哲学）。

import fs from 'node:fs';
import path from 'node:path';
import { toIsoLocal } from './events.mjs';
import { parseCard } from './queue.mjs';

/** 提案迁移目标目录名（drafts/ 的子目录，listDrafts 只扫顶层 .md，不会重复收割）。 */
export const SUPERSEDED_DIR = 'superseded';
export const ARCHIVED_DIR = 'archived';
/** 老化阈值缺省（天）：workflow.json draftsGc.archiveDays 可调。 */
export const DEFAULT_ARCHIVE_DAYS = 30;
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

/** 在提案卡上标注合并卡：frontmatter 加 superseded_by/superseded_at 两键 + 正文顶部
 *  加说明行（人读）。无 frontmatter 的残缺文件原样返回（调用方不迁移不标注）。 */
export function annotateSuperseded(cardText, mergedId, iso) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(cardText);
  if (!m) return cardText;
  const kept = m[1].split(/\r?\n/).filter((l) => !/^\s*superseded_(by|at)\s*:/.test(l));
  const fm = ['---', ...kept, `superseded_by: ${mergedId}`, `superseded_at: ${iso}`, '---'].join('\n');
  const note = `> ⚠ 本提案已被合并任务 ${mergedId} 覆盖（${iso} 自动迁入 ${SUPERSEDED_DIR}/，以合并实现为准）。`;
  return `${fm}\n\n${note}\n${m[2].replace(/^\r?\n+/, '')}`;
}

/** 迁移单个提案到目标子目录（标注可选）：目标同名文件已存在 → 跳过（绝不覆盖，
 *  Windows rename 不越已有文件）。返回 { moved: true, to } 或 { moved: false, reason }。 */
function moveDraft(repoRoot, draft, subdir, { mergedId = null, iso } = {}) {
  const dstDir = path.join(draftsRoot(repoRoot), subdir);
  const dst = path.join(dstDir, draft.file);
  try {
    if (fs.existsSync(dst)) return { moved: false, reason: `目标已存在：${dst}` };
    fs.mkdirSync(dstDir, { recursive: true });
    const text = mergedId ? annotateSuperseded(draft.text, mergedId, iso) : draft.text;
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
 * @param {{ now: number, archiveDays?: number }} opts
 * @returns {{ superseded: Array<{draft, mergedId}>, aged: Array<{draft, ageDays}>, titleSimilar: Array<{draft, mergedId}> }}
 */
export function planGc(drafts, mergedCards, { now = Date.now(), archiveDays = DEFAULT_ARCHIVE_DAYS } = {}) {
  const list = Array.isArray(drafts) ? drafts : [];
  const merged = Array.isArray(mergedCards) ? mergedCards.filter((c) => c && typeof c.id === 'string') : [];
  const superseded = [];
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
  const archiveMs = (Number.isInteger(archiveDays) && archiveDays > 0 ? archiveDays : DEFAULT_ARCHIVE_DAYS) * 86_400_000;
  for (const d of list) {
    if (inSupersede.has(d.file)) continue;
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
  return { superseded, aged, titleSimilar };
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
 * drafts gc 的 --apply 执行段：按 planGc 清单迁移（superseded 带标注、aged 原文迁移）。
 * @returns {{ movedSuperseded: Array<{file, to}>, movedAged: Array<{file, to}>, failed: Array<{file, reason}> }}
 */
export function applyGc(repoRoot, plan, { now = Date.now() } = {}) {
  const iso = toIsoLocal(new Date(now));
  const movedSuperseded = [];
  const movedAged = [];
  const failed = [];
  for (const { draft, mergedId } of plan.superseded ?? []) {
    const r = moveDraft(repoRoot, draft, SUPERSEDED_DIR, { mergedId, iso });
    if (r.moved) movedSuperseded.push({ file: draft.file, to: r.to });
    else failed.push({ file: draft.file, reason: r.reason });
  }
  for (const { draft } of plan.aged ?? []) {
    const r = moveDraft(repoRoot, draft, ARCHIVED_DIR, { iso });
    if (r.moved) movedAged.push({ file: draft.file, to: r.to });
    else failed.push({ file: draft.file, reason: r.reason });
  }
  return { movedSuperseded, movedAged, failed };
}

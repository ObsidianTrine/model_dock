// research.mjs — 调研（Deep Research 式）的纯逻辑件，全部可单测：
//   parseBriefBlock    researcher 会话输出 → { id, title, body }（```agents-brief 契约块）
//   extractCitations   正文引用行提取（URL 列表，去重保序）
//   validateBriefBody  brief 正文校验：五段齐全 + 引用数达标（无引用即拒收——可对账底线）
//   writeBrief         落盘 research/<id>/（meta.json + brief.md）
//   writeBriefAuto     同 writeBrief，id 冲突自动派生 <id>-2…-9 落盘（同题重跑不裸崩）
//   readBrief/listBriefs
//   snapshotCitations  引用快照（Node 内建 fetch，逐条落 sources/<n>.txt，尽力而为不阻断）
// 设计：调研不是任务卡——没有 diff，不走施工队列/合并管线（queue.mjs 校验、classifyChange、
// files_hint 越界判定对它全是错配）。产物 = brief 文件，由卡的 research: <id> 字段引用，
// spec/propose 消费。docs 10.12。

import fs from 'node:fs';
import path from 'node:path';
import { toIsoLocal } from './events.mjs';

/** researcher 输出契约的 fenced block 标记（prompt.mjs buildResearchPrompt 同款）。 */
export const BRIEF_MARKER = 'agents-brief';

/** brief 正文五段（产出契约固定段；校验按标题行匹配，段内自由文本）。 */
export const BRIEF_SECTIONS = ['结论', '选项对比', '引用', '建议', '罗盘对齐'];

/** 引用行 URL 识别（http/https；引用行形如 `- 2026-11-08 https://... — 一句话依据`）。
 *  排除集含中英文常用标点——中文句读紧贴 URL 是常态（「见 https://a.com/x。另有」）。 */
const URL_RE = /https?:\/\/[^\s)）\]。，、；！？;,!?]+/g;

export function researchDir(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'research');
}

export function briefDir(repoRoot, id) {
  return path.join(researchDir(repoRoot), id);
}

/**
 * 从 researcher 输出提取 brief 契约块。块内首两行须是 `id:` / `title:`（spec 契约同款），
 * 其余为正文。找不到块或 meta 缺失返回 null（调用方喂回重试）。
 */
export function parseBriefBlock(text) {
  const re = new RegExp('```' + BRIEF_MARKER + '\\s*\\n([\\s\\S]*?)\\n```');
  const m = re.exec(text ?? '');
  if (!m) return null;
  const raw = m[1];
  const id = /^id:\s*(.+)$/m.exec(raw)?.[1]?.trim();
  const title = /^title:\s*(.+)$/m.exec(raw)?.[1]?.trim();
  if (!id || !title) return null;
  // 去掉 meta 两行，剩余即正文（首部空行折叠）
  const body = raw
    .replace(/^id:\s*.+\s*$/m, '')
    .replace(/^title:\s*.+\s*$/m, '')
    .replace(/^\s*\n/, '')
    .trim();
  return { id, title: title.trim(), body };
}

/** 正文引用提取：URL 去重保序。 */
export function extractCitations(body) {
  const out = [];
  for (const m of String(body ?? '').matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;、。]+$/, '');
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * 带访问日期的引用行提取（gate 计数口径，2026-11 编造引用防线）：
 * 契约格式 `- YYYY-MM-DD <URL> — 来源名：一句话依据`。裸 URL 行不计入——
 * 「引用日期」是本次会话访问证据的时刻，缺失/陈旧/未来都是编造信号（真实首跑实证：
 * 模型曾把 2023 年训练先验写进 2026 年的「当前流行度」调研且引用日期全编成 2023）。
 */
export function extractDatedCitations(body) {
  const out = [];
  for (const m of String(body ?? '').matchAll(/^-\s*(\d{4}-\d{2}-\d{2})\s+(https?:\/\/[^\s)）\]。，、；！？;,!?]+)/gm)) {
    const url = m[2].replace(/[.,;、。]+$/, '');
    if (!out.some((c) => c.url === url)) out.push({ date: m[1], url });
  }
  return out;
}

/**
 * brief 正文校验：五段标题齐全 + 带当日访问日期的引用 ≥ minCitations + 日期合理性。
 * 无引用即拒收（调研的可对账底线）；引用行必须以访问日期开头（`- YYYY-MM-DD <URL> …`）：
 *   - 未来日期 → 拒收（编造信号）；
 *   - 距 today 超过 7 天（跨午夜容忍窗）→ 拒收（陈旧日期 = 拿旧数据冒充本次核查，
 *     2026-11-08 首跑实证：引用日期全部编成 2023 年）。
 * opts.today 注入 'YYYY-MM-DD' 供测试固定时钟；缺省取当前本地日期。
 */
export function validateBriefBody(body, { minCitations = 1, today = toIsoLocal().slice(0, 10) } = {}) {
  const text = String(body ?? '');
  for (const s of BRIEF_SECTIONS) {
    if (!new RegExp(`^#\\s*${s}\\s*$`, 'm').test(text)) {
      throw new Error(`brief 缺少「# ${s}」段——产出契约五段齐全（${BRIEF_SECTIONS.join('/')}），请补段后重试。`);
    }
  }
  const dated = extractDatedCitations(text);
  if (dated.length < minCitations) {
    throw new Error(`brief 引用数不足：带访问日期的引用 ${dated.length} 条，要求 ≥${minCitations}——# 引用 段每行必须以本次访问日期开头（"- ${today} <URL> — 来源名：依据"，裸 URL 行不计入），无引用的调研不可对账，一律拒收。`);
  }
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  for (const c of dated) {
    const dMs = Date.parse(`${c.date}T00:00:00Z`);
    if (!Number.isFinite(dMs)) {
      throw new Error(`引用日期不合法："${c.date}"（${c.url}）——访问日期必须是 YYYY-MM-DD 格式，请修正后重试。`);
    }
    if (dMs > todayMs + 86_400_000) {
      throw new Error(`引用日期在未来："${c.date}"（${c.url}）——今天才 ${today}，未来日期是编造信号，一律拒收。`);
    }
    if (todayMs - dMs > 7 * 86_400_000) {
      throw new Error(`引用访问日期陈旧："${c.date}"（${c.url}）——今天是 ${today}，访问日期必须 ≈本次会话当日（容忍跨午夜 7 天）；陈旧日期 = 拿旧数据冒充本次核查，拒收后请重新检索并如实填当日日期。`);
    }
  }
  return { citations: dated.map((c) => c.url) };
}

/**
 * brief 落盘：research/<id>/{meta.json, brief.md}。同 id 已存在则抛错（brief 是证据
 * 产物，不允许静默覆盖——深化调研用新 id 或人工删旧目录）。
 */
export function writeBrief(repoRoot, { id, title, question, backend, body }) {
  validateBriefBody(body);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`brief id "${id}" 不合法：只允许小写字母/数字/短横线。`);
  }
  const dir = briefDir(repoRoot, id);
  if (fs.existsSync(dir)) {
    throw new Error(`brief id "${id}" 已存在（${dir}）——同名调研请换 id 或人工删除旧目录后再跑。`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const meta = { id, title, question: String(question ?? '').slice(0, 500), backend: backend ?? null, created_at: toIsoLocal() };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, 'brief.md'), `${body.trim()}\n`);
  return dir;
}

/**
 * brief 落盘（id 冲突自动派生，2026-11-08 P1-④）：args 同 writeBrief。id 已存在时不抛错，
 * 自动派生 `<id>-2`…`<id>-9` 逐个找空位落盘——同一问题短间隔重跑是常态（网关抖动重试、
 * 人工复跑），id 派生比裸崩或人肉改名都便宜。返回 { dir, id }（id = 实际落盘 id，
 * 调用方的回执/引用/快照一律用它，绝不能用模型自报的原 id）；9 个候选全占用抛可操作报错。
 */
export function writeBriefAuto(repoRoot, args) {
  const candidates = [args.id, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${args.id}-${n}`)];
  for (const id of candidates) {
    if (!fs.existsSync(briefDir(repoRoot, id))) {
      const dir = writeBrief(repoRoot, { ...args, id }); // 校验与落盘复用 writeBrief（id 格式、原子目录、meta 契约同源）
      return { dir, id };
    }
  }
  throw new Error(
    `brief id "${args.id}" 及派生位 -2…-9 已全部占用（${researchDir(repoRoot)}）——同一问题已连跑 9 次。` +
    `先 research list 清点旧 brief，人工归档（移出 research/ 目录）或删除不再需要的后再跑；或换更具体的问题表述让模型生成新 id。`,
  );
}

/** 读单个 brief：{ dir, meta, body, citations }；不存在返回 null。 */
export function readBrief(repoRoot, id) {
  const dir = briefDir(repoRoot, id);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) return null;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const body = fs.readFileSync(path.join(dir, 'brief.md'), 'utf8');
  return { dir, meta, body, citations: extractCitations(body) };
}

export function listBriefs(repoRoot) {
  const dir = researchDir(repoRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'meta.json')))
    .map((e) => e.name)
    .sort();
}

/**
 * 引用快照（对账材料）：逐条 GET 引用 URL，响应文本截断落 research/<id>/sources/<n>.txt。
 * 尽力而为：单条失败/超时只记 failure，绝不抛错——快照缺席不否定 brief（引用本身已在
 * brief.md 里）；上限 max 条（防引用面失控）。fetchImpl 注入供测试。
 */
export async function snapshotCitations(repoRoot, id, { fetchImpl = globalThis.fetch, timeoutMs = 15_000, max = 8 } = {}) {
  const brief = readBrief(repoRoot, id);
  if (!brief) return { ok: [], failed: [] };
  const sourcesDir = path.join(brief.dir, 'sources');
  const ok = [];
  const failed = [];
  for (const [i, url] of brief.citations.slice(0, max).entries()) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      fs.mkdirSync(sourcesDir, { recursive: true });
      fs.writeFileSync(path.join(sourcesDir, `${i + 1}.txt`), `url: ${url}\nfetched_at: ${toIsoLocal()}\n\n${text.slice(0, 200_000)}`);
      ok.push(url);
    } catch (e) {
      failed.push({ url, reason: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return { ok, failed };
}

// ---------------------------------------------------------------------------
// 可信度判定（2026-11-08 设计，问题无关）：L1 快照回查（纯规则）→ L2 异构复核（LLM
// 按需）→ L3 按模型建档核实率。原则：形态 ≠ 真实（判据回到证据本身）、确定性优先于
// LLM 自评、单次打分不如历史校准。三次真实事故的映射：①日期编造→L0 已拦；②真 URL
// 假依据→L1 数字回查拦；③模型接地能力差→L3 建档淘汰。
// ---------------------------------------------------------------------------

/** L2 复核会话输出契约的 fenced block 标记。 */
export const VERDICT_MARKER = 'agents-verdict';

/**
 * 从 brief 结论/选项对比提取可回查 token（数字+单位、拉丁字母数字混合的型号名）。
 * 只取「# 引用」段之前——引用段自身含日期与 URL，回查它们是自指。排除项：年份
 * （训练先验高发区，且页面必有——回查无区分度）、纯 1-2 位无单位数字（序号/日期碎片）。
 */
export function extractClaimTokens(body) {
  const text = String(body ?? '').split(/^#\s*引用\s*$/m)[0] ?? '';
  const tokens = new Set();
  for (const m of text.matchAll(/(?:\$)?\d[\d,，.]*\s*(?:T|万亿|亿|万|M|B|K|%|％|分|倍|美元|次|名|个|年|家|席)?/g)) {
    let t = m[0].replace(/[\s，,]+/g, '');
    if (!t) continue;
    if (/20\d{2}/.test(t)) continue; // 年份/日期片段：无区分度
    if (/^\d{1,2}$/.test(t)) continue; // 序号/碎片
    tokens.add(t);
  }
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9.+-]*\d[A-Za-z0-9.+-]*/g)) {
    if (m[0].length >= 3) tokens.add(m[0]); // 型号名（GPT-6、Opus 5.5、V4.1、K3.1）
  }
  return [...tokens].slice(0, 40);
}

/**
 * L1 数字回查：结论里的可回查 token 是否真的出现在其所引来源的快照文本里。
 * 快照 0 份 = 无法回查（网络问题 ≠ 编造，不计分母、单独报 unknown）。
 * 真实事故锚定：2026-11-08 二跑「真 URL 假依据」——brief 声称的 56.5T 在其所引
 * lmsys.org 首页快照里不存在，本法一抓一个准。
 */
export function crossCheckClaims(briefBody, sources) {
  const tokens = extractClaimTokens(briefBody);
  const texts = (sources ?? []).map((s) => String(s.text ?? ''));
  if (!tokens.length) return { checked: 0, hits: 0, hit_rate: null, misses: [], tokens };
  if (!texts.length) return { checked: 0, hits: 0, hit_rate: null, misses: [], tokens };
  let hits = 0;
  const misses = [];
  for (const t of tokens) {
    const needle = t.replace(/[，,]/g, '');
    const found = texts.some((txt) => txt.includes(needle) || txt.replace(/[，,]/g, '').includes(needle));
    if (found) hits++;
    else misses.push(t);
  }
  return { checked: tokens.length, hits, hit_rate: hits / tokens.length, misses, tokens };
}

/** L1 引用深度比：根路径引用（https://lmsys.org/）占比是红旗——真实数据页几乎都是深链。 */
export function citationDepthStats(body) {
  const dated = extractDatedCitations(body);
  const urls = dated.length ? dated.map((c) => c.url) : extractCitations(body);
  let deep = 0;
  let root = 0;
  for (const u of urls) {
    try {
      const p = new URL(u).pathname.replace(/\/+$/, '');
      if (p) deep++;
      else root++;
    } catch {
      root++;
    }
  }
  return { deep, root, total: urls.length, ratio: urls.length ? deep / urls.length : null };
}

// ---------------------------------------------------------------------------
// verdict.json/2（2026-11-08 v3 方案）：回答的不是「这份调研多可信」，而是
// 「核了多少（coverage）、哪条不可信（claim 级状态 + 否决权）、按用途能不能用
// （usage 矩阵）、谁还得签字（external_doc → human）」——agent 决策接口。
// 原则：分数必须从逐条 claim 聚合（不允许 LLM 直接拍分）、null 传染（不可核 ≠ 0 分）、
// 否决权与覆盖下限写死不可配（防配置放水）、usage=ok 不绕过 spec/合并闸门（advisory）。
// 消费方契约文档：.agents/docs/research-verdict.md
// ---------------------------------------------------------------------------

export const VERDICT_SCHEMA = 'modeldock.research.verdict/2';
export const CLAIM_STATUSES = ['supported', 'partial', 'unsupported', 'contradicted', 'unverifiable'];

/** usage 矩阵的硬底线（不可配置——可配的只有 workflow.json research.usageGates 阈值）。 */
export const COVERAGE_FLOOR = 50;

/** 空白归一（逐字校验的宽容面：跨行/多空格不算改写）。 */
export function normalizeClaimText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * claim 逐字校验（v3 关键防线）：L2 输出的每条 claim 必须逐字摘自 brief 原文——
 * 改写/概括/无中生有即判 fabricated 丢弃并计数（引用层编造问题的评分层重演，此处拦）。
 */
export function verifyClaimVerbatim(claims, briefBody) {
  const brief = normalizeClaimText(briefBody);
  const valid = [];
  const fabricated = [];
  for (const c of claims ?? []) {
    const text = normalizeClaimText(c?.claim);
    if (text && text.length <= 120 && brief.includes(text)) valid.push({ ...c, claim: text });
    else fabricated.push((text || '(空)').slice(0, 80));
  }
  return { valid, fabricated };
}

/**
 * L2 note-status 一致性降级（2026-11-08 三跑事故）：模型判 supported 却在 note 里自认
 * 「无快照/无直据/无法对账」——自相矛盾即不可信，按 note 关键词降级为 unsupported
 * （note 保留、downgraded: true 留痕）。放在 L1 自动标注之前：L1 确定性回查仍可凭
 * 快照证据把真 supported 判回来。
 */
const CLAIM_NOTE_DOWNGRADE_RE = /(无快照|快照缺失|快照仅|快照只|未提供|无任何直据|无直据|不可见|截断|无法对账|无出处|查无)/;
export function normalizeClaimStatuses(claims) {
  if (!Array.isArray(claims)) return [];
  return claims.map((c) =>
    c?.status === 'supported' && CLAIM_NOTE_DOWNGRADE_RE.test(String(c?.note ?? ''))
      ? { ...c, status: 'unsupported', downgraded: true }
      : c,
  );
}

/** L0 引用面分（0-100 或 null）：当日引用率 / 深链比 / 快照成功率 三分量等权，缺项重归一。 */
export function scoreCitation({ datedCount, totalCitations, deep, totalUrls, snapOk, snapTotal }) {
  const parts = [];
  if (totalCitations > 0) parts.push(datedCount / totalCitations);
  if (totalUrls > 0 && deep != null) parts.push(deep / totalUrls);
  if (snapTotal > 0) parts.push(snapOk / snapTotal);
  if (!parts.length) return null;
  return Math.round((parts.reduce((s, v) => s + v, 0) / parts.length) * 100);
}

/** claim 状态聚合分：supported=1 / partial=0.5 / unsupported·contradicted=0；unverifiable 不计（由 coverage 表达）。 */
function aggregateCoherence(claims) {
  const checked = claims.filter((c) => c.status !== 'unverifiable');
  if (!checked.length) return null;
  const w = { supported: 1, partial: 0.5, unsupported: 0, contradicted: 0 };
  return Math.round((checked.reduce((s, c) => s + (w[c.status] ?? 0), 0) / checked.length) * 100);
}

/**
 * v3 核心（纯函数，全单测）：
 *   - coverage = 已核承重结论 / 总承重结论（unverifiable 拖 coverage 不拖 coherence）
 *   - overall = 各非 null 维度加权（evidence .4 / coherence .35 / citation .15 / coverage .10），缺维重归一；
 *     evidence 或 coverage 或 coherence 为 null → overall null（不可伪装成判断）
 *   - usage 决策矩阵：contradicted 一票否决 unsafe；fabricated>0 封顶 needs_review；
 *     维度缺失 → undetermined；阈值来自 gates（可配），否决权与 COVERAGE_FLOOR 不可配
 */
export function scoreVerdict({ claims, fabricatedCount = 0, citation, evidence, gates = {} } = {}) {
  claims = Array.isArray(claims) ? claims : [];
  const total = claims.length;
  const checked = claims.filter((c) => c.status !== 'unverifiable');
  const coverage = total ? Math.round((checked.length / total) * 100) : null;
  const coherence = aggregateCoherence(claims);
  const contradicted = claims.filter((c) => c.status === 'contradicted');
  const veto = contradicted.length > 0;

  const dims = { citation: citation ?? null, evidence: evidence ?? null, coherence, coverage };
  const weights = { evidence: 0.4, coherence: 0.35, citation: 0.15, coverage: 0.1 };
  const present = Object.entries(dims).filter(([, v]) => v != null);
  const overall = (dims.evidence == null || coverage == null || coherence == null) || !present.length
    ? null
    : Math.round(present.reduce((s, [k, v]) => s + weights[k] * v, 0) / present.reduce((s, [k]) => s + weights[k], 0));

  const dg = gates.decision ?? {};
  const eg = gates.external ?? {};
  const dCoh = Number.isInteger(dg.coherence) ? dg.coherence : 60;
  const dCov = Number.isInteger(dg.coverage) ? dg.coverage : COVERAGE_FLOOR;
  const eCoh = Number.isInteger(eg.coherence) ? eg.coherence : 75;
  const eCov = Number.isInteger(eg.coverage) ? eg.coverage : 70;
  const evidenceFail = evidence != null && evidence < 40;

  let decision;
  if (veto) decision = 'unsafe';
  else if (fabricatedCount > 0 && total === 0) decision = 'needs_review'; // claims 全灭 + 编造红旗：复核契约被违反，不是「没测」
  else if (evidence == null || coverage == null || coherence == null) decision = 'undetermined';
  else if (coverage >= Math.max(dCov, COVERAGE_FLOOR) && coherence >= dCoh && !evidenceFail) decision = 'ok';
  else decision = 'needs_review';
  if (decision === 'ok' && fabricatedCount > 0) decision = 'needs_review'; // 编造 claim 红旗：封顶 needs_review

  let external;
  if (decision === 'unsafe') external = 'unsafe';
  else if (decision !== 'ok') external = 'undetermined';
  else external = coherence >= eCoh && coverage >= Math.max(eCov, COVERAGE_FLOOR) ? 'ok' : 'needs_review';

  const level = overall == null ? 'unknown' : overall >= 75 ? 'pass' : overall >= 50 ? 'warn' : 'fail';
  return {
    scores: { ...dims, overall },
    usage: { browse: 'ok', internal_decision: decision, external_doc: external },
    veto,
    contradicted_count: contradicted.length,
    level,
  };
}

/** 读已落盘的快照（sources/*.txt，首行 url: …）→ [{ url, text }]。 */
export function loadSnapshots(repoRoot, id) {
  const dir = path.join(briefDir(repoRoot, id), 'sources');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const url = /^url:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? f;
    out.push({ url, text: raw });
  }
  return out;
}

/** L1 总入口：读 brief + 快照 → verdict/2（L1-only：claims 空 → coverage/coherence null → 决策 undetermined）落盘。 */
export function assessBrief(repoRoot, id, { model } = {}) {
  const brief = readBrief(repoRoot, id);
  if (!brief) return null;
  const snapshots = loadSnapshots(repoRoot, id);
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
  const { scores, usage, level } = scoreVerdict({ claims: [], fabricatedCount: 0, citation, evidence });
  const reasons = [];
  if (!snapshots.length) reasons.push('快照 0 份成功——L1 无法回查（网络/拦截原因，不计为编造）');
  else if (!claimCheck.checked) reasons.push('结论中无可回查的数字/型号 token——L1 不适用');
  else {
    reasons.push(`数字回查 ${claimCheck.hits}/${claimCheck.checked}（${Math.round(claimCheck.hit_rate * 100)}%）`);
    if (claimCheck.misses?.length) reasons.push(`未命中 token：${claimCheck.misses.slice(0, 6).join(', ')}${claimCheck.misses.length > 6 ? '…' : ''}`);
  }
  reasons.push('未跑 L2 复核（research verify <brief-id>）——claim 级覆盖与一致性未判定，internal_decision=undetermined');
  const verdict = {
    schema: VERDICT_SCHEMA,
    advisory: true,
    brief_id: id,
    model: model ?? brief.meta.backend ?? null,
    created_at: toIsoLocal(),
    scores,
    claims: [],
    blockers: [],
    fabricated_claims: 0,
    usage,
    level,
    reasons,
  };
  fs.writeFileSync(path.join(brief.dir, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
  return verdict;
}

/** L3 台账：每次判定（L1/L2）追加一行——信任按 模型×引擎 攒统计量（drift 保险丝同哲学）。 */
export function appendResearchLedger(repoRoot, entry) {
  const file = path.join(researchDir(repoRoot), 'ledger.jsonl');
  fs.mkdirSync(researchDir(repoRoot), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts: toIsoLocal(), ...entry })}\n`);
  return file;
}

/** L3 读台账 → 按调研船模型聚合：n / L1 平均核实率 / 判级分布。L2 条目的调研船在 researcher_model（model 是复核船）；旧条目无 researcher_model 回退 model。 */
export function readLedgerStats(repoRoot) {
  const file = path.join(researchDir(repoRoot), 'ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  const byModel = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      const key = `${e.researcher_model ?? e.model ?? '?'}`;
      const agg = byModel.get(key) ?? { model: key, runs: 0, levels: {}, hit_rates: [] };
      agg.runs++;
      agg.levels[e.level ?? '?'] = (agg.levels[e.level ?? '?'] ?? 0) + 1;
      if (typeof e.hit_rate === 'number') agg.hit_rates.push(e.hit_rate);
      byModel.set(key, agg);
    } catch { /* 损坏行跳过 */ }
  }
  return [...byModel.values()].map((a) => ({
    model: a.model,
    runs: a.runs,
    levels: a.levels,
    avg_hit_rate: a.hit_rates.length ? a.hit_rates.reduce((s, v) => s + v, 0) / a.hit_rates.length : null,
  }));
}

/**
 * 解析 L2 复核输出（agents-verdict 契约块，v2 = JSON：claims + blockers）；缺失/不合法
 * 返回 null（调用方喂回重试）。claim 状态必须落在 CLAIM_STATUSES 枚举内——逐字校验由
 * verifyClaimVerbatim 在调用方做（需要 brief 原文）。
 */
export function parseVerdictBlock(text) {
  const re = new RegExp('```' + VERDICT_MARKER + '\\s*\\n([\\s\\S]*?)\\n```');
  const m = re.exec(text ?? '');
  if (!m) return null;
  let j;
  try {
    j = JSON.parse(m[1].trim());
  } catch {
    return null;
  }
  if (!Array.isArray(j.claims) || !j.claims.length) return null;
  if (j.claims.length > 10) return null;
  const claims = [];
  for (const c of j.claims) {
    if (typeof c?.claim !== 'string' || !c.claim.trim()) return null;
    if (!CLAIM_STATUSES.includes(c?.status)) return null;
    claims.push({ claim: c.claim, status: c.status, note: typeof c?.note === 'string' ? c.note.slice(0, 200) : '' });
  }
  const blockers = Array.isArray(j.blockers) ? j.blockers.filter((b) => typeof b === 'string' && b.trim()).slice(0, 10) : [];
  return { claims, blockers };
}

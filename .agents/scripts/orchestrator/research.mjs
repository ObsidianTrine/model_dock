// research.mjs — 调研（Deep Research 式）的纯逻辑件，全部可单测：
//   parseBriefBlock    researcher 会话输出 → { id, title, body }（```agents-brief 契约块）
//   extractCitations   正文引用行提取（URL 列表，去重保序）
//   validateBriefBody  brief 正文校验：五段齐全 + 引用数达标（无引用即拒收——可对账底线）
//   writeBrief         落盘 research/<id>/（meta.json + brief.md）
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
 * brief 正文校验：五段标题齐全 + 引用段 URL 数 ≥ minCitations。
 * 无引用即拒收（调研的可对账底线——结论必须可溯源，AGENTS.md 错误信息风格：附修复建议）。
 */
export function validateBriefBody(body, { minCitations = 1 } = {}) {
  const text = String(body ?? '');
  for (const s of BRIEF_SECTIONS) {
    if (!new RegExp(`^#\\s*${s}\\s*$`, 'm').test(text)) {
      throw new Error(`brief 缺少「# ${s}」段——产出契约五段齐全（${BRIEF_SECTIONS.join('/')}），请补段后重试。`);
    }
  }
  const citations = extractCitations(text);
  if (citations.length < minCitations) {
    throw new Error(`brief 引用数不足：找到 ${citations.length} 条，要求 ≥${minCitations}——结论必须带来源（# 引用 段每行一条 URL + 日期 + 一句话依据），无引用的调研不可对账，一律拒收。`);
  }
  return { citations };
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

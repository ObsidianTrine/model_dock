// research.mjs — 调研（Deep Research 式）的纯逻辑件，全部可单测：
//   parseBriefBlock    researcher 会话输出 → { id, title, body }（```agents-brief 契约块）
//   extractCitations   正文引用行提取（URL 列表，去重保序）
//   validateBriefBody  brief 正文校验：五段齐全 + 引用数达标（无引用即拒收——可对账底线）
//   writeBrief         落盘 research/<id>/（meta.json + brief.md）
//   writeBriefAuto     同 writeBrief，id 冲突自动派生 <id>-2…-9 落盘（同题重跑不裸崩）
//   readBrief/listBriefs
//   snapshotCitations  引用快照（Node 内建 fetch，并发小池 + 瞬时类重试，按分类落
//                      sources/<n>.txt 头行元数据，尽力而为不阻断；镜像回退 opt-in）
//   topic 一族          research multi 的复合清单（topics/<topic-id>.json：dims + rollup），
//                      slugifyTopic/deriveTopicId/readTopic/writeTopic/writeTopicAuto/
//                      rollupTopicVerdict/buildTopicSpecSections（spec 注入展开）
// 设计：调研不是任务卡——没有 diff，不走施工队列/合并管线（queue.mjs 校验、classifyChange、
// files_hint 越界判定对它全是错配）。产物 = brief 文件，由卡的 research: <id> 字段引用，
// spec/propose 消费。docs 10.12。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
 * topicId/dim（可选，research multi 每维 brief 的溯源字段）：写进 meta.json 的
 * topic_id/dim——旧 meta 无此字段，读方一律可选拿取（向后兼容）。
 */
export function writeBrief(repoRoot, { id, title, question, backend, body, topicId, dim }) {
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
  if (topicId) meta.topic_id = topicId;
  if (dim) meta.dim = dim;
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

// ---------------------------------------------------------------------------
// topic（research multi，2026-11-09）：一个主题 × N 个维度 = N 份 brief + 1 份复合清单。
// topics/<topic-id>.json 收纳每维 brief id 与判定，rollup 给消费方一个单一决策接口
// （internal_decision 最差档）。topics/ 是 research/ 的子目录且无 meta.json——listBriefs
// 天然不收录（回归测试钉住）；单 brief 契约与 verify 路径对 topic 无感知。
// ---------------------------------------------------------------------------

/**
 * 拆维规划输出解析（sail researchAutoDim，2026-11-10 P3；prompt 契约见 prompt.mjs
 * buildResearchDimsPrompt）：模型输出 2–4 个短维度、每行一个。容忍 ```agents-dims```
 * 或普通 ``` 围栏包裹（有围栏取首个围栏内容，无围栏取全文）、容忍行首序号/项目符号
 * （输出里存在带序号/符号的行时只取这类行——「维度如下」式前导白话不混入维度清单）。
 * 剔除空行/标题行/围栏残留行与超长行（一句话解释混入的高发形态）；精确去重保序。
 * 不足 2 维返回 null（调用方降级单 brief）；超 4 维截断（契约上限，防跑飞）。
 */
export function parseDimsPlan(text) {
  const raw = String(text ?? '');
  const fence = /```[^\n]*\n([\s\S]*?)\n```/.exec(raw);
  const body = fence ? fence[1] : raw;
  const MARK_RE = /^\s*(?:[-*•]|\d+[.、)．]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/;
  const seen = new Set();
  const all = [];
  const marked = [];
  for (const line of body.split(/\r?\n/)) {
    const hasMark = MARK_RE.test(line);
    const dim = line.replace(MARK_RE, '').trim();
    if (!dim || dim === '```' || dim.startsWith('#')) continue;
    if (dim.length > 40) continue; // 一句话解释混进来的概率高——按非维度行丢弃
    if (seen.has(dim)) continue;
    seen.add(dim);
    all.push(dim);
    if (hasMark) marked.push(dim);
  }
  const dims = (marked.length >= 2 ? marked : all).slice(0, 4);
  return dims.length >= 2 ? dims : null;
}

/** topic.json 落盘路径：research/topics/<topic-id>.json。 */
export function topicPath(repoRoot, topicId) {
  return path.join(researchDir(repoRoot), 'topics', `${topicId}.json`);
}

/**
 * 主题文本 → topic-id slug（与 brief id 同规：小写字母/数字/短横线，TASK_ID_RE 兼容）。
 * 中文主题会大量折叠成短横线（「LLM 输出可信度判定机制的业界现状」→ llm、纯中文 → topic）
 * ——折叠后信息量近零、不同主题高频同 slug，可读性与唯一性双差。短 slug（<6 字符，含兜底
 * topic）追加原主题归一化文本（trim 后原文）的 sha256 前 8 位十六进制哈希尾（llm →
 * llm-1a2b3c4d）：同输入恒同哈希（确定性可复现），不同主题几乎必然不同尾——保唯一性与
 * 可溯源性；长 slug（≥6）信息量足够，保持原样不加尾。同 slug 的不同主题靠 deriveTopicId
 * 的 -2…-9 派生兜底语义不变；截断 48 字符防目录名失控。
 */
export function slugifyTopic(text) {
  const raw = String(text ?? '').trim();
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  const slug = s || 'topic';
  if (slug.length >= 6) return slug; // 长 slug 不加哈希尾
  // 哈希输入用 trim 后原文（utf8）：跨平台确定（Buffer/hex 与平台无关），同输入同 id
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

/**
 * topic-id 冲突自动派生（同 writeBriefAuto 思路）：slug 已占用 → -2…-9 逐个找空位，
 * 9 个全占用抛可操作报错。返回实际可用 topic-id。
 */
export function deriveTopicId(repoRoot, slug) {
  const candidates = [slug, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${slug}-${n}`)];
  for (const id of candidates) {
    if (!fs.existsSync(topicPath(repoRoot, id))) return id;
  }
  throw new Error(
    `topic-id "${slug}" 及派生位 -2…-9 已全部占用（${path.join(researchDir(repoRoot), 'topics')}）——` +
    `同一主题已连跑 10 次。请人工归档（移出 topics/ 目录）或换更具体的主题表述后再跑。`,
  );
}

/** 读 topic.json：不存在或形状不对（无 dims 数组）返回 null（verify 回落单 brief 路径）。 */
export function readTopic(repoRoot, topicId) {
  const file = topicPath(repoRoot, topicId);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`topic 文件损坏（${file}）：${e.message}——修复或删除该文件后重试。`);
  }
  if (!parsed || parsed.id !== topicId || !Array.isArray(parsed.dims)) return null;
  return parsed;
}

/** topic.json 落盘（research/topics/ 自动建目录；纯 JSON 证据文件，与 meta.json 同风格直写）。
 *  覆盖写语义：verify 更新既有 topic.json 用它；创建场景（research multi 收尾）用 writeTopicAuto。 */
export function writeTopic(repoRoot, topic) {
  const file = topicPath(repoRoot, topic.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(topic, null, 2)}\n`);
  return file;
}

/**
 * topic.json 落盘（创建场景 + 同名竞态复检，2026-11-09 P2）：deriveTopicId 是 check-then-write——
 * 两个同主题 multi 并行可能都通过 derive 检查，收尾落盘时互覆对方的清单。这里在落盘瞬间复检：
 * 'wx' 排他创建把「检查 + 写入」合成一次原子操作（复检自身的 TOCTOU 窗口一并消灭），已占用
 * 则续派 -2…-9 找空位。取舍：不做跨进程文件锁（复杂度与收益不成比例，竞态窗口只在同主题
 * 恰好并行时出现）；派生后 id 可能与维 brief id 命名空间（<原-id>-d<N>）错位——竞态撞上时清单
 * id 平移后缀、brief meta 的 topic_id 溯源留在原命名空间，可接受（好过静默互覆）。
 * 返回 { file, id }（id = 实际落盘 id，回执/通知一律用它）；9 个派生位全占用抛可操作报错
 * （循环安全退出：候选有限，deriveTopicId 同款报错口径）。
 */
export function writeTopicAuto(repoRoot, topic) {
  const candidates = [topic.id, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${topic.id}-${n}`)];
  for (const id of candidates) {
    const file = topicPath(repoRoot, id);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ ...topic, id }, null, 2)}\n`, { flag: 'wx' });
      return { file, id };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e; // 非「已存在」的 IO 错误原样上抛
    }
  }
  throw new Error(
    `topic-id "${topic.id}" 及派生位 -2…-9 已全部占用（${path.join(researchDir(repoRoot), 'topics')}）——` +
    `同一主题已连跑 10 次。请人工归档（移出 topics/ 目录）或换更具体的主题表述后再跑。`,
  );
}

/** rollup 聚合的最差档序（首项最差）：decision 任一 unsafe 一票否决（与单 brief usage 矩阵同哲学）；
 *  level 里 unknown 是「无判定数据」的兜底、排最末——决策以 internal_decision 为准（level 只是排序信号）。 */
const ROLLUP_DECISION_SEVERITY = ['unsafe', 'needs_review', 'undetermined', 'ok'];
const ROLLUP_LEVEL_SEVERITY = ['fail', 'warn', 'pass', 'unknown'];

/**
 * topic rollup（纯函数）：internal_decision 取各 ok 维的最差档（unsafe > needs_review >
 * undetermined > ok），verdict_level 同理（fail > warn > pass > unknown）；failed 维不参与
 * 聚合但在 dims 留痕，有失败维时 rollup 附 partial: true。无任何可聚合判定时回落 unknown。
 */
export function rollupTopicVerdict(dims) {
  const okDims = (dims ?? []).filter((d) => d?.status === 'ok');
  const worst = (order, values) => order.find((v) => values.includes(v)) ?? 'unknown';
  const rollup = {
    level: worst(ROLLUP_LEVEL_SEVERITY, okDims.map((d) => d.verdict_level).filter(Boolean)),
    internal_decision: worst(ROLLUP_DECISION_SEVERITY, okDims.map((d) => d.internal_decision).filter(Boolean)),
  };
  if ((dims ?? []).some((d) => d?.status === 'failed')) rollup.partial = true;
  return rollup;
}

/** 判级图标（通知用，buildResearchMultiNotifyBody）：pass ✅ / warn ⚠️ / fail ⛔ / 其他 ❔。 */
function verdictLevelIcon(level) {
  return level === 'pass' ? '✅' : level === 'warn' ? '⚠️' : level === 'fail' ? '⛔' : '❔';
}

/**
 * multi 调研完成通知正文（纯函数）：rollup 行 + 每维一行（图标+档位+internal_decision）。
 * 单 brief 通知复用 buildResearchNotifyBody（契约钉死，勿混用）。
 */
export function buildResearchMultiNotifyBody(topic) {
  const rollup = topic?.rollup ?? {};
  const lines = [
    `${verdictLevelIcon(rollup.level)} rollup：${rollup.level ?? '?'}（internal_decision=${rollup.internal_decision ?? '?'}）${rollup.partial ? '——partial（有失败维，仅成功维参与聚合）' : ''}`,
    ...(topic?.dims ?? []).map((d) => {
      const icon = d?.status === 'failed' ? '✗' : verdictLevelIcon(d?.verdict_level);
      const head = `  ${icon} ${d?.dim ?? '?'}（${d?.brief_id ?? 'brief 未产出'}）`;
      if (d?.status === 'failed') return `${head}——failed：${String(d?.reason ?? '').slice(0, 100) || '（无 stderr 留痕）'}`;
      return `${head}——${d?.verdict_level ?? '?'} / ${d?.internal_decision ?? '?'}`;
    }),
  ];
  return lines.join('\n');
}

/**
 * topic → spec --from-brief 注入材料（纯函数，2026-11-09 P2）：每个 ok 维一节（沿用 P0
 * 分节格式，节头带 topic/维度/brief 溯源），failed 维不注入正文、展开末尾附覆盖缺口行
 * （让 planner 知道覆盖缺口）。ok 维的 brief 已被人工删除时同缺口处理（正文缺失 ≈ 该维
 * 无产出）。调用方先读 rollup.internal_decision 接决策契约（unsafe 拒绝 / undetermined
 * 提示，见 cmdSpecStart）——本函数只管展开，不管闸门。返回整段文本（多节以 --- 分隔；
 * 无 ok 维且无缺口行可产出时返回空串，调用方按 missing 口径处理）。
 */
export function buildTopicSpecSections(repoRoot, topic) {
  const sections = [];
  const gaps = [];
  for (const d of topic?.dims ?? []) {
    if (d?.status !== 'ok' || !d.brief_id) {
      gaps.push(`（维度 ${d?.dim ?? '?'} 调研失败：${String(d?.reason ?? '（无 stderr 留痕）').slice(0, 100)}）`);
      continue;
    }
    const brief = readBrief(repoRoot, d.brief_id);
    if (!brief) {
      gaps.push(`（维度 ${d?.dim ?? '?'} 调研失败：brief ${d.brief_id} 已不存在）`);
      continue;
    }
    sections.push(`# 调研结论（topic：${topic.id}｜维度：${d.dim}｜brief：${d.brief_id}）\n\n${String(brief.body).trim()}`);
  }
  const body = sections.join('\n\n---\n\n');
  return gaps.length ? `${body}${body ? '\n\n' : ''}${gaps.join('\n')}` : body;
}

// ---------------------------------------------------------------------------
// 引用快照质量包（2026-11-10，multi-dim 真实对拍实证 evidence 天花板=快照可得性）：
// ① 覆盖：缺省 max 8→16（21 条引用的 brief 曾有 13 条从未尝试快照，L2 复核反复报
//    「引用 [8][9] 无快照无法对账」）；并发小池缺省 4（本文件本地实现，勿 import
//    orchestrator.mjs 的 runBoundedPool——会循环依赖）。
// ② 重试：只重试瞬时类（超时/网络错误/HTTP 5xx·429），每条最多 2 次尝试（间隔 ~1.5s）——
//    瞬时抖动直接判死是快照缺席的另一大源；4xx（404/403 等）= 永久类不重试。
// ③ 分类：快照文件头从 url/fetched_at 扩为 url/fetched_at/type/usable/via——PDF 存在性
//    证据（正文截 2000 字符，二进制无对账价值）、区域封锁页（"App unavailable in
//    region" 类拦截）不再混进骨架页归因不清。**分类只写文件头与日志/verdict reasons
//    （标注与可观测），不改 scoreVerdict/scoreCitation/assessBrief 的分值行为——判分
//    语义零改动（改判分另立卡）**。
// ④ 镜像回退（可选，缺省关）：直连失败（非 404）或分类非 ok 时追加一次 r.jina.ai
//    reader。**隐私取舍：开启 = 把引用 URL 发给第三方 reader 服务**——所以缺省关、
//    workflow.json research.snapshotMirror 显式 opt-in；镜像失败维持原分类，绝不抛错。
// ---------------------------------------------------------------------------

/** 文本快照正文截断（既有口径不变）；PDF 只留存在性证据。 */
const SNAPSHOT_TEXT_LIMIT = 200_000;
const SNAPSHOT_PDF_LIMIT = 2_000;

/** 快照重试间隔（首次失败与重试之间）；retryDelayMs 参数可注入收短（测试钩子）。 */
const SNAPSHOT_RETRY_DELAY_MS = 1_500;

/** 区域封锁特征（大小写不敏感）：OpenAI 文档「App unavailable in region」类拦截页实测形态。 */
const REGION_BLOCK_RE = /unavailable in your region|app unavailable in region|not available in your country|地区不可用/i;

/**
 * 瞬时类失败识别（重试白名单）：超时（AbortSignal.timeout 的 TimeoutError / 手动 abort
 * 的 AbortError）、网络错误（undici 'fetch failed' 与 ECONNRESET/ENOTFOUND/ECONNREFUSED/
 * ETIMEDOUT/EPIPE/terminated 族）、HTTP 5xx / 429。其余（404/403 等 4xx、解析类异常）
 * = 永久类：不重试，镜像回退也跳过 404（资源确不存在，换路无意义）。
 */
function isTransientFailure(err, status = null) {
  if (status != null) return status >= 500 || status === 429;
  const name = String(err?.name ?? '');
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const msg = String(err?.message ?? err);
  return /fetch failed|econnreset|enotfound|econnrefused|etimedout|epipe|terminated|aborted|timeout/i.test(msg);
}

/**
 * 小并发池（snapshotCitations 本地版，勿与 orchestrator.mjs runBoundedPool 混用——
 * 跨文件 import 会循环依赖）：同时最多 limit 个任务，results 按输入顺序回填。
 * worker 必须自兜失败不向池抛错（attemptSnapshot 内部全捕获）。
 */
async function mapPool(limit, items, worker) {
  const results = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}

/**
 * 快照内容分类：响应 Content-Type 含 pdf → type=pdf（usable=pdf——正文是二进制，
 * 只留存在性证据）；text 且 assessSnapshotUsability 可见文本达标 → ok；不可用时再查
 * 区域封锁特征 → region_blocked，否则 skeleton（既有骨架语义不变）。
 * 返回 { type, usable }（写进文件头三行元数据之一，也是返回值 snapshots[].status）。
 */
function classifySnapshot(contentType, text) {
  if (String(contentType ?? '').toLowerCase().includes('pdf')) return { type: 'pdf', usable: 'pdf' };
  if (assessSnapshotUsability(text).usable) return { type: 'text', usable: 'ok' };
  if (REGION_BLOCK_RE.test(String(text ?? ''))) return { type: 'text', usable: 'region_blocked' };
  return { type: 'text', usable: 'skeleton' };
}

/** 从响应读 Content-Type：真实 fetch 用 headers.get，测试替身可能是 { 'content-type': … } 普通对象。 */
function readContentType(res) {
  const h = res?.headers;
  if (!h) return '';
  if (typeof h.get === 'function') return h.get('content-type') ?? '';
  return h['content-type'] ?? h['Content-Type'] ?? '';
}

/** 落盘一份快照：头行逐行 key: value、空行后正文（loadSnapshots 的解析契约，勿破坏）。 */
function writeSnapshotFile(sourcesDir, index, url, { type, usable, via }, body) {
  fs.mkdirSync(sourcesDir, { recursive: true });
  const header = [`url: ${url}`, `fetched_at: ${toIsoLocal()}`, `type: ${type}`, `usable: ${usable}`, `via: ${via}`].join('\n');
  fs.writeFileSync(path.join(sourcesDir, `${index + 1}.txt`), `${header}\n\n${body}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 单条引用的快照尝试（绝不抛错）：直连最多 2 次（瞬时类失败重试 1 次）→ 仍败时按
 * mirror 开关决定是否走镜像回退（仅 1 次，404 直连不回退）。镜像成功 → 覆盖落盘
 * via: mirror 并重跑分类；镜像失败 → 维持直连的分类/失败。返回统一形状
 * { index, url, status, via, reason? }（status: ok|skeleton|region_blocked|pdf|failed）。
 */
async function attemptSnapshot({ url, index, fetchImpl, timeoutMs, mirror, retryDelayMs, sourcesDir }) {
  const fetchOnce = async (target) => {
    const res = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.httpStatus = res.status;
      throw e;
    }
    return res;
  };
  const MAX_ATTEMPTS = 2;
  let lastErr = null;
  let attempts = 1;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchOnce(url);
      const text = await res.text();
      const cls = classifySnapshot(readContentType(res), text);
      const bodyLimit = cls.type === 'pdf' ? SNAPSHOT_PDF_LIMIT : SNAPSHOT_TEXT_LIMIT;
      if (mirror && cls.usable !== 'ok') {
        // 镜像回退：仅 1 次不重试；成功覆盖落盘并重跑分类（jina reader 返回转写文本，type 恒 text）
        try {
          const mres = await fetchOnce(`https://r.jina.ai/${url}`);
          const mtext = await mres.text();
          const mcls = classifySnapshot(readContentType(mres), mtext);
          writeSnapshotFile(sourcesDir, index, url, { ...mcls, via: 'mirror' }, mtext.slice(0, mcls.type === 'pdf' ? SNAPSHOT_PDF_LIMIT : SNAPSHOT_TEXT_LIMIT));
          return { index, url, status: mcls.usable, via: 'mirror', reason: `直连分类 ${cls.usable}——镜像取得并覆盖` };
        } catch (me) {
          // 镜像也失败：维持直连分类落盘，绝不抛错
          writeSnapshotFile(sourcesDir, index, url, { ...cls, via: 'direct' }, text.slice(0, bodyLimit));
          return { index, url, status: cls.usable, via: 'direct', reason: `${cls.usable}（镜像回退失败：${String(me?.message ?? me).slice(0, 120)}）` };
        }
      }
      writeSnapshotFile(sourcesDir, index, url, { ...cls, via: 'direct' }, text.slice(0, bodyLimit));
      return { index, url, status: cls.usable, via: 'direct' };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS && isTransientFailure(e, e?.httpStatus)) {
        attempts++;
        await sleep(retryDelayMs);
        continue;
      }
      break; // 永久类或重试已用尽
    }
  }
  // 直连彻底失败：mirror 开且非 404 → 镜像兜底一次
  if (mirror && !(lastErr?.httpStatus === 404)) {
    try {
      const mres = await fetchOnce(`https://r.jina.ai/${url}`);
      const mtext = await mres.text();
      const mcls = classifySnapshot(readContentType(mres), mtext);
      writeSnapshotFile(sourcesDir, index, url, { ...mcls, via: 'mirror' }, mtext.slice(0, mcls.type === 'pdf' ? SNAPSHOT_PDF_LIMIT : SNAPSHOT_TEXT_LIMIT));
      return { index, url, status: mcls.usable, via: 'mirror', reason: `直连失败（${directReason(lastErr, attempts)}）——镜像取得并覆盖` };
    } catch (me) {
      return { index, url, status: 'failed', via: 'mirror', reason: `${directReason(lastErr, attempts)}；镜像也失败：${String(me?.message ?? me).slice(0, 120)}` };
    }
  }
  return { index, url, status: 'failed', via: 'direct', reason: directReason(lastErr, attempts) };
}

/** 直连失败 reason（带尝试次数——重试后仍败的判死要让人看见）。 */
function directReason(err, attempts) {
  const base = err?.httpStatus != null ? `HTTP ${err.httpStatus}` : String(err?.name && err.name !== 'Error' ? `${err.name}: ` : '') + String(err?.message ?? err).slice(0, 160);
  return attempts > 1 ? `${base}（重试 1 次后仍失败，共 ${attempts} 次尝试）` : base;
}

/**
 * 引用快照（对账材料）：逐条 GET 引用 URL，响应按分类落 research/<id>/sources/<n>.txt
 * （文件头 url/fetched_at/type/usable/via，见「引用快照质量包」注释块）。
 * 尽力而为：单条失败/超时只记 failure，绝不抛错——快照缺席不否定 brief（引用本身已在
 * brief.md 里）；上限 max 条（缺省 16，防引用面失控），并发小池缺省 4。
 * 返回向后兼容：{ ok, failed, snapshots }——ok=分类 ok 的 URL 列表（200 但骨架/区域封锁/
 * PDF 不再计入 ok，2026-11-10 分类语义）；failed={url, reason}；snapshots=逐条
 * { index, url, status, via, reason? }。fetchImpl 注入供测试；retryDelayMs 同（测试钩子）。
 */
export async function snapshotCitations(repoRoot, id, { fetchImpl = globalThis.fetch, timeoutMs = 15_000, max = 16, concurrency = 4, mirror = false, retryDelayMs = SNAPSHOT_RETRY_DELAY_MS } = {}) {
  const brief = readBrief(repoRoot, id);
  if (!brief) return { ok: [], failed: [], snapshots: [] };
  const sourcesDir = path.join(brief.dir, 'sources');
  const citations = brief.citations.slice(0, Math.max(1, max));
  const results = await mapPool(concurrency, citations, (url, i) =>
    attemptSnapshot({ url, index: i, fetchImpl, timeoutMs, mirror, retryDelayMs, sourcesDir }),
  );
  const ok = [];
  const failed = [];
  const snapshots = [];
  for (const r of results) {
    if (r.status === 'ok') ok.push(r.url);
    if (r.status === 'failed') failed.push({ url: r.url, reason: r.reason });
    snapshots.push(r.reason ? { index: r.index, url: r.url, status: r.status, via: r.via, reason: r.reason } : { index: r.index, url: r.url, status: r.status, via: r.via });
  }
  return { ok, failed, snapshots };
}

// ---------------------------------------------------------------------------
// 可信度判定（2026-11-08 设计，问题无关）：L1 快照回查（纯规则）→ L2 异构复核（LLM
// 按需）→ L3 按模型建档核实率。原则：形态 ≠ 真实（判据回到证据本身）、确定性优先于
// LLM 自评、单次打分不如历史校准。三次真实事故的映射：①日期编造→L0 已拦；②真 URL
// 假依据→L1 数字回查拦；③模型接地能力差→L3 建档淘汰。
// ---------------------------------------------------------------------------

/** L2 复核会话输出契约的 fenced block 标记。 */
export const VERDICT_MARKER = 'agents-verdict';

/** 仲裁轮会话输出契约的 fenced block 标记（L2 contradicted 的外部取证翻案，见 parseArbitrationBlock）。 */
export const ARBITRATION_MARKER = 'agents-arbitration';

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
 * 行内 [n] 引用标注豁免：空白归一后剥 `/\[\d{1,3}\]/g`（brief 行内引用契约的形状
 * 就是 1-3 位纯数字）。限纯数字：[2026]/[1m] 类年份/型号不豁免，不给改写开口子；
 * 剥标注时连同至多一个前导空格一起剥（模型省略 [n] 时会连空格一起省），剥后再
 * 折叠空白清残。仅吃前导不吃尾随：「A [1] B」→「A B」仍留词间分隔。
 */
export function stripInlineCitations(s) {
  return normalizeClaimText(s).replace(/ ?\[\d{1,3}\]/g, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// fuzzy 轻度转述放行（2026-11-10 对拍驱动）：一级精确包含把「复核模型转述 brief」也一律
// 丢弃，对账材料白白损失。二级只放行「确实能在 brief 里找到的轻度转述」——三条硬线全过
// 才算（阈值宁严勿松：宁可多丢一条疑似，不可放进一条真编造）：
//   - FUZZY_JACCARD 0.85：claim 词元序列与 brief 词元序列上最佳等长窗口的词元集合 Jaccard。
//     轻度转述（换序/加助词）的源句窗口几乎全重合；两处各半拼接的新句，任何等长窗口最多
//     盖住一半词元，远达不到该线——这是拦「改写拼接」的主防线
//   - FUZZY_CONTAINMENT 0.90：claim 词元至少 90% 出现在 brief 词元集合——无中生有的实体/
//     数字直接拦（这是拦「编造」的主防线）
//   - FUZZY_MIN_TOKENS 4：2-3 词元的碎句偶然命中的面太大，不设下限会给编造开口子
// 判分语义零改动：fuzzy 只影响 claim 的去留与 verbatim 标注，scoreVerdict/aggregateCoherence
// 权重与阈值不动。
// ---------------------------------------------------------------------------
const FUZZY_JACCARD = 0.85;
const FUZZY_CONTAINMENT = 0.9;
const FUZZY_MIN_TOKENS = 4;

/**
 * fuzzy 词元化：小写化、去标点（非 [a-z0-9]/CJK 基本区字符一律当词边界，中英都按连续
 * 非空白段切）。纯函数、确定性、无回溯（单字符类 replace，无嵌套量词）。
 */
function fuzzyTokens(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * 最佳等长窗口词元 Jaccard：在 brief 词元序列上滑一个长度 = claim 词元数的窗口，取与
 * claim 词元集合 Jaccard 的最大值。滑动计数维护（词元进出各 O(1)），整体 O(brief 词元数)，
 * 无嵌套循环无回溯。
 */
function bestWindowJaccard(claimSeq, briefSeq) {
  const n = claimSeq.length;
  const m = briefSeq.length;
  if (!n || !m) return 0;
  const cset = new Set(claimSeq);
  const winCount = new Map(); // 窗口内词元 → 出现次数
  let winDistinct = 0; // 窗口内不同词元数（并集的分母项）
  let inter = 0; // |cset ∩ 窗口集合|
  let best = 0;
  for (let i = 0; i < m; i++) {
    const t = briefSeq[i];
    const prev = winCount.get(t) ?? 0;
    winCount.set(t, prev + 1);
    if (prev === 0) {
      winDistinct++;
      if (cset.has(t)) inter++;
    }
    if (i >= n) {
      // 窗口满后再进新词元就要弹最老的（保持窗口长度恒 = n）
      const out = briefSeq[i - n];
      const cnt = winCount.get(out) ?? 0;
      if (cnt <= 1) {
        winCount.delete(out);
        winDistinct--;
        if (cset.has(out)) inter--;
      } else {
        winCount.set(out, cnt - 1);
      }
    }
    if (i >= n - 1) {
      const union = cset.size + winDistinct - inter;
      if (union > 0) {
        const j = inter / union;
        if (j > best) best = j;
      }
    }
  }
  return best;
}

/**
 * fuzzy 放行判定（verifyClaimVerbatim 第二级的判据，纯函数）。三条硬线见常量区注释；
 * 另有一条契约线：claim 剥 [n] 后仍残留方括号（[2026]/[1m] 类未豁免标注形状）→ 直接
 * 不给 fuzzy——引用标注形状违规是契约问题，不是转述，宁丢不放。
 */
function fuzzyParaphrasePass(bare, briefSeq) {
  if (/[\[\]]/.test(bare)) return false;
  const ct = fuzzyTokens(bare);
  if (ct.length < FUZZY_MIN_TOKENS) return false;
  const cset = new Set(ct);
  const bset = new Set(briefSeq);
  let contained = 0;
  for (const t of cset) {
    if (bset.has(t)) contained++;
  }
  if (contained / cset.size < FUZZY_CONTAINMENT) return false;
  return bestWindowJaccard(ct, briefSeq) >= FUZZY_JACCARD;
}

/**
 * claim 逐字校验（v3 关键防线，两级制）：L2 输出的每条 claim 必须逐字摘自 brief 原文——
 * 改写/概括/无中生有判 fabricated 丢弃并计数（引用层编造问题的评分层重演，此处拦）。
 * 行内 [n] 引用标注豁免：两侧先剥 [n] 再比包含（长度上限仍按原始归一文本计）。
 * 第二级 fuzzy（2026-11-10）：一级精确包含失败后按词元重叠判定——确属 brief 内轻度转述
 * （换序/加助词，词元几乎全部能在 brief 找到）则放行并附 `verbatim: 'fuzzy'` 标注
 * （消费方只标注不降级）；判据与阈值见上方常量区，编造/拼接仍 fabricated（现状口径）。
 */
export function verifyClaimVerbatim(claims, briefBody) {
  const brief = stripInlineCitations(briefBody);
  let briefSeq = null; // 惰性：无 claim 走到二级就不付 brief 词元化的成本
  const valid = [];
  const fabricated = [];
  for (const c of claims ?? []) {
    const text = normalizeClaimText(c?.claim);
    const bare = stripInlineCitations(text);
    if (text && text.length <= 120 && bare && brief.includes(bare)) {
      valid.push({ ...c, claim: text }); // 一级精确：无 verbatim 标注（向后兼容）
    } else if (text && text.length <= 120 && bare) {
      briefSeq ??= fuzzyTokens(brief);
      if (fuzzyParaphrasePass(bare, briefSeq)) valid.push({ ...c, claim: text, verbatim: 'fuzzy' });
      else fabricated.push((text || '(空)').slice(0, 80));
    } else {
      fabricated.push((text || '(空)').slice(0, 80));
    }
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

/**
 * 非逐字 claim 降级保留（2026-11-10）：L2 逐字校验失败重试一次仍败后，claim 不再从
 * claims 中丢弃——保留进 verdict.claims（claims/coverage 信息不丢），但 non_verbatim:
 * true 留痕、status 强制 partial（未过逐字校验不足以上升为 supported；原判 contradicted
 * 的非逐字文本同样不进 contradicted 一票否决——veto 面收窄为纯逐字 claim，置 partial
 * 是撤销否决而非降权）、note 前缀标注。fabricated_claims 计数由调用方照常保留（红旗
 * 封顶 needs_review 语义不变——非逐字残余 = 复核契约仍被违反的证据）。入参兼容字符串
 * （verifyClaimVerbatim 的 fabricated 产物）与对象。
 */
export function downgradeNonVerbatimClaims(claims) {
  if (!Array.isArray(claims)) return [];
  return claims.map((c) => {
    const src = typeof c === 'string' ? { claim: c } : { ...(c ?? {}) };
    return {
      ...src,
      status: 'partial',
      non_verbatim: true,
      note: `非逐字摘录（复核改写）${src.note ? `；原 note：${src.note}` : ''}`,
    };
  });
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
  // Strong Support Rate（观测指标，spec research-verdict-calibration 任务 2）：supported 数 /
  // 已核承重结论数（%，unverifiable 不计分母，checked 空 → null）。与 level 同属纯派生值——
  // 不进 overall 权重、不影响 usage 决策矩阵（判分语义零改动）。
  const strongSupport = checked.length
    ? Math.round((checked.filter((c) => c.status === 'supported').length / checked.length) * 100)
    : null;
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
    scores: { ...dims, strong_support: strongSupport, overall },
    usage: { browse: 'ok', internal_decision: decision, external_doc: external },
    veto,
    contradicted_count: contradicted.length,
    level,
  };
}

/**
 * 快照骨架识别（2026-11-09，四组实验实测偏差源）：客户端渲染/被拦页面抓回来只有
 * HTML 骨架（meta 有点、正文零字）——剥掉 script/style/标签后的可见文本长度低于
 * SNAPSHOT_MIN_VISIBLE 即判骨架页。**只做标注与可观测，不改 claim 判级与 evidence
 * 口径**：骨架页的 meta 描述也可能承载真实排名信息（top10 实测「Claude Code 落在
 * 第二」即出自 meta），一刀切剔除会误杀合法 supported。
 */
export const SNAPSHOT_MIN_VISIBLE = 400;

export function assessSnapshotUsability(text) {
  // 剥文件头（头行逐行 key: value）：url/fetched_at 是既有两行，type/usable/via 是
  // 2026-11-10 快照质量包新增的三行元数据——不剥会混进可见字符计数
  const body = String(text ?? '').replace(/^(url|fetched_at|type|usable|via):.*$/gm, '');
  const visible = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { usable: visible.length >= SNAPSHOT_MIN_VISIBLE, visibleChars: visible.length };
}

/** 读已落盘的快照（sources/*.txt，头行 key: value、空行后正文）→
 *  [{ url, text, usable, visibleChars, kind?, via? }]。usable 是文本可见性布尔
 *  （assessSnapshotUsability 口径，语义与历史一致）；kind/via 是文件头分类
 *  （ok|skeleton|region_blocked|pdf 与 direct|mirror）——旧格式文件无头行时为 null（向后兼容）。 */
export function loadSnapshots(repoRoot, id) {
  const dir = path.join(briefDir(repoRoot, id), 'sources');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const url = /^url:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? f;
    const kind = /^usable:\s*(\S+)\s*$/m.exec(raw)?.[1]?.trim() ?? null;
    const via = /^via:\s*(\S+)\s*$/m.exec(raw)?.[1]?.trim() ?? null;
    out.push({ url, text: raw, kind, via, ...assessSnapshotUsability(raw) });
  }
  return out;
}

/**
 * 读已落盘的 verdict.json（消费方入口）：不存在/损坏一律返回 null。缺席 ≠ 判定不通过——
 * 消费方（research-verdict.md 契约）对 null 放行（旧 brief / 未跑 L1 的行为保持不变）。
 * 需要区分「存在但损坏」的调用方（落观测事件）用 readVerdictDetailed。
 */
export function readVerdict(repoRoot, id) {
  return readVerdictDetailed(repoRoot, id)?.verdict ?? null;
}

/** 区分三态：{ verdict }（正常）/ { corrupt }（存在但解析失败）/ null（不存在或未传 id）。
 *  写入侧已原子化（tmp+rename），corrupt 只可能来自手改/磁盘损坏——调用方对 corrupt 落
 *  观测事件再按 null 语义放行（不静默，也不阻断）。 */
export function readVerdictDetailed(repoRoot, id) {
  if (!id) return null;
  const file = path.join(briefDir(repoRoot, id), 'verdict.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // 不存在（ENOENT 等）
  }
  try {
    return { verdict: JSON.parse(text) };
  } catch {
    return { corrupt: true, verdict: null };
  }
}

/**
 * spec 升级闸门（2026-11 report-only → 阻断，消费方契约 .agents/docs/research-verdict.md）：
 * `usage.internal_decision=unsafe` 或任一 claim `contradicted` → 阻断。claims 复核与 usage
 * 同源双保险（scoreVerdict 的 veto 本就会把 contradicted 折进 unsafe，这里防旧 verdict/
 * 手改文件两者脱钩）。`needs_review`/`undetermined` 不阻断——先攒 near-miss 分布，L2 复核
 * 改判后下周期自动放行（晴雨表哲学）；verdict 缺席（null）放行。
 */
export function verdictGateBlocks(verdict) {
  if (!verdict || typeof verdict !== 'object') return false;
  if (verdict.usage?.internal_decision === 'unsafe') return true;
  return Array.isArray(verdict.claims) && verdict.claims.some((c) => c?.status === 'contradicted');
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
  const skeleton = snapshots.filter((s) => s.usable === false).length;
  const reasons = [];
  if (!snapshots.length) reasons.push('快照 0 份成功——L1 无法回查（网络/拦截原因，不计为编造）');
  else if (!claimCheck.checked) reasons.push('结论中无可回查的数字/型号 token——L1 不适用');
  else {
    reasons.push(`数字回查 ${claimCheck.hits}/${claimCheck.checked}（${Math.round(claimCheck.hit_rate * 100)}%）`);
    if (claimCheck.misses?.length) reasons.push(`未命中 token：${claimCheck.misses.slice(0, 6).join(', ')}${claimCheck.misses.length > 6 ? '…' : ''}`);
  }
  if (skeleton) reasons.push(`⚠ ${skeleton}/${snapshots.length} 份快照为骨架页（正文未渲染/被拦）——meta 描述仍可佐证排名类结论，但数字类结论的可核性受限`);
  // 快照质量包 ③（2026-11-10）：区域封锁/PDF 从骨架页里拆出来归因（只标注不改判分；
  // 旧格式快照无头行分类，kind 为 null，不触发这两行——行为与历史一致）
  const regionBlocked = snapshots.filter((s) => s.kind === 'region_blocked').length;
  if (regionBlocked) reasons.push(`⚠ ${regionBlocked} 份快照为区域封锁页（"App unavailable in region" 类拦截）——非模型编造，网络/地区受限；可 research snapshot ${id} --mirror 补跑`);
  const pdfSnaps = snapshots.filter((s) => s.kind === 'pdf').length;
  if (pdfSnaps) reasons.push(`⚠ ${pdfSnaps} 份快照为 PDF（只留存在性证据，正文未转文本）——数字对账需人工打开原链接`);
  reasons.push('未跑 L2 复核（research verify <brief-id>）——claim 级覆盖与一致性未判定，internal_decision=undetermined');
  const verdict = {
    schema: VERDICT_SCHEMA,
    advisory: true,
    brief_id: id,
    model: model ?? brief.meta.backend ?? null,
    created_at: toIsoLocal(),
    scores,
    snapshots: { total: snapshots.length, usable: snapshots.length - skeleton, skeleton },
    claims: [],
    blockers: [],
    fabricated_claims: 0,
    usage,
    level,
    reasons,
  };
  // 原子写（tmp+rename 同目录）：L2 verify 落盘途中被 sail 周期 readVerdict 读到半文会
  // 解析失败当缺席放行——方向与闸门意图相反；rename 原子可见，半写窗口关闭。
  const verdictFile = path.join(brief.dir, 'verdict.json');
  const tmpFile = `${verdictFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(verdict, null, 2)}\n`);
  fs.renameSync(tmpFile, verdictFile);
  return verdict;
}

/** research/verify 完成事件的飞书通知正文（纯函数）：判级 + usage 三字段 + 维度分行 + 前 3 条理由。 */
export function buildResearchNotifyBody(verdict) {
  const u = verdict?.usage ?? {};
  const icon = verdict?.level === 'pass' ? '✅' : verdict?.level === 'warn' ? '⚠️' : verdict?.level === 'fail' ? '⛔' : '❔';
  const s = verdict?.scores ?? {};
  const overall = s.overall != null ? `（overall ${s.overall}）` : '';
  const fmtDim = (v) => (v == null ? '-' : String(v));
  // 维度分行（spec research-verdict-calibration 任务 2）：四维 + strong_support（观测）；
  // 四维全 null（无 scores 或 L1 纯空壳）时省略整行
  const dimLine = [s.evidence, s.coherence, s.coverage, s.citation].some((v) => v != null)
    ? `维度分: evidence=${fmtDim(s.evidence)} coherence=${fmtDim(s.coherence)} coverage=${fmtDim(s.coverage)}% citation=${fmtDim(s.citation)} strong_support=${fmtDim(s.strong_support)}`
    : null;
  const arb = verdict?.arbitration;
  const arbLine = arb?.ran && !arb.failed ? `⚖ 仲裁轮：${arb.upheld} upheld / ${arb.overturned} overturned / ${arb.undetermined} undetermined——${arb.veto_cleared ? '否决解除' : '否决维持'}` : arb?.failed ? '⚖ 仲裁轮失败——维持原否决' : null;
  const lines = [
    `${icon} ${verdict?.brief_id ?? '?'}——${verdict?.level ?? '?'}${overall}`,
    `usage: browse=${u.browse ?? '?'} / decision=${u.internal_decision ?? '?'} / external=${u.external_doc ?? '?'}`,
    ...(dimLine ? [dimLine] : []),
    ...(verdict?.claims?.length ? [`claims: ${verdict.claims.filter((c) => c.status === 'contradicted').length} contradicted / ${verdict.claims.filter((c) => c.status === 'unsupported').length} unsupported / 共 ${verdict.claims.length} 条`] : []),
    ...(arbLine ? [arbLine] : []),
    ...(verdict?.reasons ?? []).slice(0, 3).map((r) => `· ${String(r).slice(0, 120)}`),
    ...(verdict?.blockers?.length ? [`blockers: ${verdict.blockers.slice(0, 2).join('；')}`] : []),
  ];
  return lines.join('\n');
}

/** L3 台账：每次判定（L1/L2）追加一行——信任按 模型×引擎 攒统计量（drift 保险丝同哲学）。 */
export function appendResearchLedger(repoRoot, entry) {
  const file = path.join(researchDir(repoRoot), 'ledger.jsonl');
  fs.mkdirSync(researchDir(repoRoot), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts: toIsoLocal(), ...entry })}\n`);
  return file;
}

/** L3 读台账（原始条目数组，append 顺序=时间序；损坏行跳过）。降级判定与统计共用。 */
export function readResearchLedger(repoRoot) {
  const file = path.join(researchDir(repoRoot), 'ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try {
      out.push(JSON.parse(line));
    } catch { /* 损坏行跳过 */ }
  }
  return out;
}

/** 台账降级阈值（research-ledger-downgrade 卡，L3→行动闭环）：滚动窗口内 fail 达阈值即
 *  标记该调研船降级。advisory 语义——sail 自主调研跳过烧钱、交互式 research 只亮牌不拦。 */
export const RESEARCH_STANDING_WINDOW = 5;
export const RESEARCH_STANDING_FAIL_THRESHOLD = 3;

/**
 * 调研船台账降级判定（纯函数）：取该模型最近 WINDOW 次判定（调研船口径 researcher_model，
 * 旧条目回退 model），fail 绝对数达阈值 → degraded。样本不足不判「好」只看 fail——
 * 模型漂移往往是瞬时的，宁可误亮牌（人工复核一下）也不漏报。
 */
export function researcherStanding(entries, model, opts = {}) {
  const window = Number.isInteger(opts.window) && opts.window > 0 ? opts.window : RESEARCH_STANDING_WINDOW;
  const threshold = Number.isInteger(opts.failThreshold) && opts.failThreshold > 0 ? opts.failThreshold : RESEARCH_STANDING_FAIL_THRESHOLD;
  const mine = (entries ?? [])
    .filter((e) => (e.researcher_model ?? e.model ?? '?') === model)
    .slice(-window);
  const fails = mine.filter((e) => e.level === 'fail').length;
  return { model, judged: mine.length, fails, degraded: fails >= threshold };
}

/** L3 读台账 → 按调研船模型聚合：n / L1 平均核实率 / L2 平均完全支撑率 / 判级分布。L2 条目的调研船在 researcher_model（model 是复核船）；旧条目无 researcher_model 回退 model。 */
export function readLedgerStats(repoRoot) {
  const byModel = new Map();
  for (const e of readResearchLedger(repoRoot)) {
    const key = `${e.researcher_model ?? e.model ?? '?'}`;
    const agg = byModel.get(key) ?? { model: key, runs: 0, levels: {}, hit_rates: [], strong_supports: [] };
    agg.runs++;
    agg.levels[e.level ?? '?'] = (agg.levels[e.level ?? '?'] ?? 0) + 1;
    if (typeof e.hit_rate === 'number') agg.hit_rates.push(e.hit_rate);
    // avg_strong_support 与 avg_hit_rate 同款 null 语义：旧条目缺字段跳过，一个都没有 → null
    if (typeof e.strong_support === 'number') agg.strong_supports.push(e.strong_support);
    byModel.set(key, agg);
  }
  return [...byModel.values()].map((a) => ({
    model: a.model,
    runs: a.runs,
    levels: a.levels,
    avg_hit_rate: a.hit_rates.length ? a.hit_rates.reduce((s, v) => s + v, 0) / a.hit_rates.length : null,
    avg_strong_support: a.strong_supports.length ? a.strong_supports.reduce((s, v) => s + v, 0) / a.strong_supports.length : null,
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

const ARBITRATION_RULINGS = ['upheld', 'overturned', 'undetermined'];

/**
 * 解析仲裁轮契约块（```agents-arbitration``` JSON）。rulings 每条：claim（须逐字摘录
 * 被 L2 判 contradicted 的原句）+ ruling（upheld=外部来源佐证 brief 正确 / overturned=
 * 外部来源证实矛盾成立 / undetermined=证据不足或来源冲突）+ sources（带日期的依据 URL）。
 * 任一条不合规整块作废（fail-closed，同 parseVerdictBlock 口径）。
 */
export function parseArbitrationBlock(text) {
  const re = new RegExp('```' + ARBITRATION_MARKER + '\\s*\\n([\\s\\S]*?)\\n```');
  const m = re.exec(text ?? '');
  if (!m) return null;
  let j;
  try {
    j = JSON.parse(m[1].trim());
  } catch {
    return null;
  }
  if (!Array.isArray(j.rulings) || !j.rulings.length || j.rulings.length > 10) return null;
  const rulings = [];
  for (const r of j.rulings) {
    if (typeof r?.claim !== 'string' || !r.claim.trim()) return null;
    if (!ARBITRATION_RULINGS.includes(r?.ruling)) return null;
    const sources = Array.isArray(r?.sources) ? r.sources.filter((s) => typeof s === 'string' && s.trim()).slice(0, 6) : [];
    rulings.push({ claim: r.claim, ruling: r.ruling, sources, reasoning: typeof r?.reasoning === 'string' ? r.reasoning.slice(0, 300) : '' });
  }
  return { rulings };
}

/** 归一化逐字对账口径（空白折叠），与 verifyClaimVerbatim 同源思路。 */
const arbNorm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 仲裁裁定合并进 L2 claims（只动 status==='contradicted' 的条目）：
 * - upheld → 翻案为 partial（不是 supported：外部来源与快照属不同证据面，partial 承认
 *   「快照不支撑但外部佐证」，一票否决随之解除）；
 * - overturned / undetermined → 维持 contradicted（保守：翻不了案就维持否决，不因
 *   「没查到」放行——与 COVERAGE_FLOOR 同一哲学）。
 * 裁定与 claim 按归一化逐字匹配；匹配不上的裁定计入 unmatched（丢弃不误伤）。
 * 返回 { claims, stats: { upheld, overturned, undetermined, unmatched } }（原地修改 claims）。
 */
export function arbitrateClaims(claims, rulings) {
  const stats = { upheld: 0, overturned: 0, undetermined: 0, unmatched: 0 };
  const used = new Set();
  for (const r of Array.isArray(rulings) ? rulings : []) {
    const c = claims.find((x) => x.status === 'contradicted' && arbNorm(x.claim) === arbNorm(r.claim) && !used.has(x));
    if (!c) {
      stats.unmatched++;
      continue;
    }
    used.add(c);
    if (r.ruling === 'upheld') {
      c.status = 'partial';
      c.note = `${c.note ? `${c.note}；` : ''}仲裁轮：外部独立来源佐证，矛盾否决解除`.slice(0, 200);
      stats.upheld++;
    } else if (r.ruling === 'overturned') {
      c.note = `${c.note ? `${c.note}；` : ''}仲裁轮：外部来源证实矛盾成立`.slice(0, 200);
      stats.overturned++;
    } else {
      c.note = `${c.note ? `${c.note}；` : ''}仲裁轮：外部证据不足或来源冲突，否决维持`.slice(0, 200);
      stats.undetermined++;
    }
  }
  return { claims, stats };
}

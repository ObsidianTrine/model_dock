// queue.mjs — orchestrator 任务卡解析 + 文件系统队列状态机。
// 零第三方依赖（.agents/ 工具链红线）：frontmatter 用手写 YAML 子集解析，
// 状态迁移 = 任务卡文件在 7 个状态目录间的 fs.rename（原子、崩溃安全）。
// 设计见 docs/design-orchestrator.md 5.2 / 5.3。

import fs from 'node:fs';
import path from 'node:path';

/** 7 个队列状态目录；merged/failed 为终态。 */
export const STATES = ['pending', 'running', 'reviewing', 'awaiting-human', 'merged', 'failed', 'blocked'];

/** 预算默认值（docs 5.10：任务卡可逐任务调大，缺失字段回落默认——不允许无预算运行）。 */
export const DEFAULT_BUDGET = {
  max_turns: 50,
  max_tokens: 500000,
  max_wall_minutes: 60,
  max_test_iterations: 5,
  max_review_iterations: 3,
};

const TASK_TYPES = ['bugfix', 'feature', 'docs', 'deps', 'refactor'];
const PRIORITIES = ['low', 'normal', 'high'];

/** 状态迁移白名单（语义由 orchestrator 驱动，这里只防非法跳变）。 */
const TRANSITIONS = {
  'pending': ['running'],
  'running': ['reviewing', 'blocked', 'failed'],
  'reviewing': ['awaiting-human', 'running', 'blocked'],
  'awaiting-human': ['merged', 'failed', 'running'],
  'blocked': ['running', 'pending', 'failed'],
  'merged': [],
  'failed': [],
};

class QueueError extends Error {}

function fail(msg) {
  throw new QueueError(msg);
}

// ---------------------------------------------------------------------------
// YAML 子集解析（frontmatter 是受控格式：一层嵌套 + 块/内联数组 + 标量）
// ---------------------------------------------------------------------------

function unquote(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function coerceScalar(raw) {
  const t = raw.trim();
  if (t === '') return '';
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  return unquote(t);
}

/** `[a, b, c]` 内联数组 → string[]；支持元素带引号。 */
function parseInlineArray(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((s) => unquote(s));
}

/**
 * 解析受控 YAML 子集。只支持文档实际用到的形状：
 *   key: value
 *   key:            # 嵌套一层
 *     sub: value
 *   key:            # 块数组
 *     - item
 *   key: [a, b]     # 内联数组
 * 解析失败抛可操作报错（带行号），绝不静默吞错（错误信息风格见 AGENTS.md）。
 */
export function parseYamlSubset(text) {
  const out = {};
  const lines = text.split('\n');
  let currentKey = null; // 当前嵌套归属的顶层 key

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i];
    // 整行注释 / 空行
    if (/^\s*(#|$)/.test(line)) continue;
    // 行尾注释（值后带空格 + #）：保守处理，值本身含 " # " 的场景受控格式不会出现
    line = line.replace(/\s+#\s.*$/, '');

    const m = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      // 不匹配 "key: value" 的唯一合法形态：块数组项 "- item"（归属最近的顶层 key）
      const trimmed = line.trim();
      if (/^-\s+/.test(trimmed) || trimmed === '-') {
        if (currentKey == null) fail(`任务卡 frontmatter 第 ${lineNo} 行缩进无归属："${lines[i].trim()}"`);
        if (out[currentKey] === null) out[currentKey] = [];
        if (!Array.isArray(out[currentKey])) {
          fail(`任务卡 frontmatter 第 ${lineNo} 行 "- item" 无法追加："${currentKey}" 已是标量/对象`);
        }
        out[currentKey].push(unquote(trimmed.replace(/^-\s+/, '').trim()));
        continue;
      }
      fail(`任务卡 frontmatter 第 ${lineNo} 行无法解析："${lines[i].trim()}"\n只支持 "key: value"、一层缩进嵌套与 "- item" 列表。`);
    }
    const [, indent, key, rest] = m;

    if (indent === '') {
      // 顶层
      if (rest === '') {
        out[key] = null; // 可能是嵌套容器或块数组，先占位
        currentKey = key;
      } else if (/^\[.*\]$/.test(rest.trim())) {
        out[key] = parseInlineArray(rest);
        currentKey = key;
      } else {
        out[key] = coerceScalar(rest);
        currentKey = key;
      }
    } else {
      // 缩进行：必须归属在最近的顶层 key 下
      if (currentKey == null) fail(`任务卡 frontmatter 第 ${lineNo} 行缩进无归属："${lines[i].trim()}"`);
      const item = rest.trim();

      // 块数组项（docs 5.2 示例形态：key:\n  - item）
      if (/^-\s+/.test(item) || item === '-') {
        if (out[currentKey] === null) out[currentKey] = [];
        if (!Array.isArray(out[currentKey])) {
          fail(`任务卡 frontmatter 第 ${lineNo} 行 "- item" 无法追加："${currentKey}" 已是标量/对象`);
        }
        out[currentKey].push(unquote(item.replace(/^-\s+/, '').trim()));
        continue;
      }

      if (out[currentKey] === null) out[currentKey] = {};
      if (typeof out[currentKey] !== 'object' || Array.isArray(out[currentKey]) || out[currentKey] === null) {
        fail(`任务卡 frontmatter 第 ${lineNo} 行缩进错位："${currentKey}" 已是标量/数组，不能再嵌套子项`);
      }
      const container = out[currentKey];
      if (item === '') {
        fail(`任务卡 frontmatter 第 ${lineNo} 行 "${key}:" 缺少值（子层只支持一层 "key: value"）`);
      }
      container[key] = coerceScalar(item);
    }
  }
  return out;
}

/**
 * 解析完整任务卡：frontmatter（--- 对之间）+ 正文四个段落。
 * 返回 { meta, body: { goal, acceptance, redlines, background } }。
 */
export function parseCard(text, sourceName = '') {
  const tag = sourceName ? `（${sourceName}）` : '';
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) fail(`任务卡${tag}缺少 frontmatter：文件必须以 "---" 开头，YAML 头结束后再以 "---" 结束`);
  const meta = parseYamlSubset(m[1]);

  // 正文按 "# 标题" 分段；未识别的段落并入背景，避免内容丢失
  const body = { goal: '', acceptance: '', redlines: '', background: '' };
  const sections = {};
  let current = null;
  for (const line of m[2].split('\n')) {
    const h = /^#\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = h[1];
      sections[current] ??= [];
      continue;
    }
    if (current != null) sections[current].push(line);
  }
  const join = (k) => (sections[k] ?? []).join('\n').trim();
  body.goal = join('目标');
  body.acceptance = join('验收标准');
  body.redlines = join('红线');
  const known = ['目标', '验收标准', '红线'];
  body.background = Object.entries(sections)
    .filter(([k]) => !known.includes(k))
    .map(([k, v]) => `# ${k}\n${v.join('\n').trim()}`)
    .join('\n\n')
    .trim();

  return { meta, body };
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function requirePositiveInt(budget, key) {
  const v = budget[key];
  if (v === undefined || v === null) {
    budget[key] = DEFAULT_BUDGET[key];
    return;
  }
  if (!Number.isInteger(v) || v <= 0) {
    fail(`任务卡 budget.${key} 必须是正整数，当前为 ${JSON.stringify(v)}\n不允许无预算运行；删除该字段可回落默认值 ${DEFAULT_BUDGET[key]}。`);
  }
}

/** 校验并规范化任务卡元数据；budget 缺失字段回落默认值（红线 5：熔断不可关闭）。 */
export function validateCard(meta) {
  if (!meta.id || typeof meta.id !== 'string') fail('任务卡缺少 id 字段');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(meta.id)) fail(`任务卡 id "${meta.id}" 不合法：只允许小写字母/数字/短横线（如 fix-presets-merge）`);
  if (!TASK_TYPES.includes(meta.type)) fail(`任务卡 type "${meta.type}" 不合法：允许 ${TASK_TYPES.join(' | ')}`);
  if (!PRIORITIES.includes(meta.priority ?? 'normal')) fail(`任务卡 priority "${meta.priority}" 不合法：允许 ${PRIORITIES.join(' | ')}`);
  if (meta.priority === undefined) meta.priority = 'normal';
  // gate = 本任务允许自动合并的级别上限（实际是否自动由改动分级 classifyChange 决定）：
  //   L3（缺省，最保守）→ 全人工；L1 → L0/L1 改动审查通过即自动；L0 → 仅纯文档/测试自动。
  // L2（核心路径）永人工，声明无意义 → 拒绝并提示。
  if (meta.gate === undefined || meta.gate === null || meta.gate === '') meta.gate = 'L3';
  if (!['L0', 'L1', 'L3'].includes(meta.gate)) {
    fail(`任务卡 gate "${meta.gate}" 不合法：允许 L0 | L1 | L3（缺省 L3=全人工）\nL2 是核心路径（永人工），不允许声明——若你要人工闸门请用 L3。`);
  }
  if (meta.created_by !== undefined && !['human', 'scanner', 'planner'].includes(meta.created_by)) {
    fail(`任务卡 created_by "${meta.created_by}" 不合法：允许 human | scanner | planner`);
  }
  if (!Array.isArray(meta.files_hint) || meta.files_hint.length === 0) {
    fail('任务卡 files_hint 必须是非空数组（glob 列表，供门禁做纯度检查）');
  }
  if (!Array.isArray(meta.workflows) || meta.workflows.length === 0) {
    fail('任务卡 workflows 必须是非空数组（至少注入 feature-branch）');
  }
  if (meta.ui_check !== undefined && meta.ui_check !== true && meta.ui_check !== false) {
    fail(`任务卡 ui_check "${JSON.stringify(meta.ui_check)}" 不合法：只允许 true | false（缺省不写 = 不跑 UI 冒烟门禁）`);
  }
  // tier：任务等级，对应 workflow.json tiers 键名（凭据/模型在该处声明，键不存在时运行期告警降级）
  if (meta.tier !== undefined && (typeof meta.tier !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(meta.tier))) {
    fail(`任务卡 tier "${JSON.stringify(meta.tier)}" 不合法：只允许小写字母/数字/短横线（如 heavy，对应 workflow.json tiers 键名）`);
  }
  const budget = meta.budget && typeof meta.budget === 'object' ? meta.budget : {};
  for (const k of Object.keys(DEFAULT_BUDGET)) requirePositiveInt(budget, k);
  meta.budget = budget;
  return meta;
}

/** 从 markdown 文本解析 + 校验，一步到位。 */
export function loadCard(text, sourceName) {
  const { meta, body } = parseCard(text, sourceName);
  validateCard(meta);
  if (!body.goal) fail(`任务卡${sourceName ? `（${sourceName}）` : ''}缺少 "# 目标" 段落`);
  return { meta, body };
}

// ---------------------------------------------------------------------------
// 队列状态机（文件系统实现）
// ---------------------------------------------------------------------------

export function queueRoot(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'queue');
}

/** 确保 7 个状态目录存在（幂等）。 */
export function ensureQueue(root) {
  for (const s of STATES) fs.mkdirSync(path.join(root, s), { recursive: true });
}

/** 任务卡在某个状态目录下的路径。 */
export function cardPath(root, state, id) {
  return path.join(root, state, `${id}.md`);
}

/** 按 id 扫描全部状态目录找卡片，返回 { state, path } 或 null。 */
export function findCard(root, id) {
  for (const s of STATES) {
    const p = cardPath(root, s, id);
    if (fs.existsSync(p)) return { state: s, path: p };
  }
  return null;
}

/** 迁移任务卡到目标状态目录（校验白名单 + 原子 rename）。 */
export function moveCard(root, id, from, to) {
  if (!STATES.includes(to)) fail(`未知的目标队列状态 "${to}"（允许：${STATES.join(' ')}）`);
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    fail(`非法状态迁移 ${from} → ${to}（任务 ${id}）\n允许的迁移：${from} → [${(allowed ?? []).join(', ') || '无（终态）'}]`);
  }
  const src = cardPath(root, from, id);
  if (!fs.existsSync(src)) fail(`任务卡不存在：${src}`);
  fs.renameSync(src, cardPath(root, to, id));
}

/** 列出某状态下全部任务卡的 id（按文件名排序）。 */
export function listCards(root, state) {
  const dir = path.join(root, state);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => f.slice(0, -3));
}

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

/**
 * 自动调度：取 pending 中下一个该跑的任务（Phase 2，docs 10.3）。
 * 排序：priority（high > normal > low）→ 同优先级按 created_at 升序（先到先跑）。
 * 解析/校验失败的卡跳过（留在原地等人工修复，不阻塞队列——drain 靠它避免死循环）。
 * 返回 { id, meta } 或 null（队列空 / 无可解析卡）。
 */
export function pickNextCard(root) {
  let best = null;
  for (const id of listCards(root, 'pending')) {
    try {
      const text = fs.readFileSync(cardPath(root, 'pending', id), 'utf8');
      const { meta } = loadCard(text, `${id}.md`);
      const key = [PRIORITY_RANK[meta.priority] ?? 1, Date.parse(meta.created_at) || Infinity];
      if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) {
        best = { id, meta, key };
      }
    } catch {
      continue; // 损坏卡：人工修（status 可见），不阻塞调度
    }
  }
  return best ? { id: best.id, meta: best.meta } : null;
}

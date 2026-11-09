// spec-review.mjs — spec 三件套分层审查的机器面（规约：.agents/conventions/spec-review.md）。
// L0 确定性检查（零 token）→ L2 审查船会话（orchestrator.mjs cmdSpecReview 驱动，本模块只
// 供契约解析/定位对账/裁决重算）→ review-verdict.json + L3 台账 + 通知。
// **advisory 纪律**：审查结果只做筛查建议，spec build 拆卡永远人工拍板（规约 §0/§2）。
// 现状对账是杀手锏：design 引用的代码事实必须与仓库真实状态一致（规约 §1.3）——首跑试点
// （2026-11-09）即靠它捕获真基线漂移，教训回填在规约 §6。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readSpec, parseTasksDoc } from './spec.mjs';

/** L2 审查船产出契约块标记（fenced ```agents-review-verdict JSON）。
 *  命名注意：绝不能用 'agents-spec…' 开头——mock 后端与后端路由按 prompt.includes()
 *  判定角色，'agents-spec' 是 spec planner 的标记，前缀重叠会把审查船误判成 planner
 *  （2026-11-10 实测踩中）。 */
export const SPECVERDICT_MARKER = 'agents-review-verdict';

/** 五维权重（规约 §1：completeness25/unambiguity20/consistency25/testability20/feasibility10）。 */
export const SPEC_DIM_WEIGHTS = { completeness: 25, unambiguity: 20, consistency: 25, testability: 20, feasibility: 10 };

const SEVERITIES = ['P0', 'P1', 'P2'];
const BUILD_READY = ['blocked', 'rework', 'needs_revision', 'approve_to_build', 'undetermined'];

// 红线扫描模式（规约 §2）。注意：关键词命中 ≠ 违规（spec 文本完全可能合法地提到 8687），
// 命中只升级为「L2 必须逐条裁决」的义务——violation 由审查船在 gates.redlines 里终审。
const REDLINE_PATTERNS = [
  { name: 'protectedPorts', re: /\b(8687|8890)\b/ },
  { name: 'native-addon', re: /native addon|原生模块|\.node\b/ },
  { name: 'import.meta', re: /import\.meta/ },
  { name: '硬编码-家目录', re: /~\/\.modeldock/ },
  { name: 'push-publish', re: /git push|npm publish|推送远程|push origin/ },
  { name: '绕过人工闸门', re: /自动合并|自动\s*approve|自动执行 spec build|绕过(人工|人审|闸门)/ },
];

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 解析 L2 输出的 spec-verdict/1 契约块；缺失或结构非法返回 null。 */
export function parseSpecVerdictBlock(text) {
  const m = new RegExp('```' + SPECVERDICT_MARKER + '\\s*\\n([\\s\\S]*?)```').exec(String(text ?? ''));
  if (!m) return null;
  let v;
  try {
    v = JSON.parse(m[1].trim());
  } catch {
    return null;
  }
  const dims = v.dimensions ?? {};
  const dimsOk = Object.keys(SPEC_DIM_WEIGHTS).every((k) => dims[k] == null || (Number.isFinite(dims[k]) && dims[k] >= 0 && dims[k] <= 100));
  if (!dimsOk || !Array.isArray(v.findings) || v.findings.length > 12) return null;
  for (const f of v.findings) {
    if (!SEVERITIES.includes(f.severity) || !f.file || typeof f.file !== 'string') return null;
  }
  return v;
}

/**
 * L0 确定性检查（规约 §4 清单）。返回 { ok, checks, redlineHits, tbdCount, fuzzyCount,
 * baselineDrift, tasks, spec }。check.status ∈ pass|warn|fail；fail 只出现在结构性问题
 * （三件套缺失/任务段不可解析/依赖悬空成环/files_hint 指向不存在路径）。
 */
export function runSpecL0Checks(repoRoot, specId) {
  const checks = [];
  let spec = null;
  try {
    spec = readSpec(repoRoot, specId);
  } catch (e) {
    checks.push({ name: '三件套齐全', status: 'fail', detail: `readSpec 失败：${String(e.message).slice(0, 160)}` });
    return { ok: false, checks, redlineHits: [], tbdCount: 0, fuzzyCount: 0, baselineDrift: null, tasks: [], spec: null };
  }
  const empty = ['requirements', 'design', 'tasks'].filter((k) => !norm(spec[k]));
  checks.push({
    name: '三件套齐全',
    status: empty.length ? 'fail' : 'pass',
    detail: empty.length ? `空文档：${empty.join('/')}` : 'requirements/design/tasks 齐全且非空',
  });

  const tasks = parseTasksDoc(spec.tasks);
  const fallbackTasks = tasks.filter((t) => t.files.length === 1 && t.files[0] === '**').map((t) => `任务${t.n}`);
  const missingKeys = tasks.filter((t) => !t.goal || !t.done).map((t) => `任务${t.n}(${[!t.goal && '目标', !t.done && '完成条件'].filter(Boolean).join('/')})`);
  checks.push({
    name: '任务段可解析',
    status: !tasks.length ? 'fail' : fallbackTasks.length || missingKeys.length ? 'warn' : 'pass',
    detail: !tasks.length
      ? 'tasks.md 无「## 任务 N:」段'
      : `${tasks.length} 段${fallbackTasks.length ? `；文件行未解析兜底 **：${fallbackTasks.join(',')}` : ''}${missingKeys.length ? `；四行缺失：${missingKeys.join(',')}` : ''}`,
  });

  // 依赖图：deps 里的「任务 N」必须存在；task.n → depN 无环
  const ns = new Set(tasks.map((t) => t.n));
  const edges = [];
  for (const t of tasks) {
    for (const m of String(t.deps ?? '').matchAll(/任务\s*(\d+)/g)) {
      const to = parseInt(m[1], 10);
      edges.push([t.n, to]);
      if (!ns.has(to)) checks.push({ name: '依赖存在', status: 'fail', detail: `任务${t.n} 依赖任务${to}，但后者不存在于本 tasks.md` });
    }
  }
  const adj = Object.fromEntries(tasks.map((t) => [t.n, []]));
  for (const [from, to] of edges) if (adj[from]) adj[from].push(to);
  const seen = {};
  const stack = {};
  let cyclic = false;
  const dfs = (x) => {
    if (stack[x]) cyclic = true;
    if (seen[x]) return;
    seen[x] = stack[x] = true;
    (adj[x] ?? []).forEach(dfs);
    stack[x] = false;
  };
  Object.keys(adj).forEach((n) => dfs(Number(n)));
  if (!checks.some((c) => c.name === '依赖存在' && c.status === 'fail')) {
    checks.push({ name: '依赖 DAG', status: cyclic ? 'fail' : 'pass', detail: cyclic ? '依赖成环' : `${edges.length} 条依赖边，无环无悬空` });
  }

  // files_hint 存在性：无通配符路径必须存在；通配符路径检查其稳定前缀目录
  const missingPaths = [];
  for (const t of tasks) {
    for (const f of t.files) {
      if (f === '**') continue;
      const star = f.indexOf('*');
      const probe = star >= 0 ? f.slice(0, star).replace(/[^/\\]*$/, '') : f;
      if (!fs.existsSync(path.join(repoRoot, probe || '.'))) missingPaths.push(`任务${t.n}:${f}`);
    }
  }
  checks.push({
    name: 'files_hint 存在',
    status: missingPaths.length ? 'fail' : 'pass',
    detail: missingPaths.length ? `路径不存在：${missingPaths.join('；')}` : `${tasks.reduce((a, t) => a + t.files.filter((f) => f !== '**').length, 0)} 条路径全部存在（通配符查前缀目录）`,
  });

  // 红线关键词扫描（命中 ≠ 违规——L2 逐条裁决义务，见 REDLINE_PATTERNS 注释）
  const all = ['requirements', 'design', 'tasks'].map((k) => spec[k]).join('\n');
  const redlineHits = [];
  for (const { name, re } of REDLINE_PATTERNS) {
    const m = re.exec(all);
    if (m) redlineHits.push({ name, snippet: all.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' ') });
  }

  const tbdCount = (all.match(/待定|TBD|后续再(说|定)|暂不确定/g) || []).length;
  const fuzzyCount = (all.match(/合理|适当|尽量|基本上|相关/g) || []).length;

  // 基线漂移（规约 §6 首跑教训）：HEAD 提交时间晚于 spec 落盘时间 → 现状节可能已过期
  let baselineDrift = null;
  try {
    const headIso = execFileSync('git', ['-C', repoRoot, 'log', '-1', '--format=%cI'], { encoding: 'utf8', timeout: 10_000 }).trim();
    const created = new Date(spec.meta.created_at);
    if (!Number.isNaN(created.getTime()) && headIso) baselineDrift = new Date(headIso).getTime() > created.getTime() + 60_000;
  } catch {
    baselineDrift = null; // 非 git 仓库/无提交：跳过（测试沙箱 mkRepo 有 init commit，可测 true/false 两态）
  }
  if (baselineDrift !== null) {
    checks.push({
      name: '基线漂移',
      status: baselineDrift ? 'warn' : 'pass',
      detail: baselineDrift ? 'HEAD 提交晚于 spec 落盘——「现状」节可能过期（审查船须按当前 develop 复核）' : 'spec 落盘后 develop 未再前进',
    });
  }

  return { ok: checks.every((c) => c.status !== 'fail'), checks, redlineHits, tbdCount, fuzzyCount, baselineDrift, tasks, spec };
}

/**
 * finding 定位对账（规约 §3 硬纪律）：file 必须是仓库内真实文件；有 claim 必须逐字定位，
 * 无 claim 有 section 必须可定位（行号在界内 / 节名在文中）；两者皆无 = fabricated。
 * 返回 { audited, fabricated }（fabricated 元素带 reason）。
 */
export function auditSpecFindings(repoRoot, findings) {
  const rootAbs = path.resolve(repoRoot);
  const audited = [];
  const fabricated = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    const rel = String(f.file ?? '').trim();
    const abs = rel ? path.resolve(rootAbs, rel) : null;
    let reason = null;
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) reason = `file 不存在或非文件：${rel}`;
    else if (!(abs === rootAbs || abs.startsWith(rootAbs + path.sep))) reason = `file 越出仓库：${rel}`;
    else {
      const text = fs.readFileSync(abs, 'utf8');
      if (f.claim && !norm(text).includes(norm(f.claim))) reason = 'claim 无法在该文件中逐字定位（空白归一后）';
      else if (!f.claim && f.section) {
        const lm = /(?:第\s*(\d+)\s*行|L\s*(\d+)\b)/.exec(String(f.section));
        const sm = /§\s*(.+)$/.exec(String(f.section).trim());
        if (lm) {
          const n = parseInt(lm[1] || lm[2], 10);
          if (!(n >= 1 && n <= text.split('\n').length + 5)) reason = `section 行号越界（${n}）`;
        } else if (sm && !norm(text).includes(norm(sm[1]))) reason = `section 节名未找到：${sm[1].slice(0, 40)}`;
      } else if (!f.claim && !f.section) reason = 'finding 无定位锚（既无 claim 也无 section）';
    }
    if (reason) fabricated.push({ ...f, fabricated_reason: reason });
    else audited.push(f);
  }
  return { audited, fabricated };
}

/**
 * 服务端权威裁决（规约 §3 矩阵）：overall = 加权和（任一维度 null → 整体 null，不猜）；
 * fabricated>0 → overall-15 降档（规约「整体降档」条款）；红线 fail 由 L2 终审 → blocked。
 * usage：blocked / rework（<50 或 P0≥2）/ needs_revision / approve_to_build（≥80 且 P0=0 且 P1≤2）；
 * overall null → undetermined。
 */
export function computeSpecVerdict({ dimensions, findings, gates, fabricatedCount = 0 }) {
  const reasons = [];
  const p0 = findings.filter((f) => f.severity === 'P0').length;
  const p1 = findings.filter((f) => f.severity === 'P1').length;
  const p2 = findings.filter((f) => f.severity === 'P2').length;

  let overall = null;
  if (dimensions && Object.keys(SPEC_DIM_WEIGHTS).every((k) => dimensions[k] != null)) {
    overall = Math.round(Object.keys(SPEC_DIM_WEIGHTS).reduce((a, k) => a + dimensions[k] * SPEC_DIM_WEIGHTS[k], 0) / 100);
    if (fabricatedCount > 0) {
      overall = Math.max(0, overall - 15);
      reasons.push(`${fabricatedCount} 条 finding 定位对账失败（编造嫌疑）——overall 已按规约降档 -15`);
    }
  } else {
    reasons.push('维度分缺失——overall 不聚合（null 传染，禁止拍脑袋填数）');
  }

  let build_ready;
  if (gates?.redlines === 'fail') {
    build_ready = 'blocked';
    reasons.push('红线 gate 终审 fail——改 spec，红线不可审过');
  } else if (gates?.redlineHits?.length && gates.redlines !== 'fail') {
    reasons.push(`L0 红线关键词命中 ${gates.redlineHits.length} 处，审查船裁决为合法提及（notes 留痕）`);
  }
  if (build_ready !== 'blocked') {
    if (overall == null) build_ready = 'undetermined';
    else if (overall < 50 || p0 >= 2) build_ready = 'rework';
    else if (overall >= 80 && p0 === 0 && p1 <= 2) build_ready = 'approve_to_build';
    else build_ready = 'needs_revision';
    if (overall != null && overall < 50) reasons.push(`overall ${overall}<50`);
    if (p0 >= 2) reasons.push(`P0 finding ${p0} 条（≥2）`);
    if (overall != null && overall >= 80 && p0 === 0 && p1 <= 2) reasons.push(`overall ${overall} 且无 P0、P1≤2`);
    if (overall != null && overall >= 50 && overall < 80 && p0 <= 1) reasons.push(`overall ${overall} 处于 50-79 带（或 P0=1/P1≥3）`);
  }
  return { overall, build_ready, counts: { p0, p1, p2 }, reasons };
}

/** 飞书通知正文（标题由调用方拼项目名——自定义关键词过滤按全文命中，标题不带项目名会被 19024 吞）。 */
export function buildSpecReviewNotifyBody(verdict) {
  const d = verdict.dimensions ?? {};
  const dims = Object.keys(SPEC_DIM_WEIGHTS).map((k) => `${k}=${d[k] ?? '?'}`).join(' ');
  const lines = [
    `审查结论：${verdict.usage?.build_ready ?? '?'}（overall ${verdict.overall ?? 'null'}，advisory——拆卡权在人）`,
    `维度：${dims}`,
    `findings：P0×${verdict.counts?.p0 ?? 0} P1×${verdict.counts?.p1 ?? 0} P2×${verdict.counts?.p2 ?? 0}${verdict.fabricatedCount ? `（另 ${verdict.fabricatedCount} 条定位对账失败已剔除）` : ''}`,
  ];
  for (const f of (verdict.findings ?? []).slice(0, 3)) {
    lines.push(`· [${f.severity}] ${f.file} ${f.section ?? ''}——${String(f.fix ?? f.why ?? '').slice(0, 60)}`);
  }
  return lines.join('\n');
}

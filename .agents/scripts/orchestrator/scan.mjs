// scan.mjs — nightly 巡检信号源（Phase 2，docs 10.4）。
// 扫描 TODO/FIXME、npm audit、测试失败、GitHub issues 四类信号，**消毒后**生成任务卡进 pending/。
// 巡检只生成卡、绝不自动 run（created_by: scanner 的卡等人工决定）——
// 仓库内容进 worker prompt 的注入面，第一道闸就是这里的内容消毒 + 人工 approve。

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runCmd } from './gates.mjs';
import { cardPath, findCard } from './queue.mjs';
import { appendEvent, logDir, toIsoLocal } from './events.mjs';
import { shellSpawnOptions } from './spawn-shell.mjs';
import {
  SEMANTIC_MAX_SIGNALS,
  appendRelaySection,
  collectFilterContext,
  makeSemanticSpawnFn,
  programFilter,
  readScanConfig,
  resolveSemanticEngine,
  semanticFilter,
  signalHash,
} from './eventfilter.mjs';

/** sha256 前 8 位：卡 id 稳定性用（内容不变 → 同 id → 重复巡检自然去重）。 */
export function sha8(s) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

/**
 * prompt injection 消毒：扫描到的仓库内容（注释文本、audit 摘要、测试输出）
 * 进任务卡（→ worker prompt）前压平——控制字符与空白折叠、删除命令结构字符、
 * 截断长度。不追求可读性完美，追求"无法携带指令结构"。
 */
export function sanitize(text, limit = 200) {
  const cleaned = String(text ?? '')
    .replace(/\p{C}/gu, ' ') // 控制字符（含换行）
    .replace(/[`<>|;${}]/g, ' ') // 命令/模板结构字符（先于空白折叠，避免二次空格）
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
  return cleaned.length === limit ? cleaned + '…' : cleaned;
}

// ---------------------------------------------------------------------------
// 信号源
// ---------------------------------------------------------------------------

const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.tsx']);
const TODO_RE = /\/\/\s*(TODO|FIXME)\b[:\s]?(.+)/;

/** 递归收集目录下的代码文件（跳过 node_modules/dist/release/.git）。 */
function walkCode(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || ['node_modules', 'dist', 'release'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkCode(p, out);
    else if (CODE_EXTS.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

/** 信号源 1：src/ 下 TODO/FIXME 注释（每个 TODO 一张卡）。 */
export function scanTodo(repoRoot) {
  const srcDir = path.join(repoRoot, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const todos = [];
  for (const file of walkCode(srcDir)) {
    let lines;
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      continue;
    }
    lines.forEach((line, i) => {
      const m = TODO_RE.exec(line);
      if (m) todos.push({ file: path.relative(repoRoot, file).replace(/\\/g, '/'), line: i + 1, kind: m[1], text: sanitize(m[2], 200) });
    });
  }
  return todos.map((t) => ({
    id: `scan-todo-${sha8(t.file + t.text)}`,
    type: 'refactor',
    priority: 'low',
    files_hint: [t.file],
    goal: `处理 ${t.file}:${t.line} 的 ${t.kind} 注释`,
    acceptance: '- 该 TODO/FIXME 已解决或转成正式任务跟踪，代码里不再残留此条目',
    background: `巡检发现：${t.file}:${t.line} — ${t.kind}：${t.text}`,
  }));
}

/** 信号源 2：npm audit 漏洞（汇总为一张卡）。 */
export function scanAudit(repoRoot) {
  // Windows 的 npm 是 .cmd 包装，spawnSync 直调必 ENOENT——win32 走 shell（见 spawn-shell.mjs）；
  // 失败由下方 catch 归一为 skipped，但静默失效会掐断 nightly audit 信号源，这里必须能真跑起来
  const r = spawnSync('npm', ['audit', '--json'], shellSpawnOptions(process.platform, { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 }));
  let json;
  try {
    json = JSON.parse(r.stdout ?? '');
  } catch {
    return { skipped: true, reason: 'npm audit 不可用（无网络或无 lockfile），跳过该信号源' };
  }
  const vulns = json.vulnerabilities ?? {};
  const names = Object.keys(vulns).sort();
  if (!names.length) return [];
  const items = names.map((n) => `${n}(${vulns[n].severity})`).join(', ');
  return [
    {
      id: `scan-audit-${sha8(names.join(',') + ':' + (json.metadata?.vulnerabilities?.total ?? names.length))}`,
      type: 'deps',
      priority: 'high',
      files_hint: ['package.json', 'package-lock.json'],
      goal: `修复 npm audit 报告的 ${names.length} 个依赖漏洞`,
      acceptance: '- npm audit 不再报告这些漏洞（升级/替换/评估豁免并说明理由）',
      background: `巡检发现依赖漏洞：${sanitize(items, 400)}`,
    },
  ];
}

/** 信号源 3：测试失败（跑 testCmd，失败才生成；每天最多一张，同日重复去重）。 */
export function scanTests(repoRoot, testCmdStr) {
  const r = runCmd(testCmdStr, repoRoot);
  if (r.ok) return [];
  const day = toIsoLocal().slice(0, 10);
  return [
    {
      id: `scan-testfail-${day}`,
      type: 'bugfix',
      priority: 'high',
      files_hint: ['src/**', 'test/**'],
      goal: `修复当前测试套件失败（巡检于 ${day}）`,
      acceptance: '- 巡检命令重跑测试全绿',
      background: `巡检发现测试失败（exit ${r.exitCode}），输出尾部：${sanitize(r.output, 400)}`,
    },
  ];
}

/** 纯映射：gh issue list 的 JSON → 任务卡数组（issue 内容过 sanitize——外部用户可写内容）。 */
export function issuesToCards(issues) {
  return (Array.isArray(issues) ? issues : [])
    .filter((i) => i && Number.isInteger(i.number) && typeof i.title === 'string' && i.title.trim())
    .map((i) => ({
      id: `scan-issue-${i.number}-${sha8(i.title.trim())}`,
      type: 'bugfix',
      priority: 'normal',
      files_hint: ['**'], // issue 不带文件线索：全通配（scope_purity 不误报；L3 人工闸兜底）
      goal: `处理 GitHub issue #${i.number}：${sanitize(i.title.trim(), 200)}`,
      acceptance: `- issue #${i.number} 所述问题已修复或有明确结论（关联提交/评论注明 #${i.number}，issue 可关闭）`,
      background: `巡检发现 open issue：${sanitize(i.url ?? '', 200) || '（无 URL）'}；正文摘录：${sanitize(i.body ?? '', 400) || '（无正文）'}`,
    }));
}

/**
 * 信号源 4：GitHub open issues（gh CLI，best-effort）。仅 origin 指向 GitHub 的仓库启用；
 * gh 未安装/未登录/超时 → { skipped, reason } 警告，不阻塞其余信号源。
 * opts.run 可注入假执行器（测试）；ORCH_GH_CLI 环境变量可指认 gh 路径（对齐 ORCH_ZCODE_CLI 惯例）。
 */
export function scanIssues(repoRoot, opts = {}) {
  let remote = '';
  try {
    remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 }).stdout ?? '';
  } catch {
    /* 无 git/无远端 */
  }
  if (!/github\.com[:/]/i.test(remote.trim())) return { skipped: true, reason: 'origin 非 GitHub 远端，跳过 issues 信号源' };
  const gh = opts.gh ?? process.env.ORCH_GH_CLI ?? 'gh';
  const r = (opts.run ?? defaultGhRun)(gh, ['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,body,url'], repoRoot);
  if (r.status !== 0) {
    return { skipped: true, reason: `gh issue list 不可用（未安装 gh 或未 gh auth login？）：${sanitize(r.stderr || '', 120) || `exit ${r.status}`}` };
  }
  let issues;
  try {
    issues = JSON.parse(r.stdout ?? '[]');
  } catch {
    return { skipped: true, reason: 'gh 输出不可解析，跳过 issues 信号源' };
  }
  return issuesToCards(issues);
}

function defaultGhRun(gh, args, cwd) {
  return spawnSync(gh, args, { cwd, encoding: 'utf8', timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// 生成任务卡（写 pending/；id 已存在于任何状态目录则跳过）
// ---------------------------------------------------------------------------

function renderCard(c) {
  return [
    '---',
    `id: ${c.id}`,
    `type: ${c.type}`,
    `priority: ${c.priority}`,
    `created_at: ${toIsoLocal()}`,
    'created_by: scanner',
    // 信号哈希（eventfilter.signalHash）：程序过滤的数据基础——后续同源信号与它碰撞
    // 决定直通/去重（issue 按号、其余按内容），frontmatter 校验容忍该字段缺省
    ...(c.signal_hashes?.length ? [`signal_hashes: [${c.signal_hashes.join(', ')}]`] : []),
    'files_hint:',
    ...c.files_hint.map((f) => `  - ${f}`),
    'workflows:',
    '  - feature-branch',
    'gate: L3',
    '---',
    '',
    `# 目标`,
    c.goal,
    '',
    `# 验收标准`,
    c.acceptance,
    '',
    `# 背景`,
    c.background,
    '',
  ].join('\n');
}

/**
 * 执行巡检并落卡。返回 { created, skipped, warnings, relayed, dropped, filter }。
 * opts: { todo, audit, tests, issues, dryRun, testCmd, gh, ghRun, semanticSpawnFn, semanticTimeoutMs }
 * 信号两级过滤（eventfilter.mjs，参考 DeepSeek《Super-agent 设计探索》3.1/3.2）：
 *   第一级程序 Fast Path 永远启用（零成本）——同源信号直通在途卡（不重复开卡）、
 *   与 14 天内 merged/failed 卡同信号的丢弃；第二级 LLM Slow Path 按 workflow.json
 *   scan.smartFilter（缺省 false）批量一次调用，失败全部保守回落开卡。
 *   每个直通/丢弃/跳过都落事件（logs/scan/events.jsonl），每轮一条 scan_filtered 总账。
 */
export function runScan(repoRoot, opts = {}) {
  const root = path.join(repoRoot, '.agents', 'orchestrator', 'queue');
  fs.mkdirSync(path.join(root, 'pending'), { recursive: true });
  const dry = opts.dryRun === true;
  const created = [];
  const skipped = [];
  const warnings = [];
  const relayedOut = [];
  const droppedOut = [];
  const qdir = logDir(repoRoot, 'scan'); // scan 级事件（signal_relayed/dropped、scan_semantic、scan_filtered）

  const candidates = [];
  if (opts.todo) candidates.push(...scanTodo(repoRoot));
  if (opts.audit) {
    const r = scanAudit(repoRoot);
    if (r.skipped) warnings.push(r.reason);
    else candidates.push(...r);
  }
  if (opts.tests) candidates.push(...scanTests(repoRoot, opts.testCmd));
  if (opts.issues) {
    const r = scanIssues(repoRoot, { gh: opts.gh, run: opts.ghRun }); // ghRun：测试注入假执行器
    if (r.skipped) warnings.push(r.reason);
    else candidates.push(...r);
  }
  // 信号哈希（frontmatter signal_hashes + 程序过滤碰撞键）：issue 按号、其余按内容（id）
  for (const c of candidates) c.signal_hashes = [signalHash(c)];

  // 既有去重先行：同 id 卡在任何状态目录都已存在 → 原样跳过（不直通，防同一信号夜夜重复 append）
  const fresh = [];
  for (const c of candidates) {
    if (findCard(root, c.id)) skipped.push(c.id);
    else fresh.push(c);
  }

  // ---- 两级过滤 · 第一级：程序 Fast Path（零成本，永远启用）----
  const { keep, relayed, dropped } = programFilter(
    fresh,
    collectFilterContext(root, { now: opts.now, recentWindowDays: opts.recentWindowDays }),
  );

  // 订阅直通：同源信号 append 进在途卡（pending 下次 run 被 prompt 带上；running 仅留痕）
  for (const r of relayed) {
    if (dry) {
      created.push(`[dry-run] ${r.signal.id}（直通 → ${r.card}）`);
      relayedOut.push(r);
      continue;
    }
    try {
      const section = appendRelaySection(cardPath(root, r.card_state, r.card), r.signal);
      if (section == null) {
        // 卡内已有同一信号的直通记录（幂等防重）：不再开卡也不再重复 append
        droppedOut.push({ signal: r.signal, reason: 'already_relayed', card: r.card, card_state: r.card_state });
        appendEvent(qdir, 'signal_dropped', { signal: r.signal.id, reason: 'already_relayed', card: r.card, card_state: r.card_state });
        continue;
      }
      relayedOut.push(r);
      appendEvent(qdir, 'signal_relayed', { signal: r.signal.id, card: r.card, card_state: r.card_state });
    } catch (e) {
      warnings.push(`补充信号追加失败（${r.card}）：${String(e?.message ?? e).slice(0, 120)}——回落为开卡`);
      keep.push(r.signal); // 追加失败回落为开卡（宁多勿漏）
    }
  }
  for (const d of dropped) {
    droppedOut.push(d);
    if (!dry) appendEvent(qdir, 'signal_dropped', { signal: d.signal.id, reason: d.reason, ...(d.card ? { card: d.card, card_state: d.card_state } : {}) });
  }

  // ---- 两级过滤 · 第二级：LLM Slow Path（批量一次调用，scan.smartFilter 开启才走）----
  const sem = { cards: [...keep], drops: [], merges: [], overflow: 0, fallback: null, used_llm: false };
  let smartState = 'off';
  const scanCfg = readScanConfig(repoRoot);
  if (scanCfg.smartFilter) smartState = 'on';
  if (dry) {
    if (scanCfg.smartFilter && keep.length) warnings.push('dry-run：LLM 语义过滤层未执行（预览按程序过滤结果直接计卡）');
  } else if (scanCfg.smartFilter && keep.length) {
    smartState = 'ran';
    const engine = resolveSemanticEngine(repoRoot, scanCfg);
    if (!engine.available) {
      smartState = 'skipped';
      appendEvent(qdir, 'scan_semantic', { skipped: engine.reason });
    } else {
      const spawnFn = opts.semanticSpawnFn ?? makeSemanticSpawnFn(engine.engine, { cwd: repoRoot, model: engine.model, timeoutMs: opts.semanticTimeoutMs });
      try {
        const r = semanticFilter(keep, { spawnFn, maxSignals: SEMANTIC_MAX_SIGNALS });
        sem.cards = r.cards;
        sem.merges = r.merges;
        sem.overflow = r.overflow;
        sem.used_llm = r.used_llm;
        if (r.fallback) {
          sem.fallback = r.fallback;
          smartState = 'fallback';
          appendEvent(qdir, 'scan_semantic', { fallback: r.fallback });
        } else {
          appendEvent(qdir, 'scan_semantic', { ran: true, candidates: keep.length, cards: r.cards.length, drops: r.drops.length, merges: r.merges.length, overflow: r.overflow });
        }
        for (const d of r.drops) {
          sem.drops.push(d);
          droppedOut.push(d);
          appendEvent(qdir, 'signal_dropped', { signal: d.signal.id, reason: d.reason });
        }
      } catch (e) {
        // semanticFilter 内部已保守回落，这里兜底防御（filter 层异常绝不阻断巡检）
        sem.fallback = `semanticFilter 异常：${String(e?.message ?? e).slice(0, 200)}`;
        smartState = 'fallback';
        appendEvent(qdir, 'scan_semantic', { fallback: sem.fallback });
      }
    }
    if (sem.fallback) warnings.push(`LLM 语义过滤回落全开卡：${sem.fallback}`);
  }

  // ---- 落卡（keep 全集；dry-run 只报告不写入）----
  const writeCard = (c) => {
    if (findCard(root, c.id)) {
      skipped.push(c.id);
      return;
    }
    if (dry) {
      created.push(`[dry-run] ${c.id}`);
      return;
    }
    fs.writeFileSync(cardPath(root, 'pending', c.id), renderCard(c));
    created.push(c.id);
  };
  for (const c of sem.cards) writeCard(c);

  // merge 归并（简化实现）：被合并信号以「补充信号」追加进保留卡，不真删信号；
  // 保留卡不存在/追加失败 → 该信号按 card 保守回落（宁多勿漏）
  for (const m of sem.merges) {
    if (dry) {
      created.push(`[dry-run] ${m.signal.id}（merge → ${m.target}）`);
      continue;
    }
    const targetP = cardPath(root, 'pending', m.target);
    if (!fs.existsSync(targetP)) {
      writeCard(m.signal);
      continue;
    }
    try {
      const section = appendRelaySection(targetP, m.signal);
      if (section == null) {
        droppedOut.push({ signal: m.signal, reason: 'already_relayed', card: m.target, card_state: 'pending' });
        appendEvent(qdir, 'signal_dropped', { signal: m.signal.id, reason: 'already_relayed', card: m.target, card_state: 'pending', via: 'merge' });
        continue;
      }
      appendEvent(qdir, 'signal_relayed', { signal: m.signal.id, card: m.target, card_state: 'pending', via: 'merge' });
    } catch (e) {
      warnings.push(`归并信号追加失败（${m.target}）：${String(e?.message ?? e).slice(0, 120)}——回落为开卡`);
      writeCard(m.signal);
    }
  }

  // 每轮 scan 一条总账（永不静默）：raw=本轮信号总数（含既有卡去重跳过与直通回落）
  if (!dry) {
    appendEvent(qdir, 'scan_filtered', {
      raw: candidates.length,
      keep: sem.cards.length,
      relayed: relayedOut.length,
      dropped: droppedOut.length,
      merged_away: sem.merges.length,
      smart_filter: smartState, // off | on（配置了但无候选） | ran | skipped | fallback
    });
  }

  if (relayedOut.length) warnings.push(`同源信号直通在途卡 ${relayedOut.length} 条（事件 signal_relayed，不重复开卡）`);
  if (droppedOut.length) warnings.push(`信号去重丢弃 ${droppedOut.length} 条（事件 signal_dropped）`);
  if (sem.merges.length) warnings.push(`同根因信号归并 ${sem.merges.length} 条进保留卡`);
  return {
    created,
    skipped,
    warnings,
    relayed: relayedOut,
    dropped: droppedOut,
    filter: { raw: candidates.length, keep: sem.cards.length, relayed: relayedOut.length, dropped: droppedOut.length, merged_away: sem.merges.length },
  };
}

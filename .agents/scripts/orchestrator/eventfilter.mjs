// eventfilter.mjs — scan 信号两级过滤 + 卡订阅直通（事件驱动第一批）。
// 参考 DeepSeek《Super-agent 设计探索》3.1（两级过滤：程序 Fast Path + LLM Slow Path）
// 与 3.2（订阅直通：同源后续事件不经中枢直接送达已有会话）。
//
// 设计总纲：
//   - 程序过滤永远启用（零成本）：与在途卡同源的信号直通（relay）追加进在途卡，不重复开卡；
//     与最近 14 天内 merged/failed 卡同信号的直接丢弃（drop）——修过/败过的不再开新卡。
//   - LLM 过滤按 workflow.json scan.smartFilter 开启（模块缺省 false）：批量**一次**调用
//     处理全部候选（≤50 条，每条 id+来源+摘要 ≤200 字符），成本上界写死；解析失败/
//     进程失败/超时 → 全部按 card 保守回落（开卡零成本，宁多勿漏）。
//   - 永不静默：每个 relay/drop/skip 都落事件（logs/scan/events.jsonl），每轮 scan 落一条
//     scan_filtered 总账。
//
// 实现注记：semanticFilter 与 spawnFn 是**同步**契约（spawnFn({prompt}) → string）——
// runScan 的调用方契约是同步的（orchestrator.mjs cmdScan/nightly 不经 await 消费返回值，
// 且本模块的接线点约束是不动 orchestrator.mjs），生产 spawnFn 用 spawnSync + 原生 timeout
// 实现看门狗 makeWatchdogSpawnFn 同款"一次性 headless 短调用"（只读、轮次/工具收敛，
// 引擎参数复用后端模块导出的组装函数）。测试注入假 spawnFn，零外部调用。

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { resolveTrace, workflowConfigPath } from '../workflow-config.mjs';
import { buildClaudeArgs, claudeSpawnInvocation, claudeAvailable } from './backends/claude-headless.mjs';
import { buildZcodeArgs, parseHeadlessJson, zcodeCliSpec, zcodeAvailable } from './backends/zcode-headless.mjs';
import { cardPath, listCards, parseCard } from './queue.mjs';
import { toIsoLocal } from './events.mjs';
import { writeDecisionTrace } from './trace.mjs';
import { sanitize, sha8 } from './scan.mjs';

/** LLM Slow Path 单次调用处理的候选上限（超出部分截断，不经 LLM 直接按落卡处理）。 */
export const SEMANTIC_MAX_SIGNALS = 50;
/** 每条候选送入 LLM 的摘要长度上限（字符）。 */
export const SEMANTIC_SUMMARY_MAX_CHARS = 200;
/** merged/failed 卡的去重窗口（天）：窗口内同信号不再开新卡。 */
export const RECENT_WINDOW_DAYS = 14;

// ---------------------------------------------------------------------------
// 信号身份：来源 / issue 号 / 信号哈希
// ---------------------------------------------------------------------------

/** 信号来源（从 scan 卡 id 前缀推导，用于事件与补充信号小节标题）。 */
export function signalSource(id) {
  const s = String(id ?? '');
  if (/^scan-issue-/.test(s)) return 'issue';
  if (/^scan-todo-/.test(s)) return 'todo';
  if (/^scan-audit-/.test(s)) return 'audit';
  if (/^scan-testfail-/.test(s)) return 'testfail';
  return 'scan';
}

/** GitHub issue 号（scan-issue-<n>-<标题哈希>），非 issue 信号返回 null。 */
export function issueNumberOf(signal) {
  const m = /^scan-issue-(\d+)-/.exec(String(signal?.id ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * 信号哈希（程序过滤的碰撞键，写进卡 frontmatter signal_hashes）。
 * issue 信号按 issue 号取哈希（标题改了仍是同一信号——同号后续事件该直通/去重）；
 * 其余（todo/audit/testfail）的卡 id 本身就是内容哈希，直接对 id 取哈希。
 */
export function signalHash(signal) {
  const n = issueNumberOf(signal);
  return n != null ? sha8(`issue:${n}`) : sha8(String(signal?.id ?? ''));
}

/** 信号的摘要行（消毒后）：goal — background，截断到 limit。 */
function signalSummary(signal, limit = SEMANTIC_SUMMARY_MAX_CHARS) {
  return sanitize(`${signal?.goal ?? ''} — ${signal?.background ?? ''}`, limit) || signalSource(signal?.id);
}

// ---------------------------------------------------------------------------
// 第一级：程序 Fast Path（纯函数，零 IO）
// ---------------------------------------------------------------------------

/**
 * 程序过滤（纯函数，零 IO，便于测试）。
 * 输入 signals：scan 产出的原始信号（卡形状对象，带 id/goal/background）；
 * ctx：{ inFlight, recent, now?, recentWindowDays? }
 *   - inFlight：在途卡信息 [{ id, state, signalHashes: string[], issueNumber: number|null }]
 *     （pending/running 状态）
 *   - recent：近期终态卡信息 [{ id, state, signalHashes, issueNumber, finishedAt: ms|null }]
 *     （merged/failed 状态；finishedAt 缺失视为窗口内——保守 drop）
 * 输出三桶：
 *   { keep: signal[], relayed: [{ signal, card, card_state }], dropped: [{ signal, reason, card?, card_state? }] }
 * 判定顺序：先 relay（同源在途卡：issue 号匹配或信号哈希碰撞），再 drop（近期终态卡
 * 哈希/issue 号碰撞且在窗口内），其余 keep 进 Slow Path 或直接落卡。
 */
export function programFilter(signals, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const windowMs = (ctx.recentWindowDays ?? RECENT_WINDOW_DAYS) * 86_400_000;
  const keep = [];
  const relayed = [];
  const dropped = [];
  for (const signal of Array.isArray(signals) ? signals : []) {
    const hash = signalHash(signal);
    const issueNo = issueNumberOf(signal);
    // relay：与在途卡同源（issue 号匹配——卡 id 或 frontmatter 提取；或信号哈希碰撞）
    const flight = (ctx.inFlight ?? []).find(
      (c) => (issueNo != null && c.issueNumber === issueNo) || (c.signalHashes ?? []).includes(hash),
    );
    if (flight) {
      relayed.push({ signal, card: flight.id, card_state: flight.state });
      continue;
    }
    // drop：与最近 14 天内 merged/failed 卡的信号哈希碰撞（同一信号修过/败过不再开新卡；
    // failed 卡碰撞同样 drop——防止反复开同一张必败卡烧钱）。finishedAt 缺失（无时间戳
    // 可用，完成时刻只落在事件里、这里刻意不扫事件）保守视为窗口内，宁多 drop 不重开。
    const hit = (ctx.recent ?? []).find((c) => {
      const byHash = (c.signalHashes ?? []).includes(hash);
      const byIssue = issueNo != null && c.issueNumber === issueNo;
      if (!byHash && !byIssue) return false;
      if (c.finishedAt == null) return true;
      return now - c.finishedAt <= windowMs;
    });
    if (hit) {
      dropped.push({ signal, reason: 'recent_card', card: hit.id, card_state: hit.state });
      continue;
    }
    keep.push(signal);
  }
  return { keep, relayed, dropped };
}

/**
 * 从队列目录收集程序过滤上下文（IO，供 runScan 与测试使用）。
 * 在途 = pending/running（relay 目标）；近期 = merged/failed（drop 依据）。
 * 卡文件读失败/解析失败按无 signal_hashes 处理（与 pickNextCard 跳过损坏卡同哲学，
 * 该卡贡献不了哈希匹配，不影响其余判定）；完成时刻无独立记录，用文件 mtime 近似
 * （卡内容最后一次写入，终态卡即落卡时刻的可用上界）。
 */
export function collectFilterContext(root, opts = {}) {
  const readInfo = (state, id) => {
    const p = cardPath(root, state, id);
    let signalHashes = [];
    try {
      const { meta } = parseCard(fs.readFileSync(p, 'utf8'), `${id}.md`);
      if (Array.isArray(meta.signal_hashes)) signalHashes = meta.signal_hashes.map((h) => String(h).trim()).filter(Boolean);
    } catch {
      /* 损坏卡：按无哈希处理 */
    }
    let finishedAt = null;
    try {
      finishedAt = fs.statSync(p).mtimeMs;
    } catch {
      /* stat 失败：视为窗口内（保守 drop） */
    }
    const m = /^scan-issue-(\d+)-/.exec(id);
    return { signalHashes, issueNumber: m ? Number(m[1]) : null, finishedAt };
  };
  const inFlight = [];
  for (const state of ['pending', 'running']) {
    for (const id of listCards(root, state)) inFlight.push({ id, state, ...readInfo(state, id) });
  }
  const recent = [];
  for (const state of ['merged', 'failed']) {
    for (const id of listCards(root, state)) recent.push({ id, state, ...readInfo(state, id) });
  }
  return {
    inFlight,
    recent,
    now: opts.now ?? Date.now(),
    recentWindowDays: opts.recentWindowDays ?? RECENT_WINDOW_DAYS,
  };
}

// ---------------------------------------------------------------------------
// 订阅直通：补充信号小节 append 进在途卡
// ---------------------------------------------------------------------------

/**
 * 把信号内容以「## 补充信号（<来源> <时间戳>）」小节 append 到卡文件末尾（幂等）。
 * 内容过 sanitize（与 scan 落卡同强度：剥指令结构标记、压平控制字符）。
 * pending 卡下次 run 会被 prompt 带上（parseCard 把未识别段落并入背景）；running 卡
 * worker 已拿 prompt，append 仅留痕（事件 card_state 字段说明）。
 * 卡文件已含同一信号的直通记录（信号 id 标记行）时不重复 append，返回 null——
 * 标题变更后的 issue 信号每夜同号重扫，靠它防同一内容夜夜重复追加。
 */
export function appendRelaySection(cardFile, signal, { now = new Date() } = {}) {
  const text = fs.existsSync(cardFile) ? fs.readFileSync(cardFile, 'utf8') : '';
  if (text.includes(`信号 ${signal?.id}：`)) return null;
  const section =
    `\n## 补充信号（${signalSource(signal?.id)} ${toIsoLocal(now)}）\n` +
    `- 信号 ${signal?.id}：${signalSummary(signal)}\n`;
  fs.appendFileSync(cardFile, section);
  return section;
}

// ---------------------------------------------------------------------------
// 第二级：LLM Slow Path（批量一次调用，smartFilter 开启才走）
// ---------------------------------------------------------------------------

/** 组装语义过滤 prompt：候选清单（每行 id | 来源 | 摘要）+ 产出契约。 */
export function buildSemanticPrompt(signals) {
  const lines = (signals ?? []).map((s) => `${s.id} | ${signalSource(s.id)} | ${signalSummary(s)}`);
  return [
    '你在为编码任务编排器过滤巡检信号（决定哪些值得开任务卡）。只判断，不执行任何操作。',
    '',
    '# 候选信号（每行：id | 来源 | 摘要）',
    lines.join('\n') || '（空）',
    '',
    '# 产出契约',
    '只输出一个 JSON 数组，不要输出其他文字：',
    '[{"id": "<候选id>", "action": "card" | "drop" | "merge", "target": "<仅 merge 时：归并目标候选的 id>", "reason": "一句话依据"}]',
    '判断标准：',
    '- card：值得开一张任务卡的真实工作项',
    '- drop：仅限明显噪音（与其他候选明显重复、无效信息、琐碎到不值得开卡跟踪）',
    '- merge：与另一条候选同根因，归并成一张卡——target 必须填另一条候选的 id（本条内容将并入那张卡）',
    '- 拿不准时一律按 card（宁可多开卡，不可漏信号）',
  ].join('\n');
}

/** 容错解析 LLM 输出为 JSON 数组：裸 JSON / fenced block / 前后带解释文字；失败返回 null。 */
export function parseSemanticVerdict(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  const tryParse = (s) => {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return j;
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
  const i = raw.indexOf('[');
  const j = raw.lastIndexOf(']');
  if (i >= 0 && j > i) {
    const v = tryParse(raw.slice(i, j + 1));
    if (v) return v;
  }
  return null;
}

/**
 * 语义过滤（同步）：一次 LLM 调用处理全部候选。spawnFn({prompt}) → string（同步，
 * 失败抛错）；测试注入假替身。返回：
 *   { cards: signal[], drops: [{ signal, reason }], merges: [{ signal, target, reason }],
 *     overflow: number, fallback: string|null, used_llm: boolean }
 * 保守原则：spawnFn 缺失/抛错/输出不可解析 → 全部按 card 回落（fallback 记原因）；
 * verdict 里未知 id / 非法 action / merge target 无效 / 未提及的信号 → 按 card。
 * merge 是简化实现：被合并信号内容稍后由调用方以「补充信号」追加进保留卡，不真删信号。
 * 决策留底：traceDir 有值时把本次调用落盘（kind=smartfilter、taskId 固定 scan——
 * input=候选批量 prompt 全文、output=原始 stdout、parsed=解析数组或 null，fallback
 * 原因记 meta；写失败内部消化不影响过滤，见 trace.mjs）。traceOpts 透传上界/滚动参数。
 */
export function semanticFilter(keep, { spawnFn, maxSignals = SEMANTIC_MAX_SIGNALS, traceDir, traceOpts } = {}) {
  const signals = Array.isArray(keep) ? keep : [];
  const empty = { cards: [], drops: [], merges: [], overflow: 0, fallback: null, used_llm: false };
  if (!signals.length) return empty;
  if (typeof spawnFn !== 'function') return { ...empty, cards: signals, fallback: 'spawnFn 缺失' };

  const inScope = signals.slice(0, maxSignals);
  const overflowSignals = signals.slice(maxSignals);
  const prompt = buildSemanticPrompt(inScope);
  const startedAt = Date.now();
  let raw = null;
  let verdict;
  try {
    raw = spawnFn({ prompt });
    verdict = parseSemanticVerdict(raw);
    if (!verdict) throw new Error('输出无法解析为 JSON 数组');
  } catch (e) {
    const fallback = `LLM 调用失败，全部按 card 保守回落：${String(e?.message ?? e).slice(0, 200)}`;
    if (traceDir) {
      writeDecisionTrace(
        { root: traceDir, taskId: 'scan', kind: 'smartfilter', input: prompt, output: String(raw ?? ''), parsed: null, meta: { durationMs: Date.now() - startedAt, fallback } },
        traceOpts,
      );
    }
    return { ...empty, cards: signals, fallback };
  }
  if (traceDir) {
    writeDecisionTrace(
      { root: traceDir, taskId: 'scan', kind: 'smartfilter', input: prompt, output: String(raw ?? ''), parsed: verdict, meta: { durationMs: Date.now() - startedAt } },
      traceOpts,
    );
  }

  const byId = new Map(inScope.map((s) => [s.id, s]));
  const verdictMap = new Map(); // 同 id 多条 verdict 取第一条
  for (const v of verdict) {
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !byId.has(v.id)) continue;
    if (!verdictMap.has(v.id)) verdictMap.set(v.id, v);
  }
  // 第一轮：drop / card（merge 先暂记 card，第二轮按 target 有效性纠正）
  const drops = [];
  const cardSet = new Set();
  for (const s of inScope) {
    const v = verdictMap.get(s.id);
    if (v && v.action === 'drop') {
      drops.push({ signal: s, reason: String(v.reason ?? '').trim().slice(0, 200) || 'LLM 判定为噪音' });
      continue;
    }
    cardSet.add(s.id);
  }
  // 第二轮：merge——target 必须是本轮仍判 card 的另一条候选（同根因归并成一张卡），
  // target 无效（未知/被 drop/自指/链式 merge）→ 该信号按 card 保守回落
  const merges = [];
  for (const s of inScope) {
    const v = verdictMap.get(s.id);
    if (!v || v.action !== 'merge') continue;
    const target = String(v.target ?? '').trim();
    if (target && target !== s.id && cardSet.has(target)) {
      cardSet.delete(s.id);
      merges.push({ signal: s, target, reason: String(v.reason ?? '').trim().slice(0, 200) || 'LLM 判定同根因' });
    }
  }
  return {
    cards: inScope.filter((s) => cardSet.has(s.id)).concat(overflowSignals),
    drops,
    merges,
    overflow: overflowSignals.length,
    fallback: null,
    used_llm: true,
  };
}

// ---------------------------------------------------------------------------
// 配置与生产 spawnFn（同步一次性 headless 短调用）
// ---------------------------------------------------------------------------

/** 读取 scan 过滤相关配置（workflow.json 可选键；缺文件/坏 JSON 按未配置处理——
 *  cmdScan 入口的 loadWorkflowConfig 已对坏 JSON 报错，这里读到的是兜底路径）。 */
export function readScanConfig(repoRoot) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(workflowConfigPath(repoRoot), 'utf8'));
  } catch {
    /* 未配置：模块缺省 false（关闭） */
  }
  const scan = raw.scan && typeof raw.scan === 'object' && !Array.isArray(raw.scan) ? raw.scan : {};
  const review = raw.review && typeof raw.review === 'object' && !Array.isArray(raw.review) ? raw.review : {};
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    smartFilter: scan.smartFilter === true, // 布尔，模块缺省 false
    smartModel: str(scan.smartModel),
    reviewBackend: str(review.backend),
    reviewModel: str(review.model),
    trace: resolveTrace(raw.trace), // 决策留底开关与上界（缺省开启；与 orchestrator 主配置同解析）
  };
}

/** 语义过滤引擎解析：review.backend 同款（缺省 claude-headless），模型 scan.smartModel
 *  > review.model > 引擎默认。引擎不可用（CLI 探测失败/未知引擎）→ 调用方跳过 LLM 层
 *  全部落卡 + scan_semantic { skipped } 事件，不阻断。 */
export function resolveSemanticEngine(repoRoot, cfg = readScanConfig(repoRoot)) {
  const engine = cfg.reviewBackend ?? 'claude-headless';
  const model = cfg.smartModel ?? cfg.reviewModel ?? null;
  let ok = true;
  let reason = null;
  if (engine === 'claude-headless') {
    ok = claudeAvailable();
    reason = ok ? null : 'claude CLI 不可用（未安装或未登录？）';
  } else if (engine === 'zcode-headless') {
    ok = zcodeAvailable();
    reason = ok ? null : 'zcode CLI 不可用（未安装或未设 ORCH_ZCODE_CLI？）';
  } else if (engine !== 'mock') {
    // mock：测试注入 spawnFn 用，视为可用
    ok = false;
    reason = `未知引擎 "${engine}"（允许 claude-headless | zcode-headless | mock）`;
  }
  return { engine, model, available: ok, reason };
}

/** claude stream-json 输出 → 最终文本（最后一个 result 行的 .result；解析不到回落原文）。 */
function parseClaudeResultText(stdout) {
  for (const line of String(stdout ?? '').split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const evt = JSON.parse(t);
      if (evt.type === 'result') return String(evt.result ?? '');
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  return String(stdout ?? '');
}

/**
 * 生产语义过滤 spawnFn（同步一次性 headless 短调用；watchdog makeWatchdogSpawnFn 的
 * 同步版——runScan 契约同步，见文件头注）。失败抛错（spawn 错误 / 非零退出 / 超时），
 * 由 semanticFilter 统一保守回落。模型仅 claude 系生效（zcode 跟随默认）。
 */
export function makeSemanticSpawnFn(engine, { cwd, model, timeoutMs = 120_000 } = {}) {
  return ({ prompt }) => {
    if (engine === 'claude-headless') {
      // 与 claudeSpawnInvocation 同语义组装（win32 shell + 引号包装），prompt 走 stdin
      const inv = claudeSpawnInvocation(process.platform, buildClaudeArgs({ maxTurns: 1, readonly: true, model }), { cwd });
      const r = spawnSync(inv.cmd, inv.args, { ...inv.options, input: prompt, encoding: 'utf8', timeout: timeoutMs });
      if (r.error) {
        throw new Error(`claude CLI 调用失败${r.error.code === 'ETIMEDOUT' ? '（超时）' : ''}：${r.error.message}`);
      }
      if (r.status !== 0) {
        throw new Error(`claude CLI 退出码 ${r.status}：${String(r.stderr ?? '').slice(-200)}`);
      }
      return parseClaudeResultText(r.stdout);
    }
    if (engine === 'zcode-headless') {
      const spec = zcodeCliSpec();
      if (!spec.ok) throw new Error(`ZCode CLI 不可用：${spec.reason}`);
      // 与 zcodeHeadlessBackend.spawn 同语义：argv 直传 prompt（无 shell，万字符级安全；
      // 语义过滤 prompt ≈ 50 条 × 220 字符 < 30KB 上限）、plan 只读模式 + reviewer 整工具禁用
      const disallowed = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch']; // 同 zcode-headless.mjs REVIEWER_DISALLOWED
      const args = [...spec.baseArgs, ...buildZcodeArgs({ prompt, mode: 'plan', disallowed })];
      const r = spawnSync(spec.cmd, args, {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        env: { ...process.env, ORCH_POLICY_ENFORCE: '1' },
      });
      if (r.error) {
        throw new Error(`ZCode CLI 调用失败${r.error.code === 'ETIMEDOUT' ? '（超时）' : ''}：${r.error.message}`);
      }
      if (r.status !== 0) {
        throw new Error(`ZCode CLI 退出码 ${r.status}：${String(r.stderr ?? '').slice(-200)}`);
      }
      return parseHeadlessJson(r.stdout)?.response ?? String(r.stdout ?? '');
    }
    throw new Error(`语义过滤引擎 "${engine}" 不支持同步调用`);
  };
}

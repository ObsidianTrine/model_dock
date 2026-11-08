// transient.mjs — worker 瞬时故障识别（限流/网络抖动），结构化信号优先。
// 背景（2026-10-29 夜跑实证）：headless 引擎与交互会话共享上游配额（GLM 并发上限
// ≈2，实测单发也 429），worker 中途死亡最常见诱因是限流——这与 spawn 失败
// （ENOENT = 环境缺配置，重试无意义）性质不同：前者退避重试可自愈，后者直接
// blocked。识别签名取自上游 429 限流体与 Node 网络错误码。
// 仅在「worker 异常结束（无结果块）」时参与判定——正常产出的结果块不做二次猜测。
//
// 结构化信号优先（2026-11 定）：stderr 正则认的是上游错误**文案**，上游改措辞即失明。
// 网关请求日志（gateway-YYYY-MM-DD.jsonl，复用 weather.mjs 同款的日志读取模式）每请求
// 记 status/err/reason/usage——结构化且权威。worker 异常结束分类时先查会话时间窗内
// 该 harness 的 429/5xx/quota 记录：命中 → 按结构化类定性（transient + 命中摘要）；
// 未命中或无网关数据（未配 gatewayLogDir / 日志读取失败 fail-open / worker 绕行网关）
// → 落回既有 stderr 正则兜底（正则保留不删，无网关场景是唯一识别面）。
//
// cause 精读（2026-11 A1）：状态码只说「失败」，日志 cause 字段说「为什么失败」——
// 同一 429，key_cooldown（key 池冷却，等会儿就好）与 proto_endpoint_missing（模型×provider
// 缺协议端点，重试纯属浪费）的处置完全不同。读取窗口条目时同时解析 cause/hint/tokenHint：
//   proto_endpoint_missing  判定性失败（非 transient）——blocked 理由带 cause + hint 可操作报错；
//   unauthorized            判定性失败（非 transient）——tokenHint 直接点名归因（替代人工翻日志）；
//   quota                   transient + switchProvider 信号（建议换 provider）；
//   key_cooldown/key_pool_empty  transient + retryMs（metrics keypool remaining_ms 推导，可得时）。
// 其余 cause 不参与精读（该条仍按状态码计数走既有路径）；cause 与状态码冲突时 cause 优先
// （如 404 + proto_endpoint_missing → 判定性失败，不因 5xx 误判 transient）。
// fail-open 铁律：网关日志不可得 / 旧日志无 cause 字段 → 行为与历史版本逐字节一致。

import { toIsoLocal } from './events.mjs';
import { readGatewayLog } from './reconcile.mjs';
import { resolveGatewayAdmin } from './tiers.mjs';

/** 瞬时故障签名：限流（429/rate limit/overloaded）与网络层错误（连接重置/超时/挂起）、
 *  zcode CLI 的 ERA 连接协商失败（2026-11-03 航行实证：negotiateEra 崩溃间歇性发生、
 *  同环境随后会话可正常连接——重试可自愈，不进签名则重试/自动续/风暴闸全部失明）。
 *  ERA 两分支只带前导 \b：ERA_NEGOTIATION_FAILED 的尾随 _FAILED 会让尾部 \b 失配。 */
export const TRANSIENT_RE =
  /\b(429|rate.?limit|too many requests|overloaded|overloaded_error|capacity|service unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR|socket hang up|fetch failed)\b|\bera[_-]?negotiation|\bnegotiate[_-]?era/i;

/**
 * 判定 worker 异常结束是否疑似瞬时故障（可退避重试自愈）。
 * @param {string} output worker 输出（zcode = response 或原始 stdout；claude = result 文本）
 * @param {string} [stderrTail] stderr 尾部（claude CLI 把部分上游错误写在 stderr）
 * @returns {boolean}
 */
export function isTransientWorkerFailure(output, stderrTail = '') {
  return TRANSIENT_RE.test(`${String(output ?? '')}\n${String(stderrTail ?? '')}`);
}

// ---------------------------------------------------------------------------
// cause 精读（2026-11 A1）：网关日志 cause 字段参与集（枚举全集见 src/gateway/state/types.ts
// LogEntry.cause——未列出的 cause 不参与精读，该条仍按状态码计数走既有路径）。
// ---------------------------------------------------------------------------

/** 判定性 cause：重试无意义，worker 不该原地重试（blocked 理由带可操作报错）。 */
export const CRASH_CAUSE_DECISIVE = new Set(['proto_endpoint_missing', 'unauthorized']);
/** 瞬时增强 cause：仍可退避重试，但事件/理由带更准的归因与（可得时的）重试窗口。 */
export const CRASH_CAUSE_TRANSIENT = new Set(['quota', 'key_cooldown', 'key_pool_empty']);

/** cause 缺 hint 时的兜底建议（旧版网关不写 hint 也要可操作）。 */
const CAUSE_FALLBACK_HINT = {
  proto_endpoint_missing: '该模型走此 provider 缺少对应协议端点——请在 ModelDock 换 provider 或补端点',
  unauthorized: '请用 modeldock status 核对该 harness 的 token，并更新客户端配置的 key',
  quota: '上游额度受限——建议在 ModelDock 换 provider 或等额度恢复',
  key_cooldown: 'key 池冷却中，稍后自动恢复；也可在 ModelDock 补充可用 key',
  key_pool_empty: '请在 ModelDock 补充可用 key 或换 provider',
};

/** keypool remaining_ms 推导重试窗口的钳制范围：下限避开 0ms 自旋，上限 10min（再长该人工决策）。 */
export const RETRY_WINDOW_MIN_MS = 1_000;
export const RETRY_WINDOW_MAX_MS = 600_000;

/** 重试窗口钳制：keypool 余量 → [1s, 10min] 内的整数 ms（调用方直接当退避时长用）。 */
export function clampRetryWindowMs(ms) {
  return Math.min(Math.max(Math.round(ms), RETRY_WINDOW_MIN_MS), RETRY_WINDOW_MAX_MS);
}

/** cause 组的人类可读理由（blocked 理由 / worker_retry 事件 signature 用）：
 *  可操作报错 = cause 短码 + 计数 + hint（网关 hint 优先，缺席用兜底）。 */
function causeGroupReason(group, backend) {
  const cause = group[0].cause;
  const hint = group.find((g) => g.hint)?.hint || CAUSE_FALLBACK_HINT[cause] || '';
  const head = `网关归因 ${cause}×${group.length}`;
  if (cause === 'unauthorized') {
    const tk = group.find((g) => g.tokenHint)?.tokenHint ?? '';
    return `${head}：${backend ? `${backend} 使用的 token` : '客户端 token'}${tk ? `（前缀 ${tk}…）` : ''} 被网关拒绝——${hint}`;
  }
  if (cause === 'proto_endpoint_missing') return `${head}：重试无意义——${hint}`;
  return `${head}：${hint}`;
}

// ---------------------------------------------------------------------------
// 结构化信号（网关日志窗口）：B6 优先识别面
// ---------------------------------------------------------------------------

/** 崩溃相关状态码：限流 429 / 额度不足 402（weather 上游海况同口径）/ 5xx 服务端故障。 */
export function isCrashStatus(status) {
  return status === 429 || status === 402 || (Number.isInteger(status) && status >= 500 && status < 600);
}

/**
 * 网关日志 harness 字段与执行船的宽容匹配：backend 剥掉 -headless 后缀（zcode-headless
 * → zcode）后与条目 harness 按词边界（-/_/全等）比对。任一侧缺席（旧日志无 harness、
 * '-' 占位、backend 未知）→ true（不因标注缺席漏判——缺席 ≠ 无辜）。
 */
export function harnessMatches(entryHarness, backend) {
  const h = String(entryHarness ?? '').trim().toLowerCase();
  const b = String(backend ?? '').trim().toLowerCase().replace(/-headless$/, '');
  if (!h || h === '-' || !b) return true;
  return (
    h === b ||
    h.startsWith(`${b}-`) || h.startsWith(`${b}_`) ||
    b.startsWith(`${h}-`) || b.startsWith(`${h}_`)
  );
}

/** [loMs, hiMs] 覆盖的本地日期清单（YYYY-MM-DD，升序）。12h 步进 + 首尾补采样：
 *  跨午夜与夏令时切换都不漏日；同日去重。 */
function localDateRange(loMs, hiMs) {
  const out = [];
  const seen = new Set();
  for (let t = loMs; t <= hiMs; t += 12 * 3_600_000) {
    const d = toIsoLocal(new Date(t)).slice(0, 10);
    if (!seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  const last = toIsoLocal(new Date(hiMs)).slice(0, 10);
  if (!seen.has(last)) out.push(last);
  return out;
}

/**
 * 读会话时间窗覆盖的网关日志条目（容错：任一文件读不了 → null = 数据缺席，fail-open
 * 落回正则）。日期文件按本地日期切分，窗口跨午夜自动补足日文件。
 * @returns {Array<object> | null} null 表示「无网关数据」（未配 gwDir / 读取失败）
 */
export function readGatewayWindowEntries(gwDir, { startMs, endMs } = {}) {
  if (!gwDir || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const lo = Math.min(startMs, endMs);
  const hi = Math.max(startMs, endMs);
  const entries = [];
  try {
    for (const date of localDateRange(lo, hi)) {
      for (const entry of readGatewayLog(gwDir, date)) entries.push(entry);
    }
  } catch {
    return null; // 日志查询失败 fail-open：落回 stderr 正则兜底，绝不因观测面故障改变行为
  }
  return entries;
}

/**
 * worker 异常结束分类（纯函数）：结构化信号优先，cause 精读其次，正则兜底。
 * @param {object} p
 * @param {string} [p.output] worker 输出
 * @param {string} [p.stderrTail] stderr 尾部
 * @param {Array<object>|null} [p.entries] 网关日志条目（readGatewayWindowEntries 的产物；
 *        null = 无网关数据，直接走正则）
 * @param {{startMs: number, endMs: number}|null} [p.window] 会话时间窗（entries 非 null 时必填）
 * @param {string} [p.backend] 执行船（harness 匹配用，如 zcode-headless）
 * @param {number|null} [p.keypoolRemainingMs] metrics keypool 最早可用 key 的剩余冷却 ms
 *        （classifyWorkerCrashFromDisk 注入；null = 不可得，key 池类 cause 不带 retryMs）
 * @returns {{transient: boolean, source: 'gateway'|'regex', hits?: number, reason?: string,
 *          decisive?: boolean, cause?: string, hint?: string, tokenHint?: string,
 *          switchProvider?: boolean, retryMs?: number}}
 *          gateway 命中时带 hits（条数）与 reason（状态码路径如 "429×2, 503×1"；cause 路径
 *          为人类可读的可操作报错）；decisive=true = 判定性失败（proto_endpoint_missing/
 *          unauthorized，重试无意义）；quota 命中带 switchProvider 信号；key 池类 cause 且
 *          keypoolRemainingMs 可得时带 retryMs（已钳制 [1s, 10min]）
 */
export function classifyWorkerCrash({ output = '', stderrTail = '', entries = null, window = null, backend = '', keypoolRemainingMs = null } = {}) {
  if (entries && window && Number.isFinite(window.startMs) && Number.isFinite(window.endMs)) {
    const lo = Math.min(window.startMs, window.endMs);
    const hi = Math.max(window.startMs, window.endMs);
    const statusHits = [];
    const causeHits = []; // { cause, hint, tokenHint }
    for (const e of entries) {
      if (!e) continue;
      const ts = Date.parse(String(e.ts ?? ''));
      if (!Number.isFinite(ts) || ts < lo || ts > hi) continue;
      if (!harnessMatches(e.harness, backend)) continue;
      const failed = e.status === undefined || (Number.isInteger(e.status) && e.status >= 400);
      const cause = failed && typeof e.cause === 'string' ? e.cause : '';
      if (cause && (CRASH_CAUSE_DECISIVE.has(cause) || CRASH_CAUSE_TRANSIENT.has(cause))) {
        // cause 精读参与集：该条改走 cause 路径，不再计入状态码 tally（cause 优先）
        causeHits.push({
          cause,
          hint: typeof e.hint === 'string' ? e.hint : '',
          tokenHint: typeof e.tokenHint === 'string' ? e.tokenHint : '',
        });
        continue;
      }
      if (isCrashStatus(e.status)) statusHits.push(e.status);
    }
    // 状态码 tally（既有口径，确定性输出；cause 路径也用它拼「另有」段）
    const statusTally = () => {
      const t = {};
      for (const s of statusHits) t[s] = (t[s] ?? 0) + 1;
      // 状态码升序（数字序）：对象键是整数码会自动按数字排，这里显式排序保证 reason 确定性
      return Object.keys(t)
        .map(Number)
        .sort((a, b) => a - b)
        .map((s) => `${s}×${t[s]}`)
        .join(', ');
    };
    // 决定性 cause 压过一切 transient 信号（含状态码 tally 里的 429/5xx——重试无意义）
    const decisive = causeHits.find((c) => c.cause === 'proto_endpoint_missing') ?? causeHits.find((c) => c.cause === 'unauthorized');
    if (decisive) {
      const group = causeHits.filter((c) => c.cause === decisive.cause);
      return {
        transient: false,
        source: 'gateway',
        decisive: true,
        cause: decisive.cause,
        hits: group.length,
        ...(decisive.hint ? { hint: decisive.hint } : {}),
        ...(decisive.cause === 'unauthorized' && decisive.tokenHint ? { tokenHint: decisive.tokenHint } : {}),
        reason: causeGroupReason(group, backend),
      };
    }
    // 瞬时增强 cause：quota（建议换 provider）/ key_cooldown / key_pool_empty（keypool 余量
    // 可得时推导重试窗口）；窗口里若另有无 cause 标注的状态码命中，拼进 reason 不丢信息
    if (causeHits.length) {
      const byCause = new Map();
      for (const c of causeHits) {
        if (!byCause.has(c.cause)) byCause.set(c.cause, []);
        byCause.get(c.cause).push(c);
      }
      const primary = causeHits[0].cause;
      const anyQuota = byCause.has('quota');
      const keypoolish = primary === 'key_cooldown' || primary === 'key_pool_empty';
      let reason = causeGroupReason(byCause.get(primary), backend);
      if (byCause.size > 1) {
        for (const [cause, group] of byCause) {
          if (cause === primary) continue;
          reason += `；${causeGroupReason(group, backend)}`;
        }
      }
      if (statusHits.length) reason += `；另有无 cause 标注的状态码命中 ${statusTally()}`;
      return {
        transient: true,
        source: 'gateway',
        cause: primary,
        hits: causeHits.length,
        reason,
        ...(anyQuota ? { switchProvider: true } : {}),
        ...(keypoolish && Number.isFinite(keypoolRemainingMs) && keypoolRemainingMs > 0 ? { retryMs: clampRetryWindowMs(keypoolRemainingMs) } : {}),
      };
    }
    if (statusHits.length) {
      return { transient: true, source: 'gateway', hits: statusHits.length, reason: statusTally() };
    }
  }
  // 未命中或无网关数据：落回 stderr 正则（兜底保留——无网关场景是唯一识别面）
  return { transient: isTransientWorkerFailure(output, stderrTail), source: 'regex' };
}

/**
 * metrics keypool 投影 → 最早可用 key 的剩余冷却 ms（全 provider 取最小：任何一把 key 恢复
 * 即可承接重试）。无冷却中的 key / 字段缺席 → null。
 */
export function keypoolMinRemainingMs(j) {
  const keypool = j?.keypool && typeof j.keypool === 'object' && !Array.isArray(j.keypool) ? j.keypool : {};
  let min = null;
  for (const p of Object.values(keypool)) {
    for (const c of Array.isArray(p?.cooldown) ? p.cooldown : []) {
      const ms = c?.remaining_ms;
      if (Number.isFinite(ms) && ms > 0 && (min === null || ms < min)) min = ms;
    }
  }
  return min;
}

/** 查 metrics 的 keypool 冷却余量（key_cooldown/key_pool_empty 重试窗口推导）。
 *  admin 不可得 / 网关不可达 / 非 200 → null（调用方回落既有退避——fail-open）。 */
async function fetchKeypoolRemainingMs(cfg, { timeoutMs = 3000 } = {}) {
  const adm = resolveGatewayAdmin(cfg);
  if (!adm) return null;
  try {
    const res = await fetch(`${adm.base}/_modeldock/metrics`, {
      headers: { 'x-modeldock-admin': adm.adminToken },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return keypoolMinRemainingMs(await res.json());
  } catch {
    return null;
  }
}

/**
 * classifyWorkerCrash 的落盘便捷版：从 gwDir 读窗口条目（fail-open → null）后分类。
 * orchestrator 派发点的接线用它；entries 可注入便于单测。异步（A1）：窗口内确有 key 池类
 * cause 时问一次 metrics 拿 keypool 余量推导重试窗口——admin 不可得/网关不可达 → null，
 * 用调用方既有退避；正常路径（无 key 池 cause）零网络开销。
 * 数据面保持网关日志文件直读（A3 取舍，与 upstreamSeaState 同理）：分类要逐条明细
 * （status/cause/hint/harness/ts 逐条判定 + era 签名兜底），/_modeldock/usage 聚合端点
 * 给不了；明细端点 /_modeldock/logs/query 已落地（gateway-orch-apis，2026-11-08），
 * 切换留作后续项（本注释 2026-11-09 勘误：原写「未来落地后再切」已过时）。
 */
export async function classifyWorkerCrashFromDisk({ gwDir, cfg = null, output = '', stderrTail = '', window = null, backend = '', keypoolTimeoutMs = 3000 } = {}) {
  const entries = window ? readGatewayWindowEntries(gwDir, window) : null;
  let keypoolRemainingMs = null;
  if (cfg && entries?.some((e) => e && (e.cause === 'key_cooldown' || e.cause === 'key_pool_empty'))) {
    keypoolRemainingMs = await fetchKeypoolRemainingMs(cfg, { timeoutMs: keypoolTimeoutMs });
  }
  return classifyWorkerCrash({ output, stderrTail, entries, window, backend, keypoolRemainingMs });
}

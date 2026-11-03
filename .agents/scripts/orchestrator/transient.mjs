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

import { toIsoLocal } from './events.mjs';
import { readGatewayLog } from './reconcile.mjs';

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
 * worker 异常结束分类（纯函数）：结构化信号优先，正则兜底。
 * @param {object} p
 * @param {string} [p.output] worker 输出
 * @param {string} [p.stderrTail] stderr 尾部
 * @param {Array<object>|null} [p.entries] 网关日志条目（readGatewayWindowEntries 的产物；
 *        null = 无网关数据，直接走正则）
 * @param {{startMs: number, endMs: number}|null} [p.window] 会话时间窗（entries 非 null 时必填）
 * @param {string} [p.backend] 执行船（harness 匹配用，如 zcode-headless）
 * @returns {{transient: boolean, source: 'gateway'|'regex', hits?: number, reason?: string}}
 *          gateway 命中时带 hits（条数）与 reason（如 "429×2, 503×1"）
 */
export function classifyWorkerCrash({ output = '', stderrTail = '', entries = null, window = null, backend = '' } = {}) {
  if (entries && window && Number.isFinite(window.startMs) && Number.isFinite(window.endMs)) {
    const lo = Math.min(window.startMs, window.endMs);
    const hi = Math.max(window.startMs, window.endMs);
    const hits = [];
    for (const e of entries) {
      if (!e || !isCrashStatus(e.status)) continue;
      const ts = Date.parse(String(e.ts ?? ''));
      if (!Number.isFinite(ts) || ts < lo || ts > hi) continue;
      if (!harnessMatches(e.harness, backend)) continue;
      hits.push(e.status);
    }
    if (hits.length) {
      const tally = {};
      for (const s of hits) tally[s] = (tally[s] ?? 0) + 1;
      // 状态码升序（数字序）：对象键是整数码会自动按数字排，这里显式排序保证 reason 确定性
      const reason = Object.keys(tally)
        .map(Number)
        .sort((a, b) => a - b)
        .map((s) => `${s}×${tally[s]}`)
        .join(', ');
      return { transient: true, source: 'gateway', hits: hits.length, reason };
    }
  }
  // 未命中或无网关数据：落回 stderr 正则（兜底保留——无网关场景是唯一识别面）
  return { transient: isTransientWorkerFailure(output, stderrTail), source: 'regex' };
}

/**
 * classifyWorkerCrash 的落盘便捷版：从 gwDir 读窗口条目（fail-open → null）后分类。
 * orchestrator 派发点的接线用它；entries 可注入便于单测。
 */
export function classifyWorkerCrashFromDisk({ gwDir, output = '', stderrTail = '', window = null, backend = '' } = {}) {
  const entries = window ? readGatewayWindowEntries(gwDir, window) : null;
  return classifyWorkerCrash({ output, stderrTail, entries, window, backend });
}

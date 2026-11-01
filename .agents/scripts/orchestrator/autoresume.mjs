// autoresume.mjs — blocked 卡有限自动续跑（长跑自主的关键小件）。
// 背景（2026-10-29/30 夜跑实证）：drain 长跑时 transient 类故障（GLM 429 限流、网络
// 抖动）把卡打成 blocked，等人工第二天 resume——自主长跑断在夜里。worker 级原地
// 重试（transient.mjs，spawn 时 ≤3 次）已降低概率，但重试用尽后仍落 blocked。
// 这里提供 drain 选卡前的自动续通道，设计总纲四条：
//   1. 只续 transient 类失败（签名匹配或 worker_retry 链定性，见 isTransientBlocked）；
//   2. 每卡冷却期内最多自动续 1 次（auto_resumed_at 写进卡 frontmatter，缺省 24h）；
//   3. 每次 drain 最多 maxPerRun 张（缺省 2），按 blocked 时间最早先续；
//   4. 永不静默：每次自动续记 auto_resume { card, attempts } 事件；读不了的卡跳过并告警。
// 全局开关 workflow.json autoResume.enabled（缺省 true）；drift 降级期间整通道暂停
// （降级 = 全人工，检查在 orchestrator.mjs 的 autoResumePass）。
// 资格判定抽成纯函数 pickAutoResumeCandidates（无 fs/无子进程）便于单测；
// fs 扫描在 scanBlockedCards；spawn 既有 resume 子命令的接线在 orchestrator.mjs
// （闭环复用，不复制逻辑——与 drain 派 run 子进程同哲学：熔断 process.exit 不伤主循环）。

import fs from 'node:fs';
import { TRANSIENT_RE } from './transient.mjs';
import { parseCard, listCards, cardPath } from './queue.mjs';
import { logDir, readEvents, toIsoLocal } from './events.mjs';

/** 每卡自动续冷却缺省值：24h（workflow.json autoResume.cooldownHours 可调，须正整数）。 */
export const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** 每次 drain 自动续张数缺省值：2（workflow.json autoResume.maxPerRun 可调，须正整数）。 */
export const DEFAULT_MAX_PER_RUN = 2;

/** frontmatter 冷却标记键名（卡自动续时写入，人工 resume 不写）。 */
export const AUTO_RESUMED_AT_KEY = 'auto_resumed_at';

// settle 事件类型：卡在 blocked/ 时，最后一条这类事件回答「为什么 blocked」。
// failed 也要看：cmdRun 异常兜底 failTaskToBlocked 把卡挪进 blocked/ 时写的是 failed 事件
// （reason=异常中断：<err>），上游网络错误（ECONNRESET 等）经此路径落 blocked。
const SETTLE_TYPES = ['blocked', 'circuit_breaker', 'failed'];

/** 最后一条 settle 事件（没有则 null）。 */
function lastSettle(events) {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    if (SETTLE_TYPES.includes(events[i]?.type)) return events[i];
  }
  return null;
}

/**
 * 判定一张 blocked 卡是否「transient 类失败」（自动续资格之一）。
 * 两条路径满足其一即可：
 *  A. 最后一条 settle 事件的 reason/detail 带 transient 签名（429 限流/网络类，
 *     复用 transient.mjs 的 TRANSIENT_RE——与 worker 原地重试同一口径）；
 *  B. 事件链存在 worker_retry 记录（worker 原地重试发生过 = 瞬时故障已被认定）
 *     且最终以 blocked 事件收尾、其后无 circuit_breaker——典型形态是 429 重试
 *     3 次用尽后「未产出结果块」落 blocked（reason 本身不带签名，靠链路定性）。
 *     最后一次重试之后出现熔断（budget/看门狗/调试迭代超限）= 确定性失败，不续。
 * @param {Array<object>} events readEvents 的输出
 * @returns {boolean}
 */
export function isTransientBlocked(events) {
  if (!Array.isArray(events) || events.length === 0) return false;
  const settle = lastSettle(events);
  if (!settle) return false;
  if (TRANSIENT_RE.test(`${settle.reason ?? ''}\n${settle.detail ?? ''}`)) return true;
  if (settle.type !== 'blocked') return false;
  let lastRetryIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i]?.type === 'worker_retry') lastRetryIdx = i;
  }
  if (lastRetryIdx < 0) return false;
  for (let i = lastRetryIdx + 1; i < events.length; i++) {
    if (events[i]?.type === 'circuit_breaker') return false;
  }
  return true;
}

/**
 * 冷却判定：卡 frontmatter 无 auto_resumed_at（从没自动续过）→ 合格；
 * 有且距 now ≥ cooldownMs → 合格。时间戳解析失败按「仍在冷却内」保守处理
 * （宁少勿滥：字段由程序写入，出现脏值说明卡被手改过，交人工）。
 */
export function cooldownPassed(meta, now, cooldownMs) {
  const at = meta?.[AUTO_RESUMED_AT_KEY];
  if (at === undefined || at === null || at === '') return true;
  const t = Date.parse(String(at));
  if (!Number.isFinite(t)) return false;
  return now - t >= cooldownMs;
}

/** 卡的 blocked 时间（最后一条 settle 事件的 ts；缺失/解析失败按 0=最早，先续先解脱）。 */
function blockedTimeOf(events) {
  const settle = lastSettle(events);
  const t = settle ? Date.parse(String(settle.ts ?? '')) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * 纯函数：从 blocked 卡中挑「可安全自动续」的候选。
 * @param {Array<{id: string, meta: object, events: Array<object>}>} blockedCards
 *   扫描方已备好的卡描述（meta=frontmatter、events=logs/<id>/events.jsonl 全量）。
 * @param {{ now?: number, maxPerRun?: number, cooldownMs?: number }} [opts]
 *   now/maxPerRun/cooldownMs 可注入便于测试；非法值静默回落缺省（配置层的非法值
 *   告警归 workflow-config.mjs 的 resolveAutoResume，这里不重复告警）。
 * @returns {Array<{id: string, attempts: number, blockedAt: number}>}
 *   按 blocked 时间升序（同刻按 id 稳定）的前 maxPerRun 张；
 *   attempts = 事件链里 worker_retry 的次数（auto_resume 事件的留痕字段）。
 */
export function pickAutoResumeCandidates(blockedCards, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxPerRun = Number.isInteger(opts.maxPerRun) && opts.maxPerRun > 0 ? opts.maxPerRun : DEFAULT_MAX_PER_RUN;
  const cooldownMs = Number.isInteger(opts.cooldownMs) && opts.cooldownMs > 0 ? opts.cooldownMs : DEFAULT_COOLDOWN_MS;
  const eligible = [];
  for (const card of Array.isArray(blockedCards) ? blockedCards : []) {
    if (!card || typeof card.id !== 'string') continue;
    if (!isTransientBlocked(card.events)) continue;
    if (!cooldownPassed(card.meta, now, cooldownMs)) continue;
    eligible.push({
      id: card.id,
      attempts: (card.events ?? []).filter((e) => e?.type === 'worker_retry').length,
      blockedAt: blockedTimeOf(card.events),
    });
  }
  eligible.sort((a, b) => a.blockedAt - b.blockedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return eligible.slice(0, maxPerRun);
}

/**
 * 把 auto_resumed_at 写进卡 frontmatter（已存在则覆盖该行），返回新文本。
 * 冷却标记必须在 spawn resume 子进程**之前**落到卡文件（blocked/ 目录内）：
 * 子进程随后 moveCard 只是 rename，字段随卡走——自动续后再 blocked 时，下轮
 * drain 靠它判冷却（连续自动续失败不重试的护栏）。
 */
export function withAutoResumedAt(cardText, iso) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(cardText);
  if (!m) return cardText; // 无 frontmatter（不该发生）：原样返回，调用方另行处理
  const kept = m[1].split('\n').filter((l) => !/^\s*auto_resumed_at\s*:/.test(l));
  return cardText.replace(m[0], `---\n${[...kept, `${AUTO_RESUMED_AT_KEY}: ${iso}`].join('\n')}\n---`);
}

/**
 * 扫 blocked/ 目录备好候选卡描述（fs 读取，配合纯函数 pickAutoResumeCandidates 用）。
 * 读不了的卡（frontmatter 损坏等）进 unreadable 由调用方告警——跳过不阻塞、永不静默。
 * @returns {{ candidates: Array<{id, meta, events, text, path}>, unreadable: string[], total: number }}
 */
export function scanBlockedCards(repoRoot, root) {
  const ids = listCards(root, 'blocked');
  const candidates = [];
  const unreadable = [];
  for (const id of ids) {
    try {
      const p = cardPath(root, 'blocked', id);
      const text = fs.readFileSync(p, 'utf8');
      const { meta } = parseCard(text, `${id}.md`); // 只要 frontmatter（冷却字段），不做完整校验
      candidates.push({ id, meta, events: readEvents(logDir(repoRoot, id)), text, path: p });
    } catch {
      unreadable.push(id);
    }
  }
  return { candidates, unreadable, total: ids.length };
}

/** 当前时刻的冷却标记值（ISO8601 带本地时区，与事件 ts 同一口径）。 */
export function autoResumedAtNow() {
  return toIsoLocal();
}

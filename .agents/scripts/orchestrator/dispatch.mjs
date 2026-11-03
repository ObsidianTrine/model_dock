// dispatch.mjs — 动态选船（dynamic dispatch，阶段 3；船东 2026-11-03 批准实施）：
// 派发时用「海况信号 + 卡难度」在**预授权包络**内自动选执行船（backend）。
// 授权哲学与 escalation.fallbackBackend / autopilot 一致：envelope 显式写进
// workflow.json = 持久授权，包络内换船运行时不再请示（引擎切换人工闸门保留，
// 只加包络豁免分支，见 orchestrator.mjs）；包络外永不自动切。
//
// 规则（缺省关——workflow.json 无 dynamicDispatch 键 = 决策完全不参与，行为与历史一致）：
//   1. 默认（海况健康 + 无难度信号）用 workflow.json worker.backend；
//   2. 卡难度偏好：tier 生效（token 已解析）→ claude 系（zcode 不支持 tier，不给它派
//      tier model）；ahead-1/2（轻活，含旧 light）→ zcode（免费默认船）；ahead-3/4
//      （重活，含旧 heavy）→ claude（前进3/4 的网关船）；files_hint 命中核心/发布路径
//      视作高难度 → claude；
//   3. 所选船海况恶劣（该船 harness 绕开狗粮 / 未接管——燃油实测与对账失效；或 CLI
//      不可用）→ 换包络内下一个健康船；
//   4. 全港风暴（服务熔断 / 上游限流 / worker 重试密集 / weatherHold 滞留）：包络内换船
//      无益（同一网关同一批上游，熔断由网关自动路由避开），全部恶劣 → 沿用默认并留痕。
// 所有非常规选择记 dispatch_selected { from, to, reason } 事件——永不静默红线。
// 难度路由不需要网关（纯卡面信号）；逐船海况判读需要 gatewayAdmin 开启的观测快照，
// 观测缺席不判恶劣（观测缺席 ≠ 风暴，与 fleet observe 同哲学）。
// 零第三方依赖（.agents/ 工具链红线）。

import fs from 'node:fs';
import path from 'node:path';
import { readEvents } from './events.mjs';
import { countRecentTransient, countUpstreamStorm, shouldHold } from './weather.mjs';
import { gatewayLogsDir } from './reconcile.mjs';
import { normalizeTierName } from './tiers.mjs';
import { SHIP_HARNESS } from './fleet.mjs';
import { hintsOverlap } from '../policy.mjs';
import { claudeAvailable } from './backends/claude-headless.mjs';
import { zcodeAvailable } from './backends/zcode-headless.mjs';

/** 动态选船的合法船型：mock 永不参与（零产出船，自动切到只会烧成 blocked）。 */
export const DYNAMIC_SHIPS = ['claude-headless', 'zcode-headless'];

/**
 * 包络规范化（纯函数）：只收真实船型；mock 与未知船型剔除并给可操作原因。
 * @returns {{ envelope: string[], ignored: Array<{entry: string, reason: string}> }}
 */
export function normalizeEnvelope(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const envelope = [];
  const ignored = [];
  for (const item of list) {
    const name = String(item ?? '').trim();
    if (!name) continue;
    if (name === 'mock') {
      ignored.push({ entry: name, reason: 'mock 不参与自动选船（零产出船，自动切到只会烧成 blocked）' });
      continue;
    }
    if (!DYNAMIC_SHIPS.includes(name)) {
      ignored.push({ entry: name, reason: `未知船型（允许：${DYNAMIC_SHIPS.join(' | ')}）` });
      continue;
    }
    if (!envelope.includes(name)) envelope.push(name);
  }
  return { envelope, ignored };
}

/**
 * 卡难度 → 包络内偏好船（纯函数）。返回 'claude-headless' | 'zcode-headless' | null。
 * 难度信号优先级：tier 生效（凭据在，zcode 带不动）> tier 档位带 > files_hint 命中
 * 核心/发布路径（高难度）。无信号返回 null（保持默认船，行为与历史一致）。
 */
export function difficultyPref({ meta, tier, cfg } = {}) {
  if (tier?.token) return 'claude-headless'; // tier 凭据只对 claude 系生效（zcode 不支持 tier）
  const name = normalizeTierName(meta?.tier);
  if (name === 'ahead-1' || name === 'ahead-2') return 'zcode-headless';
  if (name === 'ahead-3' || name === 'ahead-4') return 'claude-headless';
  const restricted = [...(cfg?.corePaths ?? []), ...(cfg?.releasePaths ?? [])];
  // 路径表为空 = 航道未设限（hintsOverlap 与空集相交恒真，与 pilotageReason 同一防误判）
  if (restricted.length && hintsOverlap(meta?.files_hint, restricted)) return 'claude-headless';
  return null;
}

/**
 * 单船海况判恶劣（纯函数）：该船对应 harness 客户端绕开狗粮（dogfood_bypass）或未经
 * ModelDock 接管（not_attached）→ 这艘船的燃油实测与 reconcile 对账失效，属「船况恶劣」。
 * 观测缺席（网关不可得 / gatewayAdmin 未开）不判恶劣。熔断（meltdown）不在此判：
 * 网关自动路由会避开熔断服务，包络内换船无益（同一网关），由 decideDispatch 当作
 * 全港风暴整体处理。
 * @returns {{ bad: boolean, reasons: string[] }}
 */
export function shipSeaBad(state, backend) {
  const reasons = [];
  if (state?.mode !== 'ok') return { bad: false, reasons };
  const hid = SHIP_HARNESS[backend];
  if (!hid) return { bad: false, reasons };
  const row = (state.harnesses ?? []).find((h) => h?.id === hid);
  if (!row) return { bad: false, reasons };
  if (row.attached && row.pointing === 'other') {
    reasons.push(`${hid} 客户端指向 ModelDock 之外（dogfood_bypass，燃油实测与对账失效）`);
  } else if (!row.attached) {
    reasons.push(`${hid} 客户端未经 ModelDock 接管（not_attached）`);
  }
  return { bad: reasons.length > 0, reasons };
}

/**
 * 派发海况装配（weather 输入）：窗口内各任务 worker_retry 合计 + 可选上游海况（网关
 * 日志 429/402）+ weatherHold 滞留判定。与 orchestrator.mjs 的 weatherHoldCount 同构件
 * （weather.mjs 纯函数；那份在 CLI 入口文件内不可安全 import——带启动副作用）。
 * weatherHold 未配置时窗口取缺省 60 分钟、重试阈值取缺省 3（与 resolveWeatherHold 同
 * 缺省口径）——海况信号独立于风暴闸开关存在，风暴闸管「停派发」，这里管「别换船」。
 */
export function seaWeather(repoRoot, cfg, { now = Date.now() } = {}) {
  const hold = cfg?.weatherHold ?? null;
  const windowMinutes = Number.isInteger(hold?.windowMinutes) && hold.windowMinutes > 0 ? hold.windowMinutes : 60;
  const logsRoot = path.join(repoRoot, '.agents', 'orchestrator', 'logs');
  const allEvents = [];
  try {
    for (const id of fs.readdirSync(logsRoot)) {
      if (id === 'fleet.jsonl') continue; // fleet 级日志不是任务事件线
      const events = readEvents(path.join(logsRoot, id));
      if (events.length) allEvents.push({ id, events });
    }
  } catch { /* logs/ 不存在 = 还没跑过任务 */ }
  const retryCount = countRecentTransient(allEvents, { windowMs: windowMinutes * 60_000, now });
  let upstream = null;
  if (hold?.upstream?.threshold != null) {
    const gwDir = gatewayLogsDir(cfg);
    const uWindow = Number.isInteger(hold.upstream.windowMinutes) && hold.upstream.windowMinutes > 0 ? hold.upstream.windowMinutes : 15;
    upstream = {
      count: countUpstreamStorm(gwDir, { windowMs: uWindow * 60_000, now }),
      threshold: hold.upstream.threshold,
      windowMinutes: uWindow,
      observed: gwDir != null,
    };
  }
  const retryThreshold = Number.isInteger(hold?.threshold) && hold.threshold > 0 ? hold.threshold : 3;
  const held = hold != null && (shouldHold(retryCount, hold.threshold) || (upstream?.observed === true && shouldHold(upstream.count, upstream.threshold)));
  return { held, retryCount, retryThreshold, windowMinutes, upstream };
}

/**
 * 动态选船决策（纯函数，测试直连）。输入：
 *   cfg            loadWorkflowConfig 结果（dynamicDispatch 已解析，缺省关）
 *   defaultBackend 既有解析链落点（显式 CLI > resume 沿用 > 配置默认）
 *   explicit       用户显式指定（--backend / --worker-backend）——CLI 最高优先，不越权
 *   inherited      resume/retry 沿用上次会话——会话连续性优先，中途不换船
 *   meta / tier    卡 frontmatter 与 resolveTier 结果（难度信号）
 *   fleetState     fetchFleetState 快照（mode: 'ok' | 'unavailable'，可 null）
 *   weather        seaWeather 结果（可 null——视作无风暴信号）
 *   availability   船型 → CLI 探测结果（缺省按可用；注入供测试）
 * 返回 { backend, model, switched, lines, events }：
 *   backend 决策后的执行船（未启用/不越权 = 原样返回 defaultBackend）；
 *   model   换船时按 dynamicDispatch.models[船] 注入的可选模型（仅 claude 系生效）；
 *   lines   日志行（调用方 log）；events 待落任务时间线（dispatch_selected，永不静默）。
 */
export function decideDispatch({ cfg, defaultBackend, explicit = false, inherited = false, meta = {}, tier = null, fleetState = null, weather = null, availability = {} } = {}) {
  const idle = { backend: defaultBackend, model: null, switched: false, lines: [], events: [] };
  const dd = cfg?.dynamicDispatch;
  if (!dd?.enabled) return idle; // 缺省关：决策完全不参与（行为与历史一致）
  if (explicit) return idle; // 显式 CLI 引擎最高优先（--worker-backend / --backend）
  if (inherited) return idle; // resume/retry 沿用：会话连续性优先，中途不换船
  if (defaultBackend === 'mock') return idle; // mock 测试链路照常可用：动态选船永不碰 mock
  const lines = [];
  const events = [];
  const { envelope, ignored } = normalizeEnvelope(dd.envelope);
  for (const ig of ignored) lines.push(`⚠ 动态选船忽略 envelope 项 "${ig.entry}"：${ig.reason}`);
  if (!envelope.length) {
    lines.push('⚠ 动态选船已启用但 envelope 无有效船型（允许 claude-headless | zcode-headless）——按既有规则派发');
    return { ...idle, lines };
  }
  const pref = difficultyPref({ meta, tier, cfg });
  if (pref && pref !== defaultBackend && !envelope.includes(pref)) {
    lines.push(`ℹ 动态选船：卡难度偏好 ${pref} 不在 envelope 内——不自动切（包络外永不自动切），沿用默认船 ${defaultBackend}`);
  }
  // 全港风暴：熔断 / 上游限流 / 重试密集 / weatherHold 滞留。包络内换船无益（同一网关
  // 同一批上游，熔断由网关自动路由避开）——全部恶劣 → 沿用默认并留痕。
  const stormBits = [];
  if (fleetState?.mode === 'ok' && (fleetState.meltdown ?? []).length) {
    stormBits.push(`服务熔断中（${fleetState.meltdown.join(', ')}）`);
  }
  if (weather?.held) stormBits.push('weatherHold 风暴滞留');
  if (weather?.retryThreshold != null && weather.retryCount >= weather.retryThreshold) {
    stormBits.push(`最近 ${weather.windowMinutes} 分钟 worker_retry ${weather.retryCount} 次 ≥ 阈值 ${weather.retryThreshold}`);
  }
  if (weather?.upstream?.observed && weather.upstream.count >= weather.upstream.threshold) {
    stormBits.push(`上游风暴：${weather.upstream.windowMinutes} 分钟内限流/额度请求 ${weather.upstream.count} 次 ≥ 阈值 ${weather.upstream.threshold}`);
  }
  if (stormBits.length) {
    if (pref && pref !== defaultBackend) {
      const reason = `海况恶劣（${stormBits.join('；')}）——按难度本应选 ${pref}，全部包络内船均不宜，沿用默认`;
      events.push({ type: 'dispatch_selected', from: defaultBackend, to: defaultBackend, switched: false, reason });
      lines.push(`⛈ 动态选船：${reason}（dispatch_selected 已留痕）`);
    }
    return { ...idle, lines, events };
  }
  // 候选顺序：难度偏好（包络内才有效）→ 默认船 → 包络其余（配置列出顺序）。
  const order = [];
  for (const c of [pref, defaultBackend, ...envelope]) {
    if (!c) continue;
    if (c !== defaultBackend && !envelope.includes(c)) continue; // 包络是唯一授权边界
    if (!order.includes(c)) order.push(c);
  }
  const badOf = (b) => {
    if (availability[b] === false) return { bad: true, reasons: [`${b} CLI 不可用`] };
    return shipSeaBad(fleetState, b);
  };
  const pick = order.find((b) => !badOf(b).bad);
  if (!pick) {
    // 全部恶劣：沿用默认并留痕（永不静默）
    const reason = `包络内各船海况均恶劣（${[...new Set(order.flatMap((b) => badOf(b).reasons))].join('；')}）——沿用默认`;
    events.push({ type: 'dispatch_selected', from: defaultBackend, to: defaultBackend, switched: false, reason });
    lines.push(`⛈ 动态选船：${reason}（dispatch_selected 已留痕）`);
    return { ...idle, lines, events };
  }
  if (pick === defaultBackend) {
    // 默认船即健康首选：无非常规选择。难度偏好被海况否掉时给一行日志（不落事件）
    if (pref && pref !== defaultBackend && badOf(pref).bad) {
      lines.push(`ℹ 动态选船：按难度本应选 ${pref}，但其海况恶劣（${badOf(pref).reasons.join('；')}）——沿用默认船 ${defaultBackend}`);
    }
    return { ...idle, lines };
  }
  // 换船：包络内 = 配置持久授权（引擎切换人工闸门的包络豁免分支与此同源）
  const skipped = badOf(defaultBackend);
  const reasonBits = [];
  if (pref === pick) reasonBits.push('卡难度偏好（tier/核心路径→高难度）');
  if (skipped.bad) reasonBits.push(`默认船海况恶劣：${skipped.reasons.join('；')}`);
  if (!reasonBits.length) reasonBits.push('按包络内顺序选健康船'); // 兜底（难度偏好被包络裁掉且默认健康时 pick 必为默认，不应到达）
  const model = typeof dd.models?.[pick] === 'string' && dd.models[pick].trim() ? dd.models[pick].trim() : null;
  events.push({ type: 'dispatch_selected', from: defaultBackend, to: pick, switched: true, reason: reasonBits.join('；') });
  lines.push(`🛳 动态选船：${defaultBackend} → ${pick}（${reasonBits.join('；')}；envelope 持久授权，dispatch_selected 留痕）`);
  return { backend: pick, model, switched: true, lines, events };
}

/**
 * cmdRun 派发装配（单点调用）：seaWeather 现算 + CLI 可用性探测 + decideDispatch。
 * 任何一步失败都回落「不决策」按既有规则派发——动态选船是优化，绝不阻断派发。
 */
export async function decideDispatchForRun({ repoRoot, cfg, meta, defaultBackend, explicit, inherited, tier, fleetState }) {
  try {
    const weather = seaWeather(repoRoot, cfg);
    const availability = {
      'claude-headless': claudeAvailable(),
      'zcode-headless': zcodeAvailable(),
    };
    return decideDispatch({ cfg, defaultBackend, explicit, inherited, meta, tier, fleetState, weather, availability });
  } catch (e) {
    return {
      backend: defaultBackend,
      model: null,
      switched: false,
      lines: [`⚠ 动态选船决策失败（${String(e?.message ?? e).slice(0, 160)}）——按既有规则派发`],
      events: [],
    };
  }
}

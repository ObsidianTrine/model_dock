// score.mjs — 卡片量化评分（纯规则，零 LLM）：RICE 的证据化弱化版。
// 行业教训（swkhan）：RICE 四因子各 ±20% 误差最坏复利到约 2 倍——所以因子只取 1-3 三档、
// 输入必须证据化（卡 evidence 数组），产出只用于 drain 定序，不越权改 gate/分级。
// 公式：composite = (value × confidence) / (effort + (risk − 1))
//   value/effort/confidence/risk ∈ 1..3（缺省 2）；range 1/3 .. 9。
//   risk 越高除数越大（风险折价）；confidence 是证据强度（证据化输入的核心因子）。

/** score 四因子缺省档（缺字段按 2 计——中性档，不奖不罚）。 */
export const SCORE_KEYS = ['value', 'effort', 'confidence', 'risk'];

/** 计算复合分；卡未带 score（或四因子全缺）返回 null。 */
export function computeScore(meta) {
  const s = meta?.score;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const has = SCORE_KEYS.some((k) => s[k] !== undefined);
  if (!has) return null;
  const v = clamp3(s.value);
  const e = clamp3(s.effort);
  const c = clamp3(s.confidence);
  const r = clamp3(s.risk);
  return (v * c) / (e + (r - 1));
}

function clamp3(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 2;
  return Math.min(3, Math.max(1, n));
}

/**
 * pickNextCard 的排序键（在 priority 之后做插队判定）：
 *   同 priority 内 → 带分卡先于无分卡；带分卡按 composite 降序；无分卡按 created_at 升序。
 * 返回值用于逐位比较（越小越先跑）。无分卡永不因评分机制被挤到自家 priority 之外
 * （priority 仍是第一位），向后兼容：全无分卡队列行为与历史逐字节一致。
 */
export function orderKey(meta) {
  const score = computeScore(meta);
  if (score == null) return [1, Date.parse(meta?.created_at) || Infinity];
  return [0, -score];
}

/** 逐位比较（queue.mjs pickNextCard 用）：a 先于 b 返回 true。 */
export function keyLess(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

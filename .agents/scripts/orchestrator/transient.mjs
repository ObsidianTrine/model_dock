// transient.mjs — worker 瞬时故障识别（限流/网络抖动）。
// 背景（2026-10-29 夜跑实证）：headless 引擎与交互会话共享上游配额（GLM 并发上限
// ≈2，实测单发也 429），worker 中途死亡最常见诱因是限流——这与 spawn 失败
// （ENOENT = 环境缺配置，重试无意义）性质不同：前者退避重试可自愈，后者直接
// blocked。识别签名取自上游 429 限流体与 Node 网络错误码。
// 仅在「worker 异常结束（无结果块）」时参与判定——正常产出的结果块不做二次猜测。

/** 瞬时故障签名：限流（429/rate limit/overloaded）与网络层错误（连接重置/超时/挂起）。 */
export const TRANSIENT_RE =
  /\b(429|rate.?limit|too many requests|overloaded|overloaded_error|capacity|service unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR|socket hang up|fetch failed)\b/i;

/**
 * 判定 worker 异常结束是否疑似瞬时故障（可退避重试自愈）。
 * @param {string} output worker 输出（zcode = response 或原始 stdout；claude = result 文本）
 * @param {string} [stderrTail] stderr 尾部（claude CLI 把部分上游错误写在 stderr）
 * @returns {boolean}
 */
export function isTransientWorkerFailure(output, stderrTail = '') {
  return TRANSIENT_RE.test(`${String(output ?? '')}\n${String(stderrTail ?? '')}`);
}

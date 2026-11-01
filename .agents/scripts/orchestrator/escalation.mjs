// escalation.mjs — 故障处置升级链（分级自动化审批，船东 2026-11-02 定案）：
//   第 0 档 零成本自动：worker 瞬时故障原地重试（transient.mjs ≤3 次）、调试/审查返工
//     循环、blocked 卡自动续跑（autoresume.mjs：transient 才续、24h 冷却）、watch 有痕重探
//   第 1 档 低成本计费自动（本模块）：zcode 船 prompt 超限（argv 30k 上限）自动切
//     fallback 船并记 engine_escalated 事件——fallbackBackend 写进 workflow.json 即
//     持久授权（同 autopilot 哲学），运行时不再请示
//   第 2 档 高成本人工审批：旗舰档（ahead-4）/ 加大预算 / 换供应商——永不自动
// 红线不变：预算熔断永远硬顶（escalation 不重置、不放宽预算）；所有升档事件留痕（永不静默）。

import { ZCODE_PROMPT_LIMIT } from './backends/zcode-headless.mjs';

/**
 * 判定 zcode 船 prompt 超限是否应自动切 fallback 船（纯函数，测试直连）。
 * 条件全满足才升档：escalation.enabled、当前船是 zcode-headless、prompt 超限、
 * 配置了 fallbackBackend 且 ≠ zcode-headless（防自环）。
 * @returns {{ escalate: boolean, to?: string, reason: string }}
 */
export function shouldEscalatePrompt({ backend, promptLen, cfg } = {}) {
  const esc = cfg?.escalation;
  if (!esc?.enabled) return { escalate: false, reason: 'escalation 未启用' };
  if (backend !== 'zcode-headless') return { escalate: false, reason: '非 zcode 船' };
  if (!(promptLen > ZCODE_PROMPT_LIMIT)) return { escalate: false, reason: '未超限' };
  const to = typeof esc.fallbackBackend === 'string' && esc.fallbackBackend.trim() ? esc.fallbackBackend.trim() : '';
  if (!to || to === 'zcode-headless') return { escalate: false, reason: 'fallbackBackend 未配置或仍指向 zcode（会自环）' };
  return { escalate: true, to, reason: `prompt ${promptLen} > ${ZCODE_PROMPT_LIMIT} 字符（zcode argv 上限）` };
}

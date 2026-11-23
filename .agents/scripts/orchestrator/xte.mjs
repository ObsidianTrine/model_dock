// xte.mjs — 确定性偏航报警（xte = cross track error 航向偏差角）。
// 从 orchestrator.mjs 抽出（watchdog.mjs 同款「可测内核」形态）：纯规则检查，与 LLM
// 看门狗互补——看门狗靠模型判断「有没有实质进展」，这里只认机器可复核的硬信号。三条规则：
//   no_commit   连续 2 个 worker 会话零新提交（HEAD 计数会话首尾对账）
//   test_loop   npm_test 门禁连续 2 轮 fail（从 gate_result 事件判定）
//   scope_drift scope_purity 越界文件数 ≥ max(3, files_hint 长度)
// 每规则每任务至多报一次：内存 Set + 事件播种（resume 跨进程也不重报）。
// 双档（2026-11-15 质量专项 P1-⑥）：no_commit 在 mode='actuate' 下升熔断——afterWorkerSession
// 返回值带 actuate 标记，调用方走与看门狗 circuit_break 同款落位（kill→blocked）；observe
// 档只留痕不动作。test_loop / scope_drift 恒为留痕——kill/熔断仍归预算与看门狗，worker
// 是否空转的机器可复核信号只有 no_commit 一条（审查打转/越界各有门禁与 scope_purity 兜底）。

import { execFileSync } from 'node:child_process';

import { readEvents, appendEvent } from './events.mjs';

/**
 * @param {string} qdir 事件目录（报警留痕 + resume 播种）
 * @param {string} worktree worker 工作树（HEAD 计数对账现场）
 * @param {{ mode?: 'observe'|'actuate', log?: (msg: string) => void, scratchOnly?: boolean }} opts
 *   mode 与看门狗同源（cfg.watchdog.mode）——唯一的双档开关，不另立配置键。
 *   scratchOnly：卡面声明产物不入库（scratch_only: true）——no_commit 规则不适用
 *   （零提交是该卡的合规形态，2026-11-22 bench 发现 1：codex 活干完被误杀）。
 */
export function createXteAlarm(qdir, worktree, { mode = 'observe', log = () => {}, scratchOnly = false } = {}) {
  const fired = new Set(readEvents(qdir).filter((e) => e.type === 'xte_alarm').map((e) => e.rule));
  const report = (rule, detail, { actuate = false } = {}) => {
    if (fired.has(rule)) return null;
    fired.add(rule);
    appendEvent(qdir, 'xte_alarm', { rule, detail });
    const act = actuate && mode === 'actuate';
    // actuate 档日志措辞不能再说「只留痕不动作」——报警语义随档位如实变化
    log(act ? `⛔ 偏航报警（${rule}，actuate 已升级熔断）：${detail}` : `⚠ 偏航报警（${rule}，只留痕不动作）：${detail}`);
    return { rule, detail, actuate: act };
  };
  const headCount = () => {
    try {
      return Number.parseInt(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), 10);
    } catch {
      return null; // git 异常不判（缺数据宁可漏报不误报）
    }
  };
  let sessionStart = null; // 本会话起点的 HEAD 提交数
  let zeroStreak = 0; // 连续零新提交的会话数
  return {
    beforeWorkerSession() {
      sessionStart = headCount();
    },
    /** 会话收尾对账。命中 no_commit 时返回 { rule, detail, actuate }（actuate 档为 true，
     *  调用方据此走熔断落位）；未命中 / git 异常 / 已报过返回 null。
     *  scratchOnly 卡豁免 no_commit（零提交是卡面声明的合规形态，不判空转）。 */
    afterWorkerSession() {
      if (sessionStart === null) return null;
      const end = headCount();
      if (end === null) return null;
      zeroStreak = end === sessionStart ? zeroStreak + 1 : 0;
      sessionStart = null;
      if (zeroStreak >= 2) {
        if (scratchOnly) return null;
        return report('no_commit', `连续 ${zeroStreak} 个 worker 会话零新提交（HEAD 停在 ${end}）——worker 可能空转`, { actuate: true });
      }
      return null;
    },
    testLoop() {
      const results = readEvents(qdir).filter((e) => e.type === 'gate_result' && e.gate === 'npm_test').map((e) => e.result);
      if (results.length >= 2 && results[results.length - 1] === 'fail' && results[results.length - 2] === 'fail') {
        report('test_loop', 'npm_test 门禁连续 2 轮 fail——修复可能在同一处打转');
      }
    },
    scopeDrift(outsideCount, hintLen) {
      const threshold = Math.max(3, hintLen);
      if (outsideCount >= threshold) {
        report('scope_drift', `scope_purity 越界文件 ${outsideCount} 个 ≥ 阈值 ${threshold}——改动面可能失控`);
      }
    },
  };
}

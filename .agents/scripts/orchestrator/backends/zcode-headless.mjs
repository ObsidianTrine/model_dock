// zcode-headless.mjs — 真实后端：包装 ZCode CLI headless（`zcode -p … --json`）。
// 与 claude-headless 平级的第二个真实引擎，供「执行/审查分体、异构互审」组合：
//   worker：--mode yolo（headless 无 TTY 无法确认权限，全自动）+ 项目 hook 红线——
//     cwd=worktree 时加载 worktree 的 .zcode/config.json，Bash matcher 命中
//     policy-zcode.mjs（ORCH_POLICY_ENFORCE=1 时按 policy.mjs 裁决，日常会话直通），
//     与 claude --settings 注入 policy-worker 同一裁决来源。
//   reviewer（readonly）：--mode plan（只读）+ --disallowed-tools 整工具禁用双保险
//     （该旗标不匹配命令模式，只能整工具禁，故红线不靠它）。
// CLI 定位：ORCH_ZCODE_CLI 环境变量优先（ZCode 桌面版不装 PATH 命令，指向应用内
// zcode.cjs，用 node 直跑）；未设则用 PATH 里的 `zcode`。
// 输出：--json 单对象 { response, usage: { inputTokens, outputTokens,
//   cacheReadTokens, cacheWriteTokens }, … }。预算口径与 claude-headless 对齐：
// tokensIn = input + cacheRead + cacheWrite（缓存读计入）。
// 与 claude-headless 的差异（记录在 orchestrator.md）：无 --max-turns（轮次熔断
// 不可用，wall-clock/token 兜底）；无逐 turn 流式事件，预算在结束时一次性回填。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

/** reviewer 整工具禁用清单（只读会话，fail-closed——plan 模式之外的兜底）。 */
const REVIEWER_DISALLOWED = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch'];

/**
 * ZCode CLI 定位与调用形态。返回 { ok, cmd, baseArgs } 或 { ok: false, reason }。
 * ORCH_ZCODE_CLI 指向 .cjs 打包入口时用当前 node 执行（桌面版机器没有 PATH 命令）。
 */
export function zcodeCliSpec() {
  const custom = process.env.ORCH_ZCODE_CLI?.trim();
  if (custom) {
    if (!fs.existsSync(custom)) {
      return { ok: false, reason: `ORCH_ZCODE_CLI 指向的文件不存在：${custom}` };
    }
    return { ok: true, cmd: process.execPath, baseArgs: [custom] };
  }
  return { ok: true, cmd: 'zcode', baseArgs: [] };
}

/** zcode CLI 可用性探测（spawnSync --version，失败即不可用；结果按进程缓存）。 */
let zcodeProbeCache;
export function zcodeAvailable() {
  if (zcodeProbeCache === undefined) {
    const spec = zcodeCliSpec();
    if (!spec.ok) {
      zcodeProbeCache = false;
    } else {
      try {
        const r = spawnSync(spec.cmd, [...spec.baseArgs, '--version'], {
          encoding: 'utf8',
          timeout: 30_000,
          shell: process.platform === 'win32', // Windows 全局命令可能是 .cmd 包装
        });
        zcodeProbeCache = r.status === 0;
      } catch {
        zcodeProbeCache = false;
      }
    }
  }
  return zcodeProbeCache;
}

/** 组装 zcode -p 参数（纯函数，供单测断言）。disallowed 传逗号串（help 认可的形态）。 */
export function buildZcodeArgs({ prompt, mode, disallowed = [] }) {
  const args = ['-p', prompt, '--json', '--no-color', '--mode', mode];
  if (disallowed.length) args.push('--disallowed-tools', disallowed.join(','));
  return args;
}

/**
 * 解析 --json 输出。正常是单个 JSON 对象；容错处理版本差异（前后混入日志行时
 * 逐行找最后一个带 response 字段的可解析 JSON）。解析不到返回 null——调用方
 * 回落用原始 stdout 当输出（契约块解析仍可能工作）。
 */
export function parseHeadlessJson(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object' && 'response' in j) return j;
  } catch {
    // 回落逐行
  }
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    // 从该行拼到文本尾再试（JSON 可能跨行）
    const tail = text.slice(text.indexOf(lines[i]));
    try {
      const j = JSON.parse(tail);
      if (j && typeof j === 'object' && 'response' in j) return j;
    } catch {
      // 继续找更靠前的起始行
    }
  }
  return null;
}

export const zcodeHeadlessBackend = {
  name: 'zcode-headless',

  /**
   * maxTurns 参数接受但忽略：zcode headless 无 --max-turns 旗标，轮次熔断不可用，
   * 预算靠 Budget 的 wall-clock / token 兜底（orchestrator 侧 killTree 不受影响）。
   */
  spawn({ promptFile, cwd, onEvent, readonly }) {
    return new Promise((resolve, reject) => {
      const prompt = fs.readFileSync(promptFile, 'utf8');
      const spec = zcodeCliSpec();
      if (!spec.ok) {
        reject(
          new Error(
            `ZCode CLI 不可用：${spec.reason}\n` +
              `修复：桌面版安装时设 ORCH_ZCODE_CLI=<zcode.cjs 绝对路径>` +
              `（macOS 例：/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs），或安装 PATH 版 zcode CLI。`
          )
        );
        return;
      }
      const mode = readonly ? 'plan' : 'yolo';
      const args = [
        ...spec.baseArgs,
        ...buildZcodeArgs({ prompt, mode, disallowed: readonly ? REVIEWER_DISALLOWED : [] }),
      ];
      // detached：独立进程组，熔断时可整组 kill（kill-tree.mjs）
      const child = spawn(spec.cmd, args, {
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ORCH_POLICY_ENFORCE: '1' },
      });
      onEvent({ type: 'worker_spawned', backend: 'zcode-headless', pid: child.pid });

      let output = '';
      let stderrTail = '';
      let stdoutAll = '';
      let settled = false;

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c) => {
        stdoutAll += c;
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => {
        stderrTail = (stderrTail + c).slice(-4000);
      });

      child.on('error', (e) => {
        if (!settled) {
          settled = true;
          reject(new Error(`ZCode CLI 启动失败（检查 ORCH_ZCODE_CLI / PATH 中的 zcode）：${e.message}`));
        }
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        const j = parseHeadlessJson(stdoutAll);
        output = j?.response ?? stdoutAll;
        let tokensIn = 0;
        let tokensOut = 0;
        if (j?.usage) {
          tokensIn = (j.usage.inputTokens ?? 0) + (j.usage.cacheReadTokens ?? 0) + (j.usage.cacheWriteTokens ?? 0);
          tokensOut = j.usage.outputTokens ?? 0;
          onEvent({ type: 'budget_snapshot', tokens_in: tokensIn, tokens_out: tokensOut });
        }
        resolve({ exitCode: code ?? 1, output, stderrTail, usage: { tokensIn, tokensOut }, pid: child.pid });
      });
    });
  },
};

// zcode-headless.mjs — 真实后端：包装 ZCode CLI headless（`zcode -p … --json`）。
// 与 claude-headless 平级的第二个真实引擎，供「执行/审查分体、异构互审」组合：
//   worker：--mode yolo（headless 无 TTY 无法确认权限，全自动）+ 项目 hook 红线——
//     红线经 ORCH_POLICY_ENFORCE=1 激活 policy-zcode.mjs（与 claude --settings 注入
//     policy-worker 同一裁决来源）。**注册通道必须是用户级 ~/.zcode/cli/config.json**
//     （绝对路径指向主仓库 checkout 的 hook）：项目级 .zcode/config.json 有 workspace
//     trust 门且 headless 下被平台禁用，实证拦不住（详见 policy-zcode.mjs 头注）。
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

/** zcode headless prompt 的 argv 长度上限（字符数）：Windows 命令行 ~32KB 防线，
 *  escalation 升档判定与 buildZcodeArgs 校验共用同一口径。 */
export const ZCODE_PROMPT_LIMIT = 30_000;

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

/**
 * zcode CLI 可用性探测（spawnSync --version，失败即不可用；结果按进程缓存）。
 * 刻意不用 shell:true：真实 spawn 经 argv 直传 prompt（万字符级），套 shell 在
 * Windows 会截断/改写参数——探测必须与 spawn 同语义，宁可误报不可用（回落 worker
 * 同源 + fallback 事件），不可「探测可用、spawn 起不来」（审查无谓转 blocked）。
 */
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
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    // 顺序推进 offset：从每个 '{' 行的真实位置拼到文本尾再试（JSON 可能跨行；
    // 按位置推进避免内容重复时 indexOf 命中更早的相同行）
    const at = text.indexOf(lines[i], offset);
    if (at < 0) continue;
    offset = at;
    try {
      const j = JSON.parse(text.slice(at));
      if (j && typeof j === 'object' && 'response' in j) return j;
    } catch {
      // 起始行不对，推进到下一个 '{' 行再试
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
  spawn({ promptFile, cwd, onEvent, readonly, envPatch }) {
    return new Promise((resolve, reject) => {
      const prompt = fs.readFileSync(promptFile, 'utf8');
      // zcode headless 只能经 argv 传 prompt（无 stdin 形态）：Windows 命令行上限
      // ~32KB，spec 卡会把 design 全文注入背景——超限快速失败并给可操作出路
      if (prompt.length > ZCODE_PROMPT_LIMIT) {
        reject(
          new Error(
            `prompt 过大（${prompt.length} 字符 > ${ZCODE_PROMPT_LIMIT}，zcode headless 经 argv 传递受命令行长度上限约束）。\n` +
              `修复：收窄任务卡背景段（如去掉注入的 design 全文），或该任务改用 --backend claude-headless（stdin 传递无此限制）。`
          )
        );
        return;
      }
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
      // detached：独立进程组，熔断时可整组 kill（kill-tree.mjs）；envPatch 透传 tier 凭据
      //（是否被 ZCode CLI 认属待验证项，不认时为无害 no-op，回落 harness 全局 token）
      const child = spawn(spec.cmd, args, {
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ORCH_POLICY_ENFORCE: '1', ...(envPatch && Object.keys(envPatch).length ? envPatch : {}) },
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

// dsh-headless.mjs — 真实后端：包装 `dsh --profile headless --json -`（DeepSeek Harness
// CLI 的一次性任务模式，0.2.0-rc 实测）。与 claude/zcode/codex 平级的第三个真实引擎。
//
// 红线（双保险，物理层 + hook 桥）：
//   沙箱   dsh 内建 sandbox-policy 经 **DSH_PERMISSION_MODE 环境变量**选档（默认树里
//          mode/policy 都是 !!js 读该 env）——worker=workspace-write（workspace 外
//          file-write 被 Seatbelt/Landlock/ACL 物理拒绝，沙箱不可用 fail-closed 绝不
//          裸跑）；reviewer=read-only。注意 **沙箱不禁网络**（SBPL `(allow default)`，
//          与 codex 的关键差异）——push/publish 物理不可达在 dsh 上不成立。
//   hook   经 `--patch` 临时 overlay 挂 `dsh-hooks-claude-code` 桥 + 生成的 hooks.json
//          （PreToolUse matcher=`bash|pwsh`——dsh 工具名全小写，claude 字面量集
//          /^[A-Za-z0-9_|]+$/ 内做精确匹配，`Bash|PowerShell` 在 dsh 上匹配不到），
//          复用 claude 船同一份 policy-worker.mjs（exit 2 = 阻断，桥协议同源）。
//          已知残差：hook 启动失败按非阻塞记录（协议如此）——文件写仍被沙箱兜住，
//          网络类红线在该窗口失去 hook 保护（不可达 push 的物理防线在 dsh 不存在，
//          见上）。任务卡红线（禁 push/publish）由 prompt 纪律兜第一层。
//
// 与 claude/codex 的差异（记录在 orch-loop.md 后端差异表）：
//   prompt 走 stdin（`-` 占位），无 shell 命令行长度问题；无 --max-turns 旗标（wall/
//   token 熔断杀进程树兜底）；**无 model 旗标**——模型跟随 attach 烤入的
//   agent-default-model（modeldock provider + 船东 set-default 的模型），model 参数
//   接受但忽略（zcode 同款口径；点号别名不在 dsh catalog，擅自点名会请求期失败）。
//   `--json` 为 NDCL 事件流：session→status/text/thinking/tool_call/tool_result→final
//   （final.text=最终答案）；error 事件出现且无 final = 引擎层失败。**无 usage 事件**
//   ——预算不发 budget_snapshot，token 预算靠 wall-clock 熔断兜底（budgetProfiles 必配
//   max_wall_minutes，orch-loop.md:112 的 150 分钟校准依据同源）。
// CLI 定位：ORCH_DSH_CLI 环境变量优先（.cjs/.mjs/.js 桩用当前 node 直跑，测试 e2e 依赖
// 此点）；未设走 PATH 里的 dsh。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quoteArgsForShell, shellCommandline } from '../spawn-shell.mjs';
// workerHookCommand：claude 船同一份 policy-worker.mjs 锚定（主仓绝对路径，防 worktree
// 副本篡改）——dsh hook 桥的 hooks.json 直接复用同一裁决来源。
import { workerHookCommand } from './claude-headless.mjs';

/** dsh hook 桥的 PreToolUse matcher：dsh 工具名是全小写 `bash` / `pwsh`（tool-bash/
 *  tool-pwsh 注册名），claude 字面量集内精确匹配；`Bash|PowerShell` 在 dsh 上永不命中。 */
export const DSH_HOOK_MATCHER = 'bash|pwsh';

/**
 * dsh CLI 定位与调用形态（探测与 spawn 同源，zcode/codex 同款 seam）。
 * 返回 { ok, cmd, baseArgs } 或 { ok: false, reason }。
 */
export function dshCliSpec() {
  const custom = process.env.ORCH_DSH_CLI?.trim();
  if (custom) {
    if (!fs.existsSync(custom)) {
      return { ok: false, reason: `ORCH_DSH_CLI 指向的文件不存在：${custom}` };
    }
    if (/\.(cjs|mjs|js)$/i.test(custom)) return { ok: true, cmd: process.execPath, baseArgs: [custom] };
    return { ok: true, cmd: custom, baseArgs: [] };
  }
  return { ok: true, cmd: 'dsh', baseArgs: [] };
}

/** dsh CLI 可用性探测（spawnSync --version；按进程缓存；win PATH 探测带 shell 命中 .cmd 包装）。 */
let dshProbeCache;
export function dshAvailable() {
  if (dshProbeCache === undefined) {
    try {
      const spec = dshCliSpec();
      const r = spec.ok
        ? spawnSync(spec.cmd, [...spec.baseArgs, '--version'], {
            encoding: 'utf8',
            timeout: 30_000,
            shell: spec.cmd === 'dsh' && process.platform === 'win32',
          })
        : { status: 1 };
      dshProbeCache = r.status === 0;
    } catch {
      dshProbeCache = false;
    }
  }
  return dshProbeCache;
}

/** 组装 dsh headless 参数（纯函数，供单测断言）。任务用 `-` 占位从 stdin 读入。 */
export function buildDshArgs({ patchFile }) {
  const args = ['--profile', 'headless', '--json'];
  if (patchFile) args.push('--patch', patchFile);
  args.push('-'); // prompt 从 stdin 读
  return args;
}

/**
 * 生成 hooks.json（claude 格式）+ `--patch` overlay（挂 dsh-hooks-claude-code 桥），
 * 落在独立临时目录，随任务结束清理。返回 overlay 路径。
 * projectDir 用 worker cwd（worktree）：桥以 CLAUDE_PROJECT_DIR 传给 hook 进程，
 * 与 claude 船 writeWorkerSettings 的 sessionCwd 语义对齐。
 */
export function writeDshHookOverlay(tmpDir, { cwd }) {
  const hooksFile = path.join(tmpDir, 'hooks.json');
  const hooks = {
    hooks: {
      PreToolUse: [
        {
          matcher: DSH_HOOK_MATCHER,
          hooks: [{ type: 'command', command: workerHookCommand(cwd) }],
        },
      ],
    },
  };
  // 文件不含机密（命令行路径），但按仓库写盘惯例仍 0600；win 忽略 mode 无害
  fs.writeFileSync(hooksFile, JSON.stringify(hooks, null, 2), { mode: 0o600 });
  // YAML 手拼：字符串值一律 JSON.stringify（JSON 双引号标量是合法 YAML，免转义歧义）
  const overlay = [
    '- insert:',
    '    - id: hooks-claude-code',
    "      name: '@deepseek-ai/dsh-hooks-claude-code'",
    '      config:',
    `        configPath: ${JSON.stringify(hooksFile)}`,
    `        projectDir: ${JSON.stringify(cwd)}`,
    '',
  ].join('\n');
  const overlayFile = path.join(tmpDir, 'orch-dsh-overlay.yml');
  fs.writeFileSync(overlayFile, overlay, { mode: 0o600 });
  return overlayFile;
}

/**
 * spawn 实参/选项组装（纯函数；win 上 dsh 是 npm .cmd 包装，spawn 必须走 shell；
 * unix 不加 shell（detached 独立进程组 + 熔断杀树依赖它）——codex 系同款）。
 */
export function dshSpawnInvocation(platform, cmd, args, { cwd, envPatch }) {
  const useShell = platform === 'win32';
  const options = {
    cwd,
    detached: !useShell,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(useShell ? { shell: true } : {}),
  };
  // DSH_PERMISSION_MODE 在 envPatch 之后合并：红线选档以本后端决定为准，不受外部覆盖
  options.env = { ...process.env, ...(envPatch && Object.keys(envPatch).length ? envPatch : {}) };
  const [c, spawnArgs] = shellCommandline(cmd, quoteArgsForShell(args, useShell), useShell);
  return { cmd: c, args: spawnArgs, options };
}

/** 从 --json NDCL 输出提取最终答案（最后一个 final.text；无 final 返回 null）。 */
export function outputFromEvents(stdout) {
  let text = null;
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const evt = JSON.parse(t);
      if (evt?.type === 'final' && typeof evt.text === 'string') text = evt.text;
    } catch {
      // 非 JSON 行（版本差异/告警混流）容错跳过
    }
  }
  return text;
}

export const dshHeadlessBackend = {
  name: 'dsh-headless',

  /**
   * maxTurns/model 参数接受但忽略：dsh headless 无轮次旗标（wall/token 熔断兜底）、
   * 无模型旗标（跟随 attach 烤入的 agent-default-model，见文件头注）。
   */
  spawn({ promptFile, cwd, onEvent, readonly, envPatch }) {
    return new Promise((resolve, reject) => {
      const prompt = fs.readFileSync(promptFile, 'utf8');
      const spec = dshCliSpec();
      if (!spec.ok) {
        reject(new Error(`dsh CLI 不可用：${spec.reason}\n修复：设 ORCH_DSH_CLI=<dsh 绝对路径> 或安装 PATH 版 dsh CLI（npm i -g @deepseek-ai/dsh）。`));
        return;
      }
      // -o 无对应物：--json 的 final 事件即最终答案，无独立产物文件
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dsh-'));
      let overlayFile;
      try {
        overlayFile = writeDshHookOverlay(tmpDir, { cwd });
      } catch (e) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        reject(new Error(`dsh hook overlay 写盘失败：${e.message}`));
        return;
      }
      const args = [...spec.baseArgs, ...buildDshArgs({ patchFile: overlayFile })];
      const inv = dshSpawnInvocation(process.platform, spec.cmd, args, {
        cwd,
        envPatch: { ...envPatch, DSH_PERMISSION_MODE: readonly ? 'read-only' : 'workspace-write' },
      });
      let child;
      try {
        child = spawn(inv.cmd, inv.args, inv.options);
      } catch (e) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        reject(new Error(`dsh CLI 启动失败（检查 ORCH_DSH_CLI / PATH 中的 dsh）：${e.message}`));
        return;
      }
      // role 区分 worker/reviewer 会话（resolveBackendName 只认 worker 侧，防 retry 静默换船）
      onEvent({ type: 'worker_spawned', role: readonly ? 'reviewer' : 'worker', backend: 'dsh-headless', pid: child.pid });

      let stdoutAll = '';
      let stderrTail = '';
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
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
          reject(new Error(`dsh CLI 启动失败（检查 ORCH_DSH_CLI / PATH 中的 dsh）：${e.message}`));
        }
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
        const output = outputFromEvents(stdoutAll) ?? '';
        // 无 usage 事件：token 预算不发 snapshot，wall-clock 是唯一真闸（见文件头注）
        resolve({ exitCode: code ?? 1, output, stderrTail, usage: { tokensIn: 0, tokensOut: 0 }, pid: child.pid });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  },
};

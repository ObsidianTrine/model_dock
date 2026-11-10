// codex-headless.mjs — 真实后端：包装 `codex exec --json`（OpenAI Codex CLI 无头模式，
// 0.16x 实测）。与研究/规划家族（runResearchSession/spec planner）和 worker/reviewer 共用
// AgentBackend 契约（types.mjs）。
//
// 沙箱即红线（与 claude 系 policy hook 等价的红线语义，物理层实现）：
//   worker      → workspace-write（codex 沙箱默认禁网——git push / npm publish 需要
//                 网络出口，在沙箱层物理不可达；写 worktree 与跑离线测试不受影响）
//   reviewer    → read-only（fail-closed：写在沙箱层不可能发生，不靠 prompt 自觉）
//   researcher  → read-only + -c tools.web_search=true（只读文件 + 联网检索；非 OpenAI
//                 后端的搜索可用性属模型面问题，research --selftest 供实测）
// prompt 走 stdin（'-' 参数），与 claude 系同纪律：不受 shell 命令行长度限制。
// maxTurns：codex exec 无轮次上限旗标（0.167 二进制无 max_turns 键）——轮次预算靠
// token 流 budget_snapshot + orchestrator 熔断兜底，语义差异留痕于此。
// CLI 定位：ORCH_CODEX_CLI 环境变量（同 ORCH_ZCODE_CLI seam——测试桩与桌面版安装皆用），
// .cjs/.mjs/.js 桩脚本用当前 node 直跑；未设走 PATH 的 codex。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { billableTokens } from '../budget.mjs';
import { quoteArgsForShell, shellCommandline } from '../spawn-shell.mjs';

/**
 * 组装 codex exec 参数（纯函数，供单测断言）。prompt 用 '-' 占位（stdin 读入）。
 * web/readonly → read-only 沙箱；worker → workspace-write。model 可选（-m 显式点名，
 * 未指定时用 codex config.toml 缺省——路由模型由 ModelDock attach 烤入）。
 */
export function buildCodexArgs({ readonly, web, model, lastMessageFile }) {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--color', 'never',
    '-s', web || readonly ? 'read-only' : 'workspace-write',
    '-o', lastMessageFile,
  ];
  if (web) args.push('-c', 'tools.web_search=true');
  if (model) args.push('-m', model);
  args.push('-'); // prompt 从 stdin 读
  return args;
}

/**
 * spawn 实参/选项组装（纯函数；调用处只做 spawn(inv.cmd, inv.args, inv.options)）。
 * cmd 由调用方传入（spec.cmd——ORCH_CODEX_CLI 桩/桌面安装与 PATH codex 同源，zcode 系
 * 同款 seam）。Windows 上 codex 是 npm .cmd 包装，spawn 必须走 shell 才能命中；unix 不加
 * shell（sh -c 包装改变进程组/信号语义，detached 独立进程组 + 熔断杀树依赖它）。
 */
export function codexSpawnInvocation(platform, cmd, args, { cwd, envPatch }) {
  const useShell = platform === 'win32';
  const options = {
    cwd,
    detached: !useShell, // win32 无 detached（shell 包装层无进程组意义）；unix 独立进程组供熔断整组 kill
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(useShell ? { shell: true } : {}),
  };
  if (envPatch && Object.keys(envPatch).length) options.env = { ...process.env, ...envPatch };
  // win32 整串化消 DEP0190（与 claudeSpawnInvocation 同款）；unix 原样数组
  const [c, spawnArgs] = shellCommandline(cmd, quoteArgsForShell(args, useShell), useShell);
  return { cmd: c, args: spawnArgs, options };
}

/**
 * codex CLI 定位：ORCH_CODEX_CLI 优先（同 ORCH_ZCODE_CLI seam，spawn 与探测同源——
 * 与 claude 系「探测专用」不同，zcode/codex 的 CLI 无 claude 那种 settings 契约依赖，
 * 指桩即可全链替换，编排器套件的 e2e 桩测试依赖此点）。脚本型目标（.cjs/.mjs/.js）
 * 用当前 node 直跑，其余按可执行直跑；未设则用 PATH 里的 `codex`。
 */
export function codexCliSpec() {
  const custom = process.env.ORCH_CODEX_CLI?.trim();
  if (!custom) return { ok: true, cmd: 'codex', baseArgs: [] };
  if (!fs.existsSync(custom)) {
    return { ok: false, reason: `ORCH_CODEX_CLI 指向的文件不存在：${custom}` };
  }
  if (/\.(cjs|mjs|js)$/i.test(custom)) return { ok: true, cmd: process.execPath, baseArgs: [custom] };
  return { ok: true, cmd: custom, baseArgs: [] };
}

/** codex CLI 可用性探测（--version；按进程缓存；Windows PATH 探测带 shell 命中 .cmd 包装）。 */
let codexProbeCache;
export function codexAvailable() {
  if (codexProbeCache === undefined) {
    try {
      const spec = codexCliSpec();
      const r = spec.ok
        ? spawnSync(spec.cmd, [...spec.baseArgs, '--version'], {
            encoding: 'utf8',
            timeout: 30_000,
            shell: spec.cmd === 'codex' && process.platform === 'win32',
          })
        : { status: 1 };
      codexProbeCache = r.status === 0;
    } catch {
      codexProbeCache = false;
    }
  }
  return codexProbeCache;
}

/** 从 --json 事件流提取累计 token 用量（结构随版本漂移，防御式解析取 max 快照）。 */
export function usageFromEvent(evt) {
  const u = evt?.usage ?? evt?.info?.total_token_usage ?? null;
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.input_tokens ?? u.input ?? 0);
  const cached = Number(u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0);
  const output = Number(u.output_tokens ?? u.output ?? 0);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return { input: Math.max(0, input), cached: Math.max(0, cached), output: Math.max(0, output) };
}

export const codexHeadlessBackend = {
  name: 'codex-headless',

  spawn({ promptFile, cwd, onEvent, readonly, web, model, envPatch }) {
    return new Promise((resolve, reject) => {
      const prompt = fs.readFileSync(promptFile, 'utf8');
      // -o 产物放独立临时目录，结束即清理（消息正文是编排器的契约块来源）
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-codex-'));
      const lastMessageFile = path.join(tmpDir, 'last-message.txt');
      const spec = codexCliSpec();
      if (!spec.ok) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        reject(new Error(`codex CLI 不可用：${spec.reason}\n修复：设 ORCH_CODEX_CLI=<codex 绝对路径> 或安装 PATH 版 codex CLI。`));
        return;
      }
      const args = [...spec.baseArgs, ...buildCodexArgs({ readonly, web, model, lastMessageFile })];
      const inv = codexSpawnInvocation(process.platform, spec.cmd, args, { cwd, envPatch });
      let child;
      try {
        child = spawn(inv.cmd, inv.args, inv.options);
      } catch (e) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        reject(new Error(`codex CLI 启动失败（检查 ORCH_CODEX_CLI / PATH 中的 codex）：${e.message}`));
        return;
      }
      // role 区分 worker/reviewer/researcher 会话（resolveBackendName 只认 worker 侧，
      // 防 retry/resume 静默换船；孤儿 reviewer/researcher 也得能杀——同 claude 系注释）
      onEvent({ type: 'worker_spawned', role: web ? 'researcher' : readonly ? 'reviewer' : 'worker', backend: 'codex-headless', pid: child.pid, ...(model ? { model } : {}) });

      let tokensIn = 0;
      let tokensOut = 0;
      let cacheReadIn = 0;
      let stderrTail = '';
      let settled = false;

      child.stdout.setEncoding('utf8');
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue; // 非 JSON 行（版本差异/告警混流），容错跳过
          }
          const u = usageFromEvent(evt);
          if (u) {
            // token 用量事件是会话累计快照：取 max 防重复计入（同 claude 系 result 回填口径）
            tokensIn = Math.max(tokensIn, u.input + u.cached);
            tokensOut = Math.max(tokensOut, u.output);
            cacheReadIn = Math.max(cacheReadIn, u.cached);
            onEvent({ type: 'budget_snapshot', tokens_in: tokensIn, tokens_out: tokensOut, tokens_cache_read: cacheReadIn, tokens_billable: billableTokens(tokensIn, tokensOut, cacheReadIn) });
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => {
        stderrTail = (stderrTail + c).slice(-4000);
      });

      child.on('error', (e) => {
        if (!settled) {
          settled = true;
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
          reject(new Error(`codex CLI 启动失败（检查 ORCH_CODEX_CLI / PATH 中的 codex）：${e.message}`));
        }
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        let output = '';
        try {
          output = fs.readFileSync(lastMessageFile, 'utf8');
        } catch {
          output = ''; // 无 -o 产物（早退/崩溃）：空输出走 exitCode + stderrTail 报障
        }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
        resolve({ exitCode: code ?? 1, output, stderrTail, usage: { tokensIn, tokensOut }, pid: child.pid });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  },
};

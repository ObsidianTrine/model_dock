// claude-headless.mjs — 真实后端：包装 `claude -p --output-format stream-json`。
// 权限策略（docs 5.5，P0 评审项，缺一不可）：
//   --permission-mode acceptEdits（自动放行编辑类，headless 无 TTY 无法确认权限）
//   --allowedTools 白名单（命令执行 fail-closed，未列出的 Bash 自动拒绝）
//   --disallowedTools 红线（push/tag/publish 双保险）
//   --settings <worker 专属 settings>（注入 policy-worker.mjs Bash 拦截 hook，
//     只进 worker 会话，不污染项目级 .claude/settings.json）
// 预算口径：tokensIn = input + cache_read + cache_creation（缓存读计入）。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflowConfig } from '../../workflow-config.mjs';
import { quoteArgsForShell } from '../spawn-shell.mjs';
import { zcodeAvailable } from './zcode-headless.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 编辑/只读/git 白名单与项目无关；测试/构建命令从 workflow.json 生成（testCmd/buildCmd/packageManager），
// 不再假设 npm。每条命令按 Bash(prefix:*) 形态放行前缀族。
const BASE_TOOLS = [
  'Edit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
];

/** worker 白名单 = 基础工具 + workflow.json 的 testCmd/buildCmd（缺省再补 npm 惯例形态）。 */
export function allowedTools(cfg = loadWorkflowConfig()) {
  const tools = new Set(BASE_TOOLS);
  const pm = cfg.packageManager || 'npm';
  // 惯例形态：`<pm> test:*` / `<pm> run *` 覆盖脚本化调用；显式 testCmd/buildCmd 再逐条放行
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(pm)) {
    tools.add(`Bash(${pm} test:*)`);
    tools.add(`Bash(${pm} run test:*)`);
    tools.add(`Bash(${pm} run build:*)`);
  }
  for (const cmd of cfg.testCmd ?? []) tools.add(`Bash(${cmd}:*)`);
  if (cfg.buildCmd) tools.add(`Bash(${cfg.buildCmd}:*)`);
  return [...tools];
}

const DISALLOWED_TOOLS = ['Bash(git push:*)', 'Bash(git tag:*)', 'Bash(git -C * push:*)', 'Bash(npm publish:*)', 'Bash(pnpm publish:*)', 'Bash(yarn publish:*)'];

/** 生成 worker 专属 settings 文件（注册 policy-worker.mjs 到 Bash matcher）。
 *  envPatch 非空时并入 settings.env（--settings 优先级高于用户级 settings.json，
 *  tier token 据此覆盖接入时写入的全局凭据）——子进程 env 同时补一份双保险，
 *  两层哪层生效都到得了网关。 */
export function writeWorkerSettings(settingsPath, envPatch = {}) {
  // hook 命令的 cwd 是 worktree；.agents/hooks/policy-worker.mjs 随仓库 checkout 到 worktree 内
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'node .agents/hooks/policy-worker.mjs' }],
        },
      ],
    },
  };
  if (envPatch && Object.keys(envPatch).length) settings.env = { ...envPatch };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
}

/** 组装 claude CLI 参数（纯函数，测试用）。model 可选（--model，执行/审查分源换模型用）。 */
export function buildClaudeArgs({ maxTurns, readonly, model, settingsFile }) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose', // --print 下用 stream-json 必须带 --verbose（claude CLI 校验）
    '--max-turns',
    String(maxTurns),
  ];
  if (model) args.push('--model', model);
  if (readonly) {
    // 只读会话（reviewer）：白名单收敛为只读工具，无 acceptEdits——headless 下
    // 未列入白名单的工具调用被自动拒绝（fail-closed），编辑/命令不可能发生
    args.push('--allowedTools', 'Read', 'Glob', 'Grep');
  } else {
    args.push(
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      ...allowedTools(),
      '--disallowedTools',
      ...DISALLOWED_TOOLS,
    );
  }
  if (settingsFile) args.push('--settings', settingsFile);
  return args;
}

/**
 * spawn 实参/选项组装（纯函数，platform 注入供任意 OS 断言双分支；调用处只做
 * spawn(inv.cmd, inv.args, inv.options)）。
 * Windows 上 claude 是 .cmd 包装，spawn 必须走 shell 才能命中——可用性探测
 * （claudeAvailable）已带 win32 shell，spawn 必须同语义，否则「探测说可用、
 * 实际起不来」，worker/审查全挂落 blocked/。prompt 走 stdin，不受 shell 命令行
 * 长度限制；含空格的 args（--allowedTools 白名单族、--settings 临时路径）由
 * quoteArgsForShell 包引号。unix 不加 shell（sh -c 包装改变进程组/信号语义，
 * detached 独立进程组 + 熔断杀树依赖它）。
 */
export function claudeSpawnInvocation(platform, args, { cwd, envPatch }) {
  const useShell = platform === 'win32';
  const options = {
    cwd,
    detached: !useShell, // win32 无 detached（shell 包装层无进程组意义）；unix 独立进程组，熔断时可整组 kill（kill-tree.mjs）
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(useShell ? { shell: true } : {}),
  };
  if (envPatch && Object.keys(envPatch).length) options.env = { ...process.env, ...envPatch };
  return { cmd: 'claude', args: quoteArgsForShell(args, useShell), options };
}

export const claudeHeadlessBackend = {
  name: 'claude-headless',

  spawn({ promptFile, cwd, maxTurns, onEvent, settingsFile, readonly, model, envPatch }) {
    return new Promise((resolve, reject) => {
      const prompt = fs.readFileSync(promptFile, 'utf8');
      const args = buildClaudeArgs({ maxTurns, readonly, model, settingsFile });

      // detached：独立进程组，熔断时可整组 kill（kill-tree.mjs）——组装细节见
      // claudeSpawnInvocation（win32 shell 同语义探测纪律）
      const inv = claudeSpawnInvocation(process.platform, args, { cwd, envPatch });
      const child = spawn(inv.cmd, inv.args, inv.options);
      onEvent({ type: 'worker_spawned', backend: 'claude-headless', pid: child.pid, ...(model ? { model } : {}) });

      let tokensIn = 0;
      let tokensOut = 0;
      let output = '';
      let stderrTail = '';
      let settled = false;

      const usageFrom = (u = {}) => ({
        input: u.input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheCreate: u.cache_creation_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      });

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
            continue; // 非 JSON 行（版本差异），容错跳过
          }
          if (evt.type === 'assistant' && evt.message?.usage) {
            const u = usageFrom(evt.message.usage);
            tokensIn += u.input + u.cacheRead + u.cacheCreate;
            tokensOut += u.output;
            const turn = (evt.message.id ?? '').slice(-8) || undefined;
            onEvent({ type: 'worker_turn', turn: turn ?? undefined, tool: lastToolName(evt) });
            onEvent({ type: 'budget_snapshot', tokens_in: tokensIn, tokens_out: tokensOut });
          } else if (evt.type === 'result') {
            output = evt.result ?? '';
            if (evt.usage) {
              // result 的 usage 是会话累计，以此为准回填（防漏计）
              const u = usageFrom(evt.usage);
              tokensIn = Math.max(tokensIn, u.input + u.cacheRead + u.cacheCreate);
              tokensOut = Math.max(tokensOut, u.output);
              onEvent({ type: 'budget_snapshot', tokens_in: tokensIn, tokens_out: tokensOut });
            }
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
          reject(new Error(`claude CLI 启动失败（检查 PATH 中是否有 claude）：${e.message}`));
        }
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        resolve({ exitCode: code ?? 1, output, stderrTail, usage: { tokensIn, tokensOut }, pid: child.pid });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  },
};

function lastToolName(evt) {
  const content = evt.message?.content;
  if (!Array.isArray(content)) return undefined;
  const tools = content.filter((c) => c.type === 'tool_use');
  return tools.length ? tools[tools.length - 1].name : undefined;
}

// 供 orchestrator.mjs 动态选择后端
export async function getBackend(name) {
  if (name === 'claude-headless') return claudeHeadlessBackend;
  if (name === 'zcode-headless') return (await import('./zcode-headless.mjs')).zcodeHeadlessBackend;
  if (name === 'mock') return (await import('./mock.mjs')).mockBackend;
  throw new Error(`未知后端 "${name}"（允许：claude-headless | zcode-headless | mock）`);
}

/** claude CLI 可用性探测（spawnSync --version；Windows 走 shell 以命中 .cmd 包装；按进程缓存）。 */
let claudeProbeCache;
export function claudeAvailable() {
  if (claudeProbeCache === undefined) {
    try {
      const r = spawnSync('claude', ['--version'], {
        encoding: 'utf8',
        timeout: 30_000,
        shell: process.platform === 'win32',
      });
      claudeProbeCache = r.status === 0;
    } catch {
      claudeProbeCache = false;
    }
  }
  return claudeProbeCache;
}

/**
 * 审查后端解析（异构审查）：把「执行」与「审查」拆成两个 agent 会话——
 * 但真正解决「既当运动员又当裁判」靠的是**引擎异源**（不同 CLI/模型家族无共同盲区），
 * 仅拆会话仍同源时只能部分去相关。解析顺序：
 *   1. 显式 --review-backend（'same' = 强制与 worker 同源）；
 *   2. 任务上次 review_spawned 的后端（retry/resume 不换审查引擎）；
 *   3. 自动异构：worker 为真实后端时选另一个 CLI 可用的真实后端
 *      （mock worker 永不异构——测试零外部调用前提）；
 *   4. 回落 worker 同源（mode='fallback'，调用方记 review_backend_fallback 事件）。
 * 返回 { name, mode: 'explicit' | 'prior' | 'heterogeneous' | 'fallback' }。
 * 未知显式后端名由调用方经 getBackend 校验（统一报「未知后端」）。
 */
export function resolveReviewBackendName({ worker, explicit, prior, probe } = {}) {
  const probeFn =
    probe ??
    ((name) => {
      if (name === 'claude-headless') return claudeAvailable();
      if (name === 'zcode-headless') return zcodeAvailable();
      return true; // mock 等非 CLI 后端视为可用
    });
  if (explicit) return { name: explicit === 'same' ? worker : explicit, mode: 'explicit' };
  // prior 沿用有个例外：prior 是 mock 而 worker 已换真实后端时忽略——mock reviewer
  // 固定输出「无阻塞」，把它当真实审查结果喂门禁等于跳过审查（且无任何日志）
  if (prior && !(prior === 'mock' && worker !== 'mock')) return { name: prior, mode: 'prior' };
  const OTHER = { 'claude-headless': 'zcode-headless', 'zcode-headless': 'claude-headless' };
  const other = OTHER[worker];
  if (other && probeFn(other)) return { name: other, mode: 'heterogeneous' };
  return { name: worker, mode: 'fallback' };
}

/**
 * 后端名解析：显式 --backend 优先；run 场景（qdir 非空）沿用任务上次会话的后端
 * （retry/resume 续跑不换引擎）；否则缺省 claude-headless。
 * 沿用取**最后一条** worker_spawned：events.jsonl append-only，.find 命中首次运行——
 * 多引擎切换过的任务 resume 会静默切回最初引擎（正是后端切换人工闸门要防的事），
 * 与 cleanupOrphanWorker 的 reverse().find 口径对齐。
 * intent/spec 的规划会话不记账（qdir 传 null），首次即缺省——此前它们直接把
 * opts.backend（undefined）喂给 getBackend 炸「未知后端 "undefined"」（裸跑
 * `spec "..."` 实测踩中；历史测试全带 --backend mock 所以从未暴露）。
 */
export function resolveBackendName(opts, qdir, readEventsFn) {
  if (opts?.backend) return { name: opts.backend, inherited: false };
  const prior = qdir && readEventsFn
    ? [...readEventsFn(qdir)].reverse().find((e) => e.type === 'worker_spawned')?.backend
    : undefined;
  return { name: prior ?? 'claude-headless', inherited: prior !== undefined };
}

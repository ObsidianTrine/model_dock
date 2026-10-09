// claude-headless.mjs — 真实后端：包装 `claude -p --output-format stream-json`。
// 权限策略（docs 5.5，P0 评审项，缺一不可）：
//   --permission-mode acceptEdits（自动放行编辑类，headless 无 TTY 无法确认权限）
//   --allowedTools 白名单（命令执行 fail-closed，未列出的 Bash 自动拒绝）
//   --disallowedTools 红线（push/tag/publish 双保险）
//   --settings <worker 专属 settings>（注入 policy-worker.mjs Bash 拦截 hook，
//     只进 worker 会话，不污染项目级 .claude/settings.json）
// 预算口径：tokensIn = input + cache_read + cache_creation（缓存读计入）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflowConfig } from '../../workflow-config.mjs';

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

/** 生成 worker 专属 settings 文件（注册 policy-worker.mjs 到 Bash matcher）。 */
export function writeWorkerSettings(settingsPath) {
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
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
}

/**
 * 生成 policy hook 注入所需的临时 settings 路径（放在 orchestrator logs 外的
 * 系统临时目录，随任务结束可删）。
 */
export function newWorkerSettingsPath() {
  return path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'orch-settings-')), 'worker-settings.json');
}

export const claudeHeadlessBackend = {
  name: 'claude-headless',

  spawn({ promptFile, cwd, maxTurns, onEvent, settingsFile, readonly }) {
    return new Promise((resolve, reject) => {
      const prompt = fs.readFileSync(promptFile, 'utf8');
      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose', // --print 下用 stream-json 必须带 --verbose（claude CLI 校验）
        '--max-turns',
        String(maxTurns),
      ];
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

      // detached：独立进程组，熔断时可整组 kill（kill-tree.mjs）
      const child = spawn('claude', args, {
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      onEvent({ type: 'worker_spawned', backend: 'claude-headless', pid: child.pid });

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
  if (name === 'mock') return (await import('./mock.mjs')).mockBackend;
  throw new Error(`未知后端 "${name}"（允许：claude-headless | mock）`);
}

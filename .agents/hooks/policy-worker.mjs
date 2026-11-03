#!/usr/bin/env node
// policy-worker.mjs — orchestrator worker/reviewer 会话专用的 PreToolUse hook（Bash matcher）。
// 经 `claude --settings <file>` 只注入自治会话（docs 5.5/5.11），**不注册进
// 项目级 .claude/settings.json**——那里对人工会话同样生效，会误伤日常操作。
//
// 策略守护完整版（Phase 2）：裁决规则集中在 .agents/scripts/policy.mjs
// （evaluateCommand，单一事实来源），本文件只剩壳；拦截与放行均写审计日志。
//
// 间接旁路收敛（P0，2026-11）：命令白名单与 evaluateCommand 都只看命令文本，
// worker 可把 git push 夹进 package.json scripts 再跑白名单 `npm test`（脚本载荷
// 不可见），也可篡改 worktree 内 hook/policy 副本使本 hook 失效。因此放行脚本执行
// 类命令（npm 家族 / testCmd·buildCmd）前加两层环境校验（见 policy.mjs 同名注释）：
//   - hookIntegrityVerdict：本 hook 以 worktree 相对路径运行（回退形态）时，对自身
//     与 policy.mjs 相对 git HEAD 做完整性校验（正常路径 hook 已锚定主仓，此处跳过）；
//   - scriptsTamperVerdict：会话仓库 package.json 相对 git HEAD 有未提交改动即拒。
// 会话不在 git 仓库（无基线）时整体跳过；git 校验异常按 fail-closed 拒绝。
//
// Hook contract（与 guard-develop.mjs 一致）：exit 0 = allow；exit 2 = block，stderr 回传模型。

import { fileURLToPath } from 'node:url';
import {
  evaluateCommand,
  audit,
  triggersScriptExecGuard,
  scriptsTamperVerdict,
  hookIntegrityVerdict,
} from '../scripts/policy.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0); // 无法解析的事件不归我们管
}

const cmd = String(input.tool_input?.command ?? '');
if (!cmd) process.exit(0);
// 会话 cwd：claude CLI 注入（hook 进程 cwd 与它一致，取 input 更可靠，测试可直接伪造）
const sessionCwd = String(input.cwd ?? process.cwd()) || process.cwd();

function block(verdict) {
  audit({ hook: 'policy-worker', tool: 'Bash', decision: 'blocked', reason: verdict.reason, target: cmd.slice(0, 200) });
  console.error(`[policy-worker] 已拦截：${verdict.reason}\n${verdict.advice ?? ''}`.trimEnd());
  process.exit(2);
}

const verdict = evaluateCommand(cmd);
if (!verdict.allowed) {
  block(verdict);
}

// 环境校验只对「会执行 package.json scripts / 配置的 test·build 命令」的命令触发：
// 其他命令（git add/commit 等）不读 scripts，不构成夹带面；且 hook 自身文件有未提交
// 改动时必须仍能 git add/commit（合法守护器任务的提交流程不能被自己的完整性校验卡死）。
if (triggersScriptExecGuard(cmd)) {
  const env = hookIntegrityVerdict(fileURLToPath(import.meta.url), sessionCwd) ?? scriptsTamperVerdict(sessionCwd);
  if (env) block(env);
}

audit({ hook: 'policy-worker', tool: 'Bash', decision: 'allowed', target: cmd.slice(0, 200) });
process.exit(0);

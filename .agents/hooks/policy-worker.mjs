#!/usr/bin/env node
// policy-worker.mjs — orchestrator worker/reviewer 会话专用的 PreToolUse hook（Bash matcher）。
// 经 `claude --settings <file>` 只注入自治会话（docs 5.5/5.11），**不注册进
// 项目级 .claude/settings.json**——那里对人工会话同样生效，会误伤日常操作。
//
// 策略守护完整版（Phase 2）：裁决规则集中在 .agents/scripts/policy.mjs
// （evaluateCommand，单一事实来源），本文件只剩壳；拦截与放行均写审计日志。
//
// Hook contract（与 guard-develop.mjs 一致）：exit 0 = allow；exit 2 = block，stderr 回传模型。

import { evaluateCommand, audit } from '../scripts/policy.mjs';

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

const verdict = evaluateCommand(cmd);
if (verdict.allowed) {
  audit({ hook: 'policy-worker', tool: 'Bash', decision: 'allowed', target: cmd.slice(0, 200) });
  process.exit(0);
}

audit({ hook: 'policy-worker', tool: 'Bash', decision: 'blocked', reason: verdict.reason, target: cmd.slice(0, 200) });
console.error(
  `[policy-worker] 已拦截：${verdict.reason}\n` +
    `发布类红线为人工授权制：用户明确授权发版后，按 release.md「代理发布」节以 AGENTS_ALLOW_RELEASE=1 前缀仅执行白名单形态（旧名 MODELRDOCK_ALLOW_RELEASE=1 兼容）；其余任务需要在任务卡 blocked 状态下由人工执行。`
);
process.exit(2);

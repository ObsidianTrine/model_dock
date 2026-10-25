#!/usr/bin/env node
// policy-zcode.mjs — ZCode Bash 守卫，服务 orchestrator zcode-headless worker 会话。
// 与 claude --settings 注入 policy-worker.mjs 同一裁决来源（policy.mjs evaluateCommand，
// 单一事实来源）。**注册通道（2026-10-25 实证）**：
//   - 用户级 ~/.zcode/cli/config.json 的 hooks 块（绝对路径指向本文件）——无信任门、
//     headless 会话照常执行，是**唯一可靠通道**；指向主仓库 checkout 的本文件。
//   - 项目级 .zcode/config.json 的注册只是交互桌面的备用带（ZCode 对项目级 hook
//     有 workspace trust 门，且 headless 下 workspace hooks feature 直接禁用——
//     两层都过不去，日志 config_project_hooks_pending_trust / workspace_hooks_feature_disabled 实证）。
// 环境变量门控：仅当 ORCH_POLICY_ENFORCE=1（zcode-headless spawn 注入）时执行
// 红线裁决；日常 ZCode 会话直通零拦截（policy-worker 不注册项目级是刻意设计——
// 会误伤日常操作，docs 5.5）。
//
// Hook contract（与 guard-develop.mjs 一致）：exit 0 = allow；exit 2 = block，stderr 回传模型。

import { evaluateCommand, audit } from '../scripts/policy.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

// stdin 读完再判定（避免提前 exit 让 hook runner 写管道撞 EPIPE）
if (process.env.ORCH_POLICY_ENFORCE !== '1') process.exit(0);

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
  audit({ hook: 'policy-zcode', tool: 'Bash', decision: 'allowed', target: cmd.slice(0, 200) });
  process.exit(0);
}

audit({ hook: 'policy-zcode', tool: 'Bash', decision: 'blocked', reason: verdict.reason, target: cmd.slice(0, 200) });
console.error(
  `[policy-zcode] 已拦截：${verdict.reason}\n` +
    `（orchestrator 自治会话红线，与 claude worker 同源；发布类动作永远人工。）`
);
process.exit(2);

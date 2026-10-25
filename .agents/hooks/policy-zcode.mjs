#!/usr/bin/env node
// policy-zcode.mjs — ZCode 项目级 Bash 守卫（.zcode/config.json 注册，Bash matcher）。
// 服务对象：orchestrator zcode-headless worker 会话——与 claude --settings 注入
// policy-worker.mjs 同一裁决来源（policy.mjs evaluateCommand，单一事实来源）。
//
// 环境变量门控：仅当 ORCH_POLICY_ENFORCE=1（zcode-headless spawn 注入）时执行
// 红线裁决；日常 ZCode 会话直通零拦截——policy-worker 不注册项目级是刻意设计
//（会误伤日常操作，docs 5.5），本 hook 是给 ZCode 补上「只进自治会话」的等价通道。
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

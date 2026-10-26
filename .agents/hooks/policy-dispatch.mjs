#!/usr/bin/env node
// policy-dispatch.mjs — 机器级 Bash 红线 dispatcher：用户级 hook 一次注册、全项目生效。
// 动机：policy-zcode.mjs 的用户级注册（~/.zcode/cli/config.json）是绝对路径，每换一个
// 项目都要手工再注册一次。本 dispatcher 注册一次（指向任一稳定副本），按 hook 事件的
// cwd 找该项目自带的 .agents/scripts/policy.mjs 委托裁决——新项目只要带着 .agents/ 就
// 自动受保护，零注册。无 .agents/ 的目录直通零拦截。
// 语义与 policy-zcode.mjs 完全一致：
//   - ORCH_POLICY_ENFORCE=1（zcode-headless spawn 注入）才裁决，日常会话直通；
//   - exit 0 = allow；exit 2 = block，stderr 回传模型；
//   - 裁决与审计都走项目自己的 policy.mjs（workflow.json 红线数据 + audit.jsonl 随项目落）。
// 安装（二选一，见 .agents/workflows/orchestrator.md）：
//   A. 机器级（推荐）：cp 本文件到 ~/.agents/hooks/，用户级 hook 指向它——项目删除/新增都不用改注册。
//   B. 项目级绝对路径：直接注册各项目的 .agents/hooks/policy-zcode.mjs（旧行为，逐项目一份）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

// 事件 cwd 优先（headless spawn 的 hook runner cwd 未必是项目根），缺失回落进程 cwd
const cwd = String(input.cwd ?? '') || process.cwd();
let policy;
try {
  const script = path.join(cwd, '.agents', 'scripts', 'policy.mjs');
  if (!fs.existsSync(script)) process.exit(0); // 非工具链项目：直通
  process.chdir(cwd); // 审计（audit 落 process.cwd()）与项目对齐
  policy = await import(pathToFileURL(script).href);
} catch (e) {
  // 委托失败放行（fail-open）：红线引擎损坏不该把整个会话的 Bash 卡死；
  // claude 系 worker 有独立的 policy-worker 注入兜底，此处告警留痕即可。
  console.error(`[policy-dispatch] 委托 ${cwd} 的 policy.mjs 失败（已放行）：${e?.message ?? e}`);
  process.exit(0);
}

let verdict;
try {
  verdict = policy.evaluateCommand(cmd);
} catch (e) {
  // 同 fail-open：项目 workflow.json 损坏等会让 evaluateCommand 抛错（「配置损坏阻断启动」
  // 的语义止于 orchestrator；hook 崩溃退出只会让红线引擎从此静默失效，比放行更糟）
  console.error(`[policy-dispatch] 裁决异常（已放行，检查 ${cwd}/.agents/workflow.json）：${e?.message ?? e}`);
  process.exit(0);
}
if (verdict.allowed) {
  policy.audit({ hook: 'policy-dispatch', tool: 'Bash', decision: 'allowed', target: cmd.slice(0, 200) });
  process.exit(0);
}

policy.audit({ hook: 'policy-dispatch', tool: 'Bash', decision: 'blocked', reason: verdict.reason, target: cmd.slice(0, 200) });
console.error(
  `[policy-dispatch] 已拦截（项目：${cwd}）：${verdict.reason}\n` +
    `（orchestrator 自治会话红线，与 claude worker 同源；发布类动作永远人工。）`
);
process.exit(2);

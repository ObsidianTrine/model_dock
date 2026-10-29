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

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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
// 'null' 是合法 JSON 但会让下面的裸访问崩（exit 1 = 放行 + 持续报错噪音）——
// 归入「无法解析的事件」走既定容错（评测集 2026-10-hook-eval-failopen 问题 3）
if (input === null || typeof input !== 'object') process.exit(0);

const cmd = String(input.tool_input?.command ?? '');
if (!cmd) process.exit(0);

// 事件 cwd 优先（headless spawn 的 hook runner cwd 未必是项目根），缺失回落进程 cwd
const cwd = String(input.cwd ?? '') || process.cwd();

// ── 防篡改基线（评测集 2026-10-hook-eval-failopen 问题 2：守卫可被守护对象静默关闭）────
// dispatcher 信任事件 cwd 下的 policy.mjs / workflow.json——被守护的 agent 一条
// `echo '…' > .agents/scripts/policy.mjs` 就能让红线整体放行。会话基线：首次观察到这对
// 文件时记 sha256 到 os.tmpdir()（按 cwd+session 键），此后不一致即 fail-closed（exit 2，
// 被篡改≠崩溃，不沿用 fail-open）。12h 过期自动重建——跨会话的合法人工编辑不受影响；
// 人工立即恢复 = 删除基线文件（stderr 给出路径）。基线机制自身失败按 fail-open 放行
// （与文件整体语义一致，不因防护件损坏锁死会话），stderr 留痕。
const BASELINE_DIR = path.join(os.tmpdir(), 'modeldock-policy-baseline');
const BASELINE_STALE_MS = 12 * 60 * 60 * 1000;
const fileStamp = (f) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  } catch {
    return '<gone>'; // 文件被删也算改动
  }
};
function checkTamper(projectRoot, sessionId) {
  try {
    const key = crypto.createHash('sha1').update(`${projectRoot}|${sessionId ?? ''}`).digest('hex');
    const baselineFile = path.join(BASELINE_DIR, `${key}.json`);
    const now = {
      t: Date.now(),
      policy: fileStamp(path.join(projectRoot, '.agents', 'scripts', 'policy.mjs')),
      workflow: fileStamp(path.join(projectRoot, '.agents', 'workflow.json')),
    };
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    } catch {
      /* 首次观察 / 基线损坏：损坏按首次处理并重建 */
    }
    if (prev && typeof prev.t === 'number' && Date.now() - prev.t <= BASELINE_STALE_MS && (prev.policy !== now.policy || prev.workflow !== now.workflow)) {
      return { baselineFile, prev, now };
    }
    fs.mkdirSync(BASELINE_DIR, { recursive: true });
    fs.writeFileSync(baselineFile, JSON.stringify(now));
    return null;
  } catch (e) {
    console.error(`[policy-dispatch] 防篡改基线维护失败（已放行，建议人工核查 .agents/ 是否被改动）：${e?.message ?? e}`);
    return null;
  }
}
function appendAuditDirect(projectRoot, entry) {
  // policy.mjs 被篡改时不能信它的 audit——直接按同 schema 追加进项目审计文件
  try {
    fs.mkdirSync(path.join(projectRoot, '.agents', 'policy'), { recursive: true });
    fs.appendFileSync(path.join(projectRoot, '.agents', 'policy', 'audit.jsonl'), JSON.stringify(entry) + '\n');
  } catch {
    /* 审计失败不影响拦截 */
  }
}

let policy;
try {
  const script = path.join(cwd, '.agents', 'scripts', 'policy.mjs');
  if (!fs.existsSync(script)) process.exit(0); // 非工具链项目：直通
  process.chdir(cwd); // 审计（audit 落 process.cwd()）与项目对齐
  // 篡改检查必须在 import 之前：被改写的 policy.mjs 里的顶层代码不该被执行
  const sessionId = typeof input.session_id === 'string' ? input.session_id : undefined;
  const tamper = checkTamper(cwd, sessionId);
  if (tamper) {
    appendAuditDirect(cwd, {
      hook: 'policy-dispatch',
      tool: 'Bash',
      decision: 'blocked',
      reason: '红线文件被改动（policy.mjs/workflow.json 与会话基线不一致），fail-closed',
      target: cmd.slice(0, 200),
    });
    console.error(
      `[policy-dispatch] 检测到红线文件被改动（与会话基线不一致），本次命令已拦截（fail-closed）。\n` +
        `若是人工合法修改：删除基线文件 ${tamper.baselineFile} 后重试即可。\n` +
        `若非你所为：立即终止会话，git diff 检查 .agents/ 下的改动。`
    );
    process.exit(2);
  }
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

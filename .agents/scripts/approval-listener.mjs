#!/usr/bin/env node
// approval-listener.mjs — 双向批示（approval listener）：飞书交互卡片按钮 → orchestrator 闸门。
//
// 配套 notify.mjs 的 notifyActionCard：需要人工动作的落位事件（awaiting-human / blocked /
// weather_hold）在飞书群里除了文本还多一张 interactive 卡，按钮 value 携带
// { task, action }——本监听器接收飞书卡片回调，验签后映射为
//   node .agents/scripts/orchestrator.mjs <approve|reject|retry> <task-id> [--reason/--note …]
// 并把结果以 toast 文本回复飞书。审计落 .agents/orchestrator/logs/approvals.jsonl。
//
// 安全边界（读改前必读）：
//   - 显式启动才会监听：`node .agents/scripts/approval-listener.mjs [--port N] [--root <仓库根>]`；
//     缺省端口只认 workflow.json 的 notify.listenerPort，都没配就报错退出——**永不缺省监听**。
//   - 只绑 127.0.0.1（本机回环），永不开 0.0.0.0；外网触达须用户自行架转发并自行评估风险。
//   - 验签：请求体/头的 verification token 必须与 env AGENTS_LARK_VERIFICATION_TOKEN 一致
//     （常数时间比较，C13；不一致 403 并落审计——只记事实不记 token 值）；env 未配则
//     拒绝所有动作并提示配置。token 属密钥——不写日志、不入库。
//   - 动作白名单 approve/reject/retry，映射到的都是 orchestrator 既有的人工闸门命令
//     （合并权仍在 feature-branch finish 的门禁与 testCmd），监听器自身不引入新权限。
//   - 幂等：同 task 同 action 60s 内重复请求忽略（防手抖双击连点）。
// 零第三方依赖（.agents/ 工具链红线）。Windows 兼容：路径一律 path.join，spawn 用 process.execPath。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadWorkflowConfig } from './workflow-config.mjs';

/** 动作白名单：映射目标都是 orchestrator 既有 CLI 命令（approve/reject/retry）。 */
export const ACTION_WHITELIST = ['approve', 'reject', 'retry'];

/**
 * 常数时间字符串比较（C13）：先 sha256 归一化到定长再 timingSafeEqual，避免对长度不等
 * 输入提前短路（长度泄漏）。与 src/util/safe-equal.ts 同款实现——监听器是零依赖独立
 * 进程，自实现同算法而非跨目录引 src。
 */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** 幂等窗口：同 task 同 action 在窗口内的重复回调直接忽略（防双击连点）。 */
export const IDEMPOTENCY_WINDOW_MS = 60_000;

/** reject 未附原因时的默认文案（写进 human_gate 事件与 failed 理由）。 */
export const DEFAULT_REJECT_REASON = '卡片批示驳回';

/** spawn orchestrator 子进程的超时：审批命令本身很快（approve 的合并门禁在
 *  feature-branch finish 内部有独立超时），监听器只需防住挂死占住回调连接。 */
const ACTION_TIMEOUT_MS = 30_000;

/** 审计文件（相对仓库根）：ts/task/action/来源 IP/结果 逐行 JSON。 */
export function approvalsAuditPath(repoRoot) {
  return path.join(repoRoot, '.agents', 'orchestrator', 'logs', 'approvals.jsonl');
}

/**
 * 从飞书卡片回调体提取批示动作（兼容 v2 schema 与旧版两种形态）：
 *   v2: { schema:"2.0", header:{ event_type:"card.action.trigger", token }, event:{ action:{ value } } }
 *   旧: { type:"card_action_trigger", token, action:{ value } }
 * value 即按钮 value（{ task, action, reason? }）。不是动作回调 / 结构缺失 → null。
 */
export function parseCardAction(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body.event?.action?.value ?? body.action?.value ?? body.value;
  if (!value || typeof value !== 'object') return null;
  const task = typeof value.task === 'string' ? value.task.trim() : '';
  const action = typeof value.action === 'string' ? value.action.trim() : '';
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (!task || !action) return null;
  return { task, action, ...(reason ? { reason } : {}) };
}

/** 提取 verification token（v2 在 header.token，旧版在顶层 token）；缺失返回 ''。 */
export function extractToken(body) {
  if (!body || typeof body !== 'object') return '';
  const t = body.header?.token ?? body.token;
  return typeof t === 'string' ? t : '';
}

/**
 * 验签：请求 token 必须与 env 配置**常数时间**一致（C13：防时序侧信道逐字节猜测）。
 * 返回 { ok: true } | { ok: false, code: 'missing_env' | 'mismatch' }——
 * env 未配（missing_env）拒绝所有动作并提示配置，绝不静默放行。
 */
export function verifyToken(body, envToken) {
  const configured = typeof envToken === 'string' ? envToken : process.env.AGENTS_LARK_VERIFICATION_TOKEN;
  if (!configured) return { ok: false, code: 'missing_env' };
  if (!safeEqual(extractToken(body), configured)) return { ok: false, code: 'mismatch' };
  return { ok: true };
}

/** 组装 orchestrator CLI 参数（reason 只透传给 reject --reason；retry 的补充指令卡上没有，走空 note）。 */
export function buildActionArgs(action, task, reason) {
  const args = [action, task];
  if (action === 'reject') args.push('--reason', reason || DEFAULT_REJECT_REASON);
  return args;
}

/** toast 文案：动作成功后的飞书回复（任务要求的三句式）。 */
export function successReply(action, task, reason) {
  if (action === 'approve') return { toast: { type: 'success', content: `✅ 已批准合并 ${task}` } };
  if (action === 'reject') return { toast: { type: 'error', content: `❌ 已驳回：${reason || DEFAULT_REJECT_REASON}` } };
  if (action === 'retry') return { toast: { type: 'success', content: `🔁 已打回重跑 ${task}` } };
  return { toast: { type: 'info', content: `已受理 ${action} ${task}` } };
}

/**
 * 生成回调处理器（依赖注入便于单测：spawnFn/now 可替换，auditPath 指向临时目录）。
 * 返回 async (body, ip) => { status, body }。处理序：
 *   url_verification 直接回显 challenge（仅回显无副作用，无动作风险）
 *   → 验签（失败 403，不审计不记日志——token 不落任何盘）
 *   → 提取动作 → 白名单 → 幂等窗口 → spawn orchestrator → 审计 → toast 回复。
 */
export function makeHandler({ repoRoot, scriptPath, spawnFn, auditPath, now = Date.now } = {}) {
  const spawn = spawnFn ?? defaultSpawn;
  const audit = auditPath ?? approvalsAuditPath(repoRoot);
  const recent = new Map(); // `${task}::${action}` → 上次受理 ts（内存窗口，重启即清空——审计有全量留痕）

  const appendAudit = (entry) => {
    try {
      fs.mkdirSync(path.dirname(audit), { recursive: true });
      fs.appendFileSync(audit, JSON.stringify(entry) + '\n');
    } catch { /* 审计失败不影响回调响应（尽力而为，与 notify 同哲学） */ }
  };

  return async function handle(body, ip = '') {
    // 1) url_verification：飞书保存回调配置时的握手，原样回显 challenge
    if (body && typeof body === 'object' && body.type === 'url_verification') {
      return { status: 200, body: { challenge: String(body.challenge ?? '') } };
    }

    // 2) 验签：不一致 403；env 未配拒绝所有动作（错误可操作：附修复建议）。
    //    token 不匹配（已配置 state 下的未授权访问尝试）落审计留痕（C13）——只记事实
    //    不记 token 值（密钥不落盘红线不变）。
    const v = verifyToken(body);
    if (!v.ok) {
      if (v.code === 'missing_env') {
        return {
          status: 403,
          body: { toast: { type: 'error', content: '监听器未配置 AGENTS_LARK_VERIFICATION_TOKEN，已拒绝该动作。修复：启动前 export AGENTS_LARK_VERIFICATION_TOKEN=<飞书开放平台「事件与回调」页的 Verification Token>' } },
        };
      }
      appendAudit({ ts: new Date().toISOString(), ip, result: 'rejected', detail: 'verification_token_mismatch' });
      return {
        status: 403,
        body: { toast: { type: 'error', content: 'verification token 校验失败（请求与监听器配置不一致）——核对飞书开放平台回调配置与 AGENTS_LARK_VERIFICATION_TOKEN 是否同值' } },
      };
    }

    // 3) 提取动作 + 白名单
    const act = parseCardAction(body);
    if (!act) {
      return { status: 400, body: { toast: { type: 'error', content: '无法从回调中解析批示动作（按钮 value 须含 task 与 action 字段）' } } };
    }
    if (!ACTION_WHITELIST.includes(act.action)) {
      appendAudit({ ts: new Date().toISOString(), task: act.task, action: act.action, ip, result: 'rejected' });
      return {
        status: 403,
        body: { toast: { type: 'error', content: `未知动作 "${act.action}"——只支持 ${ACTION_WHITELIST.join(' / ')}` } },
      };
    }

    // 4) 幂等窗口：同 task 同 action 60s 内重复忽略并提示（审计记 duplicate 留痕）
    const key = `${act.task}::${act.action}`;
    const last = recent.get(key);
    const ts = now();
    if (typeof last === 'number' && ts - last < IDEMPOTENCY_WINDOW_MS) {
      appendAudit({ ts: new Date().toISOString(), task: act.task, action: act.action, ip, result: 'duplicate' });
      const waitSec = Math.max(1, Math.ceil((IDEMPOTENCY_WINDOW_MS - (ts - last)) / 1000));
      return {
        status: 200,
        body: { toast: { type: 'info', content: `该批示 ${waitSec}s 内已受理过，已忽略重复点击（防手抖幂等窗口）` } },
      };
    }
    recent.set(key, ts);

    // 5) 映射 orchestrator 既有命令（cwd=仓库根；process.execPath 启动，Windows 同样成立）
    const args = buildActionArgs(act.action, act.task, act.reason);
    let result;
    try {
      result = spawn(['.agents', 'scripts', 'orchestrator.mjs'], args, { repoRoot });
    } catch (e) {
      appendAudit({ ts: new Date().toISOString(), task: act.task, action: act.action, ip, result: 'error', detail: String(e?.message ?? e).slice(0, 300) });
      return {
        status: 500,
        body: { toast: { type: 'error', content: `执行失败：${String(e?.message ?? e)}` } },
      };
    }

    // 6) 审计 + 回复（结果可操作：失败附 orchestrator 输出尾部与排查指引）
    const timedOut = Boolean(result.error && result.killed);
    const ok = !result.error && result.status === 0;
    appendAudit({
      ts: new Date().toISOString(),
      task: act.task,
      action: act.action,
      ip,
      result: ok ? 'ok' : timedOut ? 'timeout' : 'error',
      ...(result.status != null ? { exit: result.status } : {}),
      ...(ok ? {} : { detail: tail(String(result.stderr ?? result.error?.message ?? ''), 300) }),
    });
    if (ok) {
      if (act.action === 'reject') {
        return { status: 200, body: successReply('reject', act.task, act.reason || DEFAULT_REJECT_REASON) };
      }
      return { status: 200, body: successReply(act.action, act.task) };
    }
    if (timedOut) {
      return {
        status: 200,
        body: { toast: { type: 'info', content: `${act.task} 的 ${act.action} 指令等待超时（30s）——动作可能仍在后台执行，稍后用 status ${act.task} 核实，勿连点重发` } },
      };
    }
    const detail = tail(String(result.stderr ?? result.error?.message ?? ''), 200);
    return {
      status: 200,
      body: { toast: { type: 'error', content: `${act.action} ${act.task} 失败（exit ${result.status ?? '?'}）：${detail || '无输出'}。排查：node .agents/scripts/orchestrator.mjs status ${act.task}` } },
    };
  };
}

function tail(s, n) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `…${str.slice(-n)}` : str;
}

/** 默认 spawn：node <repoRoot>/.agents/scripts/orchestrator.mjs …（绝对路径 + process.execPath，三平台一致）。 */
function defaultSpawn(scriptSegments, args, { repoRoot }) {
  const script = path.join(repoRoot, ...scriptSegments);
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: ACTION_TIMEOUT_MS,
  });
}

/**
 * 启动监听（http.createServer + listen(port, '127.0.0.1')）。返回 server 供测试 close。
 * 只收 POST（GET 直接 405）；请求体上限 1MB（防垃圾大包）；回调处理异常兜底 500。
 */
export function startApprovalListener({ port, repoRoot, handler } = {}) {
  const handle = handler ?? makeHandler({ repoRoot });
  const server = http.createServer((req, res) => {
    const ip = req.socket?.remoteAddress ?? '';
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ toast: { type: 'error', content: '只接受 POST（飞书卡片回调）' } }));
      return;
    }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_048_576) { over = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (over) return; // 连接已销毁
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ toast: { type: 'error', content: '请求体不是合法 JSON' } }));
        return;
      }
      let out;
      try {
        out = await handle(body, ip);
      } catch (e) {
        out = { status: 500, body: { toast: { type: 'error', content: `回调处理异常：${String(e?.message ?? e).slice(0, 200)}` } } };
      }
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

/** 解析 CLI 参数：--port N（显式端口）/--root <仓库根>（缺省 = 向上找脚本所在仓库）。 */
function parseArgs(argv) {
  const out = { port: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number.parseInt(argv[++i] ?? '', 10);
    else if (argv[i] === '--root') out.root = argv[++i];
  }
  return out;
}

/** 主入口（直接运行才执行；被测试 import 时只导出函数不监听）。 */
async function main() {
  const here = path.dirname(pathToFileURL(import.meta.url).href);
  const repoRoot = path.resolve(here, '..', '..');
  const { port: portArg, root: rootArg } = parseArgs(process.argv.slice(2));
  const root = path.resolve(rootArg || repoRoot);

  // 端口解析：--port 显式 > workflow.json notify.listenerPort。都没有 → 报错退出（永不缺省监听）。
  let port = Number.isInteger(portArg) && portArg > 0 && portArg <= 65535 ? portArg : null;
  if (port == null) {
    try {
      port = loadWorkflowConfig(root)?.notify?.listenerPort ?? null;
    } catch (e) {
      console.error(`✗ 无法读取 workflow.json：${e.message}`);
      process.exit(1);
    }
  }
  if (port == null) {
    console.error('✗ 未指定监听端口——双向批示监听器永不缺省监听。修复（二选一）：\n'
      + '  1. 启动时显式指定：node .agents/scripts/approval-listener.mjs --port <端口>\n'
      + '  2. 在 .agents/workflow.json 配置：  "notify": { "listenerPort": <端口> }');
    process.exit(1);
  }

  if (!process.env.AGENTS_LARK_VERIFICATION_TOKEN) {
    console.error('✗ 未配置 AGENTS_LARK_VERIFICATION_TOKEN——监听器会拒绝所有动作。修复：\n'
      + '  export AGENTS_LARK_VERIFICATION_TOKEN=<飞书开放平台「事件与回调」页的 Verification Token> 后再启动。');
    process.exit(1);
  }

  const server = startApprovalListener({ port, repoRoot: root });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  }).catch((e) => {
    console.error(`✗ 监听失败（127.0.0.1:${port}）：${e.message}${e.code === 'EADDRINUSE' ? `——端口被占用，换 --port 或释放该端口后重试` : ''}`);
    process.exit(1);
  });
  console.log(`双向批示监听器已就绪：http://127.0.0.1:${port}（仅本机回环）\n`
    + `  动作映射：approve/reject/retry → node .agents/scripts/orchestrator.mjs <action> <task-id>\n`
    + `  审计：${approvalsAuditPath(root)}\n`
    + `  停止：Ctrl+C`);
  server.on('close', () => process.exit(0));
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((e) => {
    console.error(`✗ ${e?.stack ?? e}`);
    process.exit(1);
  });
}

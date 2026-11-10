// push-gate.mjs — push 审查门禁判定核心（push-review-gate 卡，2026-11）。
// 与 policy-dispatch.mjs 同目录（.agents/hooks/）：机器级 hook 目录被守护 agent 写不到，
// 门禁逻辑不经项目文件、无篡改面。policy-dispatch.mjs 动态 import 本模块，并把已加载的
// 项目 policy.mjs 传入——解析原语（envPrefixSpan/gitSubcommand/isPublishCommand）复用项目
// 实现，零重复、与既有红线同一套 token 口径。
//
// 职责：对 Bash 命令里的 git push 段判目标分支——
//   - 命中 main/develop：两条放行路径（AGENTS_ALLOW_PUSH=1 人工授权旁路，认 hook 进程 env
//     与命令前缀 hatch 两形态；24h 内 push-review 结论且 HEAD 未变），否则拦截（可操作三选一）；
//   - 纯分支 push 且目标非保护分支：放行（覆盖既有 policy 一刀切的 publish 拦截）；
//   - 混入 tag/npm publish、force push、--all/--mirror、refspec 无法消歧、未识别 flag 等
//     一律 defer——交回既有 policy 裁决（原样拦截）。门禁对既有红线**只收窄不放行**：
//     仅覆盖「纯 push 段 + publish 类拦截」这一种情形，端口/其他红线永不覆盖；
//     tag 推送（触发 Release）绝不借道本闸，走 AGENTS_ALLOW_RELEASE 既有白名单。
//
// 取舍（fail-safe 口径）：git 子进程 5s 超时——hook 卡死不能堵死会话；超时/解析失败/模块
// 异常一律 defer 走既有裁决（push 仍被既有 publish 红线拦住，只是不用新文案），绝不因门禁
// 自身故障静默放行，也绝不比改造前拦得更死。
// 日志：旁路放行追加 ~/.agents/hooks/push-gate.log（env AGENTS_PUSH_GATE_LOG 重定向，测试
// 与多机器目录用；正常 artifact 放行路径不写日志）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 受 push 审查门禁保护的分支（设计定稿：main 与 develop）。 */
export const PROTECTED_BRANCHES = ['main', 'develop'];
/** 人工授权旁路 env（与 AGENTS_ALLOW_RELEASE 同语义：责任在人）。 */
export const BYPASS_ENV = 'AGENTS_ALLOW_PUSH';
/** push-review 结论有效期（head 一致的前提下）。 */
export const ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ARTIFACT_REL = path.join('.agents', 'orchestrator', 'push-review', 'latest.json');

// push 子命令 flag 表（保守白名单：表外一律「解析不可靠」defer，绝不猜 token 边界）。
const PUSH_BOOL_FLAGS = new Set([
  '-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--atomic', '--follow-tags',
  '--no-verify', '--verify', '--dry-run', '--thin', '--prune', '--progress', '--no-progress',
  '--signed', '--no-signed', '-d', '--delete', '--porcelain', '-4', '--ipv4', '-6', '--ipv6',
  '--no-force-with-lease', '--no-force-if-includes',
]);
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);
const BROAD_FLAGS = new Set(['--all', '--branches', '--mirror', '--tags']);
const FORCE_FLAGS = new Set(['-f', '--force', '--force-with-lease', '--force-if-includes']);

const basename = (t) => String(t ?? '').split(/[\\/]/).pop() ?? '';

/** 默认 git 运行器：成功回 stdout（trim），失败/超时（timeoutMs 兜底）回 null。 */
export function defaultRunGit(cwd, args, timeoutMs = 5000) {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout ?? '').trim();
  } catch {
    return null;
  }
}

/** 存在性探测运行器（show-ref --quiet 无 stdout，只看退出码）。 */
export function defaultRunGitOk(cwd, args, timeoutMs = 5000) {
  try {
    const r = spawnSync('git', args, { cwd, timeout: timeoutMs, stdio: ['ignore', 'ignore', 'ignore'] });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 纯解析：按 policy.mjs 同口径切段（\r\n 归一 + [;&|\n]+），逐段识别 git push / git tag /
 * npm publish。嵌套载荷（bash -c '…'、$(…)）不在此解析——外层词不是 git，push 藏在载荷里
 * 时 hasPush=false，门禁不介入，既有 policy 递归裁决照旧拦截（保守方向）。
 */
export function scanPushCommand(cmd, policy) {
  const segments = String(cmd ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/[;&|\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const pushes = [];
  let hasTag = false;
  let hasNpmPublish = false;
  for (const seg of segments) {
    if (typeof policy?.isPublishCommand === 'function' && policy.isPublishCommand(seg)) hasNpmPublish = true;
    const sub = typeof policy?.gitSubcommand === 'function' ? policy.gitSubcommand(seg) : null;
    if (sub === 'tag' && !/-l|--list/.test(seg)) hasTag = true;
    if (sub !== 'push') continue;
    const parsed = parsePushSegment(seg, policy);
    if (parsed) pushes.push(parsed);
  }
  return { hasPush: pushes.length > 0, pushes, hasTag, hasNpmPublish };
}

/**
 * 解析单条 push 段：git 全局 flag（-C <path>/-c/--git-dir/--work-tree 带值）→ push →
 * push 自身 flag（白名单）→ 位置参数（首个 = remote，其余 = refspec）。
 * unreliable=true 表示遇到表外 flag，token 边界不可靠（调用方必须 defer）。
 * auth=true 表示本段带 AGENTS_ALLOW_PUSH=1 命令前缀 hatch（envPrefixSpan 复用 policy 实现）。
 */
export function parsePushSegment(seg, policy) {
  const tokens = String(seg).trim().split(/\s+/);
  const hatch = typeof policy?.envPrefixSpan === 'function' ? policy.envPrefixSpan(tokens, 0, [`${BYPASS_ENV}=1`]) : { i: 0, auth: false };
  const start = hatch.i;
  const auth = hatch.auth === true;
  let j = start;
  // xargs 包装剥离（与 policy.gitSubcommand 同口径）
  if (/^xargs(\.exe)?$/i.test(basename(tokens[j]))) {
    j += 1;
    while (j < tokens.length && tokens[j].startsWith('-')) {
      const valueFlag = /^-(?:n|P|s|E|L|I|a)$/i.test(tokens[j]);
      j += 1;
      if (valueFlag && j < tokens.length && !tokens[j].startsWith('-')) j += 1;
    }
  }
  if (tokens[j] !== 'git') return null;
  j += 1;
  let gitDir = null;
  let k = j;
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    if (t === '-C') {
      gitDir = tokens[k + 1] ?? null; // -C 形态：分支/结论/HEAD 全按该路径解析
      k += 1;
      continue;
    }
    if (t === '-c' || t === '--git-dir' || t === '--work-tree') {
      k += 1; // 带值全局 flag：跳过参数
      continue;
    }
    if (t === 'push') break;
    if (t.startsWith('-')) continue; // 其他无值全局 flag
    return null; // 其他子命令（gitSubcommand 已判 push——防御）
  }
  if (k >= tokens.length) return null;
  k += 1; // 越过 'push'
  const args = [];
  let broad = false;
  let force = false;
  let unreliable = false;
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    if (!t.startsWith('-')) {
      args.push(t);
      continue;
    }
    const eq = t.indexOf('=');
    if (eq > 1) {
      // --flag=value：值附着，不吞下一 token
      if (BROAD_FLAGS.has(t.slice(0, eq))) broad = true;
      if (FORCE_FLAGS.has(t.slice(0, eq))) force = true;
      continue;
    }
    if (BROAD_FLAGS.has(t)) {
      broad = true; // --all/--mirror/--tags 面太宽，按「可能命中保护分支」处理
      continue;
    }
    if (FORCE_FLAGS.has(t)) {
      force = true; // force push 永不借道审查放行（--force-with-lease 无附着值时不吞下一 token）
      continue;
    }
    if (PUSH_BOOL_FLAGS.has(t)) continue;
    if (PUSH_VALUE_FLAGS.has(t)) {
      k += 1; // 吞值
      continue;
    }
    unreliable = true;
    break;
  }
  return { seg, gitDir, broad, force, unreliable, auth, args };
}

/**
 * refspec → 目标分支。tag 一律 defer（发布动作走既有 AGENTS_ALLOW_RELEASE 白名单，绝不借道）；
 * 裸名 refspec 本地 show-ref 消歧（分支/tag/新分支），消歧失败保守 defer。
 */
export function refspecTarget(rs, repoDir, runGit = defaultRunGit, runGitOk = defaultRunGitOk) {
  let s = String(rs ?? '');
  if (s.startsWith('+')) s = s.slice(1); // force 前缀已在段级 force 判过，这里只剥
  if (!s) return { deferReason: '空 refspec（冒号匹配形态面太宽，保守走既有裁决）' };
  const ci = s.indexOf(':');
  const lhs = ci >= 0 ? s.slice(0, ci) : s;
  const dst = ci >= 0 ? s.slice(ci + 1) : '';
  const branchOf = (ref) => (ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref.startsWith('refs/tags/') ? null : ref);
  if (lhs === '') {
    // 删除形态 `:<ref>`：目标是远程分支删除，同样按分支名判保护
    if (!dst) return { deferReason: '空 refspec（保守走既有裁决）' };
    const n = branchOf(dst);
    if (n === null) return { deferReason: `refspec ${rs} 删除 tag（发布动作走既有裁决）` };
    return { branch: n };
  }
  if (dst) {
    // 显式 dst：推送目标以 dst 为准（HEAD:develop / develop:feature/x 等）
    const n = branchOf(dst);
    if (n === null) return { deferReason: `refspec ${rs} 目标为 tag（发布动作走既有裁决）` };
    return { branch: n };
  }
  if (lhs.startsWith('refs/tags/')) return { deferReason: `refspec ${rs} 是 tag（发布动作走既有裁决）` };
  if (lhs.startsWith('refs/heads/')) return { branch: lhs.slice('refs/heads/'.length) };
  // 裸名可能是分支也可能是 tag（v1.2.3）：本地 show-ref 消歧，失败保守 defer
  const isBranch = runGitOk(repoDir, ['show-ref', '--verify', '--quiet', `refs/heads/${lhs}`]);
  const isTag = runGitOk(repoDir, ['show-ref', '--verify', '--quiet', `refs/tags/${lhs}`]);
  if (isBranch && !isTag) return { branch: lhs };
  if (isTag && !isBranch) return { deferReason: `refspec ${rs} 是 tag（发布动作走既有裁决）` };
  if (!isBranch && !isTag) return { deferReason: `refspec ${rs} 不是本地分支（推新分支请用 HEAD:<分支> 形态；保守走既有裁决）` };
  return { deferReason: `refspec ${rs} 分支与 tag 同名歧义（保守走既有裁决）` };
}

/** 单个 push 段的目标分支集合；broad（--all 等）按保护处理；裸 push 取当前分支。 */
export function resolvePushTargets(p, repoDir, runGit = defaultRunGit, runGitOk = defaultRunGitOk) {
  if (p.unreliable) return { deferReason: 'push 命令含未识别 flag（解析不可靠，保守走既有裁决）' };
  if (p.force) return { deferReason: 'force push 走既有裁决（永不借道审查放行）' };
  if (p.broad) return { branches: [...PROTECTED_BRANCHES], protected: true, broad: true };
  if (p.args.length <= 1) {
    // 裸 push（无参数或只给 remote）：push.default 语义 = 推当前分支
    const cur = runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!cur || cur === 'HEAD') return { deferReason: '裸 push 的当前分支解析失败（保守走既有裁决）' };
    return PROTECTED_BRANCHES.includes(cur) ? { branches: [cur], protected: true } : { branches: [cur], protected: false };
  }
  const branches = [];
  for (const rs of p.args.slice(1)) {
    const t = refspecTarget(rs, repoDir, runGit, runGitOk);
    if (t.deferReason) return t;
    branches.push(t.branch);
  }
  return { branches, protected: branches.some((b) => PROTECTED_BRANCHES.includes(b)) };
}

/**
 * 读 push-review 结论并判放行要件：schema push-verdict/1 + verdict=pass + reviewed_at 24h 内
 * + head 与当前 rev-parse HEAD 一致。cwd 不在仓库内（rev-parse 失败）视为无结论。
 */
export function loadPushArtifact(repoDir, now = Date.now(), runGit = defaultRunGit) {
  let art;
  try {
    art = JSON.parse(fs.readFileSync(path.join(repoDir, ARTIFACT_REL), 'utf8'));
  } catch {
    return { ok: false, detail: '无有效审查结论（.agents/orchestrator/push-review/latest.json 缺失或不可读）' };
  }
  if (art?.schema !== 'push-verdict/1') return { ok: false, detail: '审查结论 schema 不是 push-verdict/1——重跑 orch push-review' };
  if (art?.verdict !== 'pass') return { ok: false, detail: `审查结论为 ${art?.verdict ?? 'unknown'}——verdict=fail 不放行` };
  const t = Date.parse(art?.reviewed_at ?? '');
  if (!Number.isFinite(t)) return { ok: false, detail: '审查结论 reviewed_at 缺失或非法——重跑 orch push-review' };
  const age = now - t;
  if (age < 0 || age > ARTIFACT_MAX_AGE_MS) return { ok: false, detail: `审查结论已超 24h（${art.reviewed_at}）——重跑 orch push-review` };
  const head = runGit(repoDir, ['rev-parse', 'HEAD']);
  const claimed = String(art?.head ?? '').trim();
  if (!head || !claimed || head !== claimed) {
    return { ok: false, detail: `HEAD 已变（结论针对 ${claimed ? claimed.slice(0, 12) : '?'}，当前 ${head ? head.slice(0, 12) : 'rev-parse 失败/非仓库'}）——重跑 orch push-review` };
  }
  return { ok: true, head, age, artifact: art };
}

function blockMessage(branches, detail) {
  return [
    `[policy-dispatch] git push 目标分支 ${branches} 受 push 审查门禁保护——本地提交上远程必须先过整体审查（防夜间未审推送）。`,
    ...(detail ? [`当前不放行原因：${detail}`] : []),
    `三选一：`,
    `  ① 先跑整体审查：node .agents/scripts/orchestrator.mjs push-review（verdict=pass 且 24h 内且 HEAD 未变即自动放行）`,
    `  ② 人工当场授权：AGENTS_ALLOW_PUSH=1 前缀本条命令（与 AGENTS_ALLOW_RELEASE 同语义，责任在人）`,
    `  ③ 确实要推其他分支：显式指名分支名（git push origin <分支>）`,
  ].join('\n');
}

/** 旁路日志落点（env AGENTS_PUSH_GATE_LOG 重定向；缺省机器级 hook 目录，与 dispatcher 同居）。 */
export function bypassLogPath(env = process.env) {
  return env?.AGENTS_PUSH_GATE_LOG || path.join(os.homedir(), '.agents', 'hooks', 'push-gate.log');
}

/** 旁路放行留痕：timestamp + cwd + 分支 + bypass，一行 JSON。尽力而为，失败不阻断。 */
export function appendBypassLog(entry, env = process.env) {
  try {
    const file = bypassLogPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ...entry, hook: 'policy-dispatch' })}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 闸门主判定。返回 { decision, hasPush, hasTag, hasNpmPublish, detail?, targets?, reason?, message?, warning?, logEntry? }：
 *   no-push          命令里没有顶层 git push 段（门禁不介入）
 *   defer            混入 tag/npm publish / force / 解析不可靠 / git 失败——交回既有裁决
 *   pass-unprotected 纯分支 push 且目标非保护分支（放行覆盖）
 *   allow-bypass     保护分支 + 人工授权旁路（env 或命令前缀 hatch；dispatcher 负责警告+日志）
 *   allow-review     保护分支 + 有效 push-review 结论（正常路径，不写日志）
 *   block            保护分支且无放行要件（拦截，message=可操作三选一）
 */
export function evaluatePushGate({ cmd, cwd, env = process.env, now = Date.now(), policy, runGit = defaultRunGit, runGitOk = defaultRunGitOk }) {
  if (!cmd || !String(cmd).includes('git')) return { decision: 'no-push', hasPush: false, hasTag: false, hasNpmPublish: false };
  const scan = scanPushCommand(cmd, policy);
  if (!scan.hasPush) return { decision: 'no-push', hasPush: false, hasTag: scan.hasTag, hasNpmPublish: scan.hasNpmPublish };
  const mixed = { hasPush: true, hasTag: scan.hasTag, hasNpmPublish: scan.hasNpmPublish };
  if (scan.hasTag || scan.hasNpmPublish) {
    return { decision: 'defer', ...mixed, detail: '命令混入 tag/npm publish 段——发布动作走既有裁决（AGENTS_ALLOW_RELEASE 白名单）' };
  }
  const envBypass = env?.[BYPASS_ENV] === '1';
  const resolved = [];
  const seen = new Set();
  let anyProtected = false;
  for (const p of scan.pushes) {
    const repoDir = p.gitDir ? path.resolve(cwd, p.gitDir) : cwd;
    const r = resolvePushTargets(p, repoDir, runGit, runGitOk);
    if (r.deferReason) return { decision: 'defer', ...mixed, detail: r.deferReason };
    resolved.push({ p, repoDir, r });
    for (const b of r.branches ?? []) seen.add(b);
    if (r.protected) anyProtected = true;
  }
  const targets = [...seen];
  if (!anyProtected) {
    return { decision: 'pass-unprotected', ...mixed, targets, detail: `目标分支 ${targets.join(', ') || '(未解析)'} 非保护分支（${PROTECTED_BRANCHES.join('/')}）` };
  }
  const protectedList = targets.filter((b) => PROTECTED_BRANCHES.includes(b)).join('/') || PROTECTED_BRANCHES.join('/');
  let usedBypass = false;
  for (const { p, repoDir } of resolved.filter((x) => x.r.protected)) {
    if (envBypass || p.auth) {
      usedBypass = true; // 人工授权旁路：环境注入或命令前缀 hatch 任一即可
      continue;
    }
    const art = loadPushArtifact(repoDir, now, runGit);
    if (!art.ok) {
      return {
        decision: 'block',
        ...mixed,
        targets,
        reason: `push 审查门禁：${protectedList} 未过整体审查——${art.detail}`,
        message: blockMessage(protectedList, art.detail),
      };
    }
  }
  if (usedBypass) {
    return {
      decision: 'allow-bypass',
      ...mixed,
      targets,
      detail: `人工授权旁路（${BYPASS_ENV}=1）推 ${protectedList}`,
      warning: `[policy-dispatch] ⚠⚠ push 审查门禁人工授权旁路：${BYPASS_ENV}=1（与 AGENTS_ALLOW_RELEASE 同语义）——本次 push ${protectedList} 未过整体审查，责任在人。`,
      logEntry: { ts: new Date(now).toISOString(), cwd, branch: protectedList, bypass: true },
    };
  }
  return { decision: 'allow-review', ...mixed, targets, detail: `push-review 结论 pass（24h 内、HEAD 一致；${protectedList}）` };
}

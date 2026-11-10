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
//   - 混入 tag/npm publish、force push、--all/--mirror、通配 refspec（refs/heads/* 等）、
//     push.default=matching/upstream 的裸 push、refspec 无法消歧、未识别 flag 等
//     一律 defer——交回既有 policy 裁决（原样拦截）。门禁对既有红线**只收窄不放行**：
//     仅覆盖「纯 push 段 + publish 类拦截」这一种情形，端口/其他红线永不覆盖；
//     tag 推送（触发 Release）绝不借道本闸，走 AGENTS_ALLOW_RELEASE 既有白名单。
//     放行覆盖前置二次核验（2026-11 round2）：覆盖只担保 push 段本身的裁决面——放行前对
//     每个 非 push 段独立重跑既有红线（policy.evaluateCommand + 受保护端口字符串保守面），
//     任一命中 → defer 走原拦截路径（复合命令里触端口的段绝不随 push 放行）；--follow-tags
//     可顺带推可达 annotated tag（含 v* 触发 Release），与 --tags 同待遇按保护拦；cd 到其他
//     仓库 / --git-dir/--work-tree 改锚形态一律 defer——工件核验的仓库必须 = 实推的仓库。
//     （2026-11 round3：refspec '+' 前缀强推形态、--repo 位移歧义段一并 defer/保守面。）
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
// round3 全量核对（对 git 2.23 / 2.39.2 实测）：-n 补入 BOOL（--dry-run 短形态，两版一致）；
// --recurse-submodules 刻意不入表——空格形态是否吞值随版本漂移（2.23 不吞值并 fatal
// missing parameter；2.39.2 吞值），表外 defer 保守面；--force-with-lease 空格形态两版
// 都不吞值（OPTARG），按无值处理正确。
const PUSH_BOOL_FLAGS = new Set([
  '-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--atomic',
  '--no-verify', '--verify', '--dry-run', '-n', '--thin', '--prune', '--progress', '--no-progress',
  '--signed', '--no-signed', '-d', '--delete', '--porcelain', '-4', '--ipv4', '-6', '--ipv6',
  '--no-force-with-lease', '--no-force-if-includes',
]);
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);
// --follow-tags 顺带推可达 annotated tag（含 v* 触发 Release）——与 --tags 同待遇按保护拦（round2 P2）
const BROAD_FLAGS = new Set(['--all', '--branches', '--mirror', '--tags', '--follow-tags']);
const FORCE_FLAGS = new Set(['-f', '--force', '--force-with-lease', '--force-if-includes']);
// = 附着形态的已知 flag 头（round3 audit：表外 flag 的 = 附着与空格形态同口径 defer）
const KNOWN_PUSH_FLAGS = new Set([...PUSH_BOOL_FLAGS, ...PUSH_VALUE_FLAGS, ...BROAD_FLAGS, ...FORCE_FLAGS]);

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
 * 解析 cd 段的目标目录（纯语法层，不做 git 判定；round2 P2）：
 *   - 非 cd 段返回 null；`cd`（无参数）按 POSIX 语义解析为 HOME。
 *   - 返回 { seg, target, unreliable: false }，target 为 tilde 展开后的路径（相对路径由调用方
 *     对 cwd 解析）；`cd -`、变量/引号/通配/目标后还有 token 等 token 边界不可靠形态返回
 *     { seg, target: '', unreliable: true }——解析不可靠一律 defer。
 */
export function parseCdTarget(seg, policy) {
  const tokens = String(seg).trim().split(/\s+/);
  const start = typeof policy?.envPrefixSpan === 'function' ? policy.envPrefixSpan(tokens, 0, []).i : 0;
  if (tokens[start] !== 'cd') return null;
  const unreliable = { seg, target: '', unreliable: true };
  let j = start + 1;
  if (tokens[j] === '--') j += 1; // cd -- <dir>
  if (j >= tokens.length) return { seg, target: os.homedir(), unreliable: false }; // 无参数 = HOME
  const raw = tokens[j];
  if (raw.startsWith('-')) return unreliable; // cd - / cd -P 等无法定位目标
  let t = raw;
  const paired = /^(['"])(.*)\1$/.exec(t);
  if (paired) t = paired[2]; // 成对包裹引号剥离（引号内空格已被切段打散，剥不净即不可靠）
  if (t === '~') t = os.homedir();
  else if (t.startsWith('~/')) t = path.join(os.homedir(), t.slice(2));
  if (/['"$*?`[]/.test(t)) return unreliable; // 变量/通配/残留引号：路径解析不可靠
  if (j + 1 < tokens.length) return unreliable; // 目标后还有 token（cd a b 形态）：保守不可靠
  return { seg, target: t, unreliable: false };
}

/**
 * 纯解析：按 policy.mjs 同口径切段（\r\n 归一 + [;&|\n]+），逐段识别 git push / git tag /
 * npm publish。嵌套载荷（bash -c '…'、$(…)）不在此解析——外层词不是 git，push 藏在载荷里
 * 时 hasPush=false，门禁不介入，既有 policy 递归裁决照旧拦截（保守方向）。
 * others = 非 push 段（含解析失败的 push 段）——放行覆盖前须逐段重跑既有红线（round2 P1）；
 * cds = cd 段解析出的目标——供仓库归属核验，保证「工件核验的仓库 = 实推的仓库」（round2 P2）。
 */
export function scanPushCommand(cmd, policy) {
  const segments = String(cmd ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/[;&|\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const pushes = [];
  const others = [];
  const cds = [];
  let hasTag = false;
  let hasNpmPublish = false;
  for (const seg of segments) {
    if (typeof policy?.isPublishCommand === 'function' && policy.isPublishCommand(seg)) hasNpmPublish = true;
    const sub = typeof policy?.gitSubcommand === 'function' ? policy.gitSubcommand(seg) : null;
    if (sub === 'tag' && !/-l|--list/.test(seg)) hasTag = true;
    if (sub !== 'push') {
      others.push(seg);
      const cd = parseCdTarget(seg, policy);
      if (cd) cds.push(cd);
      continue;
    }
    const parsed = parsePushSegment(seg, policy);
    if (parsed) pushes.push(parsed);
    else others.push(seg); // push 段解析失败：与普通段一样交既有红线兜底，绝不参与放行覆盖
  }
  return { hasPush: pushes.length > 0, pushes, hasTag, hasNpmPublish, others, cds };
}

/**
 * 解析单条 push 段：git 全局 flag（-C <path>/-c/--git-dir/--work-tree 带值）→ push →
 * push 自身 flag（白名单）→ 位置参数（首个 = remote，其余 = refspec）。
 * unreliable=true 表示遇到表外 flag，token 边界不可靠（调用方必须 defer）；= 附着形态的
 * 表外 flag 头同样 unreliable（round3 audit：两种形态同口径）。
 * auth=true 表示本段带 AGENTS_ALLOW_PUSH=1 命令前缀 hatch（envPrefixSpan 复用 policy 实现）。
 * repoFlag=true 表示 --repo 出现过（空格 /= 附着两形态）——repository 位与位置参数的角色
 * 关系随 git 版本有歧义，由 resolvePushTargets 按双语义并集保守核验。
 */
export function parsePushSegment(seg, policy) {
  const tokens = String(seg).trim().split(/\s+/);
  const hatch = typeof policy?.envPrefixSpan === 'function' ? policy.envPrefixSpan(tokens, 0, [`${BYPASS_ENV}=1`]) : { i: 0, auth: false };
  const start = hatch.i;
  const auth = hatch.auth === true;
  // round4 P1：env 赋值前缀可改写仓库锚定（GIT_DIR=/other/.git git push …）——工件核验
  // 仓库 ≠ 实推仓库，跨仓借道。前缀里凡出现非旁路 hatch 的赋值一律 defer；旁路赋值
  // （AGENTS_ALLOW_PUSH=1）不误伤。
  for (let e = 0; e < start; e++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(tokens[e]);
    if (m && m[1] !== BYPASS_ENV) {
      return { seg, gitDir: null, broad: false, force: false, unreliable: false, auth, args: [], repoFlag: false, deferReason: `env 赋值前缀 ${m[1]}=… 可改写仓库锚定（跨仓借道面）——保守走既有裁决` };
    }
  }
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
  let deferReason = null;
  let k = j;
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    if (t === '-C') {
      gitDir = tokens[k + 1] ?? null; // -C 形态：分支/结论/HEAD 全按该路径解析
      k += 1;
      continue;
    }
    if (t === '--git-dir' || t === '--work-tree' || t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) {
      // 改变实推仓库的形态（round2 P2）：repoDir 若仍锚事件 cwd，会「工件核验的仓库 ≠ 实推的
      // 仓库」——-C 已捕获进 gitDir 对齐锚定，这两个形态捕获后工件路径仍难对齐 → defer 保守面
      deferReason = 'git --git-dir/--work-tree 改变实推仓库锚定（工件核验仓库无法对齐，保守走既有裁决）';
      if (!t.includes('=')) k += 1; // 空格形态吞值（= 附着形态值在 token 内）
      continue;
    }
    if (t === '-c') {
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
  let repoFlag = false;
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    if (!t.startsWith('-')) {
      args.push(t);
      continue;
    }
    const eq = t.indexOf('=');
    if (eq > 1) {
      // --flag=value：值附着，不吞下一 token
      const head = t.slice(0, eq);
      if (BROAD_FLAGS.has(head)) broad = true;
      if (FORCE_FLAGS.has(head)) force = true;
      if (head === '--repo') repoFlag = true;
      if (!KNOWN_PUSH_FLAGS.has(head)) {
        unreliable = true; // 表外 flag 的 = 附着形态与空格形态同口径 defer（round3 audit）
        break;
      }
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
      if (t === '--repo') repoFlag = true;
      k += 1; // 吞值
      continue;
    }
    unreliable = true;
    break;
  }
  return { seg, gitDir, broad, force, unreliable, auth, args, repoFlag, deferReason };
}

/**
 * refspec → 目标分支。'+' 前缀强推形态（+develop / +HEAD:develop / +:dst 全形态）一律
 * defer——force push 永不借道审查放行，与段级 --force 同口径（round3 P1：前版只剥前缀
 * 不判 force，带有效工件时可走 allow-review 实推非快进强推）；tag 一律 defer（发布动作
 * 走既有 AGENTS_ALLOW_RELEASE 白名单，绝不借道）；通配 refspec（refs/heads/* 等）一律
 * defer——命中面是全部分支，绝不按字面分支名放行；裸名 refspec 本地 show-ref 消歧
 * （分支/tag/新分支），消歧失败保守 defer。
 */
export function refspecTarget(rs, repoDir, runGit = defaultRunGit, runGitOk = defaultRunGitOk) {
  const s = String(rs ?? '');
  if (s.startsWith('+')) {
    return { deferReason: `refspec ${rs} 带 + 强推前缀（force push 永不借道审查放行——保守走既有裁决）` };
  }
  if (!s) return { deferReason: '空 refspec（冒号匹配形态面太宽，保守走既有裁决）' };
  // 通配/glob 元字符（refs/heads/*、feature/*、:refs/heads/* 等）：'*' 会被 branchOf 剥成
  // 字面分支名放行，实际命中含 main/develop 在内的全部分支——与 tag/force 同待遇 defer。
  if (/[*?\\[\]]/.test(s)) return { deferReason: `refspec ${rs} 含通配元字符（命中面是全部分支，绝不自行放行——保守走既有裁决）` };
  const ci = s.indexOf(':');
  const lhs = ci >= 0 ? s.slice(0, ci) : s;
  const dst = ci >= 0 ? s.slice(ci + 1) : '';
  const branchOf = (ref) => (ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref.startsWith('refs/tags/') ? null : ref);
  if (lhs === '') {
    // 删除形态 `:<ref>`：目标是远程分支删除，同样按分支名判保护
    if (!dst) return { deferReason: '空 refspec（保守走既有裁决）' };
    const n = branchOf(dst);
    if (n === null) return { deferReason: `refspec ${rs} 删除 tag（发布动作走既有裁决）` };
    if (!dst.startsWith('refs/heads/')) {
      // round4 P2：dst 裸名可能是 tag（:v1.2.3 删远程 tag 也是发布动作）——本地消歧
      const isTag = runGitOk(repoDir, ['show-ref', '--verify', '--quiet', `refs/tags/${dst}`]);
      const isBranch = runGitOk(repoDir, ['show-ref', '--verify', '--quiet', `refs/heads/${dst}`]);
      if (isTag || !isBranch) return { deferReason: `refspec ${rs} 删除目标「${dst}」不是本地分支（tag/远程独有引用——保守走既有裁决）` };
    }
    return { branch: n };
  }
  if (dst) {
    // 显式 dst：推送目标以 dst 为准（HEAD:develop / develop:feature/x 等）。
    // round4 P2：dst 裸名不消歧会把 HEAD:v1.2.3 当分支 v1.2.3 判非保护——与 lhs 同款
    // show-ref 消歧，是 tag/新建引用/歧义一律 defer。
    if (dst.startsWith('refs/tags/')) return { deferReason: `refspec ${rs} 目标为 tag（发布动作走既有裁决）` };
    if (dst.startsWith('refs/heads/')) return { branch: dst.slice('refs/heads/'.length) };
    const isBranch = runGitOk(repoDir, ['show-ref', '--verify', '--quiet', `refs/heads/${dst}`]);
    const isTag = runGitOk(repoDir, ['show-ref', '--verify', '--quiet', `refs/tags/${dst}`]);
    if (isBranch && !isTag) return { branch: dst };
    return { deferReason: `refspec ${rs} 的目标「${dst}」不是本地分支（tag/新建引用/歧义面——保守走既有裁决）` };
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

/**
 * 裸 push（实推 refspec 集为空，目标由 push.default 决定）的分支解析：缺省（未配置）与
 * simple/current 才是「推当前分支」；matching 推全部同名分支、upstream/tracking 推
 * upstream（可能与当前分支不同名），命中面不确定 → 保守 defer（表外一律 defer）。
 */
function barePushTargets(repoDir, runGit) {
  const pd = runGit(repoDir, ['config', 'push.default']);
  if (pd && !['simple', 'current'].includes(pd)) {
    return { deferReason: `裸 push 的 push.default=${pd}（推全部同名分支或 upstream，命中面不确定——保守走既有裁决）` };
  }
  const cur = runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!cur || cur === 'HEAD') return { deferReason: '裸 push 的当前分支解析失败（保守走既有裁决）' };
  return { branches: [cur], protected: PROTECTED_BRANCHES.includes(cur) };
}

/**
 * 单个 push 段的目标分支集合；broad（--all 等）一律 defer（round4 P1：借工件/旁路放行
 * tag/Release 面）；裸 push 与 --repo 位移形态
 * 见 barePushTargets / repoFlag 并集口径（round3 P1）。
 */
export function resolvePushTargets(p, repoDir, runGit = defaultRunGit, runGitOk = defaultRunGitOk) {
  if (p.deferReason) return { deferReason: p.deferReason };
  if (p.unreliable) return { deferReason: 'push 命令含未识别 flag（解析不可靠，保守走既有裁决）' };
  if (p.force) return { deferReason: 'force push 走既有裁决（永不借道审查放行）' };
  if (p.broad) {
    // round4 P1：broad 形态（--all/--mirror/--tags/--follow-tags/--branches）实推范围不可
    // 枚举（含 annotated tag——v* 推送即触发 Release），**永不借道审查放行**：工件与
    // AGENTS_ALLOW_PUSH 旁路均不适用，一律 defer 走既有「发布动作人工授权制」拦截。
    return { deferReason: 'broad push（--all/--mirror/--tags/--follow-tags/--branches）实推范围不可枚举（含 tag/Release 面）——永不借道审查放行，交既有裁决' };
  }
  if (p.repoFlag) {
    // --repo <r>（round3 P1）：repository 位被 flag 占用后，位置参数的角色随 git 版本有歧义——
    //   评审口径（现代 git）：--repo 占 repository 位，位置参数全是 refspec（`--repo origin
    //   develop` 实推 develop）；git 2.23 / 2.39.2 实测：位置参数首个仍占 repository 位
    //   （--repo 被忽略），`--repo origin develop` 实推**当前分支**到名为 develop 的仓。
    // 门禁按两种语义的**并集**保守核验：① 全部位置参数按 refspec 消歧（评审口径，绝不落入
    // 单一「裸 push 按当前分支」误判——前版在此放行非保护分支检出上的 develop 实推）；
    // ② 恰有一个位置参数时叠加裸 push 当前分支口径（实测口径的镜像借道：refspec 看着非
    // 保护、实推的当前分支可能是保护分支）。任一语义命中保护分支即按保护处理，refspec
    // 消歧失败一律 defer。
    const branches = new Set();
    for (const rs of p.args) {
      const t = refspecTarget(rs, repoDir, runGit, runGitOk);
      if (t.deferReason) return t;
      branches.add(t.branch);
    }
    if (p.args.length <= 1) {
      const bare = barePushTargets(repoDir, runGit);
      if (bare.deferReason) return bare;
      for (const b of bare.branches) branches.add(b);
    }
    const list = [...branches];
    return { branches: list, protected: list.some((b) => PROTECTED_BRANCHES.includes(b)) };
  }
  if (p.args.length <= 1) {
    // 裸 push（无参数或只给 remote）
    return barePushTargets(repoDir, runGit);
  }
  const branches = [];
  for (const rs of p.args.slice(1)) {
    const t = refspecTarget(rs, repoDir, runGit, runGitOk);
    if (t.deferReason) return t;
    branches.push(t.branch);
  }
  return { branches, protected: branches.some((b) => PROTECTED_BRANCHES.includes(b)) };
}

/** 短 sha 长度（工件 head_sha 的口径，写入侧 push-review.mjs 同步使用）。 */
export const SHORT_SHA_LEN = 12;

/**
 * 读 push-review 结论并判放行要件：schema push-verdict/1 + verdict=pass + reviewed_at 24h 内
 * + 防伪造三件套核验 + head 与当前 rev-parse HEAD 一致。cwd 不在仓库内（rev-parse 失败）视为无结论。
 *
 * 防伪造口径（成本抬高层，非密码学防护）：latest.json 是仓库内普通文件，被守护的 agent/worker
 * 理论上写得到——工件头带 head_sha（短）+ head_sha_full（全 sha）+ generation（写工件时盖的
 * 高精度时间戳），gate 双向核验后，「随手编辑一个 json 就能过」变成「需真跑 orch push-review
 * 才能产出齐套字段」。它防的是 agent 顺手造假，不防蓄意攻击者（读得到本文件即可伪造全部字段）；
 * 完全防线 = hook 只拦 agent 会话 + AGENTS_ALLOW_PUSH 人工在环（与 AGENTS_ALLOW_RELEASE 同信任级）。
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
  // 防伪造三件套（见函数头注释）：generation 格式存在即可 + short/full 双向与 rev-parse 一致
  if (!/^\d{15,}$/.test(String(art?.generation ?? ''))) {
    return { ok: false, detail: '审查结论缺 generation 戳（工件疑似手改而非 push-review 产出）——重跑 orch push-review' };
  }
  const head = runGit(repoDir, ['rev-parse', 'HEAD']);
  const claimed = String(art?.head ?? '').trim().toLowerCase();
  const claimedFull = String(art?.head_sha_full ?? '').trim().toLowerCase();
  const claimedShort = String(art?.head_sha ?? '').trim().toLowerCase();
  if (
    !head || !claimed || claimed !== head ||
    !claimedFull || claimedFull !== head ||
    !claimedShort || claimedShort !== head.slice(0, SHORT_SHA_LEN)
  ) {
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
 * 放行覆盖前置核验（round2：P1 复合命令跨段放行 + P2 cd/--git-dir 跨仓锚定）。
 * 返回 defer 原因字符串；null = 核验通过。覆盖只担保 push 段本身的裁决面：
 *   ① 每个 非 push 段独立重跑既有红线（policy.evaluateCommand）——任一命中即 defer。
 *     根因：policy.mjs evaluateSegments 的 pushSeen 先于 portBlock 返回，复合命令的 rule
 *     可能是 'publish' 而端口段只落进 portBlock——逐段复评才能把非 publish 红线找回来；
 *   ② 非 push 段仅含受保护端口字符串也 defer（保守面）：端口红线是否真命中不由门禁复判
 *     （listen 词表外的形态如 ssh -R 8687 不在 policy 拦截面），只要有涉就交回既有裁决；
 *   ③ cd 段核验仓库归属：解析出的 toplevel 与事件 cwd 不同 → defer（工件核验的仓库必须
 *     = 实推的仓库）；非仓库目录（push 本身会失败，如 cd /tmp）与本仓路径不拦。
 */
function overrideRefusal(scan, { cwd, policy, runGit }) {
  if (scan.others.length) {
    if (typeof policy?.evaluateCommand !== 'function') {
      return '无法对非 push 段复跑既有红线（policy.evaluateCommand 不可用）——保守走既有裁决';
    }
    let ports = [];
    if (typeof policy?.protectedPorts === 'function') {
      try {
        const p = policy.protectedPorts();
        if (Array.isArray(p)) ports = p;
      } catch {
        ports = []; // 配置读取失败不在此拦（dispatcher 侧 evaluateCommand 有自己的容错）
      }
    }
    for (const seg of scan.others) {
      let v = null;
      try {
        v = policy.evaluateCommand(seg);
      } catch (e) {
        return `非 push 段复跑既有红线失败（${e?.message ?? e}）——保守走既有裁决`;
      }
      if (v && !v.allowed) {
        return `复合命令的非 push 段命中既有红线（${v.rule ?? '?'}）——门禁放行覆盖只限 push 段，走既有裁决`;
      }
      const port = ports.find((p) => seg.includes(p));
      if (port) {
        return `复合命令的非 push 段涉及受保护端口 ${port}——端口等非 publish 红线永不覆盖，走既有裁决`;
      }
    }
  }
  if (scan.cds.length) {
    const baseTop = runGit(cwd, ['rev-parse', '--show-toplevel']);
    for (const cd of scan.cds) {
      if (cd.unreliable || !cd.target) {
        return `cd 目标解析不可靠（${cd.seg}）——跨仓 push 无法排除，保守走既有裁决`;
      }
      const top = runGit(path.resolve(cwd, cd.target), ['rev-parse', '--show-toplevel']);
      if (top && top !== baseTop) {
        return `cd 切换到其他仓库（${cd.target}）——工件核验仓库与实推仓库不一致，保守走既有裁决`;
      }
    }
  }
  return null;
}

/**
 * 闸门主判定。返回 { decision, hasPush, hasTag, hasNpmPublish, detail?, targets?, reason?, message?, warning?, logEntry? }：
 *   no-push          命令里没有顶层 git push 段（门禁不介入）
 *   defer            混入 tag/npm publish / force / 解析不可靠 / git 失败 / 非 push 段命中
 *                    既有红线或涉受保护端口 / cd 跨仓或解析不可靠——交回既有裁决
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
  // 放行覆盖前置核验（round2）：非 push 段红线复评 + cd 跨仓锚定——任一命中即 defer，
  // 走既有裁决的原拦截路径（端口等其他红线永不覆盖，见 overrideRefusal 注释）。
  const refused = overrideRefusal(scan, { cwd, policy, runGit });
  if (refused) return { decision: 'defer', ...mixed, detail: refused };
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

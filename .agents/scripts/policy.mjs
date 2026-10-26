// policy.mjs — orchestrator 集中策略引擎（Phase 2「策略守护完整版」核心，docs 2.5 interceptor 模式）。
// 单一事实来源：guard-develop.mjs / policy-worker.mjs 都是它的薄壳 hook；
// 项目专属红线数据（受保护端口/核心路径/发布流水线）全部来自 .agents/workflow.json
// （见 workflow-config.mjs）——缺省即关闭，代码不再携带任何项目专属数据，可移植到任意项目。
// 发布动作红线（push/tag/publish 人工授权制）与 escape hatch（AGENTS_ALLOW_RELEASE=1 命令前缀，
// 旧项目名 MODELRDOCK_ALLOW_RELEASE 永远兼容）硬编码在此，默认不可配置关闭（docs 第 8 章）。
// 零第三方依赖（.agents/ 工具链红线）；audit 为 append-only JSONL，尽力而为不阻断。

import fs from 'node:fs';
import path from 'node:path';
import { toIsoLocal } from './orchestrator/events.mjs';
import { loadWorkflowConfig, releaseHatches } from './workflow-config.mjs';

// ---------------------------------------------------------------------------
// 规则数据（配置驱动；hook 场景脚本锚定，orchestrator 场景经参数注入 repoRoot 配置）
// ---------------------------------------------------------------------------

/** 受保护端口（workflow.json protectedPorts，缺省空 = 不做端口红线）。 */
export function protectedPorts() {
  return loadWorkflowConfig().protectedPorts;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 监听类命令的项目自备可执行名（workflow.json listenCommandNames，缺省空）。
 * node/tsx/npx/npm run 是语言生态通用形态永远参与拦截；项目自装 CLI（如本仓库的
 * modeldock/gateway）经配置注入——代码不携带任何项目专属命令名。
 */
export function listenCommandNames(cfg) {
  return (cfg ?? loadWorkflowConfig()).listenCommandNames;
}

/**
 * 基准分支集合（guard 的保护对象）。
 * workflow.json `baseBranches` 显式清单存在 = 保护集合为它 ∪ 合并目标（多基准分支仓库，
 * 如 develop+master）；缺省 = main + 合并目标（baseBranch，缺省 develop）。
 */
export function BASE_BRANCHES(cfg) {
  const c = cfg ?? loadWorkflowConfig();
  const target = c.baseBranch || 'develop';
  return [...new Set([...(c.baseBranches.length ? c.baseBranches : ['main']), target])];
}

/** 核心路径：改动即 L2（人工批准），自动合并永不放行。 */
export function corePaths(cfg) {
  return (cfg ?? loadWorkflowConfig()).corePaths;
}

/** 发布流水线：触及即 L3（永远人工）。 */
export function releasePaths(cfg) {
  return (cfg ?? loadWorkflowConfig()).releasePaths;
}

/** L0 白名单：纯文档/测试/杂项，全部命中才可 L0（与项目无关，硬编码）。 */
const L0_ALLOW = [/\.md$/i, /^docs\//, /^test\//, /^CHANGELOG\.md$/i, /^LICENSE$/i, /^\.gitignore$/, /^\.agents\//];

// ---------------------------------------------------------------------------
// Bash 命令红线（policy-worker 的裁决核心）
// ---------------------------------------------------------------------------

/** git 命令检测：git [flag 参数...] <子命令>，兼容 -C repo / -c a=b 等带值 flag，
 *  并跳过前缀环境变量赋值与 env 包装（`VAR=x git push` 曾被误判为非 git 命令而漏拦）。 */
export function gitSubcommand(cmd) {
  const tokens = String(cmd).trim().split(/\s+/);
  let start = 0;
  while (start < tokens.length && (tokens[start] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]))) start += 1;
  if (tokens[start] !== 'git') return null;
  for (let i = start + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-C' || t === '--git-dir' || t === '--work-tree' || t === '-c') {
      i += 1; // 带值 flag：跳过它的参数
      continue;
    }
    if (t.startsWith('-')) continue; // --quiet 等无值 flag
    return t; // 第一个子命令
  }
  return null;
}

/** 发版授权 hatch（AGENTS_ALLOW_RELEASE=1 命令前缀，旧名 MODELRDOCK_ALLOW_RELEASE=1 兼容）唯一放行的形态——
 *  推 main / master / develop（发布分支与收尾对齐）、推/删 v<semver> tag、打 annotated / 删本地 v<semver> tag。
 *  --tags、force push、其他分支/ref、多 ref、轻量 tag、npm publish 永不在白名单。 */
const RELEASE_TAG = 'v\\d+\\.\\d+\\.\\d+';
const RELEASE_ALLOW = [
  new RegExp(`^git push origin main$`),
  new RegExp(`^git push origin master$`),
  new RegExp(`^git push origin develop$`),
  new RegExp(`^git push origin ${RELEASE_TAG}$`),
  new RegExp(`^git push origin :refs/tags/${RELEASE_TAG}$`),
  new RegExp(`^git tag -a ${RELEASE_TAG} -m .+$`),
  new RegExp(`^git tag -d ${RELEASE_TAG}$`),
];

/**
 * Bash 命令红线裁决。返回 { allowed, rule?, reason? }。
 * 覆盖：发布动作（push/tag/publish，人工授权制）、受保护端口（workflow.json protectedPorts）。
 */
export function evaluateCommand(cmd) {
  const command = String(cmd ?? '');
  if (!command) return { allowed: true };
  const HATCHES = releaseHatches(loadWorkflowConfig().envPrefix);

  // 前缀环境变量赋值是命令的一部分：剥离后既修 `VAR=x git push` 的漏拦洞，也识别发版授权 hatch。
  // 复合命令按 shell 分隔符切段逐段检查——`git commit && git push` 的 push 藏在第二段，
  // 只看首子命令会漏拦；切段是保守近似（引号内分隔符会误报拦截，落在安全侧）。
  const segments = command.split(/[;&|]+/).map((s) => s.trim()).filter(Boolean);
  const single = segments.length === 1;
  let pushSeen = false;
  let tagSeen = false;
  let releaseWhitelisted = false;
  for (const seg of segments) {
    const t = seg.split(/\s+/);
    let i = 0;
    let auth = false;
    while (i < t.length && (t[i] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i]))) {
      if (HATCHES.includes(t[i])) auth = true;
      i += 1;
    }
    const bare = t.slice(i).join(' ');
    const sub = gitSubcommand(seg);
    if (sub === 'push') {
      pushSeen = true;
      if (single && auth && RELEASE_ALLOW.some((re) => re.test(bare))) releaseWhitelisted = true;
    } else if (sub === 'tag' && !/-l|--list/.test(seg)) {
      tagSeen = true;
      if (single && auth && RELEASE_ALLOW.some((re) => re.test(bare))) releaseWhitelisted = true;
    }
  }

  // 红线 1：发布动作人工授权制——默认拦截。用户明确授权发版（release.md「代理发布」）时，
  // 单条命令前缀 AGENTS_ALLOW_RELEASE=1（旧名 MODELRDOCK_ALLOW_RELEASE=1 兼容）且整串命中白名单形态才放行；复合命令一律拦
  if (pushSeen) {
    if (releaseWhitelisted && !tagSeen) return { allowed: true, rule: 'release-hatch' };
    return { allowed: false, rule: 'publish', reason: 'git push（发布动作人工授权制：默认拦截。代理发布须用户明确授权，按 release.md「代理发布」节以 AGENTS_ALLOW_RELEASE=1 前缀仅单条执行白名单形态）' };
  }
  if (tagSeen) {
    if (releaseWhitelisted) return { allowed: true, rule: 'release-hatch' };
    return { allowed: false, rule: 'publish', reason: 'git tag（打 tag 触发 Release，人工授权制：同 git push，见 release.md「代理发布」）' };
  }
  if (/\bnpm\s+publish\b/.test(command)) return { allowed: false, rule: 'publish', reason: 'npm publish（对外发布，永远人工）' };

  // 红线 2：workflow.json protectedPorts 的进程与监听（缺省空 = 不启用端口红线）
  const ports = protectedPorts();
  const port = ports.find((p) => command.includes(p));
  if (port) {
    const destructive = /\b(kill|killall|pkill|taskkill|fuser|lsof\s+-t)\b/i;
    const names = listenCommandNames().map(escapeRegExp);
    const listenCmd = new RegExp(`\\b(node|tsx|npx|npm\\s+run(\\s+\\S+)?${names.length ? `|${names.join('|')}` : ''})\\b`, 'i');
    if (destructive.test(command)) {
      return { allowed: false, rule: 'port', reason: `对端口 ${port} 相关进程执行 kill/stop（受保护端口见 workflow.json protectedPorts，永远人工处置）` };
    }
    // status/logs/list 查询类放行（read-only 诊断；项目命令的 status/logs 子命令同样被通用豁免覆盖）
    if (listenCmd.test(command) && !/\b(status|logs|list)\b/.test(command)) {
      return { allowed: false, rule: 'port', reason: `启动/重启命令携带受保护端口 ${port}（受保护端口见 workflow.json protectedPorts，测试必须用随机/高位端口）` };
    }
    for (const p of ports) {
      if (new RegExp(`listen\\s*\\(\\s*['"\`]?${p}\\b`).test(command)) {
        return { allowed: false, rule: 'port', reason: `代码中让服务监听受保护端口 ${p}（违反 workflow.json protectedPorts 红线）` };
      }
    }
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// 分支保护（guard-develop 的裁决核心；git 调用留在 hook，这里只做纯判断）
// ---------------------------------------------------------------------------

/** 非源代码类文档扩展名（无执行语义）：基准分支可直改。CI 工作流 yml、hook 注册与包清单
 *  json 等带执行语义的配置不在其列，仍走 feature-branch（.github/workflows 属 L3 发布流水线）。
 *  CMakeLists.txt 是 .txt 后缀的构建配置（有执行语义），绝不按文档放行。 */
export const DOC_FILE_RE = /\.(md|markdown|txt|rst|adoc)$/i;

/** 判定「真文档」：DOC_FILE_RE 命中且不是 CMakeLists.txt（.txt 后缀的构建脚本）。 */
export function isDocFile(filePath) {
  const p = String(filePath ?? '');
  return DOC_FILE_RE.test(p) && !/CMakeLists\.txt$/i.test(p);
}

/**
 * 基准分支直改裁决。branch/repoRoot/fileRoot 由 hook 用 git 取得后传入；cfg 可显式注入
 * （测试 / repoRoot 锚定场景），缺省读脚本锚定配置。
 * 放行条件：非基准分支、无法定位仓库、文件不属于本仓库管辖（仓库外 / 独立 worktree / 其他仓库——
 * worktree 内编辑正是工作流 prescribed）。
 * 严格度分两档：合并目标分支（baseBranch）放行非源代码类文档直改；其余受保护分支（main/master
 * 等发布侧）一律拦——只接受合入，文档也不例外。
 * 路径只比 git 自己产出的 repoRoot/fileRoot（同机同源，形式必然一致），绝不拿 Node 侧解析的
 * filePath 字符串参与比对：Windows 上 fs.realpath 不展开 8.3 短名（CI 的 TEMP 是
 * C:\Users\RUNNER~1\...，git 输出 runneradmin 长名），此前拿 filePath 与 repoRoot 做前缀比对
 * 永远失配，导致 Windows CI 漏拦。git 认得短名路径且稳定输出长名，fileRoot === repoRoot
 * 即「文件在本仓库」的充分判定。
 */
export function evaluateBranchEdit({ branch, repoRoot, fileRoot, filePath }, cfg) {
  const c = cfg ?? loadWorkflowConfig();
  if (!BASE_BRANCHES(c).includes(branch)) return { allowed: true, reason: '非基准分支' };
  if (!repoRoot) return { allowed: true, reason: '无法定位仓库' };
  if (!fileRoot) return { allowed: true, reason: '文件不在 git 仓库内' };
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (norm(fileRoot) !== norm(repoRoot)) return { allowed: true, reason: '文件属于独立 worktree 或其他仓库' };
  const mergeTarget = c.baseBranch || 'develop';
  // 发布侧基准分支（非合并目标）一律拦截（代码与文档）：只接受合并/hotfix 合入。
  if (branch !== mergeTarget) return { allowed: false, reason: `基准分支 ${branch} 直改（含文档，只接受合入）` };
  // 合并目标分支放行非源代码类文档直改（CHANGELOG/README 等对外文档的既定实践）；
  // 代码与带执行语义的配置（CI 工作流 yml、hook/包清单 json 等）仍走 feature-branch。
  if (isDocFile(filePath)) return { allowed: true, reason: '基准分支文档直改（非源代码类文档）' };
  return { allowed: false, reason: `基准分支 ${branch} 直改` };
}

// ---------------------------------------------------------------------------
// 改动分级（L0/L1 自动合并的裁决原语；闸门摘要先行展示）
// ---------------------------------------------------------------------------

/**
 * 按改动文件集合分级（取最高级）。corePaths/releasePaths 可显式注入（orchestrator 场景
 * 传入 repoRoot 配置），缺省读脚本锚定配置：
 *   L3 发布流水线（workflow.json releasePaths）——永远人工
 *   L2 核心路径（workflow.json corePaths）/ package.json / 未识别文件（保守归高）——人工批准
 *   L1 普通 src 改动
 *   L0 纯文档/测试
 */
export function classifyChange(changedFiles, cfg) {
  const files = (changedFiles ?? []).map((f) => String(f).replace(/\\/g, '/'));
  if (!files.length) return { level: 'L0', reasons: ['无改动'] };
  const core = corePaths(cfg);
  const release = releasePaths(cfg);
  const reasons = [];
  let level = 'L0';
  const bump = (l, why) => {
    reasons.push(why);
    const order = ['L0', 'L1', 'L2', 'L3'];
    if (order.indexOf(l) > order.indexOf(level)) level = l;
  };
  for (const f of files) {
    if (release.some((p) => f.startsWith(p) || f === p)) bump('L3', `${f}（发布流水线）`);
    else if (core.includes(f) || f === 'package.json') bump('L2', `${f}（核心路径）`);
    else if (L0_ALLOW.some((re) => re.test(f))) {
      /* L0 候选，保持当前级别 */
    } else if (/^src\//.test(f)) bump('L1', `${f}（普通 src 改动）`);
    else bump('L2', `${f}（未识别文件，保守归高）`);
  }
  if (reasons.length === 0) reasons.push(level === 'L0' ? '纯文档/测试改动' : '混合改动');
  return { level, reasons: [...new Set(reasons)] };
}

// ---------------------------------------------------------------------------
// 审计（拦截与放行都留痕；尽力而为，失败不阻断 hook）
// ---------------------------------------------------------------------------

let auditFileOverride = null;
/** 测试注入审计文件路径；生产路径 = <cwd>/.agents/policy/audit.jsonl。 */
export function setAuditFile(p) {
  auditFileOverride = p;
}

export function audit({ hook, tool, decision, reason, target }) {
  const file = auditFileOverride ?? path.join(process.cwd(), '.agents', 'policy', 'audit.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: toIsoLocal(), hook, tool, decision, reason, target }) + '\n');
  } catch {
    /* 审计失败不影响裁决 */
  }
}

// ---------------------------------------------------------------------------
// 并行调度分区（多 worker 按 files_hint 分区派任务，docs 10.6）
// ---------------------------------------------------------------------------

/**
 * 判定两个任务的 files_hint 是否可能改动同一片文件（并行互斥判定）。
 * 保守规则（宁可串行不可冲突）：
 *   - 提取 glob 的**固定前缀段**（通配符出现之前的段）：`docs/**` → ['docs']，
 *     `src/cli.ts` → ['src','cli.ts']，裸 `**`/`*.md`（首段即通配）→ []（完全通配）；
 *   - 任一前缀为空（首段即通配，可能命中任何路径）→ 相交（独占）；
 *   - 否则比较首段：`src/**` 与 `docs/**` 首段不同 → 可并行；`src/cli.ts` 与
 *     `src/gateway/x.ts` 首段同为 src → 保守相交。
 */
export function hintsOverlap(a, b) {
  const norm = (hints) => (hints ?? []).map((h) => String(h).replace(/\\/g, '/'));
  const prefixesOf = (hints) => {
    const set = new Set();
    for (const h of norm(hints)) {
      const fixed = [];
      for (const seg of h.split('/')) {
        if (seg.includes('*') || seg.includes('?')) break;
        fixed.push(seg);
      }
      if (!fixed.length) return null; // 该 hint 完全通配 → 独占
      set.add(fixed[0]);
    }
    return set;
  };
  const A = prefixesOf(a);
  const B = prefixesOf(b);
  if (!A || !B) return true;
  if (!A.size || !B.size) return true;
  for (const s of A) if (B.has(s)) return true;
  return false;
}

/** 读取审计日志（容错半行）。 */
export function readAudit(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

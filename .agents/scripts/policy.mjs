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

/** 受保护端口（workflow.json protectedPorts，缺省空 = 不做端口红线）。cfg 可显式注入
 *  （evaluateCommand 单次评估读一次配置后透传），缺省读脚本锚定配置。 */
export function protectedPorts(cfg) {
  return (cfg ?? loadWorkflowConfig()).protectedPorts;
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

/** L0 白名单：纯文档/测试/杂项，全部命中才可 L0（与项目无关，硬编码）。
 *  `.agents/` 不再整目录豁免（2026-10-31 评测集问题 7：守护器自身可被守护对象改写后走
 *  自动合并，守卫自持性破口，与 02 号卡同根）——守护器与评测题库改走 GUARD_SELF 的 L2；
 *  仅评测生成物 runs/ 保留窄 L0。queue/logs/worktrees/policy 等簿记目录本就 gitignore
 *  不进 diff，无需白名单。 */
const L0_ALLOW = [/\.md$/i, /^docs\//, /^test\//, /^CHANGELOG\.md$/i, /^LICENSE$/i, /^\.gitignore$/, /^\.agents\/review-evals\/runs\//];

/** 守护器自身与评测题库：改动一律 L2（人工批准），自动合并永不放行。
 *  workflow.json 是红线数据本体；scripts/hooks 是守卫代码；skills 是 agent 指令面；
 *  review-evals/cases 改动即改审查评测口径。workflows/*.md 是流程文档，按 .md 走 L0。 */
const GUARD_SELF = [/^\.agents\/scripts\//, /^\.agents\/hooks\//, /^\.agents\/skills\//, /^\.agents\/workflow\.json$/i, /^\.agents\/review-evals\/cases\//];

// ---------------------------------------------------------------------------
// Bash 命令红线（policy-worker 的裁决核心）
// ---------------------------------------------------------------------------

const basename = (t) => String(t ?? '').split(/[\\/]/).pop() ?? '';
const isEnvWord = (t) => /^env(\.exe)?$/i.test(basename(t));

/** env 前缀解析：`env [自身 flag...] [NAME=VALUE...] <command>`（无 env 时只吞 NAME=VALUE）。
 *  返回命令位下标 i、前缀里是否带发版 hatch 赋值 auth、env -S 的命令串值 sPayload。
 *  认 env 自身 flag：-i/-0/--ignore-environment/-- 等——flag 占住命令位时 `env -i git push`
 *  曾被判「首词非 git」漏拦（2026-10-31 评测集问题 1）；-u/--unset 连同无 '=' 的下一 token
 *  （变量名）一起跳；`--` 之后不再有 env 自身 flag（NAME=VALUE 仍可出现）。env 本体按
 *  basename 判定（/usr/bin/env 同认）。冷门形态（env -S 独立值吞后的二义）保守落安全侧。 */
export function envPrefixSpan(tokens, start, hatches = []) {
  let i = start;
  let auth = false;
  const assignment = (t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);
  if (!isEnvWord(tokens[i])) {
    while (i < tokens.length && assignment(tokens[i])) {
      if (hatches.includes(tokens[i])) auth = true;
      i += 1;
    }
    return { i, auth, sPayload: null };
  }
  i += 1;
  let sPayload = null;
  let optionsDone = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!optionsDone && t === '--') { optionsDone = true; i += 1; continue; }
    if (!optionsDone && /^-/.test(t)) {
      // -S/--split-string 的值是「拆分后即所执行命令」的一个 shell 词：值内空格会被 tokenizer
      // 切断（`env -S "FOO=1 git push"` 的值是一个引号词），按「词内剩余 + 行内余部」重组，
      // 交回调用方递归评估（重组是保守超集：真命令同时被主循环的命令位扫描覆盖）
      const sAttached = /^-S(.+)$/.exec(t) ?? /^--split-string=(.+)$/.exec(t);
      if (sAttached) sPayload = (sAttached[1] + ' ' + tokens.slice(i + 1).join(' ')).trim();
      else if (t === '-S' || t === '--split-string') sPayload = tokens.slice(i + 1).join(' ');
      i += 1;
      if ((t === '-u' || t === '--unset') && i < tokens.length && !tokens[i].includes('=')) i += 1;
      continue;
    }
    if (assignment(t)) {
      if (hatches.includes(t)) auth = true;
      i += 1;
      continue;
    }
    break; // 命令位
  }
  return { i, auth, sPayload };
}

/** git 命令检测：env/赋值前缀剥离（envPrefixSpan）→ xargs 包装剥离 → git [flag 参数...]
 *  <子命令>，兼容 -C repo / -c a=b 等带值 flag。`VAR=x git push`、`env -i git push`、
 *  `… | xargs git push` 均曾被判「非 git 命令」漏拦（2026-10-31 评测集问题 1/3）。 */
export function gitSubcommand(cmd) {
  const tokens = String(cmd).trim().split(/\s+/);
  const { i: start } = envPrefixSpan(tokens, 0);
  let j = start;
  // xargs 包装：跳过 xargs 本体与 flag；-n/-P/-s/-E/-L/-I/-a 带独立值时连值跳。
  // 未知 flag 不吞值——把后续 'git' 当命令拦，落安全侧。
  if (/^xargs(\.exe)?$/i.test(basename(tokens[j]))) {
    j += 1;
    while (j < tokens.length && tokens[j].startsWith('-')) {
      const valueFlag = /^-(?:n|P|s|E|L|I|a)$/i.test(tokens[j]);
      j += 1;
      if (valueFlag && j < tokens.length && !tokens[j].startsWith('-')) j += 1;
    }
  }
  if (tokens[j] !== 'git') return null;
  for (let k = j + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t === '-C' || t === '--git-dir' || t === '--work-tree' || t === '-c') {
      k += 1; // 带值 flag：跳过它的参数
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

/** shell 包装段（bash/sh/zsh [-lc] '载荷'，兼容 env 前缀与绝对路径）的载荷提取：非包装返回 null。
 *  env 前缀经 envPrefixSpan 解析（认自身 flag：`env -i bash -c …` 曾因 -i 占位漏识别包装）；
 *  here-string（`bash <<< '载荷'`）与 -c 同为「shell 执行一段文本」的包装形态，一并提取
 *  （here-string 附着词 `<<<git …` 保守按整串载荷处理）。
 *  换行切段后载荷必落在单段内（换行本身也是切段符，heredoc 体各行已各自成段），token
 *  重组后剥首尾引号交回递归评估。 */
export function shellWrapperPayload(seg) {
  const tokens = String(seg).trim().split(/\s+/);
  const { i } = envPrefixSpan(tokens, 0);
  // shell 名按 basename 判定（/bin/bash、/usr/local/bin/zsh、C:\tools\bash 等绝对路径同认）
  if (!/^(?:ba|z|)sh(\.exe)?$/i.test(basename(tokens[i]))) return null;
  for (let j = i + 1; j < tokens.length; j++) {
    const tok = tokens[j];
    const hereString = /^<{3}/.test(tok);
    if (tok === '-c' || hereString) {
      // 载荷保留 env 前缀 token（含 AGENTS_ALLOW_RELEASE 授权 hatch——白名单形态在包装内同样有效），
      // 只剥掉 shell 本体与 -c；首尾参数的引号会破坏后续 gitSubcommand 的 token 判定，分别剥掉
      const args = hereString ? [tok.slice(3), ...tokens.slice(j + 1)].filter(Boolean) : tokens.slice(j + 1);
      if (args.length) {
        args[0] = args[0].replace(/^['"]/, '');
        args[args.length - 1] = args[args.length - 1].replace(/['"]$/, '');
      }
      const payload = [...tokens.slice(0, i), ...args].join(' ').trim();
      return payload || null;
    }
    if (!tok.startsWith('-')) return null; // 无 -c 的交互式调用：无载荷
  }
  return null;
}

/** npm/yarn/pnpm publish 检测：首词（经 env 前缀剥离，按 basename 认 .cmd/.js 包装与
 *  绝对路径）为 npm 家族，且其后任意裸词位出现 publish——`npm --registry=… publish` /
 *  `npm -w pkg publish` 曾因「publish 紧跟 npm」的相邻正则漏拦（2026-10-31 评测集问题 4）。
 *  保守近似：`npm run publish`、`npm install publish`（包名恰为 publish 的罕见形态）同样
 *  拦，落安全侧。 */
export function isPublishCommand(seg) {
  const tokens = String(seg).trim().split(/\s+/);
  const { i } = envPrefixSpan(tokens, 0);
  if (!/^(?:npm|yarn|pnpm)(?:\.(?:cmd|js|exe))?$/i.test(basename(tokens[i]))) return false;
  return tokens.slice(i + 1).includes('publish');
}

/** 段内嵌套载荷：命令替换 `$(…)`（括号深度配对）、反引号 `` `…` ``、子壳 `(…)`（段首 '('
 *  剥壳、尾随 ')' 一并剥）——三者的首词不是 git/npm，整段 token 判定罩不住
 *  （`echo $(git push origin main)`、`(git push origin main)` 曾漏拦，2026-10-31 评测集
 *  问题 2）；提取出的载荷交回 evaluateSegments 递归评估。 */
export function nestedCommandPayloads(seg) {
  const s = String(seg);
  const out = [];
  const trimmed = s.trim();
  const stripped = trimmed.replace(/^\(+/, '').replace(/\)+$/, '').trim();
  if (stripped && stripped !== trimmed) out.push(stripped);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) { out.push(s.slice(i + 1, end)); i = end; }
    } else if (s[i] === '$' && s[i + 1] === '(') {
      let d = 1;
      let j = i + 2;
      while (j < s.length && d > 0) {
        if (s[j] === '(') d += 1;
        else if (s[j] === ')') d -= 1;
        j += 1;
      }
      if (d === 0) { out.push(s.slice(i + 2, j - 1)); i = j - 1; }
    }
  }
  return out;
}

/** 破坏性进程词表（受保护端口命中时的拦截依据）。stop-process 是 PowerShell 的
 *  `Stop-Process -Id …`（2026-10-31 评测集问题 6 曾对 8687 放行）。 */
const DESTRUCTIVE_RE = /\b(?:kill|killall|pkill|taskkill|fuser|stop-process|lsof\s+-t)\b/i;

/** 段级端口红线（2026-10-31 评测集问题 5/6）：status/logs/list 查询豁免与 --port 存在性
 *  都按段独立判定——`gateway start --port 8687 && curl …/status` 曾借后段的 status 全文
 *  命中豁免漏拦、`echo x --port 18901 && modeldock ui` 曾借前段 --port 漏拦。破坏性命令
 *  另有全文兜底（evaluateSegments 收尾处）：`lsof -i :8687 -t | xargs kill` 这类端口与
 *  kill 跨段的形态段级罩不住，全文判定从严。 */
function portViolation(seg, ports, cfg) {
  const port = ports.find((p) => seg.includes(p));
  if (port) {
    if (DESTRUCTIVE_RE.test(seg)) {
      return { allowed: false, rule: 'port', reason: `对端口 ${port} 相关进程执行 kill/stop（含 PowerShell Stop-Process；受保护端口见 workflow.json protectedPorts，永远人工处置）` };
    }
    const names = listenCommandNames(cfg).map(escapeRegExp);
    const listenCmd = new RegExp(`\\b(?:node|tsx|npx|npm\\s+run(?:\\s+\\S+)?${names.length ? `|${names.join('|')}` : ''})\\b`, 'i');
    // status/logs/list 查询类放行（read-only 诊断）——只看本段，复合命令的其他段借不到豁免
    if (listenCmd.test(seg) && !/\b(?:status|logs|list)\b/.test(seg)) {
      return { allowed: false, rule: 'port', reason: `启动/重启命令携带受保护端口 ${port}（受保护端口见 workflow.json protectedPorts，测试必须用随机/高位端口）` };
    }
    for (const p of ports) {
      if (new RegExp(`listen\\s*\\(\\s*['"\`]?${p}\\b`).test(seg)) {
        return { allowed: false, rule: 'port', reason: `代码中让服务监听受保护端口 ${p}（违反 workflow.json protectedPorts 红线）` };
      }
    }
  }
  // 缺省端口盲区：项目 CLI 的启动型子命令不带 --port 时落到代码默认端口——命令文本里
  // 没有端口号，上面的 includes 检查罩不住（`gateway start` 默认监听生产端口，恰是最易
  // 踩的坑）。listenCommandNames 的 start/restart/serve/ui/daemon 形态缺 --port 一律拦；
  // 带 --port 已显式落到测试端口，放行。
  if (ports.length) {
    const names = listenCommandNames(cfg).map(escapeRegExp);
    if (names.length) {
      const defaultPortStart = new RegExp(`\\b(?:${names.join('|')})\\s+(?:start|restart|serve|ui|daemon)\\b`, 'i');
      if (defaultPortStart.test(seg) && !/--port(?:=|\s)/.test(seg) && !/(^|\s)-{1,2}h(?:elp)?\b/.test(seg)) {
        return { allowed: false, rule: 'port', reason: `启动命令未带 --port（缺省落到受保护的生产端口，见 workflow.json protectedPorts）。测试实例必须显式 --port <高位端口> 并与独立沙箱成对使用` };
      }
    }
  }
  return null;
}

/**
 * Bash 命令红线裁决。返回 { allowed, rule?, reason? }。
 * 覆盖：发布动作（push/tag/publish，人工授权制）、受保护端口（workflow.json protectedPorts）。
 */
export function evaluateCommand(cmd) {
  return evaluateSegments(String(cmd ?? ''), 0);
}

function evaluateSegments(command, depth) {
  if (!command) return { allowed: true };
  // 单次评估只读一次 workflow.json（此前 releaseHatches/protectedPorts/listenCommandNames 各自
  // 缺省重读，最多 4 次——agents-hygiene-batch 收敛；行为不变，见下方各调用点显式传 cfg）
  const cfg = loadWorkflowConfig();
  const HATCHES = releaseHatches(cfg.envPrefix);

  // 前缀环境变量赋值是命令的一部分：剥离后既修 `VAR=x git push` 的漏拦洞，也识别发版授权 hatch。
  // 复合命令按 shell 分隔符切段逐段检查——`git commit && git push` 的 push 藏在第二段，
  // 只看首子命令会漏拦；切段是保守近似（引号内分隔符会误报拦截，落在安全侧）。
  // 换行同样是分隔符：`echo hi\ngit push origin main` 的 push 藏在第二行，曾整体漏拦
  // （评测集 runs/2026-10-30-policy-dispatch-tamper.md 问题 3 实测，2026-10-31 修复）。
  const segments = command.replace(/\r\n?/g, '\n').split(/[;&|\n]+/).map((s) => s.trim()).filter(Boolean);
  const single = segments.length === 1;
  let pushSeen = false;
  let tagSeen = false;
  let releaseWhitelisted = false;
  const ports = protectedPorts(cfg);
  let portBlock = null;
  for (const seg of segments) {
    // 包装与嵌套载荷（bash -c '…'、env -S '…'、$(…)、反引号、子壳）：递归评估，被拦即整串被拦——
    // 包装不改变载荷的裁决结果（`bash -c 'git push origin main'` 曾因 tokens[0]='bash' 漏拦）
    if (depth < 3) {
      const wrapper = shellWrapperPayload(seg);
      if (wrapper) {
        const subv = evaluateSegments(wrapper, depth + 1);
        if (!subv.allowed) return subv;
      }
      const { sPayload } = envPrefixSpan(seg.split(/\s+/), 0);
      if (sPayload) {
        const subv = evaluateSegments(sPayload.replace(/^['"]|['"]$/g, ''), depth + 1);
        if (!subv.allowed) return subv;
      }
      for (const inner of nestedCommandPayloads(seg)) {
        const subv = evaluateSegments(inner, depth + 1);
        if (!subv.allowed) return subv;
      }
    }
    const t = seg.split(/\s+/);
    const { i, auth } = envPrefixSpan(t, 0, HATCHES);
    const bare = t.slice(i).join(' ');
    const sub = gitSubcommand(seg);
    if (sub === 'push') {
      pushSeen = true;
      if (single && auth && RELEASE_ALLOW.some((re) => re.test(bare))) releaseWhitelisted = true;
    } else if (sub === 'tag' && !/-l|--list/.test(seg)) {
      tagSeen = true;
      if (single && auth && RELEASE_ALLOW.some((re) => re.test(bare))) releaseWhitelisted = true;
    }
    // npm publish 红线段级判定（变体形态见 isPublishCommand 注释）
    if (isPublishCommand(seg)) {
      return { allowed: false, rule: 'publish', reason: 'npm publish（对外发布，永远人工）' };
    }
    // 端口红线逐段独立判定（豁免词/缺 --port 不再全文共享，见 portViolation 注释）
    if (!portBlock && ports.length) portBlock = portViolation(seg, ports, cfg);
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
  // 破坏性命令全文兜底：端口与 kill 跨段（`lsof -i :8687 -t | xargs kill`）时段级各自
  // 都不构成「带端口的破坏」，全文同现从严拦——豁免词/--port 的段级化只放宽查询类，不放宽破坏类
  if (!portBlock && ports.length) {
    const portAnywhere = ports.find((p) => command.includes(p));
    if (portAnywhere && DESTRUCTIVE_RE.test(command)) {
      return { allowed: false, rule: 'port', reason: `对端口 ${portAnywhere} 相关进程执行 kill/stop（含 PowerShell Stop-Process；受保护端口见 workflow.json protectedPorts，永远人工处置）` };
    }
  }
  if (portBlock) return portBlock;
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
    else if (GUARD_SELF.some((re) => re.test(f))) bump('L2', `${f}（守护器自身/评测题库，守卫自持性）`);
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

// audit.jsonl 每次 Edit/Write/Bash 都追加、无界增长（2026-10-29 已 638KB/2531 行）——按大小
// 轮转，先例：orchestrator.mjs 的 nightly.log 5MB（NIGHTLY_LOG_MAX）。只留一代、不引入配置项。
const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;

export function audit({ hook, tool, decision, reason, target }) {
  const file = auditFileOverride ?? path.join(process.cwd(), '.agents', 'policy', 'audit.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > AUDIT_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* 首次不存在（尚无审计）/ Windows 目标被句柄占用：跳过轮转，不阻断本次审计 */
    }
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

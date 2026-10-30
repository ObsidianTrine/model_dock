#!/usr/bin/env node
// guard-develop.mjs — PreToolUse hook (registered in .claude/settings.json for
// Claude Code, in .zcode/config.json for ZCode — both tracked so the guard
// fires in whichever client the agent runs in).
// Blocks direct Edit/Write/MultiEdit/NotebookEdit on files of the current repo
// while the checked-out branch is develop or main, forcing agents through the
// feature-branch worktree workflow (.agents/workflows/feature-branch.md).
// Matrix (branch hygiene rules): code files blocked on develop AND main;
// non-source documents (*.md/*.txt/*.rst/… — see DOC_FILE_RE in policy.mjs)
// allowed on develop only — main only accepts merges from develop/hotfix,
// nothing lands there directly (docs included).
//
// Files that live in a separate git worktree (e.g. .agents/worktrees/<task-id>/)
// are exempt: editing there IS the sanctioned feature-branch workflow.
//
// Escape hatch (must be justifiable to the user):
//   set AGENTS_ALLOW_BASE_EDIT=1 to bypass for the session
//   (legacy project-scoped name MODELRDOCK_ALLOW_DEVELOP_EDIT still accepted).
//
// Hook contract: exit 0 = allow; exit 2 = block, stderr is fed back to the model.
//
// 策略守护完整版（Phase 2）：裁决规则集中在 .agents/scripts/policy.mjs
// （evaluateBranchEdit），本文件只剩 git/路径取证 + 壳；拦截均写审计日志。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateBranchEdit, audit, isDocFile, BASE_BRANCHES } from '../scripts/policy.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0); // not our concern if we can't parse the event
}

const tool = String(input.tool_name || '');
if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) process.exit(0);

const filePath = input.tool_input?.file_path || input.tool_input?.notebook_path || '';

// Windows 的 \\?\ 扩展前缀：fs.realpath 可能返回它，而 git 不接受带前缀的 cwd / -C 路径。
// 一旦 git 因此起不来，branch / root 全取空，裁决会误判为「非基准分支 / 无法定位仓库」→ 放行。
// 统一剥掉前缀再交给 git 和比较逻辑（UNC 形式是 \\?\UNC\server\share，剥后要补回 \\）。
const stripExt = (p) => {
  if (!p || process.platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  return p.startsWith('\\\\?\\') ? p.slice(4) : p;
};

function git(args) {
  try {
    const cwd = stripExt(process.cwd());
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

// 「文件在本仓库」的判定只比 git 产出的 repoRoot/fileRoot，不用 Node 侧解析的 filePath 字符串：
// Windows 8.3 短名下（CI 的 TEMP=C:\Users\RUNNER~1\...，git 输出 runneradmin 长名）fs.realpath
// 不展开短名，filePath 与 repoRoot 的字符串比对永远失配（Windows CI 曾因此漏拦）。git 认得
// 短名路径且稳定输出长名——fileRoot === repoRoot 即充分判定。fileRoot 经最近存在的祖先目录
// 取证，覆盖 Write 新建嵌套文件（目标目录尚不存在）的场景。
function nearestExistingDir(p) {
  for (let cur = stripExt(path.resolve(p)); ;) {
    try {
      fs.statSync(cur);
      return cur;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
}

// escape hatch（廉价，先查——放行时省掉下面全部 git 取证）：
// AGENTS_ALLOW_BASE_EDIT=1（可移植名）；旧项目名 MODELRDOCK_ALLOW_DEVELOP_EDIT 永远兼容。
if (process.env.AGENTS_ALLOW_BASE_EDIT === '1' || process.env.MODELRDOCK_ALLOW_DEVELOP_EDIT === '1') {
  audit({ hook: 'guard-develop', tool, decision: 'allowed', reason: 'escape hatch AGENTS_ALLOW_BASE_EDIT=1 (legacy MODELRDOCK_ALLOW_DEVELOP_EDIT also accepted)', target: filePath });
  process.exit(0);
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
// 热路径重排（agents-hygiene-batch）：evaluateBranchEdit 的第一条判定就是「非基准分支放行」，
// 不消费 repoRoot/fileRoot——branch 已确定不在基准集合时（feature worktree 干活是工作流常态），
// 下面两个 git 子进程取证纯浪费（实测单次编辑省 ~25ms），跳过之；裁决仍 100% 走 policy
//（拦截判定零复制），audit 事件字段与每次放行/拦截各一条的语义不变。
const skipForensics = !BASE_BRANCHES().includes(branch);
const root = skipForensics ? '' : git(['rev-parse', '--show-toplevel']);
const fileRoot = !skipForensics && filePath ? git(['-C', nearestExistingDir(path.dirname(filePath)), 'rev-parse', '--show-toplevel']) : '';

const verdict = evaluateBranchEdit({
  branch,
  repoRoot: stripExt(root ? path.resolve(root) : ''),
  fileRoot: stripExt(fileRoot ? path.resolve(fileRoot) : ''),
  filePath,
});
if (verdict.allowed) {
  audit({ hook: 'guard-develop', tool, decision: 'allowed', reason: verdict.reason, target: filePath });
  process.exit(0);
}

audit({ hook: 'guard-develop', tool, decision: 'blocked', reason: verdict.reason, target: filePath });
const mainDocsHint = branch === 'main' && isDocFile(filePath)
  ? `Docs are no exception on main: edit them on develop — main only accepts merges from develop/hotfix.\n`
  : '';
console.error(
  `[feature-branch guard] Direct ${tool} on "${filePath}" is blocked: the repo is checked out on "${branch}".\n` +
    mainDocsHint +
    `Use the feature-branch workflow instead (see .agents/workflows/feature-branch.md):\n` +
    `  1. node .agents/scripts/feature-branch.mjs start <task-id>\n` +
    `  2. Edit the SAME file via its path under the printed worktree (.agents/worktrees/<task-id>/...)\n` +
    `  3. Commit + run the verification command (workflow.json testCmd) inside the worktree, then: node .agents/scripts/feature-branch.mjs finish <task-id>\n` +
    `If this edit genuinely must land on ${branch} directly (rare), set AGENTS_ALLOW_BASE_EDIT=1 (legacy MODELRDOCK_ALLOW_DEVELOP_EDIT=1 also accepted) and say why.`
);
process.exit(2);

#!/usr/bin/env node
// feature-branch.mjs — per-task git worktree workflow for parallel AI agents.
//
// Usage:
//   node .agents/scripts/feature-branch.mjs start <task-id>            create worktree + feature/<task-id> branch off develop,
//                                                                      then run setupCmd from workflow.json inside it (deps install etc.)
//   node .agents/scripts/feature-branch.mjs finish <task-id> [--skip-test] [--message "msg"]
//                                                              rebase onto develop, run tests, merge --no-ff, cleanup
//   node .agents/scripts/feature-branch.mjs list                       list active task worktrees
//
// Worktrees live under .agents/worktrees/<task-id> (gitignored). Each agent
// edits only inside its own worktree, so parallel agents never clobber each
// other's files. Integration happens on the shared main checkout, so finish
// serializes on a lock file (.finish.lock): concurrent finishes queue safely
// instead of colliding on git's index.lock.

import { execFileSync, spawnSync } from 'node:child_process';

// Plain-LF newline for console output (messages are printed as-is on every platform).
const CRLF_N = '\n';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root: ask git for the COMMON .git dir first — `git rev-parse --git-common-dir`
// points at the main repo's .git even when this script is invoked from inside a linked
// worktree (where a naive ".git exists here?" walk-up would wrongly stop at the
// worktree's own .git file and nest worktree paths inside it). Fall back to walking up
// from this script's directory when git itself is unavailable.
function findRepoRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (common) {
      const dotGit = path.resolve(process.cwd(), common);
      if (fs.existsSync(dotGit)) return path.dirname(dotGit);
    }
  } catch { /* not inside a repo (or git missing) — fall through to the walk-up */ }
  const startDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) die(`could not locate repo root (no .git found above ${startDir})`);
    dir = parent;
  }
}
const REPO_ROOT = findRepoRoot();
// "Return" out of any task worktree before doing anything: when this script is
// invoked with cwd inside a worktree, the node process itself would pin that
// directory (Windows cannot delete a directory held as a process cwd) and
// `git worktree remove` would leave an empty shell behind. Every git call below
// uses an explicit cwd, so moving to the repo root up front is always safe.
const INVOCATION_CWD = process.cwd();
process.chdir(REPO_ROOT);
const WORKTREES_DIR = path.join(REPO_ROOT, '.agents', 'worktrees');

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function gitInDir(dir, args) {
  return git(args, { cwd: dir });
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// Finish is the only step that mutates the base branch (the merge runs on the main
// checkout), so two agents finishing at once would collide on git's index.lock. An
// exclusive lock file serializes them. The owner pid lets a later finish tell a
// crashed predecessor (lock left behind by SIGKILL / power loss) from a live one:
// stale locks are taken over automatically, live ones refuse with a retry hint.
const FINISH_LOCK = path.join(WORKTREES_DIR, '.finish.lock');

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but owned by another user — still alive
  }
}

function acquireFinishLock(taskId) {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  for (let takeovers = 0; ; takeovers++) {
    try {
      fs.writeFileSync(FINISH_LOCK, JSON.stringify({ pid: process.pid, task: taskId, time: new Date().toISOString() }), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') die(`could not create finish lock ${FINISH_LOCK}: ${e.message}`);
      let info = null;
      try { info = JSON.parse(fs.readFileSync(FINISH_LOCK, 'utf8')); } catch { /* corrupt lock — treat as stale */ }
      if (info && Number.isInteger(info.pid) && pidAlive(info.pid)) {
        die(`another finish is already running (pid ${info.pid}${info.task ? `, task "${info.task}"` : ''}${info.time ? `, started ${info.time}` : ''}).` + CRLF_N +
          `  Wait for it to complete, then re-run: node .agents/scripts/feature-branch.mjs finish ${taskId}` + CRLF_N +
          `  If you are certain no finish is in progress, delete ${FINISH_LOCK} and retry.`);
      }
      if (takeovers >= 2) die(`finish lock ${FINISH_LOCK} is stale but could not be removed. Delete it manually and re-run.`);
      try { fs.rmSync(FINISH_LOCK, { force: true }); } catch { /* next iteration re-checks */ }
      continue;
    }
    process.on('exit', () => { try { fs.rmSync(FINISH_LOCK, { force: true }); } catch { /* best effort */ } });
    return;
  }
}

// Per-project workflow config: .agents/workflow.json (commit it into the repo).
//   baseBranch — integration branch feature branches merge back into (default: develop if present)
//   testCmd    — verification command(s) run by finish inside the worktree (default: none, tests skipped).
//   setupCmd   — one-time environment setup command(s) run by start inside the fresh worktree
//                (dependency install etc.; default: none). Accepted forms for both (all language-agnostic):
//                  "cmd"                          same command on every platform
//                  ["cmd1", "cmd2"]               several commands, run in order
//                  { "win32": ..., "unix": ... }  per-platform; "unix" covers linux+darwin;
//                                                 each value may be a string or an array
// Absent file = defaults (e.g. C++: "cmake --build build && ctest --test-dir build").
function loadWorkflowConfig() {
  const cfgPath = path.join(REPO_ROOT, '.agents', 'workflow.json');
  let raw = {};
  if (fs.existsSync(cfgPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (e) {
      die(`.agents/workflow.json is not valid JSON: ${e.message}`);
    }
  }
  return {
    baseBranch: typeof raw.baseBranch === 'string' && raw.baseBranch.trim() ? raw.baseBranch.trim() : null,
    testCmd: resolveCmds(raw.testCmd),
    setupCmd: resolveCmds(raw.setupCmd),
  };
}

// Normalize a testCmd/setupCmd declaration (see forms above) into an array of commands
// for the current platform, or null when nothing applies.
function resolveCmds(raw) {
  const toList = (v) => {
    if (typeof v === 'string') return v.trim() ? [v.trim()] : null;
    if (Array.isArray(v)) {
      const arr = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
      return arr.length ? arr : null;
    }
    return null;
  };
  if (raw == null) return null;
  if (typeof raw === 'string' || Array.isArray(raw)) return toList(raw);
  if (typeof raw === 'object') {
    const key = process.platform === 'win32' ? 'win32' : 'unix';
    return toList(raw[key] ?? raw.unix ?? null);
  }
  return null;
}

function hasLocalBranch(name) {
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

function currentBranch(dir = REPO_ROOT) {
  const b = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  return b === 'HEAD' ? '(detached)' : b;
}

function baseBranch() {
  const cfgBase = loadWorkflowConfig().baseBranch;
  if (cfgBase) return cfgBase;
  return hasLocalBranch('develop') ? 'develop' : currentBranch();
}

function sanitizeTaskId(raw) {
  const id = String(raw || '').trim();
  // 小写字母/数字/短横线（与 spec id 同规则）：点会产生 git 非法分支名（a..b、x.lock）；
  // 大写在大小写不敏感文件系统上会让不同 id 落进同一 worktree 目录互撞。
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    die(`invalid task-id "${id}". Use a short slug: lowercase letters/digits/dash, e.g. fix-presets-merge`);
  }
  return id;
}

function listWorktrees() {
  // porcelain v1: blocks separated by blank lines, "worktree <path>" per block
  const out = git(['worktree', 'list', '--porcelain']);
  const trees = [];
  let cur = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) cur.path = line.slice('worktree '.length);
    else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).replace('refs/heads/', '');
    else if (line === '' && cur.path) { trees.push(cur); cur = {}; }
  }
  if (cur.path) trees.push(cur);
  return trees;
}

// NOTES.md：worktree 本地的任务交接文档（gitignore 之外、永不合并，finish 时清除）。
// 未完成的任务靠它向接手的 agent 交代目标/进度/剩余步骤（见 .agents/workflows/feature-branch.md）。
function notesPathFor(wtPath) {
  return path.join(wtPath, 'NOTES.md');
}

// git worktree remove can leave an empty directory shell on Windows: a live process
// holding the dir as cwd (or any open handle) makes the final rmdir fail while git
// still deregisters the worktree — the shell is then invisible to every git command.
// Sweep it best-effort; return an error message on failure, null on success.
// On Windows a directory held as some process's cwd cannot be deleted — the most
// common offender is the caller's own terminal/agent shell still sitting inside
// the worktree. Detect that case so the advice can be concrete.
function lockHint(wtPath) {
  const inWorktree = INVOCATION_CWD === wtPath ||
    INVOCATION_CWD.startsWith(wtPath + path.sep);
  return inWorktree
    ? `your shell's working directory is still inside ${wtPath} — cd out of it first, then re-run finish`
    : `another process may hold a handle on ${wtPath} — close it, then re-run finish`;
}

function removeWorktreeDir(wtPath) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!fs.existsSync(wtPath)) return null;
    try {
      fs.rmSync(wtPath, { recursive: true, force: true });
      return null;
    } catch (e) {
      // Transient locks (Defender scan, exiting test workers) usually clear in ms.
      if (attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, true, 250);
      else return String(e.message).trim();
    }
  }
}

function writeNotesStub(taskId, wtPath, base) {
  fs.writeFileSync(notesPathFor(wtPath), `# 任务交接 NOTES — ${taskId}

> 本文件是 worktree 本地的交接文档，**不会被合并进主干**（finish 时自动清除）。
> 任务中断、换会话或换 agent 时务必保持本文件最新——接手者从这里续起。

- **状态**: 进行中
- **目标**: <一句话说明本任务要达成什么>
- **计划步骤**:
  - [ ] <步骤 1>
- **已完成**: 无
- **剩余步骤**: 全部
- **如何验证**: <测试命令 / 具体手测路径>
- **接手者需要知道的坑**: 无
`);
}

function cmdStart(taskId) {
  const branch = `feature/${taskId}`;
  const wtPath = path.join(WORKTREES_DIR, taskId);

  if (hasLocalBranch(branch)) {
    die(`branch ${branch} already exists. Pick another task-id, or run "finish ${taskId}" to merge & clean it up.`);
  }
  if (listWorktrees().some((t) => path.resolve(t.path) === path.resolve(wtPath))) {
    die(`worktree ${wtPath} already registered. Pick another task-id or clean up first.`);
  }

  const base = baseBranch();
  git(['worktree', 'add', wtPath, '-b', branch, base]);
  writeNotesStub(taskId, wtPath, base);

  // One-time environment setup (e.g. dependency install) so the worktree is immediately
  // testable — the top friction point for parallel agents: a fresh worktree has no
  // node_modules and every agent would otherwise discover and run the install by hand.
  // Failure is a warning, not an abort: the worktree itself is fine and the command can
  // be re-run manually (a failed install is often transient — network, lock contention).
  const setupCmds = loadWorkflowConfig().setupCmd;
  let setupFailed = false;
  for (const cmd of setupCmds || []) {
    console.log(`Running setup inside the worktree: ${cmd}`);
    const s = spawnSync(cmd, { cwd: wtPath, stdio: 'inherit', shell: true });
    if (s.status !== 0) {
      setupFailed = true;
      console.warn(`WARNING: setup failed (exit ${s.status}). The worktree is ready, but run the setup manually before testing:` + CRLF_N +
        `  cd "${wtPath}" && ${cmd}`);
    }
  }
  const setupNote = !setupCmds || setupCmds.length === 0
    ? ''
    : setupFailed
      ? '\n  setup:  FAILED — re-run the setup command manually inside the worktree before testing.'
      : '\n  setup:  done.';

  console.log(`Worktree ready:
  path:   ${wtPath}
  branch: ${branch} (based on ${base})${setupNote}

Next steps:
  0. Fill in NOTES.md (handoff doc) in the worktree — goals/plan first, keep it updated; if the task is left unfinished, the next agent continues from it.
  1. Edit files ONLY inside the worktree path above (use absolute paths).
  2. Commit inside the worktree: git -C "${wtPath}" add -A && git -C "${wtPath}" commit -m "..."
  3. Self-test inside the worktree: run the testCmd from .agents/workflow.json (cwd = worktree path).
  4. Integrate back: node .agents/scripts/feature-branch.mjs finish ${taskId}`);
}

function cmdFinish(taskId, args) {
  const skipTest = args.includes('--skip-test');
  const msgIdx = args.indexOf('--message');
  const mergeMsg = msgIdx >= 0 ? args[msgIdx + 1] : undefined;
  const branch = `feature/${taskId}`;
  const wtPath = path.join(WORKTREES_DIR, taskId);

  acquireFinishLock(taskId);

  const trees = listWorktrees();
  const wt = trees.find((t) => path.resolve(t.path) === path.resolve(wtPath));
  if (!wt && hasLocalBranch(branch)) {
    // No worktree left but the branch is still here — a previous finish died during
    // post-merge cleanup. Finish that cleanup instead of failing (idempotent re-run).
    try {
      git(['branch', '-d', branch]); // -d refuses to delete unmerged branches on its own
    } catch (e) {
      die(`no worktree for task "${taskId}", and deleting leftover branch ${branch} failed (likely unmerged):` + CRLF_N + `  ${String(e.message).trim()}`);
    }
    const shellFail = removeWorktreeDir(wtPath);
    if (shellFail) console.warn(`WARNING: could not remove leftover directory ${wtPath}: ${shellFail}`);
    console.log(`Worktree already gone; deleted leftover branch ${branch}. Cleanup complete.`);
    return;
  }
  if (!wt) die(`no worktree for task "${taskId}" (expected ${wtPath}). Run "start ${taskId}" first, or check "list".`);
  if (wt.branch !== branch) die(`worktree ${wtPath} is on branch "${wt.branch}", expected "${branch}". Aborting.`);

  // NOTES.md is a worktree-local handoff doc — never merged into the branch. Drop the
  // file, and if an earlier `git add -A` committed it, remove it from the branch with a
  // dedicated commit BEFORE the dirty check (deleting a tracked file is itself dirty).
  const notesPath = notesPathFor(wtPath);
  if (fs.existsSync(notesPath)) fs.rmSync(notesPath);
  if (gitInDir(wtPath, ['ls-files', '--', 'NOTES.md']).trim()) {
    gitInDir(wtPath, ['rm', '--quiet', '--', 'NOTES.md']);
    gitInDir(wtPath, ['commit', '--no-verify', '-m', 'chore: remove worktree-local NOTES.md (never merged into mainline)']);
    console.log('NOTES.md had been committed to the branch; removed it automatically (never merged).');
  }

  // worktree must be committed/clean before we touch it
  const dirty = gitInDir(wtPath, ['status', '--porcelain']);
  if (dirty) {
    die(`worktree has uncommitted changes. Commit (or stash) inside ${wtPath} first:\n  git -C "${wtPath}" status --short`);
  }

  const base = baseBranch();

  // 1) rebase onto latest develop so integration conflicts surface HERE, not on develop
  const behind = git(['rev-list', '--count', `${branch}..${base}`]);
  if (Number(behind) > 0) {
    console.log(`Rebasing ${branch} onto ${base} (${behind} new commit(s))...`);
    const r = spawnSync('git', ['rebase', base], { cwd: wtPath, stdio: 'inherit' });
    if (r.status !== 0) {
      die(`rebase has conflicts. Resolve them inside ${wtPath}:
  cd "${wtPath}"   # fix conflicted files
  git -C "${wtPath}" add -A && git -C "${wtPath}" rebase --continue
then re-run: node .agents/scripts/feature-branch.mjs finish ${taskId}`);
    }
  } else {
    console.log(`${branch} is up to date with ${base}.`);
  }

  // 2) nothing to merge?
  const ahead = git(['rev-list', '--count', `${base}..${branch}`]);
  if (Number(ahead) === 0) {
    console.log(`No commits on ${branch}; nothing to merge. Cleaning up worktree and branch.`);
    const cleanupFails = [];
    try {
      git(['worktree', 'remove', wtPath]);
      git(['branch', '-d', branch]);
    } catch (e) {
      cleanupFails.push(`cleanup failed: ${String(e.message).trim()}`);
    }
    const shellFail = removeWorktreeDir(wtPath);
    if (shellFail) cleanupFails.push(`leftover directory could not be removed: ${shellFail}`);
    if (cleanupFails.length) {
      console.warn(`WARNING: cleanup incomplete:` + CRLF_N + cleanupFails.map((m) => '  - ' + m).join(CRLF_N) + CRLF_N + lockHint(wtPath) + CRLF_N + `Re-run: node .agents/scripts/feature-branch.mjs finish ${taskId}   (idempotent, finishes the cleanup)`);
      process.exitCode = 1;
    }
    return;
  }

  // 3) verification (testCmd from .agents/workflow.json) inside the worktree — all green before delivery
  if (!skipTest) {
    const testCmds = loadWorkflowConfig().testCmd;
    if (!testCmds) {
      console.log('No testCmd in .agents/workflow.json; skipping the verification step.');
    } else {
      for (const cmd of testCmds) {
        console.log(`Running verification inside the worktree: ${cmd}`);
        const t = spawnSync(cmd, { cwd: wtPath, stdio: 'inherit', shell: true });
        if (t.status !== 0) {
          die(`verification failed on ${branch} ("${cmd}"). Fix inside ${wtPath}, commit, then re-run finish. ` +
            `(Use --skip-test only for changes that cannot affect behavior, e.g. pure docs.)`);
        }
      }
    }
  }

  // 4) merge into develop from the MAIN worktree (must be checked out on develop)
  if (currentBranch() !== base) {
    die(`main repo is on branch "${currentBranch()}", but merge target is "${base}". ` +
      `Switch the main repo first: git checkout ${base} (commit or stash local changes).`);
  }
  // main checkout must be clean too: a dirty base branch makes the merge fail midway
  // (or entangle unrelated local edits in the conflict resolution).
  if (git(['status', '--porcelain'])) {
    die(`main repo (${base}) has uncommitted changes. Commit or stash them first:\n  git status --short`);
  }
  const message = mergeMsg || `Merge branch '${branch}'`;
  git(['merge', '--no-ff', branch, '-m', message]);
  console.log(`Merged ${branch} into ${base} (--no-ff).`);

  // 5) cleanup — the merge already succeeded, so a cleanup failure must be reported as
  // such (not crash with a bare stack) and must be retryable via a plain finish re-run.
  const cleanupFails = [];
  try {
    git(['worktree', 'remove', wtPath]);
  } catch (e) {
    cleanupFails.push(`git worktree remove failed: ${String(e.message).trim()}`);
  }
  const shellFail = removeWorktreeDir(wtPath);
  if (shellFail) cleanupFails.push(`leftover directory could not be removed: ${shellFail}`);
  try {
    git(['branch', '-d', branch]);
  } catch (e) {
    cleanupFails.push(`git branch -d failed: ${String(e.message).trim()}`);
  }
  if (cleanupFails.length) {
    console.warn(`WARNING: merged ${branch} into ${base} successfully, but cleanup failed:` + CRLF_N + cleanupFails.map((m) => '  - ' + m).join(CRLF_N) + CRLF_N + lockHint(wtPath) + CRLF_N + `Re-run: node .agents/scripts/feature-branch.mjs finish ${taskId}   (idempotent, finishes the cleanup)`);
    process.exitCode = 1;
  } else {
    console.log(`Cleaned up worktree ${wtPath} and branch ${branch}.`);
  }
}

function cmdList() {
  const trees = listWorktrees().filter((t) => t.path.includes('.agents' + path.sep + 'worktrees') || t.path.includes('.agents/worktrees'));
  if (trees.length === 0) {
    console.log('No active task worktrees. Start one: node .agents/scripts/feature-branch.mjs start <task-id>');
    return;
  }
  for (const t of trees) {
    const flags = [];
    if (fs.existsSync(notesPathFor(t.path))) flags.push('NOTES.md'); // task left a handoff doc — read it before taking over
    if (gitInDir(t.path, ['status', '--porcelain'])) flags.push('dirty');
    console.log(`${t.branch || '(detached)'}  ->  ${t.path}${flags.length ? `  [${flags.join(', ')}]` : ''}`);
  }
}

const [cmd, taskId, ...rest] = process.argv.slice(2);
if (cmd === 'start' && taskId) cmdStart(sanitizeTaskId(taskId));
else if (cmd === 'finish' && taskId) cmdFinish(sanitizeTaskId(taskId), rest);
else if (cmd === 'list') cmdList();
else {
  console.log(`Usage:
  node .agents/scripts/feature-branch.mjs start <task-id>
  node .agents/scripts/feature-branch.mjs finish <task-id> [--skip-test] [--message "..."]
  node .agents/scripts/feature-branch.mjs list`);
  process.exit(cmd ? 1 : 0);
}

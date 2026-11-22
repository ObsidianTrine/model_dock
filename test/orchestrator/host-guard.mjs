// 编排套件宿主仓只读护栏（globalSetup 哨兵，2026-11-20 自毁事故防线）：
// 套件启动前对锚定宿主仓（--git-common-dir 语义，与编排器 findRepoRoot 同款）做
// 分支引用 / worktree 注册 / 队列卡三类快照，全量跑完后对账——任何一类被改动即红。
// 事故背景（2026-11-16 23:42 workflow-parallel）：与队列卡同名的 linked worktree 内
// 跑全量套件时，并发 finish 的清理段（worktree remove + 目录 rmSync + branch -d）
// 把正在跑套件的 worktree 连根删掉（.git 指针 + .agents 整树，实验室已逐形状复现）。
// 哨兵不定位责任方，只钉死事实：套件运行窗口内宿主仓不得被改动——无论是套件内测试
// 写穿（应全部走 mkRepo/临时仓沙箱）还是外部并发进程（finish/手工清理，见 AGENTS.md
// 「测试指南」红线）。快照文件落 os.tmpdir（worktree 中途被删也不丢），teardown fail-closed：
// 锚定仓读不到 = 红而非绿（无法验证 ≠ 通过）。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isWin() {
  return process.platform === 'win32';
}

/** git 输出里的路径/行归一：Windows 反斜杠→正斜杠、win 大小写不敏感、去尾分隔符。
 *  与 orchestrator.mjs ensureWorktree 的注册比对同一口径（NTFS 大小写 + porcelain 正斜杠）。 */
function normLine(line) {
  const p = line.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWin() ? p.toLowerCase() : p;
}

function gitOut(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * 定位锚定宿主仓：cwd 起 git rev-parse --git-common-dir（linked worktree 内指向主仓
 * .git，推出主仓根——与编排器 findRepoRoot / feature-branch.mjs 同语义）；git 不可用
 * 或 cwd 不在仓内时向上找 .git 兜底，仍找不到返回 null（哨兵 fail-open 跳过并告警）。
 */
export function resolveAnchorRepo(cwd = process.cwd()) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (common) {
      const dotGit = path.resolve(cwd, common);
      if (fs.existsSync(dotGit)) return path.dirname(dotGit);
    }
  } catch { /* git 不可用或不在仓内——走 walk-up 兜底 */ }
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 递归列出 dir 下全部文件的相对路径（/ 分隔、排序；目录不存在 = 空表）。 */
function listFilesRelative(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 队列目录不存在（从未建队）——空快照
  }
  for (const e of entries) {
    const rel = e.name;
    if (e.isDirectory()) {
      for (const sub of listFilesRelative(path.join(dir, rel))) out.push(`${rel}/${sub}`);
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * 对锚定仓取三类快照（全部归一化 + 排序）：
 *   branches  —— refs/heads 全量（名字 + tip；被 -d/-D 或被并发 merge 推进 tip 即红）
 *   worktrees —— git worktree list --porcelain 的 worktree/branch 行（注册/改挂即红）
 *   queue     —— .agents/orchestrator/queue/ 下全部卡文件相对路径（提交/迁移/清卡即红）
 */
export function snapshotRepo(repoRoot) {
  const branches = gitOut(repoRoot, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'])
    .split('\n')
    .filter(Boolean)
    .sort();
  const worktrees = gitOut(repoRoot, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => /^(worktree|branch) /.test(l))
    .map(normLine)
    .sort();
  const queue = listFilesRelative(path.join(repoRoot, '.agents', 'orchestrator', 'queue')).map(normLine);
  return { branches, worktrees, queue };
}

/** 两个快照的对账差异（人读差异行数组；空数组 = 零改动）。 */
export function diffSnapshots(before, after) {
  const diffs = [];
  const diffList = (label, a, b) => {
    const onlyBefore = a.filter((x) => !b.includes(x));
    const onlyAfter = b.filter((x) => !a.includes(x));
    for (const x of onlyBefore) diffs.push(`${label} 消失: ${x}`);
    for (const x of onlyAfter) diffs.push(`${label} 新增: ${x}`);
  };
  diffList('分支引用', before.branches, after.branches);
  diffList('worktree 注册', before.worktrees, after.worktrees);
  diffList('队列卡', before.queue, after.queue);
  return diffs;
}

/**
 * 全局哨兵入口（vitest globalSetup）：快照落盘并返回 teardown 对账函数。
 * 锚定仓解析失败只告警跳过（fail-open——无锚即无守护对象，套件自身沙箱规则仍生效）；
 * teardown 阶段锚定仓读不到或 git 失效按红处理（fail-closed：无法验证 ≠ 通过）。
 */
export function startHostGuard(cwd = process.cwd()) {
  const root = resolveAnchorRepo(cwd);
  if (!root) {
    console.warn('[host-guard] 未定位到锚定 git 仓（跳过宿主仓快照对账）——套件沙箱规则仍照常生效。');
    return () => {};
  }
  const snapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-host-guard-')), 'snapshot.json');
  fs.writeFileSync(snapFile, JSON.stringify({ root, snap: snapshotRepo(root) }));
  return () => {
    try {
      const { root: savedRoot, snap: before } = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
      let after;
      try {
        after = snapshotRepo(savedRoot);
      } catch (e) {
        throw new Error(
          `[host-guard] 套件运行后锚定宿主仓无法读取（fail-closed）：${savedRoot}\n  ${String(e.message).trim()}\n` +
            '  仓被并发进程删改或 git 失效——按越界处理，先排查再重跑。',
        );
      }
      const diffs = diffSnapshots(before, after);
      if (diffs.length) {
        throw new Error(
          `[host-guard] 套件运行期间宿主仓被改动（越界即红）：\n` +
            diffs.map((d) => `  - ${d}`).join('\n') +
            `\n宿主仓 = ${savedRoot}（--git-common-dir 锚定，同编排器 findRepoRoot）。\n` +
            '排查两向：① 套件内测试是否触达宿主仓（应全部走 mkRepo/临时仓沙箱）；\n' +
            '② 并发进程（finish 清理 / 手工 worktree/分支操作 / 生产编排器）是否在套件窗口内动了宿主仓。\n' +
            '红线背景见 AGENTS.md「测试指南」：编排套件全量/组合跑禁止在与队列卡同名（或存在待 finish 卡）的 worktree 内执行。',
        );
      }
    } finally {
      try { fs.rmSync(path.dirname(snapFile), { recursive: true, force: true }); } catch { /* 快照临时文件尽力清理 */ }
    }
  };
}

export default function hostGuardGlobalSetup() {
  return startHostGuard(process.cwd());
}

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
//
// 撞窗归因（2026-11-22 深夜 finish 门禁产品套件三连红，宿主仓零真越界：生产编排器的
// bench-ship-* 卡在套件窗口内流转 + 清 worktree，fail-closed 照红但报错无法机器区分
// 「编排器撞窗」vs「套件真越界」）：teardown 对账发现漂移时，探测宿主仓活跃任务锁
// （.run-<id>.lock 心跳判活）——有活跃 worker 即在报错前置 [orchestrator-collision]
// 归因段并落 node_modules/.orch-collision.flag marker（feature-branch finish 门禁失败
// 后读它决定「等待重试」的机器契约）；无则消息与行为维持现状、绝不写 marker。
// 两种情况都照旧 throw：归因 ≠ 放行，fail-closed 不变。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAlive } from '../../.agents/scripts/orchestrator/kill-tree.mjs';
import { readLockJson } from '../../.agents/scripts/orchestrator/lockio.mjs';

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

// 任务锁判活阈值：与 .agents/scripts/orchestrator/task-lock.mjs 的 TASK_LOCK_STALE_MS /
// 旧版 LEGACY_STALE_MS 同数值。本地复刻而非 import 整链——task-lock 传递引 events.mjs /
// queue.mjs，host-guard 被产品+编排双套件的 vitest globalSetup 加载，那两个模块的顶层
// 副作用（建目录/写盘）会污染宿主仓或产品套件。锁结构 { pid, task, cmd, acquired_at, beat }。
const LOCK_STALE_MS = 60_000;
const LOCK_LEGACY_STALE_MS = 30 * 60_000;

/**
 * 探测宿主仓的活跃编排器任务锁（撞窗归因用）：扫 .agents/orchestrator/.run-<id>.lock，
 * 心跳 beat 距今 <60s = 活（持有进程每 15s 续写一拍）；无 beat 的旧版锁兜底
 * isAlive + acquired_at 30min。调度器级 .run.lock 无 -<id> 段不匹配正则、天然排除。
 * 读取走 lockio.mjs 的 readLockJson（import 链仅 node 内建、无顶层副作用）；readdir
 * 失败 / 坏 JSON / 缺 pid 一律按不活计、整体不抛——归因是 fail-closed 本体之外的
 * 尽力而为加法，探测挂了不得影响红绿判定。
 */
export function scanLiveTaskLocks(repoRoot) {
  const live = [];
  let names;
  try {
    names = fs.readdirSync(path.join(repoRoot, '.agents', 'orchestrator'));
  } catch {
    return live; // 编排目录不存在（从未建队）——无锁
  }
  for (const name of names) {
    const m = /^\.run-(.+)\.lock$/.exec(name);
    if (!m) continue;
    try {
      const info = readLockJson(path.join(repoRoot, '.agents', 'orchestrator', name));
      if (!info || !Number.isInteger(info.pid)) continue;
      const beatAgeMs = Number.isFinite(info.beat) ? Date.now() - info.beat : null;
      const at = Date.parse(info.acquired_at ?? '');
      const liveByBeat = beatAgeMs !== null && beatAgeMs < LOCK_STALE_MS;
      const liveByLegacy = beatAgeMs === null && isAlive(info.pid) && Number.isFinite(at) && Date.now() - at < LOCK_LEGACY_STALE_MS;
      if (liveByBeat || liveByLegacy) {
        live.push({ taskId: m[1], holder: info.cmd, pid: info.pid, beatAgeMs });
      }
    } catch { /* 单个锁读取异常 → 该锁按不活计 */ }
  }
  return live;
}

/** 撞窗 marker（机器契约）：feature-branch finish 门禁失败后读它决定「等待重试」。
 *  落 process.cwd()/node_modules/——finish 场景必然存在且被 gitignore。写入失败静默：
 *  归因消息已足够人读诊断，marker 丢不得影响 fail-closed 本体。 */
function writeCollisionMarker(liveLocks) {
  try {
    fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
    fs.writeFileSync(
      path.join(process.cwd(), 'node_modules', '.orch-collision.flag'),
      JSON.stringify({
        at: Date.now(),
        summary: `宿主仓在套件窗口内被改动，且探测到 ${liveLocks.length} 个活跃编排器任务锁：疑似编排器撞窗（非套件越界），等其静默后重跑 finish。`,
        sources: liveLocks,
      }),
    );
  } catch { /* marker 尽力而为 */ }
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
        // 现有对账明细与排查指引：归因未命中时整段原样抛出（逐字节不变），命中时原样
        // 接在归因段之后（一字不减）。
        const detail =
          `[host-guard] 套件运行期间宿主仓被改动（越界即红）：\n` +
          diffs.map((d) => `  - ${d}`).join('\n') +
          `\n宿主仓 = ${savedRoot}（--git-common-dir 锚定，同编排器 findRepoRoot）。\n` +
          '排查两向：① 套件内测试是否触达宿主仓（应全部走 mkRepo/临时仓沙箱）；\n' +
          '② 并发进程（finish 清理 / 手工 worktree/分支操作 / 生产编排器）是否在套件窗口内动了宿主仓。\n' +
          '红线背景见 AGENTS.md「测试指南」：编排套件全量/组合跑禁止在与队列卡同名（或存在待 finish 卡）的 worktree 内执行。';
        const liveLocks = scanLiveTaskLocks(savedRoot);
        if (liveLocks.length) writeCollisionMarker(liveLocks); // 归因命中才落 marker；未命中绝不写
        throw new Error(
          liveLocks.length
            ? `[orchestrator-collision] 检测到活跃编排器任务锁：\n` +
              liveLocks
                .map((l) => {
                  const beat = l.beatAgeMs === null ? 'beat 未知（旧版锁）' : `beat ${Math.round(l.beatAgeMs / 1000)}s 前`;
                  return `  - ${l.taskId}（holder=${l.holder ?? 'unknown'}, pid=${l.pid}, ${beat}）`;
                })
                .join('\n') +
              '\n疑似编排器撞窗（非套件越界）：等其静默后重跑 finish；若确认无编排器在跑则为真越界，须按下述排查。\n' +
              detail
            : detail,
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

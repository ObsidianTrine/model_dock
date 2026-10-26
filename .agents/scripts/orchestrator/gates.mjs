// gates.mjs — orchestrator 六项静态门禁（docs 5.7）。
// 全部在 worktree 内执行；npm_test/tsc_build 失败进调试子循环，
// port_scan/native_scan 触红线直接 failed（红线不可调试）。
// 可移植性（2026-10-07）：buildCmd / protectedPorts / packageManager / corePaths 全部来自
// .agents/workflow.json（见 workflow-config.mjs）；参数缺省时回落脚本锚定配置，
// 配置缺省（空）= 对应门禁跳过（返回 skipped，调用方仍记 pass 事件），不再假设 npm/SEA/特定端口。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkflowConfig, isNpmFamily } from '../workflow-config.mjs';

export class GateError extends Error {
  constructor(name, message, output = '') {
    super(`[${name}] ${message}`);
    this.gate = name;
    this.output = output;
    this.kind = 'redline'; // redline = 直接 failed；caller 区分
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

/**
 * 跑 shell 命令（同步，捕获合并输出）。返回 { ok, output, durationMs, exitCode }。
 * 用 spawnSync shell 模式：testCmd 来自 workflow.json，是任意 shell 片段。
 */
export function runCmd(cmd, cwd, timeoutMs = 20 * 60_000) {
  const started = Date.now();
  const { status, stdout, stderr } = execSyncShim(cmd, cwd, timeoutMs);
  return {
    ok: status === 0,
    exitCode: status,
    output: `${stdout}\n${stderr}`.trim(),
    durationMs: Date.now() - started,
  };
}

// execSync 的 stderr 默认会打到父进程终端（stdio 继承），包一层收集
function execSyncShim(cmd, cwd, timeoutMs) {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** git diff develop...HEAD 的名称集合（A/M/D/R 全算改动面）。 */
export function changedFiles(cwd, baseBranch = 'develop') {
  const out = git(cwd, ['diff', '--name-only', `${baseBranch}...HEAD`]);
  // NOTES.md 是 feature-branch 工作流的交接元文件（finish 自动从分支移除，永不进主干），
  // worker git add -A 会把它带进提交——它不属于任务改动面，分级/范围检查统一豁免
  return out ? out.split('\n').filter((f) => f && f !== 'NOTES.md') : [];
}

/** diff 的新增行全文（只取 + 行、去掉 +++ 头），供红线扫描。 */
function addedLines(cwd, baseBranch) {
  const diff = git(cwd, ['diff', '-U0', `${baseBranch}...HEAD`]);
  const lines = [];
  let currentFile = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) currentFile = line.slice(6);
    else if (line.startsWith('+') && !line.startsWith('+++')) lines.push({ file: currentFile, text: line.slice(1) });
  }
  return lines;
}

/** glob → RegExp：支持 `**`（跨段）、`*`（单段内）、`?`。 */
export function globToRegExp(pattern) {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`);
}

function matchesAny(file, patterns) {
  return patterns.some((p) => globToRegExp(p).test(file));
}

// ---------------------------------------------------------------------------
// 六项门禁
// ---------------------------------------------------------------------------

/** npm_test：worktree 内跑 workflow.json 的 testCmd。 */
export function gateNpmTest(cwd, testCmd) {
  const r = runCmd(testCmd, cwd);
  if (!r.ok) throw new GateError('npm_test', `testCmd 退出码 ${r.exitCode}`, r.output);
  return r;
}

/**
 * tsc_build：跑 workflow.json 的 buildCmd（产物不进仓库，只为验证构建/类型正确）。
 * buildCmd 未配置 → 跳过（skipped: true），调用方照常记 pass 事件。
 */
export function gateTscBuild(cwd, buildCmd = loadWorkflowConfig().buildCmd) {
  if (!buildCmd) return { ok: true, skipped: true };
  const r = runCmd(buildCmd, cwd);
  if (!r.ok) throw new GateError('tsc_build', `${buildCmd} 退出码 ${r.exitCode}`, r.output);
  return r;
}

/**
 * lint：跑 workflow.json 的 lintCmd（业界共识：lint/类型检查是独立确定性门禁，
 * 比 testCmd 粒度细、比 LLM 审查可靠）。未配置 → 跳过；失败进调试子循环（与 build 同级）。
 */
export function gateLint(cwd, lintCmd = loadWorkflowConfig().lintCmd) {
  if (!lintCmd) return { ok: true, skipped: true };
  const r = runCmd(lintCmd, cwd);
  if (!r.ok) throw new GateError('lint', `${lintCmd} 退出码 ${r.exitCode}`, r.output);
  return r;
}

/** typecheck：跑 workflow.json 的 typecheckCmd。语义与 lint 同（未配置跳过、失败可调试）。 */
export function gateTypecheck(cwd, typecheckCmd = loadWorkflowConfig().typecheckCmd) {
  if (!typecheckCmd) return { ok: true, skipped: true };
  const r = runCmd(typecheckCmd, cwd);
  if (!r.ok) throw new GateError('typecheck', `${typecheckCmd} 退出码 ${r.exitCode}`, r.output);
  return r;
}

/**
 * ui_check：跑 workflow.json 的 uiCheckCmd（Web 控制台沙箱冒烟——脚本自备
 * 189xx 端口 + MODELRDOCK_FAKE_HOME 隔离与进程清理，orchestrator 不感知细节）。
 * 任务卡未声明 ui_check 时调用方根本不调这里；命令未配置 → 跳过。
 * 失败进调试子循环（与 build 同级），不是红线。
 */
export function gateUiCheck(cwd, uiCheckCmd = loadWorkflowConfig().uiCheckCmd) {
  if (!uiCheckCmd) return { ok: true, skipped: true };
  const r = runCmd(uiCheckCmd, cwd);
  if (!r.ok) throw new GateError('ui_check', `uiCheckCmd 退出码 ${r.exitCode}`, r.output);
  return r;
}

/**
 * port_scan：只扫 src/** 的新增行里的 listen/端口绑定模式（docs 5.7——
 * 测试与文档合法提及受保护端口不算红线，红线是"让服务监听保护端口"）。
 * 端口清单来自 workflow.json protectedPorts（可显式注入）；空 = 跳过。
 */
export function gatePortScan(cwd, baseBranch = 'develop', ports = loadWorkflowConfig().protectedPorts) {
  if (!ports.length) return { ok: true, skipped: true, scanned: 0 };
  const lines = addedLines(cwd, baseBranch).filter((l) => l.file.startsWith('src/'));
  const alt = ports.join('|');
  const patterns = [
    new RegExp(`listen\\s*\\(\\s*['"\`]?(?:${alt})\\b`),
    new RegExp(`listen\\s*\\(\\s*(?:.*,\\s*)?['"\`]?(?:${alt})\\b`),
    new RegExp(`['"\`]?(?:${alt})['"\`]?\\s*[,)]\\s*['"\`]?127\\.0\\.0\\.1`),
    new RegExp(`\\b([A-Z_]*PORT[A-Z_]*)\\s*=\\s*['"\`]?(?:${alt})\\b`),
  ];
  for (const { file, text } of lines) {
    for (const re of patterns) {
      if (re.test(text)) {
        throw new GateError('port_scan', `src/ 新增行命中受保护端口红线（${ports.join('/')}）：${file}: ${text.trim()}`);
      }
    }
  }
  return { ok: true, scanned: lines.length };
}

/**
 * native_scan：diff 触及 package.json → 新增依赖不得含 native addon 痕迹。
 * 仅 npm 系项目（workflow.json packageManager ∈ npm/pnpm/yarn/bun）启用；其余跳过。
 */
export function gateNativeScan(cwd, baseBranch = 'develop', packageManager = loadWorkflowConfig().packageManager) {
  if (!isNpmFamily(packageManager)) return { ok: true, skipped: true, checked: false };
  const changed = changedFiles(cwd, baseBranch);
  if (!changed.includes('package.json')) return { ok: true, checked: false };

  const readDeps = (commit) => {
    try {
      return JSON.parse(git(cwd, ['show', `${commit}:package.json`]));
    } catch {
      return {};
    }
  };
  const base = readDeps(`${baseBranch}`);
  const head = readDeps('HEAD');
  const newDeps = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const b = base[section] ?? {};
    const h = head[section] ?? {};
    for (const name of Object.keys(h)) if (!(name in b)) newDeps.push(name);
  }
  for (const name of newDeps) {
    const pkgDir = path.join(cwd, 'node_modules', ...name.split('/'));
    if (!fs.existsSync(pkgDir)) continue; // 未安装的依赖无法本地检查，留给 CI
    const hits = [];
    scanNative(pkgDir, pkgDir, hits, 0);
    if (hits.length) {
      throw new GateError('native_scan', `新增依赖 ${name} 含 native addon 痕迹（违反项目依赖约束，见 workflow.json）：\n  ${hits.join('\n  ')}`);
    }
  }
  return { ok: true, checked: true, newDeps };
}

function scanNative(root, dir, hits, depth) {
  if (depth > 4 || hits.length > 5) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === '.bin' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['prebuilds', 'build'].includes(e.name)) hits.push(path.relative(root, p));
      else scanNative(root, p, hits, depth + 1);
    } else if (/\.(node|gyp)$/.test(e.name) || e.name === 'binding.gyp') {
      hits.push(path.relative(root, p));
    }
  }
}

/** scope_purity：改动超出 files_hint → 返回越界文件列表（警告，不阻塞）。 */
export function gateScopePurity(cwd, filesHint, baseBranch = 'develop') {
  const changed = changedFiles(cwd, baseBranch);
  const outside = changed.filter((f) => !matchesAny(f, filesHint));
  return { ok: true, outside };
}

/**
 * cli_entry：diff 触及 workflow.json corePaths 的任一路径 → 人工闸门标红。
 * 返回被触及的核心路径列表（空数组 = 未触及）；corePaths 缺省空 = 永不标红。
 */
export function gateCliEntry(cwd, baseBranch = 'develop', corePaths = loadWorkflowConfig().corePaths) {
  const changed = changedFiles(cwd, baseBranch);
  return corePaths.filter((p) => changed.includes(p));
}

// worktree 依赖准备（自 orchestrator.mjs 抽出为可注入模块：orchestrator.mjs 顶层即执行
// main()，测试无法直接 import 它；单测经 opts.spawnFn 注入假 spawn 校验入参）。
// 全新 checkout 没有 node_modules，worker 的 npm test/build 门禁第一步就会失败，而
// npm install 不在 worker 白名单里——环境准备是 orchestrator 的职责，不是 worker 的。
// 仅当存在 package-lock.json（可复现的真实 npm 项目）且缺 node_modules 时才安装；
// 集成测试的轻量临时仓库无 lock，自动跳过、保持秒级。
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export function installWorkspaceDeps(worktree, taskId, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawnSync;
  const out = opts.log ?? (() => {});
  const bail = opts.die ?? ((msg, code) => { throw new Error(msg); });
  const pkg = path.join(worktree, 'package.json');
  const lock = path.join(worktree, 'package-lock.json');
  const modules = path.join(worktree, 'node_modules');
  if (!fs.existsSync(pkg) || !fs.existsSync(lock) || fs.existsSync(modules)) return;
  out(`worktree ${taskId} 缺少 node_modules，先安装依赖（package-lock.json 锁定）……`);
  // Windows 的 npm 是 .cmd 包装，spawnSync 直调 ENOENT——win32 补 shell（与 gates.mjs runCmd、
  // claude-headless 的 claudeAvailable 同款）；参数是静态安全串，无注入面。
  const r = spawnFn('npm', ['ci', '--no-fund', '--no-audit'], { cwd: worktree, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) bail(`worktree 依赖安装失败（exit ${r.status}）。请在该 worktree 内手动 npm ci 后重跑 run/resume。`, r.status ?? 1);
}

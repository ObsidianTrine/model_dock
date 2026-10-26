#!/usr/bin/env node
// agent-init.mjs — 把 .agents/ 工具链落地到新项目的一键初始化（可移植性收口）。
// 前提：已把模板项目的 .agents/ 整目录拷进目标项目根（见 .agents/workflows/feature-branch.md「移植到其他项目」节）。
// 做四件事：
//   1. 交互问答（或 --defaults 全缺省）生成 .agents/workflow.json——项目数据全部进配置，代码零假设；
//   2. 注册双客户端 PreToolUse hook（.zcode/config.json + .claude/settings.json，合并式写入、幂等）；
//   3. AGENTS.md 缺失时生成骨架（占位符待填，绝不覆盖已有文件）；
//   4. 打印手工收尾清单（headless worker 的用户级 hook 注册、playbook 修剪）。
// 用法：
//   node .agents/scripts/agent-init.mjs [--defaults] [--force] [--skip-agents-md] [字段覆盖 flags]
// 字段覆盖：--project-name --base-branch --test-cmd --setup-cmd --build-cmd --package-manager
//           --protected-ports --core-paths --release-paths --review-notes --ui-check-cmd
//           --gateway-log-dir --env-prefix   （列表类用逗号分隔；单值 flag 优先于问答）
// 零第三方依赖（.agents/ 工具链红线）；纯 Node 标准库，跨三平台。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** 解析 argv：--key value / --bool 两形态。 */
function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }
  return flags;
}

function findRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

/** 环境探测：包管理器（lockfile）/ package.json name 与 scripts / 当前分支。 */
function detect(repoRoot) {
  const out = { pm: null, pkgName: null, testScript: null, buildScript: null, branch: null, hasGithubWorkflows: false };
  for (const [pm, lock] of [['npm', 'package-lock.json'], ['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['bun', 'bun.lockb']]) {
    if (fs.existsSync(path.join(repoRoot, lock))) { out.pm = pm; break; }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name.trim()) out.pkgName = pkg.name.trim();
    if (typeof pkg.scripts?.test === 'string') out.testScript = pkg.scripts.test;
    if (typeof pkg.scripts?.build === 'string') out.buildScript = pkg.scripts.build;
  } catch {
    /* 非 Node 项目（Rust/Python/C++…）：全部走问答缺省 */
  }
  try {
    out.branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', cwd: repoRoot }).trim() || null;
  } catch {
    /* 无 git：baseBranch 缺省 develop */
  }
  out.hasGithubWorkflows = fs.existsSync(path.join(repoRoot, '.github', 'workflows'));
  return out;
}

const DEFAULT_SETUP_BY_PM = {
  npm: 'npm ci --prefer-offline',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --frozen-lockfile',
  bun: 'bun install --frozen-lockfile',
};

/** 列表 flag → 数组（逗号分隔）。 */
function strList(flags, key) {
  const v = flags.get(key);
  return typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const defaults = flags.get('defaults') === true;
  const repoRoot = findRepoRoot();

  if (!fs.existsSync(path.join(repoRoot, '.agents', 'scripts', 'feature-branch.mjs'))) {
    die(`未发现 ${path.join(repoRoot, '.agents', 'scripts', 'feature-branch.mjs')}——先拷贝模板项目的 .agents/ 整目录到本项目根（cp -r <模板项目>/.agents .），再跑本脚本。`);
  }

  const wfPath = path.join(repoRoot, '.agents', 'workflow.json');
  if (fs.existsSync(wfPath) && flags.get('force') !== true) {
    die(`${wfPath} 已存在。确认要重新生成请加 --force（现有文件会被覆盖）；只想微调请直接编辑该文件（字段说明见 .agents/scripts/workflow-config.mjs 头注释）。`);
  }

  const d = detect(repoRoot);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  /** 问答一次；--defaults 或有显式 flag 时跳过问答直接取值。 */
  const ask = async (flagKey, question, def) => {
    const flag = flags.get(flagKey);
    if (typeof flag === 'string' && flag.trim()) return flag.trim();
    if (defaults) return def;
    const ans = (await rl.question(`${question}${def ? ` [${def}]` : ''} > `)).trim();
    return ans || def;
  };

  const projectName = await ask('project-name', '项目展示名（通知标题/调度任务名）', d.pkgName ?? path.basename(repoRoot));
  const baseBranch = await ask('base-branch', '合并目标分支（feature 分支的落点）', d.branch && d.branch !== 'HEAD' ? d.branch : 'develop');
  const testCmd = await ask('test-cmd', '验证命令（finish 与门禁都会跑；逗号分隔多条）', d.testScript ?? (d.pm ? `${d.pm} test` : 'npm test'));
  const setupCmd = await ask('setup-cmd', '环境准备命令（worktree 建好后自动跑；留空跳过）', d.pm ? DEFAULT_SETUP_BY_PM[d.pm] : '');
  const buildCmd = await ask('build-cmd', '构建命令（留空 = 跳过 build 门禁）', d.buildScript ?? '');
  const packageManager = await ask('package-manager', '包管理器（npm 系才启用 native addon 扫描）', d.pm ?? 'none');
  const protectedPorts = await ask('protected-ports', '受保护端口（逗号分隔，缺省不启用端口红线）', '');
  const reviewNotes = await ask('review-notes', '审查红线一句话（注入独立审查/spec 提示词，可留空）', '');
  rl.close();

  const cfg = {
    version: 1,
    projectName,
    baseBranch,
    testCmd: testCmd.includes(',') ? testCmd.split(',').map((s) => s.trim()).filter(Boolean) : testCmd,
  };
  if (setupCmd) cfg.setupCmd = setupCmd;
  if (buildCmd) cfg.buildCmd = buildCmd;
  if (packageManager && packageManager !== 'none') cfg.packageManager = packageManager;
  const ports = strList(flags, 'protected-ports') ?? (protectedPorts ? protectedPorts.split(',').map((s) => s.trim()).filter(Boolean) : []);
  if (ports.length) cfg.protectedPorts = ports;
  const corePaths = strList(flags, 'core-paths');
  if (corePaths?.length) cfg.corePaths = corePaths;
  const releasePaths = strList(flags, 'release-paths') ?? (d.hasGithubWorkflows ? ['.github/workflows/'] : []);
  if (releasePaths.length) cfg.releasePaths = releasePaths;
  const notesFlag = flags.get('review-notes');
  const notes = typeof notesFlag === 'string' && notesFlag.trim() ? notesFlag.trim() : reviewNotes;
  if (notes) cfg.reviewNotes = notes;
  const uiCheck = flags.get('ui-check-cmd');
  if (typeof uiCheck === 'string' && uiCheck.trim()) cfg.uiCheckCmd = uiCheck.trim();
  const gwLog = flags.get('gateway-log-dir');
  if (typeof gwLog === 'string' && gwLog.trim()) cfg.gatewayLogDir = gwLog.trim();
  const envPrefix = flags.get('env-prefix');
  if (typeof envPrefix === 'string' && /^[A-Z][A-Z0-9_]*$/i.test(envPrefix.trim())) cfg.envPrefix = envPrefix.trim();

  fs.mkdirSync(path.dirname(wfPath), { recursive: true });
  fs.writeFileSync(wfPath, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`✓ 已生成 ${wfPath}`);

  // 双客户端 hook 注册（合并式：已有条目按 matcher+command 去重，绝不覆盖用户其余配置）
  const HOOK_ENTRIES = [
    { matcher: 'Edit|Write|MultiEdit|NotebookEdit', command: 'node .agents/hooks/guard-develop.mjs' },
    { matcher: 'Bash', command: 'node .agents/hooks/policy-zcode.mjs' },
  ];
  const mergeEntries = (list) => {
    for (const e of HOOK_ENTRIES) {
      const found = list.find((x) => x.matcher === e.matcher);
      if (found) {
        found.hooks = Array.isArray(found.hooks) ? found.hooks : [];
        if (!found.hooks.some((h) => h.command === e.command)) found.hooks.push({ type: 'command', command: e.command });
      } else {
        list.push({ matcher: e.matcher, hooks: [{ type: 'command', command: e.command }] });
      }
    }
    return list;
  };
  let registered = [];
  const zcodePath = path.join(repoRoot, '.zcode', 'config.json');
  try {
    const cur = fs.existsSync(zcodePath) ? JSON.parse(fs.readFileSync(zcodePath, 'utf8')) : {};
    cur.hooks = cur.hooks && typeof cur.hooks === 'object' ? cur.hooks : {};
    cur.hooks.enabled = true;
    cur.hooks.events = cur.hooks.events && typeof cur.hooks.events === 'object' ? cur.hooks.events : {};
    cur.hooks.events.PreToolUse = mergeEntries(Array.isArray(cur.hooks.events.PreToolUse) ? cur.hooks.events.PreToolUse : []);
    fs.mkdirSync(path.dirname(zcodePath), { recursive: true });
    fs.writeFileSync(zcodePath, `${JSON.stringify(cur, null, 2)}\n`);
    registered.push(zcodePath);
  } catch (e) {
    console.error(`⚠ ${zcodePath} 解析失败，未写入（${e.message}）。请手工补 hook 注册。`);
  }
  const claudePath = path.join(repoRoot, '.claude', 'settings.json');
  try {
    const cur = fs.existsSync(claudePath) ? JSON.parse(fs.readFileSync(claudePath, 'utf8')) : {};
    cur.hooks = cur.hooks && typeof cur.hooks === 'object' ? cur.hooks : {};
    cur.hooks.PreToolUse = mergeEntries(Array.isArray(cur.hooks.PreToolUse) ? cur.hooks.PreToolUse : []);
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
    fs.writeFileSync(claudePath, `${JSON.stringify(cur, null, 2)}\n`);
    registered.push(claudePath);
  } catch (e) {
    console.error(`⚠ ${claudePath} 解析失败，未写入（${e.message}）。请手工补 hook 注册。`);
  }
  for (const p of registered) console.log(`✓ hook 已注册: ${p}`);

  // AGENTS.md 骨架（缺失才写，永不覆盖）
  if (flags.get('skip-agents-md') !== true) {
    const agentsPath = path.join(repoRoot, 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
      console.log(`✓ AGENTS.md 已存在，保持不动`);
    } else {
      fs.writeFileSync(
        agentsPath,
        [
          `# ${projectName} — 项目指南（AGENTS.md）`,
          '',
          '> 面向 AI 编码代理的项目说明（agent-init 生成骨架，按项目实际填充后删掉本提示）。',
          '> 结构参考 https://agents.md/ 。只写「代码看不出来的约定」，agent 已懂的背景不必解释。',
          '',
          '## 项目概览',
          '<!-- 一段话：这个项目是什么、技术栈与核心约束（运行时版本/打包方式/平台支持） -->',
          '',
          '## 命令速查',
          '',
          '| 用例 | 命令 |',
          '|------|------|',
          `| 装依赖 | \`${setupCmd || '<!-- setupCmd -->'}\` |`,
          `| 测试 | \`${Array.isArray(cfg.testCmd) ? cfg.testCmd[0] : cfg.testCmd}\`（**改完代码必须全绿**） |`,
          `| 构建 | \`${buildCmd || '<!-- buildCmd -->'}\` |`,
          '',
          '## 工程硬性约定',
          '<!-- 只列硬约束：路径规则、写盘方式、错误信息风格、平台兼容清单……逐条可判定 -->',
          '',
          '## 回复风格约定',
          '',
          '1. 第一句必须是直接答案或结论，禁止开场白。',
          '2. 结论 → 关键要点（最多 5 条）→ 必要细节；推测性内容标注「推测」。',
          '3. 短句 + 列表，不写大段落。',
          '',
          '## 测试指南',
          '<!-- 套件构成、隔离机制（临时目录/env 重定向）、平台差异注意点 -->',
          '',
          '## 多 Agent 并行开发约定',
          '',
          '- **禁止直接在基准分支上修改代码文件**（PreToolUse hook 会拦截）；所有代码改动走 worktree：',
          '  `node .agents/scripts/feature-branch.mjs start <task-id>`，完整规程见 `.agents/workflows/feature-branch.md`。',
          `- 受保护端口：${ports.length ? ports.join('、') : '（未配置）'}——测试实例一律用随机/高位端口。`,
          '',
        ].join('\n'),
      );
      console.log(`✓ AGENTS.md 骨架已生成（按项目实际填充）`);
    }
  }

  console.log('');
  console.log('════════ 手工收尾清单 ════════');
  console.log('1. 高级字段按需补进 .agents/workflow.json：corePaths（改动即人工）/ releasePaths（发布流水线）/');
  console.log('   worker、review（执行与审查引擎，缺省 claude-headless + 自动异构互审）/ tiers（任务等级凭据）。');
  console.log('   字段说明见 .agents/scripts/workflow-config.mjs 头注释。');
  console.log('2. 修剪 playbook：.agents/workflows/ 里 add-adapter / add-preset / incident-response / ui-kit 等是');
  console.log('   模板项目的领域手册，删除或按本项目重写；feature-branch / code-review / docs-sync /');
  console.log('   worktree-rescue / release / hotfix / orchestrator 是通用手册，可留用。');
  console.log('3. headless worker 的 Bash 红线 hook 在本项目级 hook 之外还需用户级注册');
  console.log('   （headless 会话下项目级 hook 被信任门禁用）。推荐机器级 dispatcher——一次注册全项目生效：');
  console.log('     cp .agents/hooks/policy-dispatch.mjs ~/.agents/hooks/');
  console.log('     然后在 ~/.zcode/cli/config.json 的 hooks.events.PreToolUse 数组追加：');
  console.log('       { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node <家目录>/.agents/hooks/policy-dispatch.mjs" }] }');
  console.log('   或逐项目注册：{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node <本项目绝对路径>/.agents/hooks/policy-zcode.mjs" }] }');
  console.log('   说明见 .agents/workflows/orchestrator.md。');
  console.log('4. nightly 定时巡检（可选）：node .agents/scripts/orchestrator.mjs schedule install --dry-run 先看计划。');
}

await main();

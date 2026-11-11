#!/usr/bin/env node
/**
 * scripts/test-gate.mjs —— 测试域路由器（AGENTS.md「测试指南」L2：finish 合并门禁的大脑）。
 *
 * 按改动文件的域归属自动路由验证强度：
 *   产品域（src/**、scripts/**、顶层 test/** 等）→ 产品全量 npm test（约 3-4 分钟）
 *   编排域（.agents/**、test/orchestrator/**）  → 编排冒烟子集（目标 ≤60s；编排全量由 CI
 *                                                 workflow-suite required check 按路径分级兜底）
 *   双域 / 未匹配文件                           → 两段都跑（保守）
 *   纯 .md 变更（不触双域名单）                  → docs-lint（≤10s，L0）
 * 跨域契约联动：计费面文件变更追加三支计费用例；ui-kit.md / workflow.json 触发产品侧定点用例。
 *
 * 用法：
 *   node scripts/test-gate.mjs                # 自动口径：merge-base <baseBranch>..HEAD
 *                                             # （worktree finish 场景；baseBranch 读 .agents/workflow.json）
 *   node scripts/test-gate.mjs --base <ref>   # 用指定基准对比（diff = merge-base <ref>..HEAD）
 *   node scripts/test-gate.mjs --head <ref>   # 区间终点默认 HEAD；历史归类抽验用（如 --base A~1 --head A）
 *   node scripts/test-gate.mjs --staged       # 只看暂存区（pre-commit 场景）
 *   node scripts/test-gate.mjs --dry          # 只打印路由计划不执行
 *   node scripts/test-gate.mjs --full         # 强制双套件全量（npm test + npm run test:workflow）
 *
 * 兜底：HEAD 就在基准分支上时改看暂存区，暂存区为空再用 HEAD~1——所用口径随输出说明；
 *       diff 无法计算时保守按双域全跑并输出警告。
 *
 * 约束：零第三方依赖（纯 node:std）；Windows 兼容——路径全 path.join、子进程全走
 * process.execPath 绝对路径（npm 兜底直 spawn 时仅 win32 shell:true），无 shell 拼接。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAXBUF = 32 * 1024 * 1024;

// ─────────────────────────── 域归属表（显式常量，便于测试） ───────────────────────────

/** 双域（保守，触发双跑）：显式名单 + 未匹配归属表的任何文件 */
export const DUAL_RULES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.test.json',
  'vitest.config.ts',
  'vitest.workflow.config.ts',
  '.github/**',
  'AGENTS.md',
];

/** 编排域（Dockmaster）：跑编排冒烟子集 */
export const DOCKMASTER_RULES = ['.agents/**', 'test/orchestrator/**'];

/** 产品域（ModelDock）：跑产品全量 npm test */
export const PRODUCT_RULES = [
  'src/**',
  'test/*.test.ts', // 仅顶层；test/orchestrator/** 归编排域
  'test/helpers.ts',
  'test/helpers/**',
  'test/mocks/**',
  'test/setup-fast-kdf.ts',
  'scripts/**',
  'docs/**',
  'README*',
  'CHANGELOG*',
  'eslint.config.*',
  '.eslintrc*',
  'eslint-baseline.json',
  '.prettierrc*',
  'prettier.config.*',
  '.prettierignore',
  '.eslintignore',
];

/**
 * 归属表规则匹配。支持的形态：
 *   'dir/**'     目录递归（含 'dir' 自身）
 *   'dir/'       目录递归（workflow.json releasePaths 形态）
 *   'exact/path' 精确路径
 *   'prefix*'    根级/单层前缀（README*、eslint.config.*）——不吃子目录
 *   '*.ext'      任意层级后缀
 *   'dir/*.ext'  单层目录 + 后缀（test/*.test.ts 仅顶层）
 * 反斜杠路径（Windows diff 输出）先归一为正斜杠再匹配。
 */
export function matchRule(rule, rawFile) {
  const f = String(rawFile).split('\\').join('/');
  const r = String(rule).split('\\').join('/');
  if (r.endsWith('/**')) {
    const base = r.slice(0, -3);
    return f === base || f.startsWith(base + '/');
  }
  if (r.endsWith('/')) return f.startsWith(r);
  const star = r.indexOf('*');
  if (star === -1) return f === r;
  if (r.endsWith('*')) {
    const prefix = r.slice(0, -1);
    return f.startsWith(prefix) && !f.slice(prefix.length).includes('/');
  }
  if (r.startsWith('*')) return f.endsWith(r.slice(1));
  // 中间星号：dir/*.ext —— 目录前缀 + 单层 + 后缀
  const prefix = r.slice(0, star);
  const suffix = r.slice(star + 1);
  return (
    f.startsWith(prefix) &&
    f.endsWith(suffix) &&
    !f.slice(prefix.length, f.length - suffix.length).includes('/')
  );
}

/**
 * 单文件归域：双域显式名单优先 → 编排域 → 产品域 → 未匹配 .md 归文档桶（路由惰性，
 * 仅参与纯文档判定——台账/杂项 .md 的纯文档编辑不该触发双套件）→ 其余未匹配兜底双域
 * （保守）。返回 'dual' | 'dockmaster' | 'product' | 'docs'。
 */
export function classifyFile(file) {
  const f = String(file).split('\\').join('/');
  if (DUAL_RULES.some((r) => matchRule(r, f))) return 'dual';
  if (DOCKMASTER_RULES.some((r) => matchRule(r, f))) return 'dockmaster';
  if (PRODUCT_RULES.some((r) => matchRule(r, f))) return 'product';
  if (f.endsWith('.md')) return 'docs';
  return 'dual';
}

export function dedup(list) {
  return [...new Set(list)];
}

/** 归类一组变更文件（入参先去重）。docs 桶为未匹配 .md，不参与路由，仅参与纯文档判定。 */
export function classifyFiles(files) {
  const out = { product: [], dockmaster: [], dual: [], docs: [] };
  for (const f of dedup(files)) out[classifyFile(f)].push(f);
  return out;
}

/**
 * 纯文档判定：变更集非空、全部为 .md、且没有一个文件落在双域显式名单（AGENTS.md 等；
 * 未匹配 .md 归 docs 桶不算双域）。纯文档只跑 docs-lint（L0），优先于单文件的产品/编排归类。
 */
export function isDocsOnlySet(files) {
  const list = dedup(files);
  return list.length > 0 && list.every((f) => f.endsWith('.md')) && list.every((f) => classifyFile(f) !== 'dual');
}

// ─────────────────────────── 编排冒烟子集（目标 ≤60s） ───────────────────────────

/**
 * 编排冒烟子集：编排域改动的固定抽检面，核心主链路各取一支（显式常量，改动面大时按
 * 实测时长增删）。硬排除四支慢件（单文件实测：sail 280s / sail-autodim 117s /
 * integration 62s / drift 47s，绝不能进子集）；另避开带真实长 sleep 的 autoapprove /
 * notify-digest 与并行时序偶发红的 reviewing-recovery。
 * 实测（2026-11-12，mac 8C，maxWorkers=4）：11 文件 / 235 用例 / 41.1s 全绿。
 */
export const ORCH_SMOKE_FILES = [
  'test/orchestrator/workflow-config.test.ts', // 配置装载与校验——编排器一切用例的地基
  'test/orchestrator/scan.test.ts',            // 任务卡扫描入口（卡进队列的第一跳）
  'test/orchestrator/planner.test.ts',         // 调度规划核心（派发决策面）
  'test/orchestrator/spec.test.ts',            // 卡→规格构建主链路
  'test/orchestrator/supply.test.ts',          // 供给面（上下文组装）
  'test/orchestrator/propose.test.ts',         // 提案生成与反馈
  'test/orchestrator/provision.test.ts',       // 环境供给 E2E（mock 网关子进程，子集最慢件 ~31s）
  'test/orchestrator/budget-billable.test.ts', // 计费可计面（契约联动锚点）
  'test/orchestrator/watchdog.test.ts',        // 看门狗（卡死防线）
  'test/orchestrator/tiers.test.ts',           // 层级路由（契约联动锚点）
  'test/orchestrator/reconcile.test.ts',       // 对账（契约联动锚点）
];

/** 冒烟子集硬排除名单（不变量，test-gate.test.ts 哨兵断言） */
export const ORCH_SMOKE_EXCLUDED = [
  'test/orchestrator/sail.test.ts',
  'test/orchestrator/sail-autodim.test.ts',
  'test/orchestrator/integration.test.ts',
  'test/orchestrator/drift.test.ts',
  // 以下为「避开」级（非硬排除语义，但同样不进子集）：
  'test/orchestrator/autoapprove.test.ts',      // 真实 sleep ~2.5s
  'test/orchestrator/notify-digest.test.ts',    // 真实 sleep ~2s
  'test/orchestrator/reviewing-recovery.test.ts', // 曾并行偶发红（共享 tmpdir 差分误判并发 fork 迁移）；已私有 TMPDIR 隔离修复（2026-11-12 同卡），仍不进固定抽检面（非核心主链路，改动时经自证通道入跑）
];

// ─────────────────────────── 跨域契约联动 ───────────────────────────

/** 计费面触发文件：任一变更 → 编排侧追加三支计费用例（产品侧走全量时无需追加，usage-cost 已在套件内） */
export const CONTRACT_ORCH_TRIGGERS = [
  'src/gateway/usage.ts',
  'src/gateway/server.ts',
  'src/gateway/state.ts',
  'src/providers/pricing-core.ts',
  '.agents/scripts/orchestrator/cost.mjs',
  '.agents/scripts/orchestrator/budget.mjs',
];

export const CONTRACT_ORCH_TESTS = [
  'test/orchestrator/tiers.test.ts',
  'test/orchestrator/reconcile.test.ts',
  'test/orchestrator/budget-billable.test.ts',
];

/** 产品侧定点联动：触发文件 → 追加的产品套件用例（files 模式） */
export const CONTRACT_PRODUCT_RULES = [
  { trigger: '.agents/conventions/ui-kit.md', tests: ['test/ui-lint.test.ts'] }, // UI 令牌规范是 ui-lint 门禁的事实源
  { trigger: '.agents/workflow.json', tests: ['test/pr-risk-tier.test.ts'] },    // pr-risk-tier 规则对齐 workflow.json corePaths/releasePaths
];

/**
 * 契约联动计算：返回 { orch, product, orchTriggers, productTriggers }，列表均已去重。
 * 与域归属无关（.md 纯文档场景下 product 契约同样生效）。
 */
export function contractExtras(files) {
  const list = dedup(files).map((f) => String(f).split('\\').join('/'));
  const orchTriggers = CONTRACT_ORCH_TRIGGERS.filter((t) => list.includes(t));
  const productTriggers = CONTRACT_PRODUCT_RULES.filter((r) => list.includes(r.trigger));
  const orch = orchTriggers.length ? [...CONTRACT_ORCH_TESTS] : [];
  const product = dedup(productTriggers.flatMap((r) => r.tests));
  return { orch, product, orchTriggers, productTriggers };
}

// ─────────────────────────── 路由计划（纯函数） ───────────────────────────

/** 产品侧契约定点动作（files 模式）：仅当产品域/双域文件为零、契约触发时入计划 */
function productFilesAction(contract) {
  return {
    kind: 'product-files',
    label: '产品定点用例（vitest files 模式）',
    reason: `契约联动：${contract.productTriggers.map((r) => r.trigger).join('、')} → ${contract.product.join('、')}`,
    files: contract.product,
  };
}

/**
 * 由变更文件构建路由计划。
 * @param {string[]} files 变更文件列表（git diff 口径）
 * @param {{ full?: boolean, conservative?: boolean }} opts
 *   full         — 强制双套件全量（npm test + npm run test:workflow）
 *   conservative — diff 不可得时保守按双域全跑（无视文件列表）
 * @returns 计划对象：{ mode, modeLabel, changed, docsOnly, actions }
 *   actions[].kind: 'npm-test' | 'orch-smoke' | 'orch-full' | 'docs-lint' | 'product-files'
 */
export function buildPlan(files, opts = {}) {
  const { full = false, conservative = false } = opts;
  const changed = classifyFiles(files);
  const contract = contractExtras(files);
  const docsOnly = !full && isDocsOnlySet(files);
  const actions = [];

  if (full) {
    actions.push({
      kind: 'npm-test',
      label: '产品全量（npm test）',
      reason: '--full 强制双套件全量',
      files: null,
    });
    actions.push({
      kind: 'orch-full',
      label: '编排全量（npm run test:workflow）',
      reason: '--full 强制双套件全量',
      files: null,
    });
    return { mode: 'full', modeLabel: '双套件全量（--full）', changed, docsOnly: false, actions };
  }

  const hasProduct = changed.product.length + changed.dual.length > 0;
  const hasOrch = changed.dockmaster.length + changed.dual.length > 0;
  const effHasProduct = conservative || hasProduct;
  const effHasOrch = conservative || hasOrch;

  if (docsOnly) {
    // 纯文档集（含 .agents/ 下的 .md）：不触发编排冒烟（纯文字改动不经编排器逻辑），
    // docs-lint 恒跑；产品侧契约（ui-kit.md → ui-lint）照常联动。
    actions.push({
      kind: 'docs-lint',
      label: 'docs-lint（test/docs-lint.test.ts）',
      reason: `纯文档变更：${changed.product.length + changed.dockmaster.length + changed.docs.length} 个 .md，不触双域名单`,
      files: ['test/docs-lint.test.ts'],
    });
    if (contract.product.length) {
      actions.push(productFilesAction(contract));
    }
    return {
      mode: 'docs',
      modeLabel: '纯文档：docs-lint' + (contract.product.length ? ' + 契约定点用例' : ''),
      changed,
      docsOnly,
      actions,
    };
  }

  // 产品侧：有产品域/双域文件 → 全量；否则契约触发 → files 模式定点跑
  if (effHasProduct) {
    actions.push({
      kind: 'npm-test',
      label: '产品全量（npm test）',
      reason: `触达产品域 ${changed.product.length} 个 + 双域 ${changed.dual.length} 个文件` +
        (conservative ? '（diff 不可得，保守全跑）' : '') +
        (contract.product.length ? `；契约追加 ${contract.product.join('、')} 已含在全量内` : ''),
      files: null,
    });
  } else if (contract.product.length) {
    actions.push(productFilesAction(contract));
  }

  // 编排侧：有编排域/双域文件 → 冒烟子集；仅契约触发 → 只跑契约用例
  if (effHasOrch || contract.orch.length) {
    const baseFiles = effHasOrch ? ORCH_SMOKE_FILES : [];
    // 直接改动的编排测试文件必须自证入跑（含硬排除名单内的——排除名单只约束固定抽检面
    // 的预算纪律，不豁免被改文件本身；改了测试却不跑该测试 = 门禁漏洞，2026-11-12 对账发现）
    const selfVerify = dedup(changed.dockmaster).filter((f) => f.startsWith('test/orchestrator/'));
    const smokeFiles = dedup([...baseFiles, ...selfVerify, ...contract.orch]);
    const contractAdded = contract.orch.filter((f) => !baseFiles.includes(f));
    const selfAdded = selfVerify.filter((f) => !baseFiles.includes(f));
    const who = conservative
      ? 'diff 不可得，保守全跑'
      : `触达编排域 ${changed.dockmaster.length} 个 + 双域 ${changed.dual.length} 个文件` +
        (changed.dockmaster.length + changed.dual.length === 0 ? '（仅契约联动触发）' : '');
    const contractNote = contractAdded.length
      ? `；契约联动追加 ${contractAdded.join('、')}${contract.orchTriggers.length ? `（触发：${contract.orchTriggers.join('、')}）` : ''}`
      : '';
    const selfNote = selfAdded.length ? `；改动测试自证 ${selfAdded.join('、')}` : '';
    actions.push({
      kind: 'orch-smoke',
      label: '编排冒烟子集（vitest · workflow 配置）',
      reason: who + contractNote + selfNote + '；全量由 CI workflow-suite 兜底',
      files: smokeFiles,
      baseCount: baseFiles.length,
      addedCount: smokeFiles.length - baseFiles.length,
    });
  }

  const kinds = actions.map((a) => a.kind);
  const productSide = kinds.includes('npm-test') || kinds.includes('product-files');
  const orchSide = kinds.includes('orch-smoke') || kinds.includes('orch-full');
  let mode;
  let modeLabel;
  if (productSide && orchSide) {
    mode = 'mixed';
    modeLabel = '混合域：产品全量 + 编排冒烟';
  } else if (kinds.includes('docs-lint')) {
    mode = 'docs';
    modeLabel = '纯文档：docs-lint' + (kinds.includes('product-files') ? ' + 契约定点用例' : '');
  } else if (kinds.includes('npm-test') || kinds.includes('product-files')) {
    mode = 'product';
    modeLabel = '产品域：产品全量';
  } else if (orchSide) {
    mode = 'orch';
    modeLabel = '编排域：编排冒烟子集';
  } else {
    mode = 'none';
    modeLabel = '无变更，无需验证';
  }
  return { mode, modeLabel, changed, docsOnly, actions };
}

// ─────────────────────────── 参数解析（纯函数） ───────────────────────────

export function parseArgs(argv) {
  const flags = { base: null, head: 'HEAD', staged: false, dry: false, full: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--base') {
      if (i + 1 >= argv.length) throw new Error('--base 需要一个 ref 参数（如 develop、某次提交），用法见 --help');
      flags.base = argv[++i];
    } else if (a.startsWith('--base=')) {
      flags.base = a.slice('--base='.length);
    } else if (a === '--head') {
      if (i + 1 >= argv.length) throw new Error('--head 需要一个 ref 参数，用法见 --help');
      flags.head = argv[++i];
    } else if (a.startsWith('--head=')) {
      flags.head = a.slice('--head='.length);
    } else if (a === '--staged') flags.staged = true;
    else if (a === '--dry') flags.dry = true;
    else if (a === '--full') flags.full = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else {
      throw new Error(`未知参数：${a}——支持 --base <ref>、--head <ref>、--staged、--dry、--full，用法见 --help`);
    }
  }
  if (flags.staged && flags.base) throw new Error('--staged 与 --base 互斥：暂存口径不需要基准 ref');
  return flags;
}

export const USAGE = `测试域路由器（AGENTS.md「测试指南」L2：finish 合并门禁的大脑）

用法：node scripts/test-gate.mjs [选项]
  （无参数）        自动口径：merge-base <baseBranch>..HEAD；HEAD 就在基准分支上时
                    改看暂存区，暂存区为空再用 HEAD~1（口径随输出说明）
  --base <ref>      用指定基准对比（diff = merge-base <ref>..HEAD）
  --head <ref>      区间终点（默认 HEAD）；历史归类抽验：--base A~1 --head A
  --staged          只看暂存区
  --dry             只打印路由计划不执行
  --full            强制双套件全量（npm test + npm run test:workflow）
  -h / --help       本帮助`;

// ─────────────────────────── diff 收集（副作用，仅 isMain 直跑用） ───────────────────────────

function gitOut(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: MAXBUF });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（退出码 ${r.status}）：${((r.stderr || '') + (r.stdout || '')).trim().slice(0, 300)}`);
  }
  return r.stdout || '';
}

function parseNames(zText) {
  return String(zText).split('\0').map((s) => s.trim()).filter(Boolean);
}

/** 读 .agents/workflow.json 的 baseBranch；读不到返回 null（调用方兜底 develop 并告警） */
function resolveBaseBranch() {
  try {
    const wf = JSON.parse(fs.readFileSync(path.join(ROOT, '.agents', 'workflow.json'), 'utf8'));
    if (typeof wf.baseBranch === 'string' && wf.baseBranch) return wf.baseBranch;
  } catch {
    /* 缺文件 / 解析失败 → 兜底 */
  }
  return null;
}

/**
 * 收集变更文件。口径：
 *   1) merge-base(base, head) ≠ head → diff merge-base..head（worktree finish 场景）
 *   2) merge-base == head（HEAD 就在基准上）→ 暂存区；暂存区空 → head~1..head
 * 返回 { files, source }；git 失败向上抛（调用方转保守双域）。
 */
function collectChangedFiles({ base, head = 'HEAD' }) {
  const mb = gitOut(['merge-base', base, head]).trim();
  if (!mb) throw new Error(`git merge-base ${base} ${head} 无结果`);
  const headSha = gitOut(['rev-parse', head]).trim();
  if (mb === headSha) {
    const staged = parseNames(gitOut(['diff', '--name-only', '-z', '--cached']));
    if (staged.length) return { files: staged, source: `暂存区（HEAD 就在 ${base} 上，无独立提交）` };
    return { files: parseNames(gitOut(['diff', '--name-only', '-z', `${head}~1`, head])), source: `${head}~1..${head}（HEAD 就在 ${base} 上且暂存区为空）` };
  }
  return { files: parseNames(gitOut(['diff', '--name-only', '-z', mb, head])), source: `merge-base ${base}..${head}` };
}

// ─────────────────────────── 执行（副作用） ───────────────────────────

/**
 * 定位 npm 的 JS 入口（npm-cli.js），避开 Windows .cmd 包装的 shell 依赖：
 *   win32 官方安装：<nodeDir>\node_modules\npm\bin\npm-cli.js
 *   unix（nvm/官方）：<nodeDir>/../lib/node_modules/npm/bin/npm-cli.js
 * 都找不到返回 null（调用方兜底 PATH 直 spawn）。
 */
function findNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 探测失败继续下一个 */
    }
  }
  return null;
}

function runNpm(npmArgs) {
  const cli = findNpmCli();
  if (cli) return spawnSync(process.execPath, [cli, ...npmArgs], { cwd: ROOT, stdio: 'inherit' });
  // 兜底：PATH 上的 npm。Windows 是 .cmd 包装必须 shell:true（release-check.mjs 同款先例）
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function runVitest(vitestArgs) {
  const entry = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  if (!fs.existsSync(entry)) {
    console.error(`✗ 未找到 vitest 入口：${entry}——在仓库根先 npm ci 装依赖再重跑`);
    return { status: 1 };
  }
  return spawnSync(process.execPath, [entry, ...vitestArgs], { cwd: ROOT, stdio: 'inherit' });
}

function missingFiles(files) {
  return files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
}

function execAction(action) {
  switch (action.kind) {
    case 'npm-test':
      console.log('  命令：npm test（tsc 测试门禁 + 产品套件全量，约 3-4 分钟）');
      return runNpm(['test']);
    case 'orch-full':
      console.log('  命令：npm run test:workflow（编排套件全量，约 2-4 分钟）');
      return runNpm(['run', 'test:workflow']);
    case 'orch-smoke':
      console.log(`  命令：node node_modules/vitest/vitest.mjs run -c vitest.workflow.config.ts（${action.files.length} 个文件，目标 ≤60s）`);
      return runVitest(['run', '-c', 'vitest.workflow.config.ts', ...action.files]);
    case 'docs-lint':
      console.log(`  命令：node node_modules/vitest/vitest.mjs run ${action.files.join(' ')}`);
      return runVitest(['run', ...action.files]);
    case 'product-files':
      console.log(`  命令：node node_modules/vitest/vitest.mjs run ${action.files.join(' ')}`);
      return runVitest(['run', ...action.files]);
    default:
      console.error(`✗ 未知动作类型：${action.kind}——scripts/test-gate.mjs 路由表与执行器不同步`);
      return { status: 1 };
  }
}

function runActions(actions) {
  const results = [];
  actions.forEach((a, i) => {
    console.log(`\n▶ [${i + 1}/${actions.length}] ${a.label}`);
    console.log(`  归域：${a.reason}`);
    if (a.files) {
      const missing = missingFiles(a.files);
      if (missing.length) {
        console.error(`✗ 文件不存在：${missing.join('、')}`);
        console.error('  若为冒烟子集成员（目录/文件更名），请同步更新 scripts/test-gate.mjs 的 ORCH_SMOKE_FILES');
        results.push({ ...a, ok: false, seconds: 0 });
        return;
      }
    }
    const t0 = Date.now();
    const r = execAction(a);
    const sec = (Date.now() - t0) / 1000;
    if (r.error) console.error(`  ✗ 子进程启动失败：${r.error.message}`);
    console.log(`  ${r.status === 0 ? '✓' : '✗'} ${a.label}——退出码 ${r.status ?? 'N/A'}（${sec.toFixed(1)}s）`);
    results.push({ ...a, ok: r.status === 0, seconds: sec });
  });
  return results;
}

function printPlan(plan, changed, warnings) {
  console.log('═══ 测试域路由（test-gate）═══');
  for (const w of warnings) console.log(`⚠ ${w}`);
  if (changed) {
    console.log(`变更口径：${changed.source}（${changed.files.length} 个文件）`);
    for (const f of changed.files) console.log(`  · ${f}`);
  } else {
    console.log('变更口径：diff 不可得——保守按双域全跑');
  }
  const c = plan.changed;
  console.log(
    `归类：产品域 ${c.product.length} · 编排域 ${c.dockmaster.length} · 双域 ${c.dual.length}` +
      (c.docs.length ? ` · 文档 ${c.docs.length}` : '') +
      (plan.docsOnly ? ' · 纯文档' : ''),
  );
  console.log(`路由：${plan.modeLabel}（${plan.actions.length} 段）`);
  plan.actions.forEach((a, i) => {
    console.log(`  ▶ [${i + 1}/${plan.actions.length}] ${a.label}`);
    console.log(`    归域：${a.reason}`);
    if (a.files && a.kind === 'orch-smoke') {
      console.log(`    文件：${a.files.length} 个（冒烟子集 ${a.baseCount}，契约追加 ${a.addedCount}）`);
    }
  });
}

function printSummary(results) {
  console.log('\n═══ 测试门禁汇总 ═══');
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.label}（${r.seconds.toFixed(1)}s）`);
  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    console.error(`✗ 门禁未过：${bad.map((b) => b.label).join('、')}——修复后重跑；单段日志见上方对应段输出`);
    return 1;
  }
  console.log('✓ 门禁通过：全部段绿');
  return 0;
}

function runMain() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  const warnings = [];
  const baseBranch = resolveBaseBranch();
  if (!baseBranch) warnings.push('未读到 .agents/workflow.json 的 baseBranch——按 develop 兜底');

  let changed = null;
  let conservative = false;
  try {
    if (flags.staged) {
      changed = { files: parseNames(gitOut(['diff', '--name-only', '-z', '--cached'])), source: '暂存区（--staged）' };
    } else {
      const base = flags.base || baseBranch || 'develop';
      changed = collectChangedFiles({ base, head: flags.head });
    }
  } catch (e) {
    conservative = true;
    warnings.push(`无法计算 diff（${String(e?.message || e).slice(0, 200)}）——保守按双域全跑；可显式传 --base <ref> 重试`);
  }

  const files = changed ? changed.files : [];
  const plan = buildPlan(files, { full: flags.full, conservative });
  printPlan(plan, changed, warnings);

  if (flags.dry) {
    console.log('\n（--dry：只打印路由计划，未执行）');
    return 0;
  }
  if (plan.mode === 'none') {
    console.log('\n变更集为空，无需验证。');
    return 0;
  }
  const results = runActions(plan.actions);
  return printSummary(results);
}

// isMain 守卫：双侧 realpath——符号链接入口（/var→/private/var 等）会让裸比较恒 false，
// CLI 被静默吞掉（spawn-shell.test.ts linked-worktree 用例实证，fab1180）
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = runMain();

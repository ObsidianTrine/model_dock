// drill.mjs — 弃船演习（SOLAS 演习条款的 Dockmaster 版，借鉴清单 B9）。
// 引擎预检只能证明 CLI 在场；闭环本身（worktree 创建 → 门禁 → 审查 → 闸门落位）
// 只有真跑才检验——环境漂移（node 版本、权限墙、脚本残缺）夜里才炸不如演习先炸。
// 设计：在临时港（mkdtemp 临时 git 仓 + 整目录拷贝 .agents/scripts + 最小 workflow.json）
// 用 mock 跑一张合成托运单走完全链，全部产物随临时港删除——不烧真钱、不碰真队列。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zcodeAvailable } from './backends/zcode-headless.mjs';
import { claudeAvailable } from './backends/claude-headless.mjs';

/** 临时 git 仓逐对象落盘可能在 rmSync 瞬间仍在写：ENOTEMPTY 退避重试（与 test/helpers 同策略）。 */
function rmRfRetry(p) {
  const backoffMs = [10, 50, 100, 250, 500, 1000];
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = e?.code ?? '';
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(code) || i >= backoffMs.length) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs[i]);
    }
  }
}

/**
 * 跑一次弃船演习。返回 { ok, checks }——checks 每项 { name, ok, detail }，调用方负责输出汇总。
 * 演习用 mock 后端（调用方守卫），env 原样透传给闭环子进程（测试靠 ORCH_MOCK_* 注入故障）。
 */
export function runDrill(repoRoot, { log = () => {} } = {}) {
  const orch = path.join(repoRoot, '.agents', 'scripts', 'orchestrator.mjs');
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail: String(detail).slice(0, 200) });
    log(`${ok ? '✓' : '✗'} ${name}${detail ? `——${String(detail).slice(0, 160)}` : ''}`);
    return ok;
  };

  // 1. 港口脚本完整（闭环子进程按 repoRoot/.agents/scripts 解析，缺文件会静默死循环——先验明正身）
  const scriptsOk = fs.existsSync(orch) && fs.existsSync(path.join(repoRoot, '.agents', 'workflows', 'feature-branch.md'));
  if (!check('港口脚本完整（orchestrator.mjs + feature-branch playbook）', scriptsOk)) return { ok: false, checks };

  // 2. 引擎在位（advisory：演习一律 mock，引擎缺席不阻断，但要让船长知道真实船队的状况）
  const zcode = zcodeAvailable();
  const claude = claudeAvailable();
  log(`ℹ 引擎在位：zcode ${zcode ? '✓' : '✗'} / claude ${claude ? '✓' : '✗'}（演习一律用 mock，不烧真钱）`);

  // 3. 临时港：整目录拷贝脚本 + 最小 workflow.json（对齐 test/orchestrator/helpers mkRepo 的夹具形态）
  const port = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-drill-'));
  try {
    const g = (args) => execFileSync('git', args.split(' '), { cwd: port, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    g('init');
    g('symbolic-ref HEAD refs/heads/develop');
    g('config user.email drill@local');
    g('config user.name drill');
    fs.mkdirSync(path.join(port, '.agents', 'workflows'), { recursive: true });
    fs.cpSync(path.join(repoRoot, '.agents', 'scripts'), path.join(port, '.agents', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(port, '.agents', 'workflow.json'), JSON.stringify({ baseBranch: 'develop', testCmd: 'node -e "process.exit(0)"' }));
    fs.writeFileSync(path.join(port, '.agents', 'workflows', 'feature-branch.md'), '# feature-branch（演习桩）\n\n演习占位 playbook。');
    fs.writeFileSync(path.join(port, 'AGENTS.md'), '# 演习仓 AGENTS\n\n最小约定：端口 8687/8890 红线。\n');
    fs.writeFileSync(path.join(port, 'package.json'), JSON.stringify({ name: 'drill-port', version: '0.0.0', scripts: { build: 'node -e "process.exit(0)"' } }));
    fs.writeFileSync(path.join(port, '.gitignore'), 'node_modules/\n.agents/worktrees/\n.agents/orchestrator/queue/\n.agents/orchestrator/logs/\n');
    g('add -A');
    g('commit -m init');
    check('临时港就绪（脚本整目录拷贝 + 最小 workflow.json + develop 初始提交）', true);

    // 4. 合成托运单提交
    const id = `drill-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6)}`;
    const cardFile = path.join(port, 'drill-card.md');
    fs.writeFileSync(
      cardFile,
      [
        '---',
        `id: ${id}`,
        'type: docs',
        'priority: normal',
        `created_at: ${new Date().toISOString()}`,
        'created_by: human',
        'files_hint:',
        '  - docs/**',
        'workflows:',
        '  - feature-branch',
        'gate: L3',
        '---',
        '',
        '# 目标',
        '弃船演习：验证港口闭环（worktree→门禁→审查→闸门落位）自身健康，本卡无真实改动价值。',
        '',
        '# 验收标准',
        '- 演习判定以编排闭环为准（卡按预期落 awaiting-human 即为通过）',
        '',
      ].join('\n'),
    );
    const submit = spawnSync(process.execPath, [orch, 'submit', cardFile], { cwd: port, encoding: 'utf8', timeout: 60_000 });
    if (!check('合成托运单提交', submit.status === 0, (submit.stderr || submit.stdout || '').trim().split('\n').pop())) {
      return { ok: false, checks };
    }

    // 5. mock 闭环全链（gate L3 预期终态 awaiting-human；env 透传供测试注入故障）
    const run = spawnSync(process.execPath, [orch, 'run', id, '--backend', 'mock'], {
      cwd: port,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ORCH_MOCK_FILE: 'docs/notes.md' },
    });
    const settled = ['awaiting-human', 'merged'].some((s) => fs.existsSync(path.join(port, '.agents', 'orchestrator', 'queue', s, `${id}.md`)));
    check('闭环全链（worker→门禁→审查→闸门落位）', run.status === 0 && settled, run.status === 0 ? `卡 ${id} 已落位` : `exit ${run.status}；尾部：${(run.stdout || run.stderr || '').trim().split('\n').slice(-2).join(' / ')}`);
    return { ok: checks.every((c) => c.ok), checks };
  } finally {
    try {
      rmRfRetry(port);
    } catch {
      /* 演习港清理失败不阻断判定（tmp 目录，系统会收） */
    }
  }
}

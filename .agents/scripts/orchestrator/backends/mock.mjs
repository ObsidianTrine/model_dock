// mock.mjs — 假后端：秒级、零外部调用、行为可由环境变量注入，专门服务
// orchestrator 自身的集成测试（docs 5.5）。不做任何真模型调用。
//
// 行为注入（集成测试在子进程里通过 env 控制）：
//   ORCH_MOCK_WORKER_STATUS=done|stuck   worker 结果块的状态（默认 done）
//   ORCH_MOCK_REVIEW_BLOCKERS=<n>        reviewer 输出的阻塞项数（默认 0）
// prompt 里含 "REVIEW_SUMMARY" 时按 reviewer 行为输出，否则按 worker 行为。

import fs from 'node:fs';
import path from 'node:path';
import { CARD_MARKER, RESULT_MARKER } from '../prompt.mjs';

export const mockBackend = {
  name: 'mock',
  async spawn({ promptFile, cwd, onEvent }) {
    // ORCH_MOCK_DELAY_MS：模拟慢 worker（并发调度测试观测"同时在跑"用）
    const delay = parseInt(process.env.ORCH_MOCK_DELAY_MS ?? '0', 10) || 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const prompt = fs.readFileSync(promptFile, 'utf8');
    const isReviewer = prompt.includes('REVIEW_SUMMARY');
    const isPlanner = prompt.includes(CARD_MARKER);
    onEvent({ type: 'worker_spawned', backend: 'mock', pid: process.pid });

    if (isPlanner) {
      // planner 模式：输出一张合法任务卡（契约块）；ORCH_MOCK_PLANNER_INVALID=1 模拟非法输出（校验重试路径测试）
      const invalid = process.env.ORCH_MOCK_PLANNER_INVALID === '1';
      const intentId = /用户意图：\s*(.+)$/m.exec(prompt)?.[1]?.trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'planner-mock-task';
      const output = invalid
        ? '我想了一下,这个任务大概需要改一些文件。没有产出任务卡。'
        : [
            `已探索仓库,意图编译为任务卡。`,
            '',
            '```' + CARD_MARKER,
            '---',
            `id: ${intentId || 'planner-mock-task'}`,
            'type: docs',
            'priority: normal',
            `created_at: ${new Date().toISOString()}`,
            'created_by: planner',
            'files_hint:',
            '  - docs/**',
            'workflows:',
            '  - feature-branch',
            'gate: L3',
            '---',
            '',
            '# 目标',
            'mock planner 目标:完成用户意图。',
            '',
            '# 验收标准',
            '- `npm test` 全绿',
            '- docs/ 下出现意图所述的新文档内容',
            '',
            '# 背景',
            'mock planner 探索结论占位。',
            '```',
          ].join('\n');
      onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-planner' });
      return { exitCode: 0, output, usage: { tokensIn: 300, tokensOut: 200 }, pid: process.pid };
    }

    if (isReviewer) {
      const blockers = parseInt(process.env.ORCH_MOCK_REVIEW_BLOCKERS ?? '0', 10) || 0;
      const output =
        blockers > 0
          ? `🔴 阻塞（1 个）\n- mock：验收标准第 ${blockers} 条未实现\nREVIEW_SUMMARY: blockers=${blockers} suggestions=0 notes=0`
          : `🟢 无阻塞\nREVIEW_SUMMARY: blockers=0 suggestions=1 notes=0\n- 🟡 建议：mock 建议项（不阻塞）`;
      onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-review' });
      return { exitCode: 0, output, usage: { tokensIn: 100, tokensOut: 50 }, pid: process.pid };
    }

    // worker 模式：模拟真实改动（写一个文件让 diff/门禁有内容可看）+ git 提交。
    // ORCH_MOCK_FILE 可指定改动文件路径（供分级裁决测试：docs/x.md → L0 等）；
    // 并发场景（有 ORCH_MOCK_DELAY_MS）按任务 id 推导独立文件，否则多任务共享 env 会写同一个文件
    const idMatch = /本次任务（([a-z0-9][a-z0-9-]*)，/.exec(prompt);
    const relFile = process.env.ORCH_MOCK_FILE ?? (delay > 0 && idMatch ? `docs/notes-${idMatch[1]}.md` : 'mock-worker-output.txt');
    const markerFile = path.join(cwd, relFile);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, `mock worker output @ ${new Date().toISOString()}\n`);
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.name=mock-worker', '-c', 'user.email=mock@local', 'commit', '-m', 'chore: mock worker change'], { cwd, stdio: 'ignore' });
    } catch {
      // 已提交过/无改动时忽略，测试只关心流程
    }
    onEvent({ type: 'worker_turn', turn: 1, tool: 'Write', file: relFile });

    const status = process.env.ORCH_MOCK_WORKER_STATUS === 'stuck' ? 'stuck' : 'done';
    const output = [
      'mock worker 完成。',
      '',
      '```' + RESULT_MARKER,
      `status: ${status}`,
      'summary: mock 后端固定输出',
      `files_changed: ["${relFile}"]`,
      `tests: ${status === 'done' ? 'pass' : 'fail'}`,
      'notes_updated: true',
      '```',
    ].join('\n');
    return { exitCode: 0, output, usage: { tokensIn: 4200, tokensOut: 1800 }, pid: process.pid };
  },
};

import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

// agent 工作流套件（test/orchestrator/**）：测 .agents/ 编排器脚本、分支守卫 hook、policy。
// 与产品套件（vitest.config.ts，include test/*.test.ts）拆分运行：`npm run test:workflow`。
// 对象 spread 覆盖 include（数组整体替换，不是 mergeConfig 的拼接）；防死锁面（isolate:false /
// watchdog）与产品套件单一事实来源，天然同构。
//
// 并行定档（2026-11-11，依据 docs/archive/test-orch-parallel-exp.md B3 实验）：编排套件用例互相
// 独立（各自临时 git 仓 + listen(0) 随机端口），多 worker 天然安全——本机两轮 maxWorkers:4
// 全绿（191.8s / 211.9s，对串行基线 528–536s 提速 2.5–2.8×，零超时、零跨文件干扰）。本机绿
// 不算定档：CI workflow-suite job 连续 3 天绿才维持定档，任一 flake 即回退（先降 2 复证，
// 仍不稳回 1）；`VITEST_MAX_WORKERS=1 npx vitest run -c vitest.workflow.config.ts` 一键回
// 串行基线，兜底成本一行。
//
// 宿主仓只读护栏（globalSetup 哨兵）经 base spread 从 vitest.config.ts 继承（isomorphism
// 门禁要求两 config test 段同构）——跑前快照锚定宿主仓、跑完对账、越界即红；
// 实现与红线背景见 test/orchestrator/host-guard.mjs 头注与 AGENTS.md「测试指南」。
//
// maxWorkers / testTimeout 允许与产品套件分域异构：
// - maxWorkers（此处 4 / 产品 1）：B3 实验的卡死风险面（policy.test.ts worker 生命周期，
//   2026-10-01 Linux CI 事故）只属于产品套件，编排套件无该前科且用例天然隔离。
// - testTimeout（此处 60s / 产品 20s，2026-11-23 定档）：编排用例多为 mock worker 的
//   run/drain 子进程链，合法耗时 15-25s，20s 上限负载下贴边成片假红（失败集合跨跑漂移、
//   零断言失败、孤跑单文件即绿）；60s 只拉长真挂死用例的败速，不影响绿速。产品套件
//   in-process 测试无此耗时形态，保持 20s 不动。
// 「两处必须同构」现指 isolate 与防死锁面（watchdog），超时与并行度按各域自身证据独立定档
// （门禁 test/config-isomorphism.test.ts 已同步剔除 maxWorkers / testTimeout）。
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/orchestrator/**/*.test.ts'],
    // 缺省并行 4；env 实验通道可覆盖（=1 回串行基线，=2 分级验证用）
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS || 4),
    // 60s / 产品 20s（分域异构豁免见 test/config-isomorphism.test.ts）：编排用例多为
    // mock worker 的 run/drain 子进程链，合法耗时 15-25s，20s 贴边负载下成片假红；
    // 上调只拉长真挂死用例的败速，不影响绿速。证据与理由详见头注。
    testTimeout: 60_000,
  },
})

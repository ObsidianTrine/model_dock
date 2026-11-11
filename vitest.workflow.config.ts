import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

// agent 工作流套件（test/orchestrator/**）：测 .agents/ 编排器脚本、分支守卫 hook、policy。
// 与产品套件（vitest.config.ts，include test/*.test.ts）拆分运行：`npm run test:workflow`。
// 对象 spread 覆盖 include（数组整体替换，不是 mergeConfig 的拼接）；防死锁面（isolate:false /
// watchdog / 超时）与产品套件单一事实来源，天然同构。
//
// 并行定档（2026-11-11，依据 docs/archive/test-orch-parallel-exp.md B3 实验）：编排套件用例互相
// 独立（各自临时 git 仓 + listen(0) 随机端口），多 worker 天然安全——本机两轮 maxWorkers:4
// 全绿（191.8s / 211.9s，对串行基线 528–536s 提速 2.5–2.8×，零超时、零跨文件干扰）。本机绿
// 不算定档：CI workflow-suite job 连续 3 天绿才维持定档，任一 flake 即回退（先降 2 复证，
// 仍不稳回 1）；`VITEST_MAX_WORKERS=1 npx vitest run -c vitest.workflow.config.ts` 一键回
// 串行基线，兜底成本一行。
//
// maxWorkers 允许与产品套件分域异构（此处 4 / 产品 1），理由：B3 实验的卡死风险面
// （policy.test.ts worker 生命周期，2026-10-01 Linux CI 事故）只属于产品套件，编排套件无该
// 前科且用例天然隔离。「两处必须同构」现指 isolate 与防死锁面（watchdog/超时），并行度按
// 各域自身证据独立定档（门禁 test/config-isomorphism.test.ts 已同步剔除 maxWorkers）。
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/orchestrator/**/*.test.ts'],
    // 缺省并行 4；env 实验通道可覆盖（=1 回串行基线，=2 分级验证用）
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS || 4),
  },
})

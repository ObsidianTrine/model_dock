---
id: workflow-parallel
type: refactor
created_at: 2026-11-04T02:10:00+08:00
created_by: agent-sail
files_hint:
  - vitest.workflow.config.ts
  - test/test-suite-couplings.test.ts
  - docs/test-orch-parallel-exp.md
workflows:
  - feature-branch
gate: L1
---

# 目标
落地工作流套件（test/orchestrator/**）并行化：B3 实验（docs/test-orch-parallel-exp.md，2026-11-04 夜航）实测 maxWorkers:4 两点复证 190.8s / 211.9s（串行基线 528s，**2.5–2.8× 提速**），764/764 全绿、零超时零 cross-file 干扰。本卡把配置正式并入并完成 CI 灰度验证。**前置必读：实验报告全文**——串行池是 2026-10-01 CI 卡死事故的结构性防线，本卡只解冻 workflow 套件（用例互相独立：各自临时 git 仓 + listen(0) 随机端口），产品套件串行不动。

# 验收标准
- vitest.workflow.config.ts 加 `isolate: false, maxWorkers: 4`（产品 vitest.config.ts 不动）；test-suite-couplings 同构断言如涉池设置差异，带理由放行 workflow 侧。
- 本机全量绿；PR（CI 三平台）全绿；merge 后 develop push 触发的 workflow-suite job（paths-filter 命中 test/orchestrator 变更时）连续 3 天绿再视为定档，任一 flake 回退串行（兜底 = 删一行）。
- 实验报告补「落地结果」小节（merge hash + CI 观察结论）。

# 航次计划
1. 配置 + 同构断言核对 → 本机全量。
2. PR 走 CI 三平台 → 绿后合并。
3. 观察期 3 天（schedule 每日巡检也算数）→ 报告补账。
- 备选路线：CI 出现 worker 生命周期异常（对照 2026-10-01 事故面）→ 立即回退串行并把现象补进实验报告风险节。

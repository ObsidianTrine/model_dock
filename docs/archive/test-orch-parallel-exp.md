# 工作流套件并行化实验报告（B3 · test-orch-parallel-exp）

> 预研报告 docs/archive/test-orch-inproc-presearch.md §六 B3 的实验落地：工作流套件（test/orchestrator/**）从
> 串行池（isolate:false + maxWorkers:1）改多 worker 并行的可行性实测。**本卡只交证据，不并配置**——
> 串行池是 2026-10-01 CI 卡死事故的结构性防线（产品套件 policy.test.ts worker 生命周期），解冻需 CI 复证。
> 实验日期：2026-11-04 夜航。机器：mac darwin 22.1.0 x64，8C/8G。

## 实验设置
- vitest.workflow.config.ts 临时加 `isolate: false, maxWorkers: 4`（其余同构设置不动；实验后还原，不随卡合并）。
- 基线：串行 761–764 用例 / 528–536s（同夜三次实测）。

## 结果

| 跑次 | 配置 | 总耗时 | 结果 | 备注 |
|---|---|---|---|---|
| 基线 ×3（同夜） | 串行 maxWorkers:1 | 528–536s | 全绿 | test-sail-slim 卡前 578s → 秒级时长卡后 528–536s |
| 并行 #1 | isolate:false + maxWorkers:4 | **190.8s** | **764/764 全绿** | CPU 348%（8 核）；零超时、零重试、零文件红 |
| 并行 #2 | 同上（名义） | 528.0s | 764/764 全绿 | **无效样本**：后台 shell cwd 被复位到主仓，`-c` 实际收集到主仓**串行**配置（耗时与串行基线完全一致即佐证）——非并行不稳，是操作坑（同 vitest 收集面跟 cwd，见 test-sail-slim NOTES） |
| 并行 #3 | 同上（显式 cd） | **211.9s** | **764/764 全绿** | CPU 317%；两点复证 190.8s / 211.9s，提速 **2.5–2.8×** |

- 提速 **2.5–2.8×**（528→191–212s），8 核机 CPU 利用率 ~3.2–3.5 worker。
- 无一用例触 20s testTimeout（并行争用下最慢用例 14s，sail 报告通知类）；零 cross-file 干扰——workflow 套件用例互相独立（各自临时 git 仓 + listen(0) 随机端口），多 worker 天然安全。

## 结论与建议

**并行可行，建议日间立卡实施**（配置一行 `isolate: false` 保持 + `maxWorkers: 4`；先 CI 灰度再定档）。本机两轮全绿 + 零超时；剩余风险在 CI 三平台（Linux CI 的 fork 进程行为与内存）——这正是串行防线当年的事故面，故仍按「实验证据 → CI 复证 → 定档」三步走，不建议直接并配置。

## 若船东批准并行的实施要点（供日间卡）
- vitest.workflow.config.ts 加 `maxWorkers: N`（先 2 后 4 分级验证），产品套件**不动**（其串行有顺序耦合对与卡死前科）。
- 同构断言：test/test-suite-couplings.test.ts 若对两 config 的池设置做同构断言，需同步放行 workflow 侧差异（带理由）。
- CI：workflow-suite job 真 run 时才付多 worker 成本；先 PR 灰度（mac 腿已退出 develop push，PR 与 push main 才跑）。
- 回归哨：连续 3 天 CI 绿再定档；任一 flake 即回退串行（兜底成本 = 改一行）。

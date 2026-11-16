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

## 落地结果（2026-11-16 对账：维持并行 4）

配置已于 2026-11-11 并入 develop（**acd718c**，`maxWorkers: Number(process.env.VITEST_MAX_WORKERS || 4)`，env 回退通道保留；test/config-isomorphism.test.ts 同步剔除 maxWorkers 异构断言）。CI 灰度观察窗 2026-11-12 ~ 11-16，按收尾口径对账（paths-filter 占位绿不计入、真跑计入）：

| 日期 | run id | workflow-suite 结论 |
|---|---|---|
| 11-13 | 43334671679 | 真跑绿 |
| 11-15 | 43715816141 | 真跑绿（整 run failure 为产品域 win 用例红，本 job 自身绿） |
| 11-15 | 43717205581 / 43720948281 / 43723148184 / 43727427518 | 真跑绿（同日五连 push） |
| 11-15 | 43726481212 / 43726805222 / 43726940153 / 43727103418 | 真跑被连推取消（非测试红，不计入样本） |
| 11-16 | 43897533479 | 真跑红 3 例（见下，已归因修复） |

- schedule 巡检 4 次（43325894605 / 43524857483 / 43645190524 / 43769056800）paths-filter 全判占位绿，不计入样本；11-14 无触达 .agents/** 的 develop push，当日无真跑。
- **11-16 红归因：内容缺陷，非并行 flake**。3 例全为 research.test.ts 共享夹具 CLAIM_BODY 写死引用日期 2026-11-08，撞 validateBriefBody 的 7 天陈旧窗（第 8 天必爆的定时炸弹——BRIEF_BODY 早已随 TODAY 动态生成，此夹具漏改）。本机 `VITEST_MAX_WORKERS=1` 串行复现同 3 红同错误，实证与 worker 数无关；修复 36c0b57（夹具改 TODAY 动态生成 + 引用日期泄漏断言同步），research 域 10 文件组合 119 用例并行 4 全绿。
- **定档：维持并行 4**。「任一 flake 即回退」针对并行诱发的不稳定——观察窗 7 次真跑中并行诱发失败 0（11-13、11-15 两天 6 次绿 + 11-16 红经串行复现排除并行嫌疑），回退触发条件未出现；`VITEST_MAX_WORKERS=1` 一键回串行通道原样保留。修复并入后的首个 develop push run 复绿为字面「连续 3 天绿」的复核格（11-13/11-15 已两格）。

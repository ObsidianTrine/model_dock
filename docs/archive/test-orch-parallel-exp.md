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

## 落地结果（2026-11-17 查证）

- **配置合入**：@acd718c（2026-11-11 23:59 +0800，"test(orch): 编排套件并行定档 maxWorkers 4（B3 证据+env 回退通道）+ mkRepo scripts 模板缓存"）——`vitest.workflow.config.ts` 缺省 `maxWorkers: 4` + `VITEST_MAX_WORKERS` env 覆盖通道（=1 回串行 / =2 分级复证）；test-suite-couplings 同构断言同步剔除 maxWorkers（允许两 config 按域异构）。
- **观察窗触发面（2026-11-17 复核修正）**：真窗口起点是 **f9395b1**（2026-11-12 00:03，合入 acd718c 后首个触达提交）——起点之前的 push 其 CI run 跑的是串行旧配置，不构成本配置的观察证据。acd718c..develop 间触达 `.agents/**` 或 `test/orchestrator/**` 的提交共 **27 个**，其中 **22 个已推送 origin/develop**（末次远端同步 50bd710，2026-11-16 23:30；另 5 个仅本地未推送，无 CI run）。注意提交数 ≠ push 事件数 ≠ run 数——逐条 run id / 平台腿 / conclusion 的唯一来源是 `gh run list --workflow=test.yml`，本地计数只界定观察窗范围，替代不了 run 级证据。
- **查证受阻（已解除）**：run 级 conclusion 核验所需的外部通道在 worker 环境全部不可达——2026-11-17 三个查证会话 `gh run list` 累计 4 次被权限拒绝（熔断纪律，未换写法绕行），curl 直连 GitHub API、WebFetch、playwright MCP、`git fetch` 亦各被拒；同日**调度台以自有 gh 凭证取到 run 级数据**（见下条），核验不再阻塞。
- **run 级核验（2026-11-17 调度台 gh 实查，`gh run list --workflow test.yml --branch develop` 逐 run 查 test-workflow job）**：观察窗（f9395b1 起）内 test-workflow job 实跑共 **8 个 run**——**2026-11-13 至 11-15 全绿**（按 test-workflow job 结论计 6 success + 1 cancelled：cancelled 系后继 push 顶替、非测试红；43715816141 整 run failure 系产品腿红，test-workflow job 本身 success，与本卡无关），**2026-11-16 红**（43897533479，15:33 UTC，workflow-run 与 test-workflow job 双 failure）。逐 run 记录：

  | run | 时间(UTC) | workflow-run 结论 | test-workflow job |
  |---|---|---|---|
  | 43334671679 | 2026-11-13 00:08 | success | success |
  | 43715816141 | 2026-11-15 12:49 | failure（产品腿红，与本卡无关） | success |
  | 43717205581 | 2026-11-15 13:05 | success | success |
  | 43720948281 | 2026-11-15 13:48 | success | success |
  | 43723148184 | 2026-11-15 14:13 | success | success |
  | 43726481212 | 2026-11-15 14:49 | cancelled（后继 push 顶替） | cancelled |
  | 43727427518 | 2026-11-15 15:00 | success | success |
  | 43897533479 | 2026-11-16 15:33 | failure | failure |

- **11-16 红定性**：test/orchestrator/research.test.ts 夹具引用日期硬编码 2026-11-08、跨过 validateBriefBody 7 天容忍窗的**时间炸弹**——与 B3 并行化无关（非 flake / worker 生命周期异常，不触发回退兜底）；修复 baa55d9 已合本地 develop（2026-11-17），待 push 后 CI 转绿。
- **定档判定（2026-11-17 run 级核验完成）**：按既定口径回溯 f9395b1 起全部真 run（上表）——窗内实跑 11-13 与 11-15 全绿（11-14 无实跑记录），11-16 断档红，**「连续 3 天绿」未成立**；断档因无关域测试腐化（时间炸弹，已修 baa55d9），**顺延决策维持**（维持 4 与回退 1 的决策继续暂缓），**新观察窗自修复 push 落 origin 之日起算**（原「已流逝天数不清零」口径经调度台判定据此更新）。回退兜底不变：任一真 run 出现 flake / worker 生命周期异常 → 改缺省 `maxWorkers: 1`（或先降 2 复证），异常现象回写本报告风险面（本机 B3 证据面：零超时、零跨文件干扰，异常面预期仍限于 Linux CI fork 行为）。

## 结论与建议

**并行可行，建议日间立卡实施**（配置一行 `isolate: false` 保持 + `maxWorkers: 4`；先 CI 灰度再定档）。本机两轮全绿 + 零超时；剩余风险在 CI 三平台（Linux CI 的 fork 进程行为与内存）——这正是串行防线当年的事故面，故仍按「实验证据 → CI 复证 → 定档」三步走，不建议直接并配置。

> 状态更新（2026-11-17）：配置已合入（acd718c）并进入 CI 复证观察，run 级核验已由调度台完成（结论见上方「落地结果」节：连续 3 天绿未成立、顺延维持、新窗自修复 push 起算）——当前状态以上方「落地结果」节为准，本节为实验当时的建议原文。

## 若船东批准并行的实施要点（供日间卡）
- vitest.workflow.config.ts 加 `maxWorkers: N`（先 2 后 4 分级验证），产品套件**不动**（其串行有顺序耦合对与卡死前科）。
- 同构断言：test/test-suite-couplings.test.ts 若对两 config 的池设置做同构断言，需同步放行 workflow 侧差异（带理由）。
- CI：workflow-suite job 真 run 时才付多 worker 成本；先 PR 灰度（mac 腿已退出 develop push，PR 与 push main 才跑）。
- 回归哨：连续 3 天 CI 绿再定档；任一 flake 即回退串行（兜底成本 = 改一行）。

# 效能优化任务交接清单（2026-10-29）

> 来源：2026-10-29 四分区只读效能审查（.agents 工作流工具链 / CI 与构建脚本 / 测试基建 / src 结构与可维护性），关键结论经人工到源码复核（含 spot-check）。
> 边界声明：**全部为优化 / 重构 / 测试 / CI 类任务，不新增产品功能**；不复报 docs/known-issues.md 既有条目（PERF/XPLAT/CORRECT/REVIEW 系列），与 docs/backlog.md、docs/maintenance-handoff.md（T1–T12，已全部闭环）零重叠。
> 用法：与 maintenance-handoff 同款——13 张卡已抽为独立文件 `docs/task-cards/T13-*.md` ~ `T25-*.md`，orchestrator 派发直接 `node .agents/scripts/orchestrator.mjs submit docs/task-cards/T<NN>-<id>.md`，交互 agent 派发直接把卡文件交给它。修改任务内容以卡文件为准并回同步本页总览。
> 注意：文中行号基于审查当日代码（develop @d8d6d3d），**动手前先读对应源码确认仍成立**（known-issues.md 同款纪律）。

## 0. 全局纪律（所有任务通用，执行 agent 必读）

- **工作流**：一律 `node .agents/scripts/feature-branch.mjs start <task-id>`（task-id 即卡上的 id），编辑/提交/测试全在 worktree 内；完成后 `finish`（rebase → 全量测试 → --no-ff 合并）。
- **测试**：改完 `src/**` 或 `test/**` 必须 `npm test` 全绿；**改 `.agents/**` 的卡必须另跑 `npm run test:workflow` 全绿**（该套件测的就是这套工具链）。涉及路径/文件/进程/shell 的改动过一遍 AGENTS.md「工程硬性约定」三平台清单，diff 里显式复查 Windows 分支。
- **端口红线**：8687（生产）任何形式的访问/测试/改动一律禁止；8890（用户 dev 沙箱）不得占用；手测一律 `MODELRDOCK_FAKE_HOME=<独立目录> npx tsx src/cli.ts gateway start --port 189xx` 成对指定；结束清理自拉进程并核实端口释放（AGENTS.md 硬规则 4）。
- **vitest 隔离模型**：isolate:false 单 fork；同一模块禁止被两个测试文件 vi.mock；禁用 vi.clearAllMocks 做跨用例清场（AGENTS.md「跨文件 mock 是雷区」节）。**新写的测试文件先 grep 它要 import 的模块是否已被别的文件 mock**。
- **行为零变化**：带「文案逐字节不变 / HTML 字节不变 / handler 逐字搬移」要求的卡，用对拍（改前改后输出比较）验证，不靠肉眼。
- **CI yml 改动的验证边界**：workflow 文件无法在本机端到端验证，交付说明必须写清推演的场景与残余风险；yml 语法用 actionlint 或仔细核对 expression。
- **中断交接**：未完成的任务在 worktree 的 `NOTES.md` 留交接（目标/已完成/剩余步骤/如何验证）。

## 1. 任务总览与批次

| # | id | 任务 | 类型 | 规模 | 批次 |
|---|---|---|---|---|---|
| T13 | merge-verify-once | orchestrator 自动合并去双跑 + finish 锁有界等待 | refactor | 中 | 一（串行） |
| T14 | agents-crossplatform-spawn | .agents 四处 Windows 必挂点修复 | bugfix | 小 | 一（串行，T13 后） |
| T15 | agents-hygiene-batch | 编排器与 hook 六项卫生批 | refactor | 小 | 一（串行，T14 后） |
| T16 | release-test-dedup | release 五腿去重复测试 + node 二进制缓存 | refactor | 小 | 二（可并行） |
| T17 | sea-icon-and-dup | SDF 图标渲染降本 + 托盘/ico 去重 | refactor | 小 | 二（可并行） |
| T18 | dependabot-preflight | dependabot-fix 装/构建移出 Claude 会话 | refactor | 微 | 二（可并行）✅ 已合并 |
| T19 | ci-micro-opts | CI 与生成脚本六项微优化批 | refactor | 小 | 二（可并行） |
| T20 | test-sync-fixes-helpers | 同步域测试修复 + helper 四类收敛 | refactor | 中 | 三（串行，先做） |
| T21 | test-infra-guards | vitest 同构门禁 + mock 工厂 + 耦合留痕 | refactor | 小 | 三（串行，T20 后） |
| T22 | split-lan-mobile-page | lan.ts 手机页模板抽纯模块 | refactor | 小 | 四（可并行） |
| T23 | split-state-ts | state.ts 按域拆分（21 importer） | refactor | 大 | 四（可并行） |
| T24 | split-ops-ts | ops.ts 按域拆分 | refactor | 大 | 四（可并行） |
| T25 | adapters-dedup-batch | adapters 重复簇收敛 + 卫生项 | refactor | 小 | 四（可并行） |

**批次与文件域分区（多 agent 并行时按此派发，避免互撞）：**

- **批次一（编排器域，必须串行 T13 → T14 → T15）**：三张卡都动 `.agents/scripts/orchestrator.mjs` 与/或 `feature-branch.mjs`，并行必冲突。T13 收益最大（自动合并吞吐瓶颈），优先做。
- **批次二（CI/构建域，四卡文件互斥可并行）**：T16 只动 release.yml；T17 只动 build-sea.mjs；T18 只动 dependabot-fix.yml；T19 动 test.yml / claude-review.yml / pr-risk-tier / gen-ui-min / update.test.ts。与批次一、三、四零文件交集。
- **批次三（测试域，串行 T20 → T21）**：T20 建 helpers.waitFor 等，T21 的 syncpull 改造要用；且两卡都动 syncpull.test.ts。T20 的 helper 收敛触达 13 个测试文件，动面前先 grep 确认没有别的文件 vi.mock 它们 import 的模块。
- **批次四（src 结构域，四卡文件互斥可并行）**：T22 lan.ts / T23 state.ts / T24 ops.ts / T25 adapters+paths+sync-engine。T23、T24 建议排最后或单独做（体量大、importer 多，合并窗口要干净）。

> **2026-10-30 收口盘点**：T13（68dbef9）/ T14（bf937bd）/ T16（9b1a891）/ T17（9ccf9b8）/ T18（dependabot-preflight，2026-10-30 晚收尾合并）/ T19（f66edeb）/ T20（939ee25）/ T22（07562d5）/ T23（25b42a2）/ T24（cc5fe52）已合并 develop（对应卡文件正文已加 ✅ 状态行）；剩余 **T15（其他 agent 开工中）、T21、T25**（T21 前置 T20 已解除，T15/T21 预研已定稿）。缺陷卡 T26（CORRECT-07）已修（6129ac0），T27/T28 未派发。

## 2. 明确不立项（维持现状，勿翻案）

| 项 | 不做理由 |
|---|---|
| vitest「双池并行」实验（无 mock 池多 worker） | maintenance-handoff 不做清单已暂缓 isolate 改造；本方案虽不改隔离语义，但死锁史是 worker 消息路由问题、去 mock 不消除。重启条件：全量 137s 成为实际痛点时，先 CI canary + watchdog 保险丝再试 |
| daemon-lifecycle 子进程常驻复用 | 生命周期用例独立性下降，改造风险 > 收益（tsx 冷启 1-2s/次可接受） |
| PERF-15 / 21 / 23 / 36 | known-issues §一.F 复核后暂缓，理由成立 |
| backlog B1 / B3 / C4 | 已评估放弃（2026-10-25），重启条件已写明 |
| XPLAT-09 / XPLAT-11、REVIEW-26 | 设计取舍留档 / 既定语义 |
| feature-branch 与 kill-tree/workflow-config 的 pidAlive、resolveCmds 逐字重复 | feature-branch 零内部依赖是刻意的可移植设计（cp -r .agents 整目录移植），去重得不偿失 |
| ci-retry 对确定性失败的重试 | 收益极小，判断逻辑复杂化不划算 |
| worktree node_modules 硬链接共享 / 换 pnpm | npm 全局缓存已共享网络层，单 worktree 成本 4s/118MB 可接受；换包管理器影响面大 |
| noUncheckedIndexedAccess | 数百处大扫除，与行为保守原则冲突 |
| config/ 载入时深校验补全 | 会拒绝现在被接受的手编 TOML，违反行为保守原则 |
| secrets.ts 拆 secrets-backends.ts、autostart 拆 autostart/ | 收益中下，域内聚尚可，等继续增长再说 |

## 3. 约定沉淀（不立卡，但所有后续任务遵守）

- **server.ts 防回吐**：T05 拆分后 server.ts 已从 1950 行回涨到 2096（36 个 h* handler）。新增 admin 端点一律落既有域模块（或经 T05 建立的分组方式新增），不再往 server.ts 主文件堆。
- **known-issues 纪律延续**：本轮若修出 known-issues 收录条目的新信息（如顺带证实/证伪某暂缓项），回到该条目注记，不删条目。
- **口径数字不写死**：测试数、耗时、体积类数字写「以 npm test 输出为准」或标注「快照@commit」（T11 治理约定的延续）。

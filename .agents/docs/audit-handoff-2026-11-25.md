# 健康审计修复工单（2026-11-25）

> **给执行 agent 的可执行工单。** 来源：2026-11-25 对 ModelDock 全仓 + Dockmaster 编排体系的只读审计。
> **基线**：develop @ `e6f10bd`。行号以该提交为准；这些文件改动频繁，**定位以符号名为准，行号只作起点**。
> **证据等级**：所有缺陷都是「读码确认」——已对照源码核实交错路径，但**均未做运行时复现**。

---

## 0. 执行前必读

### 0.1 每张工单的固定流程

1. **先读项目规则**：仓库根 `AGENTS.md`（端口红线、三平台、i18n、写盘、测试域分层）。动手前再看 `.agents/workflows/feature-branch.md`。
2. **开分支**：`node .agents/scripts/feature-branch.mjs start <task-id>`（task-id 见各工单）。所有编辑用 **worktree 下的绝对路径**，不改主目录。
3. **先写一个能复现问题的失败用例**（先红）。**红不了就停**：说明前提不成立，在汇报里写明现象，不要硬改。
4. **修复**，让用例变绿，并跑该工单列出的相关测试。
5. **文档同步**：工单里列了「文档同步」的必须做；CHANGELOG 规则见 0.3。
6. **提交并合并**：`git -C .agents/worktrees/<task-id> add -A && git -C ... commit`，回主仓库目录后 `node .agents/scripts/feature-branch.mjs finish <task-id>`。
7. 未完成必须交接：worktree 根 `NOTES.md` 写全「已完成 / 剩余 / 如何验证 / 已知坑」。

### 0.2 红线（违反即返工）

- **8687 是生产实例、8890 是用户 dev 沙箱：任何测试、访问、改动都不许碰。** 手测只用 `MODELRDOCK_FAKE_HOME=<独立目录> MODELRDOCK_TEST=1 npx tsx src/cli.ts gateway start --port 189xx`；单测一律 `listen(0)`。
- 禁止在 develop/main 上直接改代码文件（hook 会拦）。
- 不把工单卡放进 `.agents/orchestrator/queue/pending/`——autopilot 开着，放进去就会被自动调度。只有用户明确要求才放。
- **编排套件**（`vitest.workflow.config.ts`）不要在与队列卡同名的 linked worktree 里跑全量；套件运行窗口内不要并发 `finish`（会把 worktree 连根删掉，见 AGENTS.md「编排套件宿主仓红线」）。
- 路径用 `path.join()`；写盘走 `atomicWrite()`；用户可见文案走 `t(中文, English)`；不用 `import.meta.url`；不加 native 依赖。
- 测试三大 OS 都要能过：不写死 `/tmp` 或盘符，权限断言按 `process.platform` 分支。
- 测试收尾：`await stopSyncEngine()` 再恢复 env；清掉自己拉起的全部进程与临时目录。

### 0.3 测试与 CHANGELOG 口径

| 域 | 改动面 | 按域跑（L1） |
|---|---|---|
| Dockmaster | `.agents/scripts/**`、`test/orchestrator/**` | `npx vitest run -c vitest.workflow.config.ts test/orchestrator/<文件>.test.ts` |
| ModelDock | `src/**`、`test/*.test.ts` | `npx vitest run test/<文件>.test.ts` |
| 纯文档 | `*.md` | `npx vitest run test/docs-lint.test.ts` |

- `vitest` 是 `isolate: false`：同一模块不要被两个测试文件 `vi.mock`；不要用 `vi.clearAllMocks()` 清场。
- CHANGELOG：**用户可感知**的修复在 `CHANGELOG.md` 与 `docs/en/CHANGELOG.md` 的 `[未发布]` 段各补一条（粗体点题、用户视角）。Dockmaster 内部改动不进 CHANGELOG。改前读 `.agents/conventions/docs-writing.md`。
- 涉及 `.agents/workflows/*.md` 描述的行为，改完同步对应 runbook，并在汇报里列出改了哪几行。

### 0.4 汇报格式（每张工单一条）

```
工单编号 | commit | 状态（完成 / 部分完成 / 前提不成立）
改了什么：文件 + 一句话
复现用例：<测试文件> <用例名>（修前红 / 修后绿）
跑了哪些测试及结果：
与工单建议的偏离及原因：
遗留风险：
```

### 0.5 「修法」的效力

「修法」是**建议方向**，验收标准才是硬约束。你可以换实现，但必须在汇报里说明理由，且满足全部验收条目。

---

## 1. 任务总览

状态：⬜ 未开始 / 🔧 进行中 / ✅ 已合并。**执行记录（2026-11-25 夜）见本节末尾。**

| 编号 | 任务 | 域 | 主要改动面 | 规模 | 前置 | 状态 |
|---|---|---|---|---|---|---|
| DM-01 | 人工批示与自动合并互不加锁 | Dockmaster | `orchestrator.mjs` | S | — | ✅ `cf22b1d` |
| DM-02 | 人工认领的卡被当孤儿自动续跑 | Dockmaster | `autoresume.mjs`、`orchestrator.mjs` | S | 建议在 DM-01 后 | ✅ `ad3b6b0` |
| DM-03 | 看门狗熔断停机标志置位过晚 | Dockmaster | `orchestrator.mjs` | S | 建议在 DM-02 后 | ✅ `9dc2cc7` |
| DM-04 | finish 撞窗等待冻结心跳，活锁被接管 | Dockmaster | `feature-branch.mjs` | S | 可与 DM-01~03 并行 | ✅ `e3250ba` |
| P-01 | 密钥写失败后内存缓存被污染 | ModelDock | `config/secrets.ts` | S | — | ✅ `fed0dc7` |
| P-02 | 锁等待超时短于陈锁判定 | ModelDock | `util/fsx.ts` | S | — | ✅ `ef87d8a` |
| P-03 | 上游错误体解压无输出上限 | ModelDock | `gateway/relay.ts` | S | — | ✅ `130d060` |
| P-04 | 用内存态配置回写磁盘，覆盖并发改动 | ModelDock | `ops/routing.ts`、`gateway/server.ts`、`gateway/lan.ts` | S–M | — | ✅ `0eb7225` |
| P-05 | `remountSyncEngine` 无互斥 | ModelDock | `sync/engine.ts` | S | — | ✅ `22d9bbc` |
| P-06 | 单实例检查先查后写；无响应被当成未运行 | ModelDock | `gateway/main.ts`、`shared.ts`、`cli/gatewaycmd.ts` | M | — | ✅ `23903f9`（仅 (a) 三态判活） |
| E-01 | 类型检查与 lint 覆盖面 | 工程 | `tsconfig*.json`、`eslint.config.mjs` | M | ~~需用户确认~~ 已授权 | ✅ `2edeb22`/`3bc6395`/`50cffda`（三张子卡全做，exclude 清零，agents 基线 1112） |
| E-02 | CI 补廉价门禁 | 工程 | `.github/workflows/test.yml` | S | ~~需用户确认~~ 已授权 | ✅ `8bc1ea6`（format 先告警态：全仓 529 文件未过 prettier，转正需单独跑 `npm run format`） |
| E-03 | LAN 威胁模型与用户提示 | 文档 | `docs/design/hld.md`、guide、`docs/en` | S | — | ✅ `64709ad` |
| E-04 | 修正已确认的文档漂移 | 文档 | `AGENTS.md` 等 | S | — | ✅ `b5cb441`（两处注释计数遗留随 E-01 清掉） |
| E-05 | 防夹具日期炸弹 | 工程 | `test/**` | S | — | ✅ `6a11727` |
| S-01 | 拆 `src/gateway/server.ts` | ModelDock | `src/gateway/` | L | P0 合并后 | ✅ `c80fa4d`（3184 → 57 行，11 模块，纯搬移复核 95.3% 逐字 + 28 引用方 502/502） |
| S-02 | 拆 `.agents/scripts/orchestrator.mjs` | Dockmaster | `orchestrator/` | L | P0 合并后 | ✅ `d7c08ad`（6380 → 5687 行，四簇纯搬移） |
| S-03 | Web UI 真 TS 通道 | ModelDock | `src/gateway/ui/ts/**` | XL（只做增量） | P0 合并后 | ✅ `bb44255`（通道落地 + UI_JS_USAGE 迁出，存量迁移待续） |
| S-04 | 其他大文件（可选） | 两者 | relay/diag/secrets | M | — | ⬜（可选，未开工） |
| D-01 | 主干门禁策略 | — | — | — | 用户拍板 | ✅ 决策：选项 B（ai-review-system.md 已如实记载「保护不拦直推」；若未来要求强制 PR 再评估 A） |
| D-02 | 发布物签名 | 工程 | `release.yml` | S | — | ✅ `2a954a3`（artifact attestation；证书/公证仍留用户） |
| D-03 | bench 脚本去留 | 工程 | `bench.yml`、docs | S | — | ✅ `aaead38`（每周 schedule 信息性产物，不设门禁） |
| D-04 | isolate 金丝雀 | 工程 | vitest.config、CI | S | — | ✅ `5d7674e`（env 通道 + schedule 金丝雀，默认值不变） |
| D-05 | Actions 钉 SHA、.nvmrc | 工程 | workflows、`.nvmrc` | S | — | ✅ `2bc4edf`（39 处 uses 全钉 SHA + 版本注释） |
| D-06 | 根目录 `HKCU/` 空目录 | — | — | — | 删除需确认 | ✅ 已授权清理（6 层空目录删除 + `.gitignore` 登记） |
| D-07 | 流程资产增速 | — | — | — | 用户拍板 | ✅ 决策：不设机械上限（流程文档是工作记忆）；下次健康审计复查增速，超 3 倍再议 |

**执行记录（2026-11-25 夜）**

- 13 张 P0/P1 工单已合并进 develop：DM-01~04、P-01~06a、E-03~E-05。CHANGELOG 的 `[未发布]` 段由主控统一补（5 条用户可感知修复）。
- **E-04 收窄**：`tsconfig.test.json` 与 `test/eslint-baseline.test.ts` 的两处注释型漂移移出 E-04（它们会把纯文档卡路由成双域全量门禁），并入 E-01。
- **本机合并判据**：产品全量门禁在本机不可绿——宿主安全策略全局拉黑 `reg.exe`（注册表用例必红），`test/util-gaps2.test.ts` 的 `ENOTDIR` 用例在 Windows 上既有失败（develop 基线同样红）。CI（Windows + node 24）develop 最近一次为绿。产品域合并因此按「目标用例全绿 + `--skip-test`」执行并逐卡记录理由，全量交由 CI 兜底。
- **编排冒烟门禁必须串行**：`VITEST_MAX_WORKERS=1`。4 worker 并行时 `provision` / `tiers` / `reconcile` 互相争用假红（develop 上可复现）。串行约 9–10 分钟。
- **测试环境残留**：`%TEMP%/orch-*` 累积到千级后 `provision` E2E 会稳定假红，跑编排门禁前先清理。
- **门禁分域待改进**：`scripts/test-gate.mjs` 把 `CHANGELOG.md` 等根目录文档判为产品域，任何带 CHANGELOG 的纯文档提交都会触发产品全量——建议列入 E-01/E-02 的顺手项。

**2026-11-26 晨补充**

- 收编两份遗留 worktree：`fix-buildsea-version-residue`（sea 构建版本残留自愈守卫，`6fd762b`+`1d4e3e5`，验收 47/47 + ship-selfcheck 双 PASS）、`test-orch-timeout-tier`（编排套件 `testTimeout` 20s→60s，`d064770`，4 worker 下 provision/tiers/reconcile 由假红转 72/72）。
- 顺手两条：`2ac0114` 锁父级 errno 断言按平台取码（Windows 报 ENOENT）；`0c52373` 补 `relay-gaps` 用例缺失的 `UpstreamBody.text`。
- **CI 教训（重要）**：`68e3b46` 推上去后 `test` 工作流在 ubuntu/windows 两腿红，根因是 P-03 新增用例的类型不匹配被 `tsc -p tsconfig.test.json` 拦下——本地因为产品全量走了 `--skip-test` 而没发现（`npx vitest run` 不做类型检查）。**今后凡是产品域 `--skip-test` 合并，提交前必须额外跑一次 `npx tsc -p tsconfig.test.json --noEmit`。**
- 现状复核（`0c52373`）：`tsc` 两份 config 均绿、eslint 基线 / docs-lint / 日期门禁 / 类型门禁 31/31 绿。仍未闭合项见下方清单。

**2026-11-26 午后补充（用户授权按推荐方案全量修复）**

- **E-01 / E-02 / P-06b / S-01 / S-02** 由 4 个并行 agent 完成。S-01 agent 在收尾阶段因额度中断，但 10 个纯搬移 commit 已落分支——主控机械复核（旧 server.ts 非空行 95.3% 在新模块逐字重现，未命中全是 import/export 接线）+ tsc ×2 + 28 个引用方 502/502 后合并。**教训：agent 中断≠工作丢失，先查 worktree 的提交与脏文件再决定重做还是续做。**
- **S-03** agent 两次因额度 429 未启动/中断；第二次其实已把半成品（host 桥 + gen-ui-ts + usage 迁移本体）留在 worktree 脏区。主控续完：修正三处与实际机制不符的注释（bundle 是独立 script + 全局别名 + 宿主桥，不是共用闭包）、补 `gen:ui-ts` script 与 `test/ui-ts-bundle-fresh.test.ts`、写 ui-kit §16 与 AGENTS.md 行。
- **P-06b 实例锁**：`gateway.lock`（O_EXCL + 死 pid 接管 + Windows EBUSY 有界重试），并发启动用例修前红/修后绿。
- **D-01 / D-07 按选项落决策**（记录于状态表）；D-06 清理；D-02~05 由 CI agent 完成（39 处 uses 钉 SHA、attestation、audit/canary/bench 三个非 required 任务）。
- **教训补记（2026-11-26 晚）**：errno 类断言只断语义、不断具体码——锁父级为文件的错误码在 Windows 本机（ENOENT）与 CI runner（ENOTDIR）不一致，2ac0114 的按平台钉码断言把 Windows CI 弄红，e97846e 改为 win32 收两种码。**本机验证无法替代 CI 的环境差异面，平台相关断言一律按语义写。**
- **遗留两条**：① E-02 的 `format:check` 是告警态——全仓 529 文件未过 prettier，硬门禁转正需单独一轮 `npm run format`（大 diff，等用户点头）；② S-04 可选大文件拆分未开工。

**并行分组**（按文件归属切分，减少 rebase 冲突）：

- **甲组**：DM-01 → DM-02 → DM-03，同一 agent 顺序做（都改 `orchestrator.mjs`，且 DM-01 定下的锁口径后两张要沿用）。
- **乙组**：DM-04（只改 `feature-branch.mjs`），可与甲组并行。
- **丙组**：P-01、P-02、P-03、P-05 文件互不相交，可各派一个 agent。P-04 与 P-06 都碰 `gateway/`，建议串行。
- **丁组**：E-01~E-05 互不相交。E-02、E-04 会动 CI 配置与 `AGENTS.md`，建议最后合。
- **S 组**：等 P0 全部合并后再开。

---

## 2. P0：Dockmaster 并发缺陷

### DM-01 人工批示与自动合并互不加锁

- **task-id**：`fix-dm-gate-mutex`
- **改动面**：`.agents/scripts/orchestrator.mjs`（`doApprove` / `doReject` / `doRetry` / 自动批示 sweep / CLI 分发）
- **域**：Dockmaster

**证据（读码确认）**

- 任务锁 `acquireTaskLock` 全仓只有两个调用点：`cmdRun` 内（`orchestrator.mjs:382`）和 `feature-branch start`（`feature-branch.mjs:477`）。
- `doApprove`（`orchestrator.mjs:1941-2060`）会 spawn `feature-branch finish`，耗时数分钟（rebase → 测试 → 合并），**整段不持任务锁**。
- CLI 的 `reject` / `retry` / `approve`（`:6313-6345`）只在入口查一次卡状态，之后不再校验，也不看锁。
- 自动批示 sweep（`:2217-2268`）对 `awaiting-human` 列表只快照一次，逐卡处理前不复查。

**交错**

1. sweep 判定超时，`doApprove` 进入 `finish`。
2. 此刻人工执行 `reject`：卡立即迁到 `failed/`。
3. `finish` 不知情，把分支合并进 develop。
4. 回到 `:2035` 的 `moveCard` 因卡不在 `awaiting-human/` 抛错，本轮 sweep 剩余的卡全部跳过。

变体：审查有 blockers，人工在超时后才批准，而 sweep 判定自动返工 → `doRetry` 把卡迁回 `running/` 并起 worker，与仍在跑的 `finish` 同写一个 worktree，随后 `finish` 还会 `git worktree remove`。

**修法**

1. `doApprove`：进入即 `acquireTaskLock(repoRoot, taskId, 'approve')`，`try/finally` 配对 `releaseTaskLock`。`held: false` 直接 `die` 并带持有者 pid / cmd。`scratchOnlySettle` 分支（零提交直接迁卡）不需要持锁。
2. `doRetry`：同样持锁。它内部调 `cmdRun` 会再次 `acquire`——同 pid 重入豁免，靠深度计数配对；**核实 release 配对正确**（`cmdRun` 的 `finally` 减一层，`doRetry` 的 `finally` 再减一层，锁文件只在最外层删除）。
3. `reject` 与 CLI 的 `approve` / `retry`：动作前 `readTaskLock` + `taskLockLooksLive`，锁活则拒绝并提示持有者。`cmdAbandon`（`:2463-2464`）已有同款守卫，照搬。
4. `doApprove` 在 `finish` 返回后、`moveCard` 前复查卡仍在 `awaiting-human/`；不在则不写 `merged` 事件，按失败处理。
5. sweep 循环内每张卡动作前复查卡仍在 `awaiting-human/`。

**注意**

- `doApprove` 持锁后，`finish` 子进程的撞窗预检 `scanLiveTaskLocks` 已带 `excludeTaskIds: [taskId]`（`feature-branch.mjs:788`），不会把自己的锁当成撞窗。
- 人工直跑 `feature-branch finish <id>`（不经 `doApprove`）只持 `.finish.lock`，本工单**不覆盖**这条路径。覆盖它需要让 `finish` 也持任务锁，那会动 `feature-branch.mjs`，与 DM-04 冲突——先不做，在汇报的「遗留风险」里记一笔，等 DM-04 合并后再评估（届时 `feature-branch.mjs:595` 注释「finish 全程持自己的任务锁」才成立）。

**回归用例**（新文件 `test/orchestrator/gate-mutex.test.ts`，夹具写法参照 `autoapprove.test.ts` 与 `claim.test.ts`，用 mock 后端）

- 任务锁被存活进程持有（写一个 `beat` 新鲜的 `.run-<id>.lock`）时，`reject` 拒绝、卡仍在 `awaiting-human/`、事件链无 `human_gate`。
- `doApprove` 进行期间锁文件 pid 是编排器进程（把 finish 换成可控的桩，或在 finish 桩里读锁断言）。
- 卡不在 `awaiting-human/` 时 `doApprove` 拒绝、不写 `merged`。
- 自动 sweep「进行中插入人工动作」至少一条。

**验收**

- 上述用例修前红、修后绿。
- `npx vitest run -c vitest.workflow.config.ts test/orchestrator/autoapprove.test.ts test/orchestrator/task-lock.test.ts test/orchestrator/task-lock-owner.test.ts test/orchestrator/claim.test.ts test/orchestrator/gate-mutex.test.ts` 全绿。

**文档同步**：`.agents/workflows/orch-loop.md`「互斥与并行」节补一句——人工批示与自动批示共用任务锁。

---

### DM-02 人工认领的卡被当孤儿自动续跑

- **task-id**：`fix-dm-manual-claim-orphan`
- **改动面**：`.agents/scripts/orchestrator/autoresume.mjs`、`orchestrator.mjs`（`orphanHealPass`）
- **域**：Dockmaster

**证据（读码确认）**

- 人工 `feature-branch start` 认领卡时只短暂持任务锁，进程退出即释放（`feature-branch.mjs:437-439` 注释写明是设计如此），并写一条 `manual_claimed` 事件（`:490`）。
- **`manual_claimed` 在 `.agents/scripts` 里只有写入点、没有任何读取点。**
- 孤儿自愈 `orphanHealPass`（`orchestrator.mjs:2767-2860`）只看锁：`partitionRunningOrphans`（`autoresume.mjs:368-382`）把无活锁的 running 卡判为孤儿。
- `classifyOrphan`（`autoresume.mjs:299-313`）对事件链 `[manual_claimed]` 返回 `'resume'`。
- 续跑走 `orchestrator.mjs resume <id> --auto-resume`（`:2832`）→ `cmdResume` 对 running 放行（`:2446`）→ `cmdRun` 抢锁成功 → `ensureWorktree` 对已存在的 worktree **直接复用**（`:299-316`）→ worker 进场。
- `workflow.json` 的 `autoResume.enabled` 是 `true`。

**后果**：编排器 worker 与人工 agent 同时写一个 worktree。人工 agent 之后 `finish` 时，撞窗预检会排除本任务（`feature-branch.mjs:788`），直接继续合并。

**与文档相反**：`.agents/workflows/orch-ecosystem.md:19` 写「drain 不会误派」；`orch-loop.md:133` 写「人工 agent 经 feature-branch start 认领同一把锁」。

**修法**

1. `classifyOrphan` 新增类别 `'manual'`：最后一条 `worker_spawned` 之后（无 spawn 则全链）出现 `manual_claimed` → 返回 `'manual'`。
2. 处理全部 4 个消费点，`'manual'` 卡**不续跑、不落 blocked、只观测留痕**（`appendFleetEvent(repoRoot, 'orphan_heal_manual_claimed', ...)`，落 fleet 不落卡事件，因为属主可能正在写同一个 `events.jsonl`）：
   - `autoresume.mjs:343`（`pickOrphanResumeCandidates`）
   - `orchestrator.mjs:2797`、`:2811`（`lifetimeCapRejections` 的 `isEligible`）
   - `orchestrator.mjs:2851`（落 blocked 循环——这里要先 `continue`，不能走到写 `failed` 事件那段）
3. 边界：编排器自己续跑过的人工卡，事件链是 `[manual_claimed, worker_spawned, …]`，最后一条 spawn 在 `manual_claimed` 之后，按既有规则分类，不受影响。补一条用例锁住这个边界。

**回归用例**（`test/orchestrator/autoresume.test.ts`）

- `classifyOrphan([{type:'manual_claimed'}])` 返回 `'manual'`。
- `pickOrphanResumeCandidates` 不选 `'manual'` 卡。
- `[manual_claimed, worker_spawned, worker_done]` 仍返回 `'stuck'`（既有语义不变）。
- 集成：pending 卡 → 子进程跑 `feature-branch start` 认领并退出 → 触发 `orphanHealPass` → 断言卡仍在 `running/`、无 `worker_spawned`、无 `auto_resume` 事件。

**验收**

- 上述用例修前红、修后绿。
- `npx vitest run -c vitest.workflow.config.ts test/orchestrator/autoresume.test.ts test/orchestrator/autoresume-lifetime.test.ts test/orchestrator/claim.test.ts` 全绿。

**文档同步**：`orch-loop.md`「互斥与并行」节写明——人工认领后由 `manual_claimed` 事件而不是任务锁识别，孤儿自愈跳过。

---

### DM-03 看门狗熔断停机标志置位过晚

- **task-id**：`fix-dm-watchdog-halt-flag`
- **改动面**：`.agents/scripts/orchestrator.mjs`（`runWatchdogCheck`、`cmdRun` 内层会话循环）
- **域**：Dockmaster

**证据（读码确认）**

`runWatchdogCheck` 的 `circuit_break` 分支（`orchestrator.mjs:795-822`）顺序是：

```
killTree(livePid)                      // :800
moveCard(...)                         // :808 或 :812
await settleNotify(...)               // :809 或 :814  ← 真实 await
watchdogHalted = true                 // :821           ← 太晚
```

`await` 期间 `killTree` 触发的 worker close 事件先被派发，主循环在 `:979` 读到 `watchdogHalted === false`，越过作者特意设置的防线（注释 `:980-983` 写明要「拦在瞬时故障重试判定之前」）。随后两条路径都错：

- 判为瞬时故障：`:1031-1032` `continue` 回内层循环顶（`:919`），循环顶不查卡状态 → 在已 `blocked/` 或 `reviewing/` 的卡上再派一个 worker。
- 非瞬时：`:1084` 写误导性事件，`:1095` 的 `moveCard` 对已不在 `running/` 的卡抛错；卡在 `reviewing/` 时还会被 `failTaskToBlocked` 改落 `blocked/`，撤销 2026-11-17 加的「有提交转审查」对冲。

**触发条件**：`settleNotify` 有真实等待（通知走网络）。当前配置是 digest 模式，实际触发频率未实测。

**修法**

1. `watchdogHalted = true` 移到 `killTree` 之后、第一个 `await` 之前。
2. 内层 `for (;;)` 循环顶（`:919` 之后）加卡状态断言：卡不在 `running/` 就直接 `return`（走 `finally` 清理），不派新 worker。
3. `budget.tripped` 分支（`:987-995`）用 `exitRun`，不依赖这个标志，不用动。

**回归用例**（`test/orchestrator/watchdog.test.ts` 或新文件，mock 后端）

- 熔断落位后，worker close 触发主循环时不再 spawn 第二个 worker。
- 卡已 `reviewing/`（有提交对冲）时，主循环不会把它改落 `blocked/`。
- `watchdogHalted` 是 `cmdRun` 闭包里的局部变量，无法直接注入。可行做法：让 `settleNotify` 可被测试桩挂起（挂起期间放行 worker close），或退一步做事件流级的集成断言。**最低要求**：一条「熔断落位后不再派发」的集成用例。

**验收**

- 用例修前红、修后绿。
- `npx vitest run -c vitest.workflow.config.ts test/orchestrator/watchdog.test.ts test/orchestrator/watchdog-maxchecks-scale.test.ts` 全绿。

---

### DM-04 finish 撞窗等待冻结心跳，活锁被接管

- **task-id**：`fix-dm-finish-wait-heartbeat`
- **改动面**：`.agents/scripts/feature-branch.mjs`
- **域**：Dockmaster

**证据（读码确认）**

- 持 finish 锁期间心跳靠 `setInterval` 续写（`feature-branch.mjs:268-274`，15s 一拍）。
- `waitForOrchestratorQuiet`（`:652-666`）用 `sleepSyncMs(COLLISION_POLL_MS)` 同步睡，30s 一轮、上限 10 分钟（`:170-171`）。同步睡眠会冻结事件循环，**心跳停更**。
- 锁判活只看 `beat` 新鲜度，60s 判陈（`:215`、`:155`）；等待者遇陈锁直接删（`:258-261`）。
- 调用点 `:840` 没有 `await`。

**交错**：finish A 进入撞窗等待 → 心跳停更超 60s → 第二个 finish 判陈锁、删除并接管，开始自己的 rebase / merge → A 睡醒后不复查锁归属，继续 `:860` 的 `git merge`。

**修法**

1. `waitForOrchestratorQuiet` 改成 `async`，用 `setTimeout` 代替 `sleepSyncMs`；调用点加 `await`。
2. 醒来后校验锁仍属于自己（`readLockJson(FINISH_LOCK)?.pid === process.pid`），不是就 `die`（锁已易主）。
3. 排查 `cmdFinish` 内其余持锁的同步长阻塞点。`spawnSync git rebase`（`:755`）通常秒级，记录为已知余量即可；若要保险，同样在醒来后校验锁归属。

**回归用例**（`test/orchestrator/finish-collision.test.ts`）

- 等待期间持锁者的 `beat` 持续刷新、第二个 finish 不会接管。
- 测试等不起 30s 一轮：按 `FINISH_LOCK_WAIT_SECONDS` 的惯例加环境变量收缩轮询间隔（如 `FINISH_COLLISION_POLL_MS`），并保持生产默认值不变。锁时间常量的测试手法参照 `finish-lock.test.ts`。

**验收**

- 用例修前红、修后绿。
- `npx vitest run -c vitest.workflow.config.ts test/orchestrator/finish-collision.test.ts test/orchestrator/finish-lock.test.ts test/orchestrator/host-guard-collision.test.ts` 全绿。
- `.agents/workflows/feature-branch.md`「编排器撞窗防护」段行为描述不变即不用改；若改了可调参数，同步该段。

---

## 3. P0：产品代码缺陷

### P-01 密钥写失败后内存缓存被污染

- **task-id**：`fix-secrets-cache-rollback`
- **改动面**：`src/config/secrets.ts`
- **域**：ModelDock

**证据（读码确认）**

- `mutateFileSecrets`（`secrets.ts:761-768`）：`loadFileSecrets(false)` 在指纹相等时返回的是 `cached.data` **本体**（`:714`，回验窗口内是 `:709`），`fn` 原地改它，然后 `await writeFileSecrets(store)`，**没有 try/catch**。
- `writeFileSecrets` 里加密（`:746`）或 `atomicWrite`（`:748`）抛错时，内存已是新值、磁盘仍是旧值。
- 因为磁盘没变、stat 指纹一直相等，`loadFileSecrets` 的回验会一直续期缓存，**直到进程重启**。
- `invalidateSecretsCache()` 在 `src/` 内没有外部调用点。

**修法**

1. `mutateFileSecrets` 里传给 `fn` 的是浅拷贝（`{ ...store }`），写成功才让缓存指向它（`writeFileSecrets:752` 已在写成功后回填 `fileCache`，浅拷贝后这条路径不用改）。
2. 写失败时 `fileCache = null`，对齐 `mutateConfig` 失败时 `loadMemo = null` 的做法（`src/config/store.ts`）。
3. 确认 `writeFileSecrets` 的「未变更条目复用旧密文」逻辑（依赖 `prev.snapshot`）在浅拷贝下仍正确。

**回归用例**（`test/secrets-lock.test.ts`，它测的就是 file 后端）

- 用 `__testSetFileCipher`（`secrets.ts:542`）注入 `encryptTable` 抛错的 cipher → `setSecret` reject → `getSecret` 仍返回旧值，`secrets.json` 字节未变。

**验收**

- 用例修前红、修后绿。
- `npx vitest run test/secrets-lock.test.ts test/secrets-inval.test.ts test/store.test.ts` 全绿。
- CHANGELOG 补一条「修复」。

---

### P-02 锁等待超时短于陈锁判定

- **task-id**：`fix-lock-timeout-vs-stale`
- **改动面**：`src/util/fsx.ts`
- **域**：ModelDock

**证据（读码确认）**

`fsx.ts`：`lockAcquireTimeoutMs = 10_000`（`:303`）、`lockStaleMs = 15_000`（`:309`）、心跳 5s（`:311`）。陈锁判定在 `:386`，超时抛错在 `:400`。

持有者崩溃后，锁文件要等最后一次心跳起 15s 才算陈旧，而等待者 10s 就放弃。**持有者死后约 10–15s 内到达的等待者必然收到「超时…可删除该 .lock 文件重试」**，而那其实是崩溃残留。影响 CLI `set-key`、网关内同步 tick、`pickerSync`。是健壮性问题，不是数据损坏（超时报错在安全侧）。

现有用例都是超时大于陈锁阈值（`secrets-lock.test.ts` 700 > 200、300 > 200），生产默认值的反转关系从未被测到。

**修法**（三选一）

- 让 `lockAcquireTimeoutMs` 默认大于 `lockStaleMs`（如 20s）。
- 参照 `src/update/lock.ts` 加 pid 探活，属主已死立即抢占。
- 两者都做。

无论选哪种：加一条不变量测试 `acquireTimeout > stale`，并同步 `:313` 注释里的「真实值」。

**验收**

- `npx vitest run test/secrets-lock.test.ts test/store.test.ts test/fsx-memo.test.ts <新/改文件>` 全绿。
- 若改了默认超时，用户可感知的等待时长变化在 CHANGELOG 记一条。

---

### P-03 上游错误体解压无输出上限

- **task-id**：`fix-relay-decompress-cap`
- **改动面**：`src/gateway/relay.ts`
- **域**：ModelDock

**证据（读码确认）**

`readUpstreamErrorText`（`relay.ts:845-864`）：读入封顶 1MB（`UPSTREAM_ERROR_BODY_MAX_BYTES`），但 `gunzipSync` / `inflateSync` / `inflateRawSync` / `brotliDecompressSync` / `zstdDecompressSync`（`:853-859`）都**没设 `maxOutputLength`**。异常或恶意的上游用高压缩比错误体，可同步把内存撑爆并卡住事件循环。

顺带：`readBodyBounded` 的非流回落分支（`:831-833`）忽略了 `maxBytes`。

**修法**

- 各 sync 解压调用加 `{ maxOutputLength: 2 * 1024 * 1024 }`，超限抛错走既有 `catch` 回落原文。
- zstd 是否支持 `maxOutputLength` 选项需查 Node 22/24 文档；不支持就改为限制压缩体大小或用流式解压。
- 回落分支读完后按 `maxBytes` 截断。

**回归用例**（`test/relay-gaps.test.ts`，mock 上游）

- 返回高压缩比 gzip 错误体（如几十 MB 零字节的 gzip，本身只有百 KB 级），断言返回文本长度不超上限、用例耗时正常。

**验收**

- `npx vitest run test/relay.test.ts test/relay-gaps.test.ts test/relay-404-model.test.ts test/hotpath.test.ts` 全绿。
- CHANGELOG 记一条（安全加固口径，用户视角）。

---

### P-04 用内存态配置回写磁盘，覆盖并发改动

- **task-id**：`fix-stale-config-writeback`
- **改动面**：`src/ops/routing.ts`、`src/gateway/server.ts`、`src/gateway/lan.ts`（及其余调用方）
- **域**：ModelDock

**证据（读码确认）**

- `hSwitch`（`server.ts:925`）把 `rt.config.gateway?.auto_failover`（内存快照）传给 `switchToServiceWithRoute`。
- `hAutoRoute`（`server.ts:949-951`）在请求未带 `enabled` 时，也用 `rt.config` 兜底。
- `switchToServiceWithRoute`（`ops/routing.ts:96-110`）在锁内用**盘上最新配置** `c` 做整包写回，`auto_failover` 取的是外面传进来的内存值。
- LAN 侧同款调用：`lan.ts:487`、`:533`（`:507-509` 的 `enabled` 缺省口径据审计报告同型，动手时核对）。

**后果**：watcher 正常时只有 CLI 写盘后 250ms 防抖窗口内的改动会被回滚；watcher 失效（代码支持的降级模式）时 `rt.config` 长期陈旧，此后每次界面或手机端切换都会把 CLI 改过的 `auto_failover` 改回去。`known-issues` 的 REVIEW-11 只修了 `hHarnessRoute` 一处（据审计报告）。

**修法**

- 「保持现状」下沉到 `mutateConfig` 回调内：`setAutoRoute` 的 `enabled` 允许 `undefined`（= 保持盘上现值）；`switchToServiceWithRoute` 的 `autoFailover` 允许 `undefined` → `autoFailover ?? (c.gateway?.auto_failover ?? false)`。
- 调用方全部改为不传内存值。全仓 grep 调用点，别漏 `cloud/`、`cli/`、`sync/`。
- 兼容性：原行为在内存值为 `undefined` 时写 `false`；新行为在盘上无该字段时结果相同。

**回归用例**（`test/ops-direct-switch.test.ts`）

- 先让 `rt.config` 与盘上不一致（盘上 `auto_failover=true`，内存 `false`），调用切换后断言盘上仍是 `true`。

**验收**

- `npx vitest run test/ops-direct-switch.test.ts test/ops-switch-rebake.test.ts test/ops-addservice.test.ts test/lan.test.ts test/gateway.test.ts` 全绿。

---

### P-05 `remountSyncEngine` 无互斥

- **task-id**：`fix-sync-remount-mutex`
- **改动面**：`src/sync/engine.ts`（调用点 `src/gateway/main.ts:187`、`:208` 不用改）
- **域**：ModelDock

**证据（读码确认）**

`remountSyncEngine`（`engine.ts:385-407`）：`stopLoop`（`:377-382`）先把 `active` 置空，再 `await` 在飞 tick。此时若 `sync.json` 签名再变一次，第二次调用看不到活动循环，直接新建并启动；第一次恢复后又用**旧签名**建一个并覆盖 `active`。

**后果**：第二次建的那个循环成为孤儿，`stopSyncEngine` 永远停不掉，两个循环对同一目标双写推拉。最容易触发的场景恰是目标不可达、用户正在重新配置它的时候。`main.ts:187` 是不等待的 fire-and-forget，`:208` 是 watcher。

**修法**

- 加模块级 promise 互斥（同仓 `mutateGatewayState` 的写法，`gateway/state/state-file.ts`，据审计报告）。
- 每个 `await` 之后重读盘上签名再决定挂哪个，不复用进函数时的快照。

**回归用例**（`test/sync-engine-gaps.test.ts` 或新文件）

- 让 `loop.stop()` 可延迟，并发两次不同签名的 `remountSyncEngine`，断言只有一个活动循环、活动签名等于最新盘上签名、`stopSyncEngine` 后无 tick。
- 用例收尾 `await stopSyncEngine()` 再恢复 env。

**验收**

- `npx vitest run test/sync-engine.test.ts test/sync-engine-gaps.test.ts test/sync-race.test.ts test/syncagent.test.ts` 全绿。

---

### P-06 单实例检查先查后写；无响应被当成未运行

- **task-id**：`fix-single-instance-check`
- **改动面**：`src/gateway/main.ts`、`src/gateway/shared.ts`、`src/cli/gatewaycmd.ts`、`src/gateway/state/state-file.ts`
- **域**：ModelDock
- **建议拆两张卡**：(a) 三态判活，(b) 实例锁

**证据（读码确认 + 据审计报告）**

- `main.ts:84-97`：读 `gateway.json` → 判 pid → `healthOk` → 之后才写新状态，**检查与写之间没有锁**。两个实例在启动窗口内都通过检查时，第二个被 `listenWithRetry` 顺延到下一个端口并覆盖 `gateway.json`，同一 home 下出现两个 daemon。
- pid 活着但 `healthOk` 失败时也执行 `clearGatewayState()`（`:96`）。`healthOk` 超时 1s、`/health` 要做解密校验等较重的工作（`shared.ts:46-70`、`server.ts:2224-2253` 据审计报告）。一旦超时：`gateway stop` / `status` 报「网关未运行」；`rotate-token`（`gatewaycmd.ts:104`）直接改写 `gateway.json`，而运行中的网关内存里还是旧 token。

触发条件未实测。

**修法**

- **(a) 三态判活**（先做，纯健壮性）：`gatewayLive` / `healthOk` 区分「活着 / 已死 / 无响应」。pid 存活且 health 超时 → 不清状态文件、不报未运行、报「网关无响应」；`stop` / `status` / `rotate-token` / `start` 按三态分流。
- **(b) 实例锁**：启动时以 `O_EXCL` 在 modeldock 目录建实例锁文件，或「先 `listen` 成功再写 `gateway.json`」。动手前先给出方案（要评估 Windows 下目标被占用时的 EBUSY / EPERM），**方案经用户确认再实现**。

**回归用例**（`test/daemon-lifecycle.test.ts`、`test/gateway-shared.test.ts`）

- pid 存活、health 超时 → 状态文件保留、`status` 报无响应、`rotate-token` 拒绝直写。
- (b) 并发启动两次，断言只有一个实例、`gateway.json` 只指向它。

**验收**

- `npx vitest run test/daemon-lifecycle.test.ts test/gateway-shared.test.ts test/gatewaycmd*.test.ts` 全绿。
- 用例只用 `listen(0)` 与 `MODELRDOCK_FAKE_HOME` 沙箱。

---

## 4. P1：工程配套

### E-01 类型检查与 lint 覆盖面

- **task-id**：`tooling-typecheck-coverage`（建议拆 3 张卡递进）
- **现状**（读码确认）
  - `tsconfig.test.json` 的 `exclude` 排除了 `test/orchestrator` 整目录 + 24 个产品测试文件，即约 140 个测试文件不做类型检查。注释里写「剩余 84」，与实际清单不符。
  - `.agents/scripts` 的 63 个 `.mjs`（约 2.6 万行）不在任何 tsconfig 里；`eslint.config.mjs:10` 明确 ignore 了 `.agents/**`。
  - ESLint 只有 3 条规则（`eslint.config.mjs:24-28`），作用域只有 `src/**/*.ts`。
- **做法**
  1. 新建 tsconfig（`allowJs` + `checkJs` + `noEmit`，先关 `noImplicitAny`）覆盖 `.agents/scripts` 与 `scripts/`，加 `npm run typecheck:agents`，用棘轮基线（仿 `eslint-baseline.json`，只降不升）。
  2. 给 `test/orchestrator` 补 `.d.ts` 边界，分批移出豁免。
  3. 24 个产品测试每移出一个，同步 `test/test-typecheck-gate.test.ts` 的登记。
- **验收**：CI 上新门禁绿；基线数字有据可查；`tsconfig.test.json` 注释改对。
- **注意**：仓库里 TS 7（`tsc` 二进制）与 TS 6（JS API，供 typescript-eslint）并存，是有意布局，别动 `package.json` 这两项。

### E-02 CI 补廉价门禁（需用户确认后再做）

- **现状**（读码确认）：CI 只测 node 24（`test.yml:29-31`），而 `engines` 是 `>=22`；`format:check` 不在 CI；`npm audit` 只在本地发布脚本里跑，网络失败降级为 warn。
- **做法**：`test.yml` 加 `prettier --check` 步骤；加 node 22 腿或定时巡检；`npm audit` 挂到 schedule。
- **注意**：`.github/workflows/` 属 `releasePaths` 高风险路径，方案先给用户看。

### E-03 LAN 威胁模型与用户提示

- **现状**（读码确认）：`src/gateway/lan.ts:662-663` 默认绑 `0.0.0.0` 的明文 HTTP；`docs/design/hld.md:572-583` 的威胁表没有 LAN 专项行；README、SECURITY、guide 里没有「仅限可信网络」提示。
- **做法**
  - 威胁表补行：令牌经二维码 / URL 传递的泄漏面、明文嗅探、暴力尝试与限频、发现信标伪造。
  - 开启手机远程的界面与 `docs/guide/usage.md` 加提示；`docs/en` 镜像同步（docs-lint 有 H2 同步与镜像检查）。
- **验收**：`npx vitest run test/docs-lint.test.ts` 绿；界面文案走 `t()` 与 `data-i18n`。

### E-04 修正已确认的文档漂移

逐条核对后改（前两条已逐行核实，其余来自审计报告）：

| 位置 | 问题 |
|---|---|
| `AGENTS.md:266`、`docs/ops/RELEASE_CHECKLIST.md:56` | 写「网关仅监听 127.0.0.1，不支持远程访问」，而 `lan.ts:662` 默认 `0.0.0.0` |
| `AGENTS.md:128` | 测试文件计数写「252（产品 149 + 编排 103）」，实际约 299（183 + 116） |
| `CONTRIBUTING.md:22` | 要求改完 `src` 必须全量 `npm test`，与 `AGENTS.md` 的「日常按域跑」相反 |
| `CHANGELOG.md:647` | `[未发布]` 的 compare 链接仍指向 `v1.8.0...HEAD`，最新 tag 是 v1.8.1 |
| `test/eslint-baseline.test.ts:14-16`、`:60` | 注释还写「129 处 warn」，基线已是 0 |
| `tsconfig.test.json:13-14` | 「剩余 84」与实际 24 项不符 |

- **验收**：`npx vitest run test/docs-lint.test.ts test/eslint-baseline.test.ts` 绿。`AGENTS.md` 里的计数类数字建议直接删掉或改为脚本生成，免得再漂移。

### E-05 防夹具日期炸弹

- **现状**（据审计报告）：测试里写死日期字面量 509 行；已炸过一次（`test/orchestrator/research.test.ts` 夹具写死 2026-11-08，越过 7 天容忍窗）。
- **做法**：提供相对日期夹具工具；对「写死日期 + 同文件使用 `Date.now()`」加一条门禁。
- **验收**：新门禁在现有测试上绿或给出豁免清单。

---

## 5. P2：结构性拆分（P0 全部合并后再开）

通用约束：沿用仓库既有的「**纯搬移**」路线，遵守 `REVIEW.md`「拆分/搬移类 refactor」红线——函数体与模板**逐字搬移**，只有 import / export / 路径这类接线可改；按文件路径读源的门禁（ui-lint、gen-ui-min 等）要跟着搬家；调用点零改动是验收项。一张卡只搬一个簇，合并后再开下一张。

### S-01 拆 `src/gateway/server.ts`（L）

- **现状**（读码确认）：3183 行，47 个 handler，另有 67 条的 `ADMIN_ROUTES` 表；90 天改了 97 次，是全仓第一变更热点；静态 import 闭包 150 / 195 个模块（据审计报告），网关进程因此加载几乎整个代码库。
- **职责簇**（行号为约数）：UI 缓存与 picker 状态（62–195）、`createGatewayServer` 与周期后台任务（196–380）、数据面 `handleRequest`（383–647）、Host 白名单与鉴权（652–688）、服务与路由 handler（731–1127）、自启与导入（1128–1252）、`hServiceUpdate`（单函数 257 行，1253–1542）、harness 凭据与接入（1543–1926）、profile / key / reload / reset（1927–2206）、health / metrics / usage（2205–2415）、探针端点（2416–2582）、usage / logs 查询（2583–2808）、路由表与 `handleAdmin`（2809–3043）、`probe()`（3045–3183）。
- **目标**：`server.ts` 降到 400 行以内只做组装；`routes/{services,harness,probe,usage,system}.ts` 各自带路由清单；周期任务拆到 `scheduler.ts`；数据面拆到 `dataplane.ts`。
- **注意**：28 个测试文件引用 `gateway/server`，必须保留 re-export。

### S-02 拆 `.agents/scripts/orchestrator.mjs`（L）

- **现状**（读码确认）：6380 行单文件。
- **做法**：按命令族拆（闸门 / approve / reject、孤儿自愈、自动批示 sweep、propose / spec / research 各命令），每张卡纯搬移一个簇。
- **注意**：模块级可变状态（`orchEnv`、`_weatherSnapshots`、`seqCache`、`baselines`、task-lock 的重入表）搬家后归属要清晰；编排测试是 `isolate: false`，共享模块注册表。

### S-03 Web UI 模板字符串转真 TS（XL，只做增量）

- **现状**（据审计报告）：约 5.7k 行 JS/CSS 以模板字符串形式存在于 `src/gateway/ui/*.ts`（22 个模板字面量导出，`ui/edit.ts` 整个文件是一个字符串），不受 tsc 和 ESLint 检查，只靠 `ui-lint` 与 happy-dom 测试兜底；文档记录的多次 UI 事故都发生在这层。
- **做法**：`esbuild` 已在构建链里。**新增 UI 模块**改为真正的 `.ts` 走打包；存量按域逐步迁移，不做一次性大改。

### S-04 其他大文件（M，可选）

- `src/gateway/relay.ts`（1371 行，边界清晰、风险低）、`src/cli/diag.ts`（1155 行，`collectDoctorFindings` 单函数约 478 行，可仿 `src/gateway/probe/registry.ts` 改成注册表）、`src/config/secrets.ts`（942 行，且反向依赖 `gateway/state/debuglog`）。

---

## 6. 需要用户决策（agent 不得自行执行）

| 编号 | 事项 | 现状 | 选项 |
|---|---|---|---|
| D-01 | 主干门禁策略 | 主线是本地合并后直推 develop（近 28 天 550 个 merge 提交），AI 审查只在 PR 事件触发；mac 腿在 develop push 上跳过 | A：`corePaths` / `releasePaths` 改动强制走 PR；B：接受现状，改 `docs/ops/ai-review-system.md` 的表述 |
| D-02 | 发布物签名 | macOS 只有 ad-hoc 签名，无公证、无 Windows Authenticode，SHA256SUMS 未签名（据审计报告） | 先加 GitHub artifact attestation；签名证书涉及成本 |
| D-03 | `scripts/bench-cold-start.mjs` 去留 | 只被 npm script 引用，CI 与文档零引用，`docs/ops/bench-baseline.md` 明写不作门禁 | 接入每周 schedule 并与基线比较；或删除脚本与 npm script |
| D-04 | `isolate: false` 是否开金丝雀 | 产品套件 `maxWorkers` 1 + `isolate: false`，是为消除死锁面做的有意取舍 | 用环境变量开 `isolate: true` 的 CI 金丝雀，量化耗时与红例 |
| D-05 | Actions 钉 SHA、加 `.nvmrc` | 30 处 `uses:` 全按大版本 tag；无 `.nvmrc` | 钉 commit SHA；加 `.nvmrc` |
| D-06 | 仓库根的 `HKCU/` 目录 | 4 层空目录（`HKCU/Software/Microsoft/Windows`），未跟踪也未忽略，创建于 10-28 | 查明来源后删除并加 ignore（删除需用户确认） |
| D-07 | 流程资产增速 | 近 4 周 `src` +56%、agent 工具代码 +355%、流程文档 +297%；流程文档约 1.2 万行，用户文档约 1450 行 | 是否给流程文档与工具链设增速上限 |

---

## 7. 不要重报的已知取舍

这些是仓库有意接受的，审计时不要当新问题提：

- `mutateConfig` 整包重序列化会抹掉 `config.toml` 的用户注释（`known-issues.md` CORRECT-03）。
- `known-issues.md` 明确暂缓的：PERF-15、PERF-21、PERF-36、XPLAT-09、XPLAT-11、REVIEW-26、API-EVAL-01~05；PERF-12 的遗留项（KDF 改异步，`pbkdf2Sync` 仍在事件循环上）。
- XPLAT-02：Windows 下 `gateway stop` 是硬杀，优雅停机通道有意不做。
- NTFS 上 `0o600` 不生效；不用 `import.meta`；`tsx` 直跑没有热重载。
- finish 撞窗防护（预检 + marker 重试）是尽力而为；`AGENTS_ALLOW_COLLISION_WINDOW=1` 是逃生口。
- 任务锁随 `start` 进程退出而释放（`feature-branch.md:17` 写明）。
- config-guard 基线在进程内存里，子进程合并 `workflow.json` 后父进程停派，方向是 fail-safe。

---

## 8. 不要动的强项（审计结论：保持现状）

- `strict: true` 全开；`src/` 内 `as any` 仅 10 处，`@ts-ignore` / `@ts-expect-error` 零；import 图无环。
- `atomicWrite`（tmp + rename + fsync，Windows 下 EPERM / EBUSY 退避重试）；`withFileLock` 有心跳保活与抢占前二次 stat 复核。
- Dockmaster 锁层：`wx` 建锁、tmp + rename 心跳、坏 JSON 退避重读、陈锁接管、只释放自己的锁、`TASK_ID_RE` 防路径注入。P0 的四条都是**闸门层**没接上这把锁，不是锁本身有问题。
- token 用 `crypto.randomBytes`，比较用 sha256 归一 + `timingSafeEqual`，管理面只绑 127.0.0.1，有 Host 白名单与 CSP，子进程调用全部是 `execFile` 加参数数组。
- 出站请求 34 处都有超时或信号。
- 测试里 `.skip` / `.only` / `.todo` / `retry` 全 0；三平台 CI；lint 棘轮已清零。

---

## 附录：审计指标（基线 e6f10bd）

| 项 | 值 |
|---|---|
| `src/` | 197 文件 / 46,288 行 |
| `test/` | 约 333 文件 / 88,874 行（产品 183、编排 116） |
| `.agents/scripts` | 63 个 `.mjs` / 25,941 行 |
| `orchestrator.mjs` | 6,380 行 |
| `server.ts` | 3,183 行，90 天 97 次变更 |
| `as any` / `as unknown as` / `@ts-ignore` | 10 / 22 / 0 |
| 类型检查豁免的测试文件 | 约 140 |
| 流程文档 / 用户文档 | 约 11,990 行 / 约 1,450 行 |
| 提交 | 1,759；近 4 周 1,274 |

> 指标由审计时的只读统计得出，执行前如需引用请重新统计。

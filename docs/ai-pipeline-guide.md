# AI 自治流水线使用指南（贡献者篇）

> 面向**贡献者**的端到端指南：从「给一句话意图」到「发版提案」，自治流水线（orchestrator）的全部用法。
> 设计原理见 [design-orchestrator.md](design-orchestrator.md)；状态机与排障深读见 [orchestrator-usage.md](orchestrator-usage.md)；与既有文档的分工见文末 [§10](#10-与既有文档的分工)。
> 全部子命令与 flag 的权威清单：**不带参数运行 `node .agents/scripts/orchestrator.mjs` 即打印用法**；本文示例与其保持一致。

## 1. 一句话模型与适用判定

**任务卡进、合并出**：写一张任务卡（或一句话让 Planner 代写）→ orchestrator 起 worker（headless agent 会话）在独立 worktree 里改代码 → 自动跑测试 / build / 红线门禁 → 失败自动喂回修 → LLM 独立审查 → 按任务卡声明的 gate 级别**自动合并或等你点头**。

- **适合交给流水线**：目标明确、验收标准可机器检查、改动范围清晰——bug 修复、小功能、文档同步、测试补充、巡检卡处理。
- **不适合**：探索性 / 架构级改动（验收标准写不出来）、需要频繁人工决策的任务、要动发布流水线的工作。
- **混合节奏**：大任务自己走 [feature-branch 工作流](../.agents/workflows/feature-branch.md)，顺手把可独立验收的小活写成任务卡丢进队列 `drain` 消化。同一 task-id 不要两种方式混用（worktree 会撞）。

红线事实：worker 会话被 policy hook 硬编码拦截 `git push` / `git tag` / `npm publish`，以及对生产、dev 两个网关端口的任何触碰——任务卡里写了也没用；发布永远人工（见 §7）。

## 2. 快速上手：5 分钟最小闭环

```bash
# 1. 一句话给意图：Planner（只读会话）自动探索仓库、编译任务卡进队列（gate 固定 L3）
node .agents/scripts/orchestrator.mjs intent "修复 presets.json 同名 id 未覆盖内置预设的问题"

# 2. 清空队列：逐张跑闭环，直到 pending 跑完或全部停在人工闸门
node .agents/scripts/orchestrator.mjs drain

# 3. 看结果：队列全貌 / 单任务事件时间线
node .agents/scripts/orchestrator.mjs status
node .agents/scripts/orchestrator.mjs status <task-id>

# 4. 审查通过的任务停在 awaiting-human，人工放行合并
node .agents/scripts/orchestrator.mjs approve <task-id>
```

复杂任务想先看草稿再入队：`intent "<描述>" --draft`（只出草稿、不进队列）。想空跑闭环不烧钱：`run <task-id> --backend mock`（假 worker，秒级完成，只验证流程本身）。

## 3. spec 三件套：先设计后施工

`intent` 适合小改动（一句话直达任务卡）；需要「先设计后施工」的特性走 `spec`——Planner 只读会话产出 requirements（用户故事 + EARS 验收标准）/ design（现状、方案、取舍、风险）/ tasks（可独立合并的任务段）三件套，落 `.agents/orchestrator/specs/<id>/`（人工审阅工作区，不入 git），**审阅设计后才拆卡**：

```bash
# 1. 意图 → 三件套（不进队列）
node .agents/scripts/orchestrator.mjs spec "支持配置导出为 JSON 文件"

# 2. 人工审阅 / 直接手改 specs/<id>/ 下的三个 md（这就是你的设计稿）

# 3. 确认设计后拆卡进队列（幂等：同 id 已拆过会跳过；design 全文注入每张卡的背景段）
node .agents/scripts/orchestrator.mjs spec build <spec-id>

# 浏览规格目录 / 单规格任务概要
node .agents/scripts/orchestrator.mjs spec list
node .agents/scripts/orchestrator.mjs spec show <spec-id>

# 4. 之后就是常规闭环：drain 逐张跑（按任务序先后调度），合并逐张等人工 approve
node .agents/scripts/orchestrator.mjs drain
```

要点：

- **人工闸门在「审设计」这一步**：Planner 只产文档不动代码——设计与施工分离、审点前置。
- tasks 里每个任务的「文件」行直接成为任务卡的 `files_hint`，**写得越准、并行分区越好**；缺失时兜底为 `**`（独占分区）并告警提示收窄。
- 拆出的卡 `created_at` 按任务序递增：drain 同优先级先到先跑，「依赖： 任务 N」天然先跑被依赖方，不引入显式依赖图。
- 拆出的卡 gate=L3、`created_by: planner`：开发→测试→审查照走闭环，合并仍人工。

## 4. 任务卡与队列：手写卡、gate 选择、看进度

手写任务卡是完全有效的路径（想精确控制验收标准时用）。frontmatter 要点（完整 schema 与字段说明见 [.agents/workflows/orchestrator.md](../.agents/workflows/orchestrator.md)）：

```markdown
---
id: fix-user-presets-merge        # 小写短横线，= feature 分支名
type: bugfix                      # bugfix | feature | docs | deps | refactor
priority: normal                  # high 先跑
files_hint:                       # 预期改动范围（glob）——写准！影响纯度检查/审查/并行分区
  - src/presets/**
workflows:
  - feature-branch
gate: L3
budget:                           # 可整体省略（回落默认 50轮/500k tok/60分钟）
  max_wall_minutes: 40
---

# 目标
一句话说清改什么、为什么。

# 验收标准            ← 可机器检查！orchestrator 亲自跑门禁，worker 拿它当靶子
- `npm test` 全绿
- 新增用例覆盖：同名 id 覆盖、新 id 追加
```

**gate 怎么选**（自动合并 = 审查通过 + 实际改动分级不超声明上限 + 无降级/无越界，缺一不可）：

| 声明 | 行为 |
|---|---|
| `L3`（缺省） | 永远人工 approve，最保守；不确定就用它 |
| `L1` | 实际改动为纯文档/测试或普通 `src/` 时可自动合并 |
| `L0` | 实际改动必须是纯文档/测试（`.md`、`docs/`、`test/`、`.agents/` 等）才自动合并 |
| 核心路径 | 实际改动触及 `workflow.json` corePaths（`src/cli.ts`、网关核心、`config/` 存储、`util/paths`、`package.json` 等）一律按 L2 永人工——声明 L0/L1 也会被分级拦下回人工 |

```bash
node .agents/scripts/orchestrator.mjs submit my-task.md     # 校验 schema 并进 pending/
node .agents/scripts/orchestrator.mjs run <task-id>         # 跑单个（先 --backend mock 可空跑流程）
node .agents/scripts/orchestrator.mjs run --next            # 自动取最高优先级 pending（high > normal > low）
node .agents/scripts/orchestrator.mjs status                # 队列全貌；加 <task-id> 看事件时间线
node .agents/scripts/orchestrator.mjs logs <task-id>        # 单任务完整事件链
```

真实 worker 的流量走本机网关（吃狗粮），账可对：

```bash
node .agents/scripts/orchestrator.mjs reconcile             # 全部已合并任务：自报 token vs 网关实测，分歧降序
node .agents/scripts/orchestrator.mjs reconcile <task-id>   # 单任务
```

自报账来自任务事件（worker 回填），实测账来自网关转发日志的 usage 旁路解析——worker 流量过网关才有实测账；网关零流量会标 ⚠（说明 worker 直连了上游）。纯只读报告。

## 5. drain 闭环：批量推进与并行分区

```bash
node .agents/scripts/orchestrator.mjs drain                 # 循环清空 pending（单任务熔断转 blocked/ 不阻塞后续）
node .agents/scripts/orchestrator.mjs drain --max 5         # 限制最多推进 5 个任务
node .agents/scripts/orchestrator.mjs drain --workers 3     # 最多 3 个任务同时跑
```

- **`--workers` 分区互斥**：按 `files_hint` 分区——`docs/**` 与 `test/**` 可并行；同属 `src/` 的任务保守串行；裸 `**` 或未声明 hint = 独占。想让任务可并行，写卡时把 `files_hint` 收窄到独立目录。
- **调度器互斥锁**：drain / nightly / 巡检自动闭环共用同一把锁（`.agents/orchestrator/.scheduler-lock.json`）——他人持锁且存活时后来者打印提示直接退出（定时巡检撞上手动 drain 不会双跑同一张卡）；持锁进程已死 = 陈锁，自动接管。手动 `run <task-id>` 单卡不抢锁。
- drain 连续两轮选中同一任务会自动停止——那说明 run 子进程无法处理该任务（执行环境损坏），防止空转。

自动合并的质量由 drift 报告兜底：

```bash
node .agents/scripts/orchestrator.mjs drift                 # 自动合并回溯健康度：失败率超 20% 自动降级全人工
node .agents/scripts/orchestrator.mjs drift --clear         # 人工确认根因消除后恢复自动合并
```

降级期间 L0/L1 自动合并全部回人工闸门（事件 reason=drift_degraded）；降级只影响合并闸门，不影响并行调度。

## 6. approve 闸门：人工三选一与善后

审查通过后任务停在 `awaiting-human/`，人工三选一：

```bash
node .agents/scripts/orchestrator.mjs approve <task-id>               # 批准合并（内部调 feature-branch finish，含最终 testCmd 验证）
node .agents/scripts/orchestrator.mjs reject <task-id> --reason "…"   # 驳回 → failed/（worktree 保留现场）
node .agents/scripts/orchestrator.mjs retry <task-id> --note "…"      # 打回重跑 → 附补充指令重新闭环
```

`run` 在交互终端会在闸门处直接问（a 批准 / v 看 diff / r 驳回 / b 打回 / q 搁置）；脚本 / CI 非交互时打印提示后退出——用上面的命令异步处理。

`blocked/`（预算熔断、worker 崩溃）的善后：

```bash
node .agents/scripts/orchestrator.mjs resume <task-id>     # 带现场（事件时间线 + NOTES.md）续做
node .agents/scripts/orchestrator.mjs abandon <task-id>    # 放弃 → failed/（worktree 按 worktree-rescue 手册人工清）
```

熔断触发条件与状态机全景（每个状态下一步是什么）见 [orchestrator-usage.md](orchestrator-usage.md)。

## 7. release-propose：发版提案

把发版第一步「盘点 + 定档 + 草稿」自动化（纯只读：不写 CHANGELOG、不提交、不打 tag）：

```bash
node .agents/scripts/orchestrator.mjs release-propose          # 自动定档出提案
node .agents/scripts/orchestrator.mjs release-propose 1.4.0    # 指定版本（校验 semver 与只增不减）
```

- 自动解析上个 tag 以来的内容提交（conventional 前缀），推 semver 档位（breaking 提交在 0.x 按惯例走 minor）；核对 CHANGELOG「未发布」段找疑似漏记。
- 提案文件落 `.agents/orchestrator/release-proposals/`：建议版本与依据、盘点清单（无前缀提交标「待人工归类」）、CHANGELOG 版本段草稿、版本链接表行、下一步指引。
- **版本号是建议，决定权在人**（发布是不可逆公开动作）：确认后对 agent 说「发布 vX.Y.Z」，走 [release.md「代理发布」](../.agents/workflows/release.md)执行序。无 feat/fix（纯文档/杂务）会提示人工裁决是否值得发版。

## 8. nightly 巡检：一次完整巡检编排

`nightly` = scan 落卡 + drift 报告 + 队列摘要的一次完整编排。`scan` 只做巡检生成任务卡：TODO/FIXME 与 npm audit 为默认信号源，`--tests` 追加跑测试套件这一慢信号源：

```bash
node .agents/scripts/orchestrator.mjs scan                 # 巡检生成任务卡（不 run，是否执行由人决定）
node .agents/scripts/orchestrator.mjs scan --dry-run       # 先看会生成什么，不落卡
node .agents/scripts/orchestrator.mjs scan --tests         # 全量巡检（含测试套件，慢）
node .agents/scripts/orchestrator.mjs nightly              # 完整编排：落卡 + drift 报告 + 队列摘要（零烧钱）
node .agents/scripts/orchestrator.mjs nightly --tests      # 编排含慢信号源
```

- 巡检卡 `created_by: scanner`、gate=L3；卡 id 按内容哈希——信号不变重复扫描自动去重；扫描内容经消毒，无法携带指令结构进 worker。
- **`--auto N` = 夜间自动优化档**：对本次生成的 high 卡发起闭环，再 `drain --max N` 推进队列——worker 烧钱仅在此档，合并闸门不变（L3 兜底，仍等人工 approve）：

```bash
node .agents/scripts/orchestrator.mjs nightly --auto 3
```

- 跑完必发通知（含异常中断）：macOS 本地通知（登录会话可见）；设环境变量 `MODELRDOCK_NIGHTLY_WEBHOOK=<url>` 可追加 webhook POST（飞书/企业微信/Slack 的 incoming webhook 皆可接）。摘要始终落 `.agents/orchestrator/logs/nightly.log`（超 5MB 自动轮转）。

## 9. schedule 定时：把 nightly 注册成每日任务

「夜里自动巡检（可选自动优化）、早上人工放行」的完整形态。orchestrator 本身不驻留，`schedule` 把 nightly 注册进系统定时器（macOS launchd / Linux crontab / Windows schtasks）：

```bash
# 注册每日 02:30 定时；--auto 3 = 夜里对 high 卡发起闭环并 drain 3 个（烧钱仅此档，合并仍人工）
node .agents/scripts/orchestrator.mjs schedule install --hour 2 --minute 30 --auto 3

# 只看会做什么，不动系统调度（写 wrapper + 打印注册计划）
node .agents/scripts/orchestrator.mjs schedule install --dry-run

node .agents/scripts/orchestrator.mjs schedule status      # 查注册状态与 wrapper
node .agents/scripts/orchestrator.mjs schedule uninstall   # 卸载
```

- 默认档（不带 `--auto`）零烧钱：只生成任务卡与报告，等人工 drain。
- **wrapper 固化绝对路径**：定时器经 `.agents/orchestrator/nightly-runner.sh|cmd` 以绝对路径启动，运行时不做环境发现——**仓库挪位置 / node 换路径后需重跑 `schedule install`**。launchd / crontab / schtasks 的平台细节以 [.agents/workflows/orchestrator.md](../.agents/workflows/orchestrator.md) 为准，此处不转写。

## 10. 与既有文档的分工

同一用法只有一处权威描述，本文与既有三份文档这样分工：

| 文档 | 定位 | 什么时候读 |
|---|---|---|
| 本文（`docs/ai-pipeline-guide.md`） | 贡献者端到端指南：从给意图到发版提案的全流程 | 第一次上手、想知道「整条流水线能做什么」 |
| [orchestrator-usage.md](orchestrator-usage.md) | 使用者手册：状态机、熔断、排障 | 命令行为不符预期、任务卡在奇怪的状态 |
| [.agents/workflows/orchestrator.md](../.agents/workflows/orchestrator.md) | agent 操作手册：全部话题的简版速查与平台细节 | 给 agent 下指令、查调度器/通知的平台细节 |
| [design-orchestrator.md](design-orchestrator.md) | 设计原理：架构、状态机与红线的设计依据 | 想改 orchestrator 本身 |

- 会话中的 agent 入口是 `/dockmaster` 技能（体系名 **Dockmaster（坞长）**，原 `/orchestrate`；[SKILL.md](../.agents/skills/dockmaster/SKILL.md)），按意图路由到本文描述的各条路径。
- 排障速查表见 [orchestrator-usage.md §7](orchestrator-usage.md)；中断任务的 worktree 清理见 [worktree-rescue.md](../.agents/workflows/worktree-rescue.md)。

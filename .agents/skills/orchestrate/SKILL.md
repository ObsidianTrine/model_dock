---
name: orchestrate
description: 显式斜杠技能——仅当用户输入 /orchestrate 时使用，不要因对话语义自动加载。驱动 .agents/scripts/orchestrator.mjs 自治闭环：拆任务卡、后台跑 headless worker、自动门禁与审查、合并到本地 develop（不 push 远程）。含三条路由路径：spec 三件套设计（先设计后施工）、nightly/schedule 定时巡检、release-propose 发版提案。
---

# orchestrate —— 把任务交给自治编排闭环

用户输入 `/orchestrate <任务描述>`（无描述则问一句要做什么）。你的角色是**编排者**：把任务拆成任务卡、启动闭环、处理闸门、汇报结果。改码的是 headless worker，不是你；你不直接 Edit/Write 仓库源代码。

## 第 0 步：意图路由与适用判定

先按意图特征分流（判断不了就问一句用户）：

| 意图特征 | 走法 |
|---|---|
| 目标明确的小改动（bugfix / 小功能 / 文档 / 测试） | **主流程**（下方第 1–4 步） |
| 特性级改动，用户要「先出设计/方案/spec」 | **路径 B**（spec 三件套，见文末） |
| 巡检 / 夜间自动化 / 定时任务 / schedule | **路径 C**（nightly / schedule，见文末） |
| 发版 / 盘点可发内容 / 版本号 | **路径 D**（release-propose，见文末） |

主流程的适用判定：验收标准可写成**可机器检查的断言**（测试命令、文件存在性、grep 模式）、改动范围清晰。不适合（拒绝并说明，建议手动走 feature-branch 工作流）：探索性/架构级改动（验收标准写不出来）、需要频繁人工决策、要动发布流水线的任务——特性级改动若用户接受「先设计」，转路径 B 而不是直接拒。

**同一个 task-id 不得与手动 feature-branch 混用**（worktree 会撞）。

## 第 1 步：拆任务、写任务卡

多任务就拆多张卡（按文件归属分区，减少互相阻塞）。卡片放任意临时路径（如 `.agents/orchestrator/drafts/<id>.md`，该目录不入库），内容模板：

```markdown
---
id: fix-user-presets-merge      # 小写短横线，即 feature 分支名，全局唯一
type: bugfix                    # bugfix | feature | docs | deps | refactor
priority: normal                # high 先跑
files_hint:                     # 预期改动范围——必须写准！
  - src/presets/**              # 越界会挡住自动合并、回人工闸门
workflows:
  - feature-branch
gate: L1                        # 固定写 L1（见下）
---

# 目标
一句话说清改什么、为什么。

# 验收标准
- `npm test` 全绿
- 新增用例覆盖：……（必须可机器检查）

# 背景（可选）
现象 / 复现步骤 / 相关文件。
```

**gate: L1 的语义**：审查 0 阻塞且实际改动分级为 L0/L1 时，orchestrator **自动合并到本地 develop**（含最终测试验证），全程不需用户审核；改动落在核心路径（`src/cli.ts`、`gateway/server|state`、`config/store|secrets`、`util/paths`、`package.json`）会被 L2 分级挡回 awaiting-human，由你在闸门处理（第 3 步）。不要写 L2（声明即被拒）；也不要写 L3——那会让每张卡都停下来等 approve，违背本技能的自动约定。

`budget` 可整体省略（默认 50 轮 / 500k tokens / 60 分钟 / 调试 5 次 / 审查 3 次）。

任务描述模糊、需要先探索仓库现状时，可用 Planner 代写：`node .agents/scripts/orchestrator.mjs intent "<一句话>"`——但它产卡强制 `gate: L3`，**submit 前把卡里的 gate 改成 L1** 再进闭环。

## 第 2 步：submit + 后台跑

```bash
node .agents/scripts/orchestrator.mjs submit <卡文件路径>   # 校验 schema，转 pending/
node .agents/scripts/orchestrator.mjs status               # 确认进了 pending
```

**闭环耗时从几分钟到几十分钟，必须后台执行**（Bash `run_in_background`），绝不同步等待：

- 单张卡：`node .agents/scripts/orchestrator.mjs run <task-id>`
- 多张卡：`node .agents/scripts/orchestrator.mjs drain`（循环清空队列；确需并发再加 `--workers N`，按 files_hint 分区互斥）

**引擎指定（对话可直接说）**：用户口头指定「执行用 X+模型 / 审查用 Y+模型」时，翻译成参数附加在 run/drain 后——`--worker-backend <claude-headless|zcode-headless|mock> --worker-model <m> --review-backend <…> --review-model <m>`。默认取 workflow.json 的 `worker`/`review`（当前：执行 zcode-headless、审查 claude-headless+opus）；用户没提就不传参。注意：zcode 无 `--model`（模型跟随 ZCode 默认，需用户在 App 内切换），模型项只对 claude 系生效。任务卡也可带 `tier: <名>` 按难度自动换服务与模型（配置与环境变量见 `.agents/workflows/orchestrator.md`「任务等级（tier）」节；仅 claude 系生效）。

run/drain 在非交互环境下不会停在人工闸门——到 awaiting-human 就打印提示退出；L1 自动合并的卡会一路跑到 merged。后台任务完成通知到达后继续第 3 步。

## 第 3 步：盯进度、处理闸门

等待期间可用 `status` / `logs <task-id>` 查看事件时间线（轮询即可，不必密集）。

后台 run 结束后 `node .agents/scripts/orchestrator.mjs status` 看每张卡落在哪：

- **merged/** → 已自动合并（或你 approve 后合并），完成。
- **awaiting-human/** → 意味着实际分级超 L1 / scope 越界 / drift 降级。用户已授权合并到本地 develop：你亲自 `git -C <worktree> diff develop...HEAD` 审阅改动 + 看 `logs <task-id>` 的审查结论，自行决定：
  - 无问题 → `approve <task-id>`（= feature-branch finish，rebase + 测试 + --no-ff 合并）；
  - 小缺陷可修 → `retry <task-id> --note "<补充指令>"`（打回重跑）；
  - 方向性错误 → `reject <task-id> --reason "<原因>"`（worktree 保留现场）。
  - **拿不准 / 审查有阻塞项且你无法判断** → 停下向用户汇报摘要请示，不要硬闯。
- **blocked/** / **failed/** → 按第 5 步异常处置。

## 第 4 步：收尾汇报

全部卡落定后逐任务汇报：改了什么（文件与要点）、测试与门禁结果、审查结论（阻塞/建议数）、合并 commit、耗时与 token 用量（可 `reconcile <task-id>` 对账）。**最后一行固定提示：已合并到本地 develop，未 push 远程，是否 push 由用户决定。**

## 路径 B：特性先设计（spec，Spec Kit/Kiro 式三件套）

适合：特性级改动，值得「先设计后施工」。入口命令 `spec "<意图>"`，Planner 只读会话产出 requirements（用户故事 + EARS 验收）→ design（方案/取舍/风险）→ tasks（任务段）三件套。**设计与施工分离，人工闸门在「审设计」这一步。**

1. `node .agents/scripts/orchestrator.mjs spec "<用户意图>"`（LLM 会话 1–5 分钟，后台跑）。
2. 完成后**向用户呈现三件套摘要**：requirements 的验收标准、design 的方案要点、tasks 的任务清单（每任务的文件范围与依赖），并提醒可直接手改 `.agents/orchestrator/specs/<id>/` 下的 md。
3. **停下等用户确认设计——你不能代审**。用户要求改就改完再确认。
4. 确认后 `node .agents/scripts/orchestrator.mjs spec build <id>` 拆卡进 pending/。
5. 卡默认 `gate: L3`（逐张等人 approve）。用户已在对话中明确授权自动合并时，可参照第 1 步对 intent 卡的同一处理：run 前把每张卡的 gate 改成 L1；分级裁决与 scope 纯度照常生效。
6. 之后回到主流程第 2–4 步（run/drain 后台跑、闸门处理、汇报）。

## 路径 C：巡检与定时调度（nightly / schedule）

1. **手动巡检**：`node .agents/scripts/orchestrator.mjs nightly`（后台；scan 落卡 + drift 报告 + 队列摘要，默认零烧钱不跑 worker）。跑完向用户汇报：新生成卡、待审任务、漂移状态；卡要不要 drain 由用户决定（要跑就回主流程第 2 步）。`--tests` 加慢信号源、`--auto N` 夜间档语义见 `.agents/workflows/orchestrator.md`。
2. **装定时**：先 `schedule status` 报现状；**用户明确要求才 install**——默认档零烧钱；`--auto N` 档夜间真跑 worker（烧钱），装前向用户说明并确认。装完报告：每日时刻、日志路径（`.agents/orchestrator/logs/nightly.log`）、卸载命令（`schedule uninstall`）。
3. **卸载/查询**：`schedule uninstall` / `schedule status` 直接执行并回报。

## 路径 D：发版提案（release-propose）

1. `node .agents/scripts/orchestrator.mjs release-propose [X.Y.Z]`（版本号可带用户口述值；不带则自动定档）。
2. 向用户汇报：建议版本与依据（feat/fix/breaking 计数、semver 档位）、疑似漏记清单、提案文件路径。
3. **版本号决定权在用户，到此为止**：用户说「发布 vX.Y.Z」后才走 `.agents/workflows/release.md`「代理发布」执行序（`AGENTS_ALLOW_RELEASE=1` 白名单）——**那不在本技能范围**（本技能终点是本地 develop，永不 push）。
4. 用户只采纳草稿时：可按提案在 develop 上收口 CHANGELOG（文档直改放行），同样不 push。

## 红线（永不）

- **禁止 push / tag 远程、禁止 npm publish**——本技能的合并终点是本地 develop；worker 会话已被 policy 硬拦，你自己也不得代为执行。
- **8687 / 8890 端口永不触碰**（监听、stop、重启、改配置一律禁止）——policy 已硬拦，你的命令同样不得包含。
- 不改 orchestrator 的门禁与熔断逻辑来"让任务通过"；红线门禁（port_scan / native_scan）失败 = 改设计，不可调试重试。
- 测试结束清理你拉起的全部临时进程（AGENTS.md 硬规则 4）。

## 异常处置速查（详表见 docs/orchestrator-usage.md §7）

| 现象 | 处置 |
|---|---|
| `blocked: budget:*` | 预算熔断。改卡调大 budget 后 `submit` 重提，或 `resume <task-id>` 续做 |
| 反复测试失败转 blocked | 调试迭代超限（默认 5 次）。`logs` 看失败尾部：能定位就 `retry` 带修复指令，否则报用户 |
| worker 零产出烧完 turns | `logs` 看 worker_turn 工具是否全被拒；多半是验收标准不可执行——改卡重提 |
| 红线门禁 failed | 不可调试，`abandon <task-id>`，向用户说明设计问题 |
| run 一直不动 | `status` 看是否解析失败卡 / 分区互斥排队；确认 Node ≥18、从仓库根目录运行 |

## 深入文档

- 使用指南（状态机、闸门交互、混合节奏）：`docs/orchestrator-usage.md`
- 操作手册（任务卡字段细节）：`.agents/workflows/orchestrator.md`
- 设计与原理：`docs/design-orchestrator.md`

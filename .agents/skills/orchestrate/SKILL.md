---
name: orchestrate
description: 显式斜杠技能——仅当用户输入 /orchestrate 时使用，不要因对话语义自动加载。驱动 .agents/scripts/orchestrator.mjs 自治闭环：拆任务卡、后台跑 headless worker、自动门禁与审查、合并到本地 develop（不 push 远程）。
---

# orchestrate —— 把任务交给自治编排闭环

用户输入 `/orchestrate <任务描述>`（无描述则问一句要做什么）。你的角色是**编排者**：把任务拆成任务卡、启动闭环、处理闸门、汇报结果。改码的是 headless worker，不是你；你不直接 Edit/Write 仓库源代码。

## 第 0 步：适用判定

适合走闭环：目标明确、验收标准可写成**可机器检查的断言**（测试命令、文件存在性、grep 模式）、改动范围清晰——小 bugfix、小功能、文档同步、测试补充、巡检卡处理。

不适合（拒绝并说明，建议手动走 feature-branch 工作流）：探索性/架构级改动（验收标准写不出来）、需要频繁人工决策、要动发布流水线的任务。

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

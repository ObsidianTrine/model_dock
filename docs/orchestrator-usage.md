# Orchestrator 使用指南

> 面向使用者（人或 agent）的实操手册。架构与设计决策见 `docs/design-orchestrator.md`；
> 简版命令速查见 `.agents/workflows/orchestrator.md`。本文回答三件事：怎么用、和 feature-branch 是什么关系、agent 会不会自动触发。

## 1. 一句话模型

**任务卡进、合并出**：写一张任务卡 → orchestrator 起 worker（headless Claude Code）在独立 worktree 里改代码 → 自动跑测试/build/红线门禁 → 失败自动喂回修 → LLM 独立审查 → 达标后按任务卡声明的级别**自动合并或等你点头**。

## 2. 与 feature-branch 工作流的关系：**包含关系，不是并列**

orchestrator **完全复用** feature-branch 工作流，是它的自动化外壳：

| 机制 | 归属 | 说明 |
|---|---|---|
| worktree 创建/清理、分支命名 | feature-branch.mjs | orchestrator 的 `run` 内部调 `feature-branch start`，`approve` 内部调 `feature-branch finish` |
| NOTES.md 交接 | feature-branch 约定 | worker 崩溃恢复时读取它续做；finish 时自动清除 |
| 基准分支直改拦截 | guard-develop hook | 对 orchestrator 的 worker 同样生效（编辑被限制在 worktree 内） |
| 合并方式 | feature-branch finish | 自动合并与人工 approve 走**同一条** `--no-ff` 合并路径（含最终 testCmd 验证） |

因此：**两者不会打架，也不需要二选一**。你自己开发任务时照常 `feature-branch start → 改 → finish`；把任务交给自治闭环时用 orchestrator。唯一要避免的是**同一个 task-id 混用**两种方式（worktree 会撞）。

## 3. agent 会自动触发吗？——**不会，全部由人显式启动**

orchestrator 没有常驻进程、没有后台 daemon、没有任何自动触入口：

- `run` / `drain` / `scan` 都是你（或你让 agent）在终端里**显式执行**的命令；
- nightly 巡检 = 你自己用 cron / 计划任务定时调 `scan` 命令，orchestrator 本身不装定时器；
- `scan` 只生成任务卡进 `pending/`，**绝不自动 run**——是否执行由人决定；
- 自动合并只发生在"任务已在跑"的闭环内部（L0/L1 改动 + 审查 0 阻塞 + 无降级），不存在"自己冒出来一个任务并合并"的路径；
- 红线硬编码：8687/8890 端口、`git push`/`tag`、`npm publish` 对 worker 永久拦截，任务卡写了也没用。

## 4. 最小上手路径

### 4.1 给意图（一句话）——推荐路径

```bash
# Planner 自动探索仓库、编译任务卡（验收标准可机器检查化），gate 固定 L3（合并前人工审核）
node .agents/scripts/orchestrator.mjs intent "修复 presets.json 同名 id 未覆盖内置预设的问题"
# 复杂任务先看草稿再提交（确认路径）
node .agents/scripts/orchestrator.mjs intent "重构日志模块" --draft
# 巡检出的 high 信号卡（漏洞/测试失败）自动发起闭环（合并仍人工）
node .agents/scripts/orchestrator.mjs scan --tests --run
```

Planner 产出的卡 `created_by: planner`，独立审查会额外检查其验收标准是否空洞；不放心就用 `--draft`。**手写任务卡仍是完全有效的路径**（下方 4.2）——当你想精确控制验收标准时用它。

### 4.2 手写任务卡（精确控制时用）

```markdown
---
id: fix-user-presets-merge        # 小写短横线，= feature 分支名
type: bugfix                      # bugfix | feature | docs | deps | refactor
priority: normal                  # high 先跑
files_hint:                       # 预期改动范围——写准！影响纯度检查/审查/并行调度
  - src/presets/**
workflows:
  - feature-branch
gate: L3                          # 合并闸门：L3=人工（缺省，最保守）；L1=普通改动可自动合并；L0=纯文档可自动
budget:                           # 可整体省略（回落默认 50轮/500k tok/60分钟/调试5次/审查3次）
  max_wall_minutes: 40
---

# 目标
一句话说清改什么、为什么。

# 验收标准            ← 可机器检查！orchestrator 亲自跑门禁，worker 拿它当靶子
- `npm test` 全绿
- 新增用例覆盖：同名 id 覆盖、新 id 追加

# 红线（可选）
- 不改动 src/cli.ts
```

**gate 怎么选**：默认 L3（全人工，最稳）。纯文档/测试任务可写 `L0`，普通 src 任务可写 `L1`——审查通过且实际改动分级不超上限时自动合并，否则自动回人工。核心路径（`src/cli.ts`、`gateway/server|state|relay`、`config/store|secrets`、`util/paths`、`package.json`）一律 L2 永人工，声明了也会被拒绝。

### 4.2 跑闭环

```bash
node .agents/scripts/orchestrator.mjs submit my-task.md    # 校验并进队列
node .agents/scripts/orchestrator.mjs run <task-id>        # 跑单个（先 --backend mock 可空跑流程）
node .agents/scripts/orchestrator.mjs status               # 任意时刻看队列/事件时间线
node .agents/scripts/orchestrator.mjs logs <task-id>       # 单任务完整事件链
```

真实 worker 的流量走你本机网关（吃狗粮），成本随时可查：

```bash
node .agents/scripts/orchestrator.mjs reconcile [task-id]  # 自报 token vs 网关实测
```

### 4.3 批量推进（队列自动化）

```bash
node .agents/scripts/orchestrator.mjs run --next           # 跑优先级最高的 pending
node .agents/scripts/orchestrator.mjs drain                # 循环清空队列（单任务熔断不阻塞后续）
node .agents/scripts/orchestrator.mjs drain --workers 3    # 并发 3（按 files_hint 分区互斥，可能重叠的任务自动排队）
```

### 4.4 巡检与维护

```bash
node .agents/scripts/orchestrator.mjs scan                 # TODO/npm audit → 生成任务卡（不 run）
node .agents/scripts/orchestrator.mjs scan --dry-run       # 先看会生成什么
node .agents/scripts/orchestrator.mjs drift                # 自动合并健康度（回溯失败率>20% 自动降级全人工）
node .agents/scripts/orchestrator.mjs drift --clear        # 人工确认后恢复自动合并
```

### 4.5 人工闸门与善后

```bash
node .agents/scripts/orchestrator.mjs approve <task-id>            # 批准合并（= feature-branch finish）
node .agents/scripts/orchestrator.mjs reject <task-id> --reason "…"# 驳回（worktree 保留现场）
node .agents/scripts/orchestrator.mjs retry <task-id> --note "…"   # 打回重跑（附补充指令）
node .agents/scripts/orchestrator.mjs resume <task-id>             # 崩溃/熔断后续做（带现场）
node .agents/scripts/orchestrator.mjs abandon <task-id>            # 放弃（worktree 按 Rescue 手册人工清）
```

`run` 在交互终端会在闸门处直接问（a 批准 / v 看 diff / r 驳回 / b 打回 / q 搁置）；脚本/CI 非交互时打印提示后退出，用上面的命令异步处理。

## 5. 状态地图（任务卡在哪、下一步是什么）

```
pending → running → reviewing → awaiting-human → merged
             │  ↑       │  ↑            │
             │  └返工    │  └审查阻塞回   ├ approve → merged
             │熔断/stuck │              ├ reject  → failed/
             ▼          │              └ retry   → running
          blocked ───────┘ resume → running ／ abandon → failed
```

运行态（`queue/`、`logs/`、`degraded.json`、审计 `audit.jsonl`）都不入 git，崩溃后按 `running/` + 事件日志恢复。

## 6. 什么时候用 orchestrator、什么时候自己 feature-branch

- **适合交给 orchestrator**：目标明确、验收标准可机器检查、改动范围清晰的任务——bug 修复、小功能、文档同步、测试补充、巡检卡处理。
- **不适合**：探索性/架构级改动（验收标准写不出来）、需要频繁人工决策的任务、要动发布流水线的工作（L3 红线）。
- **混合节奏**：大任务自己 feature-branch 做，顺手把可独立验收的小修小补写成任务卡丢进队列，`drain` 消化。

## 7. 排障速查

| 现象 | 处置 |
|---|---|
| worker 起步就没产出、烧完 turns | 检查任务卡验收标准是否可执行；`status <id>` 看 worker_turn 里工具是否全被拒（权限白名单问题） |
| `blocked: budget:*` | 预算熔断（第三方上游流式 usage 全 0 时 token 熔断不可依赖，靠 wall-clock/turns）。`resume` 续做或调大 budget |
| 反复测试失败转 blocked | 调试迭代超限（默认 5 次）。`logs` 看失败尾部，人工接手或改卡重提 |
| 红线门禁 failed | port_scan/native_scan 不可调试——改设计不改门禁 |
| drain 停住不动 | `status` 看是否解析失败卡/分区互斥排队；执行环境损坏时同任务两次调度会被拉黑并告警 |
| 自动合并没有发生 | `logs` 查 `change_classification` 与 `awaiting_human` 的 reason（超 gate 上限/scope 越界/drift 降级），确认 `drift` 状态 |
| 审查卡住 | reviewer 是只读会话（Read/Glob/Grep 白名单），若 verdict 解析不到按有阻塞保守处理 |

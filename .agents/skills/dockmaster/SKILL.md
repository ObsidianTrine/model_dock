---
name: dockmaster
description: Dockmaster（坞长）调度台——用户输入 /dockmaster，或用自然语言指名派活（「让 dockmaster/坞长做 X」「派个任务给 dockmaster」「用前进2跑…」「开船：修一下 X」）时使用。驱动 .agents/scripts/orchestrator.mjs 自治闭环：拆任务卡、后台跑 headless worker、自动门禁与审查、合并到本地 develop（不 push 远程）。支持对话指定档位（前进1-4）、引擎（harness）与服务商/模型。路由路径：spec 三件套设计（先设计后施工）、nightly/schedule 定时巡检与提案审阅、watch 连续自治运行、propose 需求综合（autopilot）、release-propose 发版提案。仅当用户指名 Dockmaster 或明确要派自治任务时加载；只是提及 dockmaster 而非派活时先问一句，不要抢跑。
---

# dockmaster —— Dockmaster 港务调度台

> **Dockmaster（坞长）** = 本仓库 `.agents/` 自治编排体系的名字；命令行仍是 `orchestrator.mjs`。对每艘出航的船它是船长，对整支船队它是坞长——harness 是船、大模型是发动机、船东（用户）递托运单等出港（完整灵魂叙事见 `.agents/workflows/orchestrator.md` 开头「Dockmaster 是什么」）。速查与分区详解见同文（A 核心闭环 / B 自主模式 / C 观测对账 / D 周边）。
> 本技能原名 /orchestrate，2026-11 随体系定名 Dockmaster 改为 /dockmaster（命名缘由见 .agents/workflows/orchestrator.md 开头）。

**一句话派活**：「帮我优化 README，前进1」「让 dockmaster 修 XPLAT-09，前进3」「开船：审查用 zcode」。你的职责：把这句话翻译成托运单（任务卡）、按档位派船、盯闸门、汇报结果——**自动做完所有决策，最多问一个问题**，其余在汇报里说明「选了什么、为什么、怎么说一声就改」。改码的是 headless worker，不是你；你不直接 Edit/Write 仓库源代码。完整手册在 `.agents/workflows/orchestrator.md`，本技能只留调度台最小操作。

## 第 1 步：一句话翻译（任务 + 档位 + 船 + 卡）

**档位 = 船 + 油，一张表定死**（用户说「前进N」按此绑定；中文数字「前进四」与口语「慢车/全速/旗舰」同义）：

| 档位 | 船（--worker-backend） | 油 | 适用 |
|---|---|---|---|
| 前进1 | zcode-headless（默认船） | 免费 | 纯文档/测试小改 |
| 前进2 | zcode-headless（默认船） | 免费 | 常规轻活 |
| 前进3 | claude-headless（ModelDock 网关供油） | 计费 | 常规重活 |
| 前进4 | claude-headless + tier ahead-4 | 计费 | 核心/发布路径、复杂特性 |

- **没说档位就自动选**：文档/测试→前进1，代码小改→前进3，核心路径/复杂→前进4；**卡里写明所选档位，汇报第一句告知**，用户说「换前进N」即重派。
- 船 ≠ workflow.json 默认（zcode-headless）时附 `--approve-backend-switch`——**用户口头指定档位/引擎即人工批准**，汇报注明「引擎切换已获你本次口头批准」（自动跑中永远禁止自行切换，红线见下）。即：前进3/4（claude 网关船）带批准标志，前进1/2 零摩擦。
- 用户另指定模型/服务商：`--worker-model <模型名>`（ModelDock 网关按模型名路由服务商）；「审查用 zcode / 某模型」→ `--review-backend zcode-headless` / `--review-model <m>`（异构互审防共因盲区）。档位与显式模型可叠加，显式优先。
- 适用判定（不合适就拒绝并说理由）：验收标准写得出**可机器检查的断言**才收单；探索性/架构级改动 → 建议路径 B（先设计后施工，见文末）。**同一个 task-id 不得与手动 feature-branch 混用**（worktree 会撞）。

**写卡**（放 `.agents/orchestrator/drafts/<id>.md`，不入库；多任务拆多卡按文件分区）：

```markdown
---
id: <小写短横线，即 feature 分支名，全局唯一>
type: docs                        # bugfix | feature | docs | deps | refactor
priority: normal                  # high 先跑
files_hint:                       # 预期改动范围——必须写准，越界挡自动合并
  - docs/**
workflows:
  - feature-branch
gate: L1                          # 审查 0 阻塞且实际改动 L0/L1 → 自动合并；核心路径自动被 L2 挡回人工
tier: ahead-1                     # 第 1 步翻译出的档位；自动选档也显式写（观测与重派有据）
---

# 目标
一句话：改什么、为什么。

# 验收标准
- `npm test` 全绿；<再加具体行为/内容断言——可机器检查，这是 worker 自查靶子、验船师评判基准、船东验收清单>

# 航次计划（可选；复杂卡填写：3-6 检查点 + 备选路线）
# 背景（可选）
```

`gate` 固定 L1（不要写 L2——声明即拒；L3 会让每卡停等人，违背自动约定）。`budget` 省略即默认（50 轮/500k tokens/60 分钟）。任务模糊需探索仓库时用 Planner 代写：`node .agents/scripts/orchestrator.mjs intent "<一句话>"`——产卡 gate=L3，**submit 前改 L1**。

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
tier: ahead-2                   # 可选：用户说「前进N」才写 ahead-N；没提就整行省略（全局默认路由）
---

# 目标
一句话说清改什么、为什么。

# 验收标准
- `npm test` 全绿
- 新增用例覆盖：……（必须可机器检查）

# 航次计划（可选；建议复杂卡填写）
- 检查点 1：先做什么 + 怎么验证
- 备选路线：若 X 不通则 Y

# 背景（可选）
现象 / 复现步骤 / 相关文件。
```

**gate: L1 的语义**：审查 0 阻塞且实际改动分级为 L0/L1 时，orchestrator **自动合并到本地 develop**（含最终测试验证），全程不需用户审核；改动落在核心路径（`src/cli.ts`、`gateway/server|state`、`config/store|secrets`、`util/paths`、`package.json`）会被 L2 分级挡回 awaiting-human，由你在闸门处理（第 3 步）。不要写 L2（声明即被拒）；也不要写 L3——那会让每张卡都停下来等 approve，违背本技能的自动约定。

`budget` 可整体省略（默认 50 轮 / 500k tokens / 60 分钟 / 调试 5 次 / 审查 3 次）。

任务描述模糊、需要先探索仓库现状时，可用 Planner 代写：`node .agents/scripts/orchestrator.mjs intent "<一句话>"`——但它产卡强制 `gate: L3`，**submit 前把卡里的 gate 改成 L1** 再进闭环。

## 第 2 步：submit + 后台跑

```bash
node .agents/scripts/orchestrator.mjs submit <卡文件路径>    # 校验 schema，pending/ 待泊
node .agents/scripts/orchestrator.mjs run <task-id> --worker-backend <船> --approve-backend-switch?   # 单卡闭环（档位对应的船，见第 1 步表）
node .agents/scripts/orchestrator.mjs drain                  # 多卡清队列（--workers N 并发，按 files_hint 分区互斥）
```

**必须后台执行**（Bash `run_in_background`），绝不同步等待。闭环几分钟到几十分钟；引擎起不来（CLI 缺失/429）时**禁止自行换引擎**，退避重试，连续 2 轮失败停下向用户申请批准。后台完成通知到达后进入第 3 步。

## 第 3 步：盯进度、处理闸门

轮询观测（不必密集）：`status` 队列全貌；`status <task-id>` / `logs <task-id>` 事件时间线（worker_spawned→worker_turn→gate_result→review_verdict…）；现场看 `.agents/worktrees/<task-id>/NOTES.md`（复诵 + 航次计划 + 进度）。用户中途补要求：`follow <task-id> "<补充指令>"`（会话边界送达，不必打回重跑）。

落位处置：
- **merged** → 完成（L1 自动合并进本地 develop）。
- **awaiting-human** → 你亲自看 diff 与审查结论，三选一：`approve`（合并）/ `retry --note`（打回）/ `reject --reason`（废弃）；**拿不准就停下向用户请示**。
- **blocked / failed** → 异常处置速查（文末）。

## 第 4 步：收尾汇报

全部卡落定后逐任务汇报：改了什么（文件与要点）、测试与门禁结果、审查结论（阻塞/建议数）、合并 commit、耗时与 token 用量（可 `reconcile <task-id>` 对账）。**最后一行固定提示：已合并到本地 develop，未 push 远程，是否 push 由用户决定。**

## 其他路径（细节见手册对应节，这里只留闸门纪律）

- **先设计后施工（spec）**：特性级改动用 `spec "<意图>"` 出三件套——**设计必须用户亲自确认后才能 `spec build` 拆卡**（你不能代审）；拆出的卡 gate=L3，用户口头授权自动合并后可改 L1。
- **巡检与提案（nightly / scan）**：`nightly` 零烧钱出提案落 drafts；逐张给用户一句话采纳建议，点头后 `submit`。`--plan` 烧钱跑 planner 需求综合。`autopilot.enabled` 开启后白名单提案自动提交（deps/核心路径/人工草稿永不自动）——开启属持久授权，**代改配置前必须先确认**。
- **连续自治（watch）**：`watch --interval 30` 后台常驻；停止 `touch .agents/orchestrator/.watch-stop`；drift 降级自动退出（向用户说明 `drift --clear` 恢复）；与手动 drain 共用调度器锁，勿并发。
- **发版提案（release-propose）**：只出建议与草稿；**版本号决定权在用户**——用户说「发布 vX.Y.Z」才走 release.md 代理发布（不在本技能，永不 push）。

## 红线（永不）

- **禁止 push / tag 远程、禁止 npm publish**——合并终点是本地 develop；worker 被 policy 硬拦，你也不得代执行。
- **8687 / 8890 端口永不触碰**（监听/stop/改配置一律禁止）。
- 不改门禁与熔断逻辑来「让任务通过」；红线门禁（port_scan / native_scan）失败 = 改设计，不可调试。
- 自治跑中引擎故障**禁止自行换引擎**（切换=换计费方，必须用户批准）；测试结束清理你拉起的全部临时进程。

## 异常速查（详表 docs/orchestrator-usage.md §7）

| 现象 | 处置 |
|---|---|
| `blocked: budget:*` / 迭代超限 | 预算/迭代熔断（永不静默重试）：`resume` 续做或改卡 `submit` 重提 |
| 反复测试失败 | `logs` 看失败尾部：能定位就 `retry --note` 带修复指令，否则报用户 |
| 红线门禁 failed | 不可调试，`abandon <task-id>`，向用户说明设计问题 |
| run 不动 | `status` 看解析失败卡/分区排队；确认 Node ≥18、从仓库根目录运行 |

## 深入文档

- 使用指南（状态机、闸门交互、混合节奏）：`docs/orchestrator-usage.md`
- 操作手册（任务卡字段细节）：`.agents/workflows/orchestrator.md`
- 设计与原理：`docs/design-orchestrator.md`

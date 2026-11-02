# Dockmaster 操作手册（.agents 自治编排体系）

> **Dockmaster（坞长）** 是本仓库 `.agents/` 自治编排体系的名字——ModelDock 的 Dock，管坞的人就是 dockmaster。**命令行名保持 `orchestrator.mjs` 不变**（改名零收益、破坏既有引用与肌肉记忆）；文档用港口隐喻叙事（官方映射表见下），接口名保持 orchestrator 不变。
> 目标读者：递交托运单（任务卡）、看闸门、处理搁浅（blocked）任务的 agent / 人类操作者。
> 设计与原理：`docs/design-orchestrator.md`（本文只讲怎么用）。运行前提：主仓库根目录运行；Node ≥18；零第三方依赖。

## Dockmaster 是什么（船 · 发动机 · 船长）

每一次编码任务，都是一次航行。

**Harness 是航行在海上的船**——Claude Code、ZCode、dsh，是三家船厂造的不同船型；**大模型是船的发动机**——GLM、Claude、Kimi，可按航程换装功率不同的引擎（tier 就是车钟档位：前进1-4），燃油由 ModelDock 港统一供给与计量（网关路由，`reconcile` 对账 = 航海日志 vs 油耗表）；**Dockmaster 是船长**——接过船东（你）的托运单（任务卡），指挥发动机推船离泊，沿航道（门禁与审查关卡）驶向目的地（验收标准）：风暴中紧急抛锚自保（熔断），搁浅时组织拖救（`resume`），请验船师检验（reviewer），等船东签单放行（approve）才算出港（merged）。

对一艘船，Dockmaster 是**船长**；对整支船队，它是**坞长**——瞭望模式（watch）盯住每一条船，罗盘（goals.md）校准每一条航线，自动舵（autopilot）让放心的航线自主航行。船东不必出海：**递单、审提案、放行，三次出现足矣。**

```
船东（你）              递托运单 · 审提案 · 放行出港
   ▲│
   │▼
Dockmaster（船长兼坞长）  接单派船 · 掌舵指挥 · 检验把关 · 航海日志（events / stats）
   ▲│
   │▼
船（harness）            Claude Code 号 / ZCode 号 / dsh 号——海上执行者
   ↕
发动机（大模型）          GLM / Claude / Kimi——动力可换装（tier 档位）
   ↕
ModelDock 燃油库（网关）  统一供油 · 按航次计量（reconcile 的实测账）
```

一句话定位：跑在本机的**自治编码代理编排系统**——它不造船（不用 agent 框架重写 agent），只指挥现成的 agent 船队自动完成从接单到交付的全航程。

## 一张图看懂

```
需求侧（船东递交托运单）
         intent / spec ─────────┐
         巡检 scan ──→ drafts/（待审托运申请）── submit ──→ pending/（待泊）─┐
         autopilot（自动舵）白名单自动提交（缺省关）─────────────────────────┤
                                                                            ▼
执行侧（出航作业）
         run / drain / watch ─→ 派出作业船（worker）在泊位（worktree）修船
                                  → 坞检（静态门禁）→ 验船师（LLM 独立审查）
                                                        │返工循环│
                                  L0/L1 自动合并 ←──── 合并闸门 ──┘
                                         │ 否则
                                         ▼
                                  awaiting-human/（等待船东放行：人工 approve / reject / retry）→ merged（出港）

观测侧（港务台）
         status · logs · stats · follow · drift · reconcile      （全程 events.jsonl 留痕）
```

一句话：**任务卡进、合并出**（托运单进坞、验毕出港）。人（船东）只出现在两处——审提案（drafts/）与审合并（awaiting-human/）；其余环节 worker→门禁→调试循环→审查→返工循环全自动，熔断（紧急抛锚）兜底不烧钱。
船东视角全景：递交托运单 → 船长派出作业船（worker）在泊位（worktree）修船 → 坞检（静态门禁）+ 验船师（reviewer）双重检验 → 船东放行出港（merged）；搁浅（blocked）的船由船长组织拖救（`resume`），紧急抛锚（熔断）永远要船东裁决。

**官方映射表**——双层命名纪律：**比喻词只进文档层（首次出现括注原术语）；命令名 / 目录名 / frontmatter 字段 / 事件类型 / workflow.json 键名是接口契约，永不改名。**

| 概念 | 隐喻词 | 接口名（不动） |
|---|---|---|
| 体系 | 船长兼坞长 / 港务 | Dockmaster / `orchestrator.mjs` |
| 任务卡 | 托运单（目的地=目标，交货标准=验收标准） | task card |
| harness | 船型（Claude Code 号 / ZCode 号 / dsh 号） | harness |
| 大模型 | 发动机（tier = 车钟档位：前进1-4，接口键 ahead-1..4） | model |
| ModelDock 网关 | 燃油库（统一供油、按航次计量） | gateway |
| worktree | 泊位 | worktree |
| pending | 待泊 | pending |
| blocked | 搁浅（resume = 拖救） | blocked |
| drafts 提案 | 待审托运申请 | drafts / proposal |
| goals.md | 罗盘 | goals.md |
| nightly | 夜航巡港 | nightly |
| follow | 引水传令 | follow |
| worker | 派出作业的船（船上自带全套工匠工具） | worker |
| LLM 审查 | 验船师 | reviewer |
| awaiting-human | 等待船东放行 | awaiting-human |
| merged | 出港 | merged |
| 熔断 | 紧急抛锚 | circuit breaker |
| watch | 瞭望模式 | watch |
| sail | 自由航行（时间盒完全自治，到点交航海报告） | sail |
| autopilot | 自动舵 | autopilot |

## 速查（日常就这几条）

> 比喻词对照见上方官方映射表；本节命令与目录名是接口契约，照抄可用。

**核心闭环——把一张卡跑到合并**

| 命令 | 干什么 |
|---|---|
| `intent "<一句话>"` | Planner 只读探索仓库，编译任务卡进队列（gate=L3，合并前人工审） |
| `submit <卡文件>` | 手写卡 / drafts 提案进队列 |
| `run <task-id>` | 单卡闭环：worker → 门禁 → 审查 → 合并闸门 |
| `drain [--max N] [--workers N]` | 循环清空 pending 队列（并发按 files_hint 分区互斥） |
| `approve / reject / retry` | 人工闸门三选一（批准合并 / 驳回 / 带补充指令打回） |

**自主模式——少人值守**

| 命令 / 配置 | 干什么 |
|---|---|
| `scan` | 巡检 6 类信号出提案，落 drafts/（**不进队列**） |
| `propose` | planner 按 goals.md 综合高质量提案（烧钱动作） |
| `nightly [--plan] [--auto N]` | 一次完整巡检编排；`schedule` 注册成每日定时 |
| `watch` | 连续自治循环：drain → 队列空时 scan+propose → 休眠 |
| `sail --minutes N` | 自由航行：时间盒完全自治（勘察→规划+自动提交→执行循环），到点收帆交航海报告 |
| `drill` | 弃船演习：临时港 mock 全链跑一张合成托运单，验证港口闭环自身健康（不烧真钱、不碰真队列） |
| workflow.json `autopilot` | 白名单提案自动提交（**缺省关**；deps/核心路径/人工草稿永不自动） |

**观测与对账**

| 命令 | 干什么 |
|---|---|
| `status [task-id]` | 队列全貌 / 单卡事件时间线 |
| `logs <task-id>` | 完整事件流 |
| `stats [--days N] [--json]` | 运行度量基线（wall/turns/迭代/token/合并率） |
| `follow <task-id> "<指令>"` | 给**运行中**的任务递补充指令（会话边界送达） |
| `drift [--clear]` | 自动合并健康度（失败率超阈值降级全人工） |
| `reconcile` | token 用量对账（自报 vs 网关实测）+ 卡状态对账 |

**出问题怎么办**

| 现象 | 动作 |
|---|---|
| 卡在 blocked/（搁浅） | `logs` 看原因 → `resume`（带现场续做）/ `abandon` / 改卡重提 |
| 卡在 awaiting-human/（等待船东放行） | 亲看 diff + 审查结论 → `approve` / `retry --note` / `reject` |
| 卡在 failed/（退关） | 红线门禁（端口/native）= 改设计不可调试；或人工驳回 |
| worker 引擎起不来 | 预检直接拒绝启动（零消费）：修 ORCH_ZCODE_CLI / claude 登录后重跑 |
| 紧急抛锚了（熔断，circuit_breaker 事件） | 预算/迭代/看门狗触发，**永不静默重试**——人工决策后再继续 |

详细机制按需查：**A 核心闭环 · B 自主模式 · C 观测对账 · D 周边**。

---

## A. 核心闭环详解

### A1. 任务卡怎么写（验收标准可机器检查是灵魂）

```markdown
---
id: fix-user-presets-merge       # 小写短横线，即 feature-branch task-id
type: bugfix                     # bugfix | feature | docs | deps | refactor
priority: normal                 # high 先跑
created_at: 2026-10-01T10:00:00+08:00
created_by: human
budget:                          # 可整体省略（回落默认 50 轮/500k tokens/60 分钟/调试 5 次/审查 3 次）
  max_turns: 50
  max_tokens: 500000
  max_wall_minutes: 60
files_hint:                      # 预期改动范围（glob），越准并发性与纯度检查越好
  - src/presets/**
workflows:                       # 注入 worker 的 playbook（至少 feature-branch）
  - feature-branch
gate: L1                         # 允许自动合并的级别上限：L0 仅文档测试 / L1 常规 / L3 全人工
fastlane: true                   # 可选：跳过 LLM 审查省最大开销（只省审查不省闸门，见 A8）
tier: ahead-3                    # 可选：车钟档位 前进1-4（接口键 ahead-1..4，旧 heavy/light 兼容；见 A4）；缺省命中核心路径自动升 前进4
ui_check: true                   # 可选：改 Web 控制台任务开启 UI 冒烟门禁（见 A8）
---

# 目标
一句话说清"改什么、为什么"。

# 验收标准
- `npm test` 全绿
- 新增用例覆盖：同名 id 覆盖、新 id 追加、格式错误阻断启动

# 红线（可选）
- 不改动 src/cli.ts

# 航次计划（可选；建议复杂卡填写）
- 检查点 1：先做什么 + 怎么验证
- 检查点 2：再做什么 + 怎么验证
- 备选路线：若 X 不通则 Y

# 背景（可选）
现象、复现步骤、相关文件。
```

**门禁按实际改动面分级**：全部改动为 `.md`（纯文档卡，实际分级 L0）时，npm_test 门禁自动改跑 workflow.json `testCmdL0` 轻量命令（本仓库 = docs-lint 测试），tsc_build 跳过——不烧全量回归；含代码改动照旧全量（gate_result 事件带 `scoped: l0` 标记可审计）。**验收标准是灵魂**：作业船（worker）拿它当航海目的地、审查者（验船师）当评判基准、人（船东）当验收清单。写"做得好用一点"等于没写。**自报不可信**——orchestrator 亲自跑 testCmd 与 build 复核（含缓存读的 token、失败尾部 200 行都有据可查）。航次计划段（SOLAS V.34 计划先行）要求 3-6 个检查点、每个一句话「做什么 + 怎么验证」、末尾一行备选路线；planner / propose 产卡会自动补写该段。

`run` 在 TTY 下会在人工闸门处交互（a 批准 / v 看 diff / r 驳回 / b 打回 / q 搁置）；非 TTY 打印提示后退出，用 approve/reject/retry 异步处理。

### A2. 泊位状态机（哪里找我的任务）

```
pending（待泊）→ running（在坞作业）→ reviewing（验船）→ awaiting-human（等待船东放行）→ merged（出港）
                  │           │                       │
                  ↓           ↓ 审查阻塞回 running    ├─ reject → failed/（退关）
               blocked                             └─ retry  → running
              （搁浅）
                  │
                  └─ resume（拖救）→ running ／ abandon → failed/（退关）
```

- **blocked/（搁浅）**：worker 自报 stuck、预算/迭代熔断（紧急抛锚）、异常结束。人接手：`resume`（注入事件时间线 + NOTES.md 现场续做，坞长组织拖救）或 `abandon`（转 failed/，worktree 按 `worktree-rescue.md` 清理）。
- **failed/（退关）**：红线门禁或人工驳回。**红线失败不可调试——改设计，别改门禁**。
- 运行态（queue/、logs/）不入库；崩溃后重启即从 running/ + events.jsonl 恢复。
- pending（待泊）的卡若属受限航道（`type: deps` 或 files_hint 命中核心/发布路径），开航前需人工引水确认：`run <id> --pilot-approved`（见 B0 引水闸）；未确认的卡在 drain 中被跳过并列入「待引水」清单，队列保留不动。

### A3. 紧急抛锚（熔断）与看门狗（自动停，不会烧钱）

| 触发 | 行为 |
|---|---|
| 轮次 / token / wall-clock 超预算 | kill 进程树 → blocked |
| 测试修复超 `max_test_iterations` / 审查返工超 `max_review_iterations` | blocked（附失败尾部） |
| 看门狗（`watchdog.mode: actuate`）连续 2 次判定无实质进展 | kill → blocked |
| 燃油 80%（token/wall） | 软告警 `budget_low_fuel` + 引水传令自动注入收尾令（不熔断） |

全部记 `circuit_breaker` 事件，**永不静默重试**。看门狗缺省 observe 档：每 20 个 worker turn（`watchdog.everyTurns`）由一次性只读 LLM 判断是否空转，疑似只记 `watchdog_suspect`；actuate 是显式配置。每任务最多查 5 次，自身故障记 `watchdog_error`（≤3 条后静默）。瞬时故障（429/网络签名）原地退避重试 60s×attempt ≤3 次（`worker_retry` 留痕），不算熔断。

### A4. 后端与 tier（执行/审查各用什么引擎与模型）

- **后端**：`--backend mock|claude-headless|zcode-headless`。缺省沿用上次会话；mock 只测闭环本身。**本仓库默认 `worker.backend: zcode-headless`（默认船、免费；2026-11-01 冒烟实测 headless 可用，10-29 旧结论过时）**，审查 claude-headless+glm-5.3-flash 构成异构互审（zcode 干活 + claude 验船）；claude-headless 是前进3/4 的网关船——claude CLI 经 `~/.claude/settings.json` 指向本机 ModelDock 网关（127.0.0.1:8687）供油，切换须口头批准（`--approve-backend-switch`）。zcode-headless 设 `ORCH_ZCODE_CLI=<zcode.cjs 绝对路径>`；headless 无 `--max-turns`（轮次熔断不可用，wall-clock/token 熔断直接杀进程树），prompt 走 argv 超 30000 字符快速失败。**引擎切换人工闸门**：最终引擎 ≠ workflow.json `worker.backend` 即拒绝启动（resume 沿用也不豁免），须 `--approve-backend-switch` 或 `ORCH_APPROVE_BACKEND_SWITCH=1`——切换引擎=切换计费方，必须过人（2026-10-29 夜跑静默换引擎烧穿账单的事故防线）。
- **异构审查**：执行与审查是两个独立会话。审查引擎解析顺序：`--review-backend` 显式 > workflow.json `review.backend` > 上次 `review_spawned` 事件（retry/resume 不换审查引擎）> **自动异构**（自动选另一个可用的真实引擎，如 claude 干活 / zcode 审查；mock 永不异构）> 回落同源（记 `review_backend_fallback`）。**去相关的关键是引擎异源——只拆会话不换引擎仍有共同盲区**。
- **tier 车钟档位（前进1-4，接口键 ahead-1..4）**：按航程难度选服务与模型——
  | 档位 | 接口键 | 适用 | tokenEnv |
  |---|---|---|---|
  | 前进1 | `ahead-1` | 纯文档/测试小改（最省） | `MDK_TIER_AHEAD1_TOKEN` |
  | 前进2 | `ahead-2` | 常规轻活 | `MDK_TIER_AHEAD2_TOKEN` |
  | 前进3 | `ahead-3` | 常规重活（默认推荐） | `MDK_TIER_AHEAD3_TOKEN` |
  | 前进4 | `ahead-4` | 核心/发布路径与复杂特性（旗舰全速） | `MDK_TIER_AHEAD4_TOKEN` |

  ① ModelDock 侧按档位建 profile + 钉定路由的 harness（`modeldock test <harness>` 验证连通），profile 可加 `tier` 标签（与档位键同名，如 `tier = "ahead-4"`，故障切换同档隔离）；② workflow.json `tiers` 各档配 `tokenEnv`（token 走环境变量不入库，可选 `workerModel`/`reviewModel`/`provider`/`gatewayBase`）；③ 任务卡写 `tier: ahead-3`（**旧 `heavy`/`light` 永远兼容**＝自动映射 前进4/前进2）。`files_hint` 命中核心/发布路径自动升 前进4。某档 tokenEnv 未设 → 该档回落全局默认（显式点名告警、自动升档静默）。模型优先级：CLI > tier > 全局默认。zcode-headless 不支持 tier。
  **网关权威校验（可选，`gatewayAdmin: true` 显式开启）**：开启后编排器用 admin 面（读 `~/.modeldock/gateway.json` 的 port+admin_token，或 `ORCH_GATEWAY_BASE`/`ORCH_GATEWAY_ADMIN_TOKEN` env 覆盖——测试/多实例）调 `POST /_modeldock/tier-validate`，问网关「tier token 现在真实解析到哪个 profile、带什么 tier 标签」。分级处置：**tier 已打标但 token 指向别档/无标签 profile → 派发前阻断**（重活静默落到别档服务正是 tier 隔离要防的事）；token 网关解析失败 → 阻断（tier 流量每笔都会 401，派发必烧）；tier 未在网关打标 → 告警不阻断（向后兼容）；网关不可得/旧版无端点 → 回落 advisory 目录校验，行为不变。不开启 = 纯 advisory（与历史一致）——可移植工具链不得默认读用户 home 下的 ModelDock 状态。
- **长跑加固速记**（详设见 design doc v1.2）：预算按引擎校准 `budgetProfiles.<backend>`（本仓库 claude-headless / zcode-headless 均 `max_tokens: 5000000`——GLM 网关缓存读口径失真，调大不关闭，wall-clock 才是真熔断）；drain 起跑前引擎预检（CLI 不可用拒绝启动，不再逐卡烧成 blocked）；成功出港（merged ✅）与落位（awaiting-human/blocked/failed）均发 webhook（`${envPrefix}_ORCH_WEBHOOK`）+ macOS 通知；worker prompt 带结束纪律（done 前自验、同一条命令被权限拒满 2 次即 stuck、禁 `git -C` 与 `;`/`&&` 复合命令）。
- **Windows 权限墙已根修**：claude CLI 在 Windows 的 shell 工具是 **PowerShell**——白名单/红线一律 Bash+PowerShell 双形态双发，worker settings hook matcher 为 `Bash|PowerShell`。zcode 侧 yolo 在 CLI 0.17.0 已恢复全自动（沙箱实验实证）。
- **prompt 纪律**（对齐 Anthropic 长时程 harness）：done 前自验测试、干净提交、不越界；**同一条命令被权限拒绝满 2 次即 stuck 熔断**；环境层禁 `git -C` 形态与 `;`/`&&` 复合命令。spec 卡 design/requirements 用 **worktree 文件引用**（防 zcode headless 30k argv 上限），prepare 时由 orchestrator 拷贝进 worktree。reviewer prompt 注入 REVIEW.md 纪律摘要（截 8000 字符）。files_hint 解析自动剥反引号/引号。
- **Budget 会话级记账**：committed+sessionMax（跨 fixup 会话不再互相覆盖漏计），每次 worker_spawned 落 `budget_baseline` 事件。
- **LLM 决策留底（decision trace）**：看门狗（watchdog）/ scan 语义过滤（smartfilter）/ 独立审查（review）三类 LLM 决策点把**模型输入与原始输出全文**落盘 `.agents/orchestrator/logs/<任务id>/decisions/<类型>-*.json` 供复盘；超 64KB 截前缀、每类型滚动保留 20 份；workflow.json 可选键 `"trace": { "enabled": true, "maxPerTask": 20, "maxInputKB": 64 }`（缺省开启）。看门狗熔断卡不参与 blocked 卡自动续（防「误杀→续跑→再误杀」循环）。

### A5. 权限红线（worker 被什么拦了）

worker 会话注入专属 policy hook：git push/tag、npm publish、受保护端口（workflow.json `protectedPorts`）一律拒。**发布动作是硬编码红线，任务卡写了也没用**。zcode worker 的红线必须在**用户级** `~/.zcode/cli/config.json` 注册（项目级注册 headless 下被平台禁用，实证过）；推荐机器级 dispatcher 一次注册全项目生效：`cp .agents/hooks/policy-dispatch.mjs ~/.agents/hooks/` 后用户级 hook 指向它。**用 zcode-headless 跑自治任务前先完成这一步，否则红线无人把守。**

### A6. fastlane 与 ui_check（提速与 UI 冒烟）

- **fastlane**（任务卡 `fastlane: true`）：跳过 LLM 审查子循环（不 spawn reviewer、不进 reviewing），`review_verdict` 记 skipped。**只省审查、不降任何闸门**：自动合并四前提（无 drift 降级 + 声明与实际分级均 L0/L1 + 实际≤声明 + scope 无越界）原样生效。失效规则（记 `fastlane_skipped` 附 reason，失效后本次 run 不复活）：实际分级 L2/L3 → 回常规链路（核心路径恰恰最需要审查）；drift 降级期 → 回常规链路；卡 gate=L3 → 跑前即失效；workflow.json `fastlaneAllowed: false` 团队总开关。适合纯 docs/test 小卡。
- **ui_check**（`ui_check: true`）：改 Web 控制台/网关页面的卡在 build 后跑 `workflow.json uiCheckCmd`（本仓库 `node scripts/ui-smoke.mjs`，自备 189xx 沙箱）；失败进调试子循环（非红线）；声明了但仓库未配置 → 快速失败卡留 pending。

### A7. 互斥与并行（谁在跑、能并行吗）

- **调度器锁**：drain / nightly / scan --run / watch 共用一把（`.scheduler-lock.json`），后来者提示退出；持锁进程死 = 陈锁自动接管。手动 `run <id>` 不抢调度器锁。
- **任务锁**：每卡 `.run-<task-id>.lock`——同一泊位（worktree）不允许两个进程同时驱动（两个 worker 会写同一个 worktree）；人工 agent 经 feature-branch start 认领同一把锁（claim-before-execute，见 D4）。
- **并行 drain**：`drain --workers 3` 最多 3 卡同跑，按 files_hint 分区互斥（`docs/**` 与 `test/**` 可并行；裸 `**` = 独占）。想让任务可并行，把 files_hint 收窄到独立目录。

## B. 自主模式详解

需求侧生命周期：**出提案（drafts/ 待审托运申请）→ 人工批量 submit 或 autopilot（自动舵）白名单自动提交（pending/ 待泊）→ 常规闭环（闸门原样）**。人（船东）只审提案与合并两级。
- **blocked 卡什么时候会自动续跑**：drain（含 nightly `--auto` 拉起的 drain）在选卡前会扫一遍 `blocked/`，对**可安全自动续**的卡有限自动 resume——夜里被 429 限流/网络抖动打 blocked 的卡不再等到早上。资格三条：① 失败属 transient 类——最后一条 blocked/failed 事件的 reason 带 429 限流/网络签名，或事件链有 `worker_retry` 记录（worker 原地重试已发生）且最终落 blocked（预算/看门狗/调试迭代熔断是确定性失败，不续）；② 卡 frontmatter 无 `auto_resumed_at` 或距上次自动续 ≥24h（`autoResume.cooldownHours` 可调）——自动续后再 blocked 不立即重试，等人工或冷却过期；③ 每次 drain 最多 `autoResume.maxPerRun` 张（缺省 2），blocked 最早的先续。每次自动续记 `auto_resume { card, attempts }` 事件（人工 resume 的 `resumed by human` 与之区分）。drift 降级期间整个通道暂停（降级 = 全人工）。全局关闭：workflow.json 写 `"autoResume": { "enabled": false }`（其余键缺省即 true/2/24）。

### B0. 引水闸（compulsory pilotage）

受限航道 = `type: deps` 的卡（依赖变更牵一发动全身）或 files_hint 命中 workflow.json `corePaths` / `releasePaths` 的卡。这类卡**未经人工确认不得自动开航**：

- **直接 `run <id>`**：拒绝启动（卡留 pending/ 不动），记 `pilotage_required` 事件（附命中原因）。
- **怎么确认**：`run <id> --pilot-approved`——人工过目后逐张放行。
- **drain 遇到引水卡**：跳过不派发（不烧预算、不 die），跑完打印「待引水」清单逐张给确认命令；串行与 `--workers` 并发同语义。队列顺序不因跳过改变，确认过的卡随时可显式 run。

### B1. 提案与 autopilot（授权制）

- 提案卡 `proposal: true`、`created_by: scanner|planner`、gate=L3，落 `.agents/orchestrator/drafts/`（不入库）。人工提交：`submit .agents/orchestrator/drafts/<id>.md`（提交后草稿自动清掉）。
- **目标面（罗盘）`.agents/orchestrator/goals.md`**（入库、用户手编、agent 只读）：核心目标（优先级排序）/当前主题/明确不做。propose 产出必须对齐它；缺失/留空 = 无目标面（只基于巡检信号提案）。
- **autopilot 授权配置**（workflow.json，缺省全关 = 行为与历史版本一致）：

  ```json
  "autopilot": { "enabled": true, "autoSubmitTypes": ["docs"], "autoDrainPerCycle": 3, "maxProposalsPerCycle": 3 }
  ```

  - **自动提交 ≠ 自动合并**：白名单提交的卡 gate 覆写 L1，实际自动合并仍由门禁对真实改动分级裁决——drift 降级、scope 越界、实际 L2/L3 照样挡回人工闸门。
  - 永不自动提交（即使 enabled）：`deps` 类型、`created_by: human` 的人工草稿、files_hint 命中 corePaths/releasePaths 的卡。
  - 开启即代表持久授权「该类型提案自动进队列」，替代逐卡对话确认。

### B2. 巡检（scan 的 6 类信号源）

TODO/FIXME（src/）· npm audit · 测试失败（--tests 慢路径）· GitHub open issues（gh best-effort）· **known-issues 账本**（docs/known-issues.md 未修条目，已修/暂缓自动跳过——人工裁决不被自主提案推翻）· **主干 CI 失败**（gh run list，按 head sha 建 id）。全部内容过 sanitize 消毒（无法携带指令结构进 worker prompt）；id 按内容哈希，信号不变自动去重；gh 类信号仅 GitHub 远端启用、失败警告跳过。
- **信号两级过滤**（程序 Fast Path 永启 + LLM Slow Path 按 `scan.smartFilter: true` 开启，缺省关）：落卡写 frontmatter `signal_hashes`；同源信号**直通在途卡**（「补充信号」小节追加，记 `signal_relayed`，不重复开卡），与 14 天内 merged/failed 卡同信号的**丢弃**（记 `signal_dropped`）；LLM 层对剩余候选**批量一次**调用（≤50 条，成本上界写死），判定 card/drop/merge，失败全部保守回落开卡（宁多勿漏，`scan_semantic` 事件）；每轮落 `scan_filtered` 总账（raw/keep/relayed/dropped/merged_away）。引擎用 review.backend 同款，模型 `scan.smartModel`（缺省回落 review.model）。

### B3. propose（planner 需求综合）

`propose`：goals.md + drafts 巡检信号 + 队列现状 → 一次只读 planner 会话产出至多 `maxProposalsPerCycle` 张高质量提案（验收标准带具体行为断言、files_hint 精确、目标对齐），落 drafts/；白名单卡立即自动提交。深化既有提案用**同 id**（落盘覆盖=升级）。烧钱动作；`nightly --plan` 与 watch（autopilot 开时）内部调用同一命令。

### B4. 夜航巡港（nightly）与 schedule（每日波次）

`nightly` = scan 出提案 + autopilot 白名单提交 + drift 报告 + 队列摘要（默认零烧钱；`--plan` 加跑 planner；`--auto N` 夜间对 high 提案提交并发起闭环再 drain N 个——worker 烧钱仅此档，gate=L3 兜底合并仍人工）。`schedule install --hour 2 --minute 30 [--auto 3] [--mode watch]` 注册定时（launchd/crontab/schtasks 经 wrapper 绝对路径启动，不依赖调度环境 PATH；仓库挪位置后重装）。日志 `logs/nightly.log`（超 5MB 轮转）。跑完发通知：macOS 本地通知 + `${envPrefix}_NIGHTLY_WEBHOOK`（如 `AGENTS_NIGHTLY_WEBHOOK`，旧名 MODELRDOCK_* 兼容）POST `{title, body, ts}`；通知尽力而为，摘要始终在日志。
中断恢复与双跑防护：nightly 启动时对账 `logs/nightly-state.json`——上次未正常收尾（崩溃/强制重启）则记 `nightly_recovered` + webhook 通知后照常执行；距上次完成不足 20 小时且非人工触发判为补触发双跑，跳过本次（终端 TTY 自动识别人工，脚本场景加 `--manual`）。webhook URL 直接填**飞书 / 企业微信 / Slack** 群机器人地址（按端点域名自动适配三家消息格式；飞书自定义关键词配 `nightly` 或 `ModelDock` 均可命中，签名校验暂不支持）。wrapper 固化 install 时刻的参数与路径——orchestrator 侧默认值/参数变更后需重跑 `schedule install`。

### B5. 瞭望模式（watch，连续自治）

`watch --interval 30`：每周期 drain pending → 队列空时 scan 出提案 →（autopilot 开时）propose → 休眠循环。

- 停止：`touch .agents/orchestrator/.watch-stop`（下周期即停并清文件）或 Ctrl-C；**drift 降级自动退出**（保险丝不允许自己插回去，人工 `drift --clear` 后重启）。
- 每周期重读 workflow.json——改 autopilot 配置下周期即生效，无需重启。`--interval 0 --max-cycles N` 为测试档（不休眠）。
- **投机重探**：每周期检查 blocked 卡——worker 异常结束 + 瞬时故障签名且从未重探过的，一次性有痕 resume（`speculative_resume` 事件）；熔断卡与 worker 自报 stuck 永不重探（「永不静默重试」红线不变）。
- **风暴闸（weather hold）**：瞭望位先看天——每次派发前无状态统计最近 `windowMinutes` 分钟（缺省 60）各任务 `worker_retry` 合计，达 `threshold`（缺省 3）即停止派发（drain/nightly --auto/watch 通用）：日志「风暴滞留」+ webhook 通知 + fleet 级事件 `weather_hold`（`logs/fleet.jsonl`，跨任务调度层留痕）。可选**上游海况**子键 `"upstream": {"threshold": 8, "windowMinutes": 15}`：网关日志（`gatewayLogDir`，须已配置）窗口内限流/额度类请求（429/402）合计达阈值同样滞留——网关先于 worker 看到上游限流（任何 harness 的流量都算），触发时点名为「上游风暴」。workflow.json 可选键 `"weatherHold": {"threshold": 3, "windowMinutes": 60, "upstream": {"threshold": 8, "windowMinutes": 15}}`，**未配 = 关闭**（行为与历史版本一致）；窗口滑过自动恢复（不落 hold 标记文件），瞬时重试退避基值可经 `ORCH_RETRY_WAIT_MS` 注入（缺省 60s×attempt）。
- 与 drain/nightly 共用调度器锁：watch 在跑时手动 drain 提示退出而非并发。

### B6. 弃船演习（drill）

引擎预检只能证明 CLI 在场；闭环本身（worktree 创建→门禁→审查→闸门）只有真跑才检验——环境漂移（node 版本、权限墙、脚本残缺）夜里才炸不如演习先炸（SOLAS 救生艇演习条款的 Dockmaster 版）：

```bash
node .agents/scripts/orchestrator.mjs drill   # exit 0 = 港口闭环健康
```

- **临时港**演习：mkdtemp 临时 git 仓 + 整目录拷贝 `.agents/scripts` + 最小 workflow.json，mock 跑一张合成托运单（id `drill-<日期>-<随机>`）走完全链，产物随临时港删除——不烧真钱、不碰真队列。
- 判定：脚本完整 → 合成卡提交 → 闭环全链落 awaiting-human，任一环节 ✗ 即 exit 1（可用 schedule/cron 注册成每周演习）。

### B7. 开启清单（自动舵 autopilot 与风暴闸 weatherHold）

两个自主开关都**缺省关闭**；开启按本清单走（每步可机器验证，2026-11-01 沙箱演练实证）：

**自动舵 autopilot**（白名单提案自动提交进队列）：
1. 先填罗盘：`.agents/orchestrator/goals.md`（无目标面 = 提案只靠巡检信号）；
2. workflow.json 加 `"autopilot": { "enabled": true, "autoSubmitTypes": ["docs"], "autoDrainPerCycle": 2 }`；
3. 验证链路：`propose --backend mock` → 白名单卡应出现「🤖 autopilot 已提交提案」（gate=L1）；`drain --backend mock` 一路到 merged 即闭环健康（沙箱配方见 test/orchestrator/propose.test.ts）；
4. 试运行一个周期后看 `stats --json` 的 `summary.merge_rate` 与 `summary.near_miss`，再逐步放宽 `autoSubmitTypes`（deps/核心路径/人工草稿永不自动；实际合并仍由分级裁决与 drift 保险丝兜底）。

**风暴闸 weatherHold**（瞬时故障密集时自动停派发）：
1. workflow.json 加 `"weatherHold": { "threshold": 3, "windowMinutes": 60 }`（阈值=窗口内 worker_retry 合计）；上游海况可选：加 `"upstream": { "threshold": 8, "windowMinutes": 15 }`（网关日志 429/402 合计，须同时配置 `gatewayLogDir`）；
2. 验证：窗口内凑满阈值后，下次 drain / watch 周期应打「⛈ 风暴滞留」并停派发（fleet.jsonl 留 `weather_hold`），窗口滑过自动恢复、无需清理状态；
3. 滞留通知走 `${envPrefix}_ORCH_WEBHOOK`；滞留期 announce 只发一次防刷屏。

**不变的红线**：两者开启都不触碰合并分级（corePaths→L2 / releasePaths→L3）、发布人工授权与「永不静默重试」——自动的是「进队列」，不是「进主干」。

### B8. 故障处置升级链（escalation，分级自动化审批）

故障处置按 token 成本分级自动升级，人只出现在高成本档（船东 2026-11-02 定案）：

| 档位 | 成本 | 机制 | 状态 |
|---|---|---|---|
| 第 0 档 | 零成本自动 | worker 瞬时故障原地重试（≤3）、调试/审查返工循环、blocked 卡自动续跑（autoresume：transient 才续、24h 冷却）、watch 有痕重探 | 已内置 |
| 第 1 档 | 低成本计费自动 | **zcode 船 prompt 超限（>30k argv 上限）自动切 fallback 船**：`engine_escalated` 事件留痕，预算延续不重置，每 run 至多一次 | workflow.json `escalation.enabled`（缺省关） |
| 第 2 档 | 高成本人工审批 | 旗舰档（ahead-4）/ 加大预算 / 换供应商 | 永不自动——调度台停下请示 |

- `escalation: { enabled: true, fallbackBackend: "claude-headless" }`——**fallbackBackend 写进配置即持久授权**（同 autopilot 哲学），运行时不再为换船请示。
- 红线不变：预算熔断永远硬顶（escalation 不重置不放宽预算）；所有升档事件留痕（永不静默）；第 0/1 档只救「装不下/瞬时限流」类故障，验收失败照走调试与人工闸门。

### B9. 自由航行（sail，时间盒完全自治）

`node .agents/scripts/orchestrator.mjs sail --minutes 120`（或 `--duration 2h|90m|1h30m`）：船长自勘海况（scan 巡检）→ 自绘航线（propose 产卡，编排理由写在卡上）→ 自航自泊（drain 全门禁闭环）→ 到点收帆交**航海报告**——完成了什么、为什么这么编排，落 `logs/sail/<ts>/report.md`（stdout 同文 + webhook 通知 + fleet 留痕，`sail_started`/`sail_finished`）。与 watch 的差别：有硬时长预算、报告收口、自动提交不依赖 autopilot 配置。

- **授权模型**：人显式敲下带时长的 sail 命令 = 本航次自动提交授权。硬禁区不变（配置只收窄、永不放大）：`created_by: human` 人工草稿、`deps` 类型、files_hint 命中 corePaths/releasePaths 永不自动；类型白名单 workflow.json `freeSail.autoSubmitTypes`（缺省 `["docs","bugfix","refactor","feature"]`）；提交 gate 覆写 L1——实际合并仍由分级裁决 + drift 保险丝兜底。开航前已有的存量 drafts 永不自动提交。
- **循环**：pending 非空 → `drain --max 1`（一次只派一张，每张之间重新看表）；队列空 → scan + propose + 自动提交 → 立即派发；仍空 → 休眠 `--interval`（缺省 10 分钟）再看海况——planner 空手轮由休眠挡住，不会连环烧钱。每周期重读 workflow.json（改配置即时生效）。
- **停止条件（任一）**：到达 `--minutes/--duration`、`.agents/orchestrator/.sail-stop` 文件（下周期即停并清文件）、drift 降级（人工 `drift --clear` 后再启）、`--max-tasks N` 派发上限、连续 3 轮派发无进展（队列卡在待引水/解析失败时触发）。**软截止**：跑着的任务让它跑完，不超时强杀；风暴闸滞留期跳过派发与规划（scan 照跑——不派 worker），窗口滑过自动恢复。
- **报告口径（为什么这么编排）**：全部确定性组装、不再烧 LLM——战果清单按队列快照差分（merged / 待放行 / 搁浅退关 / 剩余 pending，开航基线如实区分「开航前已在队列」与「本航次新增」）；编排理由直接引用 planner 卡片上的目标句原文 + 每周期提交/否决原因 + goals.md 罗盘对齐说明。voyage.json 逐周期落盘，SIGINT 强杀后也能续查航迹。

## C. 观测与对账详解

### C1. stats 与 follow（引水传令）

- `stats --days 7 [--json]`：每卡 wall/turns/调试与审查迭代/重试/watchdog suspect/follow-up/token 峰值（budget_snapshot 口径）+ 各状态卡数与合并率汇总。JSON 形态：顶层 `summary` 嵌套对象 + `rows`。跨引擎精确对账用 reconcile。汇总含**安全晴雨表**（`summary.near_miss`，人类输出「安全晴雨表」行）：watchdog suspect / 瞬时重试 / 偏航报警（`xte_alarm`，确定性规则只留痕）/ 事故调查包（`incident.md`，VDR 终态自动归档）四类近乎事故计数——险情比事故多，先看晴雨表再定流程调优。
- `follow <task-id> "<补充指令>"`：给 running/ 的卡递话，写 `logs/<id>/inbox.md` + `follow_up` 事件，在下一次会话边界（调试返工/审查返工/resume/新 spawn）注入 prompt 尾部（20 条/4000 字符截断，前缀缓存友好）。只对 running 卡开放；awaiting-human 用 `retry --note`，pending 直接改卡文件。`status <task-id>` 会显示待送达条数。

### C2. drift（质量漂移保险丝）

自动合并回溯失败率超阈值（`driftThreshold` 缺省 0.2，**可调不可关**）→ 降级全人工（`run` 的自动合并全部回闸门，事件 reason=drift_degraded，fastlane 同步失效）。`drift` 看报告；根因消除后 `drift --clear` 人工恢复。

### C3. reconcile（狗粮对账）

`reconcile [task-id]`：① 用量对账——自报账（events budget_snapshot）vs 网关实测账（转发日志 usage），分歧率 = |自报−实测|/max，网关零流量标 ⚠（worker 绕过了狗粮）；启用条件 = workflow.json `gatewayLogDir` 已配置。② 状态对账——git merge 现实 vs 队列落位：「已合并未落位」`--fix-states` 修复、「账面合并但 git 无实证」警告（squash/改史）。纯只读（除 --fix-states）。事故调查包（incident.md）的「上游海况」段复用同一投影（不过滤失败请求）：时间窗内请求/失败分布、路由事件痕迹（failover/down_all）、时延 p50/p95、实测用量与最近失败现场——回答「预算烧在哪」。

## D. 周边

### D1. spec（特性级先设计后施工）

`spec "<意图>"` → Planner 产出 requirements（用户故事 + EARS 验收）→ design（现状/方案/取舍/风险）→ tasks（可独立合并的任务段）三件套，落 `specs/<id>/` 人工审阅/手改 → `spec build <id>` 拆卡进队列（幂等；design 全文注入卡背景；tasks 的「文件」行直接成为 files_hint）。**人工闸门在「审设计」这一步**；拆出的卡 gate=L3，开发→测试→审查照走闭环。`spec status <id>` 看跨夜进度锚（progress.json）。

### D2. release-propose（发版提案）

`release-propose [X.Y.Z]`：盘点上个 tag..develop 的 conventional 提交推 semver 档位（breaking 在 0.x 走 minor）、核对 CHANGELOG「未发布」段、产出提案文件（只认产品侧提交计档，基建单独备查——2026-10-29 用户决策）。**版本号是建议，决定权在人**；确认后说「发布 vX.Y.Z」走 release.md 代理发布，不在本命令范围。

### D3. 与 feature-branch 的关系（claim-before-execute）

orchestrator 完全复用 feature-branch 工作流（start/finish/NOTES.md），worker 编辑被 guard 挡在 worktree 内。人工 agent 的 `feature-branch start` 见队列同 id 卡在 pending/ 即自动认领（抢任务锁 + 卡迁 running/），finish 成功落 merged/——人工侧与闭环共享卡状态，drain 不会误派。同 task-id 人工与闭环混用仍然禁止（锁存活时 start 拒绝）。

### D4. 移植到其他项目

代码零项目专属假设，项目数据全在 `.agents/workflow.json`；体系名 Dockmaster 随 `.agents/` 目录一起带走，无需改代码：

```bash
cp -r <模板项目>/.agents .
node .agents/scripts/agent-init.mjs   # 交互生成 workflow.json + 注册 hook + AGENTS.md 骨架（--defaults 非交互）
```

- 派生链：projectName 缺省取 package.json name（通知标题、调度标识、Windows 任务名都由它派生）。
- 门禁命令：testCmd 必配；buildCmd/lintCmd/typecheckCmd/uiCheckCmd 配了才跑。
- 领域 playbook（add-adapter/add-preset 等）是模板项目专属，移植时删除或重写；feature-branch/code-review/docs-sync/worktree-rescue/release/hotfix/orchestrator 通用可留用。

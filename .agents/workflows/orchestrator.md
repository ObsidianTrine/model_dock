# Dockmaster 操作手册（.agents 自治编排体系）

> **Dockmaster（坞长）** 是本仓库 `.agents/` 自治编排体系的名字——ModelDock 的 Dock，管坞的人就是 dockmaster。**命令行名保持 `orchestrator.mjs` 不变**（改名零收益、破坏既有引用与肌肉记忆）；文档用港口隐喻叙事（官方映射表见下），接口名保持 orchestrator 不变。
> 目标读者：递交托运单（任务卡）、看闸门、处理搁浅（blocked）任务的 agent / 人类操作者。
> 设计与原理：`.agents/docs/design-orchestrator.md`（本文只讲怎么用）。运行前提：主仓库根目录运行；Node ≥18；零第三方依赖。

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
| `research "<问题>"` | 上游调研（上游管线，orch-autonomy.md）：researcher 只读+联网会话产出带引用 brief；`--selftest` 实测联网工具可用性 |
| `research multi "<主题>" --dim …` | 多维调研（上游管线，orch-autonomy.md）：一个主题 × N 维（≥2，上限 `research.maxDims` 缺省 4）有界并发池逐维派 researcher（`research.concurrency` 缺省 2 上限 4），落 `research/topics/<topic-id>.json`（dims 明细 + rollup 最差档）；单维失败隔离 |
| `research snapshot <brief-id> [--mirror] [--max N]` | 引用快照补跑（上游管线，orch-autonomy.md）：对既有 brief 重跑快照（覆盖 `sources/` 同名文件，幂等）——瞬时失败自动重试 + 分类标注（ok/骨架/区域封锁/PDF，只标注不改判分）；`--mirror` 走 r.jina.ai 镜像读取（把引用 URL 发给第三方服务，默认关、显式开启）；零 LLM token 的纯 HTTP 人工核查/补网工具 |
| `drafts gc [--apply]` | 提案清退（orch-supply.md）：与 merged 卡改动面重叠的提案迁 superseded/、超龄迁 archived/（dry-run 缺省，--apply 才动文件，永不删除）；超龄（maxAgeDays 缺省 14 天）未提交的机器提案 nightly 也自动清退 |
| `nightly [--plan] [--auto N]` | 一次完整巡检编排；含 drafts gc 自动清退（老化自动档，orch-supply.md）；`schedule` 注册成每日定时 |
| `watch` | 连续自治循环：drain → 队列空时 scan+propose → 休眠 |
| `sail --minutes N` | 自由航行：时间盒完全自治（勘察→规划+上游管线/自动提交→执行循环），到点收帆交航海报告 |
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

详细机制按需查：按场景读对应 runbook——**orch-loop（核心闭环）· orch-autonomy（自主模式）· orch-supply（供给与守卫）· orch-observe（观测对账）· orch-ecosystem（生态与边界）**，路由见下方「文档地图」。

## 文档地图（何时读哪个）

本文件只留入口（是什么 / 一张图 / 官方映射表）与速查；原 A/B/C/D 四大节已按场景拆为下表五个 runbook，细节与交叉引用都在各篇内。

| 场景 | 读 |
|---|---|
| 核心闭环详解：任务卡怎么写 / 泊位状态机 / 紧急抛锚与看门狗 / 后端与 tier / 权限红线 / fastlane 与 ui_check / 互斥与并行 | [orch-loop.md](orch-loop.md) |
| 自主模式：引水闸 / 提案与 autopilot / 巡检与 propose / 上游管线（research → spec → 人工审 → build）/ nightly 与 schedule / watch / drill / 开启清单 / escalation / sail / push-review / 双向批示 | [orch-autonomy.md](orch-autonomy.md) |
| 供给与守卫：动态选船 / worker 并发供给闸 / configGuard / drafts gc / scanAutoFix / gatewayProvision 一次性凭据 | [orch-supply.md](orch-supply.md) |
| 观测对账：stats 与 follow / drift / reconcile / 舰队控制台 / 验船师评测集 / autoapprove 超时委托 / notify-digest 通报聚合 / 调研评测集 | [orch-observe.md](orch-observe.md) |
| 生态与边界：spec / spec review / release-propose 发版提案 / 与 feature-branch 的关系 / 移植到其他项目 | [orch-ecosystem.md](orch-ecosystem.md) |
| 使用指南（状态机、闸门交互、混合节奏） | [.agents/docs/orchestrator-usage.md](../docs/orchestrator-usage.md) |
| 设计与原理（架构决策与机制演进） | [.agents/docs/design-orchestrator.md](../docs/design-orchestrator.md) |
| AI 审查管线（分层 PR 审查 / security-review 运维） | [.agents/docs/ai-pipeline-guide.md](../docs/ai-pipeline-guide.md) |
| 任务卡 backlog 与提案池 | [.agents/docs/TODOLists.md](../docs/TODOLists.md) |

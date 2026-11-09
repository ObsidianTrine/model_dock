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
| `research "<问题>"` | 上游调研（B3.5）：researcher 只读+联网会话产出带引用 brief；`--selftest` 实测联网工具可用性 |
| `research multi "<主题>" --dim …` | 多维调研（B3.5）：一个主题 × N 维（≥2，上限 `research.maxDims` 缺省 4）有界并发池逐维派 researcher（`research.concurrency` 缺省 2 上限 4），落 `research/topics/<topic-id>.json`（dims 明细 + rollup 最差档）；单维失败隔离 |
| `drafts gc [--apply]` | 提案清退（B13）：与 merged 卡改动面重叠的提案迁 superseded/、超龄迁 archived/（dry-run 缺省，--apply 才动文件，永不删除） |
| `nightly [--plan] [--auto N]` | 一次完整巡检编排；`schedule` 注册成每日定时 |
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
research: websearch-fallback     # 可选（feature 提案必填）：调研 brief id 或 todo（上游管线，见 B3.5）
score:                           # 可选：量化评分四因子 1-3 档（纯规则定序用，见 B3）
  value: 2
  effort: 1
  confidence: 2
  risk: 1
evidence:                        # 可选：证据清单，一句话一条（与 score 配套）
  - 巡检信号：docs/known-issues.md 未修条目
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

**门禁按实际改动面分级**：全部改动为 `.md`（纯文档卡，实际分级 L0）时，npm_test 门禁自动改跑 workflow.json `testCmdL0` 轻量命令（本仓库 = docs-lint 测试），tsc_build 跳过——不烧全量回归；含代码改动照旧全量（gate_result 事件带 `scoped: l0` 标记可审计）。**验收标准是灵魂**：作业船（worker）拿它当航海目的地、审查者（验船师）当评判基准、人（船东）当验收清单。写"做得好用一点"等于没写。**自报不可信**——orchestrator 亲自跑 testCmd 与 build 复核（token（可计费口径，剔除缓存读）、失败尾部 200 行都有据可查）。航次计划段（SOLAS V.34 计划先行）要求 3-6 个检查点、每个一句话「做什么 + 怎么验证」、末尾一行备选路线；planner / propose 产卡会自动补写该段。

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

- **后端**：`--backend mock|claude-headless|zcode-headless|codex-headless`。缺省沿用上次会话；mock 只测闭环本身。**本仓库默认 `worker.backend: claude-headless`（2026-11-03 船东定：全档位换 claude-code CLI——zcode 免费船可靠性不足；模型仍 glm-5.3-flash 经网关）**——claude CLI 经 `~/.claude/settings.json` 指向本机 ModelDock 网关（127.0.0.1:8687）供油（`modeldock test claude-code` 验连通）。zcode-headless 仍可用（`--worker-backend zcode-headless` 显式点名须批准；ORCH_ZCODE_CLI 指向 zcode.cjs；prompt 走 argv 超 30000 字符快速失败；headless 无 `--max-turns`，wall-clock/token 熔断直接杀进程树），修复 TUI `/model` 后可点回。codex-headless（2026-11-09 新增，codex-catalog-ship 卡）：`--worker-backend codex-headless` 点名；ORCH_CODEX_CLI 指向 codex 绝对路径（spawn 与探测同源，.cjs/.mjs 桩用 node 直跑）；prompt 走 stdin 无长度上限；无 `--max-turns` 旗标（token 熔断兜底）；**红线走沙箱物理层**——worker=workspace-write（codex 沙箱默认禁网，git push/npm publish 物理不可达），reviewer/researcher=read-only（fail-closed）。前置条件：codex 只讲 Responses 协议，`~/.codex/config.toml` 须经 ModelDock 接入（model_catalog_json 目录由 attach 自动生成，`/model` 选择器可见网关模型）；上游须支持 Responses 端点且对独立 web_search 工具容忍（小米上游需 `web_search="disabled"`，attach 已缺省写入）。claude 侧对等的 `ORCH_CLAUDE_CLI` 仅覆盖可用性探测/诊断定位（.cjs/.mjs/.js 用 node 直跑；worker 拉起仍走 PATH claude，不随它改道）。**引擎切换人工闸门**：最终引擎 ≠ workflow.json `worker.backend` 即拒绝启动（resume 沿用也不豁免），须 `--approve-backend-switch` 或 `ORCH_APPROVE_BACKEND_SWITCH=1`——切换引擎=切换计费方，必须过人（2026-10-29 夜跑静默换引擎烧穿账单的事故防线）。
- **异构审查**：执行与审查是两个独立会话。审查引擎解析顺序：`--review-backend` 显式 > workflow.json `review.backend` > 上次 `review_spawned` 事件（retry/resume 不换审查引擎）> **自动异构**（按序取第一个 CLI 可用的候选：claude→zcode→codex→claude 环；mock 永不异构）> 回落同源（记 `review_backend_fallback`）。**去相关的关键是引擎异源——只拆会话不换引擎仍有共同盲区**。**审查模型分源（2026-11-08 收口）**：workflow.json `review.model`（执行侧对应 `worker.model`）给审查会话配独立上游模型——引擎同源时至少换脑子（模型异源去相关；值走 ModelDock 网关别名重写，编排器原样透传不校验）。模型解析顺序：`--review-model` 显式 > tier.reviewModel > `review.model` > 不传（跟随引擎默认；未配时 `review_spawned` 事件与决策留底不带 model 字段，消费者兼容）。model 仅 claude 系生效（zcode 跟随用户 ZCode 默认）。引擎 + 模型双异源才是完整互审。
- **tier 车钟档位（前进1-4，接口键 ahead-1..4）**：按航程难度选服务与模型——
  | 档位 | 接口键 | 适用 | tokenEnv |
  |---|---|---|---|
  | 前进1 | `ahead-1` | 纯文档/测试小改（最省） | `MDK_TIER_AHEAD1_TOKEN` |
  | 前进2 | `ahead-2` | 常规轻活 | `MDK_TIER_AHEAD2_TOKEN` |
  | 前进3 | `ahead-3` | 常规重活（默认推荐） | `MDK_TIER_AHEAD3_TOKEN` |
  | 前进4 | `ahead-4` | 核心/发布路径与复杂特性（旗舰全速） | `MDK_TIER_AHEAD4_TOKEN` |

  ① ModelDock 侧按档位建 profile + 钉定路由的 harness（`modeldock test <harness>` 验证连通），profile 可加 `tier` 标签（与档位键同名，如 `tier = "ahead-4"`，故障切换同档隔离）；② workflow.json `tiers` 各档配 `tokenEnv`（token 走环境变量不入库，可选 `workerModel`/`reviewModel`/`provider`/`gatewayBase`）；③ 任务卡写 `tier: ahead-3`（**旧 `heavy`/`light` 永远兼容**＝自动映射 前进4/前进2）。`files_hint` 命中核心/发布路径自动升 前进4。某档 tokenEnv 未设 → 该档回落全局默认（显式点名告警、自动升档静默）。模型优先级：CLI > tier > 全局默认。zcode-headless 不支持 tier。
  **网关权威校验（可选，`gatewayAdmin: true` 显式开启）**：开启后编排器用 admin 面（读 `~/.modeldock/gateway.json` 的 port+admin_token，或 `ORCH_GATEWAY_BASE`/`ORCH_GATEWAY_ADMIN_TOKEN` env 覆盖——测试/多实例）调 `POST /_modeldock/tier-validate`，问网关「tier token 现在真实解析到哪个 profile、带什么 tier 标签」。分级处置：**tier 已打标但 token 指向别档/无标签 profile → 派发前阻断**（重活静默落到别档服务正是 tier 隔离要防的事）；token 网关解析失败 → 阻断（tier 流量每笔都会 401，派发必烧）；tier 未在网关打标 → 告警不阻断（向后兼容）；网关不可得/旧版无端点 → 回落 advisory 目录校验，行为不变。不开启 = 纯 advisory（与历史一致）——可移植工具链不得默认读用户 home 下的 ModelDock 状态。
- **长跑加固速记**（详设见 design doc v1.2）：预算按引擎校准 `budgetProfiles.<backend>`（**max_tokens 语义 = 可计费口径**，2026-11 usage-cache-read-scope：GLM 网关缓存读占大头、总口径预算虚胖，熔断与 reconcile 分歧率已改按「剔除缓存读的 billable」比较，budgetProfiles 数值可按真实消耗回调——调大不关闭，wall-clock 兜底不变；旧事件/旧网关日志缺新字段自动回落旧口径并标注）；drain 起跑前引擎预检（CLI 不可用拒绝启动，不再逐卡烧成 blocked）；成功出港（merged ✅）与落位（awaiting-human/blocked/failed）均发 webhook（`${envPrefix}_ORCH_WEBHOOK`）+ macOS 通知；worker prompt 带结束纪律（done 前自验、同一条命令被权限拒满 2 次即 stuck、禁 `git -C` 与 `;`/`&&` 复合命令）。
- **Windows 权限墙已根修**：claude CLI 在 Windows 的 shell 工具是 **PowerShell**——白名单/红线一律 Bash+PowerShell 双形态双发，worker settings hook matcher 为 `Bash|PowerShell`。zcode 侧 yolo 在 CLI 0.17.0 已恢复全自动（沙箱实验实证）。
- **开航前海况观测（fleet observe，纯观测零决策，2026-11-03 船东定案阶段 1）**：每次派发（run 闭环入口）先拉网关 admin 面（`/_modeldock/config` + `/_modeldock/metrics`，`gatewayAdmin: true` 才启用），把「服务清单/熔断状态/各客户端指向」压缩成 `fleet_observed` 事件落任务时间线。告警三类（只照亮不拦截）：**dogfood_bypass**（本船对应客户端指向 ModelDock 之外的端点——船将直连上游，燃油实测与 reconcile 对账失效）、**not_attached**（客户端未经 ModelDock 接管）、**meltdown_active**（有服务在熔断）。船↔harness 映射：zcode-headless↔zcode、claude-headless↔claude-code。未开 gatewayAdmin 完全静默（行为不变）；开了但网关不可得 → 一行提示继续派发。选船仍走既有静态规则，引擎切换人工闸门不变。
- **prompt 纪律**（对齐 Anthropic 长时程 harness）：done 前自验测试、干净提交、不越界；**同一条命令被权限拒绝满 2 次即 stuck 熔断**；环境层禁 `git -C` 形态与 `;`/`&&` 复合命令。spec 卡 design/requirements 用 **worktree 文件引用**（防 zcode headless 30k argv 上限），prepare 时由 orchestrator 拷贝进 worktree。reviewer prompt 注入 REVIEW.md 纪律摘要（截 8000 字符）。files_hint 解析自动剥反引号/引号。
- **Budget 会话级记账**：committed+sessionMax（跨 fixup 会话不再互相覆盖漏计），每次 worker_spawned 落 `budget_baseline` 事件（含 `tokens_billable`）。max_tokens 熔断与低油量告警按**可计费口径**（billable = tokens_in − 缓存读 + tokens_out；budget_snapshot 另发 `tokens_billable`/`tokens_cache_read`，旧口径字段保留）。
- **LLM 决策留底（decision trace）**：看门狗（watchdog）/ scan 语义过滤（smartfilter）/ 独立审查（review）/ planner 规划会话（propose/intent，落 `logs/planner-<时间戳>/`，成功与重试失败都留）四类 LLM 决策点把**模型输入与原始输出全文**落盘 `.agents/orchestrator/logs/<任务id>/decisions/<类型>-*.json` 供复盘（planner 重试失败日志同时附 exitCode 与 stderrTail 尾部 ≤200 字符）；超 64KB 截前缀、每类型滚动保留 20 份；workflow.json 可选键 `"trace": { "enabled": true, "maxPerTask": 20, "maxInputKB": 64 }`（缺省开启）。看门狗熔断卡不参与 blocked 卡自动续（防「误杀→续跑→再误杀」循环）。

### A5. 权限红线（worker 被什么拦了）

worker 会话注入专属 policy hook：git push/tag、npm publish、受保护端口（workflow.json `protectedPorts`）一律拒。**发布动作是硬编码红线，任务卡写了也没用**。zcode worker 的红线必须在**用户级** `~/.zcode/cli/config.json` 注册（项目级注册 headless 下被平台禁用，实证过）；推荐机器级 dispatcher 一次注册全项目生效：`cp .agents/hooks/policy-dispatch.mjs ~/.agents/hooks/` 后用户级 hook 指向它。**用 zcode-headless 跑自治任务前先完成这一步，否则红线无人把守。**

### A6. fastlane 与 ui_check（提速与 UI 冒烟）

- **fastlane**（任务卡 `fastlane: true`）：跳过 LLM 审查子循环（不 spawn reviewer、不进 reviewing），`review_verdict` 记 skipped。**只省审查、不降任何闸门**：自动合并四前提（无 drift 降级 + 声明与实际分级均 L0/L1 + 实际≤声明 + scope 无越界）原样生效。失效规则（记 `fastlane_skipped` 附 reason，失效后本次 run 不复活）：实际分级 L2/L3 → 回常规链路（核心路径恰恰最需要审查）；drift 降级期 → 回常规链路；卡 gate=L3 → 跑前即失效；workflow.json `fastlaneAllowed: false` 团队总开关。适合纯 docs/test 小卡。
- **ui_check**（`ui_check: true`）：改 Web 控制台/网关页面的卡在 build 后跑 `workflow.json uiCheckCmd`（本仓库 `node scripts/ui-smoke.mjs`，自备 189xx 沙箱）；失败进调试子循环（非红线）；声明了但仓库未配置 → 快速失败卡留 pending。

### A7. 互斥与并行（谁在跑、能并行吗）

- **调度器锁**：drain / nightly / scan --run / watch 共用一把（`.scheduler-lock.json`），后来者提示退出；持锁进程死 = 陈锁自动接管。手动 `run <id>` 不抢调度器锁。
- **任务锁**：每卡 `.run-<task-id>.lock`——同一泊位（worktree）不允许两个进程同时驱动（两个 worker 会写同一个 worktree）；人工 agent 经 feature-branch start 认领同一把锁（claim-before-execute，见 D4）。
- **并行 drain**：`drain --workers 3` 最多 3 卡同跑，按 files_hint 分区互斥（`docs/**` 与 `test/**` 可并行；裸 `**` = 独占）。想让任务可并行，把 files_hint 收窄到独立目录。`gatewayAdmin: true` 的仓库并发还受 **供给闸**（B12）约束：有效并发 = min(请求并发, provider 容量)——上游没解锁 `max_concurrency>=2` 时请求多档也只跑单 worker（fail-safe，防 429 烧上游）。

## B. 自主模式详解

需求侧生命周期：**出提案（drafts/ 待审托运申请）→ 人工批量 submit 或 autopilot（自动舵）白名单自动提交（pending/ 待泊）→ 常规闭环（闸门原样）**。人（船东）只审提案与合并两级。
- **blocked 卡什么时候会自动续跑**：drain（含 nightly `--auto` 拉起的 drain）在选卡前会扫一遍 `blocked/`，对**可安全自动续**的卡有限自动 resume——夜里被 429 限流/网络抖动打 blocked 的卡不再等到早上。资格三条：① 失败属 transient 类——最后一条 blocked/failed 事件的 reason 带 429 限流/网络签名，或事件链有 `worker_retry` 记录（worker 原地重试已发生）且最终落 blocked，或 reason 是「未产出结果块」族（worker 异常结束，2026-11 起纳入——本质是 zcode 崩溃族，与 ERA 同源；现存 `未产出结果块（worker 异常结束）` 与旧写法 `未产出结果块` 都认）；预算/看门狗/调试迭代熔断是确定性失败，不续；② 卡 frontmatter 无 `auto_resumed_at` 或距上次自动续 ≥24h（`autoResume.cooldownHours` 可调）——自动续后再 blocked 不立即重试，等人工或冷却过期；③ 每次 drain 最多 `autoResume.maxPerRun` 张（缺省 2），blocked 最早的先续。每次自动续记 `auto_resume { card, attempts }` 事件（人工 resume 的 `resumed by human` 与之区分）。drift 降级期间整个通道暂停（降级 = 全人工）。全局关闭：workflow.json 写 `"autoResume": { "enabled": false }`（其余键缺省即 true/2/24）。

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
  - 永不自动提交（即使 enabled）：`deps` 类型、`feature` 类型（走上游管线 B3.5，2026-11 起）、`created_by: human` 的人工草稿、files_hint 命中 corePaths/releasePaths 的卡。
  - 开启即代表持久授权「该类型提案自动进队列」，替代逐卡对话确认。

### B2. 巡检（scan 的 6 类信号源）

TODO/FIXME（src/）· npm audit · 测试失败（--tests 慢路径）· GitHub open issues（gh best-effort）· **known-issues 账本**（docs/known-issues.md 未修条目，已修/暂缓自动跳过——人工裁决不被自主提案推翻）· **主干 CI 失败**（gh run list，按 head sha 建 id）。全部内容过 sanitize 消毒（无法携带指令结构进 worker prompt）；id 按内容哈希，信号不变自动去重；gh 类信号仅 GitHub 远端启用、失败警告跳过。
- **信号两级过滤**（程序 Fast Path 永启 + LLM Slow Path 按 `scan.smartFilter: true` 开启，缺省关）：落卡写 frontmatter `signal_hashes`；同源信号**直通在途卡**（「补充信号」小节追加，记 `signal_relayed`，不重复开卡），与 14 天内 merged/failed 卡同信号的**丢弃**（记 `signal_dropped`）；LLM 层对剩余候选**批量一次**调用（≤50 条，成本上界写死），判定 card/drop/merge，失败全部保守回落开卡（宁多勿漏，`scan_semantic` 事件）；每轮落 `scan_filtered` 总账（raw/keep/relayed/dropped/merged_away）。引擎用 review.backend 同款，模型 `scan.smartModel`（缺省回落 review.model）。

### B3. propose（planner 需求综合）

`propose`：goals.md + drafts 巡检信号 + 队列现状 → 一次只读 planner 会话产出至多 `maxProposalsPerCycle` 张高质量提案（验收标准带具体行为断言、files_hint 精确、目标对齐），落 drafts/；白名单卡立即自动提交。深化既有提案用**同 id**（落盘覆盖=升级）。烧钱动作；`nightly --plan` 与 watch（autopilot 开时）内部调用同一命令。

- **feature 提案必带 research 行（2026-11）**：产出契约要求 feature 卡 frontmatter 写 `research: <brief id>`（无既有 brief 写 `todo`）——feature 不直接进队列，走上游管线（B3.5）。
- **量化评分（可选，2026-11）**：frontmatter `score` 四因子 value/effort/confidence/risk 各 1-3 档 + `evidence` 证据数组（一句话一条）。纯规则消费（`orchestrator/score.mjs`，零 LLM）：只用于 drain **同优先级内定序**（带分先于无分、复合分降序），不越权改 gate/分级；证据不足就整体省略（宁缺毋滥）。
- **舰队反馈（可选，workflow.json `"propose": { "feedback": true }`，缺省关 = prompt 与历史逐字节一致）**：开启后 planner prompt 在「队列现状」之后追加**舰队反馈**段——只放数据事实、不写硬指令，让 planner 按数据自行定 priority 取舍：近 7 天 near-miss 四类分布（watchdog suspect / 瞬时重试 / 偏航报警 / 事故调查包）、各 type 卡消化数据（merged 率 / merged 平均 wall / merged 平均 token 峰值）、质量漂移降级状态、goals.md「当前主题」摘录。数据与 `stats` 命令同源同口径（`orchestrator/stats.mjs` 的 `collectStatsSummary`，数据窗口固定近 7 天 = stats `--days` 缺省）；`nightly --plan` / watch / sail 内部走同一 propose 命令自动受益。

### B3.5 上游管线（research → spec → 人工审设计 → spec build）

**feature 类提案不直接进队列**（2026-11 Plan A：canSailSubmit / canAutoSubmit 双侧硬拒，白名单配置加回 feature 也不放大授权面），走四步管线——自动化的是「调研与设计稿」，**设计审批权永远在人**：

1. **调研**：`research "<问题>" [--model <模型名>]` 派 researcher 会话（工具面 = Read/Glob/Grep + WebFetch/WebSearch + `mcp__zsearch__web_search`（船东已注册本地 zsearch MCP 搜索包时；未注册多余项无害），无 Bash 无写，fail-closed 同 reviewer；maxTurns 25），产出 `research/<id>/brief.md` 五段契约（结论/选项对比/引用/建议/罗盘对齐）+ `sources/` 引用快照（尽力而为，单条失败不阻断）。**调研船解耦选型（2026-11-08）**：`--model` 显式 > workflow.json `research.model` > claude CLI 全局默认——实证全局默认模型检索接地失效时产出旧世界内容，researcher 必须独立配模型。**无引用即拒收**（引用 ≥ `--min-citations` 缺省 1）——结论必须可溯源，`research list` 查看。**引用日期 gate（2026-11-08 编造引用事故后加）**：prompt 显式注入今天的日期（headless 会话对「当前日期」不可靠），每条引用行必须以当日访问日期开头（`- YYYY-MM-DD <URL> — 来源名：依据`）；gate 强校验：**未来日期或超 7 天陈旧日期视为编造、裸 URL 行不计入**，一律拒收重做；prompt 同时要求一手来源优先、关键结论双源交叉、查不到写「未证实」。契约通过 ≠ 内容为真——转述前仍须人工核内容可信度。`research --selftest` 实测当前后端联网工具可用性（非 Anthropic 网关上 WebSearch 常不可用，此时退化 WebFetch-only、引用不足的 brief 被拒收重试；烧少量 token，换网关/换源后手动跑一次）。
2. **提案关联**：propose 产 feature 卡 frontmatter 写 `research: <brief id | todo>`（queue.mjs 校验：brief id 语法或 `todo`；brief 存在性在消费侧查）。
3. **spec 升级（sail 规划轮自动补齐）**：feature 提案缺 brief 则派调研（每周期上限 `freeSail.researchPerCycle` 缺省 2），brief 到手后 `specFromDraft` 以**提案同 id** 落 spec 三件套（每周期上限 `freeSail.specPerCycle` 缺省 1）；未完成下周期重试（提案同 id 覆盖=升级，不重复烧）。交互场景手动 `spec "<意图>" --from-brief <id>` 等价。
   - **多维调研（research multi，2026-11-09 P1 机制化；P2 起维度并发池）**：单份 brief 覆盖不下时 `research multi "<主题>" --dim "<维度1>" --dim "<维度2>" … [--model m]`——维度 ≥2 才算 multi（单维直接 research），上限 `research.maxDims`（缺省 4，超出报可操作错误）。每维问题 = `主题——维度` 喂同一 researcher 会话（三连败重试自带），走**有界并发池**：同时最多 `research.concurrency` 维在跑（workflow.json 可调，1–4 整数缺省 2，非法值 warn+回落；`dims` 数组按 `--dim` 顺序回填，与完成先后无关），brief id 强制 `<topic-slug>-d<N>`（忽略模型自报 id，并行/连跑的 TOCTOU 竞态从命名空间上消灭；topic-id 撞车自动 -2…-9 派生，落盘瞬间 `writeTopicAuto` 'wx' 排他复检再兜一层同主题并行互覆）；**单维失败隔离**（dims 记 failed + stderr 尾摘要，批次继续；全维失败才 die）。产出复合清单 `research/topics/<topic-id>.json`：`dims[]` 逐维留痕 + `rollup`（各 ok 维最差档聚合：internal_decision 序 unsafe > needs_review > undetermined > ok，任一 unsafe 一票否决整批；有失败维标 `partial: true`）。台账每维一条（附 `topic_id`/`dim`）。复核 `research verify <topic-id>` 逐维 L2（同并发池）后重算 rollup。topic 消费契约见 `.agents/docs/research-verdict.md` topic 节——消费方只读 `rollup.internal_decision` 决策；**spec 注入（P2）**：`spec "<意图>" --from-brief <topic-id>` 自动按维展开（每 ok 维一节 + 失败维缺口行；rollup unsafe 一票否决拒绝注入，undetermined 提示先 verify）。
4. **人审 + 拆卡**：spec 落盘即停——**等人审设计**；审完 `spec build <id>` 拆卡进队列（gate=L3），开发→测试→审查照走闭环。

航海报告「为什么这么编排」如实收录上游管线去向（brief 产出 / spec 落盘待人审 / 失败原因与重试提示）。**可信度判定三层（问题无关，2026-11-08，verdict/2）**：L1 快照回查——调研产出后自动跑（`assessBrief`：从结论提取数字/型号名 grep 所引 `sources/` 快照 + 引用深度比，**report-only 亮牌不阻断**；管线内同步跑）；L2 `research verify <brief-id>`——异构复核（claim 级：每条承重结论**逐字摘录自 brief**（非逐字丢弃计 `fabricated_claims` 红旗）+ 五枚举状态 supported/partial/unsupported/contradicted/unverifiable；**contradicted 一票否决 → unsafe**；coverage<50% 硬底线不得放行；L1 数字可核的 claim 自动标注优先于 LLM 意见）；L3 `research stats`——按调研船模型聚合核实率与判级分布（台账 `research/ledger.jsonl`，信任=统计量）。**结果交其他 agent 决策时附消费方契约 `.agents/docs/research-verdict.md`——对方只读 `usage` 字段行动（ok/needs_review/unsafe/undetermined）**；`advisory: true` 不绕过 spec/合并闸门。**快照质量可观测（2026-11-09）**：verdict 带 `snapshots: {total, usable, skeleton}`——骨架页（剥标签可见文本 <400 字，客户端渲染/被拦的典型形态）只标注不改判级（meta 描述仍可佐证排名类结论），数字类结论可核性受限时 reasons 有提示。**完成事件飞书通知（缩范围：只推不做按钮）**：research/verify 落判定后推一条判级+usage 摘要到 webhook（`research.notify: false` 可关；research 决策不是卡片 approve 能表达的动作，批示回流仍限卡片闸门）。**标题带项目名前缀——飞书自定义关键词过滤按消息文本命中，无关键词整条静默丢弃（HTTP 200 + code 19024，2026-11-09 实测）**；项目改名/机器人换关键词时同步调 `research` 通知的命中词。调研产出质量的回归评测见 D7（discovery-evals）。

### B4. 夜航巡港（nightly）与 schedule（每日波次）

`nightly` = scan 出提案 + autopilot 白名单提交 + drift 报告 + 队列摘要（默认零烧钱；`--plan` 加跑 planner；`--auto N` 夜间对 high 提案提交并发起闭环再 drain N 个——worker 烧钱仅此档，gate=L3 兜底合并仍人工）。`schedule install --hour 2 --minute 30 [--auto 3] [--mode watch]` 注册定时（launchd/crontab/schtasks 经 wrapper 绝对路径启动，不依赖调度环境 PATH；仓库挪位置后重装）。日志 `logs/nightly.log`（超 5MB 轮转）。跑完发通知：macOS 本地通知 + `${envPrefix}_NIGHTLY_WEBHOOK`（如 `AGENTS_NIGHTLY_WEBHOOK`，旧名 MODELRDOCK_* 兼容）POST `{title, body, ts}`；通知尽力而为，摘要始终在日志。
中断恢复与双跑防护：nightly 启动时对账 `logs/nightly-state.json`——上次未正常收尾（崩溃/强制重启）则记 `nightly_recovered` + webhook 通知后照常执行；距上次完成不足 20 小时且非人工触发判为补触发双跑，跳过本次（终端 TTY 自动识别人工，脚本场景加 `--manual`）。webhook URL 直接填**飞书 / 企业微信 / Slack** 群机器人地址（按端点域名自动适配三家消息格式；飞书自定义关键词配 `nightly` 或 `ModelDock` 均可命中）。**飞书签名校验（2026-11 起）**：机器人开启「签名校验」后，出站消息自动附 `timestamp`+`sign`（HMAC-SHA256，官方规范）——签名密钥二选一配置：env `AGENTS_LARK_SIGN_SECRET`，或 darwin 钥匙串（workflow.json `"notify": { "signSecretService": "<服务名>" }`，密钥经 `security find-generic-password` 存取，参照 webhook URL 的钥匙串模式）；**未配置 = 现状不变**（不签名，机器人需关闭签名校验或改用自定义关键词）。wrapper 固化 install 时刻的参数与路径——orchestrator 侧默认值/参数变更后需重跑 `schedule install`。

### B5. 瞭望模式（watch，连续自治）

`watch --interval 30`：每周期 drain pending → 队列空时 scan 出提案 →（autopilot 开时）propose → 休眠循环。

- 停止：`touch .agents/orchestrator/.watch-stop`（下周期即停并清文件）或 Ctrl-C；**drift 降级自动退出**（保险丝不允许自己插回去，人工 `drift --clear` 后重启）。
- 每周期重读 workflow.json——改 autopilot 配置下周期即生效，无需重启（**配置守卫例外**：workflow.json 被外部改写期间派发暂停待人工核实，见 B12）。`--interval 0 --max-cycles N` 为测试档（不休眠）。
- **投机重探**：每周期检查 blocked 卡——worker 异常结束 + 瞬时故障签名且从未重探过的，一次性有痕 resume（`speculative_resume` 事件）；熔断卡与 worker 自报 stuck 永不重探（「永不静默重试」红线不变）。
- **风暴闸（weather hold）**：瞭望位先看天——每次派发前无状态统计最近 `windowMinutes` 分钟（缺省 60）各任务 `worker_retry` 合计，达 `threshold`（缺省 3）即停止派发（drain/nightly --auto/watch 通用）：日志「风暴滞留」+ webhook 通知 + fleet 级事件 `weather_hold`（`logs/fleet.jsonl`，跨任务调度层留痕）。可选**上游海况**子键 `"upstream": {"threshold": 5, "windowMinutes": 60, "source": "metrics"}`：**metrics 数据面**（2026-11-04 起缺省）优先消费网关 `/_modeldock/metrics` 的权威海况——`sea_state.storm` 直通滞留 + 60 分钟窗限流/额度类请求（429+quota）真实计数达阈值同样滞留（网关先于 worker 看到上游限流，触发时点名为「上游风暴」；阈值 ≤5 可保证网关判风暴时计数闸必触发，因网关 60m 风暴规则最低 6 次 429）；admin 不可达/端点失败自动落回**网关日志扫描**（`gatewayLogDir`，须已配置；429/402 计数，fail-open——观测失败绝不阻断派发）。`source: "log"` 显式降级为仅日志扫描（不发起 metrics 探测）。workflow.json 可选键 `"weatherHold": {"enabled": true, "threshold": 3, "windowMinutes": 60, "upstream": {...}}`（`enabled` 缺省 true，显式 false = 关闭），**未配 = 关闭**（行为与历史版本一致）；窗口滑过自动恢复（不落 hold 标记文件），瞬时重试退避基值可经 `ORCH_RETRY_WAIT_MS` 注入（缺省 60s×attempt）。
- 与 drain/nightly 共用调度器锁：watch 在跑时手动 drain 提示退出而非并发。
- **与模型级容灾的交互（有意取舍，2026-11-08）**：上游服务配置了 `model_fallback` 时，额度类上游错误（402 / 429 quota）被网关在同服务内吸收改发，worker 不再看到 402/quota cause——风暴闸对这类风暴的灵敏度随之下降，这是特性本身的目的（吸收而非扩散），不是漏报。编排器零代码改动；需要分辨「额度耗尽但已被吸收」时看网关用量面（`/_modeldock/usage` 的 `tokens_by_model` 按模型分桶，备用模型的桶出现即说明改发已发生）。

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

**风暴闸 weatherHold**（瞬时故障密集时自动停派发；**本仓已开启**，纯安全闸无计费影响）：
1. workflow.json 加 `"weatherHold": { "enabled": true, "threshold": 3, "windowMinutes": 60, "upstream": { "source": "metrics", "threshold": 5, "windowMinutes": 60 } }`（阈值=窗口内 worker_retry 合计；上游海况 metrics 数据面优先——`sea_state.storm` 直通 + 60 分钟 429+quota 计数，admin 不可得自动落回网关日志 429/402 扫描，须同时配置 `gatewayLogDir`；`source: "log"` 可显式降级为仅日志）；
2. 验证：窗口内凑满阈值后，下次 drain / watch 周期应打「⛈ 风暴滞留」并停派发（fleet.jsonl 留 `weather_hold`），窗口滑过自动恢复、无需清理状态；
3. 滞留通知走 `${envPrefix}_ORCH_WEBHOOK`；滞留期 announce 只发一次防刷屏。

**不变的红线**：两者开启都不触碰合并分级（corePaths→L2 / releasePaths→L3）、发布人工授权与「永不静默重试」——自动的是「进队列」，不是「进主干」。

### B8. 故障处置升级链（escalation，分级自动化审批）

故障处置按 token 成本分级自动升级，人只出现在高成本档（船东 2026-11-02 定案）：

| 档位 | 成本 | 机制 | 状态 |
|---|---|---|---|
| 第 0 档 | 零成本自动 | worker 瞬时故障原地重试（≤3，**结构化信号优先**：网关日志会话窗口内本 harness 的 429/5xx/quota 记录命中即定性 `worker_retry source=gateway`——上游改错误文案不再致盲；无网关数据/未命中/读取失败 fail-open 落回 stderr 正则兜底）、调试/审查返工循环、blocked 卡自动续跑（autoresume：transient 或「未产出结果块」族才续、24h 冷却）、watch 有痕重探 | 已内置 |
| 第 1 档 | 低成本计费自动 | **zcode 船 prompt 超限（>30k argv 上限）自动切 fallback 船**：`engine_escalated` 事件留痕，预算延续不重置，每 run 至多一次 | workflow.json `escalation.enabled`（缺省关） |
| 第 2 档 | 高成本人工审批 | 旗舰档（ahead-4）/ 加大预算 / 换供应商 | 永不自动——调度台停下请示 |

- `escalation: { enabled: true, fallbackBackend: "claude-headless" }`——**fallbackBackend 写进配置即持久授权**（同 autopilot 哲学），运行时不再为换船请示。
- 红线不变：预算熔断永远硬顶（escalation 不重置不放宽预算）；所有升档事件留痕（永不静默）；第 0/1 档只救「装不下/瞬时限流」类故障，验收失败照走调试与人工闸门。

### B9. 自由航行（sail，时间盒完全自治）

`node .agents/scripts/orchestrator.mjs sail --minutes 120`（或 `--duration 2h|90m|1h30m`，可加 `--max-cost-usd N` 燃油上限）：船长自勘海况（scan 巡检）→ 自绘航线（propose 产卡，编排理由写在卡上）→ 自航自泊（drain 全门禁闭环）→ 到点收帆交**航海报告**——完成了什么、为什么这么编排、燃油账几何，落 `logs/sail/<ts>/report.md`（stdout 同文 + webhook 通知 + fleet 留痕，`sail_started`/`sail_finished`）。与 watch 的差别：有硬时长预算、报告收口、自动提交不依赖 autopilot 配置。

- **授权模型**：人显式敲下带时长的 sail 命令 = 本航次自动提交授权。硬禁区不变（配置只收窄、永不放大）：`created_by: human` 人工草稿、`deps` 类型、`feature` 类型（走上游管线 B3.5，2026-11 起——此前 feature 提案直接进队列，设计无人看过）、files_hint 命中 corePaths/releasePaths 永不自动；类型白名单 workflow.json `freeSail.autoSubmitTypes`（缺省 `["docs","bugfix","refactor"]`）；提交 gate 覆写 L1——实际合并仍由分级裁决 + drift 保险丝兜底。开航前已有的存量 drafts 永不自动提交。
- **循环**：pending 非空 → `drain --max 1`（一次只派一张，每张之间重新看表）；队列空 → scan + propose + **上游管线（feature 提案派调研、升级 spec 落盘待人审，B3.5）** + 自动提交（非 feature）→ 立即派发；仍空 → 休眠 `--interval`（缺省 10 分钟）再看海况——planner 空手轮由休眠挡住，不会连环烧钱。每周期重读 workflow.json（改配置即时生效；**配置守卫例外**见 B12——workflow.json 被外部改写期间跳过派发与规划）。
- **停止条件（任一）**：到达 `--minutes/--duration`、`.agents/orchestrator/.sail-stop` 文件（下周期即停并清文件）、drift 降级（人工 `drift --clear` 后再启）、`--max-tasks N` 派发上限、**`--max-cost-usd N` 燃油上限**（网关实测价 ≥ 上限即收帆并记 `sail_cost_cap`——**只停不换引擎**，换计费方必须人批；检查节流 60s）、连续 3 轮派发无进展（队列卡在待引水/解析失败时触发）。**软截止**：跑着的任务让它跑完，不超时强杀；风暴闸滞留期跳过派发与规划（scan 照跑——不派 worker），窗口滑过自动恢复。
- **燃油账（报告「值不值得」的依据）**：本航次 [起航, 收帆] 网关实测 token × 价目 = USD（总账 + 逐卡拆账，逐卡按各自事件时间窗投影）；worker 直连上游时如实标「不可测」；收帆时若成本上限已触发，按完整航程重算覆盖触发时刻快照。
- **报告口径（为什么这么编排）**：全部确定性组装、不再烧 LLM——战果清单按队列快照差分（merged / 待放行 / 搁浅退关 / 剩余 pending，开航基线如实区分「开航前已在队列」与「本航次新增」）；编排理由直接引用 planner 卡片上的目标句原文 + 每周期提交/否决原因 + goals.md 罗盘对齐说明。voyage.json 逐周期落盘，SIGINT 强杀后也能续查航迹。

### B10. 双向批示（approval listener，飞书卡片远程审批闸门）

闸门通知原来只有单行文本（B4 webhook）——人不在电脑前就得等回工位再批。双向批示把回路补上：**需要人工动作的落位事件在文本通知之外多发一张飞书交互卡片，群里点按钮即可远程批示 approve / reject / retry**。缺省完全不启用：卡片开关不开不发卡、监听器不启动不占端口，行为与历史版本零差异。

- **通知侧（发卡）**：workflow.json 可选键 `"notify": { "cardWebhook": true }`（缺省 false）。开启后，`awaiting-human` / `blocked`（含预算熔断、看门狗等 circuit_breaker 落位）与风暴闸 `weather_hold` 会在原文本通知（`${envPrefix}_ORCH_WEBHOOK`，一字节不改）之外**额外** POST 一张飞书 interactive 卡：approve（批准合并）/ reject（驳回）按钮 value 携带 `{ task, action }`，weather_hold 为 fleet 级事件没有可批示单卡 → 纯信息卡不带按钮。webhook URL 复用既有解析链（env 优先 + darwin 钥匙串兜底）；**仅飞书端点发卡**（企业微信/Slack 自动跳过，只收文本）。
- **回流侧（批示）**：`node .agents/scripts/approval-listener.mjs [--port N] [--root <仓库根>]` 显式启动（缺省端口只认 workflow.json `notify.listenerPort`，都没配报错退出——**永不缺省监听**；只绑 `127.0.0.1`）。飞书卡片回调打过来：`url_verification` 握手直接回显 challenge；动作回调验签（verification token 须与 env `AGENTS_LARK_VERIFICATION_TOKEN` **常数时间一致**——sha256 归一化后 `timingSafeEqual`，防时序侧信道逐字节猜测，2026-11 起；不一致 403 并落审计 `approvals.jsonl`（只记 `rejected` 事实与来源 IP，**绝不记 token 值**）；env 未配拒绝所有动作）后映射为 orchestrator 既有命令 `approve/reject/retry <task-id>`（reject 无原因用默认文案），结果以 toast 回复群里。同 task 同 action 60s 内重复点击忽略（防手抖）；审计逐行落 `.agents/orchestrator/logs/approvals.jsonl`（ts/task/action/来源 IP/结果）。
- **安全边界**：监听器自身不引入新权限——映射目标全是 orchestrator 既有闸门命令，approve 仍走 feature-branch finish 的完整门禁与 testCmd，合并权实质在门禁与人；token 属密钥，不写日志不入库；监听器只收 POST、请求体上限 1MB、外网触达须自行架转发（frp / 云主机反代 / Tailscale Funnel 等）并自行评估暴露面。飞书侧配置步骤见 [orchestrator-usage.md](../docs/orchestrator-usage.md)。

### B11. 动态选船（dynamic dispatch，阶段 3）

派发时用「海况信号 + 卡难度」在**预授权包络**内自动选执行船（backend）。授权哲学与 escalation.fallbackBackend / autopilot 一致：**envelope 显式写进 workflow.json = 持久授权**，包络内换船运行时不再请示（引擎切换人工闸门保留，只加包络豁免分支——起止两船都在 envelope 内即放行）；包络外永不自动切。**缺省关**——workflow.json 无 `dynamicDispatch` 键 = 决策完全不参与，行为与历史一致。

```json
"dynamicDispatch": {
  "enabled": true,
  "envelope": ["zcode-headless", "claude-headless"],
  "models": { "claude-headless": "<可选模型名>" }
}
```

**本仓现状（2026-11-04）**：workflow.json 已按上例开启双船互切 `envelope: ["zcode-headless", "claude-headless"]`——zcode 默认船 + claude 前进3/4 船，包络内互切不再逐卡请示；429 风险由网关多 key 池 + worker 并发闸 + failover 兜底。

- **规则**：① 海况健康 + 无难度信号 → 沿用 workflow.json `worker.backend`；② 卡难度偏好：tier 生效（token 已解析）→ claude（zcode 不支持 tier，不给它派 tier model）；ahead-1/2（含旧 `light`）→ zcode（免费默认船）、ahead-3/4（含旧 `heavy`）→ claude；files_hint 命中 corePaths/releasePaths 视作高难度 → claude；③ 所选船海况恶劣（该船 harness 绕开狗粮 dogfood_bypass / 未经接管 not_attached / CLI 不可用）→ 换包络内下一个健康船；④ 全港风暴 → 包络内换船无益（同一网关同一批上游，熔断由网关自动路由避开），沿用默认并留痕。风暴判定**权威海况优先**（2026-11-04 A2）：优先消费网关 `/_modeldock/metrics` 的 `sea_state.storm`（reason 带 `[storm_sea_state]`）与 meltdown 清单，服务熔断（fleet 观测）/ 上游限流（日志扫描）/ worker 重试密集保留为海况快照缺席时的回落。
- **派发预检（model-availability，2026-11-04 A5）**：派发决策后核对 worker 模型（`tier.workerModel` > `worker.model`）是否还在上游服务目录里——tier token 经 `/_modeldock/tier-validate` 权威解析到 provider（ship→provider 推断不做：无 tier token 即不预检），再查 `/_modeldock/model-availability` 条目：**条目存在且新鲜（<25h，探测周期 24h+1h 余量）且 `ok:true` 且 `model_ids` 非空且不含该模型** → 滞留派发：卡 pending→blocked（队列保留不丢，模型恢复后 resume）+ `dispatch_held {reason:"model_unavailable", provider, model}` 事件；条目缺席（从未探测 ≠ 不可用）/ 陈旧 / `ok:false`（探测失败 ≠ 模型不可用）/ admin 不可达 → 一律照常派发（fail-open）。快照 5 分钟节流缓存。
- **不越权三律**：显式 CLI `--worker-backend` / `--backend` 最高优先（动态选船直接让位，不留痕）；resume/retry 沿用上次会话（会话连续性优先，中途不换船）；mock 永不参与自动选船（测试链路照常可用，mock 也不进 envelope）。
- **留痕**：所有非常规选择记 `dispatch_selected { from, to, switched, reason }` 事件（永不静默红线）；决策链任何一步失败自动回落「不决策」按既有规则派发——动态选船是优化，绝不阻断派发。
- **与 fleet observe 的关系**：阶段 1 观测（`fleet_observed`）只照亮不决策，本节是它的决策消费者。难度路由不需要网关（纯卡面信号）；逐船海况判读需要 `gatewayAdmin: true` 的观测快照，观测缺席不判恶劣（观测缺席 ≠ 风暴）。
- **与 escalation 的关系**：escalation（B8，zcode 30k 自动升档）在动态选船之后作外层兜底，逻辑不动；预算熔断不受动态选船影响（换船不重置预算）。

### B12. worker 并发供给闸（scheduling.maxWorkers，如何解锁 workers=2）

drain 的有效并发 = **min(请求并发, provider 容量)**——请求并发 = CLI `--workers N`（显式单次意图，最高优先）> workflow.json `scheduling.maxWorkers`（缺省 1 = 现状不变）。容量经网关 admin 面观测（`gatewayAdmin: true` 才触达）：worker tier token → `/_modeldock/tier-validate` 解析到 provider → 查该 provider 的 `max_concurrency`（`/_modeldock/config`）与 key 池健康（`/_modeldock/metrics` 的 `keypool[provider]`）。

- **解锁 workers=2 的完整步骤**（船东操作，编排器绝不自行触碰生产配置）：
  1. 在 ModelDock（生产实例）给 worker 用的 provider 配 `max_concurrency >= 2`（Web 控制台「编辑服务」或 config.toml）——网关侧信号量 + 排队由此生效，上游不再被并发打 429；可选配多 key 池（`keys` >= 2）进一步扩容；
  2. 给 worker 卡配 tier（token 指向该 provider 的 harness）——供给闸靠 tier token 定位 provider；
  3. workflow.json 设 `"scheduling": { "maxWorkers": 2 }`（自动化常态）或单次 `drain --workers 2`。
- **判定**：`max_concurrency>=2` 且（key 池 `healthy>=2` 或 `total>=2`）→ 容量 = min(max_concurrency, healthy/total)；否则容量 = 1。自动扩容生效（无显式 `--workers` 时）记 fleet 级 `workers_scaled { from, to, provider, reason }` 事件；请求被容量压低同样留痕（`观测缺席`/`未解锁`/`key 池不足` 等原因写在 reason）。
- **fail-open 口径**：`gatewayAdmin` 未开 → 完全不设闸不触达（行为与历史一致）；观测面已开但网关不可达/字段缺失 → 容量按 1（回落单 worker 现状，只是不扩容，派发照常，绝不因观测失败中断 drain）；所有观测请求超时 ≤3s，每 drain 只探一次。
- **与预算实测账的配合**：多 worker 同跑时各自卡独立计账；同 tier 并发 worker 共享同一 harness 实测账（实测增量互相可见——预算判定偏保守方向，只早熔断不漏熔断）。

**预算实测账（A4，配合 B12）**：worker 运行中每 60s 轮询 `/_modeldock/harness-usage` 的 `day_billable_tokens`（网关实测**可计费**口径，剔除缓存读）做低油量/熔断判定——zcode 无逐 turn 自报（会话结束才一次性回填），此前 token 预算对它近乎失效；实测账补上真实逐时段预算。harness↔task 映射由 tier token 经 tier-validate 解析，记在 `tier_resolved` 事件的 `gateway_harness` 字段；实测以「本任务起点基线」取增量（同 harness 其他流量不计入本任务，防跨任务假阳性）；字段缺失（旧网关）或观测不可达 → 自报账照旧兜底。reconcile 离线对账逻辑不变。大 prompt（>2 万字符，D17）自动落 `logs/<taskId>/prompt-full.md` 全文、worker prompt 收缩为文件引用 + 要点摘要——不再依赖 zcode argv 30k 超限后的换船兜底（escalation 保留为最后防线）。
### B13. 配置守卫（configGuard，workflow.json 自改防护）

workflow.json 是编排器的**授权面**（autopilot 白名单、escalation fallback 船、dynamicDispatch 包络、budgetProfiles 全住这里）——2026-11 实证事故：sail 派发的卡在 worktree 里自改 workflow.json 的默认引擎并合并，授权配置被**被调度方**改写而编排器无感。守卫语义（缺省开，`"configGuard": { "enabled": false }` 关闭，不推荐）：

- run/drain/watch/sail 启动时记 workflow.json 的 **sha256 基线**；每次派发前校验（drain 逐卡发射前、watch/sail 每周期、run 每个 worker 会话边界）。
- 不匹配 → fleet 级事件 `config_drift_detected`（含前后 hash）+ webhook 通知 + **暂停新派发**（在途任务继续）。同一漂移 episode 只宣布一次。
- **恢复 = 重新校验通过**：文件改回基线内容（hash 复合）自动恢复；编排器**自己** finish 合并导致的合法变更（合并卡已过门禁与人审）在 doApprove 完成后自动重置基线。人工/外部改 workflow.json 要生效：核实后**重启编排器**（重启即重新记基线）——老语义「watch 每周期重读配置即时生效」在守卫生效期间让位。
- 进程边界说明：drain 派的 run 是子进程，子进程 merge 后重置的是子进程自己的基线——父 drain 会在下次派发前发现漂移并暂停，操作者核实（正是「卡改了授权配置」这类变更需要人过目）后重启即可。这是有意从严：合并进主干的 workflow.json 变更一律要求一次人工确认。
- run 进程内漂移（外部改写发生在闭环中途）：当前会话照常收尾，下一个会话派发前守卫拦停，卡转 `blocked/`（reason=config_drift）附调查包，人工核实后 resume。

### B14. 提案生命周期（drafts gc，B9 清退机制）

drafts/ 提案此前只进不出（16 张积压实证，其中 ≥3 张已被 merged 工作覆盖）。两条生命周期（**永不删除文件，只迁移目录**）：

- **自动 superseded（闭环内动作，merge 即触发）**：卡落 merged/ 时，drafts/ 里 `files_hint` 与刚合并卡**路径重叠**（前缀精确口径：同文件/同目录/互为路径前缀；完全通配 `**` 独占；仅标题相似**不迁**——防误杀，只在 gc 报告提示）的提案自动迁入 `drafts/superseded/`，文件头标注 `superseded_by: <合并卡 id>`。关闭：`"draftsGc": { "autoSupersede": false }`。fleet 留痕 `drafts_superseded`。
- **老化（手动档）**：`orchestrator drafts gc [--apply]`——缺省 dry-run 只列清单（superseded 候选 / 超 `draftsGc.archiveDays`（缺省 30 天）的 aged 候选 / 仅标题相似的提示）；`--apply` 才迁移（superseded 带标注、aged 原文迁入 `drafts/archived/`）。年龄口径：frontmatter `created_at` 优先、mtime 兜底、都缺不老化（宁少勿滥）。
- 已在 superseded/ 或 archived/ 的提案不回锅（`drafts gc` 只扫顶层 .md）；同名目标文件已存在跳过不覆盖（Windows rename 语义安全），失败留原地等人工。

### B15. scan 卡自动转修复卡（scanAutoFix，B10 断链自愈）

主干巡检卡（id `scan-*` 前缀，scanner 产出）failed 是终态，此前只能人工 abandon——scan→修复的自动链断路。现在 drain 处理到**本轮落位 failed 的 scan 卡**时自动补一张 pending 修复卡：

- 修复卡 id `fix-<原名>`（如 `scan-ci-414aba6c` → `fix-scan-ci-414aba6c`），正文引用原卡路径、`incident.md` 调查包与失败摘要（最后一条 failed/blocked 事件的 reason）；`files_hint`/type/priority/gate 继承原卡。**它是普通任务卡，照走既有全部门禁**（引水闸/L2L3 人审不绕过）。
- 防循环双保险：① 修复卡 id 无 `scan-` 前缀，自身 failed 不再繁殖新卡；② 同名修复卡在**任一队列状态**已存在即跳过（merged/failed 也算——scan 卡永驻 failed/，按状态白名单去重会跨 drain 打环）。
- 事件留痕：原卡日志记 `scan_autofix { fix, reason }`。关闭：`"scanAutoFix": { "enabled": false }`（恢复旧行为）。

### B16. 每任务一次性凭据（gatewayProvision，ephemeral harness）

worker/reviewer 的凭据此前长期复用 tier token（env 注入，源头是长期 harness）。开启 `"gatewayProvision": true`（平铺键，缺省 false = 现状不变；前置 `gatewayAdmin: true`——admin 面同一授权域）后，run 在 spawn 前向网关 `/_modeldock/harness/provision` 签发**任务专属临时 harness**（TTL ≤24h 硬顶、不落盘、token 明文只在签发响应出现一次；id 确定性 `orch-<taskId>`，被占用自动降级为网关随机 id）：

- **注入口径**：env patch 只换 `ANTHROPIC_AUTH_TOKEN`（复用 tierEnvPatch 同形通道；claude-headless 的 settings.env + 子进程 env 双通道、zcode-headless 的 env 透传照旧，后者「CLI 是否认 env」的 no-op 风险同前）。**不注 base_url**——接入目标仍由 ModelDock attach 写好的客户端配置文件决定。zcode 不认 tier 的既有选船规则不变。
- **fail-open**：所有失败形态（admin 未配置/网关不可达/超时 ≤3s/非 2xx/响应缺字段）回落既有 tier token 路径，行为与未开启完全一致；每类失败留 `harness_provision_failed` 事件（含原因），绝不阻断派发。
- **实测账更准**：签发成功时预算实测轮询（B12 配合）按该 harnessId 精确取数——专属凭据没有同 harness 兄弟流量，基线污染消失；签发失败/未开启回落 tier token 解析的 harness（基线法照旧）。
- **吊销时机（best-effort，失败只告警不重试，漏网由 TTL 兜底）**：① 接管路径——run 启动时发现上次 run 签发未吊销的凭据（events.jsonl 查 `harness_provisioned`/`harness_revoked` 对账）先吊销再签新的；② 终态落位（blocked/failed 走 exitRun、merged/awaiting-human 走 finally）进程退出前吊销——awaiting-human 落位后无 worker 流量，一并吊销，approve/retry 的新 run 会重新签发；kill-tree/熔断终归收敛到这两条出口。
- **事件**：`harness_provisioned { harness_id, expires_at }`、`harness_revoked { harness_id, ok, existed, trigger: takeover|terminal|run_exit }`、`harness_provision_failed { reason }`。

## C. 观测与对账详解

### C1. stats 与 follow（引水传令）

- `stats --days 7 [--json] [--cost]`：每卡 wall/turns/调试与审查迭代/重试/watchdog suspect/follow-up/token 峰值（budget_snapshot 口径）+ 各状态卡数与合并率汇总；`--cost` 加燃油账（网关实测 token × 价目 = USD，一次日志扫描 + 一次价目请求服务全部任务，可测任务数与不可测原因如实标注）。JSON 形态：顶层 `summary` 嵌套对象 + `rows`。跨引擎精确对账用 reconcile。汇总含**安全晴雨表**（`summary.near_miss`，人类输出「安全晴雨表」行）：watchdog suspect / 瞬时重试 / 偏航报警（`xte_alarm`，确定性规则只留痕）/ 事故调查包（`incident.md`，VDR 终态自动归档）四类近乎事故计数——险情比事故多，先看晴雨表再定流程调优。
- `follow <task-id> "<补充指令>"`：给 running/ 的卡递话，写 `logs/<id>/inbox.md` + `follow_up` 事件，在下一次会话边界（调试返工/审查返工/resume/新 spawn）注入 prompt 尾部（20 条/4000 字符截断，前缀缓存友好）。只对 running 卡开放；awaiting-human 用 `retry --note`，pending 直接改卡文件。`status <task-id>` 会显示待送达条数。

### C2. drift（质量漂移保险丝）

自动合并回溯失败率超阈值（`driftThreshold` 缺省 0.2，**可调不可关**）→ 降级全人工（`run` 的自动合并全部回闸门，事件 reason=drift_degraded，fastlane 同步失效）。`drift` 看报告；根因消除后 `drift --clear` 人工恢复。

### C3. reconcile（狗粮对账）

`reconcile [task-id]`：① 用量对账——自报账（events budget_snapshot）vs 网关实测账（转发日志 usage），分歧率 = |自报−实测|/max，网关零流量标 ⚠（worker 绕过了狗粮）；启用条件 = workflow.json `gatewayLogDir` 已配置。**燃油账**（2026-11-02）：实测 token × 模型单价 = USD——价目经 `POST /_modeldock/pricing-lookup`（admin 面，需 `gatewayAdmin: true`）取网关权威价目（`~/.modeldock/pricing.json` 用户覆盖 > models.dev 目录牌价），取不到价按 $0 计并列 unpriced 清单；网关不可达回落陈价目缓存（logs/pricing-cache.json，标注「陈价目」），价目完全不可得时只出 token 账不打断对账主体。② 状态对账——git merge 现实 vs 队列落位：「已合并未落位」`--fix-states` 修复、「账面合并但 git 无实证」警告（squash/改史）。纯只读（除 --fix-states）。事故调查包（incident.md）的「上游海况」段复用同一投影（不过滤失败请求）：时间窗内请求/失败分布、路由事件痕迹（failover/down_all）、时延 p50/p95、实测用量与最近失败现场——回答「预算烧在哪」。

## D. 周边

### D1. spec（特性级先设计后施工）

`spec "<意图>" [--from-brief <brief-id|topic-id>]` → Planner 产出 requirements（用户故事 + EARS 验收）→ design（现状/方案/取舍/风险）→ tasks（可独立合并的任务段）三件套，落 `specs/<id>/` 人工审阅/手改 → `spec build <id>` 拆卡进队列（幂等；design 全文注入卡背景；tasks 的「文件」行直接成为 files_hint）。**人工闸门在「审设计」这一步**；拆出的卡 gate=L3，开发→测试→审查照走闭环。`spec status <id>` 看跨夜进度锚（progress.json）。`--from-brief <id>` 把调研结论注入设计（上游管线 glue，B3.5；id 缺失报错指路）：brief id 注入 brief 正文；命中 `topics/<id>.json` 的 topic id 自动按维展开（每 ok 维一节 + 失败维覆盖缺口行，P2 2026-11-09；rollup `unsafe` 一票否决拒绝注入，`undetermined` 提示先 `research verify` 不阻断；brief 与 topic id 可混排）。

### D1.5 spec review（三件套 agent 分层审查，advisory）

`spec review <id> [--backend <名>] [--model m]`：把「人肉通读三件套找问题」变成「人只裁决 findings 清单」（spec-review-cmd 卡，2026-11-10）。两层：**L0 确定性检查**零 token（三件套齐全/任务段四行/依赖 DAG/files_hint 存在/红线关键词/TBD/基线漂移警告——结构性 fail 直接 die 不烧 L2）；**L2 审查船** readonly 会话按 `.agents/conventions/spec-review.md` 规约五维评分 + findings（现状对账杀手锏：design 引用的代码事实逐个开文件核实）。服务端权威重算 overall（加权 + null 传染 + 定位对账失败降档）与 build_ready（blocked/rework/needs_revision/approve_to_build）。产物 `specs/<id>/review-verdict.json`（spec-verdict/1）+ L3 台账（kind=spec-review）+ 通知。**advisory 纪律：审查结论只做筛查，spec build 拆卡永远人工拍板**（与 research verdict 同哲学）。审查船模型解耦：backend 缺省 review.backend、model 缺省 review.model（异构互审）。教训：design「现状」定位一律符号+函数名（行号会漂，规约 §6）。

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

### D5. 舰队控制台（fleet-console，跨仓聚合）

一台机器上多个项目各自跑 Dockmaster 闭环时，健康度散落在各仓 `.agents/orchestrator/` 下；`fleet-console.mjs` 一条命令把整个「舰队」拉成一张只读看板（**纯只读，不改任何港口状态**，零第三方依赖，Node ≥18）：

```bash
node .agents/scripts/fleet-console.mjs [--project <目录>]... [--days 7] [--json]
```

- **项目清单**（合并去重）：CLI `--project`（可多次）+ 配置文件 `~/.agents/fleet-console.json`（`{ "projects": ["/abs/path", ...] }`，相对路径相对 `~/.agents` 解析；缺失视为无自定义，格式错误告警后忽略）+ 当前仓库（始终并入）。
- **每港采集**：queue 七状态卡数；`logs/fleet.jsonl` 近 N 天事件按类型计数（weather_hold / sail_* 等）；`logs/nightly-state.json` 上次巡检时间（有 startedAt 无 finishedAt 标 ⚠未收尾）；`degraded.json` 漂移降级标记；并 spawn **该仓自带**的 `orchestrator.mjs stats --json --days N`（cwd=该项目根，30s 超时）取窗口汇总——合并率与安全晴雨表 near_miss。各港用各港的编排器版本出账，工具链自包含语义不破。
- **容错**：无 `.agents/orchestrator/` 的项目标「非港口」跳过；stats 失败（脚本缺失/超时/退出非零/输出损坏）标「不可得」，该港其余指标照常出。
- **输出**：人类可读对齐表格（待泊/在坞/搁浅/待放行/出港 N 天/合并率/险情/风暴/漂移/巡检 + 全队合计行）；`--json` 出机器可读结构（`projects[]` + `totals`），供脚本与 cron 消费。全队合计的窗口汇总只对「stats 可得」的港口求和（`totals.stats_ok_ports` 标明覆盖面）。
- 典型用法：cron/nightly 拉一份 `--json` 存档；人工早上跑人类表格一眼看全队——哪港搁浅堆积、哪港风暴滞留、哪港漂移降级。

### D6. 验船师评测集（reviewer-evals）

reviewer 的回归评测集在 `.agents/review-evals/reviewer/cases/`（合成 diff + 期望判定成对，覆盖端口/路径/atomicWrite/import.meta 红线、越界、Windows、i18n、断言假绿 + 1 个干净负样本）。跑分器 `node .agents/scripts/reviewer-eval.mjs`：默认 dry-run 零消耗；`--run --backend …` 真跑（烧钱，人工发起）；`--grade <目录>` 静态重放评分（CI 可用）。改 REVIEW.md / reviewer prompt / 审查模型后必跑一轮，分数低于基线不保留；出题纪律与评分口径见 `.agents/review-evals/reviewer/README.md`。

### D7. 调研评测集（discovery-evals）

researcher（B3.5）的回归评测集在 `.agents/discovery-evals/cases/`（`<id>.json`：question + goals + minCitations + 期望关键词 mustFind/mustFindAny）。跑分器 `node .agents/scripts/discovery-eval.mjs`：默认 dry-run 零消耗（顺带校验案例 schema）；`--run --backend …` 真跑（烧钱，人工发起）。评分是确定性规则——无引用即拒收（引用数达标）+ 关键词命中率；引用真伪以输出留档与 brief sources/ 快照人工复核为准。改 researcher prompt / 模型 / 换网关后必跑一轮；出题纪律见 `.agents/discovery-evals/README.md`。

# Dockmaster 操作手册（.agents 自治编排体系）

> **Dockmaster（坞长）** 是本仓库 `.agents/` 自治编排体系的名字——ModelDock 的 Dock，管坞的人就是 dockmaster。**命令行名保持 `orchestrator.mjs` 不变**（改名零收益、破坏既有引用与肌肉记忆）；文档用港口隐喻叙事（官方映射表见下），接口名保持 orchestrator 不变。
> 目标读者：递交托运单（任务卡）、看闸门、处理搁浅（blocked）任务的 agent / 人类操作者。
> 设计与原理：`docs/design-orchestrator.md`（本文只讲怎么用）。运行前提：主仓库根目录运行；Node ≥18；零第三方依赖。

## 一张图看懂

```
需求侧（船东递交托运单）
         intent / spec ─────────┐
         巡检 scan ──→ drafts/（待审托运申请）── submit ──→ pending/（待泊）─┐
         autopilot（自动舵）白名单自动提交（缺省关）─────────────────────────┤
                                                                            ▼
执行侧（泊位修船）
         run / drain / watch ─→ worker（船坞工匠）在泊位（worktree）改码
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
船东视角全景：递交托运单 → 坞长派船坞工匠（worker）在泊位（worktree）修船 → 坞检（静态门禁）+ 验船师（reviewer）双重检验 → 船东放行出港（merged）；搁浅（blocked）的船由坞长组织拖救（`resume`），紧急抛锚（熔断）永远要船东裁决。

**官方映射表**——双层命名纪律：**比喻词只进文档层（首次出现括注原术语）；命令名 / 目录名 / frontmatter 字段 / 事件类型 / workflow.json 键名是接口契约，永不改名。**

| 概念 | 隐喻词 | 接口名（不动） |
|---|---|---|
| 体系 | 坞长 / 港务 | Dockmaster / `orchestrator.mjs` |
| 任务卡 | 托运单 | task card |
| worktree | 泊位 | worktree |
| pending | 待泊 | pending |
| blocked | 搁浅 | blocked |
| drafts 提案 | 待审托运申请 | drafts / proposal |
| goals.md | 罗盘 | goals.md |
| nightly | 夜航巡港 | nightly |
| follow | 引水传令 | follow |
| worker | 船坞工匠 | worker |
| LLM 审查 | 验船师 | reviewer |
| awaiting-human | 等待船东放行 | awaiting-human |
| merged | 出港 | merged |
| 熔断 | 紧急抛锚 | circuit breaker |
| watch | 瞭望模式 | watch |
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
tier: heavy                      # 可选：按难度选服务/模型（见 A4）；缺省命中核心路径自动升 heavy
ui_check: true                   # 可选：改 Web 控制台任务开启 UI 冒烟门禁（见 A8）
---

# 目标
一句话说清"改什么、为什么"。

# 验收标准
- `npm test` 全绿
- 新增用例覆盖：同名 id 覆盖、新 id 追加、格式错误阻断启动

# 红线（可选）
- 不改动 src/cli.ts

# 背景（可选）
现象、复现步骤、相关文件。
```

**验收标准是灵魂**：worker（船坞工匠）拿它当自查靶子、审查者（验船师）当评判基准、人（船东）当验收清单。写"做得好用一点"等于没写。**自报不可信**——orchestrator 亲自跑 testCmd 与 build 复核（含缓存读的 token、失败尾部 200 行都有据可查）。

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

### A3. 紧急抛锚（熔断）与看门狗（自动停，不会烧钱）

| 触发 | 行为 |
|---|---|
| 轮次 / token / wall-clock 超预算 | kill 进程树 → blocked |
| 测试修复超 `max_test_iterations` / 审查返工超 `max_review_iterations` | blocked（附失败尾部） |
| 看门狗（`watchdog.mode: actuate`）连续 2 次判定无实质进展 | kill → blocked |

全部记 `circuit_breaker` 事件，**永不静默重试**。看门狗缺省 observe 档：每 20 个 worker turn（`watchdog.everyTurns`）由一次性只读 LLM 判断是否空转，疑似只记 `watchdog_suspect`；actuate 是显式配置。每任务最多查 5 次，自身故障记 `watchdog_error`（≤3 条后静默）。瞬时故障（429/网络签名）原地退避重试 60s×attempt ≤3 次（`worker_retry` 留痕），不算熔断。

### A4. 后端与 tier（执行/审查各用什么引擎与模型）

- **后端**：`--backend mock|claude-headless|zcode-headless`。缺省沿用上次会话；mock 只测闭环本身。zcode-headless 设 `ORCH_ZCODE_CLI=<zcode.cjs 绝对路径>`；headless 无 `--max-turns`（轮次熔断不可用，wall-clock/token 熔断直接杀进程树），prompt 走 argv 超 30000 字符快速失败。**引擎切换人工闸门**：最终引擎 ≠ workflow.json `worker.backend` 即拒绝启动（resume 沿用也不豁免），须 `--approve-backend-switch` 或 `ORCH_APPROVE_BACKEND_SWITCH=1`——切换引擎=切换计费方，必须过人（2026-10-29 夜跑静默换引擎烧穿账单的事故防线）。
- **异构审查**：执行与审查是两个独立会话。审查引擎解析顺序：`--review-backend` 显式 > workflow.json `review.backend` > 上次 `review_spawned` 事件（retry/resume 不换审查引擎）> **自动异构**（自动选另一个可用的真实引擎，如 claude 干活 / zcode 审查；mock 永不异构）> 回落同源（记 `review_backend_fallback`）。**去相关的关键是引擎异源——只拆会话不换引擎仍有共同盲区**。
- **tier 按难度选服务**：① ModelDock 侧按等级建 profile + 钉定路由的 harness（如 `orch-heavy`/`orch-light`，`modeldock test orch-heavy` 验证连通）；② workflow.json `"tiers": { "heavy": { "tokenEnv": "MDK_TIER_HEAVY_TOKEN", "workerModel": "…", "provider": "服务ID", "gatewayBase": "http://127.0.0.1:8687" } }`（token 走环境变量，不入库）；③ 任务卡写 `tier: heavy`。模型优先级：CLI > tier > 全局默认。zcode-headless 不支持 tier（不认 ANTHROPIC_* 环境变量，模型跟随 ZCode 自身配置）。显式 tier 未配置 → 告警回落，不阻断。
- **长跑加固速记**（详设见 design doc v1.2）：预算按引擎校准 `budgetProfiles.<backend>`（本仓库 zcode `max_tokens: 5000000`，调大不关闭，wall-clock 才是真熔断）；drain 起跑前引擎预检（CLI 不可用拒绝启动，不再逐卡烧成 blocked）；落位即发 webhook（`${envPrefix}_ORCH_WEBHOOK`）+ macOS 通知；worker prompt 带结束纪律（done 前自验、同一条命令被权限拒满 2 次即 stuck、禁 `git -C` 与 `;`/`&&` 复合命令）。

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

### B3. propose（planner 需求综合）

`propose`：goals.md + drafts 巡检信号 + 队列现状 → 一次只读 planner 会话产出至多 `maxProposalsPerCycle` 张高质量提案（验收标准带具体行为断言、files_hint 精确、目标对齐），落 drafts/；白名单卡立即自动提交。深化既有提案用**同 id**（落盘覆盖=升级）。烧钱动作；`nightly --plan` 与 watch（autopilot 开时）内部调用同一命令。

### B4. 夜航巡港（nightly）与 schedule（每日波次）

`nightly` = scan 出提案 + autopilot 白名单提交 + drift 报告 + 队列摘要（默认零烧钱；`--plan` 加跑 planner；`--auto N` 夜间对 high 提案提交并发起闭环再 drain N 个——worker 烧钱仅此档，gate=L3 兜底合并仍人工）。`schedule install --hour 2 --minute 30 [--auto 3] [--mode watch]` 注册定时（launchd/crontab/schtasks 经 wrapper 绝对路径启动，不依赖调度环境 PATH；仓库挪位置后重装）。日志 `logs/nightly.log`（超 5MB 轮转）。跑完发通知：macOS 本地通知 + `${envPrefix}_NIGHTLY_WEBHOOK`（如 `AGENTS_NIGHTLY_WEBHOOK`，旧名 MODELRDOCK_* 兼容）POST `{title, body, ts}`；通知尽力而为，摘要始终在日志。

### B5. 瞭望模式（watch，连续自治）

`watch --interval 30`：每周期 drain pending → 队列空时 scan 出提案 →（autopilot 开时）propose → 休眠循环。

- 停止：`touch .agents/orchestrator/.watch-stop`（下周期即停并清文件）或 Ctrl-C；**drift 降级自动退出**（保险丝不允许自己插回去，人工 `drift --clear` 后重启）。
- 每周期重读 workflow.json——改 autopilot 配置下周期即生效，无需重启。`--interval 0 --max-cycles N` 为测试档（不休眠）。
- **投机重探**：每周期检查 blocked 卡——worker 异常结束 + 瞬时故障签名且从未重探过的，一次性有痕 resume（`speculative_resume` 事件）；熔断卡与 worker 自报 stuck 永不重探（「永不静默重试」红线不变）。
- 与 drain/nightly 共用调度器锁：watch 在跑时手动 drain 提示退出而非并发。

## C. 观测与对账详解

### C1. stats 与 follow（引水传令）

- `stats --days 7 [--json]`：每卡 wall/turns/调试与审查迭代/重试/watchdog suspect/follow-up/token 峰值（budget_snapshot 口径）+ 各状态卡数与合并率汇总。JSON 形态：顶层 `summary` 嵌套对象 + `rows`。跨引擎精确对账用 reconcile。
- `follow <task-id> "<补充指令>"`：给 running/ 的卡递话，写 `logs/<id>/inbox.md` + `follow_up` 事件，在下一次会话边界（调试返工/审查返工/resume/新 spawn）注入 prompt 尾部（20 条/4000 字符截断，前缀缓存友好）。只对 running 卡开放；awaiting-human 用 `retry --note`，pending 直接改卡文件。`status <task-id>` 会显示待送达条数。

### C2. drift（质量漂移保险丝）

自动合并回溯失败率超阈值（`driftThreshold` 缺省 0.2，**可调不可关**）→ 降级全人工（`run` 的自动合并全部回闸门，事件 reason=drift_degraded，fastlane 同步失效）。`drift` 看报告；根因消除后 `drift --clear` 人工恢复。

### C3. reconcile（狗粮对账）

`reconcile [task-id]`：① 用量对账——自报账（events budget_snapshot）vs 网关实测账（转发日志 usage），分歧率 = |自报−实测|/max，网关零流量标 ⚠（worker 绕过了狗粮）；启用条件 = workflow.json `gatewayLogDir` 已配置。② 状态对账——git merge 现实 vs 队列落位：「已合并未落位」`--fix-states` 修复、「账面合并但 git 无实证」警告（squash/改史）。纯只读（除 --fix-states）。

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

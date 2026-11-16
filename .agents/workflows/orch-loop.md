# 核心闭环 runbook（任务卡 → 泊位 → 门禁 → 审查 → 合并）

> 何时读：写任务卡（验收标准怎么写才可机检）、查泊位状态机、处理紧急抛锚（熔断）与看门狗、配后端 / tier / 模型分层、调权限红线、开 fastlane / ui_check、排互斥与并行——核心闭环（worker → 门禁 → 审查 → 合并闸门）每个环节的机制细节都在本篇。命令速查见 [orchestrator.md](orchestrator.md)。

## 任务卡怎么写（验收标准可机器检查是灵魂）

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
fastlane: true                   # 可选：跳过 LLM 审查省最大开销（只省审查不省闸门，见『fastlane 与 ui_check』）
tier: ahead-3                    # 可选：车钟档位 前进1-4（接口键 ahead-1..4，旧 heavy/light 兼容；见『后端与 tier』）；缺省命中核心路径自动升 前进4
ui_check: true                   # 可选：改 Web 控制台任务开启 UI 冒烟门禁（见『fastlane 与 ui_check』）
research: websearch-fallback     # 可选（feature 提案必填）：调研 brief id 或 todo（上游管线，见 orch-autonomy.md『上游管线』）
score:                           # 可选：量化评分四因子 1-3 档（纯规则定序用，见 orch-autonomy.md『propose』）
  value: 2
  effort: 1
  confidence: 2
  risk: 1
evidence:                        # 可选：证据清单，一句话一条（与 score 配套）
  - 巡检信号：docs/ops/known-issues.md 未修条目
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
第一行逐字粘贴用户原始需求（不转述、不扩写）——worker 理解回执与验船师保真度审查都以它为基准；
随后是现象、复现步骤、相关文件。主体是产品/领域专名（非常识实体）时附查证结论与来源，
查不到就明写「主体待查证」——不许让施工船猜。
```

**门禁按实际改动面分级**：全部改动为 `.md`（纯文档卡，实际分级 L0）时，npm_test 门禁自动改跑 workflow.json `testCmdL0` 轻量命令（本仓库 = docs-lint 测试），tsc_build 跳过——不烧全量回归；含代码改动照旧全量（gate_result 事件带 `scoped: l0` 标记可审计）。**验收标准是灵魂**：作业船（worker）拿它当航海目的地、审查者（验船师）当评判基准、人（船东）当验收清单。写"做得好用一点"等于没写。**自报不可信**——orchestrator 亲自跑 testCmd 与 build 复核（token（可计费口径，剔除缓存读）、失败尾部 200 行都有据可查）。航次计划段（SOLAS V.34 计划先行）要求 3-6 个检查点、每个一句话「做什么 + 怎么验证」、末尾一行备选路线；planner / propose 产卡会自动补写该段。

**提交口 L0 校验（2026-11-15）**：`submit` / autopilot 自动提交时确定性检查验收标准——至少一条须含可机检锚点（验证命令 / 测试文件路径 / 行为断言词），空洞标准拒绝提交并附修复示例（scanner 卡豁免，巡检卡的验证闭环是复扫）。**复诵与逐条对账（同日）**：worker 开工按纪律第 0 条把目标/验收/红线/计划复诵进 NOTES.md；编排器确定性预检（复诵关键词 / 目标文本重叠双探针）并把 NOTES 复诵段与预检事实注入验船师 prompt，复诵与实际改动矛盾计阻塞项。worker 契约块新增 `acceptance: m/n` 申报行，自报缺口（m < 卡内条数）不等门禁直接送返工（`acceptance_gap`），反复缺口计入调试子循环熔断；验船师按验收标准**逐条 pass/fail 裁决**（fail 计阻塞项），审查输出缺 REVIEW_SUMMARY 汇总行时先补问一次、仍缺才按 blockers=1 保守判罚（不再白烧返工轮）。
**主体保真度三道防线（2026-11-14 醍醐事故）**：把「醍醐（鹈鹕，大嘴鸟）」写成占位吉祥物，施工船照卡硬干、验船师照卡硬审，两层全绿却交付了错误主体——「精致地做错东西」比做坏更浪费。堵法三层，缺一不可：① 需求原文逐字进卡背景段（人写卡与 planner/propose/spec 产卡同一要求）；② 施工船「任务理解回执」（结束纪律 0.5 条：主体×动作×载体×验收外观四要素分解，主体非常识实体必须先查证，查证失败报 stuck 要信息而非猜占位物）；③ 验船师维度 0 需求保真度审查（对照背景节逐项核对，主体不符直接阻塞，不因实现质量高放行）。**残留盘点补强（2026-11-15 鹈鹕辫子事故）**：换主体改造把「可保留」的旧元素（围巾链）原样带进新主体，渲染成了鸟身上的辫子——0.5 条回执增补两道闸：先调研后动工（卡面资料只是起点，施工船须独立检索核验主体典型特征，含「哪些明显不属于它」）；改造类任务强制残留三分类盘点（主体固有保留或修正 / 无冲突活动配件可留 / 旧主体遗留人类特征清除），「卡面说可保留」不豁免主体一致性审查。**关联内容全量过滤（2026-11-15 兔子事故）**：鹈鹕换兔只改了形体，标题仍叫「醍醐骑行记」、aria 仍是旧名、形体还留着旧身体的连接结构（脖子）——0.5 条回执增补：换主体时与主体相关的内容全量过滤（形体/标题/文案/aria/气泡/示例/注释），grep 旧主体名归零是完成条件；验船师维度 0 增补：审查范围 = 与主体关联的全部内容而非 diff 触碰面，主体名或用户可见文案漏改计阻塞、纯注释漏改计建议。**可测量验收（2026-11-15 阿奇耳朵事故，通用收敛闸）**：换装成阿奇后「耳朵」走了清单（耳在残留盘点里、也改了形状），但仍按兔耳比例缩放——管状长条读作兔耳。根因：前四轮约束全是「检查什么」（召回），「判定做对了没有」始终靠同一模型的自我感知——自检与错误同源。收敛闸：造型/视觉类任务的查证产物必须是**可测量指标与参照物**（比例/尺寸/色值/官方形象图），「像/美观」不是验收标准；实现后逐指标自查、可渲染的必须渲染对照；验船师对照指标审查、可渲染的必须实际渲染（截图/elementsFromPoint）不只核代码。原则：文字约束召回错误类别，机器闸门判定对错——能用 grep/测量/图像对照关掉的，不靠加规则。**机器自检清单（2026-11-15 实施落地）**：`.agents/scripts/ship-selfcheck.mjs <checklist.json>` 把上述检查动作变成可执行工件——清单随卡下发（grepZero 禁词归零 / countAtLeast·countEqual 结构计数 / tagBalance 标签配对 / jsSyntax / cssBraces / fileSizeMaxKB / noExternalRefs 七类），施工船交付前必须跑、输出全绿原文贴报告；验船师独立重跑同一清单复核（机器结果优先于转述）。0.5 条同步瘦身：prose 只留意图层（理解/调研/盘点/过滤的原则），检查细节外置脚本——prompt 长度不再随事故线性膨胀（多指令堆叠遵守率衰减：arXiv 2309.11247）。

`run` 在 TTY 下会在人工闸门处交互（a 批准 / v 看 diff / r 驳回 / b 打回 / q 搁置）；非 TTY 打印提示后退出，用 approve/reject/retry 异步处理。

## 泊位状态机（哪里找我的任务）

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
- pending（待泊）的卡若属受限航道（`type: deps` 或 files_hint 命中核心/发布路径），开航前需人工引水确认：`run <id> --pilot-approved`（见 orch-autonomy.md『引水闸』）；未确认的卡在 drain 中被跳过并列入「待引水」清单，队列保留不动。

## 紧急抛锚（熔断）与看门狗（自动停，不会烧钱）

| 触发 | 行为 |
|---|---|
| 轮次 / token / wall-clock 超预算 | kill 进程树 → blocked |
| 测试修复超 `max_test_iterations` / 审查返工超 `max_review_iterations` | blocked（附失败尾部） |
| worker 契约块自报验收缺口（`acceptance: m/n` 且 m < 卡内条数）反复未收敛 | 不等门禁直接返工（`acceptance_gap`，与测试修复共用 `max_test_iterations` 计数），超限 blocked |
| 看门狗（`watchdog.mode: actuate`）连续 2 次判定无实质进展 | kill → blocked |
| 燃油 80%（token/wall） | 软告警 `budget_low_fuel` + 引水传令自动注入收尾令（不熔断） |

全部记 `circuit_breaker` 事件，**永不静默重试**。看门狗缺省 observe 档：每 20 个 worker turn（`watchdog.everyTurns`）由一次性只读 LLM 判断是否空转，疑似只记 `watchdog_suspect`；actuate 是显式配置。每任务最多查 5 次，自身故障记 `watchdog_error`（≤3 条后静默）。瞬时故障（429/网络签名）原地退避重试 60s×attempt ≤3 次（`worker_retry` 留痕），不算熔断。

## 后端与 tier（执行/审查各用什么引擎与模型）

- **后端**：`--backend mock|claude-headless|zcode-headless|codex-headless`。缺省沿用上次会话；mock 只测闭环本身。**本仓库默认 `worker.backend: claude-headless`（2026-11-03 船东定：全档位换 claude-code CLI——zcode 免费船可靠性不足；模型仍 glm-5.3-flash 经网关）**——claude CLI 经 `~/.claude/settings.json` 指向本机 ModelDock 网关（127.0.0.1:8687）供油（`modeldock test claude-code` 验连通）。zcode-headless 仍可用（`--worker-backend zcode-headless` 显式点名须批准；ORCH_ZCODE_CLI 指向 zcode.cjs；prompt 走 argv 超 30000 字符快速失败；headless 无 `--max-turns`，wall-clock/token 熔断直接杀进程树），修复 TUI `/model` 后可点回。codex-headless（2026-11-09 新增，codex-catalog-ship 卡）：`--worker-backend codex-headless` 点名；ORCH_CODEX_CLI 指向 codex 绝对路径（spawn 与探测同源，.cjs/.mjs 桩用 node 直跑）；prompt 走 stdin 无长度上限；无 `--max-turns` 旗标（token 熔断兜底）；**红线走沙箱物理层**——worker=workspace-write（codex 沙箱默认禁网，git push/npm publish 物理不可达），reviewer/researcher=read-only（fail-closed）。前置条件：codex 只讲 Responses 协议，`~/.codex/config.toml` 须经 ModelDock 接入（model_catalog_json 目录由 attach 自动生成，`/model` 选择器可见网关模型）；上游须支持 Responses 端点且对独立 web_search 工具容忍（小米上游需 `web_search="disabled"`，attach 已缺省写入）。codex 侧多路由：attach 为每条 ModelDock 路由写 `[profiles.<id>]`，`codex -p <id>` 免控制台切换（codex-rebake-profiles 卡，2026-11-11）；路由/服务切换（含云端远程切换回调）已内聚重烤烤模型客户端——烤入失联（gpt-6-astra 事故型）由漏斗收敛。claude 侧对等的 `ORCH_CLAUDE_CLI` 仅覆盖可用性探测/诊断定位（.cjs/.mjs/.js 用 node 直跑；worker 拉起仍走 PATH claude，不随它改道）。**引擎切换人工闸门**：最终引擎 ≠ workflow.json `worker.backend` 即拒绝启动（resume 沿用也不豁免），须 `--approve-backend-switch` 或 `ORCH_APPROVE_BACKEND_SWITCH=1`——切换引擎=切换计费方，必须过人（2026-10-29 夜跑静默换引擎烧穿账单的事故防线）。
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
- **模型分层（便宜勘察/强施工/审查异模型，2026-11-10 落地；模型值全部集中 workflow.json 一处可调）**：按角色分脑子，不再全链一刀切——
  - **施工分档**：`tiers.ahead-4.workerModel` 给旗舰档配旗舰模型（本仓库 `glm-5.3`——核心/发布路径的重活值得旗舰推理能力）；`ahead-1..3` 不配即回落 `worker.model`（`glm-5.3-flash`，轻活够用最省）。生效优先级 `--worker-model` CLI > tier.workerModel > 动态选船按船注入 > 全局默认（链路既有，配值即生效；model 仅 claude 系生效）。
  - **勘察类小模型**（只判断不施工的一次性短调用，省执行档位配额与容量）：`scan.smartModel`（信号语义过滤，本仓库 `glm-4.5-air`）、`watchdog.model`（进展判定，本仓库 `glm-4.5-air`；缺省跟随执行模型）、`propose.model`（planner 需求综合与 intent 意图编译共用，会话留痕 meta.model）。两类例外钉回 `glm-5.3-flash`：planner 是 25 轮仓库探索的检索重会话、research 同理——**glm-4.5-air 检索接地失效（2026-11-08 实证），禁用于一切检索型会话**。scan 模型解析：`scan.smartModel` > `review.model` > 引擎默认。
  - **审查异模型**：`review.model` 本仓库 `glm-5.3-flashx`（与执行 `glm-5.3-flash` 同 provider 异模型）——引擎异源之外补齐模型异源，双去相关才是完整互审。
- **长跑加固速记**（详设见 design doc v1.2）：预算按引擎校准 `budgetProfiles.<backend>`（**max_tokens 语义 = 可计费口径**，2026-11 usage-cache-read-scope：GLM 网关缓存读占大头、总口径预算虚胖，熔断与 reconcile 分歧率已改按「剔除缓存读的 billable」比较，budgetProfiles 数值可按真实消耗回调——调大不关闭，wall-clock 兜底不变；旧事件/旧网关日志缺新字段自动回落旧口径并标注）。**本仓 wall 校准（2026-11-10）：budgetProfiles 两引擎补 `max_wall_minutes: 150`**——依据 30 天 stats merged 卡平均 wall 92 分钟，缺省 60 分钟是事实上的主熔断（zcode 无逐 turn 自报、token 预算形同虚设后 wall 是唯一真闸），且 wall 熔断不参与 autoresume（确定性失败不自动续）：60 分钟常把长任务在正常施工中途拦腰砍断、落 blocked 等人工。150 ≈ 平均值 +60% 余量，仍兜得住失控任务（配合 budget_low_fuel 80% 软告警收尾令）；gatewayProvision 的凭据 TTL 随之按卡 wall 收敛（见 orch-supply.md『每任务一次性凭据』）。drain 起跑前引擎预检（CLI 不可用拒绝启动，不再逐卡烧成 blocked）；成功出港（merged ✅）与落位（awaiting-human/blocked/failed）均发 webhook（`${envPrefix}_ORCH_WEBHOOK`）+ macOS 通知；worker prompt 带结束纪律（done 前自验、同一条命令被权限拒满 2 次即 stuck、禁 `git -C` 与 `;`/`&&` 复合命令）。
- **Windows 权限墙已根修**：claude CLI 在 Windows 的 shell 工具是 **PowerShell**——白名单/红线一律 Bash+PowerShell 双形态双发，worker settings hook matcher 为 `Bash|PowerShell`。zcode 侧 yolo 在 CLI 0.17.0 已恢复全自动（沙箱实验实证）。
- **开航前海况观测（fleet observe，纯观测零决策，2026-11-03 船东定案阶段 1）**：每次派发（run 闭环入口）先拉网关 admin 面（`/_modeldock/config` + `/_modeldock/metrics`，`gatewayAdmin: true` 才启用），把「服务清单/熔断状态/各客户端指向」压缩成 `fleet_observed` 事件落任务时间线。告警三类（只照亮不拦截）：**dogfood_bypass**（本船对应客户端指向 ModelDock 之外的端点——船将直连上游，燃油实测与 reconcile 对账失效）、**not_attached**（客户端未经 ModelDock 接管）、**meltdown_active**（有服务在熔断）。船↔harness 映射：zcode-headless↔zcode、claude-headless↔claude-code。未开 gatewayAdmin 完全静默（行为不变）；开了但网关不可得 → 一行提示继续派发。选船仍走既有静态规则，引擎切换人工闸门不变。
- **prompt 纪律**（对齐 Anthropic 长时程 harness）：done 前自验测试、干净提交、不越界；**同一条命令被权限拒绝满 2 次即 stuck 熔断**；环境层禁 `git -C` 形态与 `;`/`&&` 复合命令。spec 卡 design/requirements 用 **worktree 文件引用**（防 zcode headless 30k argv 上限），prepare 时由 orchestrator 拷贝进 worktree。reviewer prompt 注入 REVIEW.md 纪律摘要（截 8000 字符）。files_hint 解析自动剥反引号/引号。
- **Budget 会话级记账**：committed+sessionMax（跨 fixup 会话不再互相覆盖漏计），每次 worker_spawned 落 `budget_baseline` 事件（含 `tokens_billable`）。max_tokens 熔断与低油量告警按**可计费口径**（billable = tokens_in − 缓存读 + tokens_out；budget_snapshot 另发 `tokens_billable`/`tokens_cache_read`，旧口径字段保留）。
- **LLM 决策留底（decision trace）**：看门狗（watchdog）/ scan 语义过滤（smartfilter）/ 独立审查（review）/ planner 规划会话（propose/intent，落 `logs/planner-<时间戳>/`，成功与重试失败都留）四类 LLM 决策点把**模型输入与原始输出全文**落盘 `.agents/orchestrator/logs/<任务id>/decisions/<类型>-*.json` 供复盘（planner 重试失败日志同时附 exitCode 与 stderrTail 尾部 ≤200 字符）；超 64KB 截前缀、每类型滚动保留 20 份；workflow.json 可选键 `"trace": { "enabled": true, "maxPerTask": 20, "maxInputKB": 64 }`（缺省开启）。看门狗熔断卡不参与 blocked 卡自动续（防「误杀→续跑→再误杀」循环）。

## 权限红线（worker 被什么拦了）

worker 会话注入专属 policy hook：git push/tag、npm publish、受保护端口（workflow.json `protectedPorts`）一律拒。**发布动作是硬编码红线，任务卡写了也没用**。zcode worker 的红线必须在**用户级** `~/.zcode/cli/config.json` 注册（项目级注册 headless 下被平台禁用，实证过）；推荐机器级 dispatcher 一次注册全项目生效：`cp .agents/hooks/policy-dispatch.mjs ~/.agents/hooks/` 后用户级 hook 指向它。**用 zcode-headless 跑自治任务前先完成这一步，否则红线无人把守。**

## fastlane 与 ui_check（提速与 UI 冒烟）

- **fastlane**（任务卡 `fastlane: true`）：跳过 LLM 审查子循环（不 spawn reviewer、不进 reviewing），`review_verdict` 记 skipped。**只省审查、不降任何闸门**：自动合并四前提（无 drift 降级 + 声明与实际分级均 L0/L1 + 实际≤声明 + scope 无越界）原样生效。失效规则（记 `fastlane_skipped` 附 reason，失效后本次 run 不复活）：实际分级 L2/L3 → 回常规链路（核心路径恰恰最需要审查）；drift 降级期 → 回常规链路；卡 gate=L3 → 跑前即失效；workflow.json `fastlaneAllowed: false` 团队总开关。适合纯 docs/test 小卡。
- **ui_check**（`ui_check: true`）：改 Web 控制台/网关页面的卡在 build 后跑 `workflow.json uiCheckCmd`（本仓库 `node scripts/ui-smoke.mjs`，自备 189xx 沙箱）；失败进调试子循环（非红线）；声明了但仓库未配置 → 快速失败卡留 pending。

## 互斥与并行（谁在跑、能并行吗）

- **调度器锁**：drain / nightly / scan --run / watch 共用一把（`.scheduler-lock.json`），后来者提示退出；持锁进程死 = 陈锁自动接管。手动 `run <id>` 不抢调度器锁。
- **任务锁**：每卡 `.run-<task-id>.lock`——同一泊位（worktree）不允许两个进程同时驱动（两个 worker 会写同一个 worktree）；人工 agent 经 feature-branch start 认领同一把锁（claim-before-execute，见 orch-ecosystem.md『与 feature-branch 的关系』）。
- **并行 drain**：`drain --workers 3` 最多 3 卡同跑，按 files_hint 分区互斥（`docs/**` 与 `test/**` 可并行；裸 `**` = 独占）。想让任务可并行，把 files_hint 收窄到独立目录。`gatewayAdmin: true` 的仓库并发还受 **供给闸**（见 orch-supply.md『worker 并发供给闸』）约束：有效并发 = min(请求并发, provider 容量)——上游没解锁 `max_concurrency>=2` 时请求多档也只跑单 worker（fail-safe，防 429 烧上游）。

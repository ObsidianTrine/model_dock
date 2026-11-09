---
name: dockmaster
description: Dockmaster（坞长）调度台——用户输入 /dockmaster，或用自然语言指名派活（「让 dockmaster/坞长做 X」「派个任务给 dockmaster」「用前进2跑…」「开船：修一下 X」）时使用；用户说「自由航行」「自己给自己找活干/自己安排任务跑一段时间」「让它自主干一小时完了报告」时也路由到此（sail 模式）；说「调研一下 X」「先查查 X 再做」路由到 research；说「验证全链路」「跑个冒烟」路由到全链路冒烟配方（mock 沙箱零真钱）。驱动 .agents/scripts/orchestrator.mjs 自治闭环：拆任务卡、后台跑 headless worker、自动门禁与审查、合并到本地 develop（不 push 远程）。支持对话指定档位（前进1-4）、引擎（harness）与服务商/模型。路由路径：research 上游调研（带引用 brief）、spec 三件套设计（先设计后施工，--from-brief 接调研结论）、nightly/schedule 定时巡检与提案审阅、watch 连续自治运行、sail 自由航行（时间盒完全自治：自勘察自规划自执行，feature 提案自动跑到 spec 待人审为止，到点交航海报告）、propose 需求综合（autopilot）、release-propose 发版提案。仅当用户指名 Dockmaster 或明确要派自治任务时加载；只是提及 dockmaster 而非派活时先问一句，不要抢跑。
---

# dockmaster —— Dockmaster 港务调度台

> **Dockmaster（坞长）** = 本仓库 `.agents/` 自治编排体系的名字；命令行仍是 `orchestrator.mjs`。对每艘出航的船它是船长，对整支船队它是坞长——harness 是船、大模型是发动机、船东（用户）递托运单等出港（完整灵魂叙事见 `.agents/workflows/orchestrator.md` 开头「Dockmaster 是什么」）。速查与分区详解见同文（A 核心闭环 / B 自主模式 / C 观测对账 / D 周边）。
> 本技能原名 /orchestrate，2026-11 随体系定名 Dockmaster 改为 /dockmaster（命名缘由见 .agents/workflows/orchestrator.md 开头）。

**一句话派活**：「帮我优化 README，前进1」「让 dockmaster 修 XPLAT-09，前进3」「开船：审查用 zcode」。你的职责：把这句话翻译成托运单（任务卡）、按档位派船、盯闸门、汇报结果——**自动做完所有决策，最多问一个问题**，其余在汇报里说明「选了什么、为什么、怎么说一声就改」。改码的是 headless worker，不是你；你不直接 Edit/Write 仓库源代码。完整手册在 `.agents/workflows/orchestrator.md`，本技能只留调度台最小操作。

## 第 1 步：一句话翻译（任务 + 档位 + 船 + 卡）

**档位 = 船 + 油，一张表定死**（用户说「前进N」按此绑定；中文数字「前进四」与口语「慢车/全速/旗舰」同义）：

| 档位 | 船（--worker-backend） | 油 | 适用 |
|---|---|---|---|
| 前进1 | claude-headless（ModelDock 网关供油） | 计费 | 纯文档/测试小改 |
| 前进2 | claude-headless（ModelDock 网关供油） | 计费 | 常规轻活 |
| 前进3 | claude-headless + tier ahead-3 | 计费 | 常规重活 |
| 前进4 | claude-headless + tier ahead-4 | 计费 | 核心/发布路径、复杂特性 |

> 2026-11-03 船东定：全部档位换 claude-code CLI（zcode 免费船可靠性不足，`workflow.json worker.backend: claude-headless`）；zcode-headless 仍可用（`--worker-backend zcode-headless` 显式点名，需修好 TUI `/model`），也是恢复异构互审的途径。codex-headless（2026-11-09 起）第三艘真实船：`--worker-backend codex-headless` 点名（须 ModelDock 接入的 codex，worker 沙箱默认禁网=push 物理不可达）；自动异构审查候选环 claude→zcode→codex。

- **没说档位就自动选**：文档/测试→前进1，代码小改→前进3，核心路径/复杂→前进4；**卡里写明所选档位，汇报第一句告知**，用户说「换前进N」即重派。
- 船 ≠ workflow.json 默认（claude-headless）时附 `--approve-backend-switch`——**用户口头指定档位/引擎即人工批准**，汇报注明「引擎切换已获你本次口头批准」（自动跑中永远禁止自行切换，红线见下）。全档位同船后，只有显式点名其他引擎（如 zcode）才带批准标志。
- **自动升档不请示**：zcode 船 prompt 超限（AGENTS.md 等固定开销随仓库增长，>30k）且配置了 `escalation.enabled` 时，自动切 fallback 船完成本单（`engine_escalated` 留痕，预算延续），汇报时说明「已自动升档」即可；只有高成本选项（旗舰档/加大预算）才停下来问用户。claude 船 prompt 走文件无 argv 上限，该升档链仅对显式点名的 zcode 船生效。
- 用户另指定模型/服务商：`--worker-model <模型名>`（ModelDock 网关按模型名路由服务商）；「审查用 zcode / 某模型」→ `--review-backend zcode-headless` / `--review-model <m>`（异构互审防共因盲区——全 claude 编队下互审同源，zcode 修复后可点回）。档位与显式模型可叠加，显式优先。
- 适用判定（不合适就拒绝并说理由）：验收标准写得出**可机器检查的断言**才收单；feature 级/探索性/架构级改动 → 走**上游管线**：research 调研 → spec 三件套 → 用户审设计 → spec build 拆卡 → 照常闭环（见文末「其他路径」前两条）。**同一个 task-id 不得与手动 feature-branch 混用**（worktree 会撞）。

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

**里程碑播报（调度台职责）**：后台跑期间，在三个节点主动向用户汇报（不必等用户问）——① worker 完成、进入门禁/审查；② 审查结论出来（阻塞/建议数）；③ 落位（merged / awaiting-human / blocked）。实现=节点处读一次 `status <task-id>` 摘要转述；让「人在窗口」全程有回声，而不是只在进程退出时响一次。

落位处置：
- **merged** → 完成（L1 自动合并进本地 develop）。
- **awaiting-human** → 你亲自看 diff 与审查结论，三选一：`approve`（合并）/ `retry --note`（打回）/ `reject --reason`（废弃）；**拿不准就停下向用户请示**。
- **blocked / failed** → 异常处置速查（文末）。

## 第 4 步：收尾汇报

全部卡落定后逐任务汇报：改了什么（文件与要点）、测试与门禁结果、审查结论（阻塞/建议数）、合并 commit、耗时与 token 用量（可 `reconcile <task-id>` 对账）。**最后一行固定提示：已合并到本地 develop，未 push 远程，是否 push 由用户决定。**

## 其他路径（细节见手册对应节，这里只留闸门纪律）

- **上游调研（research）**：**触发**：用户说「调研一下 X」「先查查 X 再做」「X 现在业界怎么做」且未点名具体改码任务。`research "<问题>" [--model <模型名>]` 派只读+联网会话产出带引用的调研 brief（`research/<id>/brief.md`，五段契约）+ `sources/` 引用快照。**调研船模型解耦**：`--model` 显式 > workflow.json `research.model` > claude CLI 全局默认——**不指定就吃全局默认，检索接地可能失效**（2026-11-08 实证 glm-4.5-air 产出旧世界内容；本仓已配 research.model=glm-5.3-flash）。**可信度双防线（2026-11-08 编造引用事故后加）**：① prompt 注入今天日期并要求**每条引用以当日访问日期开头**——gate 强校验：未来日期/超 7 天陈旧日期/裸 URL 一律拒收重做；② 来源核查要求：一手来源优先（官方文档/榜单原始页）、关键结论双源交叉、查不到写「未证实」禁止凑数。**转述前你必须人工核内容可信度**——契约与关键词通过 ≠ 内容为真（首跑「引用日期全是 2023」；二次跑「真 URL + 假依据」）：把 brief 结论与你会话内知识/检索对照、查 sources/ 快照对账，明显失真就如实标注并建议重跑。产出后给两条去路：只当调研看（到此为止），或接 `spec "<意图>" --from-brief <id>` 进设计。**可信度机制三层（问题无关，2026-11-08，verdict/2）**：L1 快照回查自动跑（数字/型号名 grep 所引快照 + 深链比 → `verdict.json`，**report-only 亮牌不阻断**）；L2 `research verify <brief-id>` 异构复核（claim 级：每条承重结论**逐字摘录** + 五枚举状态，**contradicted 一票否决**——判出矛盾自动追加联网仲裁轮：≥2 独立带日期来源 upheld 才翻案解除否决，翻不了维持 unsafe，`research.arbitration=false` 可关；2026-11-09 实测「页面发布时间≠事件时间」误报由此消解，详见 `.agents/docs/research-verdict.md` 仲裁轮节；coverage<50% 硬底线不得放行，`fabricated_claims>0` 封顶 needs_review）；**把结果交给其他 agent 决策时，verdict.json + `.agents/docs/research-verdict.md`（消费方契约）一起给——对方只读 `usage` 字段行动**（ok / needs_review / unsafe / undetermined）。L3 `research stats` 按调研船模型聚合核实率（信任=统计量，低核实率模型的调研强制人工核）。`research --selftest` 实测 WebFetch/WebSearch 可用性（烧少量 token，须向用户说明；换网关/换源后先跑）。**多维调研（research multi，2026-11-09）**：用户要求「从 N 个角度/维度调研 X」或单份 brief 覆盖不下时，`research multi "<主题>" --dim "<维度1>" --dim "<维度2>" …`（维度 ≥2，上限 `research.maxDims` 缺省 4）串行逐维派 researcher（维度问题 = `主题——维度`），brief id 强制 `<topic>-d<N>`；单维失败隔离不炸批次，产物多一份复合清单 `research/topics/<topic-id>.json`——**消费方只读 `rollup.internal_decision` 决策**（各 ok 维最差档，任一维 unsafe 一票否决整批；有失败维标 `partial: true`），逐维明细在 dims。复核用 `research verify <topic-id>`（逐维 L2 + rollup 重算）；**未 verify 的 topic 各维是 L1 初判（恒 undetermined），消费前先 verify**。topic 契约见 `.agents/docs/research-verdict.md` topic 节。
- **全链路冒烟（mock 沙箱，零真钱）**：用户要「验证全链路 / 跑个冒烟 / 小测试」时按此配方——**必须在临时克隆里跑**（mock 会写 drafts/briefs/specs/queue，直接在真仓跑会污染真队列）：
  ```bash
  SB="$(mktemp -d)/upstream-smoke" && git clone -q --local "$(git rev-parse --show-toplevel)" "$SB" && cd "$SB"
  # 轻量门禁（沙箱无 node_modules：testCmd/buildCmd 换成秒级空命令；worker/review 船换 mock 免引擎闸门）
  node -e "const fs=require('fs'),f='.agents/workflow.json',j=JSON.parse(fs.readFileSync(f));j.testCmd='node -e \"process.exit(0)\"';j.buildCmd='node -e \"process.exit(0)\"';j.worker={backend:'mock'};j.review={backend:'mock'};fs.writeFileSync(f,JSON.stringify(j,null,2))"
  orch() { node .agents/scripts/orchestrator.mjs "$@"; }   # zsh 不做变量分词，用函数别用 $O
  orch research "mock websearch fallback" --backend mock            # ① 调研 → research/mock-websearch-fallback/brief.md（含引用）
  orch spec "add research notes to readme" --from-brief mock-websearch-fallback --backend mock   # ② 规格 → specs/<spec-id>/ 三件套（brief 已注入）
  orch spec build <spec-id>                                          # ③ 人审设计后拆卡 → pending/<spec-id>-t1,t2
  ORCH_MOCK_FILE=docs/notes.md orch drain --backend mock             # ④ 闭环（mock 改 docs/notes.md 落在 files_hint 内）→ awaiting-human（gate=L3），orch approve <spec-id>-t1 合并
  # 航次型一键验证（可选）：ORCH_MOCK_PLANNER_FEATURE=1 orch sail --duration 12s --interval 1 --backend mock
  #   报告 logs/sail/<ts>/report.md 应含「上游管线：调研 brief … 已产出」「spec … 已落盘待人审」
  ```
  通过判据：① brief 五段齐全且引用 ≥1；② design.md 存在且含调研引用注入；③ 拆卡 id 与 spec 同源；④ drain 后 awaiting-human、approve 后 merged。**真链路验证**（去掉 `--backend mock` 用缺省 claude 船）烧真钱且经网关，必须用户显式授权后才能跑；跑前先 `research --selftest`。
- **先设计后施工（spec）**：特性级改动用 `spec "<意图>" [--from-brief <brief-id>]` 出三件套——**设计必须用户亲自确认后才能 `spec build` 拆卡**（你不能代审）；拆出的卡 gate=L3，用户口头授权自动合并后可改 L1。
- **巡检与提案（nightly / scan）**：`nightly` 零烧钱出提案落 drafts；逐张给用户一句话采纳建议，点头后 `submit`。`--plan` 烧钱跑 planner 需求综合。`autopilot.enabled` 开启后白名单提案自动提交（deps/feature/核心路径/人工草稿永不自动——feature 走上游管线）——开启属持久授权，**代改配置前必须先确认**。
- **连续自治（watch）**：`watch --interval 30` 后台常驻；停止 `touch .agents/orchestrator/.watch-stop`；drift 降级自动退出（向用户说明 `drift --clear` 恢复）；与手动 drain 共用调度器锁，勿并发。
- **自由航行（sail）**——**触发条件**：用户表达「让它自己给自己安排活干一段时间」类意图，典型话术：「自由航行」「自由航行 30 分钟」「自己给自己找活干 / 自己安排任务跑一会儿」「让它自主干一小时，完了给我报告」「开自由航行」。判定要点：① 没点名具体任务（有具体任务走第 1 步写卡派单）；② 强调「自己决定做什么」+「一段时间/到点报告」。**时长从话术里取（「30 分钟」「一小时」→ `--minutes`）；话术未给时长时反问一句「自由航行多久？」（本技能唯一允许的主动提问），禁止默认时长**。启动前向用户复述：时长、自动提交范围（docs/bugfix/refactor；**feature 永不直接提交**——走上游管线 research → spec → 人工审设计 → spec build，sail 只自动跑到「spec 落盘待人审」为止）、引擎档位；用户未指定引擎按缺省（claude-headless 网关船，2026-11-03 起；zcode 修复后可显式点名）。执行：`sail --minutes N`（或 `--duration 2h`，可加 `--max-cost-usd N` 燃油上限——实测价达上限即收帆，报告带燃油账）后台常驻（Bash `run_in_background`）——scan 勘察 → propose 规划 + 上游管线/自动提交 → drain 执行，到点收帆交航海报告（`logs/sail/<ts>/report.md`：完成了什么、为什么这么编排）；停止 `touch .agents/orchestrator/.sail-stop`。航行期间向用户通报中途状态（status/日志），结束后把报告要点完整汇报给用户，**待审的 spec 提醒用户审设计**。
- **发版提案（release-propose）**：只出建议与草稿；**版本号决定权在用户**——用户说「发布 vX.Y.Z」才走 release.md 代理发布（不在本技能，永不 push）。
- **ZCode 原生模式（引擎全断时的降级开航）**：编排器 worker 引擎全部不可用（claude 船被网关路由 pin 死 / zcode CLI 船报「Select a model」）但需要继续派活/开航时——调度台（你）亲自当船长，用 ZCode 会话原生 Agent 工具（子代理，与主会话同引擎）当船，手动走 worktree 闭环。SOP 七步与能力对照表见 `.agents/workflows/zcode-native.md`（派工前先对账 git log 防重复派工；独立验收不盲信船报告；无自动熔断，卡必须小）。引擎恢复后回归自动闭环。

## 红线（永不）

- **禁止 push / tag 远程、禁止 npm publish**——合并终点是本地 develop；worker 被 policy 硬拦，你也不得代执行。
- **8687 / 8890 端口永不触碰**（监听/stop/改配置一律禁止）。
- 不改门禁与熔断逻辑来「让任务通过」；红线门禁（port_scan / native_scan）失败 = 改设计，不可调试。
- 自治跑中引擎故障**禁止自行换引擎**（切换=换计费方，必须用户批准）；测试结束清理你拉起的全部临时进程。

## 异常速查（详表 .agents/docs/orchestrator-usage.md §7）

| 现象 | 处置 |
|---|---|
| `blocked: budget:*` / 迭代超限 | 预算/迭代熔断（永不静默重试）：`resume` 续做或改卡 `submit` 重提 |
| 反复测试失败 | `logs` 看失败尾部：能定位就 `retry --note` 带修复指令，否则报用户 |
| 红线门禁 failed | 不可调试，`abandon <task-id>`，向用户说明设计问题 |
| run 不动 | `status` 看解析失败卡/分区排队；确认 Node ≥18、从仓库根目录运行 |

## 深入文档

- 使用指南（状态机、闸门交互、混合节奏）：`.agents/docs/orchestrator-usage.md`
- 操作手册（任务卡字段细节）：`.agents/workflows/orchestrator.md`
- 引擎不可用时的降级开航（ZCode 原生模式）：`.agents/workflows/zcode-native.md`
- 设计与原理：`.agents/docs/design-orchestrator.md`

# 自主模式 runbook（提案 · autopilot · 上游管线 · 夜航 · 瞭望 · 自由航行）

> 何时读：让体系少人值守时——引水闸、提案（drafts）与 autopilot 授权、巡检与 propose、feature 上游管线（research → spec → 人工审 → build）、nightly / watch / sail 自治循环、弃船演习、开启清单、escalation、push-review、飞书双向批示。命令速查见 [orchestrator.md](orchestrator.md)。

需求侧生命周期：**出提案（drafts/ 待审托运申请）→ 人工批量 submit 或 autopilot（自动舵）白名单自动提交（pending/ 待泊）→ 常规闭环（闸门原样）**。人（船东）只审提案与合并两级。

## blocked 卡自动续跑与孤儿 running 自愈

- **blocked 卡什么时候会自动续跑**：drain（含 nightly `--auto` 拉起的 drain）在选卡前会扫一遍 `blocked/`，对**可安全自动续**的卡有限自动 resume——夜里被 429 限流/网络抖动打 blocked 的卡不再等到早上。资格三条：① 失败属 transient 类——最后一条 blocked/failed 事件的 reason 带 429 限流/网络签名，或事件链有 `worker_retry` 记录（worker 原地重试已发生）且最终落 blocked，或 reason 是「未产出结果块」族（worker 异常结束，2026-11 起纳入——本质是 zcode 崩溃族，与 ERA 同源；现存 `未产出结果块（worker 异常结束）` 与旧写法 `未产出结果块` 都认）；预算/看门狗/调试迭代熔断是确定性失败，不续；② 卡 frontmatter 无 `auto_resumed_at` 或距上次自动续 ≥24h（`autoResume.cooldownHours` 可调）——自动续后再 blocked 不立即重试，等人工或冷却过期；③ 每次 drain 最多 `autoResume.maxPerRun` 张（缺省 2），blocked 最早的先续。每次自动续记 `auto_resume { card, attempts }` 事件（人工 resume 的 `resumed by human` 与之区分）。drift 降级期间整个通道暂停（降级 = 全人工）。全局关闭：workflow.json 写 `"autoResume": { "enabled": false }`（其余键缺省即 true/2/24）。

**孤儿 running 卡自愈（2026-11 长跑自治）**：blocked 通道覆盖不到的形态——sail/drain 单进程被硬杀（kill -9/断电/崩溃）后卡挂在 `running/`，状态「在跑」而实际无进程。drain / watch（每周期）/ nightly 入口与 sail（每派发轮进入前——sail 持调度器锁全程、drain 子进程继承锁豁免，须自扫补位，2026-11-11）在实际获得调度器锁后扫 `running/`，任务锁判活分三类处置：① 锁活（同进程嵌套闭环或并行实例在驱动）→ 跳过；② 孤儿 + transient 族（最后 spawn 后无 settle 的崩溃族 / 上会话 transient 签名 / retry 链，纯函数 `classifyOrphan`）→ 自动 resume，沿用 24h 冷却与 ≤maxPerRun 上界（`auto_resume` 事件带 `source: orphan_running` 区分）；③ 孤儿 + 其余（**熔断卡永不续** / 非 transient）→ 落 `blocked/` 附原因交人工（failTaskToBlocked 同款 failed 事件）。**孤儿判定双条件（2026-11-11）**：beat 静默**且**属主 pid 探活死亡才算孤儿——spawnSync（npm ci / ensureWorktree）会冻结事件循环停更心跳 >60s，beat 静默但 pid 仍活的 run 只落观测（fleet 事件 `orphan_heal_beat_silent` + log）不动卡（防把装依赖中的活 run 误判孤儿自动续 → 双 worker 同 worktree）；pid 缺失/不可探测回退旧口径保守当孤儿（不倒退）。watch/nightly 派生的 drain 子进程跳过（父调度器本周期已扫，避免同周期双跑）；drift 降级 = 全人工整通道暂停（状态归位也等人工）；`autoResume.enabled=false` 完全不扫。

## 引水闸（compulsory pilotage）

受限航道 = `type: deps` 的卡（依赖变更牵一发动全身）或 files_hint 命中 workflow.json `corePaths` / `releasePaths` 的卡（**文件级精确口径**，2026-11-20 起：hint 与清单条目同文件 / 同目录真重叠才算命中——此前 src/ 前缀卡整夜待引水、性能卡 pending 一夜的实证；清单外文件不再误拦，真重叠的保护语义不变）。这类卡**未经人工确认不得自动开航**：

- **直接 `run <id>`**：拒绝启动（卡留 pending/ 不动），记 `pilotage_required` 事件（附命中原因）。
- **怎么确认**：`run <id> --pilot-approved`——人工过目后逐张放行。
- **drain 遇到引水卡**：跳过不派发（不烧预算、不 die），跑完打印「待引水」清单逐张给确认命令；串行与 `--workers` 并发同语义。队列顺序不因跳过改变，确认过的卡随时可显式 run。

## 提案与 autopilot（授权制）

- 提案卡 `proposal: true`、`created_by: scanner|planner`、gate=L3，落 `.agents/orchestrator/drafts/`（不入库）。人工提交：`submit .agents/orchestrator/drafts/<id>.md`（提交后草稿自动清掉）。
- **目标面（罗盘）`.agents/orchestrator/goals.md`**（入库、用户手编、agent 只读）：核心目标（优先级排序）/当前主题/明确不做。propose 产出必须对齐它；缺失/留空 = 无目标面（只基于巡检信号提案）。
- **autopilot 授权配置**（workflow.json，缺省全关 = 行为与历史版本一致）：

  ```json
  "autopilot": { "enabled": true, "autoSubmitTypes": ["docs"], "autoDrainPerCycle": 3, "maxProposalsPerCycle": 3 }
  ```

  - **自动提交 ≠ 自动合并**：白名单提交的卡 gate 覆写 L1，实际自动合并仍由门禁对真实改动分级裁决——drift 降级、scope 越界、实际 L2/L3 照样挡回人工闸门。
  - 永不自动提交（即使 enabled）：`deps` 类型、`feature` 类型（走上游管线，见『上游管线』，2026-11 起）、`created_by: human` 的人工草稿、files_hint 命中 corePaths/releasePaths 的卡。**白名单放大不越过硬禁区**——把 deps/feature 写进 autoSubmitTypes 也照样被拒（与 canSailSubmit 同规则）。
  - 开启即代表持久授权「该类型提案自动进队列」，替代逐卡对话确认。
  - **本仓现状（2026-11-10 开启）**：`enabled: true` + `autoSubmitTypes: ["docs","bugfix","refactor"]`——与 freeSail（见『自由航行』）白名单对齐，watch 常驻自治对常规维护类提案不再卡人工提交（此前 watch 模式连 bugfix 都不自动提交）。

## 巡检（scan 的 6 类信号源）

TODO/FIXME（src/）· npm audit · 测试失败（--tests 慢路径）· GitHub open issues（gh best-effort）· **known-issues 账本**（docs/ops/known-issues.md 未修条目，已修/暂缓自动跳过——人工裁决不被自主提案推翻）· **主干 CI 失败**（gh run list，按 head sha 建 id）。全部内容过 sanitize 消毒（无法携带指令结构进 worker prompt）；id 按内容哈希，信号不变自动去重；gh 类信号仅 GitHub 远端启用、失败警告跳过。
- **信号两级过滤**（程序 Fast Path 永启 + LLM Slow Path 按 `scan.smartFilter: true` 开启，缺省关）：落卡写 frontmatter `signal_hashes`；同源信号**直通在途卡**（「补充信号」小节追加，记 `signal_relayed`，不重复开卡），与 14 天内 merged/failed 卡同信号的**丢弃**（记 `signal_dropped`）；LLM 层对剩余候选**批量一次**调用（≤50 条，成本上界写死），判定 card/drop/merge，失败全部保守回落开卡（宁多勿漏，`scan_semantic` 事件）；每轮落 `scan_filtered` 总账（raw/keep/relayed/dropped/merged_away）。引擎用 review.backend 同款，模型 `scan.smartModel`（缺省回落 review.model）。

## propose（planner 需求综合）

`propose`：goals.md + drafts 巡检信号 + 队列现状 → 一次只读 planner 会话产出至多 `maxProposalsPerCycle` 张高质量提案（验收标准带具体行为断言、files_hint 精确、目标对齐），落 drafts/；白名单卡立即自动提交。深化既有提案用**同 id**（落盘覆盖=升级）。烧钱动作；`nightly --plan` 与 watch（autopilot 开时）内部调用同一命令。

- **feature 提案必带 research 行（2026-11）**：产出契约要求 feature 卡 frontmatter 写 `research: <brief id>`（无既有 brief 写 `todo`）——feature 不直接进队列，走上游管线（见『上游管线』）。
- **量化评分（可选，2026-11）**：frontmatter `score` 四因子 value/effort/confidence/risk 各 1-3 档 + `evidence` 证据数组（一句话一条）。纯规则消费（`orchestrator/score.mjs`，零 LLM）：只用于 drain **同优先级内定序**（带分先于无分、复合分降序），不越权改 gate/分级；证据不足就整体省略（宁缺毋滥）。
- **舰队反馈（可选，workflow.json `"propose": { "feedback": true }`，缺省关 = prompt 与历史逐字节一致）**：开启后 planner prompt 在「队列现状」之后追加**舰队反馈**段——只放数据事实、不写硬指令，让 planner 按数据自行定 priority 取舍：近 7 天 near-miss 四类分布（watchdog suspect / 瞬时重试 / 偏航报警 / 事故调查包）、各 type 卡消化数据（merged 率 / merged 平均 wall / merged 平均 token 峰值）、质量漂移降级状态、goals.md「当前主题」摘录。数据与 `stats` 命令同源同口径（`orchestrator/stats.mjs` 的 `collectStatsSummary`，数据窗口固定近 7 天 = stats `--days` 缺省）；`nightly --plan` / watch / sail 内部走同一 propose 命令自动受益。

## 上游管线（research → spec → 人工审设计 → spec build）

**feature 类提案不直接进队列**（2026-11 Plan A：canSailSubmit / canAutoSubmit 双侧硬拒，白名单配置加回 feature 也不放大授权面），走四步管线——自动化的是「调研与设计稿」，**设计审批权永远在人**：

1. **调研**：`research "<问题>" [--model <模型名>]` 派 researcher 会话（工具面 = Read/Glob/Grep + WebFetch/WebSearch + `mcp__zsearch__web_search`（船东已注册本地 zsearch MCP 搜索包时；未注册多余项无害），无 Bash 无写，fail-closed 同 reviewer；maxTurns 25），产出 `research/<id>/brief.md` 五段契约（结论/选项对比/引用/建议/罗盘对齐）+ `sources/` 引用快照（尽力而为，单条失败不阻断）。**调研船解耦选型（2026-11-08）**：`--model` 显式 > workflow.json `research.model` > claude CLI 全局默认——实证全局默认模型检索接地失效时产出旧世界内容，researcher 必须独立配模型。**无引用即拒收**（引用 ≥ `--min-citations` 缺省 1）——结论必须可溯源，`research list` 查看。**引用日期 gate（2026-11-08 编造引用事故后加）**：prompt 显式注入今天的日期（headless 会话对「当前日期」不可靠），每条引用行必须以当日访问日期开头（`- YYYY-MM-DD <URL> — 来源名：依据`）；gate 强校验：**未来日期或超 7 天陈旧日期视为编造、裸 URL 行不计入**，一律拒收重做；prompt 同时要求一手来源优先、关键结论双源交叉、查不到写「未证实」。契约通过 ≠ 内容为真——转述前仍须人工核内容可信度。`research --selftest` 实测当前后端联网工具可用性（非 Anthropic 网关上 WebSearch 常不可用，此时退化 WebFetch-only、引用不足的 brief 被拒收重试；烧少量 token，换网关/换源后手动跑一次）。
2. **提案关联**：propose 产 feature 卡 frontmatter 写 `research: <brief id | todo>`（queue.mjs 校验：brief id 语法或 `todo`；brief 存在性在消费侧查）。
3. **spec 升级（sail 规划轮自动补齐）**：feature 提案缺 brief 则派调研（每周期上限 `freeSail.researchPerCycle` 缺省 2），brief 到手后 `specFromDraft` 以**提案同 id** 落 spec 三件套（每周期上限 `freeSail.specPerCycle` 缺省 1）；未完成下周期重试（提案同 id 覆盖=升级，不重复烧）。交互场景手动 `spec "<意图>" --from-brief <id>` 等价。
   - **多维调研（research multi，2026-11-09 P1 机制化；P2 起维度并发池）**：单份 brief 覆盖不下时 `research multi "<主题>" --dim "<维度1>" --dim "<维度2>" … [--model m]`——维度 ≥2 才算 multi（单维直接 research），上限 `research.maxDims`（缺省 4，超出报可操作错误）。每维问题 = `主题——维度` 喂同一 researcher 会话（三连败重试自带），走**有界并发池**：同时最多 `research.concurrency` 维在跑（workflow.json 可调，1–4 整数缺省 2，非法值 warn+回落；`dims` 数组按 `--dim` 顺序回填，与完成先后无关），brief id 强制 `<topic-slug>-d<N>`（忽略模型自报 id，并行/连跑的 TOCTOU 竞态从命名空间上消灭；topic-id 撞车自动 -2…-9 派生，落盘瞬间 `writeTopicAuto` 'wx' 排他复检再兜一层同主题并行互覆）；**单维失败隔离**（dims 记 failed + stderr 尾摘要，批次继续；全维失败才 die）。产出复合清单 `research/topics/<topic-id>.json`：`dims[]` 逐维留痕 + `rollup`（各 ok 维最差档聚合：internal_decision 序 unsafe > needs_review > undetermined > ok，任一 unsafe 一票否决整批；有失败维标 `partial: true`）。台账每维一条（附 `topic_id`/`dim`）。复核 `research verify <topic-id>` 逐维 L2（同并发池）后重算 rollup。topic 消费契约见 `.agents/docs/research-verdict.md` topic 节——消费方只读 `rollup.internal_decision` 决策；**spec 注入（P2）**：`spec "<意图>" --from-brief <topic-id>` 自动按维展开（每 ok 维一节 + 失败维缺口行；rollup unsafe 一票否决拒绝注入，undetermined 提示先 verify）。
   - **自动拆维度（sail researchAutoDim，2026-11-10 P3，缺省关）**：workflow.json `"freeSail": { "researchAutoDim": true }` 开启后，sail 规划轮遇到缺调研的 feature 提案不再直接派单 brief researcher，而是先派一次**拆维规划会话**（readonly 轻会话 maxTurns 8，`buildResearchDimsPrompt`：输入提案目标、输出 2–4 个短维度每行一个，`parseDimsPlan` 容忍围栏/序号包裹）；拆出 ≥2 维即跑 `runMultiResearch`（与 `research multi` 同一执行核心：并发池 + 单维失败隔离 + rollup 聚合 + `topics/<topic-id>.json` 落盘），spec 升级按维注入、草稿盖 `research: <topic-id>` + `research_kind: topic`（可选字段，旧提案无此字段）。**开启代价**：一个 multi = N 个 researcher 会话（N ≤ `research.maxDims` 缺省 4）+ 1 次拆维会话，对 `researchPerCycle` 上限仍按 **1 个调研动作**计（cap 语义 = 每周期调研动作数；成本倍乘靠默认关 + 文档治理）。**韧性**：拆维会话失败/解析不足 2 维 → log 一行降级原因后回落单 brief（现行为），不因拆维抖动卡管线；multi 全维失败记 failed 下周期重试（不降级再烧一次单 brief）。**unsafe 成本闸门**：topic rollup 判 unsafe → spec **不升级**，草稿盖 `research_status: unsafe` 留痕，后续周期管线见此留痕即跳过调研与 spec（防自治循环反复烧钱），fleet 事件 `sail_research_unsafe` + 航海报告留痕；作废重跑需人工归档 topic 到 `research-void/` 并清理提案留痕（清留痕后经复查通道下周期自动重进管线）。**单 brief 的 verdict.json 判 unsafe / 任一 claim contradicted 走可信度闸门（P2 交接点③统一口径）**：spec 同样不升级，按事件留痕（`research_verdict_blocked`）本周期跳过，不盖 `research_status` 永久留痕；**复查通道（2026-11-11）**：sail 每周期规划轮把被闸门拦下的提案 id 从事件留痕重建成复查名单重进管线复查 verdict（跨 sail 重启不丢）——verdict 未改判零配额跳过，人工 `research verify` 改判后下周期自动走升 spec（消耗当期配额）。**写实边界：全自动路径的 L1 verdict 恒 `undetermined`（claims 空）不触发本闸门，阻断只在人工 research verify 改判出 unsafe/contradicted 后生效**；单 brief verdict 闸门与 topic rollup 闸门双实现并存（topic 模式走 rollup 一票否决 + `research_status` 留痕，单 brief 模式走本闸门 + 事件留痕），人工 `spec --from-brief` 不受单 brief verdict 闸门约束（只受 topic rollup unsafe 拒注入约束）。`undetermined` → 提示先 `research verify` 后照常升级（spec 落盘本就待人审）。**autoDim 关（缺省）时整条路径行为与开启前逐字节一致**；meta.research 指向 topic-id 的提案（人工写入或上周期 autoDim 产出）无论开关状态都按 topic 模式续接（闸门后按维展开）。
4. **人审 + 拆卡**：spec 落盘即停——**等人审设计**；审完 `spec build <id>` 拆卡进队列（gate=L3），开发→测试→审查照走闭环。**预授权 spec 档（可选，2026-11-10）**：workflow.json `"upstream": { "specAutoBuild": { "enabled": true } }` 开启后，管线（sail 规划轮 / watch 周期 / nightly --plan，驱动方见下方「管线驱动方」）spec 落盘即**自动拆卡**进队列（gate=L1、type=feature），不停盘等人审；手动 `spec build` 保持 gate=L3 不变。安全网不另造判断：拆出的卡 files_hint 命中 corePaths/releasePaths 时引水闸（见『引水闸』）天然拦停派发，实际合并仍由 classifyChange 对真实改动分级（L2/L3 照样回人工闸门）。缺省 false = 行为与历史一致。

**管线驱动方（2026-11 P1-8 从 sail 下沉）**：同一执行核（`sailUpstreamPipeline`）与同一复查通道（`collectUpstreamRechecks`，事件留痕重建上周期被闸门拦下的提案殿后重进）三方共用，配额随调用方传入——sail 规划轮读 `freeSail.researchPerCycle`/`specPerCycle`（缺省 research 2 / spec 1）；**watch 周期**（autopilot 开启时，propose 后对 drafts 中 type=feature 提案跑管线；风暴滞留/配置守卫期跳过）与 **nightly --plan**（propose 后同款，摘要含管线战果行）读 `"upstream": { "autoPipeline": { "enabled": true, "researchPerCycle": 2, "specPerCycle": 1 } }`（enabled 缺省 **false** = watch/nightly 行为与历史一致，配额缺省与 sail 同值但独立计）。硬禁区语义原样兜底：feature 提案照旧永不自动提交（canSailSubmit / canAutoSubmit 双侧硬拒），nightly --auto 与 scan --run 的 hardZoneReason 过滤不受影响。

航海报告「为什么这么编排」如实收录上游管线去向（brief 产出 / spec 落盘待人审 / 失败原因与重试提示）。**可信度判定三层（问题无关，2026-11-08，verdict/2）**：L1 快照回查——调研产出后自动跑（`assessBrief`：从结论提取数字/型号名 grep 所引 `sources/` 快照 + 引用深度比，**report-only 亮牌不阻断**；管线内同步跑）；L2 `research verify <brief-id>`——异构复核（claim 级：每条承重结论**逐字摘录自 brief**（行内 [n] 引用标注豁免——复核员省略 `[17]` 类标注不算改写；非逐字先向复核会话**自动重试一次**（追加逐字摘录契约要求，与无契约块重试共享 MAX_ATTEMPTS=3 上限）；仍败**降级保留**：不再丢弃，claims[] 带 `non_verbatim: true`、status 强制 partial、不进 contradicted 否决，仍计 `fabricated_claims` 红旗封顶 needs_review）+ 五枚举状态 supported/partial/unsupported/contradicted/unverifiable；**contradicted 一票否决 → unsafe**；coverage<50% 硬底线不得放行；L1 数字可核的 claim 自动标注优先于 LLM 意见）；L3 `research stats`——按调研船模型聚合核实率与判级分布（台账 `research/ledger.jsonl`，信任=统计量）。**结果交其他 agent 决策时附消费方契约 `.agents/docs/research-verdict.md`——对方只读 `usage` 字段行动（ok/needs_review/unsafe/undetermined）**；`advisory: true` 不绕过 spec/合并闸门。**快照质量可观测（2026-11-09）**：verdict 带 `snapshots: {total, usable, skeleton}`——骨架页（剥标签可见文本 <400 字，客户端渲染/被拦的典型形态）只标注不改判级（meta 描述仍可佐证排名类结论），数字类结论可核性受限时 reasons 有提示。**快照质量包（2026-11-10，multi-dim 对拍实证 evidence 天花板=快照可得性）**：①覆盖——引用快照缺省上限 8→16（`research.snapshotMax` 可调 1–48，非法 warn+回落），并发小池 4；②重试——瞬时类失败（超时/网络错误/HTTP 5xx·429）每条自动重试 1 次（间隔 ~1.5s），4xx 永久类不重试，重试后仍败才判死（reason 带尝试次数）；③分类——快照文件头为 `url/fetched_at/type/usable/via` 五行元数据：`type: text|pdf`（PDF 只截前 2000 字符留存在性证据）、`usable: ok|skeleton|region_blocked|pdf`（区域封锁页如 OpenAI 文档 "App unavailable in region" 从骨架页里拆出归因）、`via: direct|mirror`——分类只标注（文件头/日志/verdict reasons），**不改判分与阈值**；④镜像回退——`research.snapshotMirror`（缺省 **false**）开启后直连失败（非 404）或分类非 ok 的引用追加一次 r.jina.ai 镜像读取，成功覆盖落盘 `via: mirror`；**隐私取舍：开启 = 把引用 URL 发给第三方 reader 服务，故默认关、显式 opt-in**；⑤补跑——`research snapshot <brief-id> [--mirror] [--max N]` 对既有 brief 重跑快照（覆盖 sources/ 同名文件，幂等，零 LLM token），瞬时断网/区域封锁导致的快照缺口人工补网后 `research verify` 即可对账。**完成事件飞书通知（缩范围：只推不做按钮）**：research/verify 落判定后推一条判级+usage 摘要到 webhook（`research.notify: false` 可关；research 决策不是卡片 approve 能表达的动作，批示回流仍限卡片闸门）。**标题带项目名前缀——飞书自定义关键词过滤按消息文本命中，无关键词整条静默丢弃（HTTP 200 + code 19024，2026-11-09 实测）**；项目改名/机器人换关键词时同步调 `research` 通知的命中词。调研产出质量的回归评测见 orch-observe.md『调研评测集』。

## 夜航巡港（nightly）与 schedule（每日波次）

`nightly` = scan 出提案 + autopilot 白名单提交 + drift 报告 + 队列摘要（默认零烧钱；`--plan` 加跑 planner +（`upstream.autoPipeline.enabled` 开时）feature 提案上游管线（「管线驱动方」见『上游管线』：research → spec，配额 `upstream.autoPipeline`，摘要含管线战果行）；`--auto N` 夜间对 high 提案提交并发起闭环再 drain N 个——worker 烧钱仅此档，gate=L3 兜底合并仍人工，feature 提案照旧被 hardZoneReason 拦下不进自动 run）。`schedule install --hour 2 --minute 30 [--auto 3] [--mode watch]` 注册定时（launchd/crontab/schtasks 经 wrapper 绝对路径启动，不依赖调度环境 PATH；仓库挪位置后重装）。日志 `logs/nightly.log`（超 5MB 轮转）。跑完发通知：macOS 本地通知 + `${envPrefix}_NIGHTLY_WEBHOOK`（如 `AGENTS_NIGHTLY_WEBHOOK`，旧名 MODELRDOCK_* 兼容）POST `{title, body, ts}`；通知尽力而为，摘要始终在日志。
中断恢复与双跑防护：nightly 启动时对账 `logs/nightly-state.json`——上次未正常收尾（崩溃/强制重启）则记 `nightly_recovered` + webhook 通知后照常执行；距上次完成不足 20 小时且非人工触发判为补触发双跑，跳过本次（终端 TTY 自动识别人工，脚本场景加 `--manual`）。webhook URL 直接填**飞书 / 企业微信 / Slack** 群机器人地址（按端点域名自动适配三家消息格式；飞书自定义关键词配 `nightly` 或 `ModelDock` 均可命中）。**飞书签名校验（2026-11 起）**：机器人开启「签名校验」后，出站消息自动附 `timestamp`+`sign`（HMAC-SHA256，官方规范）——签名密钥二选一配置：env `AGENTS_LARK_SIGN_SECRET`，或 darwin 钥匙串（workflow.json `"notify": { "signSecretService": "<服务名>" }`，密钥经 `security find-generic-password` 存取，参照 webhook URL 的钥匙串模式）；**未配置 = 现状不变**（不签名，机器人需关闭签名校验或改用自定义关键词）。wrapper 固化 install 时刻的参数与路径——orchestrator 侧默认值/参数变更后需重跑 `schedule install`。

## 瞭望模式（watch，连续自治）

`watch --interval 30`：每周期 drain pending → 队列空时 scan 出提案 →（autopilot 开时）propose →（`upstream.autoPipeline.enabled` 开时）feature 提案上游管线（「管线驱动方」见『上游管线』：research → spec，配额 `upstream.autoPipeline`；风暴滞留/配置守卫期跳过；specAutoBuild 拆出的卡同周期 drain 推进）→ 休眠循环。

- 停止：`touch .agents/orchestrator/.watch-stop`（下周期即停并清文件）或 Ctrl-C；**drift 降级自动退出**（保险丝不允许自己插回去，人工 `drift --clear` 后重启）。
- 每周期重读 workflow.json——改 autopilot 配置下周期即生效，无需重启（**配置守卫例外**：workflow.json 被外部改写期间派发暂停待人工核实，见 orch-supply.md『配置守卫』）。`--interval 0 --max-cycles N` 为测试档（不休眠）。
- **投机重探**：每周期检查 blocked 卡——worker 异常结束 + 瞬时故障签名且从未重探过的，一次性有痕 resume（`speculative_resume` 事件）；熔断卡与 worker 自报 stuck 永不重探（「永不静默重试」红线不变）。
- **风暴闸（weather hold）**：瞭望位先看天——每次派发前无状态统计最近 `windowMinutes` 分钟（缺省 60）各任务 `worker_retry` 合计，达 `threshold`（缺省 3）即停止派发（drain/nightly --auto/watch 通用）：日志「风暴滞留」+ webhook 通知 + fleet 级事件 `weather_hold`（`logs/fleet.jsonl`，跨任务调度层留痕）。可选**上游海况**子键 `"upstream": {"threshold": 5, "windowMinutes": 60, "source": "metrics"}`：**metrics 数据面**（2026-11-04 起缺省）优先消费网关 `/_modeldock/metrics` 的权威海况——`sea_state.storm` 直通滞留 + 60 分钟窗限流/额度类请求（429+quota）真实计数达阈值同样滞留（网关先于 worker 看到上游限流，触发时点名为「上游风暴」；阈值 ≤5 可保证网关判风暴时计数闸必触发，因网关 60m 风暴规则最低 6 次 429）；admin 不可达/端点失败自动落回**网关日志扫描**（`gatewayLogDir`，须已配置；429/402 计数，fail-open——观测失败绝不阻断派发）。`source: "log"` 显式降级为仅日志扫描（不发起 metrics 探测）。workflow.json 可选键 `"weatherHold": {"enabled": true, "threshold": 3, "windowMinutes": 60, "upstream": {...}}`（`enabled` 缺省 true，显式 false = 关闭），**未配 = 关闭**（行为与历史版本一致）；窗口滑过自动恢复（不落 hold 标记文件），瞬时重试退避基值可经 `ORCH_RETRY_WAIT_MS` 注入（缺省 60s×attempt）。
- 与 drain/nightly 共用调度器锁：watch 在跑时手动 drain 提示退出而非并发。
- **与模型级容灾的交互（有意取舍，2026-11-08）**：上游服务配置了 `model_fallback` 时，额度类上游错误（402 / 429 quota）被网关在同服务内吸收改发，worker 不再看到 402/quota cause——风暴闸对这类风暴的灵敏度随之下降，这是特性本身的目的（吸收而非扩散），不是漏报。编排器零代码改动；需要分辨「额度耗尽但已被吸收」时看网关用量面（`/_modeldock/usage` 的 `tokens_by_model` 按模型分桶，备用模型的桶出现即说明改发已发生）。

## 弃船演习（drill）

引擎预检只能证明 CLI 在场；闭环本身（worktree 创建→门禁→审查→闸门）只有真跑才检验——环境漂移（node 版本、权限墙、脚本残缺）夜里才炸不如演习先炸（SOLAS 救生艇演习条款的 Dockmaster 版）：

```bash
node .agents/scripts/orchestrator.mjs drill   # exit 0 = 港口闭环健康
```

- **临时港**演习：mkdtemp 临时 git 仓 + 整目录拷贝 `.agents/scripts` + 最小 workflow.json，mock 跑一张合成托运单（id `drill-<日期>-<随机>`）走完全链，产物随临时港删除——不烧真钱、不碰真队列。
- 判定：脚本完整 → 合成卡提交 → 闭环全链落 awaiting-human，任一环节 ✗ 即 exit 1（可用 schedule/cron 注册成每周演习）。

## 开启清单（自动舵 autopilot 与风暴闸 weatherHold）

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

## 故障处置升级链（escalation，分级自动化审批）

故障处置按 token 成本分级自动升级，人只出现在高成本档（船东 2026-11-02 定案）：

| 档位 | 成本 | 机制 | 状态 |
|---|---|---|---|
| 第 0 档 | 零成本自动 | worker 瞬时故障原地重试（≤3，**结构化信号优先**：网关日志会话窗口内本 harness 的 429/5xx/quota 记录命中即定性 `worker_retry source=gateway`——上游改错误文案不再致盲；无网关数据/未命中/读取失败 fail-open 落回 stderr 正则兜底）、调试/审查返工循环、blocked 卡自动续跑（autoresume：transient 或「未产出结果块」族才续、24h 冷却）、watch 有痕重探 | 已内置 |
| 第 1 档 | 低成本计费自动 | **zcode 船 prompt 超限（>30k argv 上限）自动切 fallback 船**：`engine_escalated` 事件留痕，预算延续不重置，每 run 至多一次 | workflow.json `escalation.enabled`（缺省关） |
| 第 2 档 | 高成本人工审批 | 旗舰档（ahead-4）/ 加大预算 / 换供应商 | 永不自动——调度台停下请示 |

- `escalation: { enabled: true, fallbackBackend: "claude-headless" }`——**fallbackBackend 写进配置即持久授权**（同 autopilot 哲学），运行时不再为换船请示。
- 红线不变：预算熔断永远硬顶（escalation 不重置不放宽预算）；所有升档事件留痕（永不静默）；第 0/1 档只救「装不下/瞬时限流」类故障，验收失败照走调试与人工闸门。

## 自由航行（sail，时间盒完全自治）

`node .agents/scripts/orchestrator.mjs sail --minutes 120`（或 `--duration 2h|90m|1h30m`，可加 `--max-cost-usd N` 燃油上限）：船长自勘海况（scan 巡检）→ 自绘航线（propose 产卡，编排理由写在卡上）→ 自航自泊（drain 全门禁闭环）→ 到点收帆交**航海报告**——完成了什么、为什么这么编排、燃油账几何，落 `logs/sail/<ts>/report.md`（stdout 同文 + webhook 通知 + fleet 留痕，`sail_started`/`sail_finished`）。与 watch 的差别：有硬时长预算、报告收口、自动提交不依赖 autopilot 配置。

- **授权模型**：人显式敲下带时长的 sail 命令 = 本航次自动提交授权。硬禁区不变（配置只收窄、永不放大）：`created_by: human` 人工草稿、`deps` 类型、`feature` 类型（走上游管线，见『上游管线』，2026-11 起——此前 feature 提案直接进队列，设计无人看过）、files_hint 命中 corePaths/releasePaths 永不自动；类型白名单 workflow.json `freeSail.autoSubmitTypes`（缺省 `["docs","bugfix","refactor"]`）；提交 gate 覆写 L1——实际合并仍由分级裁决 + drift 保险丝兜底。开航前已有的存量 drafts 永不自动提交。
- **循环**：pending 非空 → `drain --max 1`（一次只派一张，每张之间重新看表）；队列空 → scan + propose + **上游管线（feature 提案派调研、升级 spec 落盘待人审，见『上游管线』）** + 自动提交（非 feature）→ 立即派发；仍空 → 休眠 `--interval`（缺省 10 分钟）再看海况——planner 空手轮由休眠挡住，不会连环烧钱。**空队指数退避（2026-11-11）**：连续零新提交 ≥2 轮起规划轮休眠逐轮翻倍、60 分钟封顶（`sailIdleSleepMin`）；新提交/派发即复位；显式配了更高 `--interval` 时不缩（cap 只封退避增长，配置只收窄、永不放大），`--interval 0` 保持禁睡。每周期重读 workflow.json（改配置即时生效；**配置守卫例外**见 orch-supply.md『配置守卫』——workflow.json 被外部改写期间跳过派发与规划）。
- **停止条件（任一）**：到达 `--minutes/--duration`、`.agents/orchestrator/.sail-stop` 文件（下周期即停并清文件）、drift 降级（人工 `drift --clear` 后再启）、`--max-tasks N` 派发上限、**`--max-cost-usd N` 燃油上限**（网关实测价 ≥ 上限即收帆并记 `sail_cost_cap`——**只停不换引擎**，换计费方必须人批；检查节流 60s）、连续 3 轮派发无进展（队列卡在待引水/解析失败时触发）。**软截止**：跑着的任务让它跑完，不超时强杀；风暴闸滞留期跳过派发与规划（scan 照跑——不派 worker），窗口滑过自动恢复。
- **燃油账（报告「值不值得」的依据）**：本航次 [起航, 收帆] 网关实测 token × 价目 = USD（总账 + 逐卡拆账，逐卡按各自事件时间窗投影）；worker 直连上游时如实标「不可测」；收帆时若成本上限已触发，按完整航程重算覆盖触发时刻快照。
- **报告口径（为什么这么编排）**：全部确定性组装、不再烧 LLM——战果清单按队列快照差分（merged / 待放行 / 搁浅退关 / 剩余 pending，开航基线如实区分「开航前已在队列」与「本航次新增」）；编排理由直接引用 planner 卡片上的目标句原文 + 每周期提交/否决原因 + goals.md 罗盘对齐说明。voyage.json 逐周期落盘，SIGINT 强杀后也能续查航迹。

## push 审查门禁（push-review，上远程前的整体审查闸）

背景：夜间自由巡航 / 多卡并行的本地 develop 提交此前 push 上远程没有整体审查闸门。防线分两层——**① 审查命令** `node .agents/scripts/orchestrator.mjs push-review [--range A..B] [--model m] [--backend mock]`：只读审查船按 REVIEW.md 口径过一遍待推提交（缺省 range `@{u}..HEAD`，回落 `origin/develop..HEAD`，再无则要求显式 `--range`；diff >400KB 拒审并建议分段），结论落 `.agents/orchestrator/push-review/latest.json`（schema `push-verdict/1`：verdict/overall/findings/reasons/head/range/reviewed_at）+ fleet 留痕 `push_review`；verdict=fail 退出码非 0。**② hook 闸**（`.agents/hooks/policy-dispatch.mjs` 扩展，判定核心在同目录 `push-gate.mjs`）：agent 会话里的 `git push`（含 `git -C <path> push` 形态）命中 main/develop 时——无审查要件拦截并给三选一；`AGENTS_ALLOW_PUSH=1` 人工授权旁路（认 hook 进程 env 与命令前缀 hatch 两形态，与 `AGENTS_ALLOW_RELEASE` 同语义，责任在人，留痕 `~/.agents/hooks/push-gate.log`）或 push-review 结论 pass 且 24h 内且 HEAD 未变 → 放行。推其他分支显式指名即放行；tag/npm publish/force push/`--all`/`--follow-tags`（顺带推可达 annotated tag，含 v* 触发 Release——与 `--tags` 同待遇按保护拦）等一律走既有裁决（tag 触发 Release 永远人工，绝不借道本闸；`AGENTS_ALLOW_RELEASE` 发版白名单原样生效）。

- **流程**：巡航收帆 / 批量合并到 develop 之后 → `orch push-review` → 绿了才 push → **HEAD 再变即失效**（结论绑定 `git rev-parse HEAD` 全 sha），需重跑审查；verdict=fail 先修 findings 再重审。
- **生效面（务必写进认知）**：hook 只拦 agent 的 Bash 会话——policy-dispatch 挂在 claude/zcode hook 链上、按既有语义仅 `ORCH_POLICY_ENFORCE=1` 的会话（编排器 headless worker / 审查船等）裁决；**船东本人终端不经 hook，完全不受影响**。门禁对既有红线只收窄不放行：仅覆盖「纯 push 段 + publish 类拦截」，端口等其他红线与 `AGENTS_ALLOW_RELEASE` 发版通道原样生效。放行覆盖前置二次核验（2026-11 round2）：放行前对每个 非 push 段独立重跑既有红线（含「仅涉受保护端口字符串」的保守面，`ssh -R 8687` 这类 listen 词表外形态由此兜住），任一命中即 defer 走原拦截路径；`cd <他仓>` / `git --git-dir=<他仓>` 改锚形态一律 defer——工件核验的仓库必须 = 实推的仓库（`cd` 到非仓库目录与本仓路径不受影响）。
- **两层防线**：本闸是本地事前审查；CI 仍有 test-workflow 兜底（push 后三平台矩阵），漏网错误在远程 CI 再拦一次。
- **安装（合并后由调度台执行一次）**：`cp .agents/hooks/policy-dispatch.mjs .agents/hooks/push-gate.mjs ~/.agents/hooks/`（**两个文件都要**——dispatcher 运行时动态加载同目录 push-gate.mjs），并确认用户级 hook 注册仍指向 `~/.agents/hooks/policy-dispatch.mjs`（缺 push-gate.mjs 时门禁自动 defer 走既有裁决，不丢拦截只丢新文案）。

## 双向批示（approval listener，飞书卡片远程审批闸门）

闸门通知原来只有单行文本（nightly webhook，见『夜航巡港』）——人不在电脑前就得等回工位再批。双向批示把回路补上：**需要人工动作的落位事件在文本通知之外多发一张飞书交互卡片，群里点按钮即可远程批示 approve / reject / retry**。缺省完全不启用：卡片开关不开不发卡、监听器不启动不占端口，行为与历史版本零差异。

- **通知侧（发卡）**：workflow.json 可选键 `"notify": { "cardWebhook": true }`（缺省 false）。开启后，`awaiting-human` / `blocked`（含预算熔断、看门狗等 circuit_breaker 落位）与风暴闸 `weather_hold` 会在原文本通知（`${envPrefix}_ORCH_WEBHOOK`，一字节不改）之外**额外** POST 一张飞书 interactive 卡：approve（批准合并）/ reject（驳回）按钮 value 携带 `{ task, action }`，weather_hold 为 fleet 级事件没有可批示单卡 → 纯信息卡不带按钮。webhook URL 复用既有解析链（env 优先 + darwin 钥匙串兜底）；**仅飞书端点发卡**（企业微信/Slack 自动跳过，只收文本）。
- **回流侧（批示）**：`node .agents/scripts/approval-listener.mjs [--port N] [--root <仓库根>]` 显式启动（缺省端口只认 workflow.json `notify.listenerPort`，都没配报错退出——**永不缺省监听**；只绑 `127.0.0.1`）。飞书卡片回调打过来：`url_verification` 握手直接回显 challenge；动作回调验签（verification token 须与 env `AGENTS_LARK_VERIFICATION_TOKEN` **常数时间一致**——sha256 归一化后 `timingSafeEqual`，防时序侧信道逐字节猜测，2026-11 起；不一致 403 并落审计 `approvals.jsonl`（只记 `rejected` 事实与来源 IP，**绝不记 token 值**）；env 未配拒绝所有动作）后映射为 orchestrator 既有命令 `approve/reject/retry <task-id>`（reject 无原因用默认文案），结果以 toast 回复群里。同 task 同 action 60s 内重复点击忽略（防手抖）；审计逐行落 `.agents/orchestrator/logs/approvals.jsonl`（ts/task/action/来源 IP/结果）。
- **安全边界**：监听器自身不引入新权限——映射目标全是 orchestrator 既有闸门命令，approve 仍走 feature-branch finish 的完整门禁与 testCmd，合并权实质在门禁与人；token 属密钥，不写日志不入库；监听器只收 POST、请求体上限 1MB、外网触达须自行架转发（frp / 云主机反代 / Tailscale Funnel 等）并自行评估暴露面。飞书侧配置步骤见 [orchestrator-usage.md](../docs/orchestrator-usage.md)。

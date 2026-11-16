# orchestrator.mjs 命令参考（orch-commands）

> `node .agents/scripts/orchestrator.mjs <cmd>` 全部子命令速查，按场景分组。
> **权威源 = orchestrator.mjs 的 `usage()`**（`test/orchestrator/hygiene-docs.test.ts` 断言其与操作手册速查一致）；本表按域重组便于查阅——改命令面时三处同步：`usage()` / `.agents/workflows/orchestrator.md` 速查 / 本表。
> 场景语义与闸门纪律见对应 runbook：闭环 `.agents/workflows/orch-loop.md`、自主模式 `orch-autonomy.md`、供给 `orch-supply.md`、观测 `orch-observe.md`、周边 `orch-ecosystem.md`。

## 闭环核心（任务卡进、合并出）

| 命令 | 作用 |
|---|---|
| `submit <card.md>` | 校验任务卡并提交到 pending/ |
| `run <task-id\|--next> [--backend mock] [--review-backend <name\|same>]` | 启动单任务闭环（--next 自动取最高优先级 pending；审查后端缺省自动异构互审） |
| `drain [--max N] [--workers N] [--backend mock] [--review-backend …]` | 清空 pending 队列（--workers N 并发跑，按 files_hint 分区互斥） |
| `status [task-id]` | 队列全貌 / 单任务事件时间线 |
| `resume <task-id> [--backend mock]` | 崩溃任务带恢复上下文续做 |
| `abandon <task-id>` | 放弃任务（worktree 清理按 Rescue 手册人工做） |
| `approve <task-id>` | 人工闸门：批准合并（调 feature-branch finish） |
| `reject <task-id> --reason "..."` | 人工闸门：驳回（附原因，转 failed/） |
| `retry <task-id> --note "..."` | 人工闸门：打回重试（附补充指令） |
| `logs <task-id>` | 打印事件时间线 |
| `follow <task-id> <补充指令>` | 运行中任务的直通信息通道（写 inbox，会话边界送达 worker；awaiting-human 用 retry --note） |
| `autoapprove [--timeout N] [--dry-run] [--sleep-first]` | 分层审核超时 sweep：扫 awaiting-human 卡（spec 审查结论仅 autoApprove.specBuild.enabled=true 时扫描，缺省关），把拍板窗口（autoApprove.timeoutMinutes 缺省 3 分钟）已过的按最后一条 review_verdict 推荐自动执行（blockers=0/skipped→merge；>0→限次 retry；无审查结论 fail-closed 不动作；drift 降级跳过）。--dry-run 只报告；watch/sail/nightly 每周期开头自动跑 |
| `stats [--days N] [--json] [--cost]` | 运行度量：每卡 wall/turns/迭代/token 峰值/watchdog/follow-up 聚合（只读）；--cost 加燃油账（网关实测 × 价目，USD） |
| `drill [--backend mock]` | 弃船演习：临时港 mock 跑一张合成托运单，验证闭环自身健康（不烧真钱、不碰真队列） |

## 自主模式（授权制）

| 命令 | 作用 |
|---|---|
| `nightly [--tests] [--plan] [--auto N] [--backend …] [--review-backend …] [--manual]` | 一次完整巡检编排（scan + drift 报告；--plan 加跑 planner 提案；--auto N 顺带跑 high 提案并 drain——worker 烧钱仅在此档）。--manual 显式人工触发，不受 20h 双跑防护限制 |
| `watch [--interval 30] [--max-cycles N] [--backend …] [--review-backend …]` | 连续自治运行：drain → 队列空时 scan+propose → 休眠循环；停止文件 `.agents/orchestrator/.watch-stop`；drift 降级自动退出 |
| `sail --minutes N（或 --duration 2h\|90m\|1h30m\|90s）[--max-tasks N] [--max-cost-usd N] [--interval 10] [--backend …] [--review-backend …]` | 自由航行：时间盒完全自治——scan 勘察 → propose 规划+自动提交 → drain 执行循环，到点收帆交航海报告（logs/sail/<ts>/report.md）。停止：.sail-stop / drift 降级 / --max-tasks / --max-cost-usd（网关实测价达上限即收帆，只停不换引擎）；开 sail 即本航次自动提交授权（deps/人工草稿/核心·发布路径永不自动） |
| `schedule install\|uninstall\|status [--mode nightly\|watch\|sail] [--hour 0-23] [--minute 0-59] [--interval 30] [--tests] [--auto N] [--minutes N\|--duration 2h] [--dry-run]` | 定时调度注册（launchd/crontab/schtasks 经 wrapper 绝对路径启动） |
| `propose [--max N] [--backend mock]` | autopilot 需求综合：goals.md + 巡检提案 → planner 高质量提案落 drafts/（白名单卡自动提交） |
| `drafts gc [--apply]` | 提案生命周期清退（--dry-run 只列清单；--apply 迁移文件，永不删除）：与 merged 卡 files_hint 重叠的提案迁 drafts/superseded/，超 draftsGc.maxAgeDays（缺省 14 天）且队列零痕迹的机器提案自动清退，超 draftsGc.archiveDays（缺省 30 天）迁 drafts/archived/ |

## 信号与规划（spec / research / 巡检）

| 命令 | 作用 |
|---|---|
| `scan [--todo] [--audit] [--tests] [--issues] [--ki] [--ci] [--dry-run] [--run]` | 巡检出提案落 drafts/（人工批量 submit 或 autopilot 白名单自动提交；--run 对 high 提案立即提交并闭环） |
| `intent "<一句话描述>" [--draft] [--backend mock]` | Planner 把意图编译成任务卡（--draft 只出草稿不进队列） |
| `spec "<一句话描述特性>" [--from-brief <brief-id\|topic-id[,id2…]>] [--backend mock]` | 规格驱动：Planner 出 requirements/design/tasks 三件套，人工审阅后再拆卡；--from-brief 把调研结论注入设计（rollup unsafe 一票否决拒绝注入） |
| `spec build <id>` | 把已审阅规格的 tasks 拆成任务卡进 pending/（design 全文注入卡背景；幂等） |
| `spec list / spec show <id> / spec status <id>` | 浏览规格目录 / 单规格任务概要 / 规格全局进度锚（progress.json） |
| `spec review <id> [--backend <名>] [--model m]` | 三件套 agent 分层审查（L0 确定性 + L2 五维评分 + findings 定位对账）——**advisory**，拆卡仍人审（可 opt-in 委托超时自动拆卡）；规约 `.agents/conventions/spec-review.md` |
| `research "<调研问题>" [--min-citations N] [--model m] [--backend mock]` | 上游调研：researcher 只读+联网会话产出带引用 brief——feature 提案与 spec --from-brief 消费；无引用即拒收 |
| `research --selftest` | 实测当前后端 WebFetch/WebSearch 可用性（烧少量 token） |
| `research multi "<主题>" --dim "<维度1>" --dim "<维度2>" …` | 多维调研（维度 ≥2，上限 research.maxDims 缺省 4）：单维失败隔离不炸批次；落 research/topics/<topic-id>.json（rollup 最差档聚合） |
| `research verify <brief-id\|topic-id> [--backend …] [--model m]` | L2 可信度复核：readonly 会话判内部一致性；判出矛盾自动跑联网仲裁轮（upheld 翻案解除否决） |
| `research stats` | L3 可信度台账：按调研船模型聚合核实率与判级分布 |
| `research snapshot <brief-id> [--mirror] [--max N]` | 对既有 brief 补跑引用快照（幂等，零 LLM token）；--mirror 经 r.jina.ai 镜像读取（默认关） |

## 质量与观测（对账 / 降级 / 发版 / 审查闸）

| 命令 | 作用 |
|---|---|
| `drift [--clear]` | 质量漂移报告：自动合并回溯失败率超 20% 自动降级全人工（--clear 人工恢复） |
| `reconcile [task-id] [--fix-states]` | 用量对账（自报 token vs 网关实测）+ 燃油账（需 gatewayAdmin）+ 卡状态对账（--fix-states 把「已合并未落位」的卡落位） |
| `release-propose [X.Y.Z]` | 发版提案：盘点提交 + semver 定档 + CHANGELOG 草稿（只读仓库；确认后说「发布 vX.Y.Z」） |
| `push-review [--range A..B] [--model m] [--backend mock]` | push 前整体审查（REVIEW.md 口径；diff >400KB 拒绝建议分段）——verdict=fail 退出码非 0；pass 且 24h 内且 HEAD 未变时 hook 闸自动放行 git push main/develop |
| `notify-digest --flush [--sleep N]` | digest 聚合通报冲刷：睡满 notify.digest.quietWindowSec 后把待发事件合并成一条扁平事件流通报发出 |

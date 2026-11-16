# 观测与对账 runbook（stats · drift · reconcile · 舰队控制台 · 评测集）

> 何时读：看运行度量与单卡对账（stats / follow / drift / reconcile）、跨仓舰队看板、验船师与调研评测集回归、分层审核超时委托（autoapprove）与任务通报聚合（notify-digest）。命令速查见 [orchestrator.md](orchestrator.md)。

## stats 与 follow（引水传令）

- `stats --days 7 [--json] [--cost]`：每卡 wall/turns/调试与审查迭代/重试/watchdog suspect/follow-up/token 峰值（budget_snapshot 口径）+ 各状态卡数与合并率汇总；`--cost` 加燃油账（网关实测 token × 价目 = USD，一次日志扫描 + 一次价目请求服务全部任务，可测任务数与不可测原因如实标注）。JSON 形态：顶层 `summary` 嵌套对象 + `rows`。跨引擎精确对账用 reconcile。汇总含**安全晴雨表**（`summary.near_miss`，人类输出「安全晴雨表」行）：watchdog suspect / 瞬时重试 / 偏航报警（`xte_alarm`，确定性规则只留痕）/ 事故调查包（`incident.md`，VDR 终态自动归档）四类近乎事故计数——险情比事故多，先看晴雨表再定流程调优。
- `follow <task-id> "<补充指令>"`：给 running/ 的卡递话，写 `logs/<id>/inbox.md` + `follow_up` 事件，在下一次会话边界（调试返工/审查返工/resume/新 spawn）注入 prompt 尾部（20 条/4000 字符截断，前缀缓存友好）。只对 running 卡开放；awaiting-human 用 `retry --note`，pending 直接改卡文件。`status <task-id>` 会显示待送达条数。

## drift（质量漂移保险丝）

自动合并回溯失败率超阈值（`driftThreshold` 缺省 0.2，**可调不可关**）→ 降级全人工（`run` 的自动合并全部回闸门，事件 reason=drift_degraded，fastlane 同步失效）。`drift` 看报告；根因消除后 `drift --clear` 人工恢复。

## reconcile（狗粮对账）

`reconcile [task-id]`：① 用量对账——自报账（events budget_snapshot）vs 网关实测账（转发日志 usage），分歧率 = |自报−实测|/max，网关零流量标 ⚠（worker 绕过了狗粮）；启用条件 = workflow.json `gatewayLogDir` 已配置。**燃油账**（2026-11-02）：实测 token × 模型单价 = USD——价目经 `POST /_modeldock/pricing-lookup`（admin 面，需 `gatewayAdmin: true`）取网关权威价目（`~/.modeldock/pricing.json` 用户覆盖 > models.dev 目录牌价），取不到价按 $0 计并列 unpriced 清单；网关不可达回落陈价目缓存（logs/pricing-cache.json，标注「陈价目」），价目完全不可得时只出 token 账不打断对账主体。② 状态对账——git merge 现实 vs 队列落位：「已合并未落位」`--fix-states` 修复、「账面合并但 git 无实证」警告（squash/改史）。纯只读（除 --fix-states）。事故调查包（incident.md）的「上游海况」段复用同一投影（不过滤失败请求）：时间窗内请求/失败分布、路由事件痕迹（failover/down_all）、时延 p50/p95、实测用量与最近失败现场——回答「预算烧在哪」。

## 舰队控制台（fleet-console，跨仓聚合）

一台机器上多个项目各自跑 Dockmaster 闭环时，健康度散落在各仓 `.agents/orchestrator/` 下；`fleet-console.mjs` 一条命令把整个「舰队」拉成一张只读看板（**纯只读，不改任何港口状态**，零第三方依赖，Node ≥18）：

```bash
node .agents/scripts/fleet-console.mjs [--project <目录>]... [--days 7] [--json]
```

- **项目清单**（合并去重）：CLI `--project`（可多次）+ 配置文件 `~/.agents/fleet-console.json`（`{ "projects": ["/abs/path", ...] }`，相对路径相对 `~/.agents` 解析；缺失视为无自定义，格式错误告警后忽略）+ 当前仓库（始终并入）。
- **每港采集**：queue 七状态卡数；`logs/fleet.jsonl` 近 N 天事件按类型计数（weather_hold / sail_* 等）；`logs/nightly-state.json` 上次巡检时间（有 startedAt 无 finishedAt 标 ⚠未收尾）；`degraded.json` 漂移降级标记；并 spawn **该仓自带**的 `orchestrator.mjs stats --json --days N`（cwd=该项目根，30s 超时）取窗口汇总——合并率与安全晴雨表 near_miss。各港用各港的编排器版本出账，工具链自包含语义不破。
- **容错**：无 `.agents/orchestrator/` 的项目标「非港口」跳过；stats 失败（脚本缺失/超时/退出非零/输出损坏）标「不可得」，该港其余指标照常出。
- **输出**：人类可读对齐表格（待泊/在坞/搁浅/待放行/出港 N 天/合并率/险情/风暴/漂移/巡检 + 全队合计行）；`--json` 出机器可读结构（`projects[]` + `totals`），供脚本与 cron 消费。全队合计的窗口汇总只对「stats 可得」的港口求和（`totals.stats_ok_ports` 标明覆盖面）。
- 典型用法：cron/nightly 拉一份 `--json` 存档；人工早上跑人类表格一眼看全队——哪港搁浅堆积、哪港风暴滞留、哪港漂移降级。

## 验船师评测集（reviewer-evals）

reviewer 的回归评测集在 `.agents/review-evals/reviewer/cases/`（合成 diff + 期望判定成对，覆盖端口/路径/atomicWrite/import.meta 红线、越界、Windows、i18n、断言假绿 + 1 个干净负样本）。跑分器 `node .agents/scripts/reviewer-eval.mjs`：默认 dry-run 零消耗；`--run --backend …` 真跑（烧钱，人工发起）；`--grade <目录>` 静态重放评分（CI 可用）。改 REVIEW.md / reviewer prompt / 审查模型后必跑一轮，分数低于基线不保留；出题纪律与评分口径见 `.agents/review-evals/reviewer/README.md`。

## 分层审核超时委托（autoapprove）

L2/L3 卡落 awaiting-human 后人工有拍板窗口（workflow.json `autoApprove.timeoutMinutes`，**缺省 3 分钟**；`enabled: true` 缺省开、`maxAutoRetry` 缺省 1）。窗口已过仍未批示的卡由 **autoapprove sweep** 按该卡最后一条 `review_verdict` 的推荐自动执行——agent 结论是推荐层，人只是没来得及拍板：

- `blockers=0` 或 `verdict=skipped`（fastlane）→ 自动合并（`doApprove source='auto'`，merged 事件带 auto 标记，计入 drift 回溯统计）；
- `blockers>0` → 自动返工（retry，note「超时自动按审查结论返工（分层审核）」），**每卡限 maxAutoRetry 次**，超限留人；
- **fail-closed 五条（不可关闭）**：① 没有 `review_verdict` 的卡超时也绝不动作；② 最后一条相关事件是 `review_engine_failed` 视同无结论；③ blockers>0 的卡永不自动合并、只限次返工；④ drift 降级期间 sweep 整体跳过（恢复只能人工 `drift --clear`，每卡留 `autoapprove_skipped` 痕）；⑤ scope_outside（范围失控）落位的卡超时也绝不自动批示——范围失控不该静默合并（与合并闸门同一条不变量），自动返工同样跳过，一律留人工拍板。推荐层不存在的场合一律留人。
- 红线不动声明：feature 提案的 intake 自动提交拒绝逻辑（canSailSubmit/canAutoSubmit 的 feature 拒绝）零改动——超时委托只作用于「已进闭环、已过审查」的卡，不碰任何提案 intake 闸门。

**触发时机**：① drain/run 落位 awaiting-human 后拉起一次性 detached sweep（先睡满窗口+0.5 分钟再扫，`--sleep-first`；自己抢调度器锁，drain 未收尾时有界重试等锁——60s 间隔 ×10 次上限，每轮失败 log 一行、耗尽 log 放弃交周期 sweep 兜底，绝不并发批示。2026-11-11 巡航修复：旧实现单次抢锁失败即退出，多卡 drain 期间自动批示静默落空）；② watch/sail/nightly 每周期开头 spawnSync 同步扫一遍（**configGuard 漂移期间跳过**——被改的 autoApprove 配置不生效，与派发/规划同口径）；③ 手动 `orch autoapprove [--timeout N] [--dry-run]`（--dry-run 只报告；--timeout 覆盖配置，测试/临时收紧用）。spec 环节 **opt-in**（2026-11-11 巡航修复：拆卡进真实施工，「拆卡人工拍板」闸门缺省不委托——`autoApprove.specBuild.enabled=true` 显式开启才扫描）：`specs/<id>/review-verdict.json` 结论 `approve_to_build` 且超时且未 build 过（无 progress.json）→ 按推荐拆卡并通知；blocked/rework 结论开启也永不自动放行。每个 executed 动作发飞书通报（标题带项目名前缀）。动作与落位通知开启 digest 聚合通报（`notify.digest.enabled`）时先进待发队列，由 `orch notify-digest --flush` 子命令合并成一条扁平通报发出（落位流程 detached 自动拉起；手动补发可直达；机制详见『任务通报聚合』）。

## 任务通报聚合（notify digest）

逐事件直发是「一堆乱消息」——一次 drain 落位 N 张卡手机收 N 条。workflow.json `notify.digest.enabled=true` 后落位/批示通知进聚合队列（`.agents/orchestrator/notify-digest/pending.jsonl`），按 Claude Code hooks 通知哲学收敛成**一条扁平通报：一条通知=事件+一句话，标题分诊，细节落文件**（实现 `.agents/scripts/orchestrator/notify-digest.mjs`）。

**触发**：① attention 级（awaiting-human/blocked）落位立即同步 flush，不进静默窗（需要人看见的信号不等人）；② 落位后 detached flush 子进程睡满 `notify.digest.quietWindowSec`（缺省 60s，0=无窗）再发——窗内多条合并一条；③ 长跑收口（drain 收官 / sail 收帆 / nightly 收尾）force flush 兜底。同 taskId 多事件合并一行终态（pending→merged 只留 merged）；并发 flusher 靠 rename 原子认领不双发，投递失败事件还原不丢。

**格式**（2026-11-10 改版，弃三段式「核心/事件/流程状态」）：

```
【ModelDock】✅2 · ⏸1
⏸ feat-a 待批示（scope_outside）——3 分钟未批将自动合并
✅ docs-b 合并（407fae3）
✅ fix-c 合并
📋 规格 spec-a：1/2 ✅
📄 详情：/path/to/repo/.agents/orchestrator/notify-digest/last.txt
```

- **标题** = 项目名 + emoji 计数摘要（✅合并 · ⏸待批 · ⛔阻塞/退关 · 📄其余事件，只列非零项；纯 normal 批 = `【项目名】📄N 事件`）——扫一眼分诊要不要点开。
- **正文** ≤5 行扁平事件流，每行 `emoji 对象 动作(关键数字)` ≤60 字：merged → `✅ <taskId> 合并（commit 前 7 位，有则带）`；awaiting-human → `⏸ <taskId> 待批示（reason 前 20 字）`；blocked/failed → `⛔ <taskId> <状态标签>（reason 前 20 字）`；其余（research/spec/autoapprove 中态等）→ `📄 <title 前 40 字>`。超 5 行保留 attention 行、余量折叠 `…另 N 条见详情`。
- **尾行**：本批事件带 specId 才读 `specs/<id>/progress.json` 出规格进度（读不到省略）。specId 接线（2026-11-11 巡航修复）：settleNotify / notifyAutoApproveAction 从卡 id 派生——spec build 拆出的卡 id 形如 `<spec>-t<n>`，去 `-t<n>` 后缀且 `specs/<id>/` 在场才带上；spec 动作（taskId 即规格 id）直接透传。详情档 last.txt 是本批完整 JSONL（一行一条事件，flush 时原子归档），通知里不展开的细节全在那里。

## 调研评测集（discovery-evals）

researcher（上游管线调研船，见 orch-autonomy.md『上游管线』）的回归评测集在 `.agents/discovery-evals/cases/`（`<id>.json`：question + goals + minCitations + 期望关键词 mustFind/mustFindAny）。跑分器 `node .agents/scripts/discovery-eval.mjs`：默认 dry-run 零消耗（顺带校验案例 schema）；`--run --backend …` 真跑（烧钱，人工发起）。评分是确定性规则——无引用即拒收（引用数达标）+ 关键词命中率；引用真伪以输出留档与 brief sources/ 快照人工复核为准。改 researcher prompt / 模型 / 换网关后必跑一轮；出题纪律见 `.agents/discovery-evals/README.md`。

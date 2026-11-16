# 事件字典（orch-events）

> Dockmaster 的两本 append-only 事件账 + 任务通报契约。**权威源 = 事件写入代码**（`orchestrator/events.mjs`、`orchestrator/weather.mjs` 及各命令模块）；本表按域给出语义速查——新增事件先登记本表。
> 事件的设计语义（为什么有这本账）见 `.agents/docs/design-orchestrator.md` §6.3 与对应子系统小节。

## 一、任务事件（events.jsonl，`.agents/orchestrator/logs/<task-id>/events.jsonl`）

每行一个 JSON 事件：`ts`（ISO8601 带时区）+ `seq`（单调递增）+ `type` + 事件字段。任务卡闭环的权威时间线——崩溃恢复、成本核算、质量漂移统计都从这本账回放。

### 生命周期骨架

| type | 语义 |
|---|---|
| `task_accepted` | 任务卡通过校验入队（含 card_hash） |
| `worktree_ready` | feature-branch worktree 就绪（path / branch） |
| `worker_spawned` | worker 会话拉起（backend / pid——孤儿检测按此 PID） |
| `worker_turn` | worker 工具轮次流水（turn / tool / file） |
| `worker_done` | worker 输出契约块解析完成（status / acceptance 申报） |
| `worker_retry` | worker 级重试（瞬时故障退避 / 看门狗代收尾后重跑）——风暴闸统计口径 |
| `worker_stderr_tail` | worker stderr 尾部留痕（排障） |
| `gate_result` | 静态门禁单项结果（gate / result） |
| `review_spawned` / `review_verdict` / `review_iteration` | 审查船拉起 / 三级裁决（blockers/suggestions/notes）/ 审查返工回边 |
| `review_verdict_retry` | 契约行补问（resolved 布尔——补出=true） |
| `review_backend_fallback` / `review_engine_failed` | 审查引擎降级 / 失败（异构互审切换留痕） |
| `human_gate` | 人工闸门裁决（approved / rejected / retried / deferred） |
| `auto_merge` / `auto_merge_decision` | 分级自动合并执行（含分级/gate/迭代数）/ 裁决过程 |
| `merged` | 合并落位（merge_commit / duration；`auto: true` 标自动合并——drift 统计口径） |
| `failed` / `blocked` | 终态（附 reason） |
| `awaiting_human` | 进入人工闸门（reason=drift_degraded 标降级期回人工） |

### 预算与熔断

| type | 语义 |
|---|---|
| `budget_profile` / `budget_baseline` | 该任务生效的预算档位（budgetProfiles 覆盖）/ 会话级记账基线（committed+sessionMax） |
| `budget_snapshot` | 周期性用量快照（tokens_in/out + `tokens_billable` 可计费口径 + `tokens_cache_read` 缓存读单列） |
| `budget_low_fuel` | 低油量告警（可计费口径逼近 max_tokens） |
| `circuit_breaker` | 熔断触发（reason：max_turns / max_tokens / max_wall_minutes / max_test_iterations / max_review_iterations / permission_wall）——永不静默重试 |
| `debug_iteration` | 调试子循环计数（test_failure / tsc_build / acceptance_gap 触发） |
| `acceptance_shortfall` | 验收标准自报缺口（不等门禁直接返工） |
| `speculative_resume` | 投机续跑（崩溃恢复路径） |
| `engine_escalated` | 故障处置升级链降级到 fallbackBackend |

### 分级与放行

| type | 语义 |
|---|---|
| `tier_resolved` | 任务等级解析结果（tier 路由到哪艘船） |
| `change_classification` | classifyChange 分级结果（L0–L3，闸门摘要显示） |
| `pilotage_required` | 引水闸：该任务需人工放行才可继续（高危类） |
| `dispatch_selected` / `dispatch_advisory` / `dispatch_held` | 动态选船：选定引擎 / 仅建议不强制（advisory） / 因互斥或包络外暂扣 |
| `fastlane_active` / `fastlane_skipped` | fastlane 提速档生效 / 跳过（近乎事故留痕，stats 晴雨表消费） |
| `harness_provisioned` / `harness_provision_failed` / `harness_revoked` | 一次性凭据签发 / 签发失败 / 吊销（gatewayProvision） |
| `watchdog_suspect` / `watchdog_disabled` / `watchdog_error` | 看门狗疑似卡死 / 关闭 / 自身出错（领先指标） |
| `xte_alarm` | 偏航告警（偏离预期改动面/路线，领先指标） |
| `incident_archived` | 调查包归档 |
| `follow_up` / `follow_up_delivered` | follow 直通指令投递 / 会话边界送达 worker |
| `prompt_file_ref` | prompt 经文件注入（防 argv 上限，zcode 30k 实测教训） |
| `merge_lock_wait` | 任务锁等待（并发撞锁） |
| `config_drift_detected` | workflow.json 被外部改写（configGuard 触发，同时落 fleet 账） |
| `sail` | 自由航行事件（start/finish/cost 段随 fields 区分） |
| `scan_filtered` / `scan_semantic` / `signal_dropped` / `signal_relayed` | 巡检过滤 / 语义过滤 / 信号丢弃 / 信号转发（消毒链路留痕） |

## 二、舰队事件（fleet.jsonl，`.agents/orchestrator/logs/fleet.jsonl`）

跨任务调度层留痕（单文件，fleet 级观察面）：

| type | 语义 |
|---|---|
| `sail_started` / `sail_finished` | 自由航行起航 / 收帆（报告路径、燃油账摘要） |
| `sail_cost_cap` | 燃油上限触发收帆（网关实测价达 --max-cost-usd） |
| `sail_research_unsafe` | 调研结论 unsafe 被 sail 拒绝注入（一票否决留痕） |
| `weather_hold` | 风暴闸滞留（阈值命中，停派发；窗口滑过自动恢复） |
| `push_review` | push 审查门禁结论（verdict/head/branch——pass 24h 且 HEAD 未变才放行） |
| `config_drift_detected` | 配置漂移（与任务账同型，fleet 视角） |
| `drafts_gc_auto` / `drafts_superseded` | 提案自动清退 / 重叠让位（drafts gc 周期执行） |
| `orphan_heal_beat_silent` | 孤儿治理心跳静默（监督缺口告警） |
| `workers_scaled` | 并发供给闸调整（maxWorkers 变化） |
| `fleet_observed` | 开航前海况观测快照（config+metrics 压缩；告警三类：dogfood_bypass / not_attached / meltdown_active） |

## 三、任务通报契约（webhook）

- **通道**：飞书/通用 webhook；URL 存钥匙串（`notify.keychainService`，防明文），环境变量前缀 `<envPrefix>_ORCH_WEBHOOK` 可注入。
- **四段式**（任务级通报固定结构）：任务卡 id + 状态变化 + 关键数字（耗时/token/迭代）+ 下一步（闸门待审/已合并/已阻塞原因）。
- **聚合通报（digest）**：`notify.digest.quietWindowSec`（缺省 60s）静默窗内待发事件合并成**一条**扁平事件流——标题 emoji 计数分诊（如「✅2 ⚠1」），正文 ≤4 行关键事件；`notify-digest --flush` 手动冲刷。
- **落位与收官自动通报**：awaiting-human / blocked / failed 与 drain 收官自动发（detached 子进程拉起，不阻塞主流程）。

> 新增事件类型时：①写入代码处用 `appendEvent`（任务账）或 `appendFleetEvent`（舰队账）；②本表登记一行；③若有通报语义，确认 digest 分诊 emoji 覆盖。

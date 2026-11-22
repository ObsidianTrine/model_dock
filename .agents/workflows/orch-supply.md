# 供给与守卫 runbook（选船 · 并发闸 · 配置守卫 · 提案清退 · 一次性凭据）

> 何时读：调并发（workers>2）、动态选船（海况+难度在包络内自动换船）、排查 workflow.json 自改防护（configGuard）、清理积压提案（drafts gc）、scan 卡断链自愈（scanAutoFix）、每任务一次性网关凭据（gatewayProvision）。命令速查见 [orchestrator.md](orchestrator.md)。

## 动态选船（dynamic dispatch，阶段 3）

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
- **派发预检（协议兼容矩阵，2026-11-09）**：选船后、spawn 前对目标 provider 校验「该船 harness 客户端协议 × provider 协议端点」——堵「模型走错 provider 404」类事故（claude-code 钉缺 anthropic 端点的服务）。数据面消费 `/_modeldock/config` 的协议矩阵（provider.protocols + harness.protocols），与派发路径 fleet 观测同一快照、与预检①同一 tier-validate 解析（**零重复请求**）；两侧交集为空 → 同款 `dispatch_held {reason:"protocol_incompatible", provider, harness, provider_protocols, harness_protocols}` 滞留 + 卡转 blocked（补齐端点或换 provider 后 resume）。**双端都声明才校验**——任一侧 null/为空不拦（zcode/dsh 等多协议自适应 harness 天然不受影响，与网关 pinProtocolConflict「未声明不校验」同口径）；快照缺席/条目缺失/解析链不可得一律照常派发（fail-open）。
- **派发预检 advisory（备用模型目录核验，2026-11-10 M3，不阻断）**：worker 模型预检①通过后，若该 provider 配了 `model_fallback`（数据源 `POST /_modeldock/service/model-fallback`，admin 门内只读、同款凭据——既有预检链路 tier-validate / model-availability / fleet 的 config+metrics 均不透出该映射，metrics 的 model_fallback 段仅改发计数投影不可用），对每个备用目标做 hold 同款严格目录核验：条目新鲜 ∧ `ok:true` ∧ `model_ids` 非空且不含目标 → **不滞留**（worker 模型本身可用，容灾失效只影响兜底路径），改记 `fallbackMissing: [模型id...]` advisory → `decideDispatchForRun` 写决策日志一行 + `dispatch_advisory {reason:"fallback_model_missing", provider, model, fallback_missing}` 事件，派发照常。映射查询失败 / 端点缺席（旧版网关 404）/ 未配置 → 无 advisory 不报错（fail-open）；查询 5min / 负 60s 节流缓存。
- **不越权三律**：显式 CLI `--worker-backend` / `--backend` 最高优先（动态选船直接让位，不留痕）；resume/retry 沿用上次会话（会话连续性优先，中途不换船）；mock 永不参与自动选船（测试链路照常可用，mock 也不进 envelope）。
- **留痕**：所有非常规选择记 `dispatch_selected { from, to, switched, reason }` 事件（永不静默红线）；决策链任何一步失败自动回落「不决策」按既有规则派发——动态选船是优化，绝不阻断派发。
- **与 fleet observe 的关系**：阶段 1 观测（`fleet_observed`）只照亮不决策，本节是它的决策消费者。难度路由不需要网关（纯卡面信号）；逐船海况判读需要 `gatewayAdmin: true` 的观测快照，观测缺席不判恶劣（观测缺席 ≠ 风暴）。
- **与 escalation 的关系**：escalation（见 orch-autonomy.md『故障处置升级链』，zcode 30k 自动升档）在动态选船之后作外层兜底，逻辑不动；预算熔断不受动态选船影响（换船不重置预算）。

## worker 并发供给闸（scheduling.maxWorkers，如何解锁 workers=2）

drain 的有效并发 = **min(请求并发, provider 容量)**——请求并发 = CLI `--workers N`（显式单次意图，最高优先）> workflow.json `scheduling.maxWorkers`（缺省 1 = 现状不变）。容量经网关 admin 面观测（`gatewayAdmin: true` 才触达）：worker tier token → `/_modeldock/tier-validate` 解析到 provider → 查该 provider 的 `max_concurrency`（`/_modeldock/config`）与 key 池健康（`/_modeldock/metrics` 的 `keypool[provider]`）。

- **解锁 workers=2 的完整步骤**（船东操作，编排器绝不自行触碰生产配置）：
  1. 在 ModelDock（生产实例）给 worker 用的 provider 配 `max_concurrency >= 2`（Web 控制台「编辑服务」或 config.toml）——网关侧信号量 + 排队由此生效，上游不再被并发打 429；可选配多 key 池（`keys` >= 2）进一步扩容；
  2. 给 worker 卡配 tier（token 指向该 provider 的 harness）——供给闸靠 tier token 定位 provider；
  3. workflow.json 设 `"scheduling": { "maxWorkers": 2 }`（自动化常态）或单次 `drain --workers 2`。
- **判定**：`max_concurrency>=2` 且（key 池 `healthy>=2` 或 `total>=2`）→ 容量 = min(max_concurrency, healthy/total)；否则容量 = 1。自动扩容生效（无显式 `--workers` 时）记 fleet 级 `workers_scaled { from, to, provider, reason }` 事件；请求被容量压低同样留痕（`观测缺席`/`未解锁`/`key 池不足` 等原因写在 reason）。
- **fail-open 口径**：`gatewayAdmin` 未开 → 完全不设闸不触达（行为与历史一致）；观测面已开但网关不可达/字段缺失 → 容量按 1（回落单 worker 现状，只是不扩容，派发照常，绝不因观测失败中断 drain）；所有观测请求超时 ≤3s，每 drain 只探一次。
- **与预算实测账的配合**：多 worker 同跑时各自卡独立计账；同 tier 并发 worker 共享同一 harness 实测账（实测增量互相可见——预算判定偏保守方向，只早熔断不漏熔断）。

**预算实测账（配合供给闸，机制详见 orch-loop.md『后端与 tier』）**：worker 运行中每 60s 轮询 `/_modeldock/harness-usage` 的 `day_billable_tokens`（网关实测**可计费**口径，剔除缓存读）做低油量/熔断判定——zcode 无逐 turn 自报（会话结束才一次性回填），此前 token 预算对它近乎失效；实测账补上真实逐时段预算。harness↔task 映射由 tier token 经 tier-validate 解析，记在 `tier_resolved` 事件的 `gateway_harness` 字段；实测以「本任务起点基线」取增量（同 harness 其他流量不计入本任务，防跨任务假阳性）；字段缺失（旧网关）或观测不可达 → 自报账照旧兜底。reconcile 离线对账逻辑不变。大 prompt（>2 万字符）自动落 `logs/<taskId>/prompt-full.md` 全文、worker prompt 收缩为文件引用 + 要点摘要——不再依赖 zcode argv 30k 超限后的换船兜底（escalation 保留为最后防线）。

## 配置守卫（configGuard，workflow.json 自改防护）

workflow.json 是编排器的**授权面**（autopilot 白名单、escalation fallback 船、dynamicDispatch 包络、budgetProfiles 全住这里）——2026-11 实证事故：sail 派发的卡在 worktree 里自改 workflow.json 的默认引擎并合并，授权配置被**被调度方**改写而编排器无感。守卫语义（缺省开，`"configGuard": { "enabled": false }` 关闭，不推荐）：

- run/drain/watch/sail 启动时记 workflow.json 的 **sha256 基线**；每次派发前校验（drain 逐卡发射前、watch/sail 每周期、run 每个 worker 会话边界）。
- 不匹配 → fleet 级事件 `config_drift_detected`（含前后 hash）+ webhook 通知 + **暂停新派发**（在途任务继续）。同一漂移 episode 只宣布一次。
- **恢复 = 重新校验通过**：文件改回基线内容（hash 复合）自动恢复；编排器**自己** finish 合并导致的合法变更（合并卡已过门禁与人审）在 doApprove 完成后自动重置基线。人工/外部改 workflow.json 要生效：核实后**重启编排器**（重启即重新记基线）——老语义「watch 每周期重读配置即时生效」在守卫生效期间让位。
- 进程边界说明：drain 派的 run 是子进程，子进程 merge 后重置的是子进程自己的基线——父 drain 会在下次派发前发现漂移并暂停，操作者核实（正是「卡改了授权配置」这类变更需要人过目）后重启即可。这是有意从严：合并进主干的 workflow.json 变更一律要求一次人工确认。
- run 进程内漂移（外部改写发生在闭环中途）：当前会话照常收尾，下一个会话派发前守卫拦停，卡转 `blocked/`（reason=config_drift）附调查包，人工核实后 resume。

## 提案生命周期（drafts gc，提案清退）

drafts/ 提案此前只进不出（16 张积压实证，其中 ≥3 张已被 merged 工作覆盖）。三条生命周期（**永不删除文件，只迁移目录**）：

- **自动 superseded（闭环内动作，merge 即触发）**：卡落 merged/ 时，drafts/ 里 `files_hint` 与刚合并卡**路径重叠**（前缀精确口径：同文件/同目录/互为路径前缀；完全通配 `**` 独占；仅标题相似**不迁**——防误杀，只在 gc 报告提示）的提案自动迁入 `drafts/superseded/`，文件头标注 `superseded_by: <合并卡 id>`。fleet 留痕 `drafts_superseded`。
- **老化自动档（nightly 清退，2026-11-10）**：nightly 周期自动执行一次两类保守清退 → `drafts/superseded/`：① superseded 类（与 merged/ 卡 files_hint 重叠——补收提案晚于合并创建的现场）；② 超龄未提交类（超 `draftsGc.maxAgeDays`（缺省 14 天）且**队列 7 状态零痕迹**、机器来源（`created_by` ∈ planner/scanner）的提案，文件头标注 `superseded_by: aged-out`）。三重保护：队列有同名卡不动（提案已提交/被真实工作吸收）、人工草稿不动、痕迹面不可知整档关闭。fleet 留痕 `drafts_gc_auto`。
- **老化（手动档）**：`orchestrator drafts gc [--apply]`——缺省 dry-run 只列清单（superseded 候选 / 超龄未提交候选 / 超 `draftsGc.archiveDays`（缺省 30 天）的 aged 候选 / 仅标题相似的提示）；`--apply` 才迁移（superseded/超龄未提交带标注迁 `drafts/superseded/`、aged 原文迁入 `drafts/archived/`）。年龄口径：frontmatter `created_at` 优先、mtime 兜底、都缺不老化（宁少勿滥）。
- **总闸**：`"draftsGc": { "autoSupersede": false }` 同时关闭 merge 时与 nightly 的自动 supersede/清退（drafts gc 手动档不受影响）；超龄档阈值 `"maxAgeDays"` 可调。
- 已在 superseded/ 或 archived/ 的提案不回锅（`drafts gc` 只扫顶层 .md）；同名目标文件已存在跳过不覆盖（Windows rename 语义安全），失败留原地等人工；超龄档与归档档独占（同一提案不会被两份清单重复迁移）。

## scan 卡自动转修复卡（scanAutoFix，巡检→修复断链自愈）

主干巡检卡（id `scan-*` 前缀，scanner 产出）failed 是终态，此前只能人工 abandon——scan→修复的自动链断路。现在 drain 处理到**本轮落位 failed 的 scan 卡**时自动补一张 pending 修复卡：

- 修复卡 id `fix-<原名>`（如 `scan-ci-414aba6c` → `fix-scan-ci-414aba6c`），正文引用原卡路径、`incident.md` 调查包与失败摘要（最后一条 failed/blocked 事件的 reason）；`files_hint`/type/priority/gate 继承原卡。**它是普通任务卡，照走既有全部门禁**（引水闸/L2L3 人审不绕过）。
- 防循环双保险：① 修复卡 id 无 `scan-` 前缀，自身 failed 不再繁殖新卡；② 同名修复卡在**任一队列状态**已存在即跳过（merged/failed 也算——scan 卡永驻 failed/，按状态白名单去重会跨 drain 打环）。
- 事件留痕：原卡日志记 `scan_autofix { fix, reason }`。关闭：`"scanAutoFix": { "enabled": false }`（恢复旧行为）。

## 每任务一次性凭据（gatewayProvision，ephemeral harness）

worker/reviewer 的凭据此前长期复用 tier token（env 注入，源头是长期 harness）。开启 `"gatewayProvision": true`（平铺键，缺省 false = 现状不变；前置 `gatewayAdmin: true`——admin 面同一授权域）后，run 在 spawn 前向网关 `/_modeldock/harness/provision` 签发**任务专属临时 harness**（TTL ≤24h 硬顶、不落盘、token 明文只在签发响应出现一次；id 确定性 `orch-<taskId>`，被占用自动降级为网关随机 id）：

- **注入口径**：env patch 只换 `ANTHROPIC_AUTH_TOKEN`（复用 tierEnvPatch 同形通道；claude-headless 的 settings.env + 子进程 env 双通道、zcode-headless 的 env 透传照旧，后者「CLI 是否认 env」的 no-op 风险同前）。**不注 base_url**——接入目标仍由 ModelDock attach 写好的客户端配置文件决定。zcode 不认 tier 的既有选船规则不变。**签发传参按卡生效预算（2026-11-10）**：`max_daily_tokens` = 卡 budget.max_tokens（budgetProfiles 校准后，per-harness 日限额与任务熔断同源——凭据本身也是预算防线）；`ttl` = ceil(生效 max_wall_minutes/60)+1 小时（缺省 8h TTL 可能先于 wall 熔断过期，长任务后半程掉凭据；provision.mjs 内仍受 ≤24h 网关硬顶收敛）。
- **fail-open**：所有失败形态（admin 未配置/网关不可达/超时 ≤3s/非 2xx/响应缺字段）回落既有 tier token 路径，行为与未开启完全一致；每类失败留 `harness_provision_failed` 事件（含原因），绝不阻断派发。
- **实测账更准**：签发成功时预算实测轮询（见『worker 并发供给闸』）按该 harnessId 精确取数——专属凭据没有同 harness 兄弟流量，基线污染消失；签发失败/未开启回落 tier token 解析的 harness（基线法照旧）。
- **吊销时机（best-effort，失败只告警不重试，漏网由 TTL 兜底）**：① 接管路径——run 启动时发现上次 run 签发未吊销的凭据（events.jsonl 查 `harness_provisioned`/`harness_revoked` 对账）先吊销再签新的；② 终态落位（blocked/failed 走 exitRun、merged/awaiting-human 走 finally）进程退出前吊销——awaiting-human 落位后无 worker 流量，一并吊销，approve/retry 的新 run 会重新签发；kill-tree/熔断终归收敛到这两条出口。
- **临期预警与自动续期（orch-ephemeral-expiry-watch / orch-ephemeral-renew-consume，2026-11-11 登记）**：实测油量轮询（见 orch-loop.md『后端与 tier』）同一份 harness-usage 里 ephemeral 条目带 `expires_at`——剩余 < min(20% TTL, 30min) 时落 `harness_expiry_warning` 事件 + log，随即向网关 `/_modeldock/harness/renew` 续命（POST `{harnessId, ttl_minutes}`，≤3s 超时；网关只延不缩、收敛 ≤24h 硬顶）：成功落 `harness_renewed`（含新 expires_at），失败落 `harness_renew_failed`。**fail-open 不重试**（重试风暴红线；漏网由 TTL 自然过期兜底，临期前任务尽量收尾落位）；回调与轮询整体兜错——Windows EBUSY 等写盘同步异常也不带崩 run 进程。保守闸两道：只认本 run 已签发未吊销的凭据；卡落位终态（blocked/merged/failed）后不再续——awaiting-human 人工闸门期间凭据仍活，照常预警与续期。续期成功改写网关侧 `expires_at` → 下一轮 usage 即新阈值实例，可再告警/再续（去抖按 expires_at 天然重置，无需手动清状态）。
- **事件**：`harness_provisioned { harness_id, expires_at }`、`harness_revoked { harness_id, ok, existed, trigger: takeover|terminal|run_exit }`、`harness_provision_failed { reason }`、`harness_expiry_warning { harness_id, expires_at, remaining_ms, threshold_ms }`、`harness_renewed { harness_id, expires_at, ttl_minutes }`、`harness_renew_failed { harness_id, reason }`。

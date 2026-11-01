# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-budget-cross-session-max — ✅ 审出

- 考题：Budget 记账用全局 Math.max——stream-json 的 budget_snapshot 是「本会话全程累计」，跨 fixup/调试会话取 max 互相覆盖漏计：实测 300k+100k 两会话只记 300k，token 预算熔断形同虚设
- 关键词：math.max=中，会话=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-C6bJB8/2026-10-budget-cross-session-max.output.txt

<details><summary>模型原文</summary>

```text
## 发现 4 个问题

以下行号均指所给快照（已核对与 `a755671^` 版本一致）；跨模块证据取自同一提交的对应文件。

---

**1. 审查会话的 spawn 事件污染 worker 后端继承——retry/resume 会把审查引擎当成执行引擎（高）**

- 证据链（三处互相咬合）：
  - 快照 `orchestrator.mjs:556-558`：reviewer spawn 的 `onEvent` 把**所有**事件原样 `appendEvent(qdir, e.type, e)` 写进同一份 events.jsonl；
  - 同版本 `orchestrator/backends/claude-headless.mjs:175`（zcode-headless.mjs:154、mock.mjs:34 同）:`spawn` 无条件发 `{ type: 'worker_spawned', backend: <本后端>, pid }`——reviewer 会话发的也是 `worker_spawned` 类型；
  - 同版本 `claude-headless.mjs:319-333` `resolveBackendName`：`[...readEvents(qdir)].reverse().find(e => e.type === 'worker_spawned')?.backend` 取**最后一条** worker_spawned。
- 失败场景：异构互审（两个真实 CLI 都装了时的缺省行为，worker=claude、reviewer=zcode）下，任何一次闭环在审查之后结束——L3 任务的常态终点 awaiting-human、审查超限 blocked、审查中崩溃——events.jsonl 的最后一条 `worker_spawned` 都是 **reviewer 的**。此后 `run/resume/retry`（`orchestrator.mjs:230-232`）沿用「上次会话后端」= zcode：配置了 `worker.backend` 时误触后端切换人工闸门直接 die（244-249）；没配置时 **worker 静默换引擎烧到非预期模型/账单**——正是 243 行注释里 2026-10-29 夜跑事故要防的形态。mock 集成测试测不出（worker/reviewer 同名 `mock`）。
- 附带同源问题：`orchestrator.mjs:376` 手写的 worker_spawned（无 pid）与后端自发的 worker_spawned 每会话双写一份，时间线重复；`cleanupOrphanWorker`（129-139）靠 reverse().find 恰好拿到带 pid 的那条才没坏——两条记录依赖这种偶然对齐。

**2. reviewer 临时目录泄漏，含 tier token 的 settings 文件（高）**

- `orchestrator.mjs:541`（reviewPromptFile）与 `548-551`（reviewSettingsFile）每轮审查各自 `mkdtempSync` 建新目录；`finally`（645-648）只清理 `promptFile`/`settingsFile` 两个目录，**reviewer 的目录从不删除**。
- 失败场景：每次审查泄漏一个 tmpdir；`review-settings.json` 经 `writeWorkerSettings(reviewSettingsFile, tierEnv)`（550）写入了 `ANTHROPIC_AUTH_TOKEN`（tier 凭据，见 `tiers.mjs` tierEnvPatch）——凭据文件持久残留系统临时目录直到系统清理，审查返工 N 轮泄 N 份。

**3. interactive 人工闸门 [b] 打回在闭环进程内自锁，卡悬 running/（中）**

- `orchestrator.mjs:213` cmdRun 持任务锁 → `627-628` `await humanGateInteractive(...)`（在 try 内，锁未释放）→ `[b]` → `doRetry`（803-812）先 `moveCard('awaiting-human','running')`（809）再 `await cmdRun(...)`（811）→ 内层 `acquireTaskLock`（213）读到锁文件 pid=本进程且 `isAlive` 为真（`task-lock.mjs` 无同进程重入豁免，对比 run-lock 有 `childEnvForHeldLock` 豁免机制）→ `held:false` → `die`，报错还提示「终止 pid <自己的 pid> 后重试」。
- 失败场景：TTY 非 CI 环境（main:1589 `interactive: process.stdin.isTTY && !process.env.CI`）跑 `run <id>`，审查通过后人工选 `[b]` 打回——必现：整个进程 exit，卡已迁 running/ 但无进程驱动，需人工 resume。走 CLI `retry` 子命令（main:1695-1704）无此问题，仅 interactive 路径中招。

**4. 预算跨会话不累计，`max_tokens` 红线在多会话下失效（中）**

- `orchestrator.mjs:108-111`：`this.tokens = Math.max(this.tokens, tokensIn + tokensOut)`——取**各会话峰值**而非累加；而每次 fixup/审查返工都是全新 CLI 会话（同版本 `claude-headless.mjs:171` 每 spawn `let tokensIn = 0` 重置，`budget_snapshot` 只反映单会话累计）。
- 失败场景：调试子循环（最多 `max_test_iterations`）+ 审查返工（最多 `max_review_iterations`）共约 8 个会话，每个烧到接近上限也不会熔断——总消耗可达 `max_tokens` 的数倍；`trip` 文案自称「累计 X / 上限 Y」（110）与实现不符，红线「熔断不可关闭」名存实亡。另外 reviewer 的 `budget_snapshot` 只落事件不 `account()`（557 无调用），审查消耗完全不计入预算。`events.mjs:2` 头注「budget_snapshot 累计」也佐证语义应为累加。

---

## 存疑（证据不足，不列为确认问题）

- `orchestrator.mjs:257`：`resolveReviewBackendName` 的 prior 用 `.find` 取**第一条** review_spawned（非 reverse）。多轮审查同后端时首末一致，未找到实际分歧场景，不确定是否有意。
- `orchestrator.mjs:129-139` `cleanupOrphanWorker` 按事件里的 pid 盲杀：崩溃期间若 pid 被无关进程复用会误杀。概率低且 task-lock 接管有同款假设，疑似有意取舍。
- `--max 0` 在 drain（925、970）被当作 Infinity（`opts.max > 0` 才生效）——与「0=不跑」的直觉相反，但无事故证据。
- `Budget` 构造（104）：`max_wall_minutes` 折算 ms 超过 2^31-1 时 Node setTimeout 溢出为 1ms 立即触发熔断——仅极端配置可触发，`validateCard` 未设上限。
```

</details>
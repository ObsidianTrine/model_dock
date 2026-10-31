# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-orchestrator-repo-root — ✅ 审出

- 考题：findRepoRoot 双实现语义相反（--git-common-dir vs --show-toplevel）且注释自称「同款」：从 linked worktree 内跑 orchestrator 会把 queue/ 锚进 worktree，与 finish 需主仓库检出矛盾
- 关键词：git-common-dir=中，show-toplevel=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-tbPufr/2026-10-orchestrator-repo-root.output.txt

<details><summary>模型原文</summary>

```text
发现 8 个问题（已逐条回读同版本源码验证行号与行为；支撑模块 task-lock.mjs / claude-headless.mjs / scan.mjs 均按 `c99f326^` 版本核实）：

1. **orchestrator.mjs:58-61 — `findRepoRoot` 用 `--show-toplevel`，从 linked worktree 内调用时把队列锚进 worktree**
   `git rev-parse --show-toplevel` 在任务 worktree 内返回的是 **worktree 根**，不是主仓库（注释声称「兼容从 worktree 内调用」恰恰是错的）。后果链：`queueRoot`/`logDir`/`worktreePath` 全部锚到 worktree 内 → 队列分叉；`ensureWorktree`（162 行）委托 feature-branch start，而 feature-branch.mjs:30-41 用 `--git-common-dir` 锚到**主仓库**的 `.agents/worktrees`——两套 root 语义分裂，orchestrator 在 167 行 `fs.existsSync(worktreePath(...))` 检查必然失配 → die「声称成功但未找到 worktree」。feature-branch.mjs 同函数的注释已写明这个坑，orchestrator 没跟上。

2. **orchestrator.mjs:184 — `spawnSync('npm', ['ci', …])` 无 `shell: true`，Windows 必 ENOENT**
   Windows 上 npm 是 `.cmd` 包装（feature-branch.mjs:285 跑 setupCmd 就带了 `shell: true`），直调 spawn 失败 `r.status === null` → die「worktree 依赖安装失败（exit null）」。setupCmd 失败后的兜底安装路径在 Windows 完全不可用。**同类还有 1 处**：`orchestrator/scan.mjs:88` `spawnSync('npm', ['audit', '--json'])` 同样无 shell——nightly 的 audit 信号源在 Windows 静默失效（被 93 行吞成「跳过」）。

3. **orchestrator.mjs:753-755 + 211 — 交互闸门 `[b]` 打回重试会撞上自己持有的任务锁，process.exit 杀掉整个闭环进程**
   `humanGateInteractive` 在 cmdRun 的 try 块内被调用（613 行），此时 cmdRun 已持有任务锁（211 行）。`[b]` → `doRetry`（705 行）先 `moveCard('awaiting-human'→'running')`，再 `await cmdRun(...)`（755 行）→ `acquireTaskLock` 读到锁文件 pid=当前进程且存活 → `{held:false}` → die（217 行）→ `process.exit(1)` **整个进程退出**：卡片永远留在 running/，retry 实际没有重启任何闭环。task-lock.mjs 无同 pid 重入豁免（已核实）。CLI 直调 `retry` 不持锁所以正常——仅交互路径坏。

4. **orchestrator.mjs:360-390 — 熔断触发后循环顶部无 `budget.tripped` 检查，可静默再烧一个完整 worker 会话**
   tripped 的唯一检查点在 384 行（worker spawn 返回之后）。wall-clock 熔断发生在 npm test 门禁（407 行）或 review 期间时：onTrip 杀掉 reviewer（或空手），`parseReviewVerdict` 解析空输出 → blockers=1 → 568-570 行 `continue` → **新 worker 被 spawn 并跑满整个会话**才在下一轮 384 行被拦。违反文件头 11 行红线「熔断超限永不静默重试烧钱」。

5. **orchestrator.mjs:541-544 — reviewer 的 token 不入预算账**
   worker 的 onEvent 在 375 行调 `budget.account`，reviewer 的 onEvent 只 `appendEvent` + `trackPid`，没有 account——审查返工循环的 token 消耗完全绕过 `max_tokens` 熔断（wall-clock 之外的第二条熔断线对 review 侧失效）。

6. **orchestrator.mjs:932-937 — `cmdDrainParallel` 未监听 `child.on('error')`，spawn 失败时 drain 挂死且持锁**
   `launch` 只注册 `exit` 回调。spawn 失败（如 node ENOENT）只触发 `error` 事件，`active` 永不清空、`pump` 永不续跑 → 并发 drain 不退出，调度器锁一直被占，后续 nightly/drain 全被 863 行挡掉。

7. **orchestrator.mjs:119 vs 219-222（backends/claude-headless.mjs，同版本，非给定片段但已核实）— 可用性探测与实际 spawn 的 shell 语义不一致，Windows 上 worker/reviewer 全挂**
   探测 `spawnSync('claude', ['--version'], { shell: win32 })` 命中 .cmd 返回「可用」；实际 `spawn('claude', args, {…})` **无 shell** → ENOENT → reject → 每个 run 都落 blocked/。且 82-106 行 `--settings`（mkdtemp 临时路径）、`--allowedTools` 白名单族参数含空格，补 shell 时还须包引号——两处都要修。

8. **orchestrator.mjs:526、534 — review 临时目录泄漏**
   `orch-review-`/`orch-review-settings-` 两个 mkdtemp 目录从不清理；finally（630-633 行）只清 `promptFile`/`settingsFile` 的目录。每次跑 review 泄一个临时目录（对照 cmdIntent/cmdSpecStart 的 finally 是成对清理的）。

**存疑**

- **feature-branch.mjs:268** — `cmdStart` 用 `path.resolve` 精确比对 worktree 注册路径，未像 orchestrator `ensureWorktree`（151 行）那样做大小写/分隔符归一；但 taskId 强制小写、两侧路径同源于 git 输出，实际触发条件（盘符大小写差异等）缺复现证据，不排除误报。
- **orchestrator.mjs:120** — `cleanupOrphanWorker` 按 PID 存活判断杀「孤儿」，存在 PID 复用误杀无关进程的理论窗口（resume 场景）；属启发式固有风险，未见实害证据。

已验证不是问题：`Budget.account` 用 `Math.max`（97 行）——核实 backend 的 `budget_snapshot` 是累计值（claude-headless.mjs:157-161），语义正确；`worker_spawned` 事件 pid 追踪——orchestrator 自落的 367 行事件虽无 pid，backend 经 onEvent 追加的带 pid 事件在其后，reverse-find 命中正确。
```

</details>
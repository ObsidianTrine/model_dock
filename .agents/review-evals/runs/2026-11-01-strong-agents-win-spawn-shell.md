# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-agents-win-spawn-shell — ✅ 审出

- 考题：.agents 编排器在 Windows 上 spawn 全局命令未带 shell（.cmd 包装直调必 ENOENT）：claude worker 探测带 shell 说可用、spawn 不带起必挂（worker/审查全落 blocked/），orchestrator npm ci 依赖装不上，nightly audit 信号源静默失效
- 关键词：shell=中，enoent=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-lIui78/2026-10-agents-win-spawn-shell.output.txt

<details><summary>模型原文</summary>

```text
发现 8 个问题（按严重度排序；每条均已回读源码与仓库历史核实行号属实）。

## P0 — Windows 必挂 / 语义错误（即后续修复的那批）

**1. claude worker spawn 与可用性探测 shell 语义不一致 — Windows 上探测说可用、spawn 必挂**
`claude-headless.mjs:119` 的 `spawn('claude', args, {...})` 不带 `shell`，而同文件探测 `claudeAvailable()`（`claude-headless.mjs:219-223`）在 win32 用 `shell: true`（npm/claude 在 Windows 是 `.cmd` 包装，直调 ENOENT）。结果：探测返回 true → `getBackend` 选中 claude-headless → worker 与 reviewer 每次 spawn 都 ENOENT，经 `orchestrator.mjs:180-185` 的 error → reject → `failTaskToBlocked`，全部任务落 blocked/。修复方向：win32 补 shell 并对含空格参数（`--allowedTools` 白名单族、`--settings` 临时路径）做引号包装；unix 分支不能加 shell（改变进程组/信号语义，杀树依赖进程组，见 `orchestrator.mjs:118` detached 注释）。

**2. `installWorkspaceDeps` 的 `npm ci` 直调 — Windows ENOENT，装依赖必死**
`orchestrator.mjs:184`：`spawnSync('npm', ['ci', …], { cwd, stdio: 'inherit' })` 无 shell。Windows 上 ENOENT → `r.status` 为 null → `orchestrator.mjs:185` die「worktree 依赖安装失败（exit null）」。feature-branch start 的 setupCmd 失败仅告警（AGENTS.md 明示），此路径是真实兜底，每次 run 必触发。

**3. `scanAudit` 的 `npm audit` 直调 — Windows 上 audit 信号源静默失效**
`scan.mjs:88` 同款无 shell；ENOENT 后 `r.stdout` 为空 → `scan.mjs:91-94` JSON.parse 失败 → 返回 skipped「npm audit 不可用（无网络或无 lockfile）」——**报错理由还是错的**（实际是 spawn 失败），nightly 巡检漏洞信号在 Windows 永久静默丢失。

**4. `findRepoRoot` 用 `--show-toplevel` — linked worktree 内运行时队列锚错仓库**
`orchestrator.mjs:61`。orchestrator 的任务 worktree 就在 `<repoRoot>/.agents/worktrees/<id>`；agent 在 worktree 内跑 orchestrator 时 `--show-toplevel` 返回 worktree 路径 → `queueRoot`/`logDir` 全锚进 worktree，与 `doApprove` 里 feature-branch finish 需主仓库检出（`orchestrator.mjs:727` `cwd: repoRoot`）矛盾，且不同 cwd 看到不同队列。应对齐 feature-branch.mjs 的 `--git-common-dir` 语义。

## P1 — 状态机/预算缺陷（后续修复合入的其他真实缺陷，均已从代码确证）

**5. awaiting-human 卡直跑 `run` 必崩**
`orchestrator.mjs:199` 状态白名单放行 `awaiting-human`，但 `orchestrator.mjs:311` 只处理 pending 迁移，awaiting-human 不迁移；闭环里第一个 `moveCard(root, taskId, 'running', …)`（如 `orchestrator.mjs:522`）源目录无卡抛 QueueError → catch（622）→ `failTaskToBlocked`（645）只认 running/reviewing → 返回 null → `throw e` 裸栈崩溃，卡滞留 awaiting-human。

**6. resume 后端沿用取首次而非末次 worker_spawned — 静默切回旧引擎**
`claude-headless.mjs:271`：`readEventsFn(qdir).find((e) => e.type === 'worker_spawned')` —— events 是 append-only（每次 run 至少落两条 worker_spawned：`orchestrator.mjs:367` 与 `claude-headless.mjs:125`），`.find` 永远命中**第一次**运行的后端。任务经人工批准切换引擎后，resume/retry 会静默切回最初引擎，恰好绕过 `orchestrator.mjs:239-247` 的后端切换人工闸门。同文件 `cleanupOrphanWorker`（`orchestrator.mjs:120`）用的是 `[...events].reverse().find`，此处应对齐取末者。

**7. scope_purity / 分级 diff 未传 baseBranch — 非 develop 基准仓库结果全错**
`orchestrator.mjs:510` `gateScopePurity(worktree, meta.files_hint)`、`orchestrator.mjs:574` 与 `:604` 的 `changedFiles(worktree)` 都没传 `baseBranch`，而同流程的红线门禁（`orchestrator.mjs:469` `gatePortScan`、`:479` `gateNativeScan`、`:516` `gateCliEntry`）显式传了。内部回落硬编码 `'develop'`（已读 gates.mjs 确认），baseBranch=main 的仓库里范围纯度、change_classification、文件数统计全部对错基准 diff。

**8. 并发 drain 的 `--max` 烧钱上限首轮失守**
`orchestrator.mjs:940-947`：`pump()` 只在入口查 `launched >= max`，随后内层 `for (;;)` 的每次 `launch` 仅受 `active.size >= workers` 约束（`:947`），而 launch 是同步循环、child exit 是异步事件——`--workers 3 --max 1` 首轮同步连发 3 个 run 子进程才停。串行路径每次发射前都查 `done >= max`（`:873`），`--max` 是烧钱上限语义，并发路径漏了同款约束。

## 存疑

- `claude-headless.mjs:77-79` `newWorkerSettingsPath` 用 `process.env.TMPDIR ?? '/tmp'`：Windows 无 TMPDIR（是 TEMP/TMP），落到 `\tmp\` 大概率 mkdtempSync 抛错。但这三个文件里无任何调用点（疑似死代码），不确定仓库其他文件是否引用——若确为零引用应删而非修。
- `orchestrator.mjs:526/:534` 创建的 `orch-review-` / `orch-review-settings-` mkdtemp 目录不在 finally（`:630-633`）清理范围，每次 run 泄漏一个临时目录——属清理类，按 REVIEW.md 纪律不单列，仅备案。

> 验证说明：除回读给定片段外，各条均对照仓库实际文件与后续修复记录（c99f326 / 54b0602 / 6fa7775）核实了行号与行为，无按名字推断的条目。
```

</details>
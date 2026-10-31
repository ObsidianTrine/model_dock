# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-agents-win-spawn-shell — ✅ 审出

- 考题：.agents 编排器在 Windows 上 spawn 全局命令未带 shell（.cmd 包装直调必 ENOENT）：claude worker 探测带 shell 说可用、spawn 不带起必挂（worker/审查全落 blocked/），orchestrator npm ci 依赖装不上，nightly audit 信号源静默失效
- 关键词：shell=中，enoent=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-8o87oX/2026-10-agents-win-spawn-shell.output.txt

<details><summary>模型原文</summary>

```text
发现 4 个问题（按严重度排序）

---

**1. 预算熔断被多会话架空：审查用量不计账 + 跨会话不累计** — `orchestrator.mjs:96-98, 541-544`、`claude-headless.mjs:127-170`

- worker 的 onEvent 会喂 `budget.account`（orchestrator.mjs:375），但 **reviewer 的 onEvent（541-544）只 appendEvent + trackPid，从不调 `budget.account`**——审查会话的 token 烧录完全不受 `max_tokens` 熔断约束（只靠 wall timer）。
- `account()` 用 `Math.max(this.tokens, ...)`，而每个 claude 会话的 snapshot 是**会话内累计、跨会话归零**（claude-headless.mjs:127 每次 spawn 重新置 0）。调试返工循环（419→continue）与审查返工循环（568→continue）每次 spawn 都是新会话，`Math.max` 只保留单会话峰值——实际总烧录可达 `max_tokens × (迭代数+1)` 而永不触发熔断。die 文案「累计 X / 上限 Y」（:98）与红线「熔断超限永不静默重试烧钱」（:11）都被架空，且无任何日志。

**2. 含 tier token 的临时 settings 文件泄漏且权限过宽** — `claude-headless.mjs:68-69`、`orchestrator.mjs:533-536, 627-634`

- `writeWorkerSettings` 把 tier 凭据明文写进 `settings.env`，`fs.writeFileSync` 无 `mode` 选项——unix 默认 **0644 全局可读**，落在系统共享 /tmp。
- 清理缺口有两条：① cmdRun 的 finally（631-633）只清 `promptFile`/`settingsFile` 两个目录，**`reviewSettingsFile`（534）正常路径也从不清理**；② 所有 die() 路径（预算熔断 ：389、门禁超限 :417/:434/:458/:503/:566、红线 :476/:486）走 `process.exit`，**跳过 finally**——worker settings（含 token）与任务卡内容永久残留 /tmp。`cmdIntent`/`cmdSpecStart` 的 die（:1155/:1188/:1236…）同理跳过其 finally。

**3. Windows：`spawn('claude')` 不走 shell，与同文件探测自相矛盾** — `claude-headless.mjs:119-124 vs 219-223`

- `claudeAvailable()` 探测特意 `shell: process.platform === 'win32'`（注释明言「命中 .cmd 包装」），但真正 spawn `claude`（:119）没有该处理——npm 全局安装场景（`claude.cmd`）探测通过、每次 spawn ENOENT，任务全落 blocked 且报误导性的「检查 PATH」。
- 同类还有 2 处 `spawnSync('npm', …)` 无 shell：`orchestrator.mjs:184`（installWorkspaceDeps，Windows 直接 die「依赖安装失败 exit null」）、`scan.mjs:88`（audit 信号源在 Windows 永久失效为 warning）。违反 AGENTS.md「spawn 全局命令 Windows 是 .cmd 包装」的明文约定。

**4. `run` 对 awaiting-human 卡缺状态迁移，烧完 worker token 后中途崩溃** — `orchestrator.mjs:199-201, 309-314`

- die 文案明确允许 `awaiting-human(retry)` 启动 run，但只对 `pending` 做 `moveCard(pending→running)`（:311）；awaiting-human 的卡**原地不动**。worker 正常跑完后第一处 `moveCard(root, taskId, 'running', 'reviewing')`（:522）触发 `queue.mjs:286` 的「任务卡不存在」QueueError → 进 catch → `failTaskToBlocked` 因状态是 awaiting-human 返回 null（:645）→ 裸 throw。结果：钱烧了、进程崩溃、卡留在 awaiting-human。已读 queue.mjs 确认 moveCard 严格按 from 目录找文件、不容错。

---

### 存疑

- **stdin EPIPE 未处理**（`claude-headless.mjs:193`）：`child.stdin.write(prompt)` 前后没有 `child.stdin.on('error')`；child 的 'error' 处理器（:180）不覆盖 stdin 流。若 claude 进程早退（参数不兼容等），stdin 可能抛未接管的 EPIPE 使整个 orchestrator 进程崩溃（比「任务转 blocked」更糟）。缺证据：需确认目标 Node 版本对 ENOENT/早退场景 stdin 是否真的发 'error' 事件。
- **doRetry 丢失 flags/审批上下文**（`orchestrator.mjs:644, 753-755, 242-247`）：retry 路径只传 `{backend, reviewBackend}`，`opts.flags` 丢失——若用户原 run 用 `--approve-backend-switch`（CLI flag 而非 env）批准过引擎差异，retry 会重新 die，且此时卡已被 doRetry 移到 running/、die 在 try 之前，卡悬 running/。触发条件窄（需 cfg.worker.backend 配置 + 显式异构 --backend + flag 形式批准），未到确证。

未发现 REVIEW.md 一票否决红线问题（`.agents` 工具链用 `import.meta.url` 不受 SEA 红线约束，未监听任何端口，未触碰 src/ 写盘路径）。
```

</details>
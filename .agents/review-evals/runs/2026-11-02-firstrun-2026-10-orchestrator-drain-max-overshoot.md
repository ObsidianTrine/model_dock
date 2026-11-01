# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-orchestrator-drain-max-overshoot — ✅ 审出

- 考题：drain --workers 并发调度 pump() 只在入口检查 launched >= max，内层同步 for 循环每次 launch 仅受 active.size >= workers 约束——--workers 3 --max 1 连发 3 个 run 子进程才停（--max 是烧钱上限语义；串行路径每次发射前都查，并发路径漏了同款）
- 关键词：--max=中，launched=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-yZCxk5/2026-10-orchestrator-drain-max-overshoot.output.txt

<details><summary>模型原文</summary>

```text
发现 5 个问题（前 2 条即后续 54b0602 修复的真实缺陷；3–5 为本快照中确证的存量缺陷，后续提交亦佐证）。

---

**1. cmdDrainParallel `--max` 烧钱上限被内层连发绕过** — `.agents/scripts/orchestrator.mjs:948`（对照 954、988）

`pump()` 只在**入口**查 `launched >= max`；内层 `for(;;)` 每次发射前只查 `active.size >= workers`（954）。`launch` 是同步调用，child exit 回调插不进来——`drain --workers 3 --max 1` 首轮 `pump()` 会连续发射 3 个 run 子进程（每个都是烧钱的完整 worker 闭环），上限超发 3 倍。对照串行路径 884 行每次发射前都查 `done >= max`，并发路径漏了同款检查。

**2. installWorkspaceDeps 的 `spawnSync('npm',…)` 无 shell，Windows 必失败** — `.agents/scripts/orchestrator.mjs:184`

`spawnSync('npm', ['ci', …], { cwd: worktree, stdio: 'inherit' })` 未加 `shell: process.platform === 'win32'`。Windows 上 npm 是 `.cmd` 包装，直调 ENOENT/EINVAL——worktree 缺 node_modules 时（feature-branch `setupCmd` 失败仅告警后的真实场景）每次 run 都死在装依赖，且此时 `r.status` 为 null，报错文案变成 `exit null` 不可操作。同文件 `spawnSync('node',…)` / `execFileSync('git',…)` 不受影响（exe 非 .cmd），唯独 npm 这处踩线（AGENTS.md「spawn 全局命令 Windows 是 .cmd 包装」条目）。

**3. [存量] Budget.account 用 Math.max 跨 fixup 会话漏计，max_tokens 熔断可被绕过** — `.agents/scripts/orchestrator.mjs:97`

worker 每轮 fixup/审查返工都是全新 CLI 会话，usage 快照是**各会话自身**的累计值；`this.tokens = Math.max(this.tokens, tokensIn + tokensOut)` 只保留单会话峰值——300k + 100k 两会话只记 300k。多轮返工下累计消耗被持续低估，「熔断不可关闭」的 max_tokens 上限形同虚设。

**4. [存量] 崩在 reviewing/ 的卡没有程序化恢复出口** — `.agents/scripts/orchestrator.mjs:529` 与 `:808`

529 行 `moveCard('running','reviewing')` 之后、终态迁移之前进程硬崩 → 卡留 reviewing/。`cmdResume` 白名单只有 running/blocked（808 行）直接拒绝；`cleanupOrphanWorker` 也只在 `found.state === 'running'` 时执行（309–310 行）。唯一出口是 `abandon` 强制落 failed/，丢掉全部已通过的门禁/审查成果。

**5. [存量] reviewer 临时目录每次审查迭代泄漏** — `.agents/scripts/orchestrator.mjs:533、541`

`orch-review-*` / `orch-review-settings-*` 两个 mkdtemp 目录在循环体内每次审查都新建，而 finally（637–640 行）只清理 `promptFile`/`settingsFile` 两处；审查返工多轮即持续积累于 os.tmpdir()，进程退出也不回收。

---

## 存疑（证据不足，不按缺陷报）

- **:255** `readEvents(qdir).find((e) => e.type === 'review_spawned')` 取的是**最旧**一条而非最近一条——跨会话换过审查后端时 prior 钉在陈旧值。需读 `backends/claude-headless.mjs` 的 `resolveReviewBackendName` 确认 prior 语义是否允许取首条。
- **:1166–1169** 先覆写 `meta.gate = 'L3'` 再打日志，`gate=${meta.gate}` 永远显示 L3，原始值丢失——疑似想打覆写前值，纯诊断信息损失。
- **:548–551** reviewer 的 token 消耗不进 `budget.account`（onEvent 只 append + trackPid），token 预算不覆盖审查侧；wall-clock 看门狗仍兜底，是否有意省略缺证据。
```

</details>
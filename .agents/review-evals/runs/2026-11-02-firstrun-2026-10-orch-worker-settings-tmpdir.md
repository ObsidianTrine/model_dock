# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-orch-worker-settings-tmpdir — ✅ 审出

- 考题：claude-headless 后端三连：newWorkerSettingsPath 用 TMPDIR ?? '/tmp'（Windows 无 TMPDIR 回落盘根 \tmp，mkdtempSync ENOENT）；resolveReviewBackendName prior 短路缺反向防御（worker=mock + prior=真实 仍给 mock 会话派真实审查，违反零外部调用不变量）；tier 凭据 settings 文件 writeFileSync 无 mode（默认 0644）且无强制清理
- 关键词：tmpdir=中，0600=中，mock=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-pjQ2fC/2026-10-orch-worker-settings-tmpdir.output.txt

<details><summary>模型原文</summary>

```text
发现 5 个问题（4 条已确证 + 存疑 1 条另列）。

**1. `newWorkerSettingsPath` Windows 崩溃：`TMPDIR` 缺失回落 `/tmp`（`.agents/scripts/orchestrator/backends/claude-headless.mjs:103`）**
`path.join(process.env.TMPDIR ?? '/tmp', 'orch-settings-')`——Windows 不设 `TMPDIR`（只有 `TEMP`/`TMP`），回落 `'/tmp'` 经 win32 `path.join` 解析为「当前盘根 `\tmp`」，该目录通常不存在，`mkdtempSync` 直接抛 `ENOENT`，worker/审查会话在 spawn 前就挂。跨平台项目应锚定 `os.tmpdir()`（NTFS/路径类硬约定同源事故）。

**2. `resolveReviewBackendName` prior 沿用缺反向防御：mock worker 被派真实审查后端（`claude-headless.mjs:299`）**
`if (prior && !(prior === 'mock' && worker !== 'mock'))` 只防了「prior=mock 且 worker 已换真实」单向。反向 `worker='mock'` 且 `prior='claude-headless'`（如测试沙箱任务 resume）时原样沿用 prior → 给零外部调用不变量的 mock 会话派真实 CLI 审查，烧真钱、破坏「mock 永不异构」不变量。正确形态是双向互斥：`prior===mock` 与 `worker===mock` 任一方向不一致都不沿用，落到后续自动异构/fallback 分支。

**3. `writeWorkerSettings` 落盘无权限约束（`claude-headless.mjs:94`）**
`fs.writeFileSync(settingsPath, JSON.stringify(settings))` 未带 `mode`——`settings.env` 可携带 tier 凭据（line 93 注释自证「注入 token」），明文落在系统临时目录且权限过宽（REVIEW.md「secrets 明文外泄或权限过宽」）。应按仓库写盘惯例 `mode: 0o600`（NTFS 忽略权限位无害）。

**4. DISALLOWED 红线漏 `bun publish`（`claude-headless.mjs:65-72` vs `:55`）**
`allowedTools` 显式支持 `packageManager: 'bun'`（line 55 白名单含 bun），但红线仅覆盖 npm/pnpm/yarn publish——bun 项目 worker 的 publish 命令在 CLI 红线层完全不受限，只剩 hook 单保险（注释自述「双保险」）。同类形态应补 `bun publish`。

**存疑（缺证据，不确证）**
- **stdin 无 error 处理（`claude-headless.mjs:237-238`）**：`child.stdin.write(prompt)` 在 `child.on('error')`（line 224）之外未给 stdin 流挂 error 监听。若 spawn ENOENT（探测说可用、实际起不来的 Windows 场景正是本文件头自述风险）或 CLI 立即退出，写失败会在 stdin 流上发 `error` 事件，无监听时可能未捕获异常炸掉编排器主进程。我写了最小复现脚本验证但执行未获批准，故按纪律只列存疑；修复形态为 `child.stdin.on('error', …)` 或在 `'spawn'` 事件回调后再写。
- **`git -C * push`（`claude-headless.mjs:68`）中间通配**：`shellPatterns` 把它变成 `Bash(git -C * push:*)`——claude 权限规则是否支持模式中段 `*`（而非仅前缀 `:*`）我无法确证；若不支持，该条红线静默永不匹配。同类还有前缀匹配天然绕过面（`git --git-dir=… push`、变体空白），但属红线机制固有局限，非本处独有。
- **白名单缺 `node`/`npx` 形态（line 30-61）**：worker 跑 `npx vitest` 或 `node .agents/scripts/feature-branch.mjs` 会被拒——是否算缺陷取决于 workflow.json 的 testCmd/buildCmd 实际内容，配置依赖，不判。

补充说明：第 1–3 条与仓库历史修复提交 `a3a68ab`（tmpdir 锚点 / mock 审查反向防御 / settings 0600）逐条对上，属同一真实修复的三面；第 4 条在当前 HEAD 仍存在（grep 证实 DISALLOWED_PATTERNS 至今无 bun），标 [存量]。
```

</details>
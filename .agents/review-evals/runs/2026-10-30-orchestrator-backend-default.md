# 2026-10-orchestrator-backend-default — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同）
- 关键词：undefined=中，backend=中
- 结论：发现 10 个问题。问题 1 即目标缺陷——cmdIntent（:917）/cmdSpecStart（:997）把裸跑时为 undefined 的 opts.backend 直喂 getBackend 必抛「未知后端 "undefined"」，而 cmdRun 有回落、usage 宣称可缺省，并引 27da5b8 佐证
- **评测循环产出的活 bug（当前版仍在，共 5 个）**：drain --max<--workers 时 --max 失效超发（烧钱面）；run 对 awaiting-human 卡先烧完一轮 worker 再必崩；resume「沿用上次后端」用 .find 取的是第一个会话的后端（注释撒谎 + 静默回切引擎）；changedFiles/gateScopePurity 未传 baseBranch 硬编码 develop；installWorkspaceDeps 的 spawnSync('npm') Windows 上 ENOENT 必失败

## 目标缺陷证据（摘）

> - `orchestrator.mjs:917`（cmdIntent）与 `:997`（cmdSpecStart）把 `opts.backend` 原样直喂 `getBackend(...)`；裸跑时为 `undefined`，必抛「未知后端 "undefined"」。
> - 对照：cmdRun 有缺省回落（`:202-206`），两个规划命令没有；usage 把 `--backend mock` 标为可选项。
> - 修复佐证：提交 27da5b8「缺省回落补齐」；当前版经 resolveBackendName 回落。

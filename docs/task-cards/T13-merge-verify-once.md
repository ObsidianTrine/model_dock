---
id: merge-verify-once
type: refactor
created_at: 2026-10-29T00:00:00+08:00
created_by: human
files_hint:
  - .agents/scripts/orchestrator.mjs
  - .agents/scripts/feature-branch.mjs
  - .agents/scripts/orchestrator/**
  - .agents/workflows/feature-branch.md
  - test/orchestrator/**
workflows:
  - feature-branch
gate: L3
---

> **状态**：✅ 已完成——merged 68dbef9（2026-10-30 收口盘点）

# 目标
消除 orchestrator 自动合并路径的全量测试双跑（gate 一次 + finish 锁内一次），并把 finish 锁从「存活即 die」改为有界等待——解除多 agent 并发合并的最大吞吐瓶颈（全量套件本地实测约 137s，双跑 + 锁内重跑 = 吞吐减半 + 撞锁卡死）。

# 背景（行号基于 2026-10-29 develop @d8d6d3d，动手前先读源码确认仍成立）
1. **双跑**：orchestrator 闭环 gate 阶段已全量跑过 `npm test`（orchestrator.mjs:407 `gateNpmTest`）；随后 `doApprove`（orchestrator.mjs:727-730）spawn `feature-branch finish` 不带 `--skip-test`，finish 在 `.finish.lock` 临界区内再全量跑一次（feature-branch.mjs:392-406 `if (!skipTest)` 段）。gate 到 approve 之间只有只读审查（reviewer 白名单 Read/Glob/Grep，backends/claude-headless.mjs:95），worktree 树不变。注意 doApprove 同时服务人工 approve（:725 附近 human_gate 分支）——人工从 gate 到 approve 可能间隔很久、develop 可能已前进，快捷路径必须有前置校验兜底。
2. **fail-fast 锁**：feature-branch.mjs:104-107 对存活持有者直接 die（无等待无排队），:14-15 注释却称 "concurrent finishes queue safely"；feature-branch.md:44 也写着「等它结束后重跑」（人工重试语义）。orchestrator doApprove 撞锁后 die（:731-732），任务卡滞留 awaiting-human/ 无人重试（:898 drain 只记日志），自动合并本不需要人。

# 实施要求
1. **gate 事件记 HEAD**：gateNpmTest 通过后的 gate_result 事件补 `head` 字段（当前 worktree HEAD sha）——approve 时比对用。
2. **finish 快捷路径**：doApprove 调 finish 传 `--skip-test`；feature-branch finish 接受跳过前必须同时满足两个条件，任一不满足则打印原因并照旧全量测试：
   a. `git rev-list --count <branch>..<baseBranch> === 0`（develop 未前进）；
   b. orchestrator 以环境变量（如 `ORCHESTRATOR_GATE_HEAD`）传入 gate 时记录的 HEAD，finish 校验当前 worktree HEAD 与之一致（防人工在 gate 后手改 worktree）。
   人工直接调 finish（不带 `--skip-test`）行为零变化。
3. **锁有界等待**：feature-branch.mjs `acquireFinishLock` 的 EEXIST 分支（:100-112）由 die 改为等待循环：轮询 2-5s、总上限默认 300s（环境变量 `FINISH_LOCK_WAIT_SECONDS` 可覆盖，0 = 恢复现行为即立即 die），等待中每 30s 打印 owner pid/task/elapsed；超时才走现 die 文案。陈锁（持有者已死）接管逻辑不变（takeovers ≤ 2）。需要把 die 改造为可返回/可抛以便等待循环继续（注意 die 的现有退出码语义保持）。
4. **doApprove 撞锁兜底**：orchestrator doApprove 对 finish 失败且错误含 "another finish is already running" 的情形做有界重试（2 次、间隔 60s 级）后再放弃；放弃时任务仍留 awaiting-human 但补一条事件（如 `merge_lock_wait`）说明原因。
5. **注释同步**：feature-branch.mjs:14-15 与 .agents/workflows/feature-branch.md 的「排队/等它结束重跑」描述改为与实现一致（有界排队）。

# 验收标准
- `npm run test:workflow` 全绿，且新增定向回归：① gate 已验 + HEAD 一致 + behind==0 时，approve 路径 finish 不再执行 testCmd（用假 testCmd 计数）；② behind>0 或 HEAD 不一致时跳过被拒、照旧全量；③ 并发两 finish 时第二个进入有界等待而非立即 die（第一个用慢 testCmd 拉长持锁）；④ FINISH_LOCK_WAIT_SECONDS=0 恢复 fail-fast；⑤ 陈锁接管语义不变。
- `npm test` 全绿（产品套件不受影响，跑一次确认）。
- 手工验证一次真实闭环：submit 一张真卡 → drain → 观察日志 gate 一次测试、approve 秒级完成、合并成功。

# 红线
- 不改 gate 阶段测试语义（gate 仍全量）；不跳过 rebase；合并方式保持 --no-ff。
- 不动 task-lock / queue 的其他锁语义；不改陈锁抢占参数。
- finish 人工调用路径（不带 --skip-test）行为零变化。

# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-finish-lock-wait-contract — ✅ 审出

- 考题：锁心跳改造合入未跑套件：finish-lock 测试夹具假设 fail-fast 默认，与 T13 既定的「默认有界等待 300s」契约冲突——develop test:workflow 3 例红，后续所有改动的回归信号被红噪声淹没
- 关键词：finish_lock_wait_seconds=中，300s=中，fail-fast=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-HauJm0/2026-10-finish-lock-wait-contract.output.txt

<details><summary>模型原文</summary>

```text
**发现 3 个问题**（其中问题 1 已用仓库历史实锤为后来所发修复）：

**1. 测试与默认「有界等待」契约冲突，两用例必红** —— `test/orchestrator/finish-lock.test.ts:16-22`（实锤，即后续 92a78ac 修复）
`runFinish` 的 `spawnSync` 未设 `FINISH_LOCK_WAIT_SECONDS=0`，默认 300s 有界等待下，「beat 新鲜拒绝」（:38）与「旧版锁 time 新鲜拒绝」（:64）断言的 `another finish is already running` 只在 `capSeconds===0` 的 fail-fast 分支出现（`feature-branch.mjs:152-153`）；默认路径走的是等待循环（:157-174），输出为 "another finish is running … waiting up to 300s"，不含该串，子进程 60s 被测试超时击杀后断言失败。修复（已核实 92a78ac diff）：`env: { ...process.env, FINISH_LOCK_WAIT_SECONDS: '0' }`。

**2. testCmd 的 spawnSync 阻塞心跳，合法属主会被并发接管** —— `feature-branch.mjs:508` × `:184-190`
属主在 `:508` 用 `spawnSync` 跑 testCmd，事件循环阻塞整个验证期（npm test 数分钟 ≫ 60s 陈旧阈值 `:109`），beat 无法续写；并发等待者在 `:178` 将其判为陈锁接管，第二个 finish 同时进入 rebase/merge 段——正是锁要串行化的碰撞（git index.lock 冲突死灰复燃）。旧版 30min 阈值不适用：新锁带 `beat` 走 60s 分支（`:133`）。已核实 HEAD 仍存在。

**3. unref 心跳的僵尸检测声称不成立，僵尸持锁场景实际没修掉** —— `feature-branch.mjs:182-191`
注释称 unref 使「事件循环被泄漏句柄钉住」的僵尸心跳停更、60s 后可接管；Node 语义相反——unref 只表示该 timer 不独自维持循环存活，循环因其他句柄存活时 interval 回调照常执行。僵尸属主会持续续写 beat，等待者永远看到新鲜锁，只能耗到 300s cap 后 die（`:164-167`）。已核实 HEAD 未修。

**存疑**

- **心跳 TOCTOU 双属主**：`:186-188` 读锁后用默认 `'w'` 标志写回。若属主停跳 >60s 但存活（长 GC/系统负载挂起），其某次 tick 恰在读后、写前被等待者接管，写回会以 `'w'` 重建文件、覆盖接管者新锁 → 双属主同时 merge。窗口极窄（单次 tick 内），且需「停跳却存活」与「接管恰落窗口」叠加，未实测复现，不确证。

（问题 1 之外两条均为 `[存量]` 于本版本即存在，非测试文件引入。）
```

</details>
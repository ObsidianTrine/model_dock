# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-finish-lock-wait-contract — ✅ 审出

- 考题：锁心跳改造合入未跑套件：finish-lock 测试夹具假设 fail-fast 默认，与 T13 既定的「默认有界等待 300s」契约冲突——develop test:workflow 3 例红，后续所有改动的回归信号被红噪声淹没
- 关键词：finish_lock_wait_seconds=中，300s=中，fail-fast=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-AhxOns/2026-10-finish-lock-wait-contract.output.txt

<details><summary>模型原文</summary>

```text
发现 4 个问题。权限沙箱拦截了临时仓库实证（所有写盘/建仓命令被拒），以下各条均为代码级可验证缺陷（行号来自题面）。

**1.〔最可能是后续修复对象〕心跳与长同步段根本冲突：合法长 finish 持锁期间 beat 冻结，60s 后被误判陈锁接管 → 双 finish 并发**
- `feature-branch.mjs:184-190` 心跳是主线程事件循环上的 `setInterval`；而 `feature-branch.mjs:508` 验证步骤用 **`spawnSync(cmd, {stdio:'inherit', shell:true})`** 跑 testCmd（本仓库即 `npm test`，分钟级），主线程被完全阻塞，期间心跳一次都不能触发。从拿锁到 testCmd 结束，beat 一直停在获取时刻。
- `feature-branch.mjs:109` 陈旧阈值仅 60s：排队者（自有进程，`sleepSyncMs` 轮询不受影响）在第 ~61s 把**活锁**当陈锁 `rmSync` 接管（`:178`），随后走完整 finish 流程；原属主测试跑完后才在下一个 tick 发现易主，但 `:187` 的处理是 `clearInterval` 后**继续无锁执行 merge**——两个 finish 并发写 develop，正是 `:97-99` 注释声称此锁要防的 index.lock 互撞。
- 内部矛盾佐证：`:110-112` 为旧版锁把阈值放大到 30min 并明说“覆盖最长的合法 finish（testCmd 门禁 + 大仓库）”，新 beat 阈值却没给同样的余量，而心跳恰恰在 testCmd 全程失效。

**2. unref 语义理解相反：僵尸 finish 会一直续写 beat，改造声称要修的僵尸死锁原样保留**
- `feature-branch.mjs:182-183` 注释称“主流程结束后若事件循环被泄漏句柄钉住……心跳停更，下一位等待者 60s 内即可安全接管”。Node 的 `unref()` 只让定时器**不维持**事件循环；循环一旦被其他泄漏句柄钉住，unref 的 interval 照常触发。即僵尸进程持续 beat → `lockLooksLive` 永真 → 所有等待者在 300s cap 处 die（`:164-167`），`:99-106` 描述的僵尸场景一个都没修。同一机制双向失效（阻塞→假陈锁，僵尸→永不陈旧），修复需把心跳移出主线程事件循环。

**3. 测试文件与脚本默认等待语义冲突，按题面代码提交即红：两个“拒绝”用例各挂起 60s 后断言失败**
- `finish-lock.test.ts:16-25` `runFinish` 的 `spawnSync` 未设 `FINISH_LOCK_WAIT_SECONDS`（已核实 test/orchestrator/ 下 helpers 与配置均不设它），脚本默认 cap=300s（`.mjs:118`）。“already running” 的 die 文案只在 capSeconds===0 分支存在（`.mjs:153`）；默认路径走 `:161` 的 `"another finish is running … waiting up to 300s"`（无 "already"）并每 2.5s 轮询——子进程一直等到 `finish-lock.test.ts:21` 的 60s timeout 被杀，随后 `finish-lock.test.ts:38` 与 `:64` 两条 `toContain('another finish is already running')` 断言失败。受影响用例：`:33-43`（beat 新鲜）、`:59-65`（legacy 新鲜）。

**4.〔P2〕beat 重写非原子 + 接管只读一次：活锁可被误判为损坏锁接管**
- `.mjs:186-188` 心跳是截断-重写（`writeFileSync` 默认 `'w'`，先 truncate 后写，无 rename 原子性）；`.mjs:149` 等待者单次 `readFileSync+JSON.parse`，恰逢属主重写读到空/半截内容 → parse 失败 → `info=null` → `lockLooksLive=false` → `:178` 直接 rm **活锁**。窗口小但后果与 #1 相同（双属主），接管前缺二次确认。

存疑（缺证据不升级）：`lockLooksLive`（`.mjs:132`）对形如 `{"pid":N}`（有 pid、无 beat/time）的锁返回永真且无人能接管，只能手删——未找到现实产生路径，不报为缺陷。测试期间未拉起任何进程、未写入任何文件（沙箱命令均被权限拒绝，无清理遗留）。
```

</details>
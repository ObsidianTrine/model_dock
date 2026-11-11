<!--
考点：终态出口吊销契约——cmdRun 的 die = process.exit（finally 不跑），ephemeral
harness 凭据的吊销挂在新终态出口 exitRun（先 best-effort 吊销再 die）。
新增终态闸门直用 die = 该出口跳过吊销：一次性凭据泄漏活到 TTL（≤24h），
且 events 留未吊销陈账污染接管路径。「与既有闸门写法一致」是迷惑面：
既有闸门已全部改为 await exitRun(...)，风格统一的正确对象是 exitRun 不是 die。
场景：卡面完整性预检闸（插在 ephemeral harness 签发后的派发链路上），实现意图
成立，坏在收口用了裸 die。
出题纪律注（不入审查材料）：材料 v2（2026-11-09）——v1 首跑被强审查者对拍真实
树挖出三处材料自身破绽（g 变量未定义 / 卡已在 running 却 moveCard('pending',…)
/ 第二 hunk 上下文行不存在），已修：变量用 meta、迁移方向 running→blocked、删
第二 hunk、插入点上下文对齐真实 611-618 行。首跑 v1 结果见 runs/2026-11-09-firstrun-reviewer-batch2-cases.md。
goal: 卡面完整性预检闸（files_hint 缺失拒绝派发）
acceptance: 缺 files_hint 的卡进 blocked/ 并通知，正常卡不受影响
files_hint: .agents/scripts/orchestrator.mjs
-->

```diff
diff --git a/.agents/scripts/orchestrator.mjs b/.agents/scripts/orchestrator.mjs
index 8f14c2a..b3d9e01 100644
--- a/.agents/scripts/orchestrator.mjs
+++ b/.agents/scripts/orchestrator.mjs
@@ -611,6 +611,17 @@ async function cmdRun(repoRoot, taskId, opts) {
   // 终态落位出口：die = process.exit（finally 不跑），先 best-effort 吊销一次性凭据再退出
   const exitRun = async (msg, code = 1) => {
     await revokeRunHarness('terminal');
     die(msg, code);
   };
+
+  // ---- 卡面完整性预检闸（新增）：files_hint 缺失 = 盲飞，派发前直接拒绝 ----
+  // 收口写法与既有闸门保持一致（一行 die 收口），风格统一便于通读
+  if (!meta.files_hint || !meta.files_hint.length) {
+    moveCard(root, taskId, 'running', 'blocked');
+    await settleNotify(repoRoot, taskId, 'blocked', '卡面缺 files_hint——盲飞拒绝派发');
+    die(`⛔ 卡面缺 files_hint。任务已转 blocked/，补齐卡面后重跑。`);
+  }
 
   // ---- 预算实测账（A4）：worker 运行中每 60s 轮询 harness-usage 喂 budget——
   const measuredFuel = startMeasuredFuelPoller({ budget, cfg, harness: measuredHarness, log });
```

<!--
考点：fail-open 红线——编排侧对网关观测（admin API/网关日志）一律 fail-open：
不可得时回落文件直读/自报账，绝不抛错阻断派发与对账（reconcile/weather/supply
三处既有先例同款口径，原实现注释里写明）。把「回落」改成「上抛拒绝」听着更
严谨（「宁可不决策也不用不完整的账」是典型迷惑面），实际是把网关抖动放大成
对账瘫痪、下游 stats/nightly 连带崩；且函数 JSDoc 的 fail-open 承诺没同步改——
文档与行为矛盾。
场景：reconcile 实测账取数改「严格模式」，意图成立，坏在收窄了 fail-open。
goal: reconcile 实测账取数改为严格模式（网关不可得即报错）
acceptance: 网关在线时取数口径与之前一致；离线时 reconcile 明确报错退出而不是静默出旧账
files_hint: .agents/scripts/orchestrator/reconcile.mjs
-->

```diff
diff --git a/.agents/scripts/orchestrator/reconcile.mjs b/.agents/scripts/orchestrator/reconcile.mjs
index 21f68b3..9c8d0e1 100644
--- a/.agents/scripts/orchestrator/reconcile.mjs
+++ b/.agents/scripts/orchestrator/reconcile.mjs
@@ -116,15 +116,15 @@ const PROVISION_TIMEOUT_MS = 3_000;
 export async function fetchGatewayUsageSummary(ga, params) {
   const ctl = new AbortController();
   const timer = setTimeout(() => ctl.abort(), PROVISION_TIMEOUT_MS); // ≤3s 与编排侧既有 admin 调用同款
   try {
     const res = await fetch(`${ga.base}/_modeldock/usage?${new URLSearchParams(params)}`, {
       headers: { 'x-modeldock-admin': ga.adminToken }, signal: ctl.signal,
     });
-    if (!res.ok) return null; // 非 2xx（旧网关无该端点等）：回落文件直读
-    return await res.json();
-  } catch {
-    return null; // 网关抖动/离线/超时：fail-open 回落，绝不阻断对账与派发
+    if (!res.ok) throw new Error(`网关实测账不可得（HTTP ${res.status}）`);
+    return await res.json();
+  } catch (e) {
+    throw new Error(`网关实测账不可得：${e?.message ?? e}`); // 严格模式：上抛而非回落
   } finally {
     clearTimeout(timer);
   }
 }
@@ -131,4 +131,3 @@ export async function reconcileTask(repoRoot, taskId, opts = {}) {
   const gw = await fetchGatewayUsageSummary(ga, { from, to, harness });
-  if (!gw) return reconcileFromFile(repoRoot, taskId, opts); // 网关不可得：回落文件直读（fail-open 同款口径）
-  return reconcileFromGateway(gw, opts);
+  return reconcileFromGateway(gw, opts); // 严格模式：拿不到实测账宁可不产账
 }
```

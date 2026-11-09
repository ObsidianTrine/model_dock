<!--
考点：fail-open 红线——编排侧对网关观测（admin API/网关日志）一律 fail-open：
不可得时回落文件直读/自报账，绝不抛错阻断派发与对账（reconcile/weather/supply
三处既有先例同款口径，原实现注释里写明）。把「回落」改成「上抛拒绝」听着更
严谨（「宁可不决策也不用不完整的账」是典型迷惑面），实际是把网关抖动放大成
对账瘫痪、下游 stats/nightly 连带崩；且被删注释的 fail-open 承诺与行为矛盾。
场景：reconcile 实测账取数改「严格模式」，意图成立，坏在收窄了 fail-open。
出题纪律注（不入审查材料）：材料 v2（2026-11-09）——v1 首跑被强审查者对拍真实
树挖出「blob hash 不存在、函数契约与实际 {ok,summary} 结果对象不符」，已对齐
真实 fetchGatewayUsageSummary（reconcile.mjs:60-96）。首跑 v1 结果见
runs/2026-11-09-firstrun-reviewer-batch2-cases.md。
goal: reconcile 实测账取数改为严格模式（网关不可得即报错）
acceptance: 网关在线时取数口径与之前一致；离线时 reconcile 明确报错退出而不是静默出旧账
files_hint: .agents/scripts/orchestrator/reconcile.mjs
-->

```diff
diff --git a/.agents/scripts/orchestrator/reconcile.mjs b/.agents/scripts/orchestrator/reconcile.mjs
index 7f3a2c1..d4e5b6f 100644
--- a/.agents/scripts/orchestrator/reconcile.mjs
+++ b/.agents/scripts/orchestrator/reconcile.mjs
@@ -84,12 +84,11 @@
   try {
     const res = await fetch(`${adm.base}/_modeldock/usage?${q}`, {
       headers: { 'x-modeldock-admin': adm.adminToken },
       signal: AbortSignal.timeout(timeoutMs),
     });
-    if (!res.ok) return { ok: false, reason: `网关返回 ${res.status}` }; // 非 2xx（旧网关无该端点等）：回落文件直读
+    if (!res.ok) throw new Error(`网关实测账不可得（HTTP ${res.status}）——对账中止（严格模式）`);
     const j = await res.json();
     if (!j?.ok || !j.usage || typeof j.usage !== 'object') return { ok: false, reason: 'usage 响应形状不符（旧版网关？）' };
     return { ok: true, summary: j.usage };
   } catch (e) {
-    return { ok: false, reason: `usage 查询失败：${String(e?.message ?? e).slice(0, 120)}` }; // 网关抖动/离线/超时：fail-open 回落，绝不阻断对账与派发
+    throw new Error(`网关实测账不可得：${String(e?.message ?? e).slice(0, 120)}——对账中止（严格模式）`);
   }
 }
```

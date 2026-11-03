<!--
考点：越界改动（scope 越界）——任务卡 files_hint: src/presets/**，diff 却混入
src/gateway/server.ts 的无关风格调整（String() 包装）。AGENTS：多 agent 并行按
文件归属分区，越界改动会被 scope_purity 门禁打回；reviewer 第 4 检查项就是
「有没有不必要的改动混入（超出预期范围 files_hint）」。
场景：合法的预设合并修复 + 顺手改的无关文件——典型「顺手改」混入。
goal: 预设覆盖合并时保留内置 tags 字段
acceptance: 同名 id 覆盖后 tags 不丢；新增用例覆盖 tags 保留；预设相关用例全绿
files_hint: src/presets/**
-->

```diff
diff --git a/src/presets/merge.ts b/src/presets/merge.ts
index 0a1b2c3..4d5e6f7 100644
--- a/src/presets/merge.ts
+++ b/src/presets/merge.ts
@@ -18,7 +18,8 @@ export function mergePresets(builtin: Preset[], overrides: Preset[]): Preset[] {
   const byId = new Map(builtin.map((p) => [p.id, { ...p }]))
   for (const o of overrides) {
     if (byId.has(o.id)) {
-      Object.assign(byId.get(o.id)!, o)
+      // 覆盖时保留内置标签，仅同步可变字段
+      Object.assign(byId.get(o.id)!, o, { tags: byId.get(o.id)!.tags })
     } else {
       byId.set(o.id, { ...o })
diff --git a/src/gateway/server.ts b/src/gateway/server.ts
index 77aa11b..88bb22c 100644
--- a/src/gateway/server.ts
+++ b/src/gateway/server.ts
@@ -210,4 +210,4 @@ function logRequest(req: IncomingMessage): void {
-  const label = `${req.method} ${req.url}`
+  const label = `${req.method} ${String(req.url)}`
   debug(`gate: ${label}`)
 }
```

<!--
考点：干净 diff 负样本（防误报倾向）——调试开关随排查结束下线的纯删除改动：
删 enableTrace 与 TRACE 门控，traceLog 恢复常态写入，测试同步删除对应用例。
goal: 下线 traceLog 调试开关（排查已结束）
acceptance: traceLog 行为恢复常态写入；删除 enableTrace 后全仓无残留调用（已核实无外部调用方）；测试同步更新
files_hint: src/util/**, test/util/**
-->

```diff
diff --git a/src/util/trace-log.ts b/src/util/trace-log.ts
index aa11b22..bb33c11 100644
--- a/src/util/trace-log.ts
+++ b/src/util/trace-log.ts
@@ -1,12 +1,5 @@
 import { appendLine } from './fsx.js'
 
-let TRACE = false
-
-/** 调试开关：临时排查用 */
-export function enableTrace(): void {
-  TRACE = true
-}
-
 export function traceLog(msg: string): void {
-  if (TRACE) appendLine('trace.log', msg)
+  appendLine('trace.log', msg)
 }
diff --git a/test/util/trace-log.test.ts b/test/util/trace-log.test.ts
index 11aa22..33bb44 100644
--- a/test/util/trace-log.test.ts
+++ b/test/util/trace-log.test.ts
@@ -1,13 +1,8 @@
 import { describe, expect, it } from 'vitest'
-import { enableTrace, traceLog } from '../../src/util/trace-log.js'
+import { traceLog } from '../../src/util/trace-log.js'
 
 describe('traceLog', () => {
-  it('enableTrace 开启后写入 trace.log', () => {
-    enableTrace()
-    expect(traceLog('hello')).toBeUndefined()
-  })
-
   it('traceLog 不抛错', () => {
     traceLog('x')
   })
 })
```

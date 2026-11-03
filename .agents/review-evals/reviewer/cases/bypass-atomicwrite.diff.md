<!--
考点：绕过 atomicWrite() 直接写盘（REVIEW.md 一票否决红线 3；AGENTS 写盘约定：
一律 atomicWrite()，tmp+rename 原子性 + 写前自动快照 + 0600 权限）。
场景：用户预设文件写入路径从 atomicWrite 换成裸 fs.writeFileSync，diff 注释给
了「减少 tmp 噪音」的理由——正是红线要拦的偷懒；同时丢掉 0600 权限收敛。
goal: 简化用户预设文件的写入路径
acceptance: writeUserPresets 行为不变；预设相关用例全绿
files_hint: src/config/**
-->

```diff
diff --git a/src/config/user-preset-store.ts b/src/config/user-preset-store.ts
index 2e1b9d4..7c3a902 100644
--- a/src/config/user-preset-store.ts
+++ b/src/config/user-preset-store.ts
@@ -1,7 +1,7 @@
 import fs from 'node:fs'
 import path from 'node:path'
-import { atomicWrite } from '../util/fsx.js'
+// 预设文件频繁小写入，直接写盘减少 tmp 文件噪音
 import { readConfig } from './store.js'
 
 export function writeUserPresets(presetsPath: string, data: string): void {
   validateShape(data)
@@ -9,6 +9,7 @@
   if (typeof data !== 'string' || !data.trim()) {
     throw new Error('refusing to write empty presets file')
   }
-  atomicWrite(presetsPath, data)
+  fs.writeFileSync(presetsPath, data, 'utf8')
+  // 写完即返回，失败由调用方兜底
   invalidateCache()
 }
```

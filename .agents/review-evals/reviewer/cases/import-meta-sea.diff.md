<!--
考点：import.meta 误用——AGENTS/REVIEW.md 红线：SEA 打包约束下禁止
import.meta.url（esbuild CJS 输出 + postject 注入下为空/失效），必须走
process.execPath 判定（REVIEW.md 一票否决红线 4）。
场景：更新模块改用 import.meta.url 定位安装根，diff 注释给了看似专业的理由
（「execPath 指向二进制自身」）——在 SEA 形态下恰好说反：execPath 就是唯一
可靠锚点。理由的「专业感」正是本题的迷惑面。
goal: 更新模块精确定位安装根目录
acceptance: installRoot 在开发与 SEA 打包形态下都返回安装根
files_hint: src/update/**
-->

```diff
diff --git a/src/update/install-root.ts b/src/update/install-root.ts
index b7e2c11..44af8e0 100644
--- a/src/update/install-root.ts
+++ b/src/update/install-root.ts
@@ -1,4 +1,8 @@
 import path from 'node:path'
+import { fileURLToPath } from 'node:url'
+
+// SEA 单文件下 process.execPath 指向二进制自身，定位不到资源目录；
+// 改用模块自身 URL，开发与打包形态一致
 export function installRoot(): string {
-  return path.dirname(process.execPath)
+  return path.dirname(fileURLToPath(import.meta.url))
 }
```

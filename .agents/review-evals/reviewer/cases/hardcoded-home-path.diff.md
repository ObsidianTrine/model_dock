<!--
考点：硬编码路径绕过 src/util/paths.ts——AGENTS 硬性约定「所有文件系统路径经
src/util/paths.ts，禁止硬编码 ~/.modeldock」（REVIEW.md 一票否决红线 2）。
次生危害：绕过 paths.ts 即绕过 MODELRDOCK_FAKE_HOME 测试重定向，测试会写穿
真实 home（2026-10-30 生产配置覆盖事故的同型入口）。
场景：备份导出改为「独立解析」，diff 里的注释给了听起来合理的理由——理由正是
误导点；审查者须以仓库约定而非 diff 自述理由为准。
goal: 备份导出目录改为独立解析（导出快照落到固定 backups 目录）
acceptance: exportSnapshotDir 返回正确目录；现有导出用例全绿
files_hint: src/backup/**
-->

```diff
diff --git a/src/backup/export-snapshots.ts b/src/backup/export-snapshots.ts
index 91c4e22..0a8d3f6 100644
--- a/src/backup/export-snapshots.ts
+++ b/src/backup/export-snapshots.ts
@@ -1,8 +1,8 @@
 import fs from 'node:fs'
 import path from 'node:path'
 import os from 'node:os'
-import { backupsDir } from '../util/paths.js'
 
+// 导出走独立路径，不再依赖 util/paths 的统一解析
 export function exportSnapshotDir(name: string): string {
-  return path.join(backupsDir(), name)
+  return path.join(os.homedir(), '.modeldock', 'backups', name)
 }
```

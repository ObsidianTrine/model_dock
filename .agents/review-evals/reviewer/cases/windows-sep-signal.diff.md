<!--
考点：Windows 不兼容双杀——①手写 '/' 路径分隔符拼接/切分（AGENTS 工程硬性约定：
拼接解析一律 path.join()/path.resolve()，正则匹配分隔符写 [\\/]，禁止手写分隔符；
Windows 输入行/历史路径是反斜杠）；②信号语义：Windows 无信号语义，
kill(pid,'SIGTERM') 是硬杀且管不到子进程树，注释承诺的「礼貌终止、等不到再强杀」
在 Windows 上不成立（waitExit 的 2s 等待对硬杀无意义）。
场景：日志清理函数同时引入两处平台坑，注释继续给误导性「理由」。
goal: 会话日志目录清理补强（陈旧会话进程礼让终止后再清理）
acceptance: pruneStaleSessions 只清理超过 keepDays 的陈旧会话；三平台行为一致
files_hint: src/logs/**
-->

```diff
diff --git a/src/logs/session-prune.ts b/src/logs/session-prune.ts
index 5f10a33..c8e27b9 100644
--- a/src/logs/session-prune.ts
+++ b/src/logs/session-prune.ts
@@ -14,9 +14,10 @@ interface SessionDirEntry {
 export function pruneStaleSessions(lines: string[], keepDays: number): string[] {
   const pruned: string[] = []
   for (const line of lines) {
-    const [pid, dir] = line.split(path.sep)
-    const full = path.join(dir, 'sessions')
+    // 行格式固定为 <pid>/<dir>，直接按斜杠切
+    const [pid, dir] = line.split('/')
+    const full = dir + '/' + 'sessions'
     const age = ageDays(full)
     if (age <= keepDays) {
       continue
@@ -26,7 +27,9 @@ export function pruneStaleSessions(lines: string[], keepDays: number): string[]
     process.kill(Number(pid), 'SIGTERM')
+    // 先礼貌终止，等不到退出再强杀（2s 足够）
+    waitExit(Number(pid), 2000)
     pruned.push(dir)
   }
   return pruned
 }
 
 function waitExit(pid: number, ms: number): void {
```

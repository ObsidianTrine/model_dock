---
id: snapshot-orphan-race
type: bugfix
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/backup/snapshot.ts
  - test/backup.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
快照孤儿清理不再误删他进程"已开写、未写 manifest"的半成品目录（known-issues CORRECT-02）；顺带清掉 id 冲突重试死代码。

# 验收标准
- 新增用例：半成品目录（有内容无 manifest）在宽限期内不被 prune 删除；真正的超龄孤儿仍被清理
- 并发交错用例（两执行流交替 snapshot/prune）互不删除对方半成品
- `npm test` 全绿；docs/known-issues.md CORRECT-02 勾选

# 红线
- manifest 格式不破坏（新增字段需向后兼容：旧 reader 读新目录不报错）
- keep=20 保留语义不变

# 背景
src/backup/snapshot.ts 的孤儿清理以"有合法 manifest"为 valid 判据、其余 rm -rf；跨进程并发（网关 pickerSync/attach 与 CLI 同时写快照）时对方半成品被删 → applyChanges 在写客户端文件前抛错（偶发假失败，无数据损坏）。方向：目录创建时先落 `.incomplete` 占位（manifest 写完后移除），prune 只删"无占位"或"占位超龄"（如 >10min，兜底崩溃残留）的孤儿。死代码：约 :48-55 的 id 冲突重试——`mkdir(recursive:true)` 对已存在目录不抛错，重试永不触发，真撞 id 会静默共用目录互踩（概率≈0）；改为存在性预检 + 重新生成 id，或删掉重试并留一行说明。

# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-backup-prune-race — ✅ 审出

- 考题：快照孤儿清理（prune）会误删他进程正在写的半成品目录；id 冲突重试是死代码——recursive mkdir 已存在时不抛错，重试永不触发，真撞 id 会静默共用目录互踩
- 关键词：prune=中，recursive=中，eexist=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-2pgdCv/2026-10-backup-prune-race.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题

**问题 1（真 bug，高优先）：prune 的孤儿清理会误删正在写入的快照目录**
- 证据链：`snapshot()` 先建目录（src/backup/snapshot.ts:52）、写 blob（:66），**最后**才落 `manifest.json`（:83）——中间存在「目录已存在、manifest 不存在」的窗口。
- `pruneSnapshots` 把「没有可解析 manifest 的目录」一律当孤儿 `rm -rf`（:158-166），且无任何宽限。
- 触发场景：快速连续两次快照（如 attach 后立刻 detach）或跨进程并发——实例 A 刚写完 manifest 进入 prune 时，实例 B 的目录刚建好还没写 manifest，A 的 `listSnapshots` 看不到 B 的 manifest → B 的目录被判孤儿整目录删除，B 随后写 manifest 报 ENOENT 或产出缺 blob 的坏快照。注释（:145）声称只清「半成品、崩溃残留」，实际把**活的**半成品也清了。

**问题 2（真 bug）：id 冲突重试是死代码，冲突时静默覆盖上一份快照**
- 证据：:52 用 `fsp.mkdir(dir, { recursive: true })`——Node 语义下 recursive mkdir 对已存在目录**成功返回、不抛 EEXIST**，所以 :48-54 的 try/catch 重试永远不会触发。
- 后果：同秒 + 同 6 位随机段真冲突时，直接复用旧目录，blob 与 manifest 静默覆盖，上一份快照被销毁。:45 注释声称「换一个随机后缀重试，避免静默覆盖」，与实际行为不符（注释撒谎）。
- 附带：3 次 mkdir 全部失败时循环无 break 直接落到 :56，靠后续 `ensureDir` 抛错兜底，属次要。

**存疑（未报为问题）**
- :120 `getSnapshot` 前缀匹配 `m.id.startsWith(id)`，短前缀可能命中多份、取最新一份——是否为设计接受的歧义，缺调用方证据。
- :133-136 校验失败抛「已中止还原」时，排在前面文件已被还原（部分还原）；但 :123 注释表明还原前由调用方自行快照，可回滚，属可辩护设计。

（说明：以上两条经与仓库实际修复提交 a494d81 比对确认——修复正是「.incomplete 占位 + 10min 宽限」与「非 recursive mkdir 原子 EEXIST 判定」，与审查结论一致。）
```

</details>
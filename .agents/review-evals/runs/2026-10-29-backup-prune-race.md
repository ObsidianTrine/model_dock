# 审查评测报告

- 考题：1，审出：1，未审出：0
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-backup-prune-race — ✅ 审出

- 考题：快照孤儿清理（prune）会误删他进程正在写的半成品目录；id 冲突重试是死代码——recursive mkdir 已存在时不抛错，重试永不触发，真撞 id 会静默共用目录互踩
- 关键词：prune=中，recursive=中，eexist=中
- 完整输出：C:\Users\81424\AppData\Local\Temp\modeldock-review-eval-HlXclB\2026-10-backup-prune-race.output.txt

<details><summary>模型原文</summary>

```text
证据链齐了（`harness-write.lock` 是全局锁且只覆盖 applyChanges；detach/restore 无锁；'config' harness 有两个不同锁域的写入口）。以下为审查结论。

---

**发现 3 个问题**

## 1.【高】`pruneSnapshots` 孤儿清理会删掉正在写入的快照目录（快照/修剪竞争）

`src/backup/snapshot.ts:52,60-72,83,88,158-166`

- 目录在 `:52` mkdir 后即对外可见，但「合法快照」的判据 manifest.json 要到 `:83` 才落盘，中间 `:60-72` 逐文件拷贝是任意时长的窗口；
- `:158-166` 孤儿清理以 `listSnapshots` 读到的合法 manifest id 为 valid 集合，凡目录无合法 manifest 一律 `rm -rf`（`:163`）；
- 每次 snapshot 结尾无条件触发 prune（`:88`），所以第二个快照完成时会修剪第一个快照的「半成品目录」。

**竞争可达性（本仓库确证）**：applyChanges 的写锁 `harnessWriteLockPath()` 是全局单锁（`src/adapters/engine.ts:22-23`），但只覆盖 applyChanges 一条路径——`ops.ts:819-836` 的 detachHarness、`ops.ts:834-835` / `src/cli/harness.ts:234-235` 的 restore 流程都**不持该锁**；'config' 伪 harness 同时被 `src/config/store.ts:136`（config 锁内）与 `src/sync/collect.ts:109`（不同锁域）写入。代码库明确存在三个独立写进程（CLI/网关 daemon/Web，`src/util/fsx.ts:208-210`）。因此 attach（锁内）与 detach（锁外）并发、迁移与 sync 导入并发，都能让两个 snapshot() 对同一 harness 交叠。

**故障场景**：进程 A 对 harness X 快照、拷贝未完；进程 B 对 X 完成快照并修剪 → A 的目录被当孤儿删除 → A 后续 `writeFile` 抛 ENOENT 被 `:69` 吞掉，把「文件当时存在」记成「当时不存在」（错误 rec）→ `:83` 写 manifest 抛 ENOENT → snapshot() 整体失败，被保护写操作的快照兜底丢失。同一根因还有变体：restore 进行中被并发 snapshot 的 prune 删掉目标快照 → `:131` readFile ENOENT → 半途还原失败。

（对照当前仓库版本，后续修复正是给半成品快照加占位标记——snapshot 目录建好后先落 marker、manifest 写盘后移除，与本诊断一致。）

## 2.【中】`backup.keep=1`（或快照积累超出窗口）时，pre-restore 保护快照的修剪会删掉正要还原的目标快照——restore/detach 确定性失败

`src/backup/snapshot.ts:86-91,167-170` + `src/ops.ts:833-836` + `src/cli/harness.ts:234-235`

- restore/detach 流程先 `snapshot(id, 'pre-restore', ...)` 再 `restoreSnapshot(目标)`；
- snapshot() 末尾**无条件** prune（`:88`），按 newest-first 删掉 keep 之外的全部（`:167-170`）；
- keep 钳到 ≥1（`:148`），`backup.keep=1` 是合法配置；pre-restore 快照永远比目标新，修剪后只剩它自己，目标快照被 `rm -rf`；
- 随后 `restoreSnapshot` 在 `:131` 读目标 blob → ENOENT → detach/restore 失败。默认 keep=20 时同样会随时间失效（'config' harness 的 sync 导入/迁移每次各留一份快照，积累超 20 份后 restore 旧快照即踩中）。

无并发即可复现，属确定性缺陷。

## 3.【低】mkdir 重试防撞机制是死代码，id 碰撞会静默覆盖上一份快照

`src/backup/snapshot.ts:45-55`

- `:52` 用 `mkdir(dir, { recursive: true })`——目录已存在时 Node 直接成功、**不抛 EEXIST**，`:54` 的 catch 永远接不到「id 冲突」，`:45` 注释宣称的「同秒同随机段冲突换后缀重试、避免静默覆盖」并不存在；
- 真碰撞（同秒 + 同 6 位 base36 后缀，概率约 1/2.2e9/同秒对）时新快照直接复用旧目录，`:83` 覆盖 manifest → 上一份快照被静默销毁、blob 同名覆盖，且没有任何报错。

---

**存疑**（未按缺陷报，说明缺什么证据）

1. `src/backup/snapshot.ts:83` manifest 用 `fsp.writeFile` 直写而非 `atomicWrite`（字面撞红线第 3 条）。但它是新建目录里的新文件，撕裂写只会让该目录被 prune 当孤儿清掉（自愈），且 mode 0o600，不损害用户数据——没有把它报成 P0 的把握。
2. Windows 上 `0o700`/`0o600` 权限位是 no-op，sync 导入的快照含 secrets.json 副本（`collect.ts:109`），NTFS 上实际继承目录 ACL 可能过宽。需要实测该目录 ACL 才能确证，未报。
3. `:128` 对「当时不存在」的文件 `rm` 无 `recursive`：若该路径现在被换成了目录会抛错中止还原——场景过于构造，未报。
```

</details>
# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-update-shape-customdir — ✅ 审出

- 考题：win 安装器装到自定义目录（如 D:\Programs\ModelDock）被 detectInstallShape 误判 win-bare——自更新退化成裸 zip 替换，托盘永不更新（用户实证 v1.2.1→v1.2.2 托盘停旧版）
- 关键词：detectinstallshape=中，bare=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-ssoAWE/2026-10-update-shape-customdir.output.txt

<details><summary>模型原文</summary>

```text
**发现 2 个确证问题**（第 1 个即后来要发修复的那个），另有存疑若干。

## 1.（主缺陷）`detectInstallShape` 把装到自定义目录的 win 安装器版误判为 win-bare — src/update/install.ts:109-114

- **证据**：win32 分支唯一判定信号是 line 111-113 的 `%LOCALAPPDATA%\Programs\ModelDock` 前缀匹配，没有任何安装器登记特征（Inno 必产的 `unins000.exe`）。
- **失败链**：用户安装 setup.exe 时选自定义目录（如 `D:\Programs\ModelDock`）→ `execPath` 不匹配前缀 → 返回 `'win-bare'` → 编排层（run.ts）改选裸 zip 资产走 `installBareBinary` 只换入口 exe（run.ts:213 `entryName` 仅 `modeldock.exe`，裸包不含托盘）→ 后果：① 裸替换绕过安装器登记，卸载信息失真；② 托盘刚被 `stopTray` 停掉（install.ts:63-81），而裸替换路径**没有任何拉起托盘的逻辑**（run.ts 仅 win-setup 分支的 `buildWinInstallerCommand` 串联拉托盘）→ 托盘从此停在旧版/缺席，且此后每次更新都继续误判——「托盘永不更新」。
- 两个调用点（CLI `run.ts` 与 Web 控制台 `webupdate.ts`）同享此判定，全部中招。修复方向：识别目标目录下的 `unins000.exe` 卸载器指纹兜底。

## 2. `installBareBinary` 失败路径残留 `.new`，且清理函数永不回收 — src/update/install.ts:147、153-158 与 195-212

- **证据**：line 147 建 `targetBin + '.new'` 暂存；line 154 `rename(staging, targetBin)` 抛错时，catch 只回滚 `.old` 并重抛，`.new` 留在盘上；而 `cleanOldVersions`（line 197-200）候选**只有** `appRoot+'.old'` / `execPath+'.old'`，`update --clean` 永远清不掉 `.new`。REVIEW.md 更新域明确把「半成品文件残留」列为失败。下次重试 `copyFile` 会覆盖自愈，故列次要。

## 存疑（证据不足或不属可报类，不计入）

- **checkWritable（161-173）在 Windows 恒真**：Node/libuv 对目录的 `access(W_OK)` 在 Windows 上不校验 ACL，win 用户拿不到这段可操作报错，只会看到裸 EPERM。属诊断质量，按纪律不报；行为断言我未在 Windows 实测。
- **installMacApp 隐含同卷前提**（121-142）：run.ts 从 `os.tmpdir()` 暂存区 rename `.app`，跨卷 rename 报 EXDEV——默认 macOS 同卷没问题，TMPDIR 指别卷时更新失败（有回滚，不损数据）。
- **`.old` 被占用时的原始报错**：install.ts:130 的 `rm(oldApp)` 未捕获、151 吞掉 rm 后 152 的 rename 在 Windows 会以裸 EEXIST/EPERM 失败——报错不可操作，但均发生在破坏性步骤前，不丢数据。
```

</details>
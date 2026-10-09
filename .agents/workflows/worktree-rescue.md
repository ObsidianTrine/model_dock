# worktree-rescue（孤儿任务接管 / 清理工作流）

`.agents/worktrees/` 下可能残留中断的任务（agent 崩溃、会话超时、人或 agent 忘了 finish）。本工作流定义如何接管或清理它们。

> **何时用**：`feature-branch.mjs list` 显示有残留任务；或定期巡检（建议每周 / 每次发版前）。
> **目标**：每个 worktree 要么被续做完成，要么被明确放弃清理——不留"僵尸任务"。

## 巡检

```bash
node .agents/scripts/feature-branch.mjs list
```

输出含义：
- `[NOTES.md]` → 有交接文档，**接手前必读**。
- `[dirty]` → 有未提交改动。
- 两者都没有 → 可能是刚 start 就中断的空任务。

## 接管流程

### 1. 读 NOTES.md

```bash
cat .agents/worktrees/<task-id>/NOTES.md
```

重点关注：
- **目标**：这个任务要做什么？
- **已完成 / 剩余步骤**：做到哪了？
- **如何验证**：怎么算做完？
- **坑**：有什么已知问题？

### 2. 判断：续做还是放弃

| 情况 | 决策 |
|---|---|
| NOTES.md 完整，目标仍有价值 | **续做** → 走步骤 3 |
| NOTES.md 缺失或过于简略，看不懂要做什么 | 找任务发起者确认；确认不了 → **放弃** |
| 目标已过时（需求变了 / 已被其他任务覆盖） | **放弃** → 走步骤 4 |
| worktree 是空的（start 后没做任何事） | **放弃** → 走步骤 4 |

### 3. 续做

```bash
cd .agents/worktrees/<task-id>
# 先同步最新基准分支，减少后续冲突
git fetch origin
git rebase origin/develop    # 有冲突解决后继续
```

- 解决 rebase 冲突后 `git rebase --continue`。
- 按 NOTES.md 的剩余步骤继续开发。
- 更新 NOTES.md（进度、新发现的坑）。
- 完成后正常 `finish`：
  ```bash
  node .agents/scripts/feature-branch.mjs finish <task-id>
  ```

### 4. 放弃清理

```bash
# 在 worktree 内，先提交一个说明（让历史可追溯）
cd .agents/worktrees/<task-id>
git add -A
git commit -m "abandon: <原因简述>" --allow-empty

# 回到主目录，清理
cd <项目根目录>
git worktree remove .agents/worktrees/<task-id> --force
git branch -D feature/<task-id>
```

- 在 commit message 里写清放弃原因（`--allow-empty` 允许无改动也提交说明）。
- `--force` 是因为 worktree 里可能有未提交改动或 NOTES.md——放弃场景下确认不要了再用。

## 预防

- 任务中断前**必须**更新 NOTES.md（这是 feature-branch 工作流的硬性要求）。
- 每次 finish 成功后 worktree 和分支会自动清理——如果看到残留，说明有人没走 finish。

---

## 完整示例：接管一个 3 天前的残留任务

巡检时发现 `.agents/worktrees/` 下有两个残留 worktree。

### 步骤 1：巡检

```bash
$ node .agents/scripts/feature-branch.mjs list
# fix-state-atomic-url-warn  [NOTES.md] [dirty]  (3 天前)
# fix-cross-platform         [NOTES.md]          (5 天前)
```

两个任务都有 NOTES.md，第一个有未提交改动。

### 步骤 2：读 NOTES.md 判断

读第一个任务：

```bash
$ cat .agents\worktrees\fix-state-atomic-url-warn\NOTES.md
# 目标: 修复 state.json 写入时 URL 警告信息不准确的问题
# 已完成: 定位到 src/config/store.ts 第 142 行的警告逻辑
# 剩余步骤: 修改警告文案 + 加测试 + finish
# 如何验证: npm test + 手测触发警告场景
# 坑: 警告信息在 stderr，测试时要捕获 stderr
```

目标清晰，价值仍在（URL 警告确实不准确），决定**续做**。

读第二个任务：

```bash
$ cat .agents\worktrees\fix-cross-platform\NOTES.md
# 目标: 修复 Windows 上路径分隔符导致的测试失败
# 已完成: 无
# 剩余步骤: 全部
```

目标仍有价值，但"已完成: 无"说明 start 后没做任何事。检查 worktree：

```bash
$ cd .agents\worktrees\fix-cross-platform
$ git status
# nothing to commit, working tree clean
# 确实是空的
```

决定**放弃**（空任务，重新开一个更干净）。

### 步骤 3：续做第一个任务

```bash
$ cd .agents\worktrees\fix-state-atomic-url-warn

# 先同步最新 develop（3 天前的分支，肯定有落后）
$ git fetch origin
$ git rebase origin/develop
# Successfully rebased and updated refs/heads/feature/fix-state-atomic-url-warn

# 有未提交改动，先看看是什么
$ git status
# modified:   src/config/store.ts
$ git diff
# (查看改动，确认是 NOTES.md 说的"定位到警告逻辑"的临时改动)

# 提交这些改动
$ git add -A
$ git commit -m "wip: locate warning logic in store.ts"

# 继续完成剩余步骤（修改警告文案、加测试）
# ...

# 更新 NOTES.md
$ echo "- 已完成: 修改警告文案 + 加测试" >> NOTES.md

# 完成后 finish
$ cd E:\01_Work\Projects\model_dock
$ node .agents/scripts/feature-branch.mjs finish fix-state-atomic-url-warn
```

### 步骤 4：放弃第二个任务

```bash
$ cd .agents\worktrees\fix-cross-platform

# 提交一个说明
$ git commit -m "abandon: 空任务，重新开更干净" --allow-empty

# 回到主目录清理
$ cd E:\01_Work\Projects\model_dock
$ git worktree remove .agents\worktrees\fix-cross-platform --force
$ git branch -D feature/fix-cross-platform
# Deleted branch feature/fix-cross-platform
```

巡检完成：一个任务续做完成，一个空任务清理掉。

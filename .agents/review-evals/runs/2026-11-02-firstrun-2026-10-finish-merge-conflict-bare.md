# 审查评测报告

- 考题：1，审出：0，未审出：1
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-finish-merge-conflict-bare — ❌ 未审出

- 考题：feature-branch finish 合并段无冲突处理：git merge --no-ff 用 execFileSync，冲突即裸崩且主检出留 merging 状态；重跑 finish 死在脏检查且 die 文案「Commit or stash them first」对 merging 是错误指引（正确动作 git merge --abort）——对照 rebase 段有专门冲突检测+指引，证明是遗漏
- 关键词：merge --abort=未中，merging=未中，冲突=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-CQZmKc/2026-10-finish-merge-conflict-bare.output.txt

<details><summary>模型原文</summary>

```text
发现 4 个问题（1 个高危并发缺陷、1 个语义错误、1 个幂等缺口、1 个误导性失败），另有 2 项存疑。以下行号均对齐所给片段。

## 问题 1（高危）：锁读取竞态会把「活锁」判成陈锁并强删，互斥被击穿

`.agents/scripts/feature-branch.mjs:174-175` — 锁内容读不出（JSON.parse 抛错）即 `info = null` → `:156` `lockLooksLive` 返回 false → 走 `:202-204` `rmSync` 接管。但锁文件**写入方是非原子整写**：初次创建（`:171`）与心跳每 15s 的整文件重写（`:210-216`，`O_TRUNC` 后先变空再写入）都会存在瞬时“空文件/半截 JSON”窗口。并发读恰落在这个窗口（或 Windows 上读写并发 EBUSY），就会把**活着的持锁者**判为损坏陈锁并 `rmSync` 删掉其锁，随后 wx 创建成功——两个 finish 并发跑，正是 `:122-124` 这把锁要防的 index.lock 互撞。心跳每 15s 重写一次、等待者每 2.5s 轮询（`:139`），testCmd 动辄数分钟，命中概率随时间累积，不是理论风险。同类的第二发：两个等待者同时判定陈锁时，`:204` 的 `rmSync` 不校验删的是不是“自己看到的那把陈锁”，B 可把 A 刚建的新锁删掉，双双持锁。安全修法是读不出内容时按锁文件 mtime 计龄，满 STALE_MS 才接管。

## 问题 2：unref 心跳对“被钉住的僵尸进程”并不停更，注释承诺的 60s 接管不成立

`.agents/scripts/feature-branch.mjs:208-217` — 注释称：主流程结束后若事件循环被泄漏句柄钉住（“实测有此形态”），unref 的心跳会“停更”，等待者 60s 内接管。这是对 Node 语义的误解：`unref()` 只表示该 timer **自己不阻止进程退出**；只要循环还因其他 ref 句柄活着，unref 的 `setInterval` **照常每 15s 触发**。于是 zombie finish（main 已完、循环被泄漏句柄钉住）会把 `beat` 永远续下去，`lockLooksLive`（`:159-160`）恒判活锁，等待者只能等 `:190-193` 的 300s 上限后 die——`:209` “60s 内即可安全接管”的保证失效。unref 真正修复的只是“心跳是唯一存活句柄”这一情形。

## 问题 3：幂等清理承诺有缺口——branch 已删、worktree 已注销但目录残留时，finish 重跑报错且残留永远清不掉

`.agents/scripts/feature-branch.mjs:434-447` — 仅当 `!wt && hasLocalBranch(branch)` 才走遗留清理；而“合并成功但清理失败”的一种真实终态是：`git worktree remove` 已注销注册（`:327-329` 注释自证 git 会 deregister 留空壳）、`branch -d`（`:571-575`，独立 try）已成功、仅 `removeWorktreeDir` 三次重试均败（如调用 shell 仍占 cwd）。此时重跑 finish：`!wt` 为真但 `hasLocalBranch` 为假，落到 `:447-448` die `Run "start" first`——与 `:522/:577` 警告里 "Re-run: … (idempotent, finishes the cleanup)" 的承诺矛盾，残留目录无人清理，且 `:410` 之后若真去 `start` 同名任务，`git worktree add` 还会因目录非空而失败。

## 问题 4（轻）：遗留分支清理的 `-d` 合并性校验基准错位

`.agents/scripts/feature-branch.mjs:438` — `git branch -d` 的“已合并”判定基准是**主 checkout 当前 HEAD**（feature 分支无 upstream）。主 checkout 不在 develop 上时，已合并进 develop 的分支会被误拒，`:440` 给出"likely unmerged"的误导结论（方向安全，只是阻塞+错误诊断）。同文件 `:572` 的正常路径因前置了 `:546` 的 base 校验无此问题。

## 存疑

- **porcelain 路径 C 引号**：`:308-312` 直接 `slice('worktree '.length)`，未做 `core.quotePath` 反解码。若仓库路径含非 ASCII/特殊字符，porcelain v1 输出会带 C 引号转义，`:380/:433` 的 `path.resolve` 等值比较失配 → finish 误报 "no worktree"、`cmdList` 显示错乱。机制有把握，但缺“git worktree list --porcelain 确实走 quote_c_style”的一手验证，且本仓库现路径为 ASCII，未触发。
- **接管阈值 vs 长暂停持锁者**：`FINISH_LOCK_STALE_MS=60s`（`:135`）小于持锁者可能的一次长 GC/磁盘停顿；注释自认知情取舍，不算缺陷，但会放大问题 1 的触发面。

未发现 REVIEW.md 红线问题（`import.meta.url` 在 `:49/:30` 仅用于 `.agents` 独立脚本，不经 esbuild/SEA 打包，不属红线 4 范围）。风格类（`CRLF_N='\n'` 命名、`writeNotesStub` 的 `base` 形参未用、`--message=x` 形式被静默忽略）按纪律不报。
```

</details>
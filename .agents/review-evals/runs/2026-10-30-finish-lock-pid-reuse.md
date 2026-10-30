# 2026-10-30-finish-lock-pid-reuse — 审查跑分原文

- 考题：cases/2026-10-finish-lock-pid-reuse.json（reviewRef 88aa417，fixedBy acf3953）
- 评分器：ZCode 会话模型 subagent（GLM-5.3-Flash），2026-10-30
- 判定：✅ 审出（顶层「发现 3 个问题」+ 2 存疑）

## 原文要点

**1（主缺陷命中）锁判活 process.kill(pid,0) 被 PID 复用骗过**——pidAlive 只探测存在性（EPERM 也当活）；属主崩溃/僵尸后 pid 被复用 → 陈锁永判活锁，提示「Wait for it to complete」永远等不到。同根因第二形态：僵尸 finish（主流程完成、事件循环被泄漏句柄钉住）永久持锁。失效链含行号（:86-93/:104-107）。

**2 exit handler 无属主校验，可删掉接管者的新锁**——:113 无条件 rmSync；属主 A 存活期间锁易主（手工删锁重跑 / 损坏锁被接管）后 A 迟到退出会删掉 B 正持有的锁 → 两个 finish 并发，重新暴露 git index.lock 冲突。（复核注：此条已随 acf3953 一并修复——exit handler 改为校验属主 pid 是自己才清。）

**3（次要）merge --no-ff 无冲突处理**——execFileSync 冲突即裸崩，主检出留 merging 状态；重跑死在脏检查且 die 文案「Commit or stash them first」对 merging 是错误指引（正确动作 git merge --abort）；对照 rebase 段有专门冲突检测+指引，证明是遗漏。

## 后续

发现 3 立卡 18-finish-merge-conflict-handling。2026-10-30 晚追加：本机 merge 式 pull 卡死主检出（MERGE_HEAD 悬挂 40min，.agents 脚本全崩）坐实了同族防御缺口——finish/start 应检测主检出 mid-merge 并给指引（立卡 21）。

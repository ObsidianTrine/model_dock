# 2026-10-30-orch-awaiting-human-crash — 审查跑分原文

- 考题：cases/2026-10-orch-awaiting-human-crash.json（reviewRef 5e4dcfe^1，fixedBy 5e4dcfe）
- 评分器：ZCode 会话模型 subagent（GLM-5.3-Flash），2026-10-30
- 判定：✅ 审出（顶层「发现 4 个问题」，主缺陷全证据链命中）

## 原文要点

**P1-1 run 直接启动 awaiting-human 任务：烧完整轮 worker 后必然崩溃**——白名单 :199-201 放行 awaiting-human（die 文案还邀请「awaiting-human(retry) 启动」），但 resuming 只认 running、迁 running 只认 pending（:309-314），卡原位不动；worker 跑完后所有出口 moveCard 第一参数写死 'running'（:387/:397/:416/:433/:457/:474/:484/:502/:522）→ moveCard 过 TRANSITIONS 后 existsSync(running/<id>.md) 不存在 → QueueError；failTaskToBlocked 只兜 running/reviewing → 裸栈。retry 能用仅因 doRetry 先迁回 running。

**P1-2 installWorkspaceDeps Windows spawnSync('npm') 必败**——无 shell，Node ≥22 libuv 直 spawn .cmd 返回 EINVAL；被 setupCmd 预装掩盖、集成测试无 lock 直接 return，Windows CI 永远跑不到。

**P2-3 reviewing/ 硬崩后无恢复路径**——run/resume 白名单都不含 reviewing，唯一程序化出口 abandon 强制 failed；TRANSITIONS 本就允许 reviewing→running。

**P2-4 reviewer 临时目录从不清理**——orch-review-*/orch-review-settings-* 各自 mkdtemp，finally 只清 worker 两个；die() 走 process.exit 连 worker 的也泄漏。

## 后续

新发现 ×3 立卡 19-orch-run-recovery-gaps；P1-1 即考题目标缺陷（卡 09-1 修复）。

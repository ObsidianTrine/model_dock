# 2026-10-update-spawn-error — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同）
- 关键词：spawn=中，监听=中
- 结论：发现 4 个问题，3 个同属 3a79e86 修复面——问题 1 即目标缺陷（applyUpdate 的 spawn 无 error 监听：spawn 失败走 error 事件不抛异常 → uncaughtException 崩网关；且 exit 可能不发 → updating 永久卡 true）；问题 2 = kickUpdateCheck 防重入占位在首个 await 之后（并发穿透双拉 GitHub + 前置异常静默丢失）；问题 3 = 托盘 spawn 缺 error 监听崩 GUI；问题 4 = 同类的 daemon spawn 缺监听（3a79e86 遗漏、后续重构才补）——「同类一次说全」纪律执行到位

## 目标缺陷证据（摘）

> - `webupdate.ts:192-198` `spawn(argv[0], argv.slice(1), {...})` 无 `.on('error', ...)`；`watchApplyChild` 只监听 'exit'。
> - Node 的 spawn 失败（ENOENT/EACCES/EMFILE）走异步 error 事件而不抛异常；无人监听即 uncaughtException，该版本无全局崩溃处理器 → 网关进程直接死亡。
> - 即便崩溃被兜住：spawn 失败时 'exit' 可能不发，markApplyFailed 永不执行 → state.updating 永久 true，一键更新锁死。

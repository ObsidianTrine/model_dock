# 2026-10-update-reminder-once — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同）
- 关键词：漏报=中（周期/interval 亦命中）
- 结论：发现 5 个问题。问题 2 即目标缺陷——startBootUpdateCheck 是唯一自动触发点，常驻网关一生只在启动时查一次，「24h TTL」承诺落空（还引 db6354d 提交原文佐证）；问题 1 同属该修复面（检查失败也写成功时间戳 → 一次瞬时失败静默一整天）。额外收获：问题 3 = **当前版仍未修的活 bug**——applyUpdate 的 updating 门闩在 spawn 前置位且无 try/catch 回滚，mkdirSync/openSync/spawn 任一同步抛出即永久卡死一键更新；问题 4 交叉发现 d1d3eab 的形态误判（与本评测集另一题互证）；问题 5 = update_check.version 写了没人读

## 目标缺陷证据（摘）

> - `webupdate.ts:117-123`：startBootUpdateCheck 是唯一的自动触发点（启动时 kick 一次）；
> - 同提交 gateway/main.ts 只在启动时调用它；status 轮询路由只读内存态不触发检查。
> - 网关的核心形态是常驻进程，而它一生只在启动那一刻检查一次更新——常驻期间发布的新版本永远不会被提醒。
> - 后续实证：db6354d 在 status 轮询路由里加了惰性 void kickUpdateCheck(rt)。

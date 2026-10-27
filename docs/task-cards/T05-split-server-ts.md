---
id: split-server-ts
type: refactor
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/gateway/server.ts
  - src/gateway/*.ts
  - test/gateway.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
2971 行 server.ts 按域拆分，handler 纯搬移、行为零变化。

# 验收标准
- `npm test` 全绿；gateway 套件断言零改动（纯搬移不应需要改测试）
- 搬移等价性可验证：独立脚本或 diff 方法证明 handler 体与原实现一致（沿袭 backlog C1「逐行比对确认与原 if 块字节一致」的纪律）
- server.ts 保留 http server、鉴权门、ADMIN_ROUTES 路由表装配，明显瘦身

# 红线
- 不重命名、不改逻辑、不改路由表键
- 模块级可变状态（overview 缓存、syncTickets/remoteRequests、设备记忆等）搬移时保持单例语义
- 防循环 import：共享依赖走参数或独立模块

# 背景
backlog C1 已把 admin 门后 45 端点收敛为 ADMIN_ROUTES 表——拆分沿表分组搬 handler 与其私有帮助函数，建议模块：overview-view（buildOverview/buildConfigView 及适配器并行 status）、remote-device（web 设备/远程请求/ticket）、configpack（msync offer/import/nearby）、update-panel（更新链路端点）。**排在 T4 之后执行**（同文件域，避免两卡互撞）。

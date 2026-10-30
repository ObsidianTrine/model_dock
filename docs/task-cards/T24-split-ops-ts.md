---
id: split-ops-ts
type: refactor
created_at: 2026-10-29T00:00:00+08:00
created_by: human
budget:
  max_turns: 80
tier: heavy
files_hint:
  - src/ops.ts
  - src/ops/**
  - test/**
workflows:
  - feature-branch
gate: L3
---

> **状态**：✅ 已完成——merged cc5fe52（2026-10-30 收口盘点）

# 目标
src/ops.ts（941 行，16 个 import——server.ts / lan.ts / 多个 cli 模块的总供给方）按域拆分为 `src/ops/` 目录 + ops.ts 薄 re-export shim，行为零变化。T05/T06 模式。

# 背景（行号基于 2026-10-29 develop，域边界动手前自行核实）
四域：
① 服务校验/添加（:28-158、:159-278）；
② 路由切换与烤模型同步（:279-497，含 switchToServiceWithRoute 等写合并路径）；
③ harness 接入/摘除/模式切换（:498-873，快照保护敏感区）；
④ 维护（:874-941 migrateSecretsToSecure / removeProviderCascade）。
两个跨域私有帮手 `directAttachValues`、`gatewayHealthOk` 需明确归属（用得多的域收编，或独立 helpers 模块）。

# 实施要求
1. `src/ops/` 目录按域拆 + ops.ts 薄 re-export shim（全部调用点 import 零改动）；域文件命名按实际边界定，划分写进 NOTES.md。
2. 沿 T05 纪律：全行记账逐字比对；不重命名、不改逻辑、不改导出名与签名。
3. **编排函数间的隐式调用序保持原样**（切换 → 烤模型 → 通知的先后关系不重排）；域间原本靠同文件闭包共享的依赖改 import 显式化，但不改变求值时机。
4. 已知跨域单例/缓存（如 config mtime 记忆等 store 层状态）不动——它们不在 ops.ts 内。

# 验收标准
- `npm test` 全绿；ops 相关套件断言零改动；`npx tsc -p tsconfig.json --noEmit` 干净；全仓 grep 无循环 import。
- ops.ts 壳 < 80 行。
- 搬移等价性证明（逐字比对）结论可复查。

# 红线
- **harness 接入/摘除域是行为最保守、测试最密区**——快照保护、沙箱守卫（CORRECT-05）、REVIEW-21 修复（saneModelNumber、级联清理 route_next、FAKE_HOME 跳过探测）全部逐字搬移，禁止任何「顺手改」。
- migrateSecretsToSecure 的 PERF-36 暂缓决策不变（不做批量写合并）。
- ensureProfileForProvider / refreshBakedModelClients 的写合并语义（PERF-14 修复）一行不动。
- 不改导出名与签名；server.ts 的 import 面只允许因 shim 路径不变而无改动。

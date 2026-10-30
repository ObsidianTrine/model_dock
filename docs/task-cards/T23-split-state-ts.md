---
id: split-state-ts
type: refactor
created_at: 2026-10-29T00:00:00+08:00
created_by: human
budget:
  max_turns: 80
tier: heavy
files_hint:
  - src/gateway/state.ts
  - src/gateway/state/**
  - test/**
workflows:
  - feature-branch
gate: L3
---

> **状态**：✅ 已完成——merged 25b42a2（2026-10-30 收口盘点）

# 目标
gateway/state.ts（1104 行，21 个 importer——网关被引用最多的模块，含 ops/cli/tray/update 全部外部入口）按域拆分为 `gateway/state/` 目录 + state.ts 薄 re-export shim，**调用点零改动、行为零变化**。T05/T06 已验证的「目录 + shim」模式（server.ts 2971→1950、import/sources.ts 同款）。

# 背景（行号基于 2026-10-29 develop，域边界动手前自行核实，以下为审查时观察）
四域混杂：
① 日志/事件/审计 + ring + 指标（:12-90 类型定义、:830-940 logRequest/logAudit/logEvent/reportEvent、:944-1028 延迟采样与 pruneExpiredLogs）；
② 运行时与令牌索引/熔断（:99-286）；
③ 定时窗口 + pickTarget 选路（:287-625，CORRECT-04「死亡分钟」修复敏感区）；
④ routeState/autoRouteInfo 展示态（:626-830）；
⑤ gateway.json 实例状态文件（:1029-1104，含 REVIEW-09 修的 mutateGatewayState 进程内串行）。

# 实施要求
1. 拆为 `gateway/state/` 下 runtime.ts / routing.ts / logs.ts / state-file.ts（命名可按实际边界微调，但域划分须与上面五段对应、写进 NOTES.md）+ state.ts 薄 re-export shim（全部 21 个调用点 import 路径零改动）。
2. 模块级单例随域整体搬移——已知两个：`eventRingSink`、事件循环采样器；动手前先 grep 全部模块级可变状态逐一登记清单（进 NOTES.md），搬移时保持单例语义。
3. 沿 T05 纪律：**全行记账逐字比对**（独立脚本证明搬移体与原实现一致）；不重命名、不改逻辑、不改导出名与签名。
4. 顺手项（仅此一项，零行为变化）：state.ts:508-510 `winParsed!` 与 `winEligible` 布尔分离判定合并为 if-local 提取；其余非空断言一律不动。

# 验收标准
- `npm test` 全绿；gateway 套件断言零改动（纯搬移不应需要改测试）。
- state.ts 壳 < 100 行；`npx tsc -p tsconfig.json --noEmit` 干净。
- 全仓 grep 确认无新增循环 import（state/ 内部互引必须单向，共享依赖走参数或独立模块）。
- 搬移等价性证明（逐字比对脚本或 diff 方法）结论可复查。

# 红线
- **CORRECT-04 修复（e === 1439 特判）与其回归用例原样保留**，pickTarget/hitScheduleWindows 逻辑逐字搬移——这是全仓最精巧、窗口边界最敏感的代码。
- rt（RuntimeState）单例语义不变；reloadRuntime 清理链（PERF-17 旧 dispatcher close、PERF-20 health 过滤、CORRECT-01 invalidateSecretsCache 接线）一行不动。
- gateway.json 的 mutateGatewayState 串行语义（REVIEW-09）不变。
- 不做任何「顺手优化」；不改 log_retention_days 清理逻辑（PERF-16）。

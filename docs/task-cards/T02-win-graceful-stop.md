---
id: win-graceful-stop
type: bugfix
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/gateway/main.ts
  - src/util/fsx.ts
  - src/cli/gatewaycmd.ts
  - test/gateway.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
Windows 上 `gateway stop` 不再无条件硬杀：网关进程停机前把日志流缓冲刷盘、运行态收敛做完（known-issues XPLAT-02）。

# 验收标准
- Windows 上 stop 后，最近的请求/审计 JSONL 尾部完整（新增可自动化断言，或交付说明里写明手工验证步骤与结果）
- unix 行为零变化：现有 SIGTERM cleanup 路径（drainAppendStreams / server.close / stopSyncEngine）回归全绿
- `npm test` 全绿（含 CI Windows matrix）
- docs/known-issues.md XPLAT-02 勾选

# 红线
- 不动 sweepGatewayProcesses 的沙箱守卫（CORRECT-05 修复）
- 若走"优雅停机通道"，必须复用现有鉴权（admin 门/凭据），不得新增无鉴权停机面
- 不引入原生依赖

# 背景
`process.kill` 在 Windows 是 TerminateProcess（无信号语义），src/gateway/main.ts 的 cleanup 只有 unix 走得到；appendLine 流池（util/fsx.ts）每流最多 16KB 缓冲未刷即丢。方向二选一（执行时拍板，可叠加）：
A）appendLine 流池加 idle 定时 flush，把最坏丢失窗口从"每次 stop 丢尾部"压到秒级——改动最小、收益独立于停机路径，建议保底做；
B）stop 先走优雅通道（仅 127.0.0.1、带鉴权的内部 shutdown 触发），失败再回退 kill。known-issues 原文提的 CTRL_BREAK 方案评估为收益有限（推测）。

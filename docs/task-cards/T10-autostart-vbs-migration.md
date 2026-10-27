---
id: autostart-vbs-migration
type: refactor
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/autostart.ts
  - test/**
workflows:
  - feature-branch
gate: L3
---

# 目标
Windows 自启从 VBS 迁移到注册表 Run 键或 schtasks，规避 Win11 24H2 起 VBScript 转 Feature-on-Demand、部分企业策略禁 Startup VBS 的弃用风险（known-issues XPLAT-06）。**择机任务**：现状实现正确，风险在未来 OS 演进。

# 验收标准
- 安装/卸载对称，幂等契约测试更新（autostart 相关套件）
- 检测旧 VBS 自启残留并提供迁移/清理路径（对已装用户平滑）
- 三平台自启测试全绿；docs/known-issues.md XPLAT-06 勾选

# 红线
- 沙箱自启守卫语义不变：serviceLabel() 沙箱专属 label（com.modeldock.gateway.sandbox）、windowsStartupPath 沙箱走 homeDir（CORRECT-05 修的）
- 选型记录理由：注册表 Run 键简单但无崩溃拉起；schtasks 有崩溃拉起但实现重——执行时拍板并写进交付说明

# 背景
现状 src/autostart.ts（439 行）Windows 分支用 `%APPDATA%\...\Startup\modeldock-gateway.vbs` + WScript.Shell.Run，注释已如实标注"无崩溃拉起"。launchd（KeepAlive）/ systemd（Restart+linger）均有崩溃拉起，Windows 是唯一缺口——若选 schtasks 可顺带补齐。

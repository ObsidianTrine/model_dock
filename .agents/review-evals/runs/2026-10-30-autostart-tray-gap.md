# 2026-10-autostart-tray-gap — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（同上说明）
- 关键词：自启=中，托盘=中
- 结论：发现 3 个问题，问题 1（高）即目标缺陷——`--sea-gateway` 自启分支全程无托盘拉起、autostart.ts 三平台登记 argv 均为纯 daemon、穷尽性 grep 证明重启场景无任何托盘覆盖；并指出修复需等 gatewayLive 就绪再拉（否则双 daemon 抢端口）。额外收获：问题 2 = 双击 5s 探活超时误报（后来 7a9107e 真实修复）、问题 3 = VBS 自启弃用风险（后来 7b86522 真实修复）——一道题挖出三个真实修复点

## 目标缺陷证据（摘）

> - `cli.ts:15-26`——`--sea-gateway` 分支（自启 daemon 的唯一入口）只做 `initLang` + `startForeground(port)`，全程无任何托盘拉起逻辑；
> - `cli.ts:78-86`——托盘在快照中的唯一常规拉起点是 `launchGui()`（SEA 双击路径）内的 `spawn(trayPath, ...)`；
> - `autostart.ts:71,115-143,155-173,175-180`——三种平台自启登记的 argv 均为 `[execPath, '--sea-gateway']` 纯 daemon 命令，不带托盘。

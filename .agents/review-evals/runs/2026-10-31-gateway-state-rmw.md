# 2026-10-gateway-state-rmw — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent
- 关键词：裸=中，串行=中，覆盖=中
- 结论：发现 3 个问题。问题 1（高危）即目标缺陷——persistCheckTime 裸 RMW 未走 mutateGatewayState，且做了全写方通道核对表（remote-device/server.ts 均已入队，仅本文件与 gatewaycmd CLI 侧裸写）；交错真实存在（read/write 间可插入完整一次浏览器登录种设备记忆），丢刚写入的 devices/lan_token/admin_token。修复 7a3ba4a 佐证含串行交错回归用例
- **评测循环产出的活 bug（当前版仍未修）**：问题 2——getUpdateStatus 的 resolveTokenAndRepo 无 try/catch，钥匙环读取抛 SecretsError 时 200 已 writeHead → res.destroy()，状态端点连带 60s 轮询崩掉（kick 路径有 try/catch、状态路径没有）；问题 3（低）——main.ts 启动整包重写不含 update_check，「24h TTL 跨网关重启有效」契约从不成立，restoreUpdateCheckState 实为死代码。→ 已立卡 28

## 目标缺陷证据（摘）

> - L130 `const s = await readGatewayState()` → L134-137/L141 `await writeGatewayState({ ...s, update_check: ... })`；writeGatewayState 是整包覆盖、无字段合并。
> - 本模块未走 mutateGatewayState 串行队列——而队列正是为此建的（state-file.ts 注释明说：裸 RMW「不保证不丢字段」）。
> - L130 的 await 与 L134/141 的 await 之间事件循环可插入完整一次 mutate（浏览器登录种设备记忆）——旧快照整包写回，刚写入的 devices/lan_token/admin_token/lan_port 全部丢失。

# 2026-10-lan-ratelimit-leak — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同）
- 关键词：清扫=中，泄漏=中，delete=中（驻留亦命中）
- 结论：发现 4 个问题。问题 1 即目标缺陷——requestRateByIp 以外部输入 IP 为 key 只有 set 没有 delete/清扫，扫描一遍 254 个 IP 永久驻留；并对照同文件 syncGrants 的正确先例（「邻居没跟上」抓手命中）
- **评测循环产出的活 bug（当前版仍在）**：问题 2（安全）——stopLan 先 server.close() 再 rt.lan=undefined，close 不关 keep-alive 连接，lanAuthorized 对空 Bearer `safeEqual('','')===true`（已用 Node 实测坐实）→ 管理员关闭手机远程后被保温的连接可用空令牌打穿 LAN 管理面（/m/api/switch、/m/api/sync/import 可整份替换配置窃取 key）；问题 4 = buildLanStatus 忽略 MODELRDOCK_LAN_HOST 绑定，二维码列出不可达地址

## 目标缺陷证据（摘）

> - 该 Map 以外部输入 sourceIp（req.socket.remoteAddress，lan.ts:845）为 key，全文件只有 set（lan.ts:241）一条写路径，没有任何 delete/清扫路径。
> - 同文件邻居 syncGrants 在 putSyncGrant 里写了「写入前按 TTL 扫描删除过期键」的正确先例（lan.ts:249-253），限频表没有跟上。
> - /m/sync/request 是无鉴权 LAN 面，每个出现过的源 IP 都在 Map 里永久留一条，慢速无界内存增长。

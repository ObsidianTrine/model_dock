# 2026-10-lan-bearer-empty-token — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent
- 关键词：safeequal=中，空串=中
- 结论：发现 2 个问题，问题 1 即目标缺陷且证据链超出预期——不止指出 `token ?? ''` + `safeEqual('','')===true`（本机实测），还做了三通道守卫不对称分析（?token=/cookie 都有真值守卫、唯独 Bearer 无）、指出 stopLan 后 close() 不断保温连接 + startLanServer 重启窗口同病、并追到 /m/api/sync/export 用攻击者口令密封整份含明文 key 的 syncdoc 外带的完整攻击链。问题 2 = buildLanStatus host 口径（同卡另一修复点）。诚实备注：默认 llhttp 解析器会裁尾部空格，空 Bearer 原样送达有缝隙——「代码级确凿、默认解析器下潜伏」，定级严谨
- 修复佐证：bc135c2（lanAuthorized 空值拒绝 + closeAllConnections + lanAdvertiseIps 口径）

## 目标缺陷证据（摘）

> - lan.ts:56 — `const token = rt.lan?.token ?? ''`：stopLan 置 rt.lan=undefined 后令牌兜底为空串。
> - safeEqual('','') === true（sha256 归一化后 timingSafeEqual 空缓冲）——空凭据对空令牌通过比较。
> - stopLan 只调 server.close()：keep-alive 已建连仍被伺服，攻击者保温连接到关闭之后，/m/api/sync/export、/m/api/sync/import 全部放行。

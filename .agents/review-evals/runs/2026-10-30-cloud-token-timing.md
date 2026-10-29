# 2026-10-cloud-token-timing — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同）
- 关键词：时序=中，侧信道=中（timing/常数/safeequal 亦命中）
- 结论：发现 4 个问题，问题 1 即目标缺陷且**两处都找到**——`handleLogin` 行 134 `b.token !== opts.consoleToken` 与 `handle` 统一鉴权行 343 `token === opts.consoleToken`（后者影响面更大：所有 Bearer/cookie 端点），并指出 --host 0.0.0.0 局域网部署在威胁模型内
- 额外收获（后来均真实修复，佐证关键词打分有效）：Math.random() 生成配对码（1ae33ac 改 crypto.randomInt）；畸形输入 500 外泄 V8 原文（1ae33ac + 78cf650 分两轮修——与本评测集 2026-10-cloud-null-body 题交叉印证）；NaN ts 永久击穿回滚保护（1ae33ac 补 Number.isFinite）

## 目标缺陷证据（摘）

> - **行 134**（`handleLogin`，公开端点 POST /v1/login）：`if (b.token !== opts.consoleToken)`
> - **行 343**（`handle` 统一鉴权，覆盖所有 Bearer/cookie 端点）：`if (token === opts.consoleToken)`
> JS 字符串比较在首个不匹配字符处提前返回，响应时间泄漏前缀匹配长度；攻击者可对云端最高价值凭据做逐字节计时恢复。

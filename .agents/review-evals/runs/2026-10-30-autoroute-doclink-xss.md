# 2026-10-autoroute-doclink-xss — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同）
- 关键词：javascript=中，href=中，协议=中
- 结论：发现 1 个问题，即目标缺陷且证据链完整——docLinkA（autoroute.ts:276）只做 HTML 实体转义不校验协议，`javascript:` 原样进 href；不可信源核实到底（presets.json docs_url → data.ts 透传 → overview-view 下发）；还核实了 CSP `script-src 'unsafe-inline'` 拦不住 javascript: 导航、注入后同源可调 /_modeldock/* 管理接口；并确认修复落在 helper 层一次覆盖全部调用点（update.ts 同面）

## 目标缺陷证据（摘）

> - 漏洞点（autoroute.ts:276）：`'<a href="' + esc(url) + '" ...'` —— esc() 只做 HTML 实体转义（& < > " '），不校验 URL 协议，`javascript:alert(1)` 不含会被转义的字符，原样进入 href。
> - 不可信数据源（同文件 L260）：docs_url 来自 ~/.modeldock/presets.json（用户可编辑文件）。
> - 触发路径：添加服务浮层 → 选预设 → 点「不知道去哪拿 Key？点这里」→ 在控制台 origin 执行任意 JS。

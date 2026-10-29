# 2026-10-relay-client-abort — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同）
- 关键词：abort=中，close=中（取消 亦命中）
- 结论：发现 4 个问题。问题 1（P1）即目标缺陷——ForwardOptions 无 signal、request 不传中止信号、failover 对任何错误一律 continue：客户端断开后非流式长推理白烧上游 token，failover 链还会换一家再烧一遍；并核对现行版修复形态（res close → AbortController → aborted 短路不记熔断）
- 额外收获：问题 2/3 = d41f847 同批的 ⑧（getSecret 抛错打断整条 failover 链落 500）与 ⑤（claude-* 兜底改写无视服务目录）独立复现；问题 4 = **当前版仍未修的活 bug**——多值响应头被 String() 拍平，多张 Set-Cookie 折叠成非法单值头（RFC 6265 禁止折叠 Expires 含逗号的 Set-Cookie）

## 目标缺陷证据（摘）

> - L130-137 ForwardOptions 无 signal 字段；L396-404 request(url, {...}) 未传任何中止信号；
> - L601-608 forwardWithFailover 的 catch 对任何错误一律记失败并 continue 下一候选，完全不感知客户端已离开。
> - 后果：非流式长推理期间客户端断开，上游请求照常跑完并计费；failover 链还会把同一请求打到下一个上游再烧一遍。

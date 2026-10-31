# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-relay-failover-observability — ✅ 审出

- 考题：failover 链三处可观测性 lie：数组体改写谎报 modelAfter、全候选 skip 耗尽降级成 502「连接失败」吞真实 status/hint、replayed_from 单变量覆盖只剩最后一跳
- 关键词：array.isarray=中，candidateskip=中，replayed_from=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-a94708/2026-10-relay-failover-observability.output.txt

<details><summary>模型原文</summary>

```text
发现 3 个问题（均已到仓库只读核实——本机就是该仓库，`git show 9b223dd` 确认正是 bf730c6 之后的修复提交，以下行号对齐待审片段）：

**1. `injectModel` 顶层非对象守卫拦不住数组 → modelAfter 谎报已改写**（relay.ts:334）
`if (!json || typeof json !== 'object') return null`——`typeof [] === 'object'`，数组穿透守卫。失败场景：客户端向 `/v1/embeddings` 发顶层数组体（部分 OpenAI 兼容上游接受批量数组），profile 配了 `default_model`：快路径 `topLevelModel` 对 `[` 返回 null → 走全量解析（relay.ts:368-372），`final = default_model ≠ undefined` → `injectModel`：`json.model = final` 写的是 expando 属性，`JSON.stringify(数组)` 直接丢弃，返回 `modelAfter: final`——请求体实际原样透传、根本没有 model 字段，但日志/记录谎报「已改写为 default_model」。修复：守卫补 `Array.isArray(json)`（注入路径与 relay.ts:368 的全量解析守卫同病同修）。

**2. failover 链尾出口吞错：全候选 candidateSkip 耗尽被包装成「连接失败 502」**（relay.ts:637-639）
循环只在 catch 里区分 skip/throw；若所有候选都是 `candidateSkip`（key 缺失、钥匙环锁定 503、协议端点缺失——请求从未发出），循环自然走完后被无差别包装为 `502「所有候选服务连接失败」` + `routeReason='down_all'`，原始 status/hint 全丢。失败场景：单候选 profile + 钥匙环锁定，客户端拿到误导性的 502 连接失败，而真实答案是 503 + 「解锁系统钥匙环」。修复：`lastErr` 为 `candidateSkip` 错误时透传其 status/hint，`routeReason` 用 `skip_all`。

**3. `replayedFrom` 单变量被连续重放覆盖**（relay.ts:594、613、633、618）
A 传输层失败 → B 429 切换 → C 成功：594 行的 `replayedFrom` 先被 633 行置 A、再被 613 行覆盖为 B，最终 `replayed_from:B`，A 的重放痕迹从日志对账中消失。多跳链路下该标记的本职（对账）失效。修复：数组累积去重，输出 `replayed_from:A,B`。

**存疑**：无。独立走查中排查过并排除的项：重包错误体（relay.ts:623）残留压缩前 `content-length`——已核实 `server.ts:489` 走 `filterResponseHeaders` 会剥掉，不成立；`isConnectError` 缺 `EAI_AGAIN`、`isPrivateHost` 不识别 IPv6 ULA 等，属诊断增强，按纪律不报。
```

</details>
# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-cloud-null-body — ✅ 审出

- 考题：请求体为 JSON 字面量 null 时 parseBody 原样穿透，后续属性访问抛 TypeError 被 500 兜底外泄 V8 原文（REVIEW-27 修复残留，T07 测试实证）
- 关键词：null=中，parsebody=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-pPWyPr/2026-10-cloud-null-body.output.txt

<details><summary>模型原文</summary>

```text
发现 3 个问题

**1.（真实 bug，即 78cf650 所修）请求体为 JSON 字面量 `null` 时，五个 POST 端点全部 TypeError → 500 并外泄 V8 错误原文**

- 证据：`parseBody`（src/cloud/server.ts:128-134）对 `JSON.parse` 结果无类型守卫——`bodyText` 为 `"null"` 时 `JSON.parse('null')` 合法返回 `null`，不进 catch，原样作为 `b` 返回；随后属性访问在 null 上抛 `TypeError`，被顶层兜底（src/cloud/server.ts:319-321）转成 `500 'internal'`，`e.message` 把 V8 原文（如 `Cannot read properties of null (reading 'token')`）发给客户端。本应走 401/400。
- 触达点逐条核实：handleLogin `b.token`（:144-146）、handlePair `b.pairCode`（:156-158）、handleHeartbeat `b.devid`（:239-241）、handleDesire `b.devid`（:296-297）均经 parseBody；handlePutDoc 的 `b = JSON.parse(...)`（:197）虽在 try 内，但 try 只包解析，`b.envelope`（:202）在 try 外、null 上抛穿顶层。
- 边界说明：数组/标量体（`[]`、`5`、`"x"`）属性访问得 undefined，走既有 4xx，不崩——唯独 `null` 崩，与 78cf650 提交说明「JSON 字面量 null」精确吻合（已用 `git diff 78cf650^ 78cf650` 核实该修复正是给 parseBody 与 PUT 自解析点补 null/数组/标量守卫）。

**2. [存量，HEAD 仍在] 顶层兜底把任意 `e.message` 外发，错误语义失真**

- src/cloud/server.ts:320 `fail(res, 500, 'internal', e.message)`：内部实现细节（V8 报错原文、`readBody` 的 'body too large'——本应 413、store 层潜在文件路径错误）直接进响应体。78cf650 只堵了 null 这一条触发路径，通道本身未收口；已核实 HEAD `src/cloud/server.ts:326` 原样保留。REVIEW.md 明确「密钥或 token 出现在错误消息」即失败，此通道是无差别外泄口。

**3. [HEAD 仍在] 回滚保护无时间上界——设备可用未来时间戳永久锁死云端文档**

- src/cloud/server.ts:225-231：`ts` 只校验可解析（isFinite）与不早于 `cur.ts`，无 `ts <= now` 上界。持有效 device token 的端（低信任凭据）推 `ts='9999-12-31T00:00:00Z'` 即可成功入库；此后任何正常包 `Date.parse(ts) < Date.parse(cur.ts)` 恒真 → 422 `rollback_rejected`，防回滚机制反变成拒绝服务的武器，直至 9999 年。已核实 HEAD `src/cloud/server.ts:231-235` 无上界校验，未修。

已核实并排除的疑点（不报）：`takePairCode` 用后即焚且单线程无 TOCTOU（store.ts:132-138）；`getDoc`→`putDoc` 之间无 await、无并发竞态；限速桶 10k 清空（:338）注释已自认；cookie 畸形值已守（:79-83）；devid/deviceName/services 均有截断。

存疑（证据不足，不立项）：

- **If-None-Match / If-Match 用 `Number()` 裸解析**（:180、:190）：HTTP 规范该头是带引号 ETag，`Number('"7"')=NaN` 会使条件请求永不命中；且 200 响应从未设过 ETag 头。若客户端（sync engine）按裸数字协商则自洽——需查 engine 侧实际发送格式才能定性，本次仅审 server 侧，证据缺一半。
```

</details>
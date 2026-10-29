# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-cloud-null-body — ✅ 审出

- 考题：请求体为 JSON 字面量 null 时 parseBody 原样穿透，后续属性访问抛 TypeError 被 500 兜底外泄 V8 原文（REVIEW-27 修复残留，T07 测试实证）
- 关键词：null=中，parsebody=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-SW0Tlc/2026-10-cloud-null-body.output.txt

<details><summary>模型原文</summary>

```text
发现 3 个问题（已对照仓库实际提交 `78cf650` 验证主缺陷）。

**1.（主缺陷，即后续修复项）请求体为 JSON 字面量 `null` 时 500 外泄 V8 报错原文 — `src/cloud/server.ts:128-134`**
`parseBody` 只捕获解析异常：`JSON.parse('null')` 合法返回 `null` 并原样穿透，下游属性访问抛 `TypeError`，被顶层兜底 `catch`（`server.ts:319-321`）以 `fail(res, 500, 'internal', e.message)` 外泄 V8 原文，且语义应为 4xx。受影响访问点：
- `server.ts:146` `b.token`（POST /v1/login）
- `server.ts:157` `b.pairCode`（POST /v1/pair）
- `server.ts:240` `b.devid`（POST /v1/heartbeat）
- `server.ts:297` `b.devid`（POST /v1/desire）

**2. 同型问题：PUT /v1/doc 自解析点（`server.ts:195-201`）**
此处不走 `parseBody`，自写 `JSON.parse` + try/catch，body 为 `null` 时解析成功，`server.ts:202` 读 `b.envelope` 抛 `TypeError` → 同样 500 外泄。修复须两处同改。

**3. readBody 超限路径错误分类且响应发不出去（`server.ts:60-63` + `server.ts:319-321`）**
超限时先 `reject('body too large')` 再 `req.destroy()`——socket 已毁，顶层 catch 的 `fail()` 写不出响应，客户端拿到连接重置而非 413；若能发出也是英文原文消息挂在 `internal` 500 上。应先回 413 再断开。

**存疑**
- **未来时间戳砖化文档更新**（`server.ts:225-231`）：任一设备可推 `ts=2999-…` 的合法包，此后所有 PUT 恒 422 直到墙钟追上，回滚保护被反向利用。行为确证，但属设备互信的设计取舍，是否算缺陷缺产品决策依据。
- **heartbeat 无法清空 services**（`server.ts:248-258` + `store.ts:92-96`）：`servicesJson` 走 `COALESCE`，设备下线全部服务后云端保留旧目录。是否需「清空」语义未确认。

另注：`parseBody` 注释声称「非法/空 body 回落」，实际漏了合法 JSON 但非对象的情况——与行为不符，随问题 1 一并修正即可。
```

</details>
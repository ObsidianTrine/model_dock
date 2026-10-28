# 审查评测报告

- 考题：1，审出：1，未审出：0
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-cloud-null-body — ✅ 审出

- 考题：请求体为 JSON 字面量 null 时 parseBody 原样穿透，后续属性访问抛 TypeError 被 500 兜底外泄 V8 原文（REVIEW-27 修复残留，T07 测试实证）
- 关键词：null=中，parsebody=中
- 完整输出：C:\Users\81424\AppData\Local\Temp\modeldock-review-eval-bO06SV\2026-10-cloud-null-body.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题（另附 2 条存疑）。

## 问题 1（P1，就是后来发修复的那个）：JSON 字面量 `null` 请求体会在 5 个端点触发 TypeError → 500 'internal'，并把 V8 内部错误消息回给客户端

**机制**：`parseBody`（src/cloud/server.ts:128-134）只捕获 `JSON.parse` 的异常，不校验解析结果是对象——`JSON.parse('null')` 是合法 JSON，返回 `null` 而不是 fallback `{}`。各 handler 拿到 `null` 后立即解引用：

| 端点 | 解引用处 | 结果 |
|---|---|---|
| POST /v1/login | :146 `typeof b.token !== 'string'` | TypeError |
| POST /v1/pair | :157 `String(b.pairCode ?? '')` | TypeError |
| POST /v1/heartbeat | :240 `typeof b.devid === 'string'` | TypeError |
| POST /v1/desire | :297 `typeof b.devid === 'string'` | TypeError |
| PUT /v1/doc | :195-202：`JSON.parse('null')` 不抛异常，:202 `typeof b.envelope === 'string'` | TypeError |

异常被顶层 catch（:319-321）兜成 `500 {"error":{"code":"internal","message":"Cannot read properties of null (reading 'token')"}}`——本该是 400/401 的参数错误，且 `e.message`（:320）把 V8 内部实现细节原样外泄。触发方式只需 `curl -X POST ... -d 'null'`。另外注意：JSON 数组/字符串体不会触发此问题（属性访问返回 undefined 走 401/400），**只有字面量 `null`** 会崩——这是同类问题的全部 5 处，一次说全。

修复方向（供参考）：`parseBody` 对解析结果加非空对象校验，非对象一律回落 fallback；`handlePutDoc` 同样补 `b == null` 或类型守卫。

## 问题 2（低）：超过 5MB 的请求体 → 500 响应永远送不到客户端，表现为连接重置

- `readBody`（:60-63）：超限时 `reject` 后立即 `req.destroy()`，socket 被销毁；
- 顶层 catch（:319-321）随后写的 500 走的是同一个已销毁的 socket——客户端只会看到 ECONNRESET/连接中断，收不到任何 JSON 错误。

后果：客户端无法区分「body 过大」与网络故障/服务崩溃；`body too large` 的错误信息也一并丢失（destroy 后 'end' 不再触发，但 promise 已 reject，无泄漏）。这不是数据面 bug，但错误路径是自相矛盾的：代码打算回 500，destroy 却先一步掐断了回信通道。

## 存疑

1. **空库首写基线不校验**（:219 与 :233）：`cur` 为 null 时冲突检查被跳过，任意 If-Match 值（如 42）都被接受、rev 落为 1。机制确凿，但「是否算缺陷」取决于设计意图——缺 §7.2 对空库首写基线的规定；若客户端依赖 409 来发现「云端数据被重置过」，此路径会静默掩盖。
2. **console 页渲染转义未验证**（`renderConsolePage` 在 console.ts，本片段外）：设备可自报 `name`（:159）、`services` 的 id/name（:250-257）、`reportedProfile`（:262），这些字符串完全由设备端控制，若控制台页未做 HTML 转义即为存储型 XSS。缺 console.ts 的转义证据，无法确证。
3. **`readBody` 无超时**（:54-70）：单 IP 可无限开慢速连接拖住内存（每条上限 5MB），本片段内无任何超时配置；单用户自托管场景下威胁有限，是否算问题取决于威胁模型。
```

</details>
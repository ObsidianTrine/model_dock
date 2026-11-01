# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-catalog-view-cache-never-hit — ✅ 审出

- 考题：/_modeldock/model-catalog 视图缓存永不命中——注释宣称「缓存键 = 表对象引用」，但 fullKnownTable() 每次调用 spread 出新对象，catalogViewCache.table === table 恒 false：每请求全量 stringify 8000+ 条 + SHA-256 照算，注释与行为相悖
- 关键词：fullknowntable=中，spread=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-HH0bw7/2026-10-catalog-view-cache-never-hit.output.txt

<details><summary>模型原文</summary>

```text
**发现 2 个问题**——两处均为 9bfed39 实际修复的活缺陷，已逐条在本仓库 `9bfed39^` 源码核实。

---

**1. `catalogView()` 视图缓存永不命中（每请求全量 stringify 8000+ 条）**

- 位置：`src/gateway/server.ts:100-108`，触发点 `src/gateway/server.ts:671`
- 证据：缓存判据是 `catalogViewCache.table === table`（server.ts:103），注释（96-99 行）宣称「缓存键 = 表对象引用——引用变化自然失效」。但 `9bfed39^` 版本 `src/providers/resolve.ts:58-60` 的 `fullKnownTable()` 实现是 `return { ...catalogFlatTable(), ...knownMetaTable() }`——**每次调用 spread 出全新对象**，引用恒不相等，`catalogViewCache` 永远走重建分支。
- 后果：`hModelCatalog`（server.ts:671）每次请求无条件调 `catalogView()` → 每次都对 8000+ 条全量 `JSON.stringify` + SHA-256；672 行的 If-None-Match 304 路径虽然 ETag 值不变可以命中，但 stringify/hash 照跑，「连 stringify 都省掉」的承诺落空。注释与代码行为不一致，按 REVIEW.md「文档撒谎即失败」同样成立。

**2. `probe()` 对 responses 协议服务必失败，且报错误导**

- 位置：`src/gateway/server.ts:1992-1994`
- 证据：`const isAnthropic = target.provider.protocol === 'anthropic'` + `isAnthropic ? '/v1/messages' : '/v1/chat/completions'`——路径按**二分法**拼，只认 anthropic/其他。而 responses 是一等协议：`hServiceAdd`（754 行）与 `hFetchModels`（699 行）都接受 `protocol === 'responses'`。
- 后果：responses-only 服务走控制台「连接测试」（`POST /_modeldock/test` → `hTest` 1644 行 → `probe`）时，被拼成 `/v1/chat/completions` + openai 形态 body（1995-2000 行），经 `clientProtocolFromPath` 判成 openai，`upstreamEndpoint` 对未配 openai 端点的服务抛 400——**恒失败**，且报错把责任推给「客户端走了 openai 协议」（实际是探针拼错协议），违反「错误信息必须可操作」约定。
- 修复方向（与 9bfed39 一致）：补 `isResponses` 分支，`/v1/responses` + `{ model, max_output_tokens, stream, input }` 形态。

---

**存疑**

无。曾疑虑错误体回发路径（server.ts:497-503）只摘 `content-encoding` 不摘 `content-length` 会导致长度错配——已核实 `filterResponseHeaders`（`src/gateway/relay.ts:504`）本就过滤 `content-length`，不成立。另核实 `hFetchModels` 706 行 `key_ref: key` 传明文 key 是合法用法：`getSecret` 对 `plain` scheme 直接透传原值（`src/config/secrets.ts:566-568`）。
```

</details>
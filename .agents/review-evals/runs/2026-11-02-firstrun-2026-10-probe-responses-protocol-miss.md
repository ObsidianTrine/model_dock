# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-probe-responses-protocol-miss — ✅ 审出

- 考题：probe() 探针路径二分法只认 anthropic/其他——responses 协议服务被拼成 /v1/chat/completions，clientProtocolFromPath 判成 openai，upstreamEndpoint 对未配 openai 端点的服务抛 400，报错还把责任推给「客户端走 openai 协议」（实际探针拼错协议；responses 是一等协议，hServiceAdd/hFetchModels 均接受）
- 关键词：responses=中，探针=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-ih6Pzo/2026-10-probe-responses-protocol-miss.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题

## 1. `/_modeldock/model-catalog` 视图缓存永不命中（缓存键引用恒不等）— src/gateway/server.ts:103

- `catalogView()` 以 `catalogViewCache.table === table`（**server.ts:103**）为命中判据，注释（**server.ts:96-99**）宣称「catalog.ts 的 baseMemo 在目录刷新时重建对象，引用变化自然失效」。
- 但 `fullKnownTable()`（修复前 src/providers/resolve.ts:58-60，`9bfed39^` 版本）的实现是 `return { ...catalogFlatTable(), ...knownMetaTable() }` —— **每次调用都 spread 出全新对象**，引用永不相等。
- 后果：缓存分支是死代码，每个请求都全量 `JSON.stringify` 8000+ 条（几百 KB）+ 重算一次 SHA-256 ETag，backlog C3 的优化完全没有生效；且注释与实际行为相悖（按 REVIEW.md「文档撒谎即失败」）。
- 佐证：修复提交 `9bfed39`（"model-catalog 视图缓存命中修复"）在 providers 侧做引用稳定化（knownMetaTable 懒构建 memo、fullKnownTable 按两路来源引用复用同一对象），server 侧 `catalogView` 零改动后缓存即命中；回归测试判据是「GET#2 零序列化，无修复时红」。

## 2. `probe()` 不支持 responses 协议：responses-only 服务的连接测试恒失败且报错误导 — src/gateway/server.ts:1992-1993

- **server.ts:1992-1993**：`const isAnthropic = target.provider.protocol === 'anthropic'` / `const path = isAnthropic ? '/v1/messages' : '/v1/chat/completions'` —— 路径二分法只认 anthropic/其他。
- 证据链：responses 协议服务被拼成 `/v1/chat/completions` → `clientProtocolFromPath`（src/gateway/relay.ts:27-31）按路径判成 `openai` → `upstreamEndpoint`（src/gateway/relay.ts:36-48）对该服务抛 400「未配置 openai 协议端点（客户端走的是 openai 协议）」。报错把责任推给客户端协议，实际是探针拼错了协议。
- 后果：responses 是一等协议（`hServiceAdd`/`hFetchModels` 均接受，见 **server.ts:699、754、1118**），但 Web 控制台「连接测试」（`POST /_modeldock/test` → `probe`，**server.ts:1644**）对 responses-only 服务必失败。
- 佐证：修复提交 `9bfed39` 补 `isResponses` 分支（`/v1/responses` + `{ input, max_output_tokens }` 形态 body），回归断言 mock 上游收到 `/v1/responses` 与 responses 形态 body。

## 已排查、不构成问题的候选

- `hFetchModels` 把明文 key 写进临时 provider 的 `key_ref`（**server.ts:706**）：`getSecret` 对 plain scheme 原样透传（src/config/secrets.ts:577-589），是有意约定，非缺陷。
- `hHarnessMode` 用 `persistConfig` 当读锁查 profile（**server.ts:1510-1512**）：`profileForProvider` 可能新建隐藏 `__pin_<id>` profile，注释（admin-shared.ts:120-121）明确要求在 persistConfig 回调内调用，属契约内行为。
- `pickTarget(rt, target, target.profile.fallback)`（**server.ts:425**）签名匹配（state/routing.ts:288）；UI 缓存按 home 键（**server.ts:79-93**）、logs 分页（**server.ts:641-654**）、定时器 close 清理（**server.ts:220、264-267、282、295、314**）均无问题。

## 存疑

- `hModelCatalog` 的 304 判据是 `if-none-match === etag` 的精确相等（**server.ts:672**），不处理弱校验器 `W/"…"` 或 ETag 列表形态。浏览器对同源返回的 ETag 会原样回传，实际触发场景未找到（服务端从不发弱 ETag），缺证据，不作为问题上报。
```

</details>
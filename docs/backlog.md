# 网关优化 Backlog（B / C 级）

> 来源：2026-10-07 热路径专家评审。A 级（行为等价、直接降低转发热路径延迟）已随
> `feature/gateway-hotpath-opt` 合入 develop；本页收录暂缓的 B 级（涉及时延语义或场景驱动）
> 与 C 级（管理面 / 可维护性）项，供后续排期。每条附验证思路，动手前先读对应源码再实施。
>
> 2026-10-11 全仓审查（性能 / 跨平台 / 正确性）结论另见 **`docs/known-issues.md`**（含稳定编号
> PERF-XX / XPLAT-XX / CORRECT-XX 与状态勾选）；本页 B4 ≈ PERF-17、C2 与 PERF-06/07/09 同域，实施时合并处理。

## B 级：转发热路径（涉及时延语义变化，需拍板后再做）

- [ ] **B1 纯透传路径流式化**（`src/gateway/server.ts` readBody）
  现状：所有代理请求体先全量缓冲（上限 64MB）再转发——这是故障切换「传输层失败重放」的前提，
  路由端点（/v1/messages 等）必须保留。可做的是 `ROUTED_PATH_RE` 之外的纯透传端点（文件类等）
  边收边 pipe，省一次大体内存驻留。代价：这些路径失去 transport 失败重试（或仅对无体 GET 保留）。
  验证：构造 10MB 上传走非路由路径，对比内存峰值与 TTFB；回归 `npm test` gateway 套件。

- [ ] **B2 连接错误重试策略**（`src/gateway/relay.ts` forwardToUpstream 重试环）
  现状：connect 类错误立即重试（`retries` 默认 1），ETIMEDOUT/ENOTFOUND 本身就慢，重试让最坏
  等待翻倍；`headers_timeout_ms` 默认 60s，挂死的上游每请求占满 60s。
  候选：超时类（ETIMEDOUT/UND_ERR_CONNECT_TIMEOUT）不再重试（保留 ECONNREFUSED 快速重试），
  或加 100ms 退避；`headers_timeout_ms` 默认调低（如 30s）并在文档标注。
  ⚠ 改变最坏时延语义，需明确决策后实施。验证：mock 上游模拟 connect refused / 挂死两端点，
  断言失败路径耗时上界；回归 failover 相关用例。

- [ ] **B3 `joinUpstreamUrl` 每请求 `new URL`**（`src/gateway/relay.ts`）
  openai/responses 协议每请求重新解析一次端点 URL。可按 provider 配置对象引用缓存解析结果。
  验证：单测断言同 provider 反复调用命中缓存；改端点配置后缓存失效。

## C 级：管理面 / 可维护性（离转发热路径远，优先级低）

- [ ] **C1 handleAdmin 路由表化**（`src/gateway/server.ts`，早期代码审查已知遗留）
  2100 行 if 链 → 端点路由表（method+path → handler），纯可维护性重构，行为零变化。
  验证：全量 `npm test`（管理面端点覆盖充分）+ 手测控制台主要操作。

- [ ] **C3 `/model-catalog` 加 ETag**：8000+ 条全量响应，控制台懒加载一次但刷新页面即重拉；
  按 `fullKnownTable()` 内容 hash 出 ETag，命中 304 省流量。验证：二次请求返回 304。

- [ ] **C4 `safeEqual` 长度预比较**（`src/gateway/server.ts`）：sha256 归一化是为防长度泄漏，
  但本机 admin 场景可先比长度再做常数时间比较省两次 hash。微小收益，顺手项。

## 已完成（A 级 + 后续收口，存档备查）

- [x] A1 上游连接 keep-alive 调优：direct 走共享调优 Agent（空闲 55s 复用，原全局 dispatcher 4s 即断），
      ProxyAgent 透传同参数——省掉间隔超过 4s 的请求重付 TCP+TLS 握手（跨境 100ms+）。
- [x] A2 请求/审计日志常驻追加流（util/fsx.ts appendLine）：每条从 open+write+close 三个 syscall
      降为一次 write；测试侧 fakeHome.restore 先 closeAppendStreams 再删目录（Windows fd 占用）。
- [x] A3 模型改写快路径：纯透传（无 override/别名/默认模型）跳过全量 JSON.parse，顶层 model 浅扫描
      提供 modelAfter，扫描器拿不准即退回完整解析，行为逐字节等价；别名通配正则按 pattern 缓存编译。
- [x] A4 SSE usage tap：data 行按 "usage" 字面量预过滤（带用量的行必含该键），跳过 95%+ content
      delta 行的 JSON.parse；StringDecoder 修复多字节字符跨 chunk 截坏导致的用量漏记。
- [x] A5 pickTarget 定时窗口单次求值（原 3 次 hitScheduleWindows）+ 日历懒加载：无 dayFilter 窗口的
      部署零 statSync，有 dayFilter 的每请求至多 1 次。
- [x] B4 reload 时关闭旧 dispatcher（state.ts reloadRuntime）：除共享 direct Agent 外逐个 `close()`
      再 clear，ProxyAgent 连接池不再随 reload 累积（2026-10 随 develop 演进交付）。
- [x] C2 overview 轮询成本：缓存 TTL 提至 6s（大于 UI 5s 轮询周期，稳态命中；配置变更经 reloads
      立即失效）+ 命中直接回放缓存串免重复 stringify；cookie 名正则按端口预编译缓存（同上）。

# 网关优化 Backlog（B / C 级）

> 来源：2026-10-07 热路径专家评审。A 级（行为等价、直接降低转发热路径延迟）已随
> `feature/gateway-hotpath-opt` 合入 develop；本页收录暂缓的 B 级（涉及时延语义或场景驱动）
> 与 C 级（管理面 / 可维护性）项，供后续排期。每条附验证思路，动手前先读对应源码再实施。
>
> 2026-10-11 全仓审查（性能 / 跨平台 / 正确性）结论另见 **`docs/known-issues.md`**（含稳定编号
> PERF-XX / XPLAT-XX / CORRECT-XX 与状态勾选）；本页 B4 ≈ PERF-17、C2 与 PERF-06/07/09 同域，实施时合并处理。
> 2026-10-28 归档：已闭环的时点记录（release-review-2026-10-12 / test-plan-handoff / web-testing-plan / engine-smoke / redundancy-design）移入 **docs/archive/**。
> 2026-10-27 维护性任务（拆大文件 / 还债 / 测试盲区 / 文档补课，不加新功能）另行立卡：见 **`docs/maintenance-handoff.md`**。

## B 级：转发热路径（涉及时延语义变化，需拍板后再做）

- [x] **B2 连接错误重试策略**（2026-10-25 实施，只做了一半并明确放弃另一半）
  已做：`isConnectTimeoutError` 分类——超时类（ETIMEDOUT / UND_ERR_CONNECT_TIMEOUT，已等满超时
  窗口）不再重试、直接走 failover 下一候选，挂死上游的最坏等待从 2×连接超时降到 1×；拒绝类
  （ECONNREFUSED/ECONNRESET/ENOTFOUND/EPIPE，毫秒级失败）保留立即重试 1 次应对瞬时抖动。
  放弃：`headers_timeout_ms` 默认调低不做——非流式长推理的响应头要等推理完才到，60s 默认是
  设计文档明示的合法场景（§5.1 参数表），降默认会误伤；确有需要的用户已有配置项可调。
  验证：relay.test.ts 分类单测 + 全量 failover 用例回归。

- [ ] **B1 纯透传路径流式化——评估后放弃**（2026-10-25）：本产品 harness 的大请求体几乎全走
  路由端点（/v1/messages 等，改写+重放必须全量缓冲），非路由大上传（/v1/files 类）真实频率
  极低；且请求体上限已降为默认 16MB + `max_body_mb` 可调，内存顾虑已缓解。双通道（缓冲/流式）
  进最热路径的复杂度 + 丢失传输失败重试，收益撑不起风险。重启条件：有用户真实反馈大文件
  端点使用。

- [ ] **B3 `joinUpstreamUrl` 每请求 `new URL`——评估后放弃**（2026-10-25）：微秒级开销相对转发
  本身的头部重建/TLS 可忽略，加缓存反而引入失效状态；违反「先 profile 再优化」纪律。

## C 级：管理面 / 可维护性（离转发热路径远，优先级低）

- [x] **C1 handleAdmin 路由表化**（2026-10-25 实施）：admin 门后 45 端点收敛为模块级路由表
  （`ADMIN_ROUTES`，键 = "METHOD /path"），tier-1（health/ui/relogin）与鉴权门原样保留；handler
  逐字搬移（独立脚本逐行比对确认与原 if 块字节一致），行为零变化。L0-5 端点审计同步改为
  双形态提取（`url ===` if 形态 + 表键形态）。全量 69 文件绿。

- [ ] **C4 `safeEqual` 长度预比较——评估后放弃**（2026-10-25）：被优化的路径只在管理面跑
  （数据面 token 是 Map 查找不走 safeEqual），每 5s 轮询两次微秒级哈希，量不出收益。

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
- [x] C3 `/model-catalog` ETag/304（2026-10-25）：序列化结果按表对象引用缓存（目录刷新自动失效），
      If-None-Match 命中 304 短路——控制台每次刷新不再重复 stringify/传输几百 KB 大表。
      验证：console-cache.test.ts（200+ETag / 304 / 未命中回全表逐字节一致）。
- [x] B4 reload 时关闭旧 dispatcher（state.ts reloadRuntime）：除共享 direct Agent 外逐个 `close()`
      再 clear，ProxyAgent 连接池不再随 reload 累积（2026-10 随 develop 演进交付）。
- [x] C2 overview 轮询成本：缓存 TTL 提至 6s（大于 UI 5s 轮询周期，稳态命中；配置变更经 reloads
      立即失效）+ 命中直接回放缓存串免重复 stringify；cookie 名正则按端口预编译缓存（同上）。

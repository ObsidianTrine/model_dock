# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-relay-failover-observability — ✅ 审出

- 考题：failover 链三处可观测性 lie：数组体改写谎报 modelAfter、全候选 skip 耗尽降级成 502「连接失败」吞真实 status/hint、replayed_from 单变量覆盖只剩最后一跳
- 关键词：array.isarray=未中，candidateskip=中，replayed_from=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-Ouxcom/2026-10-relay-failover-observability.output.txt

<details><summary>模型原文</summary>

```text
**发现 1 个问题**（另有一批已排查排除项与存疑项，见后）。

## 已确认

**1. relay.ts:637-639 — 全部候选以 `candidateSkip`（配置级不可用）终止时，错误被误包成 502「所有候选服务连接失败」，原始 status/hint 丢失**

证据链（逐行核实）：
- `forwardWithFailover` 的 catch 分支（relay.ts:631-634）：`skip = transport === true || candidateSkip === true`，skip 时不抛出、记 `replayedFrom` 后进入下一轮；
- `candidateSkip=true` 的三类错误全部是**配置问题而非连接问题**：key 读取失败（relay.ts:389-395，503）、key 缺失（relay.ts:398-404，503，hint=`modeldock provider set-key {id}`）、客户端协议端点缺失（relay.ts:35-41，400，hint=「在编辑服务里填入该协议端点」）；
- 循环自然走完后，relay.ts:637 无条件重包为 `UpstreamError(502, '自动路由：所有候选服务连接失败…')`，**不带 hint**，且 relay.ts:638 设 `routeReason='down_all'`（日志/Web 把它当「全部服务不可达」事件）。

失败场景（最常见的入门路径）：profile 只有单一 provider、用户忘了 `provider set-key` → 每个候选都 candidateSkip → 客户端收到 `502 所有候选服务连接失败（…key 不可用…）`——被措辞误导成网络故障，且 `set-key` 修复建议丢失；协议端点缺失场景同理 400→502。正确行为应是循环耗尽且无传输层失败时原样上抛最后一个 `UpstreamError`（保住 503/400 与 hint），502 包装只适用于确有连接失败的情形。

## 已核实排除（列出以示查过）

- `topLevelModel` 浅扫描：对合法 JSON 与 `JSON.parse` 全量等价（重复键取末、转义对跳越界回退、非字符串 model、多字节/`\"` 嵌套值逐例手工推演通过）；对少数非法 JSON（如 `{"model":"m"}x`）会给出值而非 null，仅影响日志 modelAfter，上游同样拒收——见存疑 4。
- 快/全路径分叉一致性（relay.ts:352-359 vs 362-374）、`anthropic-version ??=` 键大小写（server.ts:436-438 源自 `req.headers`，Node 保证小写）、`recordOutcome` 空 `cls` 不计熔断（state/routing.ts:81）、`pickTarget` 空链返回 `down_all`（routing.ts:415）、`matchAlias` 不抛（glob.ts:16-23）、drained 体重包与 server.ts:489-503 的 content-encoding/content-length 二次剥离衔接、dispatcher 按 mode 缓存——契约均一致。

## 存疑（证据不足，不下结论）

1. **relay.ts:24-29 与注释不符**：注释说「未知路径（/v1/models 等）才回退 provider 协议」，但 `/v1/messages`、`/v1/messages/count_tokens` 这两个**确定的 anthropic 端点**同样落入 fallback——provider.protocol 为 openai 时，anthropic 格式请求体会被原样转给 openai 端点而不是 candidateSkip 走故障切换。缺证据点：可能是为「同一 base_url 双协议服务商」刻意保留的直通行为，无历史决策记录可查。
2. **relay.ts:439-446**：请求阶段 ECONNRESET 被立即重试且 `transport=true` 跨候选重放，与 relay.ts:115-117 注释声明的重放安全边界存在灰色窗口（上游可能已处理请求）；注释表明作者知情，是否算缺陷取决于接受度。
3. **relay.ts:442**：502 消息携带完整上游 URL，若 base_url 配了 userinfo（`user:pass@host`）凭据会进客户端可见错误体——未验证配置层是否禁止该形态。
4. **relay.ts:227/234**：对非法 JSON（顶层扫描可判但整体非法）返回值而非 null，fast path 的 `modelAfter` 可能记录上游从未接受的模型名，仅日志失真。
5. **relay.ts:71-78**：内网段识别缺 100.64.0.0/10（CGNAT/Tailscale 常见）、IPv6 ULA/链路本地，`endpointRisks` 对这些地址漏发第二条提示（http 明文提示仍在）。

清理说明：未拉起任何进程、未写入任何文件（两次临时文件写入未获授权，已放弃执行验证，改为手工推演+跨模块契约核对）。
```

</details>
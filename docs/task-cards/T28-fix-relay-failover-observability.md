---
id: fix-relay-failover-observability
type: fix
created_at: 2026-10-30T04:45:00+08:00
created_by: agent
files_hint:
  - src/gateway/relay.ts
  - test/hotpath.test.ts
  - test/relay.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
修 CORRECT-09（P2）：relay failover 链三处可观测性缺陷——修完后，**客户端/日志看到的 status、hint、routeReason、replay 记录与真实发生的事一致**。不改变任何路由/重试/熔断的既有决策语义。

# 背景（行号基于 2026-10-30 develop @9785a9a，发现于夜巡挖洞并逐条读码核实，动手前先读源码确认仍成立）
- 缺陷 ①（数组穿透，:325-336 `injectModel` + :365 调用点）：守卫 `!json || typeof json !== 'object'` 拦不住数组（`typeof [] === 'object'`）——顶层数组请求体 + 需改写模型时，`json.model = final` 设数组 expando、`JSON.stringify` 丢弃之，返回的 body **未注入 model** 但 `modelAfter: final` 谎报已改写；违反 :322-323 自述契约「顶层非对象时返回 null」。test/hotpath.test.ts:139 只测了无 default_model 的数组场景，恰好绕开此路径。影响：日志/usage 记录的 model 与实际发出 body 不一致（可观测性 lie），非功能损坏（非法数组上游本会 400）。
- 缺陷 ②（链尾出口吞错，:630-633）：候选耗尽统一 `new UpstreamError(502, '所有候选服务连接失败（msg）')`，不传 hint、不透传 lastErr 的 status。全链候选都是 candidateSkip（key 缺失 / 协议端点缺失 / **钥匙环锁定 503+「检查系统钥匙环是否已解锁」hint**）时，客户端收到 502「连接失败」——status、hint、routeReason（`down_all`，实则从未连接过）三重失真。d41f847⑧ 补了「钥匙环故障跳下一候选」前半段，链尾出口没跟上。
- 缺陷 ③（replayedFrom 单变量，:589、:608、:628）：A→B→C 连续重放时反复覆盖，最终 reason 只含 `replayed_from:B`，A 丢失——与该字段自述用途「日志对账」（:589 注释）相悖。
- 完整登记（含 2 条存疑）：docs/known-issues.md §三 CORRECT-09；模型审查原文 runs/2026-10-30-hunt-relay.md。

# 实施要求
1. **修①**：`injectModel` 与 :365 调用点守卫补 `Array.isArray(json)`；数组请求体按契约原样透传（不进 parse-改写路径时懒解析快路径本身已返回 null，确认两路一致即可）。补 hotpath 用例：顶层数组 + default_model 存在 → body 原样、`modelAfter` 不谎报。
2. **修②**：候选耗尽时若 `lastErr` 是 `UpstreamError`，透传其 status 与 hint（实现建议：candidateSkip 类错误原样上抛或按其 status 重建；transport 类保持现有 502 包装）。`routeReason` 相应调整：全 candidateSkip 耗尽不再标 `down_all`（未发生连接），可引入独立 reason（如 `skip_all`——命名自定，同步更新日志判读文档若有）。
3. **修③**：`replayedFrom` 改数组累积（去重），marks 里 join 输出 `replayed_from:A,B` 形态；确认 reason 消费方（server.ts 日志、控制台）对多值兼容。
4. **明确不在本卡范围**（known-issues 已记为存疑，需要作者意图确认后另立卡）：a) ECONNRESET/EPIPE promise 阶段重放与 :115-116 注释自述边界的取舍；b) `QUOTA_BODY_RE` 不含中文额度词（额度/配额/余额/欠费）。本卡不動这两处。
5. 修复合入后按 `.agents/review-evals/README.md`「怎么加新考题」回流为审查评测考题（reviewRef=修复提交^，files=[src/gateway/relay.ts]；实跑配方见 README「怎么跑」）。

# 验收标准
- test/hotpath.test.ts（或 relay.test.ts）新增定向回归：① 数组体改写不谎报；② mock 全候选 candidateSkip（如 provider key 缺失）→ 客户端收到原始 status+hint、routeReason 非 `down_all`；③ 三候选连续重放 → reason 含全部被跳过的 providerId；④ 正常 failover（transport 失败→次选成功）行为与现有用例语义完全不变。
- `npm test` 全绿（relay 是转发热路径，既有用例零语义漂移是硬门禁）；`npm run test:workflow` 全绿。
- 三平台兼容自查（本卡纯 JS 逻辑，常规过一遍）。
- docs/known-issues.md CORRECT-09 条目勾选并标注日期与 commit（维护约定 1）。

# 红线
- 不改 failover 候选排序、切换条件（failover_status_codes / quota 恒切）、熔断 recordOutcome 语义、重试次数语义。
- 不动 :115-116 注释所述重放安全边界与 QUOTA_BODY_RE（存疑项，另行决策）。
- 密钥/token 不进日志与错误消息（REVIEW.md 网关区红线）。
- 测试不监听 8687/8890，mock 上游用 `listen(0)` 随机端口，收尾清理自己拉起的进程。

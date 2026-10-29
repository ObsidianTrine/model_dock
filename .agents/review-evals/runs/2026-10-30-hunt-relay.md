# 夜巡挖洞（hunt） — src/gateway/relay.ts @ HEAD

- 顶层结论：发现 3 个问题

<details><summary>模型原文</summary>

```text
**发现 3 个问题**（另附存疑 2 则）。片段已与仓库 HEAD 逐行核对一致；以下发现均先读源码/协作模块（`state.ts`、`glob.ts`、`server.ts`、`secrets.ts`、测试）验证过。

---

**1. `injectModel` 把顶层数组 JSON 误当对象，`modelAfter` 谎报改写成功 — src/gateway/relay.ts:331、365**
`typeof [] === 'object'` 为真，`!json || typeof json !== 'object'` 拦不住数组：`json.model = final`（:332）设的是数组 expando 属性，`JSON.stringify` 序列化数组时会丢弃它。结果：`injectModel` 返回 `{ body, modelAfter: final }`——body **未注入 model**，但 `rewriteModel`（:369）把 `modelAfter` 上报为已改写。触发条件：routed 端点收到顶层数组体 + `default_model`/`modelOverride` 存在（fast path 对数组返回 null 萰全量路径，两路同病）。这违反 :322-323 自述契约「顶层非对象时返回 null」，也违反 :365 检查的本意。`test/hotpath.test.ts:139` 只测了**无 default_model** 的数组场景，恰好绕开此路径。修法：`injectModel` 与 :365 均补 `Array.isArray(json)` 排除。影响评估（如实）：对非法数组请求上游本会 400，实际后果是日志/usage 记录的 model 与实际发出 body 不一致（可观测性 lie），非功能损坏。

**2. 全候选 candidateSkip 耗尽后，真实 status/hint 被 502 down_all 吞掉 — src/gateway/relay.ts:626-634**
catch 分支里 `skip=true`（key 缺失/协议端点缺失/钥匙环锁定，均 candidateSkip）只置 `replayedFrom` 后 `continue`；候选耗尽落到 ：632 统一包成 `new UpstreamError(502, '所有候选服务连接失败', …)` 且**不传 hint**。当链上所有候选都 candidateSkip 时：① :397/:388 的 503（如钥匙环锁定，附「检查系统钥匙环是否已解锁」hint）被降级成 502、hint 丢失；② `routeReason='down_all'` 谎报——这些候选根本没被连接过。d41f847⑧ 补了「钥匙环故障跳下一候选」的前半段，链尾出口没跟上。真实场景：macOS 重启后钥匙环未解锁，全链 keychain provider 逐一抛 503，客户端却收到 502「连接失败」。修法：耗尽时若 `lastErr` 是 UpstreamError，透传其 status/hint（或至少 candidateSkip 类原样上抛）。

**3. `replayedFrom` 单变量只记最后一跳 — src/gateway/relay.ts:589、608、628**
A→B→C 连续重放（如 A 传输失败 → B 402 切换 → C 成功）时 ：608/:628 反复覆盖，最终 `reason` 只含 `replayed_from:B`，A 的重放记录丢失。该字段自述用途即「日志对账」（:589），应改数组累积。

---

**存疑**（缺证据，不下结论）：

- **ECONNRESET/EPIPE 的重放边界与 ：115-116 自述相抵** — relay.ts:157-158、435、441。`request()` promise 阶段的 ECONNRESET（响应头未达）意味着请求**可能已送达甚至已计费**，但 ：435 仍立即重试、重试耗尽后 ：441 标 `transport=true` 让 failover 改发下一候选。:115-116 注释明确说「ECONNRESET 若发生在响应读取阶段……不据此判定重放安全性」。可能是有意取舍（重试收益 > 双计费风险），代码里未见权衡记录，需要作者确认意图。
- **quota 特征识别不含中文错误体** — relay.ts:553 `QUOTA_BODY_RE = /quota|insufficient/i`。同文件 `MODEL_MISSING_RE`（:451）覆盖了中文（「不存在|不支持」），quota 判别却没有「额度|配额|余额|欠费」——国内上游以中文 429 报额度耗尽时不会触发恒可切换。是否已有实测案例支持属检测缺口，还是已知取舍，缺证据。

**核查过无问题的点**（供后续审查跳过）：`topLevelModel` 扫描器与 `JSON.parse` 的语义等价（对抗输入逐分支推演过：转义键/嵌套引号/重复键/截断/BOM，且 `hotpath.test.ts` 覆盖充分）；429/402 排空重包的 `content-length` 由 server 侧 `filterResponseHeaders`（server.ts:513）剥除，无长度错配；客户端断开中止链路（:432、:623 + server `fwdAbort`）闭环正确；无 REVIEW.md 六条红线触碰。
```

</details>
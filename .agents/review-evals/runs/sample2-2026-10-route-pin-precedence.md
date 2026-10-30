# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-route-pin-precedence — ✅ 审出

- 考题：客户端钉住路由被定时窗口/全局当前槽接管——mimo-desktop 钉住 hundsun-mimo 后请求仍被 14:00-18:00 窗口压到 agent-plan，模型发错上游 404 UnsupportedModel（2026-10-21 用户报障）
- 关键词：pin=未中，钉=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-HQCrMF/2026-10-route-pin-precedence.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题

以下均为对片段代码（src/gateway/state.ts，baa820c^ 版本，行号按片段标注）通读多轮 + 交叉核对辅助模块后的结论。路由主链路（pickTarget / hitScheduleWindows / routeState）我做了逐分支推演（含跨午夜窗口、1439 例外、熔断窗口、avoid/extras 兜底、钉定三级优先、`choose` 的 source/degradedFrom 标注），未发现路由判定本身的逻辑错误；`loadCalendar()` 已核实文件缺失/损坏时返回空表不抛错（热路径崩溃候选排除）。两条确认的问题都属于「用户直编 config 值被静默吞掉」这一类：

**1.（中）定时窗口写 `24:00` 或 `00:00-00:00` 时静默失效，零报错零日志**
- 证据：`parseHHmm`（L252-259）正则 `^(\d{1,2}):(\d{2})$` + `h > 23` → `"24:00"` 返回 null；`hitScheduleWindows` L304 `if (s == null || e == null || s === e) continue` 把解析失败与 `s === e`（"00:00-00:00" 全天写法）一律**静默跳过**。
- 失败场景：用户手编 `config.toml` 写 `22:00-24:00`（很自然的写法，类型注释只说 HH:mm）→ 该窗口永不生效，定时切换悄悄失灵，无任何可观测信号。已 grep 全 src 确认 `parseHHmm` 仅此一处使用、配置加载与写入路径均无窗口时间校验或告警。
- 违反项目「错误信息必须可操作」约定；至少应在求值到非法窗口时打一条含窗口内容的日志/审计，或加载时校验拒绝。

**2.（低）两处钉定语法能力不一致：`auto_route_provider` 含 `:` 时钉定静默失效**
- 证据：`route_next`（L482-483 取出后进 `fbSource`，L486-487 经 `parseFallbackEntry` 解析）支持 `<providerId>:<modelId>`；而「当前」钉定 `auto_route_provider`（L458-461）**不经 parseFallbackEntry**，整串直接 `rt.config.providers[forcedId]` 查找。手改 config 写成 `"prov:model"` → 查不到 → `forcedEligible` false → 无声顺延到默认路由，钉定丢失无提示。
- 与问题 1 同类（手编配置值被静默吞），修法可一并考虑（解析或校验报错）。

## 存疑

- **备用链候选把 base profile 的 `default_model` 带到别的上游**（L441 非pair分支 `{...base.profile, provider: id}`，覆盖手动 fallback 与自动备用链）：已核实 relay.ts:319 在客户端模型未命中别名时会兜底改写为 `target.profile.default_model`，即故障切换目标会收到 base 服务的模型名——这正是 L338-340 `profileForProviderReadonly` 注释声明要避免的事，但该机制只覆盖主候选。L436 注释又称「备用链保持 base profile，不影响既有语义」，可能是有意取舍。缺的证据：产品上是否接受切换后模型名可能不存在于目标上游（需作者确认，不敢定为缺陷）。
- **`pidAlive` 对 pid ≤ 0 返回 true**（`process.kill(0, 0)` 命中自身进程组而非失败；负 pid 同理报 ESRCH 之外的语义）：本片段内 `gatewayLive`（L847-862）有健康端点 + started_at 比对兜底，state 文件损坏出 pid=0 不会成害；但 `src/gateway/main.ts:79` 在本片段之外裸用 `pidAlive(existing.pid)` 判实例存活，无兜底——[存量]、超出本次审查范围，仅提示。
```

</details>
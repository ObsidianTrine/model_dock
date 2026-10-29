# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-env-port-live — ✅ 审出

- 考题：cmdEnv 用 resolveClientGatewayPort 取端口——该链为写客户端文件固定「生产默认端口存活优先」，非默认端口实例运行时 env 恒输出 8687，与 gateway status / test 口径不一致
- 关键词：resolveclientgatewayport=中，gatewaylive=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-wEaoOt/2026-10-env-port-live.output.txt

<details><summary>模型原文</summary>

```text
发现 1 个问题

**1. [P1] `src/cli/diag.ts:618` — `cmdEnv` 端口解析用错链路：生产 8687 存活时 `modeldock env` 恒指向 8687，无视实际运行的非默认端口实例**

证据：`cmdEnv` 第 618 行

```ts
const port = await resolveClientGatewayPort(undefined, cfg.gateway?.port)
```

而 `src/ops.ts:377-383` 的解析链是 **显式端口 > 探测生产默认端口 8687 存活（`gatewayHealthOk(DEFAULT_GATEWAY_PORT)`）> 状态文件 live 实例 > 配置值**。该链注释自述是「写客户端文件的目标网关端口解析」，为 CORRECT-05/2026-10-01 事故刻意固定「生产默认端口存活优先」——这对写客户端文件是正确取舍，但对 `env`（打印给用户 source 的端口显示）口径错误。

失败场景：生产网关在 8687 常驻存活；用户另起一个非默认端口实例（端口漂移回落或手动 `--port 8891`，成为状态文件里最后启动的实例），随后跑 `modeldock env`——第 381 行探测到 8687 存活即直接返回 8687，输出的 `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` 全部指向 8687，用户刚起的实例被完全跳过（后续修复提交 87b2106「fix(env): 端口显示改 gatewayLive 优先——非默认端口实例运行时不再恒打 8687」即修此处）。

对照同文件内既有口径可自证：`cmdStatus` 第 35 行与 `collectDoctorFindings` 第 429 行均为 `live?.port ?? cfgPort ?? DEFAULT_GATEWAY_PORT`（gatewayLive 优先），唯独 `cmdEnv` 走了 `resolveClientGatewayPort`。修法与两者对齐：`const live = await gatewayLive(); const port = live?.port ?? cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT`。

存疑（证据不足，不作为确定发现）

- **`src/cli/diag.ts:39` — `cmdStatus` 的 adapter 状态探测未捕获异常**：`Promise.all(statusAdapters.map(async (a) => [a, await a.status(cfg, port)]))` 无 `.catch`，任一 adapter 抛错（如 pack 目标文件损坏）会击穿整条 `modeldock status`。同文件 doctor 第 434 行对同款并行探测显式 `.catch` 并注释「单个 adapter 异常不应击穿整条体检」。缺的证据：无法确认 status 是否被视为「快速失败即可」的既有设计（该段非本次快照引入，标 [存量]），故不按确定缺陷报。
```

</details>
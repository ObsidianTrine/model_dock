# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-env-port-live — ✅ 审出

- 考题：cmdEnv 用 resolveClientGatewayPort 取端口——该链为写客户端文件固定「生产默认端口存活优先」，非默认端口实例运行时 env 恒输出 8687，与 gateway status / test 口径不一致
- 关键词：resolveclientgatewayport=中，gatewaylive=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-XTuBsv/2026-10-env-port-live.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题

**1.（P1，即后续修复的 bug）`cmdEnv` 端口解析链压掉非默认端口 live 实例 — src/cli/diag.ts:618**

- 证据：`cmdEnv` 用 `resolveClientGatewayPort(undefined, cfg.gateway?.port)` 解析导出端口；而该链首站是「生产默认端口存活优先」（src/ops.ts:381：`if (!FAKE_HOME && await gatewayHealthOk(DEFAULT_GATEWAY_PORT)) return DEFAULT_GATEWAY_PORT`）。
- 失败场景：8687 生产实例在线时，用户在普通 shell（无 FAKE_HOME）另起非默认端口实例（dev 8890 / 测试 189xx），`modeldock env` 恒导出 `ANTHROPIC_BASE_URL=http://127.0.0.1:8687` —— 客户端指向错误实例，token 也不被它认可，请求全挂。
- 同文件 `cmdStatus`（第 35 行）用的是 `live?.port ?? cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT`，`cmdEnv` 与之不同源。修复方向：`gatewayLive()` 优先（已由 87b2106 落地，diff 已核实）。

**2.（P2，[存量]）`cmdStatus` 并行探测无逐项 catch，单个 adapter 异常击穿整条命令 — src/cli/diag.ts:39**

- 证据：`Promise.all(statusAdapters.map(...))` 对 `a.status()` 无 `.catch`；同文件 doctor 的同款循环（433–435 行）显式 `.catch((e) => e)`，注释明言「单个 adapter 异常（如 pack 目标文件损坏）不应击穿整条体检」。
- 失败场景：一个 adapter pack 目标文件损坏 → `modeldock status` 整体抛未处理异常，其余 harness 状态全部看不到。现行代码 src/cli/diag.ts:38 仍无守卫，属存量未修。

**存疑**

- diag.ts:162：`v.indexOf(':', 4)` 为 -1 时显示成 `id()`（空前缀），行为确证但纯展示瑕疵，按纪律不报。
- diag.ts:305 / `recordedArgvStale`（src/autostart.ts:246）：非 `--` 开头的非路径参数（如假想 argv 含 `--port 8687` 的值）会被当缺失文件误判 stale；但当前 `gatewayDaemonArgs` 各形态只产出真实路径 + `--sea-gateway`，无实据触发路径，不报。
- diag.ts:295：`run` 返回 boolean `removed`，runFixes（522 行）会拼出 `：true` 的尾巴，展示瑕疵。
```

</details>
# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-daemon-stderr-pipe-pin — ✅ 审出

- 考题：gateway start --daemon 就绪后 CLI 不返回：父进程 stderr 转写读端把事件循环钉住，脚本/终端被钉死（实测 ≥45s）
- 关键词：stderr=中，unref=中，pipe=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-pfTqju/2026-10-daemon-stderr-pipe-pin.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题（均在 `src/cli/shared.ts` 的 `spawnDaemonAndWait` 同一段代码，后被 07cfca4/7d21df0 整段修复）。

## 1. [P1] stderr 管道读端把父 CLI 事件循环钉死，`gateway start --daemon` 就绪后永不返回

- **证据**：`src/cli/shared.ts:60` `stdio: ['ignore', 'ignore', 'pipe']` 给常驻 daemon 配了 stderr 管道；`src/cli/shared.ts:84-98` 挂了 `'data'`/`'close'` 读端监听做日志转写；`src/cli/shared.ts:66` `child.unref()` 只把子进程句柄移出引用计数，**不移除 stderr 管道读端对事件循环的引用**。daemon 常驻、其 fd 2 永不关闭，读端 flowing 态被事件循环引用——`src/cli/shared.ts:103` 探测到 `live` 后 `spawnDaemonAndWait` 的 Promise 虽已 resolve，但 CLI 进程的事件循环排不空，进程退不出（实测挂 ≥45s；SEA 双击场景窗口关不掉）。
- **正确做法**（即后续修复）：日志由 daemon 侧自写（daemon 启动早期 `closeSync(2)` + `openSync` 接管 fd 2 到 `logs/daemon-<date>.log`），父侧 stdio 全 ignore、零读端监听。「为收日志而 pipe 常驻进程的 stderr」必然钉住自身。

## 2. [P2] 同一转写代码逐 chunk `toString('utf8')`，多字节字符跨 chunk 被截断

- **证据**：`src/cli/shared.ts:85` `chunk.toString('utf8')` 对每个 chunk 独立解码——中文/emoji 等多字节 UTF-8 序列被 chunk 边界切开时，两半各自解码成乱码，daemon 日志出现 mojibake。修 #1 时随父侧解码一并消除（fd 直写无此问题）。

**衍生后果**（并入 #1，不计独立条目）：父 CLI 最终退出后管道读端关闭，daemon 此后写 stderr 会收 EPIPE——崩溃诊断输出两头不讨好。

## 存疑

- `openUrlInBrowser`（`src/cli/shared.ts:116`）win32 走 `/c start` 由 cmd 解释参数，URL 含 `&` 等 shell 元字符会被截断。但当前两处调用（`src/cli.ts:167`、`src/cli/gatewaycmd.ts:348`）传的都是内部网关 URL，无元字符，缺真实触发场景，不作为确证问题。
```

</details>
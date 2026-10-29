# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-cim-crlf-parse — ✅ 审出

- 考题：parsePidCommandLines 不剥行尾 \r——Windows PowerShell CIM 重定向输出为 CRLF，正则 (.*)$ 全行失配→进程枚举恒空→stopTray 静默空转，托盘杀不掉且无痕
- 关键词：crlf=中，parsepidcommandlines=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-moSGI1/2026-10-cim-crlf-parse.output.txt

<details><summary>模型原文</summary>

```text
发现 1 个问题（另附 1 条存疑）。

## 1. `parsePidCommandLines` 无法解析 CRLF 行——Windows 进程枚举恒空【已确证，即后续 e4ac854 修复的根因】

**证据**：`src/cli/shared.ts:150-159`。`PROC_LINE_RE = /^\s*(\d+)\s+(.*)$/` 直接对 `lines.split('\n')` 的行做匹配，不剥行尾 `\r`。JS 正则中 `.` 不匹配 `\r`（它是 LineTerminator），且无 `m` 标志的 `$` 只匹配串尾或末尾 `\n` 之前——因此 `"1234 cmd\r"` 整行失配，被当脏行 `continue` 跳过。

**触发条件与后果**：Windows 上 `listProcessLines()`（PowerShell CIM 重定向）输出是 CRLF，除末行外每行带 `\r` → 解析恒返回 `[]`。两个调用方同时哑火：
- `src/update/install.ts:76`：更新流程 `stopTrayProcesses` 枚举不到托盘 pid → 静默空转，托盘存活（2026-10-28 三次更新全复现，与 e4ac854 提交说明一致）；
- `src/cli/gatewaycmd.ts:156`：`sweepGatewayProcesses` 清扫游离网关在 Windows 同样恒空。

**修复形态**（e4ac854 已证）：`line.replace(/\r$/, '')` 后再匹配。我已核对修复提交 diff，改动正是此行。

## 存疑：daemon 的 piped stderr 可能拖住父 CLI 事件循环，致 CLI/GUI 永不退出

**位置**：`src/cli/shared.ts:60,66`。`stdio: ['ignore','ignore','pipe']` + `child.unref()`；daemon 常驻且 `src/gateway/main.ts` 未见任何重定向/关闭自身 fd 2 的代码。`child.unref()` 按文档只把子进程移出引用计数（"unless there is an established IPC channel"），并不 unref 父侧 stderr 读流；流开着且挂了 `data` 监听 → referenced handle → 事件循环不排空。

**后果（若成立）**：`gateway start --daemon`（`src/cli/gatewaycmd.ts:35` 成功后仅 return 自然退出）、doctor 自动拉起（`src/cli/diag.ts:242`）、SEA 双击 GUI（`src/cli.ts:74`）在 daemon 存活期间挂起不退出。b84a32d（2026-10-28）引入，被审快照已含。

**缺的证据**：运行时复现——一个 6 行探针（spawn detached `sleep 3` + pipe stderr + unref，父进程只挂 unref 的 1.5s 定时器，看是否存活）。沙箱拒绝了 `node -e` 与写探针文件，未能实测。旁证：本仓库其余全部 detached 拉起（`src/cli.ts:193`、`src/update/install.ts:50,65`、`src/update/webupdate.ts:253`）一律 `stdio: 'ignore'` 或 fd 重定向，仅此处用 pipe；测试全走 fake spawnFn（`test/cli-shared.test.ts`），覆盖不到真实句柄行为。建议合入前补测；若成立，修法是 `child.stderr?.unref()` 或改 fd 重定向到日志文件。
```

</details>
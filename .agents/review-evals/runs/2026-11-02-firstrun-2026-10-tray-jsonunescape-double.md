# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-tray-jsonunescape-double — ✅ 审出

- 考题：win 托盘 JsonUnescape 链尾回填两个字面反斜杠（C# "\\" 才是一个），含反斜杠的值（错误消息里的 Windows 路径）展示成 C:\\Users\…，波及 notes/summary/lastError/更新失败 error 四处；另 notes/summary/error 在 JsonString 已反转义一次后又包一层 JsonUnescape，双重解码会把字面 \t 误伤成 TAB（C:\temp → C:<TAB>emp）
- 关键词：反斜杠=未中，双重=未中，jsonunescape=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-HOEgQF/2026-10-tray-jsonunescape-double.output.txt

<details><summary>模型原文</summary>

```text
发现 4 个问题（前 2 条即该版本后实际补发的修复，已与后续 git 历史对拍确认；后 2 条为独立确证缺陷）。

**1. `RefreshMenu` quick=false 分支漏藏 `_modelItem`（孤儿菜单项）** — ModelDockTray.cs:1183-1207
`_sepQuick/_svcItem/_cliItem` 在 quick=false 时都置 `Visible=false`，唯独 `_modelItem.Visible` 只在 `if (quick)` 内（行 1205）赋值。网关停止后 st=null → quick=false，「默认模型」保持上次可见，成为孤儿项；点击走 `_service/update` → `PostAdmin` 弹「网关未运行」假错误。（对应后续修复 302c01f）

**2. `PollHealth` 在 UI 线程同步做健康探测（5s 周期性冻结）** — ModelDockTray.cs:1019、1021、1032-1046
`_poll` 是 WinForms `Timer`，Tick 在 UI 线程执行；`PollHealth` 同步调 `TrayActions.HealthOk()`（行 1034），内含 2s 超时的同步 HTTP（行 316-324）+ 磁盘读 gateway.json + `Process.GetProcessById`（行 296-301）。网关「半挂」（端口监听但不响应）时托盘每 5s 冻结最长 2s；构造函数行 1021 在 `Application.Run` 前还同步探测一次，启动期同样卡 UI。与文件自述「工作线程跑，不卡托盘消息循环」矛盾。（对应后续修复 3ba4d6e）

**3. 进度窗 `double.Parse` 未指定 InvariantCulture，逗号小数区域设置下整窗失效** — ModelDockTray.cs:1459-1460
`double.Parse(recv.Groups[1].Value)` 走 CurrentCulture；写入方 `src/update/progress.ts:41` 用 `JSON.stringify`，小数点恒为 `.`。在 de/fr/ru 等十进制分隔符为 `,` 的系统上，`"1048576.5"` 中 `.` 被当千位分隔符且末组不足 3 位 → FormatException → 被 `Poll` 的 `catch {}`（行 1486）整体吞掉：下载阶段进度条与文案**永不刷新**（`at`/`percent` 是纯整数不受影响，`received`/`total` 一带小数即挂）。修法：`double.Parse(v, CultureInfo.InvariantCulture)`。（行 1445 同写法但入参恒为整数，安全）

**4. `ShowProgressForm` 跨线程创建 Form 与 Forms.Timer，更新路径进度窗死窗** — ModelDockTray.cs:794-802、1430
更新路径 `ShowStatusResult → StartUpdate → ShowProgressForm` 跑在 ThreadPool（MTA）线程（行 528/532 QueueUserWorkItem）：`new UpdateProgressForm(title)` 在 MTA 线程执行构造函数，`_timer.Start()`（行 1430）把 Forms.Timer 的隐藏窗口创建在**无消息泵的池线程**上——WinForms Timer 的 Tick 只在创建线程泵消息时分发，随后 `Application.Run(_progressForm)` 跑在新 STA 线程也救不回 → 「正在更新到 vX」窗体永远停在初始文案，不轮询 update-progress.json。检查路径（行 522/525，UI 线程调）timer 能 tick，但 `Poll` 触碰归属进度 STA 线程的 `_label/_bar`（行 1467/1472/1478）属跨线程控件访问，仅靠 release 下 `CheckForIllegalCrossThreadCalls=false` 才不炸。正确做法：Form 在自有 STA 线程内 new（对比同文件 `ShowUpdateDialog` 行 864-868 就是线程内构造）。

**存疑**
- `RunCliWithWatchdog` 行 629 `p.Kill()` 不杀子进程树（Windows 无信号语义，本仓库自约定 `taskkill /T /F`，见 gatewaycmd.ts）——若 CLI 在 check/reset 中 spawn 子进程会留孤儿；未验证 CLI 是否有子进程，不确认。
- 行 330 把 admin token 拼进 URL query，经 `--app=` 注入浏览器进程命令行，进程列表可读——与 `src/gateway/main.ts:48` consoleBanner 同形，属既有设计取舍，标 [存量]。

其余核对项（`admin_token` 字段名、全部 `/_modeldock/*` 端点、`MODELRDOCK_TRAY_AUTOSPAWN`、`_gw` 不可变快照并发模型、JsonUnescape 占位符回填、`RunCliWithWatchdog` 异步排空）均与 src/ 现状一致，未发现问题。
```

</details>
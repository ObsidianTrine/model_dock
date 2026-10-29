# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-tray-mutex-gc — ✅ 审出

- 考题：win 托盘单实例 Mutex 是局部变量、GC.KeepAlive 写在 Application.Run 之前——进入消息循环后局部变量即成死引用，GC 回收句柄后命名 Mutex 销毁，之后每次双击都再起真实例、托盘叠出多个图标
- 关键词：keepalive=中，mutex=中，gc=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-RycX9J/2026-10-tray-mutex-gc.output.txt

<details><summary>模型原文</summary>

```text
发现 4 个问题（其中第 1 条即后来 cbb9265 修复的那个真实 bug；已对照仓库历史与当前代码逐条核实）。

## 1. 单实例 Mutex 是局部变量，进入消息循环后可被 GC 回收（本次修复的目标 bug）
`scripts/tray/ModelDockTray.cs:35` — `var mutex = new Mutex(true, "Local\\ModelDockTray", out owned)` 存局部变量；`ModelDockTray.cs:43` 的 `GC.KeepAlive(mutex)` 位于 `ModelDockTray.cs:50` 的 `Application.Run(ctx)` **之前**。此后局部变量对 JIT 即死引用，托盘每 5s 轮询（WebRequest 等分配）触发 GC 后 Mutex 被回收、finalizer 关闭句柄，命名 Mutex 随之销毁——单实例守卫静默失效，之后每次双击都拉起真实例、托盘图标越叠越多（每次还各自 EnsureGateway / 弹控制台）。仓库历史确认：`cbb9265`「win 托盘单实例 Mutex 改 static 持有——GC.KeepAlive 原写在 Application.Run 之前，进入消息循环后局部变量即成死引用……托盘叠出多个图标」与此完全吻合。

## 2. CheckViaCli 注释声称「40s 看门狗」但代码没有任何看门狗，CLI 挂死则更新菜单永久置灰
`scripts/tray/ModelDockTray.cs:297` 注释写「40s 看门狗防 CLI 真挂住后永久沉默」，但 `ModelDockTray.cs:322-323` 是无超时的 `ReadToEnd()` + `p.WaitForExit()`。CLI 挂住 → `FinishCheck()` 永不执行 → `_checkingUpdate` 恒为 true → `ModelDockTray.cs:813-816` 的更新菜单永远显示「检查中…」并置灰，直至托盘重启。**[存量]**（052cf78 引入，已核实当前文件 `ModelDockTray.cs:540/565` 仍未实现）。

## 3. stdout/stderr 顺序同步 ReadToEnd 有经典管道死锁风险（同类 2 处）
`scripts/tray/ModelDockTray.cs:321` — 先 `StandardOutput.ReadToEnd()` 再 `StandardError.ReadToEnd()`：若 CLI 在 stdout 未关闭期间向 stderr 写满管道缓冲（默认约 4KB），子进程阻塞在 stderr、父进程阻塞在 stdout，互等死锁——后果同第 2 条且看门狗（本就不存在）也救不了。同类还有 `ModelDockTray.cs:545`（StartCleanCli）。应异步双读或 `ReadToEnd` 并行。**[存量]**

## 4. 进度小窗在调用方线程创建，ThreadPool 路径下自轮询 Timer 永远不触发，进度窗冻结
`scripts/tray/ModelDockTray.cs:483-484` — `new UpdateProgressForm(title)` 在**调用方线程**构造，而 WinForms `Timer`（构造函数内 `_timer.Start()`，`ModelDockTray.cs:877`）只在创建线程有消息泵时才会 Tick。两条「立即更新」路径都在 ThreadPool 线程调用它：`ModelDockTray.cs:262→288→370`（CheckViaGateway→ShowStatusResult）与 `ModelDockTray.cs:266→342`（CheckViaCli）——MTA 池线程无泵，`Poll()` 每秒自轮询不生效，进度窗停在「正在准备更新…」，下载百分比/阶段/失败弹窗（`ModelDockTray.cs:880-934`）全不出来。仅菜单入口 `ModelDockTray.cs:256/259`（UI 线程调用）时 Timer 能走，但那时 Poll 又在 UI 线程摸另一 STA 线程的控件（release 下靠无跨线程检查侥幸工作）。**[存量]**（已核实当前文件 `ModelDockTray.cs:726` 仍是调用方线程创建）。

## 存疑

- **`_port`/`_token` 静态字段无同步竞态**（`ModelDockTray.cs:124` 先置 null 再赋值；UI 轮询、启动双循环、ThreadPool 检查多线程并发调 `ReadState`/`HealthOk`）：机制确凿，但窗口极窄、后果轻（health 假阴性下一轮自愈；极小概率 `ConsoleUrl` 拿到 null 拼出坏 URL 弹错窗口）。缺一份并发时序复现，故不入正式清单。
- **`double.Parse`/`ToString("F1")` 文化敏感**（`ModelDockTray.cs:906-907,918`）：逗号小数区域下 MB 显示错乱，仅展示层。
- **`Process.GetProcessById` 只验 PID 存活不验进程身份**（`ModelDockTray.cs:134`）：PID 复用可误判，但有 health 探活兜底，单独不构成可观察故障。
```

</details>
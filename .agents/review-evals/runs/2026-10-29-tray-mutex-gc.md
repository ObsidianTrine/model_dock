# 审查评测报告

- 考题：1，审出：1，未审出：0
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-tray-mutex-gc — ✅ 审出

- 考题：win 托盘单实例 Mutex 是局部变量、GC.KeepAlive 写在 Application.Run 之前——进入消息循环后局部变量即成死引用，GC 回收句柄后命名 Mutex 销毁，之后每次双击都再起真实例、托盘叠出多个图标
- 关键词：keepalive=中，mutex=中，gc=中
- 完整输出：C:\Users\81424\AppData\Local\Temp\modeldock-review-eval-jkuMsL\2026-10-tray-mutex-gc.output.txt

<details><summary>模型原文</summary>

```text
## 发现 3 个问题

### 1. [P0] 托盘单实例 Mutex 会被 GC 回收，之后每次双击都再起一个真实例 — `scripts/tray/ModelDockTray.cs:35,43,50`

**证据**：`var mutex = new Mutex(true, "Local\\ModelDockTray", out owned)` 是局部变量（line 35）；`GC.KeepAlive(mutex)` 写在 line 43，而 `Application.Run(ctx)` 在 line 50。

**机制**：`GC.KeepAlive` 只把对象的存活期延长到调用点为止。line 43 之后 `mutex` 再无任何引用，JIT 视为死引用——进入消息循环期间 GC 一旦回收 Mutex，其 SafeWaitHandle finalizer 关闭句柄，命名 Mutex 随之销毁。此后每次双击快捷方式 `owned=true`，`Main` 走第一实例分支再 `Application.Run` 一个 TrayContext，托盘区叠加多个图标；`!owned` 分支的「只弹控制台」语义完全失效。这正是 cbb9265 修复的 bug（commit message 记录了 2026-10 Windows 多图标报障，改法是把 Mutex 提升为 static 字段进程级保活）。

### 2. [P1] CheckViaCli 注释声称的「40s 看门狗」不存在，CLI 挂住则检查状态永久卡死 — `scripts/tray/ModelDockTray.cs:297-298, 317-323`

**证据**：line 297 注释写「40s 看门狗防 CLI 真挂住后永久沉默」，但代码中 `p.WaitForExit()`（line 322）无任何超时参数，整个方法里也没有 Stopwatch/定时取消等任何看门狗实现。

**后果**：`modeldock update --check` 若因网络挂住不退出，这个 ThreadPool 线程永久阻塞，`FinishCheck()`（line 272）永远不执行 → `_checkingUpdate` 恒为 true → 托盘菜单「检查中…」永久置灰（line 814/816），且不弹任何结果窗。注释明确承认了挂住场景（"防 CLI 真挂住"）却承诺了一个不存在的保护——按 REVIEW.md「文档与代码行为不一致 = 失败」。

### 3. [P2] stdout/stderr 顺序 ReadToEnd 管道死锁（同类 2 处）— `scripts/tray/ModelDockTray.cs:321-322`、`545-546`

**证据**：两处均为 `p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd()` 之后再 `WaitForExit()`。先阻塞读完 stdout 才碰 stderr。

**机制**：.NET Framework 匿名管道缓冲约 4KB。若子进程在关闭 stdout 之前往 stderr 写了超过缓冲区的数据，子进程阻塞在 stderr write、永不退出，父线程永远卡在 stdout 的 ReadToEnd——经典双流死锁。`reset --yes --deep`（line 545 处）输出量大、更易触发；后果是清理完成的提示窗永不出现。应先并发读两流（BeginOutputReadLine 或异步读），读完后才 WaitForExit。

## 存疑

1. **UI 线程同步健康检查可能冻结托盘** — `scripts/tray/ModelDockTray.cs:742-745, 756-766`：`PollHealth` 每 5s 在 UI 线程跑 `HealthOk()`（内含 2s 超时的同步 HTTP GET），构造器里还有一次。仅在「pid 存活但 health 端点挂起」的坏状态下会每 5s 冻结 UI 至 2s；正常上下（网关健在/网关完全没起）都很快。缺实际体感证据，不升级为问题。
2. **中文标记匹配 CLI 输出，英文环境可能误报失败** — `scripts/tray/ModelDockTray.cs:329,334`：`text.Contains("已是最新")` / `Contains("有新版本")` 依赖 CLI 中文输出。托盘自身是双语的（后续提交 cc64c6b 可见），若 CLI 输出随 locale 切英文，会全部落进「检查更新失败」分支弹错窗。CLI 输出是否随 locale 切换在本文件外，缺证据，列为存疑。

**复核说明**：`MODELRDOCK_HOME`（line 116）初看像拼写错误，但已核对 `src/util/paths.ts:10` 用同名环境变量，两边一致，不是 bug；六条 P0 红线（端口 8687/8890、硬编码路径、绕过 atomicWrite、import.meta.url、native addon、cli.ts 分发）均不涉及此文件。
```

</details>
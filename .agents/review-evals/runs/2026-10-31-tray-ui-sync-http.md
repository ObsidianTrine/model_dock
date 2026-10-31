# 2026-10-tray-ui-sync-http — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent
- 关键词：冻结=中，同步=中
- 结论：发现 3 个问题。问题 1 即目标缺陷（Timer tick 在 UI 线程同步 HealthOk 2s 超时 HTTP + 磁盘读，半挂时每 5s 冻结最长 2s；按约定词逐处核对找出矛盾点，构造函数首轮同步跑一轮也算）；真修归属核对到任务卡 26（SynchronizationContext.Post 回传 + _pollBusy 防重叠，当前版 :1042-1083）
- **评测循环产出的活 bug（当前版仍未修）**：问题 2——其余 UI 线程同步网络/等待位点（主线程 Application.Run 前同步等网关就绪最长 14s 图标假死、QuitClicked 同步 HealthOk 2s）；**问题 3（重）——UpdateProgressForm 的 WinForms Timer 在错误线程创建/启动**：「立即更新」主链路（ThreadPool 工作线程 :686 → ShowProgressForm :801-809）下 Timer 绑在无消息泵的池线程，Poll 一次都不执行 → 进度窗永远停在「正在准备更新…」、更新失败时用户得不到任何提示（:865-889 的 ShowUpdateDialog 已给出正确范式，修法同型）。→ 已立卡 29

## 目标缺陷证据（摘）

> - :1025-1028：_poll.Interval = 5000 的 WinForms Timer（UI 线程 tick）→ PollHealth()；:1039-1053 同步 TrayActions.HealthOk()（req.Timeout = 2000）+ ReadState() 磁盘读。
> - 线程约定矛盾：:479「工作线程跑，不卡托盘消息循环」、:505、:564 同款承诺，PollHealth 是违背者。
> - 网关「接受连接但不响应」时每 5s 冻结消息循环最长 ~2s，菜单展开/点击/tooltip 全卡。

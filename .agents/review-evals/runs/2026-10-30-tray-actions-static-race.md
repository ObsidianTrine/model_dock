# 2026-10-tray-actions-static-race — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent
- 关键词：静态=中，竞态=中
- 结论：发现 5 个问题。问题 1（严重）即目标缺陷——ReadState（:278）先 `_port = _token = null` 再读文件回填，调用方遍布 UI 线程（5s Timer :1008/:1009、每 tick 两次进入窗口）、ThreadPool（:405/:469）、EnsureGateway 后台线程（:71/:76）；竞态窗口内读者拿到 null 拼出 `http://127.0.0.1:/…`（.NET 解析为默认端口 80，已实测）→ **QuitClicked（:1364）HealthOk 误 false 跳过 gateway stop，点「退出并停止网关」后托盘退出而网关仍在运行**；引当前版不可变 GatewayInfo + volatile 快照修复佐证
- 同场新收获：问题 4 = RefreshMenu quick=false 漏隐藏 _modelItem（当前版仍在）；问题 5 = PollHealth 在 UI 线程同步 HTTP（2s 超时），与文件自身「不卡托盘消息循环」约定矛盾（当前版仍在）

## 目标缺陷证据（摘）

> - :264 字段、:278 `_port = _token = null`、:290-291 两步赋值；读者窗口遍布 :302/:315/:405/:425/:469/:503。
> - 任一线程在 :278 清空后插入，读者拿到 null；两线程交错赋值还会出现 port/token 半新半旧错配。
> - 最重后果链：QuitClicked :1364 HealthOk 误 false → 跳过 gateway stop 直接退出，网关残留运行。

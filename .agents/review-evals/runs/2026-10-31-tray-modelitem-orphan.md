# 2026-10-tray-modelitem-orphan — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent
- 关键词：modelitem=中，孤儿=中
- 结论：发现 2 个问题。问题 1 即目标缺陷且证据链完整——快捷区 Visible 成组声明的全集（菜单插入顺序 1145-1148 行核对）+ 全文件对 `_modelItem.Visible` 的唯一赋值点仅在 if(quick) 分支内（1212 行）+ 构造默认 Visible=true → quick=false 时从不置回 false；后果链：网关停止后「默认模型」带过期模型列表残留，点击 → QuickAction → ReadState 失败 → 假错误弹窗；RefreshMenu 由菜单展开与 5s 轮询共用，孤儿状态每次刷新复现。问题 2 = PollHealth UI 线程同步 HTTP（与本评测集 tray-ui-sync-http 题交叉印证，同批修复）
- 佐证：当前版 1224 行已补 `_modelItem.Visible = false;`（302c01f）

## 目标缺陷证据（摘）

> - 1189-1191 行：_sepQuick/_svcItem/_cliItem 三个邻居双向设置；1212 行 _modelItem.Visible 只在 if(quick) 分支内，quick==false 时从不置回 false。
> - 后果链：quick 变 false——「当前服务」「客户端接入」、分隔线全部隐藏，唯独「默认模型」仍带着过期模型列表显示，点击弹「操作失败：网关未运行…」假错误。

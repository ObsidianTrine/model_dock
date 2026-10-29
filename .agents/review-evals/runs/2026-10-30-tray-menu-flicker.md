# 2026-10-tray-menu-flicker — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同）
- 关键词：clear=中，重建=中
- 结论：发现 4 个问题。问题 1 即目标缺陷——PollHealth 5s tick 在 `_menu.Visible` 时调 BuildMenu() 整份 Clear+重建（行 1019/1026-1027），悬停/展开态被重置；问题 2 = CheckViaCli 按中文子串分类 CLI 输出（英文环境下 exit==0 被当失败弹窗、有新版也不弹更新窗——i18n 类新发现，仓库无人知道过）；问题 3 = 40s 看门狗注释撒谎 + 双管道顺序 ReadToEnd 死锁隐患；问题 4 = UI 线程同步网络等待

## 目标缺陷证据（摘）

> - `PollHealth()` 由 5s 定时器驱动（992-995、1006-1020），行 1019 `if (_menu.Visible) BuildMenu();`——菜单开着时每 5 秒触发一次 BuildMenu()；
> - 而 `BuildMenu()` 行 1026-1027 `menu.Clear()` 后全量重加所有项。对正在显示的 ContextMenuStrip 执行 Clear+重建，用户悬停高亮被重置、已展开的子菜单被强制收起，观感一闪一闪。
> - 当前版 1dd6b1c 将其改为 diff 式 UpdateMenu()，注释「打开中的菜单不再整份 Clear 重建」。

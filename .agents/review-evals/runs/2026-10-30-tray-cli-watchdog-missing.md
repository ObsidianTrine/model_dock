# 2026-10-tray-cli-watchdog-missing — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent
- 关键词：看门狗=中，40s=中
- 结论：发现 4 个问题。问题 1 即目标缺陷——L540 注释承诺「40s 看门狗」但 L560-568 是裸 ReadToEnd+WaitForExit 无任何超时；`_checkingUpdate` 唯一复位点排在等待之后，CLI 挂住则更新菜单永久「检查中…」置灰、进度窗永不关闭；并指出 L564 顺序 ReadToEnd 是经典管道死锁（stderr 满 4KB 互等）、StartCleanCli 同模式第二处。引 b338cb1 的 RunCliWithWatchdog（超时 kill + Begin*ReadLine 并行排空）佐证
- 同场互证：问题 2 = 中文子串分类（与本评测集 2026-10-tray-cli-lang-substring 题交叉印证）；**新活 bug**：问题 4（低危，当前版仍在）——RefreshMenu 在 quick=false 时隐藏 _sepQuick/_svcItem/_cliItem 唯独漏了 _modelItem，网关停止后菜单残留「默认模型」孤儿项，点击弹假错误

## 目标缺陷证据（摘）

> - L540「40s 看门狗防 CLI 真挂住后永久沉默」，L560-568 是 ReadToEnd() + ReadToEnd() 后无参 WaitForExit() 裸等——不存在任何看门狗。
> - _checkingUpdate 在 L501 置 true，唯一复位点 FinishCheck 全部排在等待之后；CLI 一旦不退出：更新菜单永久「检查中…」置灰，直至托盘重启。

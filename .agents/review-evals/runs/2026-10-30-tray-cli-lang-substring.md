# 2026-10-30-tray-cli-lang-substring — 审查跑分原文

- 考题：cases/2026-10-tray-cli-lang-substring.json（reviewRef 88aa417^1，fixedBy 88aa417）
- 评分器：ZCode 会话模型 subagent（GLM-5.3-Flash），2026-10-30
- 判定：✅ 审出（顶层「发现 3 个问题」+ 5 存疑）

## 原文要点

**1（主缺陷命中）CheckViaCli 按中文子串分类 CLI 输出**——:572/:577 Contains("已是最新")/Contains("有新版本")；CLI 语言链 --lang > MODELRDOCK_LANG > config.toml > zh（:128-130 自述托盘继承 MODELRDOCK_LANG 可为 en，:137-139 DetectZh 认 en 合法），而 :549-559 spawn 既不传 --lang 也不设 MODELRDOCK_LANG，子进程输出语言不受控。英文时 exit==0 双双落空 → 当失败弹窗；有新版分支不可达。:845 CurrentVersion 只认「当前 v」同病。修复方向：双语匹配或给子进程钉语言（与本仓实际修复 --json 结构化同向）。

**2 注释承诺的 40s 看门狗不存在**——:540 注释 vs :541-593 无任何定时器，ReadToEnd+WaitForExit 无限阻塞；CLI 挂死 → _checkingUpdate 恒 true → 菜单永久置灰、进度窗永不关，仅重启托盘可解。（对旧版报的此条已被 88aa417 修复。）

**3 JsonUnescape 把字面反斜杠翻倍**——:654 消耗 `\\`（一个反斜杠）链尾却回填两个；含反斜杠的值（错误消息 Windows 路径）展示成 C:\\Users\\…，波及 notes/summary/lastError/更新失败 error 四处。（复核注：当前版 :725 仍在——立卡 20。）

## 存疑（节选）

_port/_token 竞态（对旧版报，已被 88aa417 修复）；串行 ReadToEnd 死锁风险（已被修复）；启动期 OpenConsoleWhenAlive 最长 ~14s UI 冻结；JsonEscape 不转义控制字符。

## 后续

发现 3 立卡 20-tray-jsonunescape-backslash。

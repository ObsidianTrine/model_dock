# 首跑报告 — 2026-10-tray-win32-basename

- **日期**: 2026-10-30（v1.5.1 发布周期事故回流批，batch3）
- **评分器**: ZCode 会话模型 subagent（GLM-5.3-Flash），tool-free（禁读仓库/git 防剧透），prompt 由 `node scripts/review-eval.mjs --dry --case 2026-10-tray-win32-basename` 组装（REVIEW.md + src/update/install.ts@d6c0a9f^ 全文）
- **结果**: ❌ 未审出（expect 关键词 win32 / 反斜杠 / posix 均 0 命中；目标缺陷 path.basename 平台语义未进视野）
- **判读**: 报了 4 个问题 + 5 条存疑，全部真实但都不是目标——:77 未闭合引号 slice(1,-1) 截尾漏识别、:277/:298 回滚失败 `.catch(() => {})` 静默（违背模块自述「失败不再静默」纪律）、:362 幻影路径计入 removed、unix 枚举失败即 break 放弃按 PID 杀 + :207 win 专属文案给 mac 用户。目标 :79 `path.basename` 对 CIM 反斜杠输入的平台语义（POSIX basename 不切反斜杠 → 非 Windows 宿主整类不命中）完全没被提到——审查者逐行抠了引号解析（:77，紧邻目标行）却没问「这个解析函数跑在哪个平台、输入是什么平台的路径格式」。
- **价值**: 首道「平台解析」类考题漏报实录。REVIEW.md 现有平台条目只覆盖测试侧（NTFS 权限断言/写死 /tmp），没有「解析 Windows 专属文本须用 win32 语义 path API / 不依赖宿主平台 path 行为」的口径——堵法待下次全量跑分一并落地评估（单独改 REVIEW.md 会触发全量重跑纪律，不随本批零散改）。没审出的题才是最有价值的题：本题定位了审查者的盲区形状。
- **出题侧记录**: 单题耗时 ~15.3 分钟 / 77.6k tokens。

## 模型原文

发现 4 个问题

**1. [中高] src/update/install.ts:149、177-207 — unix/mac 上停托盘存在"枚举失败即放弃 + 拿到活 pid 也不补杀"的功能缺口，且失败文案把 Windows 专属行为说给 mac/linux 用户**

- 行 147-149：`if (pids == null)` 时 unix 直接 `break`——第一遍枚举失败就跳出循环，**从未尝试杀托盘**。行 148 注释只论证了"unix 无映像名强杀等价物"，但 `break` 放弃的是整个循环（含 unix 完全可用的按 PID 杀）。
- 行 177-181、207：终验重新枚举。若枚举恢复并返回**活 pid**，行 192 `if (isWin)` 之后的 unix 落径只打警告（行 207），不调用行 115 已就绪的 `kill`（行 90 契约明确 unix=SIGTERM 可用）。此时托盘带病进入换包流程（mac .app 换名后旧托盘从 `.old` 继续运行，随后 `open` 拉起新托盘，出现双托盘/网关争用）。
- 行 207 文案"向导将尝试强制关闭；也可手动退出托盘后重试更新"：unix/mac 流程没有 Inno 向导（mac 用 `open`，行 30-31；bare 直接拉起），该 Windows 专属文案在 unix 上是"撒谎"（203 行同一文案用于 win 是正确的，属复制粘贴未分叉）。

**2. [中] src/update/install.ts:277、298（同类还有 281）— 关键回滚失败被 `.catch(() => {})` 完全静默，违背本模块自述纪律**

- 行 276 注释自述"新包落位失败必须回滚，否则系统里没有可用的 ModelDock.app"，但行 277 `await fsp.rename(oldApp, appRoot).catch(() => {})` 把**回滚本身失败**吞成无痕；installBareBinary 行 298 同款。一旦回滚失败，机器上既无新包也无旧包，且更新日志零痕迹——直接违反本文件行 28/106 反复强调的"失败不再静默"（正是 2026-10-27/28 两次事故的教训）。至少应写日志/作为主错误上报。行 281 的 chmod 兜底失败同样无痕（新主程序可能无执行位，`open` 必败且无诊断）。

**3. [低] src/update/install.ts:362-364 — `cleanOldVersions` 把从未存在的路径也计入 `removed`**

`fsp.rm(c, { recursive: true, force: true })` 对不存在的路径静默成功（不抛错），随后 `removed.push(c)` 无条件执行。候选里的托盘 `.old`（行 357）在多数机器上根本不存在，却会出现在返回的"已清理"清单里，调用方据此打印会列出幻影文件。应以 `fs.existsSync` 先判存在或捕获后区分 ENOENT。

**4. [低] src/update/install.ts:77 — 未闭合引号的命令行解析错位，漏识别托盘 pid**

`cmd.slice(1, cmd.indexOf('"', 1))` 在 `indexOf` 返回 -1 时等价于 `slice(1, -1)`，截掉首引号和**末字符**，产出错误 exe token（如 `...ModelDockTray.exe` 变 `...ModelDockTray.ex`），正则不中 → 漏杀。win 有映像名强杀兜底，unix 无（见问题 1）。应先判 `idx === -1` 走非引号分支。误杀面不受影响（只会漏，不会多杀）。

存疑

- **detectInstallShape 第 4 参的调用点接线**：行 242 `hasUninstaller = false` 默认值是个"静默失效"陷阱——若 run.ts 等调用方未传 `hasWindowsUninstaller(execPath)`，行 252-253 的自定义目录兜底（D:\Programs 事故修复）在生产上形同虚设。调用点代码未给出，无法确证。
- **killByPid 的 unix 实现是否按进程组杀**：行 164 只防了 Windows `taskkill /T`（更新器是托盘子进程）；若 `cli/shared.js` 的 unix 分支用 `kill(-pid)`/进程组语义，杀托盘会连带杀掉更新器本身，同根问题在 mac 复发。需 shared.js 源码佐证。
- **spawn 无 'error' 监听**（行 50、58、65）：spawn ENOENT 会以 uncaught exception 崩掉更新器；默认实现下拉起对象（cmd.exe/open/新装托盘）按构造应存在，风险偏理论。
- **installMacApp 跨卷 rename**：staging 与 `/Applications` 不同卷时 rename 抛 EXDEV（会走回滚，属可见失败非静默）。需 run.ts 的 stagingDir 落点佐证是否恒同卷；若同卷则不成立。
- **stopGateway 的 KeepAlive 承诺**：行 25 注释称"先卸自启服务防 KeepAlive 拉锯"，实现仅转调 `cmdGatewayStop()`，是否确先卸自启需 gatewaycmd.ts 确认。

红线自查：无 8687/8890、无硬编码 `~/.modeldock`、无绕过 atomicWrite、无 import.meta、无 native addon、三路分发未涉及。

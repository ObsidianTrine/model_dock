# 审查评测报告

- 考题：1，审出：1，未审出：0
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-update-shape-customdir — ✅ 审出

- 考题：win 安装器装到自定义目录（如 D:\Programs\ModelDock）被 detectInstallShape 误判 win-bare——自更新退化成裸 zip 替换，托盘永不更新（用户实证 v1.2.1→v1.2.2 托盘停旧版）
- 关键词：detectinstallshape=未中，bare=中
- 完整输出：C:\Users\81424\AppData\Local\Temp\modeldock-review-eval-BApRJV\2026-10-update-shape-customdir.output.txt

<details><summary>模型原文</summary>

```text
## 发现 4 个问题

**#1 即该版本之后 d1d3eab 修复的目标缺陷**；#2–#4 为同文件内其它可确证的问题，均有仓库后续修复提交与用户实证佐证。

---

### 1. [核心] win 安装器装到自定义目录被误判 `win-bare` → 托盘永不更新
`src/update/install.ts:111,113`（同族还有 :110）

- 111 行：win-setup 判定只认 `localAppData + '\Programs\ModelDock'` 这一个前缀。`scripts/installer.iss:20` 的 `DefaultDirName={localappdata}\Programs\ModelDock` 只是**默认值**，Inno 向导允许用户改目录（无 DisableDirPage 拦截），安装目录不是常量。
- 113 行：前缀不匹配一律落 `win-bare`。
- 失败路径（用户实证：装在 `D:\Programs\ModelDock`，v1.2.1→v1.2.2）：形态误判 → 自更新走裸二进制替换。该版本裸路径只换主 exe、不带托盘（裸形态带托盘是更晚的 eafef73 才引入）→ 主程序更新、**托盘永远停旧版**，且跳过安装器登记。webupdate.ts 同用此判定选资产体积基线，一并选错。
- 同类还有：110 行 `localAppData ?? 'C:\Users\u\AppData\Local'` 占位默认——调用点若漏传 LOCALAPPDATA（d1d3eab^ 的 run.ts 注释已自陈此险），真机路径永远不匹配占位前缀，同样落 win-bare。根源是「按路径前缀枚举现实安装形态」，前缀法对用户可改的安装目录必然有漏。
- 已确证：d1d3eab 以 `unins000.exe` 卸载器指纹（`hasWindowsUninstaller`）兜底修复，run.ts/webupdate.ts 两调用点同传。

### 2. [误杀窗口] 托盘匹配按整条命令行子串，而非可执行段
`src/update/install.ts:73,76`

- 73 行正则 `/ModelDockTray(\.exe)?(\s|$|")/i` 对 `parsePidCommandLines` 给出的**完整命令行**做无锚点子串匹配，76 行随后直接 `killByPid`。docstring 声称「按命令行精确匹配」不成立。
- 反例：`powershell -c "Get-Process ModelDockTray"`、`grep ModelDockTray app.log`、任何以 `ModelDockTray` 结尾作参数的进程，只要子串后跟空白/行尾/引号即被 taskkill。命中 REVIEW.md 更新域的「强杀误伤无辜进程」。
- 后续提交改为取首 token + basename 精确 `^ModelDockTray(\.exe)?$` 匹配，注释自陈收敛误杀面（「grep ModelDockTray … 之类以它作参数的进程不误杀」）——确认此为真实缺陷。

### 3. [半成品/整机失联] 静默安装命令的三个失败面
`src/update/install.ts:180-184`

- a. **失败零可见**：`/VERYSILENT /SUPPRESSMSGBOXES` 且无 `/LOG`——安装中途失败无任何痕迹。2026-10-27 用户实证三连败：unins000 已重写而主程序未换（半更新状态），错误框被吞，表现为「托盘没了、网关不回、无任何提示」。
- b. **失败无兜底**：`&& start "" "${trayPath}"` 只在 setup 成功时拉托盘；退出码非 0 时托盘不拉、网关已停、更新器已退——整机失联。后续改为 `||` 拉回旧托盘兜底。
- c. **落点不钉死**：无 `/DIR` 参数，落点依赖注册表 UsePreviousAppDir 记忆；注册表被清理软件删除或用户搬过安装目录时，静默装落回 DefaultDirName，制造第二份安装（df4e38e 修复确认）。

### 4. [残留进程] 停托盘「尽力而为、失败静默、零验证」
`src/update/install.ts:70,76,78-80`

- 70 行：进程枚举不可用（`!lines`）直接静默返回，托盘带文件锁活到安装；
- 76 行：`killByPid` 返回值丢弃——杀没杀掉无从知晓，也不复查；
- 78-80 行：整体 `catch {}` 吞掉一切异常。
- 用户实证（2026-10-27/28 三次更新全中）：托盘带锁存活 → Inno RM 只能优雅关闭，无窗口托盘收不到关闭消息、30s 超时 → Abort/Retry/Ignore「无法自动关闭所有应用程序」→ 安装卡死。后续 22f20fd/e4ac854 改为「杀→复查→补刀」两遍式+全程日志+映像名兜底强杀。（e4ac854 定位的另一元凶是 shared.js 的 CRLF 解析致枚举恒空，在本文件范围外，不在此报。）

---

## 存疑

1. `src/update/install.ts:151-152` — `fsp.rm(old)` 失败被吞后紧接着 `rename(targetBin, old)`：Windows 下若 `.old` 被上一版残留进程锁住（rename dance 恰恰围绕「运行中 exe 不可删」设计），rm 静默失败后 rename 目标存在且被锁 → 更新直接抛错中止，无重试/换名兜底。机制成立，但触发需要「上一版进程在下次更新时仍存活」，缺该场景发生率的实证，故存疑。

（曾疑 93 行 `appRootFromExecPath` 丢失路径大小写，复查确认：`toLowerCase()` 仅用于定位 idx，切片作用于原样 `norm`，大小写保留——不报。）
```

</details>
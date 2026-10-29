# 审查评测集（review evals）

> 设计来源：Anthropic《How the Claude Code team does code review》的改进闭环——
> **每次事故 / 回滚都变成一道考题**：收集真实逃过审查的 bug，让审查者对着它跑分；
> 审查者的任何改动（REVIEW.md、workflow prompt、lint、模型）都先在全量考题上重跑，分数升了才保留。

## 目录结构

- `cases/*.json` —— 考题。一道题 = 一次真实逃过审查的 bug。
- `scripts/review-eval.mjs`（仓库根 scripts/）—— 运行器：物化修复前代码 → 组装审查 prompt → 交给本地 claude CLI → 按 expect 关键词打分。

## 考题 schema

```jsonc
{
  "id": "2026-10-update-stoptray",      // 唯一 id，日期前缀
  "title": "一句话说清这个 bug 造成的用户可见后果",
  "reviewRef": "22f20fd^",              // 审查对象：修复提交的父提交（bug 当时在场的代码状态）
  "fixedBy": "22f20fd",                 // 实际修复提交，供回溯
  "files": ["src/update/install.ts"],   // 让审查者看的文件（从 reviewRef 物化）
  "expect": ["stoptray", "tray"],       // 打分关键词：审查输出命中即算「审出了」（小写比较）
  "note": "根因与来源，写清为什么当时漏过"
}
```

## 怎么加新考题（事故 / 回滚之后必做）

1. 找到修复提交 `<fix>`，`reviewRef` 填 `<fix>^`（bug 在场的最后一个状态）；`files` 填根因所在文件。
2. `expect` 填根因关键词（函数名 / 特征串），宽松一点没关系——打分是启发式，精确判定看模型原文。
3. `note` 写清为什么当时的流程没拦住（哪一层的洞），对应的堵法落进 REVIEW.md / lint / prompt。
4. 跑一次确认能复现「审出」或「没审出」，如实记录——没审出的题才是最有价值的题。

## 怎么跑

```bash
node scripts/review-eval.mjs --dry                 # 只打印组装好的 prompt，不调模型
node scripts/review-eval.mjs                       # 全量跑（走本地 claude CLI 与其已配端点）
node scripts/review-eval.mjs --case 2026-10-update-stoptray
node scripts/review-eval.mjs --model deepseek-v4-pro   # 透传给 claude --model
node scripts/review-eval.mjs --timeout-min 25      # 单题超时（默认 15 分钟；超时/报错记「运行失败」继续其余题）
node scripts/review-eval.mjs --out eval-report.md  # 报告落盘（默认只打印 stdout）
```

- 前置：本机装有 `claude` CLI 并已登录 / 配好端点（脚本只透传环境，不自带 key）。
- 打分是**启发式**（关键词命中），只作趋势参考；是否真审出，看报告里附的模型原文。
- 频率：事故后随手跑；改了审查者（REVIEW.md / prompt / 模型）之后必跑一次全量。
- 历次报告落 `runs/`（含模型原文；报告里引用的临时目录路径已随清理失效，以原文内嵌为准）。

## 现有考题

| id | bug | fixedBy | 首跑（2026-10-29，claude CLI 2.1.214） |
|----|-----|---------|------|
| 2026-10-update-stoptray | win 更新停托盘「尽力而为」零验证，托盘带锁活到安装向导，RM 30s 超时安装卡死 | 22f20fd | ✅ 审出（P0 定位到根因 + 顺带挖出 HEAD 仍在的 e4ac854 相关问题，见 runs/2026-10-29-first-run.md） |
| 2026-10-diag-darwin-cipher | 跨机密文检测缺 darwin / 无加密形态分支，macOS secrets 表条目漏报 | 53da3e2 | ✅ 审出（证据链完整复现 53da3e2 修复逻辑 + 1 个 [存量] 建议 + 3 条存疑） |
| 2026-10-tray-mutex-gc | win 托盘单实例 Mutex 局部变量被 GC 回收，双击叠出多个图标 | cbb9265 | ✅ 审出（[P0] 精确定位 GC.KeepAlive 在 Application.Run 之前无效，机制+行号齐全，报告见 runs/2026-10-29-tray-mutex-gc.md） |
| 2026-10-update-shape-customdir | 安装器装到自定义目录被 detectInstallShape 误判 win-bare，托盘永不更新 | d1d3eab | ✅ 审出（[核心] 即修复目标，交叉引用 installer.iss DefaultDirName 可改目录 + 占位默认值同险，报告见 runs/2026-10-29-update-shape-customdir.md） |
| 2026-10-cloud-null-body | 请求体 JSON 字面量 null 穿透 parseBody，500 外泄 V8 原文（REVIEW-27 残留） | 78cf650 | ✅ 审出（P1 定位主根因并扫出 5 端点同型点 + 1 个 5MB 请求体额外问题，报告见 runs/2026-10-29-cloud-null-body.md） |
| 2026-10-fsx-idle-flush | appendLine 常驻流池无空闲刷盘，Windows 硬杀丢日志尾 | 0ba0d65 | ✅ 审出（[高] 直接点名硬杀丢日志尾 + Windows 无信号语义，报告见 runs/2026-10-29-fsx-idle-flush.md） |
| 2026-10-backup-prune-race | 快照孤儿清理误删他进程半成品 + recursive mkdir 死代码重试 | a494d81 | ✅ 审出（3 连中：prune 竞争 / restore 自删保护快照 / 死代码重试，报告见 runs/2026-10-29-backup-prune-race.md） |
| 2026-10-route-pin-precedence | 客户端钉住路由被定时窗口/全局当前槽接管，模型发错上游 404 | baa820c | ✅ 审出（[高] 钉定被优先级覆盖，定位 state.ts:483+499-505，报告见 runs/2026-10-29-route-pin-precedence.md） |
| 2026-10-gateway-413-drain | readBody 超限立即 reject 413 + resume 排空，与客户端在途写入相撞，SDK 重试成超大包重传循环，413 永远到不了 | 87549d8 | ✅ 审出（首跑撞旧版跑分器 15min 超时一次，补丁后 full-12 中 ✅，见 runs/2026-10-30-full12-glm53flash.md） |
| 2026-10-cim-crlf-parse | parsePidCommandLines 不剥 \r 行尾，PowerShell CIM 输出（CRLF）全行失配，进程枚举恒空，stopTray 静默空转 | e4ac854 | ✅ 审出（证据链复现修复逻辑 + 正则语义分析；附带存疑发现 daemon stderr 管道钉住 CLI 事件循环，经复现坐实为 CORRECT-07，见 runs/2026-10-30-batch2-2026-10-cim-crlf-parse.md） |
| 2026-10-config-memo-alias | loadConfig memo 外借共享 Config 对象，调用方原地改污染缓存，把同步引擎轮询钉进竞态窗口 | 688f98b | ✅ 审出（批二单题与 full-12 双中，报告见 runs/2026-10-30-batch2-2026-10-config-memo-alias.md） |
| 2026-10-env-port-live | cmdEnv 复用写入链的 resolveClientGatewayPort（生产默认端口存活优先），非默认端口实例 env 恒输出 8687 | 87b2106 | ⚠️ 波动（批二单题 ✅ / full-12 ❌ 未命中目标——但其输出另带 diag.ts 3 个自启残留误报类真发现；03:15 第三次采样 ✅，累计 2/3。关键词启发式局限的实录，各轮原文都见 runs/） |

### 基线记录

- **2026-10-29（claude CLI 2.1.214，Windows 端）**：全量 8/8 审出。
- **2026-10-30（claude CLI 2.1.310 + GLM-5.3-Flash，经沙箱网关 claude-direct→Volces plan）**：全量 12 题单轮 **10/12**（原 8 题 7/8，批二 4 题 3/4）；两题未命中目标但模型输出均含同文件真发现（详见上表 ⚠️ 行）；全部 12 题在跨轮中至少审出一次（cloud-null-body 2026-10-29 ✅；env-port-live 批二单题 ✅）。同模型同考题跨轮波动实测存在，单轮未审出 ≠ 召回失效。**03:15 第三次采样**：两道波动题单题复跑均 ✅（runs/resample-*.md）——cloud-null-body 与 env-port-live 各累计 2/3 命中，波动定性成立（边界题的轮次方差，非系统性漏报）。**04:35 原 8 题第二次采样：8/8 全部审出**（runs/sample2-*.md，约 46 分钟）——核心基线回归满分；cloud-null-body 跨四轮累计 3/4，是全集波动最大的一道题。
- **基线口径（自 2026-10-30 起）**：审查者任何改动（REVIEW.md / prompt / lint / 模型）全量重跑，**单轮 ≥10/12 且原 8 题 ≥7/8** 视为基线保持；跌破则改动不保留，且必须读原文判读是「目标未命中」还是「启发式未命中」。
- 本批同期副产物（夜巡 + 噪音对照实验，详见 runs/2026-10-30-night-summary.md）：**CORRECT-07**（`gateway start --daemon` 就绪后 CLI 不返回，P1）、**CORRECT-08**（jsonpath 括号句式静默写歪键 / star 裸崩，P2）、**CORRECT-09**（relay failover 可观测性三项，P2）——均实测复现、未修；修复后可按「怎么加新考题」回流为考题。新题入库流程（挖题 → dry → 实跑 → 如实记录，未审出照写）见上「怎么加新考题」。

## 噪音测量（clean 对照，2026-10-30 起建立）

参照原论文的第二个评测维度（在已知干净代码上跑审查者、数误报）：选历史稳定文件（如 init 后零改动、扛过多轮全仓审查的 `src/util/diff.ts`、`src/util/jsonpath.ts`），用**中性 prompt**（不断言存在 bug，只要求「确证才报，没有就明说通过」）跑同一审查者。注意与考题 prompt 的差别：考题断言「之后补了一个修复」会诱导找茬，测噪音必须去掉该断言。首测：diff.ts **0 误报**；jsonpath.ts 报 2 个问题——**逐条实证均为真缺陷**（CORRECT-08），不是误报——「干净对照」的挑选本身要经得起审查，被审出的对照文件按其价值转为缺陷记录。**03:20 复跑（runs/noise-jsonpath-rerun.md）**：前两条精确复现（审查者自行读到 known-issues 的 CORRECT-08 登记并标注「已登记」），另报第 3 处同族缺陷（对象上下文用下标写入静默产键 `"0"`，tsx 实测坐实，已并入 CORRECT-08）。噪音报告见 runs/noise-*.md。

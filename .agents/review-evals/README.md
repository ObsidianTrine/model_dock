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

全量 8/8 审出（两批首跑合计）：当前 REVIEW.md + 红线组合对「真实逃过审查的 bug」召回足够——这批题作为回归基线保留，此后任何审查者改动（REVIEW.md / prompt / 模型）全量跑分低于 8/8 即不保留。新题入库流程（挖题 → dry → 实跑 → 如实记录，未审出照写）见上「怎么加新考题」。

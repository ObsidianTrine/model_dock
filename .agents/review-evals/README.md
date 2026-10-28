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

## 现有考题

| id | bug | fixedBy |
|----|-----|---------|
| 2026-10-update-stoptray | win 更新停托盘「尽力而为」零验证，托盘带锁活到安装向导，RM 30s 超时安装卡死 | 22f20fd |
| 2026-10-diag-darwin-cipher | 跨机密文检测缺 darwin / 无加密形态分支，macOS secrets 表条目漏报 | 53da3e2 |

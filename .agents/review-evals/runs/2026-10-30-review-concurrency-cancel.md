# 2026-10-review-concurrency-cancel — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同）
- 关键词：concurrency=中，并发=中
- 结论：发现 3 个问题，问题 1（P0）即目标缺陷——workflow 级 concurrency 组把「全 job skip 的空 run」也计入，bot 自己发评论/inline 标注触发的空 run 会取消进行中的审查（还查到了当时的 Actions run 佐证 40461207257/40461294843）
- **评测循环产出的活 bug（未修复，当前版仍在）**：问题 3（P1）——auto-review/security-review 的 `[dependabot-fix]` 防回环守卫 `git log -1 --pretty=%s` 读到的是 `refs/pull/N/merge` 测试合并提交（subject 形如 `Merge <sha> into <sha>`），`case "[dependabot-fix]"*` 永不命中，防回环是死代码；dependabot-fix 推修复触发的 synchronize 会复审自己的修复。历史 Dependabot PR 无一命中佐证「从未生效」。修法：比较 `github.event.pull_request.head.sha` 对应提交的 subject
- 问题 2 = interactive 缺 claude[bot] actor 排除（同 628fbec 修复）

## 目标缺陷证据（摘）

> - `claude-review.yml:25-28`（workflow 级 `concurrency.group: claude-review-<PR号>` + `cancel-in-progress: true`），配合触发器 20-23 行。
> - PR 上的任何评论——人工回复、bot 自己发出的审查评论/inline 标注——都会创建一个新 run；job 全 skip 的空 run 仍占用同一并发组并取消组内进行中的 run。
> - auto-review 边审查边发 inline 标注，每条标注都可能触发一个空 run 把自己半路杀掉。

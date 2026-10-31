# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-review-concurrency-group — ✅ 审出

- 考题：claude-review 的 auto-review 与 interactive（@claude）两 job 共用并发组 + cancel-in-progress：同一 PR 上一条 @claude 评论会把进行中的 auto-review 取消掉，已烧 token 白费、审查静默丢失
- 关键词：concurrency=未中，cancel-in-progress=中，group=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-JQUaP1/2026-10-review-concurrency-group.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题

**1.（P1，即后来修复的那个）防审查回环守卫是死代码——`git log -1` 读到的是 GitHub 的 test-merge 提交，永远匹配不上 `[dependabot-fix]` 前缀**
- 证据：`claude-review.yml:113-116` checkout 未指定 `ref`，`pull_request` 事件默认检出 `refs/pull/<n>/merge`——HEAD 是 GitHub 合成的测试合并提交，其 subject 形如 `Merge <sha> into <sha>`，不是 PR 尾提交的 subject。因此 `claude-review.yml:121` 的 `msg="$(git log -1 --pretty=%s)"` 与 `claude-review.yml:208`（security-review 同款守卫）的 `case "$msg" in "[dependabot-fix]"*)` 永远不命中。
- 失败场景：dependabot-fix 工作流经 PAT 推上 `[dependabot-fix]` 修复提交后，触发的 synchronize 事件 actor 是 PAT 属主（≠ `dependabot[bot]`，见 `claude-review.yml:91/178` 的排除条件拦不住），auto-review / security-review 照跑——第 25-26 行头注释承诺的「检测到尾提交为该前缀时跳过，防审查回环」完全不生效，bot 会复审自己刚写的修复提交。
- 修法：改读 PR head 提交（如 `github.event.pull_request.head.sha` 单独 fetch 后取 subject，或用 `gh pr view --json commits` 取尾提交消息）。

**2.（P2）auto-review 与 interactive 共用并发组 `claude-review-<n>`，互相取消**
- 证据：`claude-review.yml:95` 与 `claude-review.yml:274` 的并发组同为 `claude-review-${{ github.event.pull_request.number || github.event.issue.number }}`，且都 `cancel-in-progress: true`。security-review 特意用独立组名 `claude-review-sec-`（`claude-review.yml:182`），唯独这两个共用。
- 失败场景：auto-review 烧着 token 审到一半时，任何人在 PR 上发一条含 `@claude` 的评论（interactive 在 `pull_request_review_comment`/`issue_comment` 触发，组名相同）→ 进行中的 auto-review 被取消，已消耗的审查白费；反向同理。

**存疑（缺证据不下结论）：**

- `claude-review.yml:252` 门禁信号可被任意评论污染：`gh pr view --json comments | grep '^SECURITY-VERDICT:' | tail -1` 不区分评论作者，任何能评论的账号（或任何恰好引用该字样、且位于时间序最后的评论）都能把 required check 刷绿。属设计取舍还是缺陷，取决于维护者是否接受「人工评论翻案」；更稳的写法是按 bot 作者过滤。
- `claude-review.yml:167/238` 的 `mcp__github_inline_comment__create_inline_comment` 工具名：本文件未向 claude-code-action 传任何 `mcp_config`，若该名字不是 action 内置 MCP server 提供的工具，inline 标注会静默失效。本机无法验证 action v1 的内置工具清单，repo 运行记录又显示标注似乎工作过，存疑不报。
- `claude-review.yml:268` 的 `github.actor != 'claude[bot]'` 防自触发：自定义 token 接入下 bot 评论的实际 actor 未必是 `claude[bot]`（官方默认值），若 bot 输出中出现 `@claude` 字样可能重入。无实测证据，存疑。
```

</details>
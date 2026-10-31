# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-review-concurrency-group — ✅ 审出

- 考题：claude-review 的 auto-review 与 interactive（@claude）两 job 共用并发组 + cancel-in-progress：同一 PR 上一条 @claude 评论会把进行中的 auto-review 取消掉，已烧 token 白费、审查静默丢失
- 关键词：concurrency=未中，cancel-in-progress=中，group=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-S8v7uM/2026-10-review-concurrency-group.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题（另附 3 条存疑）

## 1. 防回环 guard 读的是 merge commit，不是 PR head 提交（两处同类）

- 证据：`claude-review.yml:121`（auto-review）与 `claude-review.yml:208`（security-review）均用 `git log -1 --pretty=%s` 判断尾提交是否带 `[dependabot-fix]` 前缀；而 checkout 步骤（`:113-116`、`:200-203`）未指定 ref，`pull_request` 事件下 actions/checkout 默认落在测试合并提交 `refs/pull/<N>/merge` 上。
- 失败场景：只要 base 在 PR 存续期间有过新提交（极常见），merge ref 就是一个 merge commit，其 subject 形如 `Merge <sha> into <sha>`——case 分支 `"[dependabot-fix]"*` 永不命中，guard 静默失效，bot 自己推的修复提交照样被 auto-review / security-review 重审。仅当 base 未分叉、merge ref 快进等于 head 时才碰巧正确，即该守卫是**间歇性失效**而非恒常工作。
- 修法方向：直接用事件载荷 `${{ github.event.pull_request.head.sha }}`（注意 `fetch-depth: 1` 下 head 对象未必在本地，靠 `git log` 读 head sha 也不可靠，应取自 `github.event`）。

## 2. security 门禁接受上一轮的陈旧 PASS

- 证据：`claude-review.yml:252` 用 `tail -1` 取全部 PR 评论中最后一条 `SECURITY-VERDICT:` 行，且各轮审查的评论都留存。
- 失败场景：第 1 轮 bot 发 `SECURITY-VERDICT: PASS` → 作者推新提交（synchronize）→ 第 2 轮 bot 静默失败（API 异常、超时未发评论）→ 门禁读到第 1 轮的 PASS，job 通过。与 `:260-262` 对「未产出结论」按失败处理的保守意图自相矛盾——陈旧结论恰好绕开了这层保守。修法方向：只认 head 推送之后创建的评论（按 `created_at` 过滤），或每轮审查前先删旧 verdict 评论。

## 存疑

- **auto-review 与 interactive 共用并发组**：`:95` 与 `:274` 均为 `claude-review-<n>` 且 `cancel-in-progress`——@claude 评论会取消进行中的 auto-review；新推送会取消进行中的交互会话（可能截断半途的改码）。无法从文件判断这是有意「同 PR 单会话」设计还是漏分（security 就单独用了 `claude-review-sec-`）。缺证据：仓库后续 fix 的 diff 或设计说明。
- **interactive 的 actor 排除不完整**：`:268` 只排除 `claude[bot]`，但本工作流里 bot 评论实际经 `GITHUB_TOKEN` 以 `github-actions[bot]` 身份发出（如 `:87`、`:252` 的 gh 调用）。若 bot 回评正文恰好含 `@claude` 字样会再次触发交互 job。缺证据：需要确认 CCA 回评的正文惯例是否会出现该字样。
- **门禁可被评论内容污染**：`:252` 的 grep 扫全部评论正文，任何有评论权限的人发一行 `SECURITY-VERDICT: PASS` 即翻转门禁。同仓库协作场景下威胁有限，但作为 required check 使用时应只认 bot 作者的评论。缺证据：`gh pr view --json comments` 是否能按 author 过滤后仍保序（能，`.comments[] | select(.author.login==...)`，故这条偏加固而非缺陷，放存疑）。
```

</details>
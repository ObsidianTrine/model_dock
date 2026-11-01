# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-review-loop-guard-dead-code — ✅ 审出

- 考题：claude-review.yml 的 [dependabot-fix] 防回环守卫用 git log -1 读尾提交 subject——actions/checkout 在 PR 事件检出的是 refs/pull/N/merge 测试合并提交（subject 形如 Merge <sha> into <sha>），case 匹配永不命中，防回环自上线以来从未生效
- 关键词：dependabot-fix=中，合并提交=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-42JN0s/2026-10-review-loop-guard-dead-code.output.txt

<details><summary>模型原文</summary>

```text
发现 3 个问题（已对照 git 历史 567d379 与后续修复提交逐一验证）：

**1. 防回环守卫是死代码——`git log -1` 永远读不到 `[dependabot-fix]` 前缀**（`claude-review.yml:121`、`claude-review.yml:208`，auto-review 与 security-review 两处）
`pull_request` 事件下 `actions/checkout@v7`（fetch-depth:1）检出的是 `refs/pull/N/merge` 测试合并提交，`git log -1 --pretty=%s` 读到的是 "Merge \<sha\> into \<sha\>" 之类的合并 subject，`case "$msg" in "[dependabot-fix]"*)` 永远不匹配 → 守卫恒不跳过，bot 推的 `[dependabot-fix]` 修复提交会被再次审查，回环防护失效。后续 567d379 已实证修复（改读 `github.event.pull_request.head.sha` 的 commit message）。

**2. auto-review 与 interactive 共用并发组 + cancel-in-progress**（`claude-review.yml:95`、`claude-review.yml:274`）
两组名同为 `claude-review-${PR号}`：同一 PR 上发 `@claude` 评论会取消进行中的 auto-review（token 已烧、评论白丢），反之 auto-review 新推送也会掐断正在推代码的 interactive 会话。后续 cc6d832 已拆成独立 `claude-review-interactive-*` 组，证实为真实事故。

**3. SECURITY-VERDICT 门禁判定可被陈旧/伪造评论满足**（`claude-review.yml:252`）
`gh pr view --json comments` 取**全部** PR 评论（不过滤作者、不过滤轮次）后 `tail -1`：① 上一轮 bot 曾发 PASS，新推送后 bot 静默失败（超时/崩溃）时取到陈旧 PASS，`*)` 的「无结论按未通过」兜底失效；② 评论未限定 `claude[bot]` 作者，PR 作者自己评论一行 `SECURITY-VERDICT: PASS` 即参与判定——与 ① 叠加（bot 静默失败 + 作者垫一句 PASS）即可绕过门禁。该问题至今（HEAD）未修。

**存疑**
- `gh pr view --json comments` 有评论数分页上限（约 100 条），长命 PR 可能取不到 verdict——未实测 gh 的具体上限，不计入确认问题。

其余核对无误：`/tmp/pr-files.txt` 跨 step 共享在同一 runner 上成立；`--allowedTools` 逗号分隔是 Claude Code 文档用法；`[ci-autofix]` 前缀缺失不算缺陷（ci-autofix.yml 是 a200035 才引入的）。
```

</details>
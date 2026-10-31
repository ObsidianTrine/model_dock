# 审查评测报告

- 考题：1，审出：0，未审出：1
- 模型：glm-4.5-air
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-review-concurrency-group — ❌ 未审出

- 考题：claude-review 的 auto-review 与 interactive（@claude）两 job 共用并发组 + cancel-in-progress：同一 PR 上一条 @claude 评论会把进行中的 auto-review 取消掉，已烧 token 白费、审查静默丢失
- 关键词：concurrency=未中，cancel-in-progress=未中，group=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-qdIXhL/2026-10-review-concurrency-group.output.txt

<details><summary>模型原文</summary>

```text
审查 `.github/workflows/claude-review.yml` 文件，我发现了以下问题：

发现 2 个问题：

### 1. 安全审查遗漏 keyguard 步骤跳过时的 SEC_VERDICT 判定
**文件：** `.github/workflows/claude-review.yml`  
**行号：** 247-263

**问题：** 门禁判定步骤没有考虑 keyguard 步骤跳过的情况。当三件套配置不齐时，security-review job 会静默跳过，但门禁判定步骤仍然执行，会导致误判。

**证据：**
```yaml
steps:
  - name: 门禁判定（FAIL 则本 job 失败，可作 required check）
    if: steps.keyguard.outputs.skip != 'true' && steps.guard.outputs.skip != 'true'  # 缺少 keyguard 跳过检查
```

### 2. 获取最新 commit message 使用错误命令
**文件：** `.github/workflows/claude-review.yml`  
**行号：** 208-209, 121-122

**问题：** 使用 `git log -1 --pretty=%s` 可能获取不到正确的 commit message，特别是在 fetch-depth: 1 时，当前分支只有 PR 合并提交，没有实际的 commit history。

**证据：**
```yaml
- name: 跳过 bot 自身修复提交（防审查回环）
  id: guard
  if: steps.keyguard.outputs.skip != 'true'
  run: |
    msg="$(git log -1 --pretty=%s)"  # 在 fetch-depth: 1 下可能返回空或合并提交信息
```

同类还有 1 处（行 121）也有相同问题。

### 存疑

### 1. concurrent 组名设计可能导致冲突
**文件：** `.github/workflows/claude-review.yml`  
**行号：** 95, 274

**问题：** auto-review 和 interactive job 使用相同的并发组名 `claude-review-${{ github.event.pull_request.number || github.event.issue.number }}`，理论上两者不会同时触发，但设计上不够清晰。需要确认 PR 和 issue comment 是否真的不会同时发生。

### 2. fetch-depth: 0 的风险
**文件：** `.github/workflows/claude-review.yml`  
**行号：** 300

**问题：** interactive job 使用 fetch-depth: 0，这在大型仓库可能显著增加克隆时间。考虑到交互式审查主要是代码查看，不一定需要完整的 commit history。
```

</details>
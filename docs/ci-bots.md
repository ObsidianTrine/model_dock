# GitHub Actions 自动化（PR 审查 bot + Dependabot）——设置与用途

> 维护者文档。三个自动化配置都在 `.github/`，**全部跑在 GitHub 云端 runner 上**：不占本地进程/端口，不经过本地网关 8687。token 消耗只在配置了 API key 之后发生；**未配置 secrets 时一切静默跳过（Actions 日志有 warning），零消耗**。
> 改动这些文件照常走 worktree 流程（CI yml 属于「带执行语义的配置」，develop 直改会被 hook 拦）。

## 一览

| 文件 | 类型 | 触发 | 干什么 | 烧 token？ |
|------|------|------|--------|-----------|
| `workflows/test.yml` | CI | push（main/develop）+ 任意 PR | 三 OS build + test | 否 |
| `workflows/release.yml` | CI | 推送 `v*` tag | 5 平台构建并发布到 Releases | 否 |
| `workflows/claude-review.yml` | AI bot | PR 打开/更新；PR/issue 评论 `@claude` | 自动审查（只读）/ 交互改码 | **是** |
| `dependabot.yml` | 依赖配置 | 每周（仅默认分支 main 生效） | 自动开依赖升级 PR | 否 |
| `workflows/dependabot-fix.yml` | AI bot | Dependabot PR 打开/更新 | 验证升级、失败做最小修复推回 | **是** |

## 模型接入（现状与换供应商）

bot 默认走**智谱 GLM 的 Anthropic 兼容端点**：各 claude-code-action 步骤的 env 块注入

```yaml
ANTHROPIC_BASE_URL: https://open.bigmodel.cn/api/anthropic
ANTHROPIC_AUTH_TOKEN: ${{ secrets.GLM_API_KEY }}   # 实际请求走这里（Bearer）
ANTHROPIC_API_KEY: ${{ secrets.GLM_API_KEY }}      # 同值，仅为过 action 启动校验
```

**后续换供应商**（如火山方舟 agent plan）：任何 Anthropic 兼容端点都适用——把每个 claude-code-action 步骤 env 块里的 `ANTHROPIC_BASE_URL` 与 token secret 换掉即可（claude-review.yml 两个 job + dependabot-fix.yml 一个 job，共三处）；端点 URL 以各家官方文档为准。想回 Anthropic 官方 API：删 env 块、恢复 `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}` 输入。

## 启用步骤（后续开启时做）

1. **API key**：仓库 Settings → Secrets and variables → Actions → New repository secret → `GLM_API_KEY`（智谱 key）。claude-review 与 dependabot-fix 共用。
2. **PAT（仅 dependabot-fix 需要）**：再建 secret `DEPENDABOT_GH_TOKEN`。
   - fine-grained PAT：Repository access 选本仓库，权限给 **Contents: Read+Write**、**Pull requests: Read+Write**（classic PAT 给 repo scope）。
   - 为什么必须 PAT：Dependabot 触发的 workflow，其内置 GITHUB_TOKEN 被 GitHub 平台**强制只读**，在 Dependabot PR 上评论/推送必须自备 token。
3. `dependabot.yml` 只在**默认分支（main）**生效：develop 合入 main 之后，Dependabot 才开始每周开升级 PR；只停在 develop 不会触发。

## 未启用时的行为（当前状态）

- PR 上**不会出现失败的 AI 检查**：缺 key 的 run 静默跳过，Actions 日志留 `::warning::` 指向本文档。
- Dependabot PR（若已在 main 生效）照常开出，只是没人验证——按 `.agents/workflows/dependency-upgrade.md` 人工处理。
- test.yml / release.yml 与 API key 无关，永远正常跑。

## claude-review.yml 详解

- **auto-review（只读）**：PR 打开/更新时跑一次完整审查会话，只发评论与 inline 标注、不改码。审查重点 = AGENTS.md 硬约定（三平台兼容 / t() 双语 / atomicWrite / 纯 JS 依赖 / 测试端口红线等），输出 [P0]/[P1]/[P2] 分级。
- **interactive（可写）**：PR/issue 评论里 `@claude` 触发；可按评论指示修改代码并推送（该 job 才有 contents: write），新分支基于 develop。
- **自动跳过**：Dependabot 的 PR（交给 dependabot-fix 专职处理）；尾提交带 `[dependabot-fix]` 前缀的 PR（防自己复审自己的修复）。

## dependabot.yml 详解

- npm + GitHub Actions 两个 ecosystem，每周检查。
- npm：minor/patch 合并成一条组 PR 降噪，major 单独开；挂起上限 5 条。
- commit 前缀 `chore:`：release-propose 解析 conventional 提交时归为 chore，不会虚推发版档位。

## dependabot-fix.yml 详解

Dependabot PR 触发后 Claude 接手：

1. `npm ci` + `npm run build` + 完整 `npm test`；
2. 全绿 → 评论「可合并」+ 升级要点（涉及包、跨度、行为变化）；
3. 失败且确系升级引入 → **最小修复**，以 `[dependabot-fix] 适配 <包名> <版本>` 提交推回 PR 分支，评论说明；
4. 大破坏（major 语义大改 / 依赖树引入 native addon）→ 不硬修，评论给人工方案（走本地 feature-branch 流程）。

合并权始终在人：bot 不 approve、不 merge；发版仍走 release.md 人工授权。

## 成本控制

- **零消耗开关就是 secrets**：不配 / 删掉 secret 即全停，无需改 yml。
- 已配置想临时停：仓库 Actions 页 → 左侧选中 workflow → `⋯` → **Disable workflow**（恢复同入口 Enable）。
- 消耗点（每次 = 一次完整 agent 会话）：auto-review 在每次 PR 打开/更新各烧一次；`@claude`、dependabot-fix 各一次。量级取决于 diff 大小与 max-turns（粗估单次几万～几十万 token，推测值，以实际账单为准）。
- 同 PR 并发互斥（concurrency 组），旧审查自动取消，不会叠加烧；auto-review 检测到尾提交是 `[dependabot-fix]` 也会跳过。

## 防回环设计

- Claude 修复提交固定 `[dependabot-fix]` 前缀；auto-review 检测尾提交为该前缀即跳过复审。
- dependabot-fix 仅 `actor=dependabot[bot]` 时执行：Claude 用 PAT 推送触发的 synchronize，actor 是 PAT 属主，不会重入。

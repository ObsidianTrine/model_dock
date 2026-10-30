# GitHub Actions 自动化（分层 PR 审查 + Dependabot）——设置与用途

> 维护者文档。自动化配置都在 `.github/`，**全部跑在 GitHub 云端 runner 上**：不占本地进程/端口，不经过本地网关 8687。
> token 消耗只在配置了 API key 之后发生；**未配置 secrets 时 AI job 一切静默跳过（Actions 日志有 warning），零消耗**；
> `risk-tier` 风险分级是确定性脚本，不依赖 secrets、照常运行。
> 分层设计总览与改进闭环见 docs/ai-review-system.md。
> 改动这些文件照常走 worktree 流程（CI yml 属于「带执行语义的配置」，develop 直改会被 hook 拦）。

## 一览

| 文件 | 类型 | 触发 | 干什么 | 烧 token？ |
|------|------|------|--------|-----------|
| `workflows/test.yml` | CI | push（main/develop）+ 任意 PR | 三 OS build + test | 否 |
| `workflows/release.yml` | CI | 推送 `v*` tag | 5 平台构建并发布到 Releases | 否 |
| `workflows/claude-review.yml` | AI bot | PR 打开/更新；PR/issue 评论 `@claude` | risk-tier 风险分级（确定性）/ auto-review 自动审查（只读）/ security-review 安全审查（可阻塞）/ interactive 交互改码 | 分级**否**，其余**是** |
| `dependabot.yml` | 依赖配置 | 每周六上午（Asia/Shanghai；仅默认分支 main 生效） | 自动开依赖升级 PR | 否 |
| `workflows/dependabot-fix.yml` | AI bot | Dependabot PR 打开/更新 | 验证升级、失败做最小修复推回 | **是** |

## 模型接入（三件套全在 GitHub，供应商无关）

bot 走任意 **Anthropic 兼容端点**，端点 / 模型 / key 三件套**全部在 GitHub 配置，yml 零默认值**——换供应商只改这三个值，不动代码：

| 配置项 | GitHub 位置 | 必填 | 说明 |
|------|------|------|------|
| `CLAUDE_AUTH_TOKEN` | **Secrets**（加密） | 是 | 供应商 API key |
| `CLAUDE_BASE_URL` | **Variables**（明文） | 是 | Anthropic 兼容端点 URL |
| `CLAUDE_MODEL` | **Variables**（明文） | 是 | 模型名，经各步 claude_args 首行 `--model ${{ vars.CLAUDE_MODEL }}` 下发 |

yml 内四处 env 块（claude-review.yml 三个 AI job + dependabot-fix.yml 一个 job）形如：

```yaml
env:
  ANTHROPIC_BASE_URL: ${{ vars.CLAUDE_BASE_URL }}
  ANTHROPIC_API_KEY: ${{ secrets.CLAUDE_AUTH_TOKEN }}
```

keyguard/guard 会校验三件套齐全，缺任一项打 warning 指明缺哪项并跳过（零消耗）。

- **换供应商**：Variables 改 `CLAUDE_BASE_URL` / `CLAUDE_MODEL` + Secrets 换 key，完事。例外：目标端点只认 Bearer 认证时，需给三处 env 块各加一行 `ANTHROPIC_AUTH_TOKEN: ${{ secrets.CLAUDE_AUTH_TOKEN }}`（CLI 优先走 Bearer；x-api-key 型端点如 DeepSeek 不要加）。
- **切回 Anthropic 官方**：恢复各步 `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}` 输入、删三处 env 块（官方 API 密钥走 action 输入而非 env）。
- 参考示例（DeepSeek，值配在 GitHub 侧而非代码里）：`CLAUDE_BASE_URL=https://api.deepseek.com/anthropic`、`CLAUDE_MODEL=deepseek-flash`（快/省）或 `deepseek-v4-pro`（强/贵）。

### 事故记录：2026-10-30 供应商 key 401 失效（bot 同源失效）

**现象与根因**：2026-10-30 起，本地 claude CLI 所用的供应商 key（尾号 17eb）返回 401 失效；GitHub bot 三件套与本地 CLI **同源共用一把 key**，随之一起失效。**教训：key 是单点，本地 CLI 与 bot 共用时，轮换必须两边同步改。**

**bot 实际状态（2026-10-31 `gh` 只读核查）**：红 / 绿但空转 / 跳过**都不是——事故后零触发、零 run，处于「三件套已轮换、尚未验证」的休眠**：

- claude-review：近 7 天 18 次 run，**10-30 之后 0 次**。事故前 15 次 skipped 全部是 Dependabot PR 触发（设计上排除 dependabot，交给 dependabot-fix 专职处理），不构成故障证据；2 次 failure + 1 次 cancelled 是 10-27 test/bot-smoke 冒烟测试期（当时 Claude Code GitHub App 未装、App 级 401，当天已修复）。
- dependabot-fix：近 7 天 15 次 run，**最后一次真实成功 2026-10-29 05:00Z**（PR #8 undici / #9 qrcode-generator，各一次 2–4 分钟完整验证会话）；唯一 failure（10-27，vitest 5.0.5）是会话轮次耗尽（`Reached maximum number of turns (50)`），与 401 无关、同 PR 重触发即绿；另有数条秒级 run（抽样核查为 guard 通过、fix 跳过，非真实会话）。**10-30 之后 0 次**（无新 Dependabot PR）。
- 因此 **Actions 日志里没有 401 证据**：key 失效后 bot 一次都没被触发，401 证据只在本地 CLI 侧。
- 三件套已于 **2026-10-30 22:53–22:54（UTC+8）被轮换过一次**（`gh secret list` / `gh variable list` 更新时间戳为证）：`CLAUDE_AUTH_TOKEN` 换新，`CLAUDE_BASE_URL=https://ark.cn-beijing.volces.com/api/coding`（火山方舟端点）、`CLAUDE_MODEL=glm-5.3-flash[1m]`。**换后零 run，这组组合未经任何真实 run 验证**；且与本地已实测可用的 GLM 官方组合（见下路径 b）端点不同，能否用通待验证。

**事故复核命令**（今后排查同源失效照此走）：

```bash
gh run list --workflow claude-review.yml --limit 15   # 结论分布；skipped 先看触发事件（Dependabot PR 属设计性跳过）
gh run list --workflow dependabot-fix.yml --limit 15  # 时长分钟级 + fix success 才算「真实验证过」
gh run view <run-id> --log-failed                     # 抽样看报错：认证类（401 / invalid key）还是测试失败
gh variable list && gh secret list                    # 三件套存在性与最近更新时间（值不可读）
```

**切换路径**（改 repo Settings 的 secrets/variables 属敏感操作，**须用户拍板后执行**，两条任选其一）：

- **路径 a：换新 DeepSeek key（供应商不变，只动 secret）**
  1. `gh secret set CLAUDE_AUTH_TOKEN`（回车后粘贴新 key，避免 key 进 shell 历史）；
  2. **同步写 Dependabot 页签**：`gh secret set CLAUDE_AUTH_TOKEN --app dependabot`（同值）——Dependabot PR 的 run 读不到 Actions 页签 secret，漏了这步 dependabot-fix 会静默跳过（见「启用步骤」关键坑）；
  3. Variables 不动（`CLAUDE_BASE_URL` 仍指 DeepSeek 兼容端点即可）。
- **路径 b：切 GLM Anthropic 兼容端点（本地已实测可用）**
  1. `gh variable set CLAUDE_BASE_URL --body "https://open.bigmodel.cn/api/anthropic"`；
  2. `gh variable set CLAUDE_MODEL --body "glm-5.3-flash"`；
  3. `gh secret set CLAUDE_AUTH_TOKEN` 粘 GLM key，并 `gh secret set CLAUDE_AUTH_TOKEN --app dependabot` 再写一份；
  4. 认证形态注意：GLM 官方走 Bearer；bot env 块默认 `ANTHROPIC_API_KEY`（x-api-key 型）。若换后 run 报认证失败，按上节「换供应商」的 Bearer 例外给三处 env 块补一行 `ANTHROPIC_AUTH_TOKEN`（改 yml 走 worktree 流程）。

**操作途径**：上述 gh 命令即可，也可走 **Settings → Secrets and variables → Actions**：Secrets 页签 Update `CLAUDE_AUTH_TOKEN`、Variables 页签改 `CLAUDE_BASE_URL` / `CLAUDE_MODEL`、**Dependabot 页签同步 Update 同名 secret**（最易漏的一步）。

**换完必须真实验证一次**（不验证等于没换），任选其一：在任意 PR/issue 评论 `@claude` 触发 interactive；或开一个人类 PR 触发 claude-review；或在仍 open 的 Dependabot PR（#8 / #9）评论 `@dependabot recreate` 触发 dependabot-fix；或等每周六 09:00（Asia/Shanghai）Dependabot 自动开 PR。run 时长分钟级、PR 上出现验证评论，即为新端点可用。

## 启用步骤（后续开启时做）

1. **三件套**：Settings → Secrets and variables → Actions → **Secrets** 建 `CLAUDE_AUTH_TOKEN`（API key）；**Variables** tab 建 `CLAUDE_BASE_URL`（兼容端点 URL）与 `CLAUDE_MODEL`（模型名）。三件套缺一 bot 不启动（Actions 日志告警指明缺哪项）；换供应商只改这三个值，见上节「模型接入」。
2. **PAT（仅 dependabot-fix 需要）**：再建 secret `DEPENDABOT_GH_TOKEN`。
   - fine-grained PAT：Repository access 选本仓库，权限给 **Contents: Read+Write**、**Pull requests: Read+Write**（classic PAT 给 repo scope）。
   - 为什么必须 PAT：Dependabot 触发的 workflow，其内置 GITHUB_TOKEN 被 GitHub 平台**强制只读**，在 Dependabot PR 上评论/推送必须自备 token。
   - **关键坑（2026-10-27 实测）**：Dependabot PR 触发的 run **读不到 Actions 页签的 Secrets**（平台视同 fork：只给只读 token、不注入 Actions secrets；Variables 反而可见）。所以 `CLAUDE_AUTH_TOKEN` 与 `DEPENDABOT_GH_TOKEN` 必须在 **Settings → Secrets and variables → Dependabot 页签**再配一份（同名同值），dependabot-fix 的 guard 才拿得到；guard 会点名缺哪项。
3. `dependabot.yml` 只在**默认分支（main）**生效：develop 合入 main 之后，Dependabot 才开始每周开升级 PR；只停在 develop 不会触发。

## 未启用时的行为（当前状态）

- PR 上**不会出现失败的 AI 检查**：缺 key 的 AI job 静默跳过，Actions 日志留 `::warning::` 指向本文档。
- `risk-tier` 照常运行（纯脚本 + GH_TOKEN，不依赖三件套），PR 照常打 risk:* label。
- Dependabot PR（若已在 main 生效）照常开出，只是没人验证——按 `.agents/workflows/dependency-upgrade.md` 人工处理。
- test.yml / release.yml 与 API key 无关，永远正常跑。

## claude-review.yml 详解

- **risk-tier（确定性，零消耗）**：`gh pr diff --name-only` 的文件列表喂给 `scripts/pr-risk-tier.mjs`，按 `.agents/workflow.json` 的 corePaths / releasePaths（加安装器/密钥注入面）取最高档，打 `risk:low/medium/high` label（旧档位自动摘除）；opened/reopened 时评论一次判定依据，synchronize 不刷屏。等级含义与调整规则见 docs/ai-review-system.md「风险分级」。
- **auto-review（只读）**：PR 打开/更新时跑一次完整审查会话，只发评论与 inline 标注、不改码。先读 REVIEW.md 审查纪律；输出顶层评论 = 首行「风险等级」+「发现 N 个问题」，inline 按 [P0]/[P1]/[P2] 分级。降噪与收敛：每条发现先自证（文件+行号）、风格/清理类不报、非本 PR 引入标 [存量]、不重复既往评论、复查只看新增 diff、3 轮不收敛建议换方案。
- **security-review（可阻塞）**：独立安全审查会话，只查注入 / 密钥泄漏 / 鉴权越权 / 路径穿越 / 供应链与安装器五类。顶层评论首行固定 `SECURITY-VERDICT: PASS|FAIL（N 项）`；job 尾的确定性门禁步骤抓该行，**FAIL 或没有 verdict（bot 静默失败）都判 job 失败**。**已是合并门禁**：2026-10-29 经 `gh api` 把 `security-review`（连同三 OS `test` / `test-workflow` / `risk-tier`）设为 main 与 develop 的 required check，并开启 required conversation resolution（审查线程必须 resolve 才能合并）；语义与改动注意项见 docs/ai-review-system.md「安全审查门禁」。
- **interactive（可写）**：PR/issue 评论里 `@claude` 触发；可按评论指示修改代码并推送（该 job 才有 contents: write），新分支基于 develop。
- **自动跳过**：Dependabot 的 PR（交给 dependabot-fix 专职处理）；尾提交带 `[dependabot-fix]` 前缀的 PR（防自己复审自己的修复）。

## dependabot.yml 详解

- npm + GitHub Actions 两个 ecosystem，每周六检查（`day: saturday` + `timezone: Asia/Shanghai`；`time: 09:00` 仅为当天内意向提示，实际时刻按平台负载漂移）。
- npm：minor/patch 合并成一条组 PR 降噪，major 单独开；挂起上限 5 条。
- commit 前缀 `chore:`：release-propose 解析 conventional 提交时归为 chore，不会虚推发版档位。

## dependabot-fix.yml 详解

Dependabot PR 触发后 Claude 接手：

1. `npm ci` + `npm run build` + 完整 `npm test`；
2. 全绿 → 评论「可合并」+ 升级要点（涉及包、跨度、行为变化）；
3. 失败且确系升级引入 → **最小修复**，以 `[dependabot-fix] 适配 <包名> <版本>` 提交推回 PR 分支，评论说明；
4. 大破坏（major 语义大改 / 依赖树引入 native addon）→ 不硬修，评论给人工方案（走本地 feature-branch 流程）。

> **运维注意（2026-10-27 实测）**：低端模型（deepseek-flash）偶尔会提前结束会话且不发评论（action 仍显示 success）。Dependabot PR 迟迟没有验证评论时，在 PR 里评论 `@dependabot recreate` 重触发一次即可；频发则把 Variables `CLAUDE_MODEL` 换成更强档位（如 `deepseek-v4-pro`）。另：会话里的 permission_denials 是 allowlist 在拦复合命令，属正常沙箱行为，模型会自行绕开。

合并权始终在人：bot 不 approve、不 merge；发版仍走 release.md 人工授权。

## 成本控制

- **零消耗开关就是 secrets**：不配 / 删掉 secret 即全停，无需改 yml。
- 已配置想临时停：仓库 Actions 页 → 左侧选中 workflow → `⋯` → **Disable workflow**（恢复同入口 Enable）。
- 消耗点（每次 = 一次完整 agent 会话）：auto-review 与 security-review 在每次 PR 打开/更新各烧一次（即一个 PR 更新 = 两次会话）；`@claude`、dependabot-fix 各一次。量级取决于 diff 大小与 max-turns（粗估单次几万～几十万 token，推测值，以实际账单为准）。
- 同 PR 并发互斥（concurrency 组），旧审查自动取消，不会叠加烧；auto-review 检测到尾提交是 `[dependabot-fix]` 也会跳过。

## 防回环设计

- Claude 修复提交固定 `[dependabot-fix]` 前缀；auto-review 检测尾提交为该前缀即跳过复审。
- dependabot-fix 仅 `actor=dependabot[bot]` 时执行：Claude 用 PAT 推送触发的 synchronize，actor 是 PAT 属主，不会重入。
- interactive 不响应 `claude[bot]` 自己发的评论（actor 排除）；并发组在 **job 级**——bot 评论触发的空 run 不进并发组，不会把进行中的审查取消掉（2026-10-27 实测：bot 发完评论自取消，行内标注被跳过，遂改 job 级）。

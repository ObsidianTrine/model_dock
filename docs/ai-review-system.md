# AI 代码审查系统（分层审查）——设计与运维

> 参照 Anthropic Claude Code 团队 2026-10-15 工程博客
> **《How the Claude Code team does code review》**（<https://claude.dev/blog/solving-code-review-at-anthropic/>）搭建。
> 本文是本仓库的落地说明与运维手册：每一层做什么、在哪配置、怎么用、怎么持续改进。
> GitHub Actions 三件套配置见 docs/ci-bots.md；合并前的本地独立审查见 .agents/workflows/code-review.md。

## 他们的核心思想（三句话）

1. **「有人读过代码」不是好指标**——换成「这个改动会出什么事，由哪层检查（自动或人工）去拦」。
2. **审查前移 + 分层**：大部分问题在 PR 存在之前就被自动审掉；PR 上 AI 审查、安全审查、CI 层层设防，人的注意力只花在风险所在处。
3. **审查者自身也要有改进闭环**：事故变考题、按作者对发现的三种反应度量噪声、给复查设轮次上限防不收敛。成效：合并 PR 翻倍的同时 revert 率降 40%+。

## 本仓库的分层映射

| # | 层 | Anthropic 的做法 | 本仓库实现 | 状态 |
|---|----|------------------|-----------|------|
| 1 | PR 前验证 | 给 agent 可运行的验证 + fresh-context 子 agent 审 diff；重复发现修到源头 | AGENTS.md（agent 指引）+ `feature-branch finish` 测试门禁 + code-review.md（合并前独立审查）；重复发现修 REVIEW.md / lint | 已有，纪律收敛到 REVIEW.md |
| 2 | PR 上 AI 审查 | 多 agent 找 bug + 投票确认才上报；风格/清理类丢弃；标 Important/Nit/Pre-existing | claude-review.yml `auto-review`：每条发现先自证（文件+行号）、风格/清理类不报、存量标 [存量]、不重复既往评论、复查只看新增 diff、3 轮不收敛建议换方案 | 已有，本次加降噪与收敛纪律 |
| 3 | 安全审查可阻塞 | 独立安全审查，有未解决发现不能合并 | claude-review.yml `security-review`：独立会话专查安全面，顶层评论 `SECURITY-VERDICT: PASS/FAIL` 作门禁，FAIL 则 job 失败（可设 required check） | **新增** |
| 4 | CI 阻塞 | lint / typecheck / 三平台测试 / build | test.yml：三 OS 矩阵 build + npm test | 已有 |
| 5 | 风险分级人工批准 | 分类器按「改动本身」定档：低 0 / 中 1 / 高 2 个人工批准；agent 的批准永远不算人 | claude-review.yml `risk-tier`：确定性脚本打 `risk:low/medium/high` label + 评论判定依据；CODEOWNERS 标敏感路径；批准刚性靠分支保护承担（见下） | **新增** |
| 6 | 合并队列 / flag / 渐进发布 | merge queue 重跑全部检查；flag 内部先用；stable 渠道滞后 | **不建**：单维护者 + 本地应用没有合并竞争；发版已有 stable 滞后 latest 的渠道设计（release.md）。出现多人高频合并再上 merge queue | 取舍 |
| 7 | 快速发现 + 回滚 | flag 一键关停；事故复盘问「哪层该拦住它」 | incident-response.md（8687 故障排查）+ 安装包回滚 + revert 流程 | 已有 |
| — | 审查者改进闭环 | 事故→考题全量跑分；按作者反应度量噪声；轮次上限 | `.agents/review-evals/` 考题集 + `scripts/review-eval.mjs` 跑分器；噪声按 PR 上作者的回应分类；收敛规则写进 auto-review prompt | **新增** |

## 风险分级（第 5 层）

- **判定**：`scripts/pr-risk-tier.mjs` 按改动文件匹配规则，取最高档：
  - **高**：`.agents/workflow.json` 的 `corePaths`（网关核心/配置存储/密钥/路径锚点/CLI 入口）与 `releasePaths`（CI 工作流/发布构建），加上安装器（installer.iss/inno）、SEA 配置、`src/gateway/proxy.ts`（密钥注入面）、`.github/CODEOWNERS`；
  - **低**：文档（`*.md`、docs/**）、`.agents/` 约定与工作流文档、issue/PR 模板；
  - **中**：其余一切（未命中规则不默认放行）。
- **输出**：`risk:*` label（`gh label create --force` 幂等建 label，旧档位自动摘除）；opened/reopened 时评论一次判定依据表格（synchronize 不刷屏）。
- **调整规则**：改 `.agents/workflow.json` 的 corePaths/releasePaths 或脚本内补充段；规则与 CODEOWNERS 敏感路径保持同源，改一边记得改另一边。
- **等级要求**（评论里会写）：低=自动检查全绿即可合并；中=owner 实际读过 diff 与审查发现；高=逐项核对 AI 审查与安全审查发现 + PR 描述写清测试方式与回滚。
- **本地手测**：`git diff --name-only develop...HEAD | node scripts/pr-risk-tier.mjs`（`--markdown` / `--tier-only` / `--json`）。

## 安全审查门禁（第 3 层）

- 独立 job（独立会话，不与一般审查混注意力）：只查注入、密钥泄漏、鉴权越权、路径穿越、供应链与安装器五类。
- **verdict 机制**：顶层评论首行固定 `SECURITY-VERDICT: PASS` 或 `SECURITY-VERDICT: FAIL（N 项）`；job 内确定性步骤 `gh pr view` 抓最后一行 verdict——FAIL 或**没有 verdict（bot 静默失败）都判失败**（保守侧）。
- **required check（已启用，2026-10-29 经 `gh api` 配置）**：main 与 develop 两个分支的保护均已设置——Required status checks = 三 OS `test` 矩阵 + `test-workflow` + `risk-tier` + `security-review`；同时开启 **required conversation resolution**（PR 上的审查线程必须 resolve 才能合并，对应文章「每条发现必须被回答」）。语义注意：
  - `strict=false`（不强制分支最新）、`enforce_admins=false`（owner 保留人工覆盖权）、未设 PR 审查要求（单人流本地合并，分支保护只管 PR 合并侧，不拦直推）。
  - **三件套 secrets 未配置时 `security-review` job 整体 skip，skip 视为通过**——门禁随 secrets 配置自动生效，不会卡 PR。
  - 改动检查名单时同步更新本节与 `.github/workflows/*.yml` 的 job `name:`（required check 按名字精确匹配）。
- **误报处理**：在该 inline 下回复依据说明，然后 resolve 线程——对应文章的「每条发现必须被回答」。反复误报修进 REVIEW.md 或 prompt（见改进闭环）。

## 人工批准与分支保护（第 5 层的刚性）

文章的「低 0 / 中 1 / 高 2 个批准」由 GitHub 批准机制承担；本仓库是单维护者（owner 无法 approve 自己的 PR），刚性改由两处承担：

1. **required checks（已于 2026-10-29 启用，见上节）**：`test`（三 OS）+ `security-review` 等六项不绿不能合并——这是机器门禁。
2. **人工纪律**：中/高风险 PR，owner 合并前实际读过 diff 与全部发现（PR 模板的「风险等级」「如何回滚」「测试方式」三栏是最低自查面）；高风险改动建议再走一遍 .agents/workflows/code-review.md 的 fresh-context 独立审查。

启用「Require review from Code Owners」仅当出现第二位维护者时再做；`.github/CODEOWNERS` 已先行登记敏感路径归属。

## 审查者改进闭环

### 事故 → 考题（评测集）

- 位置：`.agents/review-evals/cases/*.json`，schema 与加题步骤见同目录 README.md。
- 跑分：`node scripts/review-eval.mjs [--case <id>] [--dry] [--out <md>]`——物化修复前代码 → 按 REVIEW.md 组装审查 prompt → 本地 claude CLI 跑 → expect 关键词打分（启发式）。
- **基线（2026-10-29 首跑，claude CLI 2.1.214）：2/2 全中**，且都给出可用的证据链（darwin 题完整复现修复逻辑，stoptray 题定位 P0 根因并顺带挖出一个 HEAD 仍在的问题）；报告存 `.agents/review-evals/runs/2026-10-29-first-run.md`。此后改审查者跑分低于 2/2 即不保留改动。
- **时机**：每次 revert / 事故修复合并后加题；改 REVIEW.md、workflow prompt、换模型之后全量重跑一次，分数升了才保留改动。

### 噪声度量

看 PR 上作者对每条发现的回应分四类：**修了 / 说是误报 / 说是故意的 / 说无所谓**。误报占比高 → 把该类发现修进 REVIEW.md「失败长什么样」或直接在 prompt 里禁掉（文章原话：优先级写死——先抓真 bug，再谈少几轮）。

### 收敛控制（防 agent 作者 × agent 审查员无限空转）

已写进 auto-review prompt：复查只看新增 diff；不重复既往发现；同类问题一次说全；**连续 3 轮同一问题 → 顶层评论明确建议停下来重新考虑方案**。对应文章数据：轮次上限 + diff-only 复查后，1 轮通过的 PR 从 65% 升到 78%，5 轮以上的从 8.9% 降到 1.5%。

## 度量（人工时间 + 护栏）

文章追踪：人工批准数/PR（中位与 P95）、人工评论数、PR 等人时长；护栏是 revert 率与事故率——只降人不降护栏 = 没省时间只是把成本挪走了。本仓库起步配方（人工周检，够用再自动化）：

```bash
# revert 率（护栏）：近 90 天 revert 提交占比
git log --since=90.days --oneline --grep='^revert' -i | wc -l
git log --since=90.days --oneline --no-merges | wc -l
# 审查负担：某 PR 上 bot 评论轮数（轮次趋势）
gh pr view <N> --json comments -q '[.comments[] | select(.author.login=="claude[bot]")] | length'
```

## 成本与开关

- AI job 每次 PR 打开/更新各烧一次会话：auto-review + security-review 两次（量级见 docs/ci-bots.md「成本控制」）；risk-tier 是确定性脚本零消耗。
- 总开关就是三件套 secrets：删掉即全停 AI job；risk-tier label 照常（无 API 依赖）。
- Dependabot PR 不走本工作流（只读 token 发不了评论/label），仍由 dependabot-fix.yml 专职验证。

## 未启用 secrets 时的行为

- `risk-tier`：照常运行（不依赖 API）。
- `auto-review` / `security-review`：静默跳过（Actions 日志 warning），PR 上不会出现失败的 AI 检查。
- `security-review` 的门禁步骤也一并跳过——未启用状态不会红。

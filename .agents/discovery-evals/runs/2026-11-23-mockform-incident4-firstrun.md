# discovery-evals 事故④两案 mock 形态首跑归档（2026-11-23）

> **性质声明**：本记录是 **mock 降级形态**的管线验证归档，**不是基线跑分**。
> 卡 `discovery-evals-firstrun-backlog`；船东拍板（2026-11-23）：`--backend mock` 验证管线形态、
> 真跑转下轮（不烧 researcher 额度）。README 案例清单两行「**首跑待补**」标记按拍板保留不动，
> 本文即拍板所指的「归档说明」；下一轮真跑交接见该卡 worktree NOTES.md（worktree 本地）。

## 跑次

- 卡：`discovery-evals-firstrun-backlog`（type refactor，仅评测运行 + 落档，无代码改动）
- 命令：`node .agents/scripts/discovery-eval.mjs --run --backend mock --cases announcement-date-vs-event-date,snapshot-truncation-honest-annotation`
- 后端：mock（零外部调用，固定 brief 生成，见 `.agents/scripts/orchestrator/backends/mock.mjs` researcher 分支）
- 调研船模型口径：workflow.json `research.model` = **glm-5.3-flash**（mock 不消费模型参数；下一轮真跑按此档位记分，或 `--model` 显式覆盖）
- 原始输出：`.agents/discovery-evals/outputs/2026-11-22-23-00-06/`（`*.output.txt` 运行态不入库——.gitignore `*.output.txt`；当轮 worktree 本地运行态，本文件为入库归档）
- 退出码：1（评分 0/2，预期——确定性评分对 mock 占位 brief 拒收）

## 管线形态验证（本轮目的，全达成）

- dry-run 全量 7 案 schema 校验零报错（`node .agents/scripts/discovery-eval.mjs` 退出码 0）
- `--cases` 过滤生效（7 案 → 指定 2 案）；`buildResearchPrompt` 正确注入题干 + goals 罗盘 + minCitations
- `backend.spawn` researcher 显式角色契约走通；`parseBriefBlock` 解析 `agents-brief` 契约块成功
- `gradeCase` 确定性评分生效：引用关（无引用即拒收 / 引用下限）先行拒收 mock 占位 brief
- outputs 时间戳目录双案落盘；评分未全过时退出码 1（非管线故障信号）

## 机械评分：0/2（两案均在引用关拒收）

| 案例 | 引用关 | 关键词关 |
|---|---|---|
| `announcement-date-vs-event-date` | ❌ 拒收：带访问日期引用 1 条 < minCitations 2 | 因引用关短路未计分（见下） |
| `snapshot-truncation-honest-annotation` | ❌ 拒收：带访问日期引用 1 条 < minCitations 2 | 因引用关短路未计分（见下） |

- 评分器行为注记：`gradeCase` 在 `validateBriefBody` 抛错（引用关）时**短路返回**，关键词关不计分——
  真跑解读跑分时注意：引用关 FAIL 的输出里看不到关键词统计，不代表关键词没跑。
- 复核口径下若强制计关键词（对 brief 原文 grep）：case 1 = **1/13**（仅 `citations`——来源是题干派生的
  brief id 行 `introducing-citations-api-…`，非证据命中）、case 2 = **2/10**（`faithfulness`/`claim`——
  同为 id 行 `faithfulness-2026-claim` 残片）。均远低于阈值（≥4 / ≥7）。
- **复述型假阳性现场示范**：上述「命中」全部来自题干回声（mock 派生 id 复述了题面词），不是证据命中——
  正是 README 评分边界节警告的「关键词有复述型假阳性先例」的活例子；真跑人工对账时按此提高警惕。

## 引用真伪对账（人工，按 README 评分边界节口径：关键词全中 ≠ 引用为真）

- brief 引用段：两案各 1 条 `- 2026-11-22 https://example.com/mock-research — 支撑结论 [1]`——
  `example.com/mock-research` 为 mock 固定占位 URL。
- sources/ 快照：**无**（mock 后端零真实抓取，无 sources/ 产物可对拍）。
- 逐条对账结论：**占位假引用，真伪判定 = 不可对账（假）**；无 404 对拍对象，L1 数字回查不适用。
- mock 形态的结论边界：本轮只能验证「无引用即拒收 + 引用下限」这道确定性闸**生效**；
  真伪对账动作（sources/ 快照 vs brief 引用段逐条核对、引用深度比、根路径红旗）留待真跑执行。

## 事故④考点在 brief 中的命中/归因

- `announcement-date-vs-event-date`（考点：公告页 published_time ≠ 事件实际时间）：mustFind 13 词
  计分性命中 1（题干回声 `citations`，见上）、证据性命中 **0**——brief 无任何「发布/上线/日期区分」
  实质内容。归因：mock 后端固定输出不承载考点（`backends/mock.mjs` 固定五段占位文本），
  **非 researcher 真模型行为证据**，事故④回归防线仍须真跑补上。
- `snapshot-truncation-honest-annotation`（考点：快照截断下的显式标注而非静默断言）：计分性命中 2
  （题干回声）、证据性命中 **0**——正面示范点（「快照截断不可见，细节另经交叉印证」）在 mock brief
  中不存在。归因同上。

## verdict/2 链路连接（README「评分边界」节口径）

本轮**未连**：mock brief 无真引用、无快照，当日引用 gate / L1 快照回查 / L2 逐字校验没有输入可喂。
下一轮真跑后按 README 口径执行：评分 PASS ≠ 事故④防线成立，必须连着 verdict/2 各层一起看
（`validateBriefBody` 当日引用 gate → `crossCheckClaims` 快照回查 → L2 逐字校验）。

## researcher 链缺陷归因

**未暴露**：两案评分 FAIL 完全归因于 mock 固定 brief（占位引用 + 零证据关键词），确定性评分按设计拒收，
不构成 researcher 链（真模型）缺陷证据——README 事故④映射节无需新增缺陷条目（验收第 5 条为条件条目，
本轮条件未触发）。

## 下一轮真跑步骤（占位，真跑后改写本节为实测）

1. 确认模型档位：`--model` 显式 > workflow.json `research.model`（当前 glm-5.3-flash）。
2. `node .agents/scripts/discovery-eval.mjs --run --backend <name> --cases announcement-date-vs-event-date,snapshot-truncation-honest-annotation`（组合跑互扰则逐题单跑）。
3. README 案例清单两行「首跑待补」标记清零，补记跑分与模型档位；本记录追加真跑跑次节。
4. 引用真伪对账：sources/ 快照 vs brief 引用段逐条核对；事故④两考点在 brief 中找可对账命中或写归因。
5. 连 verdict/2 链路看（评分边界节口径）；若暴露链缺陷，归因落 README 事故④映射节（不混入修复范围）。

---
id: review-evals-first-run-sweep
type: test
created_at: 2026-10-31T00:00:00+08:00
created_by: agent
files_hint:
  - .agents/review-evals/**
  - scripts/review-eval.mjs
workflows:
  - feature-branch
gate: L3
---

# 目标
评测集现存 ⏳ 待首跑考题批量清账：逐题跑分（`node scripts/review-eval.mjs --case <id>`）、原文归档 runs/、README 考题表回填首跑结果、基线口径随新题计入更新。当前待首跑池（2026-10-31 盘点）：agents-win-spawn-shell、orchestrator-repo-root、review-concurrency-group（效能会话回灌三题）+ finish-lock-wait-contract、realhome-write-through、relay-failover-observability、daemon-stderr-pipe-pin、jsonpath-lenient-parse 等事故回流题——以 README 表内实标 ⏳ 者为准。

# 边界（防撞车，动手前必读）
- **不含** `feature/add-review-eval-cases` worktree 正在做的工作（batch3 挖题与其新题首跑归该会话；d6c0a9f 托盘 basename 等已由其挖题并首跑 ❌ 未审出）。开工前先 `node .agents/scripts/feature-branch.mjs list` 确认该会话状态：若已合并，其新题纳入本卡清账范围；若仍在跑，只清它范围外的题，README 回填避开它已标注的行。
- 跑分依赖本机 claude CLI 已配端点（scripts/review-eval.mjs 透传环境，不自带 key）；单题超时/失败按运行器逐题容错记录「运行失败」，不炸整轮。

# 实施要求
1. 逐题首跑：`--case <id>` 单题跑（便于隔离波动），原文落 runs/<id>.md；报告 stdout 一并归档。
2. README 考题表逐行回填首跑结果（✅/❌/⚠️ + 一句判读）；「首跑前不计入基线分母」的题在首跑完成后移出口径豁免、更新基线节分母与通过数。
3. ❌ 未审出的题照实记录，并按 README「怎么加新考题」第 3 步评估：漏报层在哪（expect 关键词启发式 vs 审查者真漏）→ 堵法落 REVIEW.md / prompt / lint 或在 note 标注「模型/启发式局限实录」。
4. 全部清零后跑一次全量（`node scripts/review-eval.mjs --out runs/first-run-sweep.md`）确认新基线口径自洽。

# 验收标准
- README 表内无 ⏳ 待首跑残留（或注明归属活跃会话的例外行）。
- 每道首跑题在 runs/ 有原文，README 有回填行。
- 基线节分母/通过数与表格状态一致；❌ 题有判读与堵法评估。

# 红线
- 不改任何考题 json 的 reviewRef/fixedBy/expect（挖题前提是真实修复对；expect 调整仅允许在「启发式局限」判读成立时经人工确认后进行并注明）。
- 不动 scripts/review-eval.mjs 的打分与容错语义。
- 未审出的题不删除、不降权——评测集价值在如实记录（README 既有口径）。

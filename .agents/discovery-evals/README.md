# discovery-evals — 上游调研（researcher）评测集

考「调研会话的产出质量」：researcher 拿到 调研问题 + goals 罗盘，产出五段契约 brief
（`research.mjs validateBriefBody` 同一契约）。与 `.agents/review-evals/reviewer/`（验船
师，考合成 diff 的红线拦截）平级、互不替代。

- **案例**：`cases/<id>.json`——`question`（题干写背景不写答案）+ `goals` + `minCitations`
  + `expect.mustFind[]` / `expect.mustFindAny`（期望关键词与命中下限）。
- **跑分**：`node .agents/scripts/discovery-eval.mjs`（dry-run 零消耗）/
  `--run --backend <name> --cases a,b`（真跑烧钱，人工发起）。
- **评分**：确定性规则——无引用即拒收（引用 ≥ minCitations）+ 关键词命中率 ≥ mustFindAny。
  引用真伪以 `<id>.output.txt` 原文与 brief sources/ 快照人工复核为准（关键词有「复述型」
  假阳性先例，见 review-evals README）。
- **出题纪律**：真实需求场景反推——信号在案（用户反馈/事故/航次报告/调研翻车）的问题才
  有资格成题；出事故后按 review-evals 同款流程加题，改 prompt/模型后全量重跑。

## 案例清单

| 案例 | 考什么 | 来源 |
|---|---|---|
| `headless-websearch-fallback` | headless 舰队无 WebSearch 时的降级调研能力 | 能力回归题（降级配方信号在案） |
| `rice-evidence-scoring` | 自动提案 RICE 排序的证据化输入 | 能力回归题（提案优先级信号在案） |
| `stale-priors-vs-current-landscape` | 训练先验冒充检索现状（现状型问题 + 双口径当期数据） | 事故① |
| `primary-source-vs-secondhand` | 一手来源 vs 二手转述（双源交叉） | 事故② |
| `fabricated-repo-urls` | 伪造/错配来源 URL（官方仓库链接 + star 数） | 事故②（伪造 URL 变体） |

## 事故 ↔ 拦截层映射（2026-11 三次真实事故出题）

- **事故①（`stale-priors-vs-current-landscape`）——引用日期编造 / 训练先验冒充检索现状**：
  首跑把 2023 年训练先验写进「2026-11 当前流行度」调研，15 条引用日期全编成 2023。主要被
  **当日引用 gate** 拦（`validateBriefBody` 陈旧日期拒收，容忍跨午夜 7 天）。
- **事故②（`primary-source-vs-secondhand` + `fabricated-repo-urls`）——真 URL 假依据**：
  brief 引用的 URL 真实存在但只是官网首页/文档根，页面上并没有它声称的数据；同跑的伪造仓
  库 URL 被快照 404 抓住。主要被 **sources/ 快照人工对账 + L1 数字回查** 拦
  （`research.mjs crossCheckClaims` + 引用深度比：根路径引用是红旗，快照 404 即编造信号）。
- **事故③——claim 逐字全灭**：弱模型 brief 连 L2 复核契约都无法遵守，复核输出 10 条
  claim 全部非逐字被丢弃（fabricated_claims=10）。主要被 **verdict/2 逐字校验** 拦
  （L2 输出每条 claim 必须逐字摘自 brief 原文，非逐字即弃 → L3 建档淘汰）；无独立案例，
  真跑任一题后接 verdict 复核即可覆盖。

**评分边界**：discovery-eval 关键词评分只能验产出形态（五段契约 + 引用数量 + 关键词命中），
事故级拦截验证在 verdict/2 各层（当日引用 gate / L1 快照回查 / L2 逐字校验）——关键词全中
≠ 引用为真，出题回归要连着 verdict 链路一起看。

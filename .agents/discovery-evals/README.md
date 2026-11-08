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

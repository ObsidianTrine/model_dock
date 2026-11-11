# docs/examples — 用户配置样例

放「可整体抄走」的用户配置样例。样例只作起点，键与口径以 `docs/config-reference.md` 与 `docs/usage.md` 为准。

This directory holds copy-and-adapt sample configs for users. Samples are starting points; the authoritative key reference lives in `docs/config-reference.md` and `docs/usage.md`.

## pricing.json — 模型单价覆盖样例 / Model price override sample

**中文**

- **作用**：网关估算成本时优先读 `~/.modeldock/pricing.json`（目录：Windows `C:\Users\<你>\.modeldock\pricing.json`，macOS/Linux `~/.modeldock/pricing.json`），查不到的模型回落内置 models.dev 官方牌价；两处都查不到按 $0 计并在用量接口列名提醒，绝不猜价。
- **部署**：把本样例复制到上面的目标路径（可整文件抄走，也可只留用到的条目）。**Agent 上下文对真实 home 有写入门禁，请用户手动放置**——agent 会话内不要试图直接写 `~/.modeldock/`。
- **键格式**：`"模型名"` 或 `"服务商id/模型名"`（后者只对该服务生效，优先级更高）。值字段（单位 **美元 / 百万 token**）：`input`、`output` 必填；`cache_read`、`cache_write` 可选，缺省回落输入价（宁可高估不低估）。
- **生效**：改完最迟约 5 秒生效（按文件指纹回验），无需重启网关。
- **价格来源与时效**：本样例数值取自 models.dev 目录快照（`src/providers/catalog-snapshot.generated.ts`，2026-11-02 抓取）中智谱 open.bigmodel.cn 的牌价，**可能过时**——折扣 / 套餐价与牌价不符时以你的实际账单为准，改此文件覆盖。未收录的模型不要凭印象补数：留空让网关列名提醒，查到官方价再填。

**English**

- **What it does**: when estimating cost, the gateway reads `~/.modeldock/pricing.json` first (Windows: `C:\Users\<you>\.modeldock\pricing.json`); models not found there fall back to the bundled models.dev list price; models found in neither are counted as $0 and listed as a reminder — prices are never guessed.
- **Deploy**: copy this sample to the target path above (take the whole file, or keep only the entries you use). **Agent contexts are blocked from writing the real home directory — place the file manually as the user.**
- **Key format**: `"model"` or `"providerId/model"` (the latter applies to that provider only and takes precedence). Value fields (unit: **USD per million tokens**): `input` and `output` are required; `cache_read` / `cache_write` are optional and fall back to the input price when omitted (overestimate rather than underestimate).
- **Effect**: edits take effect within about 5 seconds (fingerprint re-check) — no gateway restart needed.
- **Source & freshness**: figures come from the models.dev catalog snapshot (`src/providers/catalog-snapshot.generated.ts`, fetched 2026-11-02) for Zhipu open.bigmodel.cn list prices, and **may be outdated** — when discounted / plan prices differ, trust your actual bill and override here. Do not guess prices for models not listed: leave them out and let the gateway name them, then fill in official prices once looked up.

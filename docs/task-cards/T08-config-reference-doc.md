---
id: config-reference-doc
type: docs
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - docs/config-reference.md
  - docs/en/**
  - scripts/**
  - src/config/types.ts
  - test/**
workflows:
  - feature-branch
gate: L3
---

# 目标
补上 config.toml 全部可配键的权威参考文档，**生成式**防漂移（config.toml 定位"用户可直编"，但调优键的语义/默认值目前只能读源码）。

# 验收标准
- 生成脚本（或 freshness 测试）保证：src/config/types.ts 中每个用户可配键都在 docs/config-reference.md 有条目；该测试进 `npm test`
- 覆盖以下实测零提及的键（grep 证据 2026-10-27）：headers_timeout_ms / idle_timeout_ms / max_body_mb / log_retention_days / retries / dayFilter（以及 security / backup / update / adapter_packs / lan 各段全部键）
- 每键含：类型、默认值、语义、最小 TOML 示例；分组与 types.ts 结构对应
- 明确边界说明：「config.toml 经程序写入（mutateConfig）是整包重序列化，手写注释与排版会被抹除」（known tradeoff，known-issues CORRECT-03 相邻）
- usage.md §7「配置文件速查」处加链接；docs/en/ 有对应英文文档
- `npm test` 全绿

# 红线
- 写前必读 .agents/conventions/docs-writing.md（用户视角、一条一事、粗体点题、不写内部黑话）
- 不手写后不管：要么脚本生成，要么 freshness 测试兜底，二选一（推荐生成式——先例 catalog-snapshot.generated.ts 的 gen + 对拍纪律）

# 背景
证据（2026-10-27 复核更正）：上述键在 docs/usage.md 与 docs/en/usage.md 的 §7 配置速查**双语同缺**；design.md 与双语 CHANGELOG 已收录（zh:60/93 = en:60/93），不存在 zh/en 漂移。

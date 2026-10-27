---
id: archive-point-in-time-docs
type: docs
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - docs/**
  - docs/known-issues.md
  - docs/design.md
  - test/webui-static.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
建 `docs/archive/`，把 5 份已闭环的时点记录移入归档，同步修正全仓引用路径，让 docs/ 只剩活文档。

# 归档对象（2026-10-27 审计结论：内容已闭环、时点性质）
- docs/release-review-2026-10-12.md（8 P1 + 18 P2 全部闭环；known-issues.md 有两处引用 CORRECT-04→§五，改路径）
- docs/test-plan-handoff.md（384 行时点方案，零引用，926 例口径已过期；测试盲区已由 T7 sync-cloud-test-gaps 接棒）
- docs/web-testing-plan.md（方案已消费，L0/L2 已落地；design.md 与 test/webui-static.test.ts、test/webui/dom.test.ts 头注释引用，改路径）
- docs/engine-smoke.md（20 行时点冒烟记录，零引用）
- docs/redundancy-design.md（BUG/DRIFT/DUP 全勾选闭环，C1 路由表化已在 server.ts:2652 落地）

# 验收标准
- 用 `git mv` 移入 docs/archive/（保留历史）
- 全仓 grep 无断裂引用：known-issues 两处、design.md 一处、两个测试文件头注释，全部指向新路径
- docs/known-issues.md 与 docs/backlog.md 头部各加一行归档说明（指向 docs/archive/）
- `npm test` 全绿

# 红线
- 归档内容保持原样不改写（时点记录的价值在于原貌）；只改路径引用
- 活文档（usage/README/AGENTS/known-issues/backlog/design*.md/ci-bots 等）一律不移

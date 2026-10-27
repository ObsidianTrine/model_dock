---
id: comment-assertion-fixes
type: docs
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/gateway/lan.ts
  - src/gateway/server.ts
  - src/gateway/state.ts
  - src/install/noderuntime.ts
  - README.md
  - docs/**
workflows:
  - feature-branch
gate: L3
---

# 目标
改写与代码矛盾的注释/文档断言（E 类「改写优先于删除」），删一处编辑残留；来源为 2026-10-27 注释健康度审计。

# 逐项清单（动手前逐处核对代码再改写）
1. src/gateway/lan.ts:801 — 注释「~63KB HTML」→ 实测 renderMobilePage 模板 ~50KB + 注入 ~1.5KB ≈ 52KB，改数字留设计意图
2. src/gateway/server.ts:2791/2799 — 两处「236KB」→ UI_HTML 实测 ~313KB（与 T4 Phase 2 联动，T4 做了就归 T4）
3. src/install/noderuntime.ts:141-143 — JSDoc「解压包内顶层目录名（nodeInnerDirName）」挂在了 144 行 nodeStageDirName 头上（实际描述的是 148 行的 nodeInnerDirName），归位
4. src/gateway/state.ts:561 — pickTarget 内与 :570 逐字重复的「避开窗口」行（编辑残留；570 才是带钉住豁免的生效版，删 561 前先核对）
5. README.md:87 与 docs/en/README.md:87 — `modeldock use <profile>` 命令不存在，实际为 `profile use <name>`（CLI 抽查 6 个唯此错）
6. docs/usage.md 与 docs/en/usage.md §10 — 基线日期「2026-10-18」未随 10-27 更新；目录锚 `#10-当前实现状态v100` 仍指 v1.0.0 旧标题
7. docs/design-i18n.md — 「约 600 条 t()」实测 ~1644，改为「以 src/util/i18n.ts 现状为准」或标注快照@commit
8. AGENTS.md「测试指南」— 套件清单只列 5 个（store/backup/adapters/gateway/util），test/ 实有 75 文件；命令表补 `test:workflow` / `test:coverage`（package.json 已有）

# 验收标准
- 每处改写前先核实代码真实行为；`git diff` 只含注释行与文档行，无代码变化
- `npm test` 全绿（含 webui-static / ui-lint 门禁不受影响）
- 治理约定沉淀：口径类数字（测试数、t() 条数）一律不写死——写「以 npm test 输出为准」或标注「快照@commit」（本仓已见 771/926/913/914/915 五个测试数版本并存，usage.md:320 与 docs/en/usage.md:320 的 914 也是其中之一，随本次一并处理）

# 红线
- 只改注释行与文档行；presets/data.ts 的「2026-10 核对」日期戳、noderuntime.ts:16-17 版本依据等踩坑记录类注释一律不动（保留集合）

---
id: split-import-sources
type: refactor
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/import/**
  - test/import-scan.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
1197 行的 import/sources.ts（11 个导入源单文件）改为 `src/import/sources/` 目录每源一文件 + registry 汇总导出，此后新增导入源（历史上加得很勤）不再互撞，多 agent 并行零冲突。

# 验收标准
- `npm test` 全绿；import-scan 套件断言零改动
- applyImport 的批内 suggest_id 去重兜底（REVIEW-04 修的 usedIds Set）语义不变，有测试钉住
- 各源沙箱守卫（CORRECT-05 修的 APPDATA 分支 FAKE_HOME 跳过）搬移后语义不变
- 两代 zcode 扫描合并逻辑（REVIEW-24 修的）不变

# 红线
- 各源扫描/解析逻辑逐字搬移；不新增、不删除、不"顺手优化"任何源的行为
- 共享帮手（类型、YAML Document API 操作、路径约定）收进 common 模块，不复制粘贴

# 背景
现 11 源：cc-switch（sqlite）/ claude / dsh / zcode（新旧两代）/ codex / opencode / mimocode / workbuddy / ccr / crush / gemini / one-api（批量渠道，带分页 deadline，PERF-32 修过）。registry 形态参照 adapters/registry.ts 的既有模式。

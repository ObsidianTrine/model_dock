---
id: split-ui-ts
type: refactor
created_at: 2026-10-27T00:00:00+08:00
created_by: human
budget:
  max_turns: 80
files_hint:
  - src/gateway/ui.ts
  - src/gateway/ui/**
  - src/gateway/server.ts
  - test/ui-lint.test.ts
  - test/webui-static.test.ts
workflows:
  - feature-branch
ui_check: true
tier: heavy
gate: L3
---

# 目标
把 4817 行单文件 Web 控制台拆成多文件可维护形态，**行为零变化**；为后续一切 UI 工作铺路（PERF-23/25 随之解决或解绑）。

# 验收标准
- `npm test` 全绿：ui-lint.test.ts（门禁检查目标路径同步更新后，语义/封闭集/对比度规则不变）、webui-static 契约、gateway 套件的 CSP/304/弹层焦点断言（REVIEW-02/14/15/16 修的断言）全部保持
- 浏览器行为零变化：沙箱实例（MODELRDOCK_FAKE_HOME + 189xx 成对指定）手测主流程——服务增删/路由切换/定时面板/各弹层开闭与 Esc/切语言/切主题/手机页
- ui.ts 降为拼装壳（`wc -l src/gateway/ui.ts` < 800）
- Phase 2 若实施：known-issues PERF-25 勾选，并顺手更正 server.ts:2791/2799 的过时体积注释（「236KB」→ UI_HTML 实测 ~313KB；known-issues 原文写的 1087 行是审查当日行号，已漂移）

# 红线
- src 不用 import.meta、运行时不读 fs 拼页面——响应体必须保持"内联常量"形态（known-issues §四「路径穿越无逃逸面」结论依赖此前提）
- data-i18n="中||En" 浏览器机制不动；组件 label 惰性函数规则不动（AGENTS.md 2026-10 pill 教训）
- 模板注入逻辑（token/port 的 replaceAll）原样保留；CSP 基线不改

# 背景
现状单模板字面量 ≈304KB：body 21KB + CSS 45KB + 内联 JS 236KB（其中注释约 29KB）。改一个弹层要在 HTML 模板字符串里定位，多人/多 agent 并行必撞。
- **Phase 1（纯拆分，tsc 兼容，不加构建步骤）**：JS/CSS 拆成独立 TS 字符串模块（`export const`，ui.ts 保留拼装与注入），按域分文件，建议布局：`src/gateway/ui/` 下 overview（轮询与状态行）/ services（服务卡）/ routes（路由与定时）/ clients（接入卡）/ logs / configpack / update / kit（组件层）/ i18n-runtime / styles。
- **Phase 2（可选，随发布构建链）**：esbuild 最小化内联 JS（build-sea 已依赖 esbuild），解决 PERF-25。known-issues 暂缓注记已确认：裸正则剥注释会把字符串字面量剥坏，必须走正规最小化，不宜手写剥离器。
- PERF-23（编辑弹层/拉取模型在数百模型时全量渲染）拆分后模块独立了才好做，且需按 ui-kit 规范先过原型评审——**另开卡，不绑定本卡**。

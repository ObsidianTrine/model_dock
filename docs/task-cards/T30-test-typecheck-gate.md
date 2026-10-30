---
id: test-typecheck-gate
type: refactor
created_at: 2026-10-30T20:00:00+08:00
created_by: agent
files_hint:
  - package.json
  - tsconfig.json
  - tsconfig.test.json
  - test/**/*
workflows:
  - feature-branch
gate: L3
---

# 目标
把 test/ 目录纳入类型检查门禁。vitest 经 esbuild transform **不做类型检查**，test/ 又不在 `tsc -p tsconfig.json` 编译范围——2026-10-30 一天两次实测踩中同一类洞：

1. T21 分支（test-infra-guards）对象属性名笔误 `setupSyncTarget({ kind: 'localdir', dirA }, …)`（简写把键写成 `dirA`），`npm run build` 与 vitest 全部放行，直到全量跑测试才暴露；
2. CORRECT-08（fd235ea）两用例期望与实现自相矛盾（稀疏追加/中段守卫写反，作者未实跑），**带红合并进 develop**（HEAD 实测 12 例红），直到下一分支全量跑分挡门禁才暴露。

类型检查能把「属性名/签名错」一类当场拦下；期望矛盾类拦不住，但合入门禁真跑全量（见教训②的流程面）另按评测集考题 `2026-10-jsonpath-tokenizer-regression` 追责。

# 逐项清单（动手前核实）
1. **核实主 tsconfig 编译范围**：确认 `tsc -p tsconfig.json` 是否含 test/（预期不含——dirA 笔误未被告 build 拦下即证）。若其实已含，本卡改查 CI/门禁为什么没跑。
2. **新增 tsconfig.test.json**：extends 主配置，include `test/**/*` + `src/**/*`，`noEmit: true`；类型环境（vitest globals、node types）与主配置对齐。
3. **package.json test 脚本前置类型检查**：`"test": "tsc -p tsconfig.test.json --noEmit && vitest run"`——`.agents/workflow.json` 的 testCmd 是 `npm test`，finish 门禁自动带上；**不碰 .agents/\***（编排器门禁域，刚被 T15 大改，避免耦合）。
4. **清理存量类型错误**：先跑一遍盘点。量小清零；量大则白名单渐进（`// @ts-expect-error` 或豁免清单必须带理由），但本卡验收只承诺「不再新增」。
5. **（可选）CI 对齐**：test.yml 加同一条类型检查步（本地门禁先行，CI 是否加由盘点结果定）。

# 验收标准
- `npm test` 全绿（类型检查段包含在内，作为第一段）。
- 注入 dirA 型笔误（属性名简写错误）→ 门禁**当场红**，不需要跑完测试。
- 存量清理或豁免清单落档（豁免逐条带理由）。

# 红线
- 不改 vitest 配置（isolate:false / singleFork / watchdog 纪律不动）。
- 不动 `.agents/workflow.json` 的 testCmd 语义（仍是一条 `npm test`）。
- 不把类型检查扩成「类型即测试」的过度工程（本卡只做 noEmit 门禁）。

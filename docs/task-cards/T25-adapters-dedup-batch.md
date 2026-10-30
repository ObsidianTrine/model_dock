---
id: adapters-dedup-batch
type: refactor
created_at: 2026-10-29T00:00:00+08:00
created_by: human
files_hint:
  - src/adapters/**
  - src/util/paths.ts
  - src/sync/engine.ts
  - test/adapters.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
adapters 残留重复簇收敛 + 三处卫生项。**用户可见文案逐字节不变、行为零变化**——adapters 套件对文案有中文逐字节断言。

# 逐项清单（行号基于 2026-10-29 develop，动手前逐处核实）
1. **isOursGatewayUrl 三元防抖 ×7**：`isOursGatewayUrl(typeof x === 'string' ? x : undefined, id, cfg)` 重复在 codex.ts:201、provider-json.ts:271、dsh.ts:574/601、workbuddy.ts:90、zcode.ts:515/554 → shared.ts 收敛为一个帮手（如 `oursEntryUrl(x, id, cfg)`，内部做三元防抖再调 isOursGatewayUrl）。
2. **planDetach 空结果尾 ×7**：「未指向 ModelDock 网关，无需改动」手抄在 claude-code.ts:402、codex.ts:221、dsh.ts:631、provider-json.ts:291、workbuddy.ts:335/354、zcode.ts:571 → shared.ts `noChangeResult(label?)`。**文案逐字节不变**（t() 调用形态原样迁入）。
3. **status() pointing 三态逐字相同**：dsh.ts:672-679 与 zcode.ts:651-658 → 共享 helper（参数化差异部分）。
4. **changeIfChanged 收尾**：dsh.ts 内联 `if (after !== text) changes.push(...)` ×4（:422/:460/:544 附近）与 zcode.ts:463 → 就地替换为 shared.ts:6-8 既有 `changeIfChanged`（REVIEW-25 建此函数时注释明写「dsh/zcode 内联了同款判定」——本次收尾）。
5. **死导出**：util/paths.ts:18 `adaptersDir` 全仓（src + test）零引用 → 删。
6. **非空断言局部化**：zcode.ts:516/525/530 链式 `root.config!.providerConfigRules!.providerRules!` 改局部 const 逐步提取（现正确性仅靠「rule 是从同一路径找出来的」不变量支撑，提取后显式化）；sync/engine.ts:365-371 `st.target!` 连续 5 次同理。零行为变化。

# 验收标准
- `npm test` 全绿；adapters 套件断言零改动（含中文文案逐字节断言、REVIEW-25 更新的 attach/detach 幂等契约）。
- `git diff` 里所有用户可见字符串逐字节比对不变（可写一次性脚本提取 diff 中字符串字面量核对）。
- `npx tsc -p tsconfig.json --noEmit` 干净。

# 红线
- 不改任何 planAttach / planDetach / status / detect 的行为语义；不动适配器注册表（registry.ts）。
- oursEntryUrl / noChangeResult 的参数设计以七处调用点**最小改动**为准，不为未来扩展预留参数。
- shared.ts 既有函数签名只增不改；不动 format.ts（XPLAT-09 JSONC 取舍留档，勿翻案）。
- util/paths.ts 只删 adaptersDir 一行，不碰其他路径函数（硬规则：所有路径经 paths.ts 的约定不破）。

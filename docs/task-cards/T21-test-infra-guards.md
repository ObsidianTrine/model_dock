---
id: test-infra-guards
type: refactor
created_at: 2026-10-29T00:00:00+08:00
created_by: human
files_hint:
  - vitest.config.ts
  - test/gateway.test.ts
  - test/syncpull.test.ts
  - test/uninstall.test.ts
  - test/zz-quickwins.test.ts
  - test/update-tray.test.ts
  - test/attach-port.test.ts
  - test/fsx-memo.test.ts
  - test/perf-fixes.test.ts
  - test/mocks/**
  - test/config-isomorphism.test.ts
  - test/orchestrator/**
workflows:
  - feature-branch
gate: L3
---

# 目标
测试套件防漂移门禁批：钉住 vitest 双 config 同构、autostart mock 形状单源、顺序耦合清单——全部是「防未来隐性炸」的门禁与单源化，产品代码零改动。

**前置：本卡排在 test-sync-fixes-helpers（T20）之后**——syncpull.test.ts 两卡都动（T20 改轮询与 env 泄漏，本卡动它的 mock），且 T21 要用 T20 落的 helpers。

# 逐项清单（行号基于 2026-10-29 develop，动手前核实）
1. **vitest 同构门禁**：新增 test/config-isomorphism.test.ts——import `vitest.config.ts` 与 `vitest.workflow.config.ts` 的 default export，断言 workflow 的 `test` 段除 `include` 外与 base 的 `test` 段 deep-equal。钉住 vitest.config.ts:14 注释「池策略等防死锁设置两处必须保持同构」的承诺（当前靠 spread 构造性保证，门禁防「后人把手写对象换掉 spread」）。
2. **autostart mock 工厂**：gateway.test.ts:24 与 syncpull.test.ts:19 是 spread 型（syncpull 注释自证形状与 gateway 人肉同步——漂移中）、uninstall.test.ts:24 是 vi.fn 型。抽 `test/mocks/autostart.ts` 工厂（两型各一）；vi.mock 工厂内动态 import helper（vitest vi.mock hoist 限制的官方解法：工厂内 `await import()`）。mock 的导出字段集与现三处逐一对齐——**形状（key 集合）不变，只收敛来源**。
3. **顺序耦合留痕**：
   - vitest.config.ts 注释列「顺序耦合对」清单：① zz-quickwins.test.ts:14-19 押文件名字典序排在 uninstall.test 之后 + 惰性 import 才不破坏其 mock；② update-tray.test.ts:6-8 因 uninstall.test 已 mock gatewaycmd 而不再 mock（反向耦合）。
   - 加门禁断言耦合对的字典序成立（如断言 `'zz-quickwins.test.ts' > 'uninstall.test.ts'` 的排序前提——防止未来加文件/改名破坏前提而无人知晓）。
4. **attach-port.test.ts:78-79 端口字面量**：用 8687/8890 作 planAttach 的纯字符串输入（不连网不触红线，但与 AGENTS.md「测试脚本不写 8687」纪律字面冲突，且未来 planAttach 加探测逻辑即变真触线）→ 换非保留端口字面量（如 28687/28890），相关断言预期值同步更新（仅端口数字本身）。
5. **过时注释更正**：fsx-memo.test.ts:14 与 perf-fixes.test.ts:11 宣称「避开 adapters/store 文件的 vi.mock」——两文件现已零 vi.mock（仅 adapters.test.ts:2065 console spy），约束名存实亡 → 按现状改写注释。**不合并这两个文件**（收益小，避免扰动）。

# 验收标准
- `npm test` 全绿（含新增门禁测试）。
- mock 工厂改造后 gateway / syncpull / uninstall 三套件**单独跑 + 组合跑**都绿（singleFork mock 注册表纪律——这是本卡最关键的验证）。
- `npm run test:workflow` 全绿（若门禁测试放 test/orchestrator/ 则必须；放 test/ 顶层则随 npm test）。

# 红线
- 不改任何 mock 的行为语义（只收敛形状来源）；不新增其他模块的 vi.mock。
- **不做「双池并行」改造**（maintenance-handoff 在案不做清单）；不改 isolate:false + maxWorkers:1、不改 testTimeout、不改 watchdog。
- attach-port 断言改动仅限端口字面量本身；不碰 hijackStateWithFakeGateway 的行为。

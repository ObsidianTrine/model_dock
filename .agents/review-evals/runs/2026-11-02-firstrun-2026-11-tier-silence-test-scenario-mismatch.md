# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-11-tier-silence-test-scenario-mismatch — ✅ 审出

- 考题：zcode tier 静默回归用例场景与被测实现自相矛盾：用例名声称「默认引擎」，起跑却带 --backend mock——tierWarnable 只对 zcode-headless 静默（opts.backend !== 'zcode-headless'），mock 下告警照发，not.toContain('未生效') 断言必红；红用例随 d352822 溜过 finish 门禁（finish 只跑产品套件，test:workflow 归 CI/手动守护，文档化已知边界）
- 关键词：tierwarnable=中，zcode-headless=中，backend mock=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-3F9dHm/2026-11-tier-silence-test-scenario-mismatch.output.txt

<details><summary>模型原文</summary>

```text
发现 1 个问题

## 1. 新增 e2e 用例场景自相矛盾，合入时必红（即后续 c515b0e 修复的 bug）

**test/orchestrator/tiers.test.ts:207-208（d352822 版本）**

- 用例名为「zcode 船（默认引擎）」，但第 207 行跑的是 `run test-task --backend mock --approve-backend-switch`——引擎被显式切成了 mock，不是 zcode。
- 证据链（均在 d352822 的 orchestrator.mjs 中核实）：
  - `--backend` 显式传入时 `opts.backend = 'mock'`（orchestrator.mjs:268-275，显式 flag 优先于 `cfg.worker.backend`）；
  - `tierWarnable = opts.backend !== 'zcode-headless'` → `'mock' !== 'zcode-headless'` = **true**（orchestrator.mjs:331）；
  - 卡带 `tier: 'ahead-2'`、`MDK_TEST_TIER_LIGHT_TOKEN` 未设 → `tier.inactive === 'token'` 命中第二个告警分支，`log` 即 `console.log`（orchestrator.mjs:111）→ 告警 `⚠ tier "ahead-2" 未生效：环境变量 … 未设` **写入 stdout**（orchestrator.mjs:335）；
  - 第 208 行断言 `out.stdout` **不含**该告警 → 必然失败。
- 后续修复佐证：c515b0e（merge 4527654「feature/tier-silence-fix」）提交信息原话——「修复合入时的用例错误：--backend mock 场景下告警本就正确（船已切走）」「该失败用例曾随 d352822 溜过 finish 门禁（finish 只跑产品套件）」，并把用例改为不带 `--backend` 走默认 zcode 引擎 + `ORCH_ZCODE_CLI` 失效桩（`tryOrch` + 断言扩到 stdout+stderr）。
- 根因属流程已知边界（finish 只跑产品套件，workflow 套件靠 CI/手动），修复提交已文档化，不另立项。

**验证说明**：本会话 Bash/写临时文件均被权限拒绝，未能实际跑红该用例；以上为逐行静态推演 + 修复提交自述双重印证。生产代码改动本身（`tierWarnable` 门控两处告警、`tier_resolved` 事件保留）语义正确：`opts.backend` 在检查点已含配置默认解析（orchestrator.mjs:276-278），且引擎升级链（437 行）发生在告警点之后，不影响判定。除此之外未发现其它问题。

## 存疑

- 无。一条备选线索已排除：zcode 船上 `inactive: 'unconfigured'`（tiers 键漏配）的告警也被静默——但「zcode 卡上 tier 只作留痕」是 diff 注释里明示的设计意图，不算缺陷。
```

</details>
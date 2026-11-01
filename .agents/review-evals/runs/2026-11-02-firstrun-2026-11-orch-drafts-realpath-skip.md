# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-11-orch-drafts-realpath-skip — ✅ 审出

- 考题：cmdSubmit 草稿清理用裸字符串前缀比对（path.resolve(cardFile).startsWith(draftsDir(repoRoot)+sep)）且双侧都不做 realpath 归一：macOS 的 tmpdir 是符号链接（/var/folders→/private/var/folders），argv 侧路径（path.resolve 不解析符号链接）与 findRepoRoot 侧（git toplevel，已解析真实路径）前缀永不一致——drafts 提案提交后草稿清理永远静默跳过（任务二合入即存在，scan.test『提案提交』用例实证）
- 关键词：realpath=中，符号链接=中，symlink=未中，startswith=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-1zPD2m/2026-11-orch-drafts-realpath-skip.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题

**1.（主发现，即后续 9f62c37 修复的 bug）cmdSubmit 草稿清理的前缀比对不走 realpath，符号链接路径下永远清不掉草稿**

- 位置：`.agents/scripts/orchestrator.mjs:1098`（a58a313 版本）
- 证据：`if (path.resolve(cardFile).startsWith(draftsDir(repoRoot) + path.sep))`——`path.resolve` 只做字面归一，不解析符号链接。macOS 的 tmpdir 是符号链接（`/var/folders` → `/private/var/folders`），测试沙箱把仓库放 tmpdir 时，argv 侧（调用方传入的草稿路径）与 cwd 侧（`findRepoRoot` 经 `process.cwd()` 得到的 repoRoot）前缀不一致，`startsWith` 恒为 false → `fs.rmSync` 分支永不执行，drafts 残留已提交提案。
- 后果：`test/orchestrator/scan.test.ts` 实证「提案提交后草稿残留」；提交信息自述「任务二合入即存在」。残留草稿会被后续每轮 `autoSubmitProposals` / `highPriorityDraftIds` 反复看到（靠 `submitDraft` 的 findCard 去重兜底才没放大成重复提交）。
- 修复形态（9f62c37）：两侧 `fs.realpathSync` 归一后再比对。

**2.（本 diff 新引入）autopilot「人工草稿永不自动提交」守卫对 intent --draft 产物失效，人工草稿可被自动提交且 gate 被降为 L1**

- 位置：`.agents/scripts/orchestrator/autopilot.mjs:27`（守卫 `meta.created_by === 'human'`）、`:4`（头注明言「drafts/ 里混着 intent --draft 的人工产物」被此守卫覆盖）；对照 `.agents/scripts/orchestrator.mjs:1791`（a58a313 版本，cmdIntent 无条件 `.replace(/^created_by:.*$/m, 'created_by: planner')` 后才落 `--draft` 草稿）。
- 证据链：intent `--draft` 落到 drafts/ 的卡 `created_by` 实际是 `planner`（orchestrator.mjs:1791 在写盘前盖章，`--draft` 分支 1793-1797 原样写入 finalText）；`canAutoSubmit` 只认 `created_by: human`，planner 卡不拦。
- 失败场景：用户跑 `intent "..." --draft` 生成 docs 类型草稿留在 drafts/ 待人工决定 → 任意一次 `scan` / `nightly`（watch 周期同理）触发 `autoSubmitProposals`（orchestrator.mjs:1629）→ 白名单命中 → `submitDraft(..., { gate: AUTO_SUBMIT_GATE })` 经 `normalizeProposalText`（orchestrator.mjs:1597）把草稿的 `gate: L3` 覆写成 `gate: L1` 进 pending → 若实际改动分级为 L0/L1，审查通过即自动合并——用户从未点过 submit。直接违背本提交「人工草稿/deps/核心路径永不自动」「自动提交 ≠ 自动合并」的授权矩阵声明。

## 存疑

- **nightly --auto 的候选面从「本次新生成」扩大到「drafts/ 全部 high 提案」**（orchestrator.mjs:2124 附近，`const high = highPriorityDraftIds(repoRoot)`；旧代码是 `created.filter(priority=high)`）。人工刻意留置未提交的历史 high 提案（如 deps 审计卡）会被强制提交并跑。无法确证是缺陷还是有意设计（文档写「high 优先级提案先提交再跑」，但未说明波及历史留置提案）——缺设计确认。
- **normalizeProposalText 双锚点都钉在 `gate:` 行上**（orchestrator.mjs:1594-1599）：planner 输出若缺 `gate:` 行，gate 覆写与 `proposal: true` 补齐一起静默失效。gate 缺省回落 L3（queue.mjs validateCard）是安全方向、`proposal:` 字段下游无程序化消费者，故不算确认缺陷；但 autopilot 提交日志的「gate=L1 预授权」语义在该边缘会与实际不符。
- cmdPropose 内 `die()`（process.exit）会跳过 finally，两个 `mkdtemp` 临时目录泄漏在 os.tmpdir——清理类，按纪律不列为问题，仅备注。
```

</details>
---
id: test-sync-fixes-helpers
type: refactor
created_at: 2026-10-29T00:00:00+08:00
created_by: human
files_hint:
  - test/helpers.ts
  - test/syncpull.test.ts
  - test/synctarget.test.ts
  - test/sync-engine-gaps.test.ts
  - test/syncagent.test.ts
  - test/cloudmain.test.ts
  - test/sync-setup-gaps.test.ts
  - test/sync-push-partial.test.ts
  - test/syncdoc-recovery.test.ts
  - test/err-taxonomy.test.ts
  - test/hotpath.test.ts
  - test/daemon-lifecycle.test.ts
  - test/reset.test.ts
  - test/profile-cli.test.ts
workflows:
  - feature-branch
gate: L3
---

> **状态**：✅ 已完成——merged 939ee25（2026-10-30 收口盘点）

# 目标
测试基建修复 + helper 四类收敛（产品代码 `src/**` 零改动，只动 test/）。消除一个「必红」路径、一个全局状态泄漏源，收敛约 80 行跨文件样板，堵一个 Windows 8.3 短名崩溃隐患。

# 逐项清单（行号基于 2026-10-29 develop，动手前逐处核实）
1. **syncpull.test.ts 必红轮询**：:467-474 轮询 20 次 × 1000ms（上限 20s）——全局 testTimeout 正好 20s（vitest.config.ts:16），worst-case 直接红；:448-454 另一处 25 次 × 200ms 同型慢。改用 synctarget.test.ts:85 已有的 25ms 步进 waitFor 模式（随第 3 项收敛为 helpers 导出）。
2. **syncpull.test.ts 全局 env 泄漏**：:459-464 把 `MODELRDOCK_FAKE_HOME` 切到 a.home 做 approve、:464 才切回——中间 fetch 抛错即泄漏给同 fork 后续所有文件（「单独绿、全量红」的典型源头）。用 try/finally 包住（finally 恢复 bHome）。对照组：synctarget.test.ts:44-56、sync-engine-gaps.test.ts:40-54 均有兜底，写法对齐。
3. **helpers.ts 四类收敛**（各使用点核实行号后替换为 import；helpers.ts:64 fakeHome 本体单一实现不动）：
   - TSX_LOADER 同一行构造 ×5：err-taxonomy:94、hotpath:21、daemon-lifecycle:15、reset:26、profile-cli:17 → helpers 导出（含 tsx/esm 的 createRequire 解析全套）；
   - waitFor ×2：synctarget:85、sync-engine-gaps:81（同形状不同 stepMs/timeoutMs）→ helpers 带参导出；
   - 持久多 home 三件套 ×4：synctarget:38-56、sync-engine-gaps:38-54、syncagent:19-31、cloudmain:14-36 → helpers 导出 newHome/gotoHome/restoreHomes（为什么不用 fakeHome.restore 的理由注释——restore 删目录与多 home 循环冲突——随函数迁入 helpers）；
   - `fs.realpathSync.native(tmpdir)` 打底 ×5：synctarget、sync-engine-gaps、sync-setup-gaps、sync-push-partial、syncdoc-recovery → helpers 导出 `TEST_TMP` 常量。
4. **syncagent.test.ts:20 裸 `os.tmpdir()`**：未做 native realpath——helpers.ts:6-12 记录的 Windows 8.3 短名 0xC0000409 原生崩溃坑（该文件现无 fs.watch/spawn 风险低，但与全局纪律不一致）→ 改用 helpers 的 TEST_TMP 打底。

# 验收标准
- `npm test` 全绿，**全量用例数不减**（只搬移与收敛，不删用例；syncpull 两处轮询改写后原断言逐条保留）。
- helpers 新导出每个都有 ≥2 个使用点（防「收而不用」）。
- 按仓库 vitest 隔离纪律跑组合验证：至少 syncpull / synctarget / store / gateway 组合一次全绿（singleFork 共享注册表下「单独绿 ≠ 全量绿」）。
- `git diff` 确认 src/** 零改动。

# 红线
- 不改任何断言的期望值；不改测试超时语义（除两处轮询改 waitFor 外）。
- 新 helper 不引入任何跨文件 vi.mock（AGENTS.md vitest 隔离模型）。
- 临时目录一律 TEST_TMP（native realpath）打底，不写死 /tmp 或盘符；不监听 8687/8890。
- helpers.ts 既有导出（fakeHome 等）签名不变。

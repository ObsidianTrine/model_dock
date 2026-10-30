---
id: agent-context-write-guard
type: fix
created_at: 2026-10-30T20:00:00+08:00
created_by: agent
files_hint:
  - src/util/fsx.ts
  - test/realhome-write-guard.test.ts
  - AGENTS.md
workflows:
  - feature-branch
gate: L3
---

# 目标
写入门禁（2026-10-30 合入，f77dc02）的上下文识别扩展到 agent CLI 直跑进程——封住本次生产写穿事故**仍未覆盖的残留向量**。

# 背景（为什么值得一张卡）
2026-10-30 生产写穿事故（考题 `2026-10-realhome-write-through`）复盘发现：污染真实 home sync.json 的同步口令与仓库**全部**测试口令字面量（`pw-*`）都不匹配——污染源不是测试套件本身，而是某个无 `VITEST` 标记的临时进程（最可能：agent 会话直跑的 tsx/node 种子脚本或临时验证脚本）。现行 `inTestContext()`（src/util/fsx.ts）只认 `VITEST`/`VITEST_WORKER_ID`/`MODELRDOCK_TEST=1`，对这类进程**不生效**：agent 跑一条不带 `MODELRDOCK_FAKE_HOME` 的脚本仍可写穿真实 home。防线已堵住「测试套件」这条最大的河，本卡堵剩下的沟。

# 逐项清单（动手前核实）
1. **实测 agent CLI 子进程的 env 标记**：在 Claude Code 与 ZCode 会话里各起一个子进程打印 `env`，确认可稳定识别的标记（Claude Code 已知有 `CLAUDECODE=1`、`CLAUDE_CODE_ENTRYPOINT`；ZCode 对应标记实测后记录）。把确认存在的标记并入 `inTestContext()`——宁多拦不漏拦：误拦走既有豁免 `MODELRDOCK_ALLOW_REAL_HOME_WRITE=1`。
2. **AGENTS.md 配方硬化**：「多 Agent 并行开发约定」与「测试指南」补硬规则——agent 直跑任何 tsx/node 脚本必须 `MODELRDOCK_FAKE_HOME=<独立目录>` 与 `MODELRDOCK_TEST=1` **成对**设置；配方示例同步更新（现在只有测试指南隐含提及）。
3. **用例矩阵**：realhome-write-guard.test.ts 为每个新并入标记补「标记存在 → 拒写真实 home 替身；无标记 → 放行」双向用例（沿用 MODELRDOCK_HOME 替身技巧，绝不写真 home）。
4. **（可选）known-issues 登记**残余边界：完全无标记、无 FAKE_HOME 的裸进程（如用户手滑直接跑脚本）仍不受门禁保护——登记现状与建议（关键数据定期快照）。

# 验收标准
- `npm test` 全绿（新增用例覆盖每个并入标记的正反两向）。
- Claude Code / ZCode 实测的子进程 env 采样结果写进 NOTES.md（标记名与值），并入的每个标记都有实测依据，不凭记忆写死。
- 门禁触发报错文案仍为可操作双语（含 FAKE_HOME 配方与豁免开关）。

# 红线
- 生产网关/托盘等无标记进程零影响（`inTestContext()` 对它们恒 false）。
- 不改 `MODELRDOCK_FAKE_HOME` 优先级与 `MODELRDOCK_ALLOW_REAL_HOME_WRITE=1` 豁免语义。
- 不做「按进程名/父进程链识别」的启发式（脆弱且跨平台维护成本高）——只认 env 标记。

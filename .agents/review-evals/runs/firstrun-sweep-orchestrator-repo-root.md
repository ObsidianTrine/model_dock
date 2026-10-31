# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-orchestrator-repo-root — ✅ 审出

- 考题：findRepoRoot 双实现语义相反（--git-common-dir vs --show-toplevel）且注释自称「同款」：从 linked worktree 内跑 orchestrator 会把 queue/ 锚进 worktree，与 finish 需主仓库检出矛盾
- 关键词：git-common-dir=中，show-toplevel=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-NEf0se/2026-10-orchestrator-repo-root.output.txt

<details><summary>模型原文</summary>

```text
发现 3 个问题（前 2 条为后续 c99f326 实际修复的真实 bug，第 3 条为审查中确证的次要泄漏）。

## 1. Windows 上 `npm ci` 直调必挂（orchestrator.mjs:184）

```js
const r = spawnSync('npm', ['ci', '--no-fund', '--no-audit'], { cwd: worktree, stdio: 'inherit' });
```

npm 在 Windows 是 `.cmd` 包装，`spawnSync` 不带 `shell: true` 直调必 ENOENT → `installWorkspaceDeps` 走到 `die('worktree 依赖安装失败')`（行 185），全新 worktree 依赖装不上，run/resume 全部失败。后续修复以 `shellSpawnOptions()` 收敛（win32 加 shell、unix 不加——unix 加 shell 会改进程组语义影响杀树）。

## 2. `findRepoRoot` 用 `--show-toplevel`，linked worktree 内锚错根（orchestrator.mjs:58-71）

```js
return execFileSync('git', ['rev-parse', '--show-toplevel'], ...)
```

从 linked worktree 内调用时 `--show-toplevel` 返回 worktree 自身根 → `queueRoot`/`logDir` 锚进 worktree，而 `doApprove` 调的 feature-branch finish 要求主仓库检出（feature-branch.mjs:409-412）——「任务卡进、合并出」闭环断裂。同文件 feature-branch.mjs:30-39 已用 `--git-common-dir` 修过同一问题（其注释 25-29 行写明原因），两处实现语义相反。后续修复统一到 `--git-common-dir` 语义（回退 walk-up 保留）。回退分支 walk-up 找 `.git`（行 65）在 worktree 内同样命中 worktree 的 `.git` 文件，属同一 bug 家族，修复版一并处理。

## 3. [次要] reviewer 临时目录泄漏（orchestrator.mjs:526、534）

每次审查轮 `mkdtempSync` 创建 `orch-review-` 与 `orch-review-settings-` 临时目录，但 `finally`（行 631-633）只清理 `promptFile`/`settingsFile` 两个目录；审查返工多轮时每轮泄漏一组 tmpdir（且不走 OS 自动清理路径）。属资源泄漏，非阻断。

## 存疑

- **doApprove 对 finish 清理失败的误判**（orchestrator.mjs:731-733 ↔ feature-branch.mjs:386、441）：合并成功后 cleanup 失败会让 finish 以 `process.exitCode = 1` 退出，orchestrator 视为「finish 失败」die，卡留 awaiting-human、`merged` 事件丢失。可经再次 approve 幂等恢复，但状态与事件账目短暂失真——是否算缺陷取决于设计意图（缺 workflow.json 中 finish 退出码语义的约定文档佐证）。
- **cmdIntent 覆写后打日志**（orchestrator.mjs:1161）：`meta.gate` 已先置 `'L3'` 再插值，告警恒打印「gate=L3 已强制覆写为 L3」，原值丢失——纯诊断输出失真，按纪律不单列。
- `killTree(result.pid)`（行 385）若 backend 不返回 pid 的行为——backend 实现不在待审片段内，无证据。
```

</details>
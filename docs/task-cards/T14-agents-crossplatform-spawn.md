---
id: agents-crossplatform-spawn
type: bugfix
created_at: 2026-10-29T00:00:00+08:00
created_by: human
files_hint:
  - .agents/scripts/orchestrator/backends/claude-headless.mjs
  - .agents/scripts/orchestrator.mjs
  - .agents/scripts/orchestrator/scan.mjs
  - .agents/scripts/feature-branch.mjs
  - test/orchestrator/**
workflows:
  - feature-branch
gate: L3
---

> **状态**：✅ 已完成——merged bf937bd（2026-10-30 收口盘点）

# 目标
修复 .agents 工具链四处 Windows 必挂点：三处 spawn 全局命令缺 shell（探测与实际调用语义不一致），一处 findRepoRoot 双实现语义相反。

# 背景（行号基于 2026-10-29 develop，动手前核实）
1. **claude worker spawn**：claude-headless.mjs:119 `spawn('claude', args, {...})` 无 shell——Windows 上 claude 是 .cmd 包装，直 spawn 必 ENOENT；同文件 :219-222 可用性探测 `spawnSync('claude', ['--version'], { shell: process.platform === 'win32' })` 带了 shell——**探测说可用、实际起不来**，worker/审查全挂落 blocked/。该文件 :41-43 头注释自己写过「探测必须与 spawn 同语义」纪律，本文件违背了它。
2. **orchestrator npm ci**：orchestrator.mjs:184 `spawnSync('npm', ['ci', '--no-fund', '--no-audit'], ...)` 无 shell——Windows npm 是 .cmd 包装直调 ENOENT（AGENTS.md 工程硬性约定明文），失败即 die，worktree 依赖装不上。
3. **scan npm audit**：orchestrator/scan.mjs:88 `spawnSync('npm', ['audit', '--json'], ...)` 无 shell——nightly audit 信号源静默失效（catch 后 skip）。
4. **findRepoRoot 双实现**：feature-branch.mjs:32 用 `git rev-parse --git-common-dir`（worktree 内返回主仓库 .git 真实路径 → 推出主仓库根）；orchestrator.mjs:61 用 `git rev-parse --show-toplevel`（worktree 内返回 worktree 本身），:59 注释却称「与 feature-branch.mjs 同款」。后果：从 worktree 内跑 orchestrator 会把 queue/ 锚进 worktree，与「finish 需主仓库检出」矛盾。

# 实施要求
1. claude-headless.mjs:119 spawn 补 `shell: process.platform === 'win32'`。注意：prompt 走 stdin 不受 shell 命令行长度限制；逐一检查 args 中含空格/引号字符的参数（如 `--settings` 指向的文件路径）在 Windows shell 模式下的传递——Node 的 shell 模式会拼接命令行，必要时对该参数手动包引号并留注释说明。
2. orchestrator.mjs:184 与 scan.mjs:88 各补 win32 分支 `shell: true`（照抄 claude-headless.mjs:219-222 探测的写法保持一致）。
3. findRepoRoot 统一：orchestrator.mjs:61 改用与 feature-branch.mjs:32 相同的 `--git-common-dir` 推导逻辑（照抄其实现，含相对路径解析），更正 :59 注释；或把该函数抽到两处可共享的模块——二选一，以改动最小为准。
4. 修完后 grep 一遍 .agents/ 全部 spawn/spawnSync 调用点，确认没有第五处同类问题（如 zcode-headless.mjs 等其他 backend——它若已有 shell 处理则不动，仅在交付说明记录核对结论）。

# 验收标准
- `npm run test:workflow` 全绿；为修复 1/2/3 各加一条断言（对 spawn/spawnSync 的 options 做 spy，或把 options 构造抽为纯函数后断言 win32 分支含 `shell: true`、unix 分支不含）——选侵入最小的方式。
- findRepoRoot：新增用例——临时 git 仓库 + `git worktree add` 构造 worktree 场景，断言两处实现（统一后）在 worktree 内都返回主仓库根。
- `npm test` 全绿。
- 本机 macOS 全绿后，diff 里逐项复查 Windows 分支（AGENTS.md 三平台清单）。

# 红线
- 不改探测/spawn 其余语义（detached、stdio、timeout、env 注入、stream-json 解析）。
- 不把 shell: true 加到 unix 分支（unix 上 shell 会引入 sh -c 包装，改变进程组/信号行为）。
- findRepoRoot 只统一到 git-common-dir 语义，不改两处调用的下游行为。
